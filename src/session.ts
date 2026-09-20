import {
    readFileSync, writeFileSync, existsSync, readdirSync,
    unlinkSync, mkdirSync, statSync, renameSync, copyFileSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import * as os from "node:os";

// ═══════════════════════════════════════════════════════════════
// Session persistence — one JSON file per conversation
// ═══════════════════════════════════════════════════════════════
//
// Storage layout (global, one directory per project — as Claude Code does):
//   ~/.triumcode/sessions/<project-hash>/<8-char-hex>.json  — session data
//   ~/.triumcode/sessions/<project-hash>/session-latest     — active-session pointer
//
// Keying on the project root rather than the cwd keeps one project's
// conversations together no matter which subdirectory the CLI is started
// from; a per-cwd store would scatter them across every directory entered.
//
// Atomically written via temp + rename so a crash mid-write never
// corrupts the session file.

const SESSIONS_ROOT = join(os.homedir(), ".triumcode", "sessions");
const MAX_SESSIONS = 50;

// ── Project-scoped storage ───────────────────────────────────

/**
 * Nearest ancestor holding a project marker, or the cwd when there is none.
 * The home directory is never accepted as a root: a stray ~/.git (a dotfiles
 * repo) would otherwise fold every project on the machine into one store.
 */
export function projectRoot(): string {
    const start = resolve(process.cwd());
    let dir = start;
    while (true) {
        if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".triumcode"))) return dir;
        const parent = dirname(dir);
        if (parent === dir || dir === os.homedir()) return start;
        dir = parent;
    }
}

function projectHash(): string {
    return createHash("sha256")
        .update(projectRoot().toLowerCase())
        .digest("hex")
        .slice(0, 12);
}

function sessionsDir(): string {
    return join(SESSIONS_ROOT, projectHash());
}

function latestFile(): string {
    return join(sessionsDir(), "session-latest");
}

/**
 * Pull a project's pre-global sessions into the global store, once.
 *
 * Copies rather than renames: the project and the home directory are often on
 * different volumes (the norm on Windows), where rename fails outright. A
 * marker in the target records that the move happened, so a session the user
 * later deletes is not resurrected from the legacy copy on the next startup.
 */
const MIGRATION_MARKER = ".migrated-from-local";

function migrateLegacySessions(): void {
    const legacyBase = join(projectRoot(), ".triumcode");
    const legacyDir = join(legacyBase, "sessions");
    const legacyLatest = join(legacyBase, "session-latest");
    if (!existsSync(legacyDir) && !existsSync(legacyLatest)) return;

    const target = sessionsDir();
    if (existsSync(join(target, MIGRATION_MARKER))) return;

    try {
        mkdirSync(target, { recursive: true });
        const files = existsSync(legacyDir)
            ? readdirSync(legacyDir).filter((f) => f.endsWith(".json"))
            : [];
        for (const file of files) {
            const dest = join(target, file);
            if (!existsSync(dest)) copyFileSync(join(legacyDir, file), dest);
        }
        const latestDest = latestFile();
        if (existsSync(legacyLatest) && !existsSync(latestDest)) {
            copyFileSync(legacyLatest, latestDest);
        }
        writeFileSync(join(target, MIGRATION_MARKER), new Date().toISOString(), "utf-8");
    } catch { /* migration is best-effort */ }
}

// ── Types ──────────────────────────────────────────────────────

export interface SessionData {
    version: 1;
    id: string;
    created: string;          // ISO 8601
    updated: string;
    model: string;
    title: string;
    messages: unknown[];
}

/** Lightweight metadata for listing — messages excluded for speed. */
export interface SessionIndex {
    id: string;
    created: string;
    updated: string;
    model: string;
    title: string;
    messageCount: number;
}

// ── Helpers ────────────────────────────────────────────────────

function ensureSessionDir(): void {
    migrateLegacySessions();
    mkdirSync(sessionsDir(), { recursive: true });
}

function randomId(): string {
    // 8 hex chars = 4 bytes, collision-free well past MAX_SESSIONS.
    return Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
    ).join("");
}

function sessionPath(id: string): string {
    return join(sessionsDir(), `${id}.json`);
}

/** Read the latest-pointer. Returns null if missing or dangling. */
function readLatest(): string | null {
    if (!existsSync(latestFile())) return null;
    try {
        const id = readFileSync(latestFile(), "utf-8").trim();
        if (id && existsSync(sessionPath(id))) return id;
    } catch { /* ignore */ }
    return null;
}

function writeLatest(id: string): void {
    try { writeFileSync(latestFile(), id, "utf-8"); } catch { /* best effort */ }
}

// The per-turn reminder is prepended to the user's text as a <system-reminder>
// block (see prompt.ts). It is machine context, not what the user asked, so it
// must not become the session title.
const REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function titleText(text: string): string {
    return text.replace(REMINDER_BLOCK, " ").replace(/\s+/g, " ").trim();
}

/** Extract a human-readable title from the first real user message. */
function extractTitle(messages: unknown[]): string {
    for (const msg of messages) {
        if (!msg || typeof msg !== "object" || (msg as any).role !== "user") continue;
        const content = (msg as any).content;
        const texts = typeof content === "string"
            ? [content]
            : Array.isArray(content)
                ? content
                    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
                    .map((b: any) => b.text as string)
                : [];
        for (const text of texts) {
            const cleaned = titleText(text);
            if (cleaned) return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 77) + "…";
        }
    }
    return "untitled";
}

/** Atomic write: land bytes in a temp file, then rename. */
function atomicWrite(filePath: string, data: string): void {
    const dir = dirname(filePath);
    const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        writeFileSync(tmp, data, "utf-8");
        // On Windows, renameSync fails if target exists. Remove first.
        try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
        renameSync(tmp, filePath);
    } catch {
        try { unlinkSync(tmp); } catch { /* cleanup */ }
        throw new Error(`Failed to write ${filePath}`);
    }
}

