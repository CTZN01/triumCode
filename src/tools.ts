import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, type Dirent } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, basename, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { getSkill, resolveSkillPrompt } from "./skills.js";
import { saveMemory, listMemories, MEMORY_TYPES, type MemoryType } from "./memory.js";

// ═══════════════════════════════════════════════════════════════
// Tool Interface — each tool's complete behavior contract
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Todo types
// ═══════════════════════════════════════════════════════════════

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
    id: number;
    content: string;
    status: TodoStatus;
}

// Context threaded into every tool call. Add fields as new cross-cutting
// concerns appear (permissions, telemetry, abort signal …).
export interface ToolContext {
    readFileState?: ReadFileState;
    askUser?: (question: string, options?: string[]) => Promise<string>;
    permissionPolicy?: import("./permissions.js").PermissionPolicy;
    confirmPermission?: (message: string) => Promise<boolean>;
    enterPlanMode?: () => Promise<string>;
    exitPlanMode?: () => Promise<string>;
    todos?: TodoItem[];
}

export interface Tool {
    name: string;
    description: string;
    inputSchema: Anthropic.Tool.InputSchema;

    // ── Behavior contract (input-aware) ───────────────────────
    // Receives the parsed input so the same tool can have different safety
    // semantics for different arguments (e.g. `ls` vs `rm` in run_command).
    isConcurrencySafe(input: Record<string, any>): boolean;
    isReadOnly(input: Record<string, any>): boolean;
    isDestructive(input: Record<string, any>): boolean;

    // Results larger than this are truncated before being sent back to the
    // model. Per-tool because a 50 KB file listing is fine, but a 50 KB
    // grep output floods the context window.
    maxResultSizeChars: number;

    // `deferred` withholds the schema until the model asks for it by name
    // through tool_search. Activation is sticky — once bought, it stays.
    deferred?: boolean;

    // ── Execution ─────────────────────────────────────────────
    call(input: Record<string, any>, context: ToolContext): Promise<string>;

    // ── System prompt guidance ────────────────────────────────
    // Returns a fragment injected into the system prompt so the model
    // knows how to use this tool correctly. Empty string = nothing added.
    prompt(): string;
}

// ═══════════════════════════════════════════════════════════════
// Tool Registry
// ═══════════════════════════════════════════════════════════════

export const toolRegistry = new Map<string, Tool>();

function register(tool: Tool): Tool {
    toolRegistry.set(tool.name, tool);
    return tool;
}

// Look up a tool by name. Returns undefined for unknown tools.
export function getTool(name: string): Tool | undefined {
    return toolRegistry.get(name);
}

// All tools known to the system (for iteration, system prompt, etc.).
export function getAllTools(): Tool[] {
    return [...toolRegistry.values()];
}

// ═══════════════════════════════════════════════════════════════
// Read-before-edit guard
// ═══════════════════════════════════════════════════════════════

// Guards three failures: a blind edit (old_string written from memory of a
// state that was never current), a stale overwrite (the user edited the file
// after we read it), and a repeat read (the model asking again for content it
// already has, which costs a full file's worth of tokens for nothing). The map
// is threaded in by the caller, not held here — "has this been read" is
// per-conversation, and two agents in one process must not license each
// other's writes.
export interface ReadRecord {
    /** mtime at the last read, for the stale-write guard. */
    mtimeMs: number;
    /**
     * Line ranges already handed to the model, merged and sorted. A repeat
     * read of a range in here is answered with a notice instead of the
     * content — but only while that content is still in the conversation, so
     * the caller drops these when compression evicts the result.
     */
    ranges: Array<[number, number]>;
    /** Line count at the last read, so a shrunk file invalidates the ranges. */
    totalLines: number;
}

export type ReadFileState = Map<string, ReadRecord>;

/**
 * Note that the model has seen `range` of this file.
 *
 * Without a range (a write, which the model authored itself) the ranges are
 * cleared rather than kept: the file changed, so anything the model was shown
 * before is no longer what is on disk. The mtime is still recorded, which is
 * what lets a write follow a read without a second read in between.
 */
function recordRead(
    absPath: string,
    state: ReadFileState,
    range?: [number, number],
    totalLines?: number,
): void {
    let mtimeMs: number;
    try {
        mtimeMs = statSync(absPath).mtimeMs;
    } catch {
        return;  // raced with a delete
    }

    const previous = state.get(absPath);
    const carried = previous && previous.mtimeMs === mtimeMs ? previous.ranges : [];
    state.set(absPath, {
        mtimeMs,
        ranges: range ? mergeRange(carried, range) : [],
        totalLines: totalLines ?? (previous && previous.mtimeMs === mtimeMs ? previous.totalLines : 0),
    });
}

/** Insert a range into a sorted, merged list. */
function mergeRange(ranges: Array<[number, number]>, next: [number, number]): Array<[number, number]> {
    const merged: Array<[number, number]> = [];
    for (const range of [...ranges, next].sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
        else merged.push([range[0], range[1]]);
    }
    return merged;
}

// Whether the model has already been shown this exact range of an unchanged
// file. Anything that could make the earlier content wrong — a different
// mtime, a different line count — answers false.
function alreadyShown(
    absPath: string,
    state: ReadFileState,
    range: [number, number],
    totalLines: number,
): boolean {
    const record = state.get(absPath);
    if (!record || record.totalLines !== totalLines) return false;
    try {
        if (statSync(absPath).mtimeMs !== record.mtimeMs) return false;
    } catch {
        return false;
    }
    return record.ranges.some(([start, end]) => start <= range[0] && end >= range[1]);
}

// Null when the write may proceed, or the message to hand back to the model.
function staleWrite(absPath: string, verb: string, state: ReadFileState): string | null {
    if (!existsSync(absPath)) return null;
    const seen = state.get(absPath);
    if (seen === undefined) {
        return `Error: You must read this file before ${verb} it. Use read_file first to see its current contents.`;
    }
    let current: number;
    try {
        current = statSync(absPath).mtimeMs;
    } catch (e: any) {
        return `Error: cannot stat ${absPath}: ${e.message}`;
    }
    if (current !== seen.mtimeMs) {
        return `Warning: ${absPath} was modified externally since you last read it. Read it again before ${verb} it, so you are working from its current contents.`;
    }
    return null;
}

