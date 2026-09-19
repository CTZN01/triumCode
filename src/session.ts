import {
    readFileSync, writeFileSync, existsSync, readdirSync,
    unlinkSync, mkdirSync, statSync, renameSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { migrateDir } from "./migrate.js";

// ═══════════════════════════════════════════════════════════════
// Session persistence — one JSON file per conversation
// ═══════════════════════════════════════════════════════════════
//
// Storage layout:
//   .triumcode/sessions/<8-char-hex>.json  — full session data
//   .triumcode/session-latest              — plain-text pointer to last active ID
//
// Atomically written via temp + rename so a crash mid-write never
// corrupts the session file.

const TRIUMCODE_DIR = resolve(".triumcode");
const SESSIONS_DIR = join(TRIUMCODE_DIR, "sessions");
const LATEST_FILE = join(TRIUMCODE_DIR, "session-latest");

// Sessions saved before the rename live in .triumph/.  Adopt them here, at
// import time: once ensureSessionDir() has created the current directory the
// two are indistinguishable and the history is stranded.
migrateDir(resolve(".triumph"), TRIUMCODE_DIR);
const MAX_SESSIONS = 50;

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
    mkdirSync(SESSIONS_DIR, { recursive: true });
}

function randomId(): string {
    // 8 hex chars = 4 bytes, collision-free well past MAX_SESSIONS.
    return Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
    ).join("");
}

function sessionPath(id: string): string {
    return join(SESSIONS_DIR, `${id}.json`);
}

/** Read the latest-pointer. Returns null if missing or dangling. */
function readLatest(): string | null {
    if (!existsSync(LATEST_FILE)) return null;
    try {
        const id = readFileSync(LATEST_FILE, "utf-8").trim();
        if (id && existsSync(sessionPath(id))) return id;
    } catch { /* ignore */ }
    return null;
}

function writeLatest(id: string): void {
    try { writeFileSync(LATEST_FILE, id, "utf-8"); } catch { /* best effort */ }
}

/** Extract a human-readable title from the first user message. */
function extractTitle(messages: unknown[]): string {
    for (const msg of messages) {
        if (msg && typeof msg === "object" && (msg as any).role === "user") {
            const content = (msg as any).content;
            if (typeof content === "string") {
                return content.length <= 80 ? content : content.slice(0, 77) + "…";
            }
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
                        const text = block.text.replace(/\n/g, " ").trim();
                        return text.length <= 80 ? text : text.slice(0, 77) + "…";
                    }
                }
            }
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
        const entries = readdirSync(SESSIONS_DIR)
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    const stat = statSync(join(SESSIONS_DIR, f));
                    return { file: f, mtime: stat.mtimeMs };
                } catch {
                    return { file: f, mtime: 0 };
                }
            })
            .sort((a, b) => a.mtime - b.mtime);

        while (entries.length >= MAX_SESSIONS) {
            const old = entries.shift()!;
            try { unlinkSync(join(SESSIONS_DIR, old.file)); } catch { /* best effort */ }
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
            const matches = readdirSync(SESSIONS_DIR)
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
        files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }

    const sessions: SessionIndex[] = [];
    for (const file of files) {
        try {
            const raw = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf-8"));
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
    const p = sessionPath(id);
    if (!existsSync(p)) return false;
    try {
        unlinkSync(p);
        if (readLatest() === id) {
            try { unlinkSync(LATEST_FILE); } catch { /* ignore */ }
        }
        return true;
    } catch {
        return false;
    }
}

/** ID of the session that would resume next (for display). */
export function latestSessionId(): string | null {
    return readLatest();
}