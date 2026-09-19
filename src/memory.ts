import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatter, scalar } from "./skills.js";

// ═══════════════════════════════════════════════════════════════
// Persistent, file-based memory
// ═══════════════════════════════════════════════════════════════
//
// One memory per .md file with YAML frontmatter (name/description/type),
// stored in two layers: .triumcode/memory/ for the project and
// ~/.triumcode/memory/ for user-global facts. Before each turn the relevant
// few are recalled (semantic selection via a side model query, falling back
// to keyword scoring) and injected into the conversation as a
// <system-reminder> user message.
//
// The system deliberately "parasitizes" plain files: users can edit them
// with any editor, and no dedicated memory API is needed beyond this module.

// Closed taxonomy, not free tags — prevents label sprawl degrading recall.
export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface MemoryEntry {
    filename: string;
    path: string;                    // absolute
    source: "project" | "global";
    name: string;
    description: string;
    type: MemoryType;
    mtimeMs: number;
    content: string;                 // full file content, frontmatter included
}

export interface MemoryOptions {
    cwd?: string;   // overrides process.cwd() (project layer)
    home?: string;  // overrides homedir() (global layer)
}

// A side model call, kept tiny: system + user prompt in, text out.
export type SideQueryFn = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

// ── Budgets ──────────────────────────────────────────────────
// Index: line cap is the normal guard (one line per entry); byte cap catches
// the pathological case of few lines with extremely long ones.
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
// Per-memory cap so one giant entry can't flood the context.
export const MAX_MEMORY_BYTES_PER_FILE = 4_096;
// Session-wide recall budget (bytes of injected memory content).
export const MAX_SESSION_MEMORY_BYTES = 60_000;
const MAX_RECALLED_MEMORIES = 5;

const MEMORY_INDEX_FILENAME = "MEMORY.md";

// ── Storage layers ───────────────────────────────────────────

// Project layer first; on a filename collision the project memory wins,
// mirroring how .claude/skills overlays ~/.claude/skills.
export function getMemoryDirs(options: MemoryOptions = {}): { dir: string; source: "project" | "global" }[] {
    const cwd = resolve(options.cwd ?? process.cwd());
    const home = resolve(options.home ?? homedir());
    return [
        { dir: join(cwd, ".triumcode", "memory"), source: "project" },
        { dir: join(home, ".triumcode", "memory"), source: "global" },
    ];
}

export function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function memoryFilename(type: MemoryType, name: string): string {
    return `${type}_${slugify(name)}.md`;
}

function formatFrontmatter(meta: { name: string; description: string; type: MemoryType }, body: string): string {
    return `---\nname: ${meta.name}\ndescription: ${meta.description}\ntype: ${meta.type}\n---\n\n${body.trim()}\n`;
}

// Save to the project layer and rebuild that layer's human-readable index.
export function saveMemory(
    entry: { name: string; description: string; type: MemoryType; content: string },
    options: MemoryOptions = {},
): string {
    const { dir } = getMemoryDirs(options)[0];
    mkdirSync(dir, { recursive: true });
    const filename = memoryFilename(entry.type, entry.name);
    const content = formatFrontmatter(
        { name: entry.name, description: entry.description, type: entry.type },
        entry.content,
    );
    writeFileSync(join(dir, filename), content, "utf-8");
    rebuildMemoryIndex(options);
    return join(dir, filename);
}

// Rebuild MEMORY.md in every layer that has memory files. The index is a
// convenience for humans browsing the directory; the prompt section is built
// from listMemories() directly so it can never go stale.
export function rebuildMemoryIndex(options: MemoryOptions = {}): void {
    const memories = listMemories(options);
    for (const { dir, source } of getMemoryDirs(options)) {
        const layer = memories.filter((m) => m.source === source);
        if (!layer.length) continue;
        const lines = ["# Memory Index", ""];
        for (const m of layer) {
            lines.push(`- **[${m.name}](${m.filename})** (${m.type}) - ${m.description}`);
        }
        try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, MEMORY_INDEX_FILENAME), lines.join("\n") + "\n", "utf-8");
        } catch { /* index is best-effort */ }
    }
}

// ── Discovery ────────────────────────────────────────────────