// Only reached for a tool that is not in the registry, which cannot happen
// through the agent loop — the model can only call tools it was given.
const DEFAULT_MAX_RESULT_CHARS = 50_000;

/**
 * The per-tool result cap, in characters. Each tool declares its own, so a
 * 50 KB file listing passes through whole while a 50 KB grep output does not.
 */
export function toolResultLimit(name: string): number {
    return getTool(name)?.maxResultSizeChars ?? DEFAULT_MAX_RESULT_CHARS;
}

// ═══════════════════════════════════════════════════════════════
// Tool Definitions
// ═══════════════════════════════════════════════════════════════

// ─── read_file ───────────────────────────────────────────────

// A read returns at most this many lines unless the model asks for fewer.
// Without a cap the only limit was the tool result size, and a result over
// that limit came back as a short preview of a file the model then could not
// see — so the cap belongs here, where the model can page past it.
export const READ_DEFAULT_LINES = 2_000;
const READ_MAX_LINES = 5_000;
// Past this the file is not something to read into a conversation at all.
const READ_MAX_BYTES = 20 * 1024 * 1024;

type ReadResult =
    | { ok: true; text: string; start: number; end: number; totalLines: number }
    | { ok: false; message: string };

// A binary file decoded as utf-8 is a wall of replacement characters: real
// tokens, no information, and it displaces whatever the model was working on.
function looksBinary(buffer: Buffer): boolean {
    return buffer.subarray(0, 8_000).includes(0);
}

// The model does not always send a number, and the schema is not enforced by
// the API. A NaN that reaches the line maths renders as "NaN | line" all the
// way down the result.
function wholeNumber(value: unknown, fallback: number): number {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : fallback;
}

function readFileImpl(input: { file_path: string; offset?: number; limit?: number }): ReadResult {
    let buffer: Buffer;
    try {
        buffer = readFileSync(input.file_path);
    } catch (e: any) {
        return { ok: false, message: `Error reading file: ${e.message}` };
    }

    if (looksBinary(buffer)) {
        return { ok: false, message: `Error: ${input.file_path} is a binary file. read_file returns text only — use grep_search to find what you need in it.` };
    }
    if (buffer.byteLength > READ_MAX_BYTES) {
        return { ok: false, message: `Error: ${input.file_path} is ${Math.round(buffer.byteLength / 1_048_576)} MB, too large to read. Use grep_search to find what you need, or read it with offset/limit through run_command.` };
    }

    const lines = buffer.toString("utf-8").split("\n");
    const totalLines = lines.length;

    const start = Math.max(1, wholeNumber(input.offset, 1));
    if (start > totalLines) {
        return { ok: false, message: `Error: offset ${start} is past the end of ${input.file_path}, which has ${totalLines} lines.` };
    }

    const count = Math.min(Math.max(1, wholeNumber(input.limit, READ_DEFAULT_LINES)), READ_MAX_LINES);
    const end = Math.min(totalLines, start + count - 1);

    // Pad to the widest line number in this slice rather than to a fixed
    // width: on a file of a few hundred lines that is most of the padding.
    const width = String(end).length;
    let text = lines
        .slice(start - 1, end)
        .map((line, i) => `${String(start + i).padStart(width)} | ${line}`)
        .join("\n");

    if (end < totalLines) {
        text += `\n\n[lines ${start}-${end} of ${totalLines}. Continue with offset=${end + 1}.]`;
    }

    return { ok: true, text, start, end, totalLines };
}

const readFileTool = register({
    name: "read_file",
    description: "Read the contents of a text file, with line numbers. Returns up to 2000 lines by default; pass offset and limit to page through a longer file. Reading a range you have already been shown returns a short notice instead of the content again.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "The path to the file to read" },
            offset: { type: "number", description: "Line number to start at, 1-based. Defaults to 1." },
            limit: { type: "number", description: "How many lines to return, at most 5000. Defaults to 2000." },
        },
        required: ["file_path"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 100_000,

    async call(input, ctx) {
        const result = readFileImpl(input as { file_path: string; offset?: number; limit?: number });
        if (!result.ok) return result.message;

        const absPath = resolve(input.file_path);
        const range: [number, number] = [result.start, result.end];

        if (ctx.readFileState && alreadyShown(absPath, ctx.readFileState, range, result.totalLines)) {
            return `${input.file_path} is unchanged since you read lines ${result.start}-${result.end} of it, and that content is already above in this conversation. Pass a different offset or limit if you need another part of the file.`;
        }
        if (ctx.readFileState) {
            recordRead(absPath, ctx.readFileState, range, result.totalLines);
        }
        return result.text;
    },

    prompt: () => "Always read a file before editing or writing to it. read_file returns the first 2000 lines unless you pass offset/limit — page through a longer file rather than assuming you have seen all of it.",
});

// ─── write_file ──────────────────────────────────────────────

// Atomic write: bytes land in a sibling temp file first, then rename.
// If we crash or the disk fills up mid-write, the original file is intact.
function writeFileImpl(input: { file_path: string; content: string }): string {
    const target = input.file_path;
    const dir = dirname(target);
    const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, input.content, "utf-8");
        renameSync(tmp, target);
        const lines = input.content.split("\n").length;
        const bytes = Buffer.byteLength(input.content, "utf-8");
        return `Successfully wrote ${target} (${lines} lines, ${bytes} bytes)`;
    } catch (e: any) {
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        return `Error writing file: ${e.message}`;
    }
}

const writeFileTool = register({
    name: "write_file",
    description: "Write content to a file. Create the file if it does not exist, and overwrite it if it does. Returns a success message.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "The path to the file to write" },
            content: { type: "string", description: "The content to write to the file" }
        },
        required: ["file_path", "content"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => true,
    maxResultSizeChars: 2_000,

    async call(input, ctx) {
        const absPath = resolve(input.file_path);
        if (ctx.readFileState) {
            const blocked = staleWrite(absPath, "writing", ctx.readFileState);
            if (blocked !== null) return blocked;
        }
        const result = writeFileImpl(input as { file_path: string; content: string });
        if (ctx.readFileState && !result.startsWith("Error")) {
            recordRead(absPath, ctx.readFileState);
        }
        return result;
    },

    prompt: () => "write_file overwrites the entire file. Prefer edit_file for partial changes.",
});