// ── Enforce MAX_SESSIONS ───────────────────────────────────────

function pruneOldest(): void {
    try {
        const entries = readdirSync(sessionsDir())
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    const stat = statSync(join(sessionsDir(), f));
                    return { file: f, mtime: stat.mtimeMs };
                } catch {
                    return { file: f, mtime: 0 };
                }
            })
            .sort((a, b) => a.mtime - b.mtime);

        while (entries.length >= MAX_SESSIONS) {
            const old = entries.shift()!;
            try { unlinkSync(join(sessionsDir(), old.file)); } catch { /* best effort */ }
        }
    } catch { /* listing failed — non-fatal */ }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Save the current conversation to disk.
 * - First call in a session creates a new file and sets the latest-pointer.
 * - Subsequent calls update the same file (resolves via latest-pointer).
 * - Atomic write prevents corruption on crash.
 */
export function saveSession(messages: unknown[], model = ""): void {
    if (messages.length === 0) return;
    ensureSessionDir();

    // Resolve existing session: reuse latest-pointer, or mint a new ID.
    let id = readLatest();
    const isUpdate = id !== null;
    if (!id) {
        id = randomId();
        pruneOldest();
    }

    const now = new Date().toISOString();
    const data: SessionData = {
        version: 1,
        id,
        created: isUpdate ? undefined! : now,  // will read from existing if updating
        updated: now,
        model,
        title: extractTitle(messages),
        messages,
    };

    // If updating, preserve the original created timestamp.
    if (isUpdate) {
        try {
            const existing = JSON.parse(readFileSync(sessionPath(id!), "utf-8")) as SessionData;
            data.created = existing.created;
        } catch {
            data.created = now;
        }
    }

    atomicWrite(sessionPath(id), JSON.stringify(data, null, 2));
    writeLatest(id);
}

/**
 * Load a session by ID, ID prefix, or "latest".
 * @param identifier  undefined/"latest" → latest pointer
 *                     string → exact match or unambiguous prefix
 */
export function loadSession(identifier?: string): SessionData | null {
    ensureSessionDir();

    let id: string | null = null;

    if (!identifier || identifier === "latest") {
        id = readLatest();
    } else {
        // Exact match first.
        if (existsSync(sessionPath(identifier))) {
            id = identifier;
        } else {
            // Prefix match: must be unambiguous.
            const matches = readdirSync(sessionsDir())
                .filter((f) => f.endsWith(".json") && f.startsWith(identifier));
            if (matches.length === 1) {
                id = matches[0].replace(".json", "");
            } else if (matches.length === 0) {
                return null;
            } else {
                // Ambiguous — return null, caller prints the matches.
                return null;
            }
        }
    }

    if (!id) return null;
    try {
        const raw = JSON.parse(readFileSync(sessionPath(id), "utf-8")) as SessionData;
        if (!raw || !Array.isArray(raw.messages)) return null;
        return raw;
    } catch {
        return null;
    }
}

/** List all sessions, sorted by most recently updated first. */
export function listSessions(): SessionIndex[] {
    ensureSessionDir();

    let files: string[];
    try {
        files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }

    const sessions: SessionIndex[] = [];
    for (const file of files) {
        try {
            const raw = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
            if (raw && Array.isArray(raw.messages)) {
                sessions.push({
                    id: raw.id ?? file.replace(".json", ""),
                    created: raw.created ?? "",
                    updated: raw.updated ?? "",
                    model: raw.model ?? "",
                    title: raw.title ?? "untitled",
                    messageCount: raw.messages.length,
                });
            }
        } catch { /* skip corrupted */ }
    }

    return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Delete a session by ID. Returns true if something was removed. */
export function deleteSession(id: string): boolean {
    ensureSessionDir();
    const p = sessionPath(id);
    if (!existsSync(p)) return false;
    try {
        unlinkSync(p);
        // The pointer must not be left dangling, or the next save would target
        // a file that no longer exists and silently resurrect it.
        if (readLatest() === id) startNewSession();
        return true;
    } catch {
        return false;
    }
}

/** ID of the session that would resume next (for display). */
export function latestSessionId(): string | null {
    return readLatest();
}

/**
 * Make `id` the session later saves append to. Called after an explicit
 * resume: without it, saveSession would keep writing to whichever session the
 * pointer already named, appending the resumed conversation to the wrong file.
 */
export function setActiveSession(id: string): void {
    ensureSessionDir();
    writeLatest(id);
}

/**
 * Retire the active pointer so the next save mints a new session. The file it
 * named stays on disk — this is what separates /new (keep the old conversation)
 * from /clear (empty it in place).
 *
 * The store is initialized first: a pending legacy migration copies the old
 * pointer in, and deleting it afterwards is exactly the point — otherwise the
 * very run that meant to start fresh would adopt the migrated session.
 */
export function startNewSession(): void {
    ensureSessionDir();
    try {
        if (existsSync(latestFile())) unlinkSync(latestFile());
    } catch { /* best effort */ }
}

/**
 * Empty the active session in place, keeping its ID and creation time, so the
 * wipe survives a restart. Returns false when nothing is active yet.
 */
export function clearActiveSession(): boolean {
    const id = readLatest();
    if (!id) return false;
    try {
        const existing = JSON.parse(readFileSync(sessionPath(id), "utf-8")) as SessionData;
        const data: SessionData = {
            ...existing,
            updated: new Date().toISOString(),
            title: "untitled",
            messages: [],
        };
        atomicWrite(sessionPath(id), JSON.stringify(data, null, 2));
        return true;
    } catch {
        return false;
    }
}