function parseMemoryFile(filePath: string, source: MemoryEntry["source"]): MemoryEntry | null {
    let content: string;
    try {
        content = readFileSync(filePath, "utf-8");
    } catch { return null; }
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;
    const name = scalar(parsed.values.get("name"));
    const type = scalar(parsed.values.get("type")) as MemoryType;
    if (!name || !MEMORY_TYPES.includes(type)) return null;
    let mtimeMs = 0;
    try { mtimeMs = statSync(filePath).mtimeMs; } catch { /* unreadable stat */ }
    return {
        filename: filePath.split(/[\\/]/).pop()!,
        path: filePath,
        source,
        name,
        description: scalar(parsed.values.get("description")),
        type,
        mtimeMs,
        content,
    };
}

// Both layers merged, project winning on filename collision, sorted by
// filename so filesystem order groups types together ({type}_{name}.md).
export function listMemories(options: MemoryOptions = {}): MemoryEntry[] {
    const merged = new Map<string, MemoryEntry>();
    // Global first so the project layer's Map.set overwrites it below.
    const dirs = [...getMemoryDirs(options)].reverse();
    for (const { dir, source } of dirs) {
        if (!existsSync(dir)) continue;
        let entries: string[];
        try { entries = readdirSync(dir); } catch { continue; }
        for (const entry of entries) {
            if (!entry.toLowerCase().endsWith(".md") || entry === MEMORY_INDEX_FILENAME) continue;
            const memory = parseMemoryFile(join(dir, entry), source);
            if (memory) merged.set(memory.filename, memory);
        }
    }
    return [...merged.values()].sort((a, b) => a.filename.localeCompare(b.filename));
}

// ── Index text (dual truncation) ─────────────────────────────

export function truncateIndexText(content: string): string {
    const lines = content.split("\n");
    if (lines.length > MAX_INDEX_LINES) {
        content = lines.slice(0, MAX_INDEX_LINES).join("\n")
            + "\n\n[... truncated, too many memory entries ...]";
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_INDEX_BYTES) {
        content = Buffer.from(content, "utf-8").subarray(0, MAX_INDEX_BYTES).toString("utf-8")
            + "\n\n[... truncated, index too large ...]";
    }
    return content;
}

// ── Freshness ────────────────────────────────────────────────