// ─── edit_file ───────────────────────────────────────────────

function matchLines(content: string, needle: string): number[] {
    const lines: number[] = [];
    for (let i = content.indexOf(needle); i !== -1 && lines.length < 5; i = content.indexOf(needle, i + needle.length)) {
        lines.push(content.slice(0, i).split("\n").length);
    }
    return lines;
}

function editFileImpl(input: { file_path: string; old_string: string; new_string: string }): string {
    if (input.old_string === "") return "Error: old_string must not be empty.";

    let content: string;
    try {
        content = readFileSync(input.file_path, "utf-8");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }

    let oldString = input.old_string;
    let newString = input.new_string;

    // The file on disk may be CRLF while the model wrote LF; without this, every
    // multi-line edit against a Windows checkout reports "not found".
    if (!oldString.includes("\r\n") && content.includes("\r\n")) {
        oldString = oldString.replace(/\r?\n/g, "\r\n");
        newString = newString.replace(/\r?\n/g, "\r\n");
    }

    if (oldString === newString) return "No change: old_string and new_string are identical.";

    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.file_path}.`;
    if (count > 1) {
        const lines = matchLines(content, oldString).join(", ");
        return `Error: old_string occurs ${count} times in ${input.file_path} (lines ${lines}). Include more surrounding context.`;
    }

    const line = content.slice(0, content.indexOf(oldString)).split("\n").length;
    const replacement = content.split(oldString).join(newString);
    const removedLines = oldString.split("\n").length;
    const addedLines = newString.split("\n").length;
    const written = writeFileImpl({ file_path: input.file_path, content: replacement });
    if (written.startsWith("Error")) return written;
    return `Edited ${input.file_path} at line ${line} (+${addedLines}/-${removedLines} lines)`;
}

const editFileTool = register({
    name: "edit_file",
    description: "Edit a file by replacing an exact string. old_string must occur exactly once in the file — include enough surrounding context to make it unique. Returns the line that changed.",
    inputSchema: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "The path to the file to edit" },
            old_string: { type: "string", description: "The exact string to find. Must be unique in the file." },
            new_string: { type: "string", description: "The string to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    maxResultSizeChars: 2_000,

    async call(input, ctx) {
        const absPath = resolve(input.file_path);
        if (ctx.readFileState) {
            const blocked = staleWrite(absPath, "editing", ctx.readFileState);
            if (blocked !== null) return blocked;
        }
        const result = editFileImpl(input as { file_path: string; old_string: string; new_string: string });
        if (ctx.readFileState && !result.startsWith("Error")) {
            recordRead(absPath, ctx.readFileState);
        }
        return result;
    },

    prompt: () =>
        "edit_file replaces an exact, unique substring. Include enough surrounding context " +
        "to make old_string occur exactly once. Read the file first — the edit will be rejected " +
        "if the file has not been read or was modified since the last read.",
});

// ─── list_files ──────────────────────────────────────────────

// Directories that are almost never what the caller means and can hold tens of
// thousands of entries.
const NOISE_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
    "target", "coverage", "__pycache__", ".venv", "venv", ".next", ".cache",
]);

const LIST_LIMIT = 200;

const clampDepth = (d: unknown, fallback: number): number =>
    Number.isFinite(d) ? Math.min(Math.max(Math.trunc(d as number), 1), 10) : fallback;

type WalkEntry = { abs: string; rel: string; kind: "file" | "dir" | "symlink" };

// Shared tree walk: generator, explicit stack, deterministic sorted order.
function* walkTree(
    root: string,
    maxDepth: number,
    onSkipDir: (rel: string) => void,
    onUnreadable: (rel: string, why: string) => void,
): Generator<WalkEntry> {
    const stack: Array<[string, string, number]> = [[root, "", 0]];
    while (stack.length > 0) {
        const [dirAbs, prefix, depth] = stack.pop()!;
        let entries: Dirent[];
        try {
            entries = readdirSync(dirAbs, { withFileTypes: true });
        } catch (e: any) {
            onUnreadable(prefix || ".", e.code ?? e.message);
            continue;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const descend: Array<[string, string, number]> = [];
        for (const entry of entries) {
            const abs = join(dirAbs, entry.name);
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isSymbolicLink()) {
                yield { abs, rel, kind: "symlink" };
            } else if (entry.isDirectory()) {
                yield { abs, rel, kind: "dir" };
                if (NOISE_DIRS.has(entry.name)) { onSkipDir(rel); continue; }
                if (depth + 1 < maxDepth) descend.push([abs, rel, depth + 1]);
            } else {
                yield { abs, rel, kind: "file" };
            }
        }
        for (let i = descend.length - 1; i >= 0; i--) stack.push(descend[i]);
    }
}

function listFilesImpl(input: { directory_path: string; max_depth?: number }): string {
    const root = input.directory_path;
    let rootStat;
    try { rootStat = statSync(root); } catch (e: any) { return `Error listing files: ${e.message}`; }
    if (!rootStat.isDirectory()) return `Error: ${root} is not a directory. Use read_file to read a file.`;

    const maxDepth = clampDepth(input.max_depth, 4);
    const out: string[] = [];
    const notes: string[] = [];
    const ignored = new Set<string>();
    let truncated = false;

    for (const entry of walkTree(root, maxDepth, (rel) => ignored.add(rel), (rel, why) => notes.push(`unreadable ${rel}/ (${why})`))) {
        if (out.length >= LIST_LIMIT) { truncated = true; break; }
        if (entry.kind === "dir") out.push(`${entry.rel}/`);
        else if (entry.kind === "symlink") out.push(`${entry.rel}@`);
        else out.push(entry.rel);
    }

    if (out.length === 0) return `No files found in ${root}.`;
    const footer: string[] = [];
    if (truncated) footer.push(`truncated at ${LIST_LIMIT} entries — narrow directory_path or lower max_depth`);
    if (ignored.size > 0) footer.push(`not descended into: ${[...ignored].sort().join(", ")}`);
    const extra = [...footer, ...notes];
    return extra.length === 0 ? out.join("\n") : `${out.join("\n")}\n\n${extra.map((line) => `(${line})`).join("\n")}`;
}

const listFilesTool = register({
    name: "list_files",
    description: "List files under a directory, recursively. Returns paths relative to that directory, sorted, one per line; directories end with \"/\" and symlinks with \"@\". Does not descend into node_modules/.git/dist-style directories, and stops after 200 entries.",
    inputSchema: {
        type: "object",
        properties: {
            directory_path: { type: "string", description: "The path to the directory to list files from" },
            max_depth: { type: "number", description: "How many directory levels to list below directory_path. 1 lists just its immediate contents. Defaults to 4, capped at 10." }
        },
        required: ["directory_path"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 30_000,

    async call(input) {
        return listFilesImpl(input as { directory_path: string; max_depth?: number });
    },

    prompt: () => "",
});

// ─── grep_search ─────────────────────────────────────────────

const GREP_MATCH_LIMIT = 100;
const GREP_MAX_DEPTH = 10;
const GREP_SCAN_CEILING = 1000;
const GREP_CHUNK_BYTES = 64 * 1024;
const GREP_LINE_WINDOW = GREP_CHUNK_BYTES;
const GREP_LINE_OVERLAP = 512;
const MAX_MATCH_CHARS = 400;

type ScanResult = "done" | "stopped" | "unreadable";

function scanFile(abs: string, re: RegExp, onMatch: (lineNo: number, text: string) => boolean): ScanResult {
    let fd: number;
    try { fd = openSync(abs, "r"); } catch { return "unreadable"; }
    try {
        const decoder = new StringDecoder("utf-8");
        const buf = Buffer.allocUnsafe(GREP_CHUNK_BYTES);
        let pending = "";
        let lineNo = 0;
        let firstChunk = true;
        let hit = false;
        let pre = "";
        let head = "";

        const endLine = (text: string): boolean => {
            const display = head === "" ? text : head;
            const matched = hit || re.test(pre + text);
            lineNo++;
            hit = false; pre = ""; head = "";
            return matched && onMatch(lineNo, display);
        };

        for (;;) {
            const read = readSync(fd, buf, 0, buf.length, null);
            const last = read === 0;
            pending += decoder.write(buf.subarray(0, read));
            if (last) pending += decoder.end();
            if (firstChunk) {
                if (pending.includes("\0")) return "done";
                firstChunk = false;
            }
            let start = 0;
            for (;;) {
                const nl = pending.indexOf("\n", start);
                if (nl === -1) break;
                const line = pending.slice(start, nl);
                start = nl + 1;
                if (endLine(line)) return "stopped";
            }
            pending = pending.slice(start);
            if (pending.length > GREP_LINE_WINDOW) {
                if (re.test(pre + pending)) hit = true;
                pre = (pre + pending).slice(-GREP_LINE_OVERLAP);
                if (head === "") head = pending.slice(0, MAX_MATCH_CHARS + 1);
                pending = "";
            }
            if (last) break;
        }
        if (pending !== "" || pre !== "") {
            if (endLine(pending)) return "stopped";
        }
        return "done";
    } finally {
        closeSync(fd);
    }
}

function formatMatch(relPath: string, lineNo: number, text: string): string {
    const clipped = text.length > MAX_MATCH_CHARS ? `${text.slice(0, MAX_MATCH_CHARS)}…` : text;
    return `${relPath}:${lineNo}:${clipped}`;
}

type Match = { file: string; line: number; text: string };

function renderMatches(matches: Match[], notes: string[], capped = false): string {
    matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const shown = matches.slice(0, GREP_MATCH_LIMIT);
    const body = shown.length === 0
        ? "No matches found."
        : shown.map((m) => formatMatch(m.file, m.line, m.text)).join("\n");

    const footer = [...notes];
    if (matches.length > shown.length) {
        const perFile = new Map<string, number>();
        for (const m of shown) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
        const [topFile, topCount] = [...perFile].sort((a, b) => b[1] - a[1])[0];
        const culprit = topCount > shown.length / 2 ? `, ${topCount} of them from ${topFile}` : "";
        const atLeast = capped ? "+" : "";
        footer.unshift(`showing ${shown.length} of ${matches.length}${atLeast} matches${culprit} — narrow the path or the pattern`);
    }
    return footer.length === 0 ? body : `${body}\n\n${footer.map((line) => `(${line})`).join("\n")}`;
}

function grepWithSystemGrep(pattern: string, root: string, operand: string): Match[] | string | null {
    const args = ["--line-number", "--with-filename", "--color=never", "--recursive", "-I"];
    for (const dir of NOISE_DIRS) args.push(`--exclude-dir=${dir}`);
    args.push("--", pattern, operand);

    let out: string;
    try {
        out = execFileSync("grep", args, {
            cwd: root,
            encoding: "utf-8",
            maxBuffer: 8 * 1024 * 1024,
            timeout: 10_000,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (e: any) {
        if (e.code === "ENOENT") return null;
        if (e.status === 1) return "No matches found.";
        if (e.code === "ETIMEDOUT") return `Error: search timed out after 10s — narrow the path or the pattern.`;
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `Too many matches (over 8MB) — narrow the path or the pattern.`;
        return `Error searching: ${e.message}`;
    }

    const matches: Match[] = [];
    let unparsed = 0;
    for (const raw of out.split("\n")) {
        if (raw === "") continue;
        const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(raw);
        if (m) matches.push({ file: m[1].replace(/^\.\//, ""), line: Number(m[2]), text: m[3] });
        else unparsed++;
    }
    return unparsed === 0 ? matches : renderMatches(matches, [`could not parse ${unparsed} line(s) of grep output`]);
}

function grepInProcess(re: RegExp, root: string, operand: string, isFile: boolean): { matches: Match[]; notes: string[]; capped: boolean } {
    const matches: Match[] = [];
    const notes: string[] = [];
    const unreadableDirs: string[] = [];
    let unreadableFiles = 0;
    let capped = false;

    const candidates = isFile
        ? [{ abs: join(root, operand), rel: operand, kind: "file" as const }]
        : walkTree(root, GREP_MAX_DEPTH, () => {}, (rel, why) => unreadableDirs.push(`unreadable ${rel}/ (${why})`));

    for (const entry of candidates) {
        if (entry.kind !== "file") continue;
        const result = scanFile(entry.abs, re, (lineNo, text) => {
            matches.push({ file: entry.rel, line: lineNo, text });
            return matches.length >= GREP_SCAN_CEILING;
        });
        if (result === "unreadable") unreadableFiles++;
        else if (result === "stopped") { capped = true; break; }
    }

    if (unreadableFiles > 0) notes.push(`could not read ${unreadableFiles} file(s)`);
    notes.push(...unreadableDirs);
    return { matches, notes, capped };
}

function grepSearchImpl(input: { pattern: string; path: string }): string {
    let re: RegExp;
    try { re = new RegExp(input.pattern); } catch (e: any) { return `Error: invalid regex: ${e.message}`; }

    let stat;
    try { stat = statSync(input.path); } catch (e: any) { return `Error searching: ${e.message}`; }

    const isFile = !stat.isDirectory();
    const root = isFile ? dirname(input.path) : input.path;
    const operand = isFile ? basename(input.path) : ".";

    const viaSystem = grepWithSystemGrep(input.pattern, root, operand);
    if (typeof viaSystem === "string") return viaSystem;
    if (viaSystem !== null) return renderMatches(viaSystem, []);

    const { matches, notes, capped } = grepInProcess(re, root, operand, isFile);
    return renderMatches(matches, notes, capped);
}

const grepSearchTool = register({
    name: "grep_search",
    description: "Search for a regex pattern in files. Recurses through a directory, or searches a single file. Returns matches as \"path:line: text\", one per line, with paths relative to the searched directory. Skips node_modules/.git/dist-style directories and binary files, stops after 100 matches, and clips very long lines.",
    inputSchema: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "The regex pattern to search for (JavaScript/RE2-flavoured, unanchored — it matches anywhere in the line)" },
            path: { type: "string", description: "The path to the directory or file to search in" }
        },
        required: ["pattern", "path"]
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 30_000,

    async call(input) {
        return grepSearchImpl(input as { pattern: string; path: string });
    },

    prompt: () => "grep_search uses JavaScript regex syntax. Anchor with ^/$ when needed. Results are capped at 100 matches — narrow the path or pattern if truncated.",
});

// ─── run_command ─────────────────────────────────────────────

const RUN_TIMEOUT_MS = 30_000;
const RUN_MAX_CHARS = 30_000;

// Input-aware classification: the same tool has different safety semantics
// depending on what command the model asks to run.
const READONLY_COMMANDS = new Set([
    "ls", "dir", "cat", "head", "tail", "wc", "echo", "pwd", "whoami",
    "which", "where", "node", "python", "python3", "tsc", "eslint",
    "prettier", "jest", "vitest", "mocha", "pytest", "cargo",
]);
const GIT_READONLY_ARGS = new Set(["status", "log", "diff", "show", "branch", "tag", "remote"]);
const DESTRUCTIVE_PATTERNS = [/\brm\b/, /\brmdir\b/, /\bdel\b/, /\bdrop\b/i, /\btruncate\b/i, /\bkill\b/];
const MUTATING_COMMANDS = new Set([
    "npm", "npx", "yarn", "pnpm", "pip", "pip3", "cargo", "go",
    "make", "cmake", "mvn", "gradle",
]);

function classifyCommand(input: Record<string, any>): { readonly: boolean; safe: boolean; destructive: boolean } {
    const cmd = String(input.command ?? "").toLowerCase();
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    const joined = `${cmd} ${args.join(" ")}`;

    const destructive = DESTRUCTIVE_PATTERNS.some(p => p.test(joined));

    // git is read-only for status/log/diff, mutating for commit/push/reset.
    if (cmd === "git") {
        const sub = args[0]?.toLowerCase() ?? "";
        const readonly = GIT_READONLY_ARGS.has(sub);
        return { readonly, safe: readonly, destructive: sub === "reset" || sub === "clean" };
    }

    // Pure read-only commands (ls, cat, echo, tsc, jest, …).
    if (READONLY_COMMANDS.has(cmd) && !destructive) {
        return { readonly: true, safe: true, destructive: false };
    }

    // Package managers and build tools mutate the filesystem but are safe to
    // run concurrently with other reads.
    if (MUTATING_COMMANDS.has(cmd)) {
        return { readonly: false, safe: false, destructive: false };
    }

    // Unknown command: assume unsafe.
    return { readonly: false, safe: false, destructive };
}

function killTree(child: ChildProcess): void {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
    } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
}

function noExecutable(command: string, args: string[]): string {
    const hints: string[] = [];
    if (args.length === 0 && /\s/.test(command)) {
        hints.push(`"${command}" contains a space — put the program in "command" and each argument in "args".`);
    }
    if (process.platform === "win32") {
        hints.push(
            "This tool runs programs directly, without a shell, so Windows .cmd/.bat shims " +
            "(npm, npx, yarn, tsc, ...) cannot be launched. Invoke the underlying program with " +
            "\"node\" instead — command \"node\", args [\"node_modules/<pkg>/bin/<entry>.js\", ...]."
        );
    }
    return [`Error: no such executable: ${command}`, ...hints].join("\n");
}

// ─── Windows .cmd shim resolver ───────────────────────────────
// On Windows, npm/npx/yarn/tsc are .cmd batch files that can't be executed
// by spawn(shell:false). When a command fails with ENOENT/EINVAL on Windows,
// this function finds the .cmd shim, parses it to extract the underlying
// `node <script>.js` invocation, and returns the resolved command.

function resolveWindowsShim(command: string): { cmd: string; script: string } | null {
    if (process.platform !== "win32") return null;

    // Locate the .cmd shim via PATH.
    let cmdPath: string;
    try {
        const output = execFileSync("where", [command], {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
        });
        cmdPath = output.split(/\r?\n/).find(l => l.trim().toLowerCase().endsWith(".cmd"))?.trim() ?? "";
    } catch {
        return null;
    }
    if (!cmdPath) return null;

    // Read the .cmd file and find the JS script it ultimately runs.
    // Standard npm/npx .cmd shims set a *CLI_JS variable via
    //   SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"
    // then invoke it with  "%<VAR>" %*
    // Resolve the variable to its %~dp0-relative path.
    try {
        const content = readFileSync(cmdPath, "utf-8");
        const shimDir = dirname(cmdPath).replace(/\\/g, "/");

        // Look for SET "*CLI_JS=%~dp0\<path>.js" (the script variable).
        const varMatch = /SET\s+"(\w*CLI_JS)=(%\~dp0\\[^"]+\.js)"/im.exec(content);
        if (varMatch) {
            const jsFile = varMatch[2].replace(/^%\~dp0\\/i, shimDir + "/").replace(/\\/g, "/");
            if (existsSync(jsFile)) return { cmd: "node", script: jsFile };
        }

        // Fallback: look for the direct final invocation line.
        const directMatch = /(?:^|\n)\s*"(?:%\~dp0\\)?node\.exe"\s+"(%\~dp0\\[^"]+\.js)"\s+%\*/im.exec(content);
        if (directMatch) {
            const jsFile = directMatch[1].replace(/^%\~dp0\\/i, shimDir + "/").replace(/\\/g, "/");
            if (existsSync(jsFile)) return { cmd: "node", script: jsFile };
        }
    } catch {
        // Fall through to the normal error path.
    }
    return null;
}

// Spawn a process and capture its output. Used by runCommandImpl — called
// once for the original command, and again if a Windows .cmd shim is resolved.
function spawnAndCapture(
    command: string,
    args: string[],
    cwd: string,
    onFinish: (result: string) => void,
): void {
    let child: ChildProcess;
    try {
        child = spawn(command, args, {
            cwd,
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (e: any) {
        onFinish(`Error running ${command}: ${e.message}`);
        return;
    }

    const started = Date.now();
    const outDecoder = new StringDecoder("utf-8");
    const errDecoder = new StringDecoder("utf-8");
    let out = "";
    let err = "";
    let outBytes = 0;
    let errBytes = 0;
    let clippedOut = false;
    let clippedErr = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => { timedOut = true; killTree(child); }, RUN_TIMEOUT_MS);

    const finish = (result: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onFinish(result);
    };

    const capture = (chunk: Buffer, decoder: StringDecoder, stream: "out" | "err"): void => {
        const text = decoder.write(chunk);
        if (stream === "out") {
            outBytes += chunk.length;
            if (out.length < RUN_MAX_CHARS) out += text; else clippedOut = true;
        } else {
            errBytes += chunk.length;
            if (err.length < RUN_MAX_CHARS) err += text; else clippedErr = true;
        }
    };

    child.stdout?.on("data", (c: Buffer) => capture(c, outDecoder, "out"));
    child.stderr?.on("data", (c: Buffer) => capture(c, errDecoder, "err"));

    child.on("error", (e: any) => {
        if (e.code === "ENOENT" || (process.platform === "win32" && e.code === "EINVAL")) {
            finish(noExecutable(command, args));
            return;
        }
        finish(`Error running ${command}: ${e.message}`);
    });

    child.on("close", (code, signal) => {
        out = (out + outDecoder.end()).slice(0, RUN_MAX_CHARS);
        err = (err + errDecoder.end()).slice(0, RUN_MAX_CHARS);

        const status = timedOut
            ? `timed out after ${RUN_TIMEOUT_MS / 1000}s — killed`
            : signal !== null ? `killed by ${signal}` : `exit ${code}`;

        const body: string[] = [];
        if (out.trim() !== "") body.push(out.trimEnd());
        if (err.trim() !== "") body.push(`stderr:\n${err.trimEnd()}`);
        if (body.length === 0) body.push("(no output)");

        const footer: string[] = [];
        if (clippedOut) footer.push(`stdout truncated at ${RUN_MAX_CHARS} chars (${outBytes} bytes total)`);
        if (clippedErr) footer.push(`stderr truncated at ${RUN_MAX_CHARS} chars (${errBytes} bytes total)`);

        const text = `${status} · ${Date.now() - started}ms\n${body.join("\n\n")}`;
        finish(footer.length === 0 ? text : `${text}\n\n${footer.map((l) => `(${l})`).join("\n")}`);
    });
}

function runCommandImpl(input: { command: string; args?: string[]; cwd?: string }): Promise<string> {
    const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
    const cwd = input.cwd || process.cwd();

    return new Promise<string>((resolve) => {
        // Wrap resolve to intercept ENOENT/EINVAL on Windows and auto-resolve
        // .cmd shims (npm, npx, yarn, tsc, …) to their underlying node command.
        const finish = (result: string): void => {
            if (process.platform === "win32" && result.startsWith("Error: no such executable:")) {
                const shim = resolveWindowsShim(input.command);
                if (shim) {
                    spawnAndCapture(shim.cmd, [shim.script, ...args], cwd, resolve);
                    return;
                }
            }
            resolve(result);
        };

        spawnAndCapture(input.command, args, cwd, finish);
    });
}

const runCommandTool = register({
    name: "run_command",
    description: "Run a program and return its exit code, stdout and stderr. There is NO shell: pipes, redirects, globs and \"&&\" are not interpreted, so pass the program in \"command\" and each argument in \"args\". A non-zero exit code is a normal result, not an error. Times out after 30s.",
    inputSchema: {
        type: "object",
        properties: {
            command: { type: "string", description: "The program to run, e.g. \"node\", \"git\", \"python3\"" },
            args: { type: "array", items: { type: "string" }, description: "Each argument as its own array element, e.g. [\"--version\"]" },
            cwd: { type: "string", description: "Working directory. Defaults to the current directory." }
        },
        required: ["command"]
    },
    isConcurrencySafe: (input) => classifyCommand(input).safe,
    isReadOnly: (input) => classifyCommand(input).readonly,
    isDestructive: (input) => classifyCommand(input).destructive,
    maxResultSizeChars: 30_000,

    async call(input) {
        return runCommandImpl(input as { command: string; args?: string[]; cwd?: string });
    },

    prompt: () =>
        "run_command runs a program directly — there is NO shell, so pipes, redirects, " +
        "and && do not work. Put the program in \"command\" and each argument separately in \"args\". " +
        "Windows .cmd shims (npm, npx, yarn) are automatically resolved to their underlying node command.",
});

// ─── git_diff ────────────────────────────────────────────────

const GIT_DIFF_MAX_CHARS = 100_000;

function gitDiffImpl(input: { cwd?: string; staged?: boolean; path?: string }): string {
    const args = ["diff"];
    if (input.staged === true) args.push("--cached");
    if (input.path) args.push("--", input.path);

    try {
        const output = execFileSync("git", args, {
            cwd: input.cwd || process.cwd(),
            encoding: "utf-8",
            maxBuffer: GIT_DIFF_MAX_CHARS * 8,
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const diff = output.trimEnd();
        if (diff === "") return "No changes.";
        if (diff.length > GIT_DIFF_MAX_CHARS) {
            return `${diff.slice(0, GIT_DIFF_MAX_CHARS)}\n\n(diff truncated at ${GIT_DIFF_MAX_CHARS} characters)`;
        }
        return diff;
    } catch (e: any) {
        if (e.code === "ENOENT") {
            return input.cwd
                ? `Error running git diff: working directory does not exist: ${input.cwd}`
                : "Error: git executable not found.";
        }
        if (e.code === "ETIMEDOUT") return "Error: git diff timed out after 10s.";
        const detail = String(e.stderr ?? e.message ?? "git diff failed").trim();
        return `Error running git diff: ${detail}`;
    }
}

const gitDiffTool = register({
    name: "git_diff",
    description: "Show the Git diff for the working tree or staged changes. Read-only; optionally limit the diff to one path.",
    inputSchema: {
        type: "object",
        properties: {
            cwd: { type: "string", description: "Git working directory. Defaults to the current directory." },
            staged: { type: "boolean", description: "Show staged changes instead of working-tree changes." },
            path: { type: "string", description: "Optional file or directory path to limit the diff." },
        },
        required: [],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: GIT_DIFF_MAX_CHARS,

    async call(input) {
        return gitDiffImpl(input as { cwd?: string; staged?: boolean; path?: string });
    },

    prompt: () => "Use git_diff to inspect changes before editing or reporting implementation status.",
});

// ─── ask_user ─────────────────────────────────────────────

const askUserTool = register({
    name: "ask_user",
    description: "Ask the user a question and wait for their response. Use this when you need clarification, want to confirm an approach, or need the user to choose between options. The user can also skip by pressing Enter without typing anything.",
    inputSchema: {
        type: "object",
        properties: {
            question: { type: "string", description: "The question to ask the user" },
            options: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of choices for the user to pick from (numbered). If omitted, the user types a free-text response."
            },
        },
        required: ["question"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 2_000,

    async call(input, ctx) {
        const question = String(input.question ?? "");
        const options = Array.isArray(input.options) ? input.options.map(String) : undefined;

        if (!question) return "Error: question must not be empty.";
        if (!ctx.askUser) return "Error: ask_user is not available in this context.";

        return ctx.askUser(question, options);
    },

    prompt: () =>
        "Use ask_user when you need to ask the user a question mid-task. " +
        "Provide 2-3 options when the choice is constrained, or omit options for open-ended questions. " +
        "The user may skip without answering — respect that and continue with your best judgment.",
});

// ─── skill ───────────────────────────────────────────────────

register({
    name: "skill",
    description: "Load a reusable project or user skill by name. The returned prompt is the complete instructions for that skill.",
    inputSchema: {
        type: "object",
        properties: {
            name: { type: "string", description: "Skill name" },
            arguments: { type: "string", description: "Arguments passed to the skill" },
        },
        required: ["name"],
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 50_000,

    async call(input) {
        const name = String(input.name ?? "").trim();
        if (!name) return "Error: skill name must not be empty.";
        const skill = getSkill(name);
        if (!skill) return `Error: skill \"${name}\" was not found.`;
        const prompt = resolveSkillPrompt(name, String(input.arguments ?? ""));
        if (!prompt) return `Error: skill \"${name}\" could not be loaded.`;
        const allowed = skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "all available tools";
        return `${prompt}\nAllowed tools for this skill: ${allowed}`;
    },

    prompt: () =>
        "Use skill when a listed reusable skill matches the user's request. " +
        "Load the skill before acting and follow its prompt and allowed-tools. " +
        "Skills with mode=fork should be treated as isolated sub-agent work.",
});