function memoryAge(mtimeMs: number): string {
    const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
    if (days === 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
}

// Memories are point-in-time observations. Past a day, say so AND tell the
// model what to do about it — an action guide beats a bare timestamp.
export function memoryFreshnessWarning(mtimeMs: number): string {
    const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
    if (days <= 1) return "";
    return `This memory is ${days} days old. Memories are point-in-time observations, not live state - claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
}

// ── Recall: semantic selection with keyword fallback ─────────

const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to ${MAX_RECALLED_MEMORIES}). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

// Deterministic fallback: word-overlap scoring. Zero API cost, weaker match
// ("deploy flow" won't find a memory titled "CI/CD notes") — but it keeps
// recall working with no key, offline, or when the side query fails.
export function keywordRecall(query: string, candidates: MemoryEntry[]): MemoryEntry[] {
    const queryWords = new Set(
        query.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
    );
    if (queryWords.size === 0) return [];
    const scored: { memory: MemoryEntry; score: number }[] = [];
    for (const memory of candidates) {
        const words = new Set(memory.content.toLowerCase().split(/\W+/));
        let score = 0;
        for (const w of queryWords) if (words.has(w)) score++;
        if (score > 0) scored.push({ memory, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RECALLED_MEMORIES).map((s) => s.memory);
}

export interface RelevantMemory extends MemoryEntry {
    header: string;   // provenance + freshness line shown above the content
}

function truncateMemoryContent(content: string): string {
    if (Buffer.byteLength(content, "utf-8") <= MAX_MEMORY_BYTES_PER_FILE) return content;
    return Buffer.from(content, "utf-8").subarray(0, MAX_MEMORY_BYTES_PER_FILE).toString("utf-8")
        + "\n\n[... truncated, memory file too large ...]";
}

function toRelevantMemory(memory: MemoryEntry): RelevantMemory {
    const freshness = memoryFreshnessWarning(memory.mtimeMs);
    const header = freshness
        ? `${freshness}\n\nMemory (saved ${memoryAge(memory.mtimeMs)}): ${memory.path}:`
        : `Memory (saved ${memoryAge(memory.mtimeMs)}): ${memory.path}:`;
    return { ...memory, content: truncateMemoryContent(memory.content), header };
}

// Ask the side model to pick relevant memories from the manifest (filenames +
// descriptions only, so input tokens stay tiny). Any failure — throw, unparsable
// reply, empty pick — falls back to keyword scoring. Recall must never block
// or break the main loop.
export async function selectRelevantMemories(
    query: string,
    sideQuery: SideQueryFn,
    alreadySurfaced: Set<string>,
    options: MemoryOptions = {},
    signal?: AbortSignal,
): Promise<RelevantMemory[]> {
    const candidates = listMemories(options).filter((m) => !alreadySurfaced.has(m.path));
    if (candidates.length === 0) return [];

    let picked: MemoryEntry[] = [];
    try {
        const manifest = candidates
            .map((m) => `- ${m.filename}: ${m.description || m.name}`)
            .join("\n");
        const text = await sideQuery(SELECT_MEMORIES_PROMPT, `Query: ${query}\n\nAvailable memories:\n${manifest}`, signal);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]) as { selected_memories?: unknown };
            const filenames = new Set(
                (Array.isArray(parsed.selected_memories) ? parsed.selected_memories : [])
                    .map(String),
            );
            picked = candidates.filter((m) => filenames.has(m.filename));
        }
    } catch (e: any) {
        if (signal?.aborted) return [];
        // Silent degradation: keyword recall replaces the failed side query.
        console.error(`[memory] semantic recall failed, falling back to keywords: ${e?.message ?? e}`);
    }
    if (picked.length === 0) picked = keywordRecall(query, candidates);

    return picked.slice(0, MAX_RECALLED_MEMORIES).map(toRelevantMemory);
}

// ── Async prefetch ───────────────────────────────────────────

export interface MemoryPrefetch {
    promise: Promise<RelevantMemory[]>;
    settled: boolean;
    consumed: boolean;
}

// Gates, cheapest first: a query too short to match semantically, a session
// budget already spent, or nothing to recall at all — each skips the side
// query entirely.
function isSubstantiveQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) return false;
    // CJK has no spaces; two or more CJK chars is a matchable query.
    const cjkChars = trimmed.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
    if (cjkChars >= 2) return true;
    return trimmed.split(/\s+/).filter(Boolean).length >= 2;
}

export function startMemoryPrefetch(
    query: string,
    sideQuery: SideQueryFn,
    alreadySurfaced: Set<string>,
    sessionMemoryBytes: number,
    options: MemoryOptions = {},
    signal?: AbortSignal,
): MemoryPrefetch | null {
    if (!isSubstantiveQuery(query)) return null;
    if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;
    const fresh = listMemories(options).filter((m) => !alreadySurfaced.has(m.path));
    if (fresh.length === 0) return null;

    const handle: MemoryPrefetch = {
        promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, options, signal),
        settled: false,
        consumed: false,
    };
    handle.promise
        .then(() => { handle.settled = true; })
        .catch(() => { handle.settled = true; });
    return handle;
}

// ── Injection ────────────────────────────────────────────────

export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
    return memories
        .map((m) => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`)
        .join("\n\n");
}

// ── System prompt section ────────────────────────────────────

// Injected into the dynamic system context each turn: teaches the taxonomy,
// the write path, and restraint. The index rides along so the model knows
// what it already remembers before deciding to save more.
export function buildMemoryPromptSection(options: MemoryOptions = {}): string {
    const memories = listMemories(options);
    const dirs = getMemoryDirs(options);
    const index = truncateIndexText(
        memories.map((m) => `- [${m.source}] ${m.filename} (${m.type}) - ${m.description || m.name}`).join("\n"),
    );

    return `# Memory System

You have a persistent, file-based memory. Project memories live in \`${dirs[0].dir}\`; user-global memories (preferences that apply everywhere) in \`${dirs[1].dir}\`. Relevant memories are recalled and injected into the conversation automatically.

## Memory Types
- **user**: The user's role, preferences, knowledge level
- **feedback**: Corrections AND confirmations of your behavior. Body must include **Why:** and **How to apply:** lines
- **project**: Ongoing work, goals, decisions, deadlines. Convert relative dates to absolute ("Thursday" -> "2026-03-05")
- **reference**: Pointers to external resources (URLs, dashboards, tickets)

## How to Save
Use the memory tool with operation "save". One fact per file; the filename is derived as {type}_{name}.md and the index is rebuilt automatically.

## What NOT to Save
- Code patterns, architecture, file paths - read the code instead
- Git history or past fixes - use git log
- Anything already in CLAUDE.md or AGENTS.md
- Ephemeral task details that only matter to the current conversation
Only save what cannot be derived from the current project state.

## Current Memory Index
${memories.length > 0 ? index : "(No memories saved yet.)"}`;
}