// ─── Plan mode tools ────────────────────────────────────────

register({
    name: "enter_plan_mode",
    description: "Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.",
    inputSchema: {
        type: "object",
        properties: {},
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 5_000,

    async call(_input, context) {
        if (!context.enterPlanMode) return "Error: plan mode is unavailable in this context.";
        return context.enterPlanMode();
    },

    prompt: () => "",
    deferred: true,
});

register({
    name: "exit_plan_mode",
    description: "Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.",
    inputSchema: {
        type: "object",
        properties: {},
    },
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 5_000,

    async call(_input, context) {
        if (!context.exitPlanMode) return "Error: plan mode is unavailable in this context.";
        return context.exitPlanMode();
    },

    prompt: () => "",
    deferred: true,
});

// ─── todo ───────────────────────────────────────────────────

const TODO_STATUS_ICONS: Record<TodoStatus, string> = {
    pending: "⬜",
    in_progress: "🔄",
    completed: "✅",
};

function formatTodoList(todos: TodoItem[]): string {
    if (todos.length === 0) return "No todos.";
    const done = todos.filter((t) => t.status === "completed").length;
    const lines = todos.map((t) => `${TODO_STATUS_ICONS[t.status]} [${t.id}] ${t.content}`);
    lines.push(`\nTotal: ${todos.length} | Completed: ${done}/${todos.length}`);
    return lines.join("\n");
}

register({
    name: "todo",
    description: "Manage a task todo list. Use 'write' to create or update the entire list (pass all todos). Use 'read' to view the current list. Each todo has an id (integer), content (string), and status: pending, in_progress, or completed. Update status as you work through tasks.",
    inputSchema: {
        type: "object",
        properties: {
            operation: {
                type: "string",
                enum: ["write", "read"],
                description: "Operation: 'write' replaces the entire todo list, 'read' returns the current list."
            },
            todos: {
                type: "array",
                description: "Array of todo items. Required for 'write'.",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "integer", description: "Unique integer id for the todo" },
                        content: { type: "string", description: "Description of the task" },
                        status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Current status" },
                    },
                    required: ["id", "content", "status"],
                },
            },
        },
        required: ["operation"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 5_000,

    async call(input, context) {
        const operation = String(input.operation ?? "");

        if (operation === "read") {
            const todos = context.todos ?? [];
            return formatTodoList(todos);
        }

        if (operation === "write") {
            if (!Array.isArray(input.todos)) {
                return "Error: 'todos' array is required for write operation.";
            }
            const todos: TodoItem[] = input.todos.map((t: any) => ({
                id: Number(t.id),
                content: String(t.content ?? ""),
                status: (["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending") as TodoStatus,
            }));
            context.todos = todos;
            return formatTodoList(todos);
        }

        return `Error: unknown operation "${operation}". Use "write" or "read".`;
    },

    prompt: () =>
        "Use the todo tool to manage a structured task list when working on multi-step tasks. " +
        "Call write to create or update the full todo list at the start of a task or when the plan changes. " +
        "Mark items as in_progress before working on them, and completed when done. " +
        "Call read to check current progress. Keep todos concise and actionable.",
});

// ─── memory ──────────────────────────────────────────────────

register({
    name: "memory",
    description: "Save a persistent memory about the user or project, or list saved memories. Memories survive across sessions and are recalled automatically when relevant. Types: user (preferences, background), feedback (behavior corrections/confirmations, include Why and How to apply), project (goals, decisions, deadlines - absolute dates only), reference (external resource pointers).",
    inputSchema: {
        type: "object",
        properties: {
            operation: {
                type: "string",
                enum: ["save", "list"],
                description: "Operation: 'save' writes one memory file, 'list' returns all saved memories.",
            },
            name: { type: "string", description: "Short kebab-case identifier, e.g. 'prefers-concise-output'. Required for save." },
            description: { type: "string", description: "One-line summary used for recall matching. Required for save." },
            type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type. Required for save." },
            content: { type: "string", description: "The memory body. Required for save." },
        },
        required: ["operation"],
    },
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    maxResultSizeChars: 5_000,

    async call(input) {
        const operation = String(input.operation ?? "");

        if (operation === "list") {
            const memories = listMemories();
            if (memories.length === 0) return "No memories saved yet.";
            return memories
                .map((m) => `- [${m.source}] ${m.name} (${m.type}) - ${m.description}`)
                .join("\n");
        }

        if (operation === "save") {
            const name = String(input.name ?? "").trim();
            const description = String(input.description ?? "").trim();
            const type = String(input.type ?? "") as MemoryType;
            const content = String(input.content ?? "").trim();
            if (!name) return "Error: 'name' is required for save.";
            if (!MEMORY_TYPES.includes(type)) {
                return `Error: 'type' must be one of: ${MEMORY_TYPES.join(", ")}.`;
            }
            const path = saveMemory({
                name,
                description: description || name,
                type,
                content: content || description || name,
            });
            return `Memory saved: ${path}`;
        }

        return `Error: unknown operation "${operation}". Use "save" or "list".`;
    },

    prompt: () =>
        "Use the memory tool to persist facts that cannot be derived from the project state: "
        + "the user's preferences and corrections (feedback), their role and background (user), "
        + "project decisions and deadlines (project), pointers to external systems (reference). "
        + "Save when the user states a preference, corrects your behavior, or shares context a future session needs. "
        + "One fact per save. Feedback bodies must include Why: and How to apply: lines. "
        + "Do not save code details, git history, or anything already written in CLAUDE.md.",
});

// ─── tool_search ─────────────────────────────────────────────

const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
    activatedTools.clear();
}

// What the system prompt advertises: names are cheap, schemas are not.
export function getDeferredToolNames(): string[] {
    return [...toolRegistry.values()]
        .filter((t) => t.deferred && !activatedTools.has(t.name))
        .map((t) => t.name);
}

// The array that actually goes to the API: un-activated deferred tools dropped,
// internal fields stripped.
export function getActiveToolDefinitions(): Anthropic.Tool[] {
    const all = [...toolRegistry.values()];
    const anyDeferred = all.some((t) => t.deferred);

    return all
        .filter((t) => t.name !== "tool_search" || anyDeferred)
        .filter((t) => !t.deferred || activatedTools.has(t.name))
        .map((t): Anthropic.Tool => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
        }));
}

function toolSearchImpl(query: string): string {
    const needle = (query ?? "").trim().toLowerCase();
    if (needle === "") return "Error: query must not be empty. Pass a tool name or keywords.";

    const all = [...toolRegistry.values()];
    const matches = all.filter((t) => t.deferred && (
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle)
    ));

    if (matches.length === 0) {
        return `No deferred tools match "${query}". ${getDeferredToolNames().length} deferred tool(s) available — try a name or keyword.`;
    }

    for (const m of matches) activatedTools.add(m.name);

    return JSON.stringify(
        matches.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        null, 2,
    );
}

const toolSearchTool = register({
    name: "tool_search",
    description: "Search for available tools by name or keyword. Returns full schema definitions for matching deferred tools so you can use them. Tools already in your tool list are never deferred and do not need searching.",
    inputSchema: {
        type: "object",
        properties: {
            query: { type: "string", description: "Tool name or search keywords" }
        },
        required: ["query"]
    },
    // Never deferred — it is the door the others are behind.
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isDestructive: () => false,
    maxResultSizeChars: 5_000,

    async call(input) {
        return toolSearchImpl(input.query as string);
    },

    prompt: () => "",
});

// ═══════════════════════════════════════════════════════════════
// System prompt assembly
// ═══════════════════════════════════════════════════════════════

// Collect prompt() from all active tools and join into a single block.
export function buildToolPromptBlock(): string {
    const all = [...toolRegistry.values()];
    const anyDeferred = all.some((t) => t.deferred);

    const fragments = all
        .filter((t) => t.name !== "tool_search" || anyDeferred)
        .filter((t) => !t.deferred || activatedTools.has(t.name))
        .map((t) => t.prompt())
        .filter((p) => p.length > 0);

    return fragments.join("\n");
}
