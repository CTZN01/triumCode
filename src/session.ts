import {
    readFileSync, writeFileSync, existsSync, readdirSync,
    unlinkSync, mkdirSync, statSync, renameSync, copyFileSync, openSync, closeSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import type { PermissionAction, PermissionOutcome, PermissionSource, SessionPermissionGrant } from "./permissions.js";

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
const SESSION_LOCK_WAIT_MS = 1_000;
const SESSION_LOCK_STALE_MS = 5_000;

// ── Project-scoped storage ───────────────────────────────────

/**
 * Nearest ancestor holding a project marker, or the cwd when there is none.
 * The home directory is never accepted as a root: a stray ~/.git (a dotfiles
 * repo) would otherwise fold every project on the machine into one store.
 *
 * Home is tested *before* the markers, and that order is the whole point:
 * ~/.triumcode is the global config directory this CLI creates, so it is
 * itself a marker. Checking markers first made the home guard unreachable —
 * every directory under home with no project of its own resolved to home and
 * shared one session store.
 */
export function projectRoot(workspaceRoot?: string): string {
    const start = resolve(workspaceRoot ?? process.cwd());
    if (workspaceRoot) return start;
    const home = os.homedir();
    // homedir() comes from the environment and the cwd from the OS, so their
    // casing can differ on Windows.
    const isHome = (dir: string): boolean =>
        process.platform === "win32"
            ? dir.toLowerCase() === home.toLowerCase()
            : dir === home;
    let dir = start;
    while (true) {
        const parent = dirname(dir);
        if (isHome(dir) || parent === dir) return start;
        if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".triumcode"))) return dir;
        dir = parent;
    }
}

function projectHash(workspaceRoot?: string): string {
    return createHash("sha256")
        .update(projectRoot(workspaceRoot).toLowerCase())
        .digest("hex")
        .slice(0, 12);
}

function sessionsDir(workspaceRoot?: string): string {
    return join(SESSIONS_ROOT, projectHash(workspaceRoot));
}

function latestFile(workspaceRoot?: string): string {
    return join(sessionsDir(workspaceRoot), "session-latest");
}

function workspaceOperationFile(workspaceRoot?: string): string {
    return join(sessionsDir(workspaceRoot), ".workspace-operation.lock");
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

function migrateLegacySessions(workspaceRoot?: string): void {
    const legacyBase = join(projectRoot(workspaceRoot), ".triumcode");
    const legacyDir = join(legacyBase, "sessions");
    const legacyLatest = join(legacyBase, "session-latest");
    if (!existsSync(legacyDir) && !existsSync(legacyLatest)) return;

    const target = sessionsDir(workspaceRoot);
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

export type SessionActivityState = "running" | "complete" | "denied" | "failed" | "notice" | "interrupted";

export interface SessionActivity {
    id: string;
    runId?: string;
    messageIndex?: number;
    afterMessageIndex?: number;
    title: string;
    detail: string;
    state: SessionActivityState;
    output?: string;
    durationMs?: number;
    startedAt?: string;
    updatedAt?: string;
    permissionSource?: PermissionSource;
    permissionDecision?: PermissionAction;
    permissionOutcome?: PermissionOutcome;
    permissionGrantRevoked?: boolean;
    failureCategory?: "network" | "authentication" | "rate-limit" | "provider" | "internal";
    retryable?: boolean;
    safeToRetry?: boolean;
}

export interface DesktopUsageSnapshot {
    input: number;
    inputAvailable: boolean;
    output: number;
    outputAvailable: boolean;
    cacheRead: number;
    cacheReadAvailable: boolean;
    cacheWrite: number;
    cacheWriteAvailable: boolean;
    contextTokens?: number;
}

/** Non-secret desktop model settings pinned to a conversation when it is created. */
export interface DesktopSessionSettings {
    modelPreset: string | null;
    model: string;
    apiBase: string;
    protocol: "anthropic" | "openai-chat" | "openai-responses";
    auth: "api-key" | "bearer";
    thinking: boolean;
    effort: string;
    contextWindow: number;
    permissionMode?: "desktopDefault" | "desktopAcceptEdits" | "bypassPermissions";
}

export interface SessionData {
    version: 1;
    id: string;
    /** Monotonic write version; missing in legacy session files means revision 0. */
    revision?: number;
    created: string;          // ISO 8601
    updated: string;
    model: string;
    title: string;
    messages: unknown[];
    desktopActivities?: SessionActivity[];
    desktopUsage?: DesktopUsageSnapshot;
    desktopPermissionGrants?: SessionPermissionGrant[];
    desktopSettings?: DesktopSessionSettings;
    desktopWaitingFor?: "approval" | "user";
    status?: "idle" | "running" | "interrupted" | "cancelled" | "failed";
    titleSource?: "auto" | "user";
}

/** Lightweight metadata for listing — messages excluded for speed. */
export interface SessionIndex {
    id: string;
    created: string;
    updated: string;
    model: string;
    title: string;
    messageCount: number;
    status?: "idle" | "running" | "interrupted" | "cancelled" | "failed";
    desktopWaitingFor?: "approval" | "user";
    latestActivity?: Pick<SessionActivity, "id" | "title">;
}

interface CachedSessionIndex {
    mtimeNs: bigint;
    ctimeNs: bigint;
    size: bigint;
    index: SessionIndex;
}

const MAX_SESSION_INDEX_CACHE = 1_200;
const sessionIndexCache = new Map<string, CachedSessionIndex>();

// ── Helpers ────────────────────────────────────────────────────

function ensureSessionDir(workspaceRoot?: string): void {
    migrateLegacySessions(workspaceRoot);
    mkdirSync(sessionsDir(workspaceRoot), { recursive: true });
}

function randomId(): string {
    // 8 hex chars = 4 bytes, collision-free well past MAX_SESSIONS.
    return Array.from({ length: 4 }, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
    ).join("");
}

function sessionPath(id: string, workspaceRoot?: string): string {
    if (!/^[a-f0-9]{8}$/i.test(id)) throw new Error("Invalid session ID");
    return join(sessionsDir(workspaceRoot), `${id}.json`);
}

/** Read the latest-pointer. Returns null if missing or dangling. */
function readLatest(workspaceRoot?: string): string | null {
    if (!existsSync(latestFile(workspaceRoot))) return null;
    try {
        const id = readFileSync(latestFile(workspaceRoot), "utf-8").trim();
        if (id && existsSync(sessionPath(id, workspaceRoot))) return id;
    } catch { /* ignore */ }
    return null;
}

function writeLatest(id: string, workspaceRoot?: string): void {
    try { writeFileSync(latestFile(workspaceRoot), id, "utf-8"); } catch { /* best effort */ }
}

export class SessionConflictError extends Error {
    readonly code: "SESSION_CONFLICT" | "SESSION_LOCK_TIMEOUT";

    constructor(
        readonly sessionId: string,
        readonly expectedRevision: number,
        readonly actualRevision: number | null,
        code: "SESSION_CONFLICT" | "SESSION_LOCK_TIMEOUT" = "SESSION_CONFLICT",
    ) {
        const detail = code === "SESSION_LOCK_TIMEOUT"
            ? "another process is still writing it"
            : actualRevision === null
                ? "it was deleted by another process"
                : `it advanced from revision ${expectedRevision} to ${actualRevision}`;
        super(`Session ${sessionId} changed while this process was using it: ${detail}. Reload the session before continuing.`);
        this.name = "SessionConflictError";
        this.code = code;
    }
}

export class SessionBusyError extends Error {
    readonly code = "SESSION_BUSY";

    constructor(readonly sessionId: string, readonly scope: "session" | "workspace" = "session") {
        super(scope === "workspace"
            ? "Another task or Git operation is already using this workspace."
            : `Session ${sessionId} already has a task running in another process.`);
        this.name = "SessionBusyError";
    }
}

function sessionRevision(data: SessionData): number {
    return data.revision ?? 0;
}

function readSessionFile(filePath: string): SessionData | null {
    try {
        const raw = JSON.parse(readFileSync(filePath, "utf-8")) as SessionData;
        if (!raw || !Array.isArray(raw.messages)) return null;
        if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || raw.revision < 0)) return null;
        return {
            ...raw,
            revision: raw.revision ?? 0,
            ...(raw.desktopWaitingFor === "approval" || raw.desktopWaitingFor === "user"
                ? { desktopWaitingFor: raw.desktopWaitingFor } : { desktopWaitingFor: undefined }),
        };
    } catch {
        return null;
    }
}

interface LockOwner {
    pid: number;
    token: string;
}

function lockOwner(lockPath: string): LockOwner | null {
    try {
        const value = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockOwner>;
        return Number.isSafeInteger(value.pid) && typeof value.token === "string"
            ? { pid: value.pid!, token: value.token }
            : null;
    } catch {
        return null;
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/** Serialize stale-lock cleanup so a waiter cannot remove a newly acquired lock. */
function releaseStaleLock(lockPath: string): void {
    let observed: LockOwner | null = null;
    let observedMtime = 0;
    try {
        observed = lockOwner(lockPath);
        const stat = statSync(lockPath);
        observedMtime = stat.mtimeMs;
        if (observed ? processIsAlive(observed.pid) : Date.now() - stat.mtimeMs < SESSION_LOCK_STALE_MS) return;
    } catch {
        return;
    }

    const recoveryPath = `${lockPath}.recovery`;
    const recoveryToken = randomUUID();
    const openRecovery = (): number => {
        const fd = openSync(recoveryPath, "wx");
        try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, token: recoveryToken }), "utf-8");
            return fd;
        } catch (error) {
            closeSync(fd);
            try { unlinkSync(recoveryPath); } catch { /* best effort */ }
            throw error;
        }
    };
    let recoveryFd: number;
    try {
        recoveryFd = openRecovery();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
        releaseStaleLock(recoveryPath);
        try { recoveryFd = openRecovery(); } catch { return; }
    }

    try {
        const current = lockOwner(lockPath);
        if (observed && current?.token === observed.token && !processIsAlive(current.pid)) {
            unlinkSync(lockPath);
        } else if (!observed && !current) {
            try {
                if (Date.now() - Math.max(observedMtime, statSync(lockPath).mtimeMs) >= SESSION_LOCK_STALE_MS) unlinkSync(lockPath);
            } catch { /* another waiter removed it */ }
        }
    } finally {
        closeSync(recoveryFd);
        if (lockOwner(recoveryPath)?.token === recoveryToken) {
            try { unlinkSync(recoveryPath); } catch { /* best effort */ }
        }
    }
}

function acquireLockFile(
    sessionId: string,
    lockPath: string,
    waitMs: number,
    rejectBusy: boolean,
    scope: "session" | "workspace" = "session",
): () => void {
    mkdirSync(dirname(lockPath), { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    let fd: number | null = null;
    while (fd === null) {
        try {
            fd = openSync(lockPath, "wx");
            writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), "utf-8");
            closeSync(fd);
            fd = null;
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                if (fd !== null) {
                    closeSync(fd);
                    if (lockOwner(lockPath)?.token === token) {
                        try { unlinkSync(lockPath); } catch { /* best effort */ }
                    }
                }
                throw error;
            }
            releaseStaleLock(lockPath);
            if (!existsSync(lockPath)) continue;
            if (rejectBusy) throw new SessionBusyError(sessionId, scope);
            if (Date.now() >= deadline) {
                throw new SessionConflictError(sessionId, 0, null, "SESSION_LOCK_TIMEOUT");
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }

    return () => {
        if (lockOwner(lockPath)?.token === token) {
            try { unlinkSync(lockPath); } catch { /* best effort */ }
        }
    };
}

function withSessionLock<T>(sessionId: string, filePath: string, action: () => T): T {
    const release = acquireLockFile(sessionId, `${filePath}.lock`, SESSION_LOCK_WAIT_MS, false);
    try {
        return action();
    } finally {
        release();
    }
}

function withSessionRunLock<T>(sessionId: string, filePath: string, action: () => T): T {
    const release = acquireLockFile(sessionId, `${filePath}.run.lock`, 0, true);
    try {
        return action();
    } finally {
        release();
    }
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
    const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    try {
        writeFileSync(tmp, data, "utf-8");
        // Rename replaces the destination on supported desktop filesystems;
        // never unlink first because a crash would leave the session missing.
        renameSync(tmp, filePath);
    } catch {
        try { unlinkSync(tmp); } catch { /* cleanup */ }
        throw new Error(`Failed to write ${filePath}`);
    }
}

// ── Enforce MAX_SESSIONS ───────────────────────────────────────

function pruneOldest(workspaceRoot?: string): void {
    try {
        const entries = readdirSync(sessionsDir(workspaceRoot))
            .filter((f) => f.endsWith(".json"))
            .map((f) => {
                try {
                    const stat = statSync(join(sessionsDir(workspaceRoot), f));
                    return { file: f, mtime: stat.mtimeMs };
                } catch {
                    return { file: f, mtime: 0 };
                }
            })
            .sort((a, b) => a.mtime - b.mtime);

        while (entries.length >= MAX_SESSIONS) {
            const old = entries.shift()!;
            const id = old.file.slice(0, -".json".length);
            const path = join(sessionsDir(workspaceRoot), old.file);
            try {
                withSessionRunLock(id, path, () => withSessionLock(id, path, () => {
                    if (readLatest(workspaceRoot) !== id && existsSync(path)) unlinkSync(path);
                }));
            } catch { /* a busy or damaged old session is kept */ }
        }
    } catch { /* listing failed — non-fatal */ }
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Load a session by ID, ID prefix, or "latest".
 * @param identifier  undefined/"latest" → latest pointer
 *                     string → exact match or unambiguous prefix
 */
export function loadSession(identifier?: string, workspaceRoot?: string): SessionData | null {
    ensureSessionDir(workspaceRoot);

    let id: string | null = null;

    if (!identifier || identifier === "latest") {
        id = readLatest(workspaceRoot);
    } else {
        // Exact match first.
        if (!/^[a-f0-9]{1,8}$/i.test(identifier)) return null;
        if (identifier.length === 8 && existsSync(sessionPath(identifier, workspaceRoot))) {
            id = identifier;
        } else {
            // Prefix match: must be unambiguous.
            const matches = readdirSync(sessionsDir(workspaceRoot))
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
    return readSessionFile(sessionPath(id, workspaceRoot));
}

/** List all sessions, sorted by most recently updated first. */
export function listSessions(workspaceRoot?: string): SessionIndex[] {
    ensureSessionDir(workspaceRoot);
    const directory = sessionsDir(workspaceRoot);

    let files: string[];
    try {
        files = readdirSync(directory).filter((f) => f.endsWith(".json"));
    } catch {
        return [];
    }

    const sessions: SessionIndex[] = [];
    for (const file of files) {
        const path = join(directory, file);
        try {
            const stat = statSync(path, { bigint: true });
            const cached = sessionIndexCache.get(path);
            if (cached && cached.mtimeNs === stat.mtimeNs && cached.ctimeNs === stat.ctimeNs && cached.size === stat.size) {
                sessionIndexCache.delete(path);
                sessionIndexCache.set(path, cached);
                sessions.push(cached.index);
                continue;
            }

            const raw = JSON.parse(readFileSync(path, "utf-8"));
            if (raw && Array.isArray(raw.messages)) {
                const latestActivity = Array.isArray(raw.desktopActivities) ? raw.desktopActivities.at(-1) : undefined;
                const index: SessionIndex = {
                    id: raw.id ?? file.replace(".json", ""),
                    created: raw.created ?? "",
                    updated: raw.updated ?? "",
                    model: raw.model ?? "",
                    title: raw.title ?? "untitled",
                    messageCount: raw.messages.length,
                    status: raw.status,
                    ...(raw.desktopWaitingFor === "approval" || raw.desktopWaitingFor === "user"
                        ? { desktopWaitingFor: raw.desktopWaitingFor } : {}),
                    ...(latestActivity && typeof latestActivity.id === "string" && typeof latestActivity.title === "string"
                        ? { latestActivity: { id: latestActivity.id, title: latestActivity.title } }
                        : {}),
                };
                sessions.push(index);
                sessionIndexCache.delete(path);
                sessionIndexCache.set(path, {
                    mtimeNs: stat.mtimeNs,
                    ctimeNs: stat.ctimeNs,
                    size: stat.size,
                    index,
                });
                while (sessionIndexCache.size > MAX_SESSION_INDEX_CACHE) {
                    const oldest = sessionIndexCache.keys().next().value;
                    if (oldest === undefined) break;
                    sessionIndexCache.delete(oldest);
                }
            }
        } catch {
            sessionIndexCache.delete(path);
            /* skip unreadable or corrupted sessions */
        }
    }

    const present = new Set(files.map((file) => join(directory, file)));
    for (const cachedPath of sessionIndexCache.keys()) {
        if (dirname(cachedPath) === directory && !present.has(cachedPath)) sessionIndexCache.delete(cachedPath);
    }

    return sessions.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Delete a session by ID. Returns true if something was removed. */
export function deleteSession(id: string, workspaceRoot?: string): boolean {
    ensureSessionDir(workspaceRoot);
    let p: string;
    try { p = sessionPath(id, workspaceRoot); } catch { return false; }
    if (!existsSync(p)) return false;
    try {
        return withSessionRunLock(id, p, () => withSessionLock(id, p, () => {
            if (!existsSync(p)) return false;
            unlinkSync(p);
            // The pointer must not be left dangling, or the next save would target
            // a file that no longer exists and silently resurrect it.
            if (readLatest(workspaceRoot) === id) startNewSession(workspaceRoot);
            return true;
        }));
    } catch (error) {
        if (error instanceof SessionConflictError) throw error;
        return false;
    }
}

/** ID of the session that would resume next (for display). */
export function latestSessionId(workspaceRoot?: string): string | null {
    return readLatest(workspaceRoot);
}

/** Keep the legacy latest pointer aligned after an explicit resume. SessionWriter
 * separately holds the selected ID and revision for process-local saves.
 */
export function setActiveSession(id: string, workspaceRoot?: string): void {
    ensureSessionDir(workspaceRoot);
    if (!existsSync(sessionPath(id, workspaceRoot))) throw new Error("Session does not exist");
    writeLatest(id, workspaceRoot);
}

/**
 * Retire the latest pointer so a fresh CLI run does not select the prior session.
 * The file it named stays on disk, which separates /new from /clear.
 *
 * Initialize first so a pending legacy migration can run before the pointer is
 * retired. SessionWriter also resets its process-local target when /new is used.
 */
export function startNewSession(workspaceRoot?: string): void {
    ensureSessionDir(workspaceRoot);
    try {
        if (existsSync(latestFile(workspaceRoot))) unlinkSync(latestFile(workspaceRoot));
    } catch { /* best effort */ }
}

/**
 * Empty the active session in place, keeping its ID and creation time, so the
 * wipe survives a restart. Returns false when nothing is active yet.
 */
export function clearActiveSession(workspaceRoot?: string): boolean {
    const id = readLatest(workspaceRoot);
    if (!id) return false;
    const existing = readSessionFile(sessionPath(id, workspaceRoot));
    if (!existing) return false;
    return Boolean(new SessionStore(projectRoot(workspaceRoot)).clear(id, sessionRevision(existing)));
}

/** Explicit, workspace-bound session access for desktop hosts and future clients. */
export class SessionStore {
    readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = resolve(workspaceRoot);
    }

    create(model = "", desktopSettings?: DesktopSessionSettings): SessionData {
        ensureSessionDir(this.workspaceRoot);
        pruneOldest(this.workspaceRoot);
        while (true) {
            const id = randomId();
            const path = sessionPath(id, this.workspaceRoot);
            const created = withSessionLock(id, path, () => {
                if (existsSync(path)) return null;
                const now = new Date().toISOString();
                const data: SessionData = {
                    version: 1,
                    id,
                    revision: 0,
                    created: now,
                    updated: now,
                    model,
                    title: "untitled",
                    titleSource: "auto",
                    status: "idle",
                    messages: [],
                    ...(desktopSettings === undefined ? {} : { desktopSettings }),
                };
                atomicWrite(path, JSON.stringify(data, null, 2));
                return data;
            });
            if (created) return created;
        }
    }

    load(id: string): SessionData | null {
        return loadSession(id, this.workspaceRoot);
    }

    list(): SessionIndex[] {
        return listSessions(this.workspaceRoot);
    }

    save(
        id: string,
        messages: unknown[],
        model: string,
        expectedRevision: number,
        status: SessionData["status"] = "idle",
        desktopActivities?: SessionActivity[],
        desktopUsage?: DesktopUsageSnapshot,
        desktopPermissionGrants?: SessionPermissionGrant[],
        desktopSettings?: DesktopSessionSettings,
        desktopWaitingFor?: SessionData["desktopWaitingFor"],
    ): SessionData | null {
        const path = sessionPath(id, this.workspaceRoot);
        return withSessionLock(id, path, () => {
            const existing = readSessionFile(path);
            const actualRevision = existing ? sessionRevision(existing) : null;
            if (actualRevision !== expectedRevision) {
                throw new SessionConflictError(id, expectedRevision, actualRevision);
            }
            const now = new Date().toISOString();
            const automaticTitle = extractTitle(messages);
            const data: SessionData = {
                ...existing!,
                revision: actualRevision + 1,
                updated: now,
                model,
                title: existing!.titleSource === "user" ? existing!.title : automaticTitle,
                titleSource: existing!.titleSource ?? "auto",
                status,
                messages,
                ...(desktopActivities === undefined ? {} : { desktopActivities }),
                ...(desktopUsage === undefined ? {} : { desktopUsage }),
                ...(desktopPermissionGrants === undefined ? {} : { desktopPermissionGrants }),
                ...(desktopSettings === undefined ? {} : { desktopSettings }),
                desktopWaitingFor,
            };
            atomicWrite(path, JSON.stringify(data, null, 2));
            return data;
        });
    }

    updateDesktopSettings(id: string, expectedRevision: number, settings: DesktopSessionSettings): SessionData | null {
        const path = sessionPath(id, this.workspaceRoot);
        return withSessionRunLock(id, path, () => withSessionLock(id, path, () => {
            const existing = readSessionFile(path);
            if (!existing) return null;
            const actualRevision = sessionRevision(existing);
            if (actualRevision !== expectedRevision) {
                throw new SessionConflictError(id, expectedRevision, actualRevision);
            }
            const data: SessionData = {
                ...existing,
                revision: actualRevision + 1,
                updated: new Date().toISOString(),
                model: settings.model,
                desktopSettings: settings,
            };
            atomicWrite(path, JSON.stringify(data, null, 2));
            return data;
        }));
    }

    rename(id: string, title: string): SessionData | null {
        const cleaned = title.trim();
        if (!cleaned) return null;
        const path = sessionPath(id, this.workspaceRoot);
        return withSessionRunLock(id, path, () => withSessionLock(id, path, () => {
            const existing = readSessionFile(path);
            if (!existing) return null;
            const data: SessionData = {
                ...existing,
                revision: sessionRevision(existing) + 1,
                title: cleaned.slice(0, 120),
                titleSource: "user",
                updated: new Date().toISOString(),
            };
            atomicWrite(path, JSON.stringify(data, null, 2));
            return data;
        }));
    }

    clear(id: string, expectedRevision: number): SessionData | null {
        const path = sessionPath(id, this.workspaceRoot);
        return withSessionRunLock(id, path, () => withSessionLock(id, path, () => {
            const existing = readSessionFile(path);
            const actualRevision = existing ? sessionRevision(existing) : null;
            if (actualRevision !== expectedRevision) {
                throw new SessionConflictError(id, expectedRevision, actualRevision);
            }
            const data: SessionData = {
                ...existing!,
                revision: actualRevision + 1,
                updated: new Date().toISOString(),
                title: "untitled",
                titleSource: "auto",
                messages: [],
                desktopUsage: undefined,
                desktopPermissionGrants: undefined,
                ...(existing!.desktopActivities ? { desktopActivities: [] } : {}),
            };
            atomicWrite(path, JSON.stringify(data, null, 2));
            return data;
        }));
    }

    acquireRun(id: string, expectedRevision?: number): () => void {
        const path = sessionPath(id, this.workspaceRoot);
        const releaseWorkspace = acquireLockFile("workspace", workspaceOperationFile(this.workspaceRoot), 0, true, "workspace");
        let releaseSession: (() => void) | null = null;
        try {
            releaseSession = acquireLockFile(id, `${path}.run.lock`, 0, true);
            const latest = readSessionFile(path);
            const actualRevision = latest ? sessionRevision(latest) : null;
            if (actualRevision === null || (expectedRevision !== undefined && actualRevision !== expectedRevision)) {
                throw new SessionConflictError(id, expectedRevision ?? 0, actualRevision);
            }
        } catch (error) {
            releaseSession?.();
            releaseWorkspace();
            throw error;
        }
        return () => {
            releaseSession?.();
            releaseWorkspace();
        };
    }

    acquireWorkspaceGitMutation(): () => void {
        return acquireLockFile("workspace", workspaceOperationFile(this.workspaceRoot), 0, true, "workspace");
    }

    isRunActive(id: string): boolean {
        const path = sessionPath(id, this.workspaceRoot);
        const lockPath = `${path}.run.lock`;
        if (!existsSync(lockPath)) return false;
        const owner = lockOwner(lockPath);
        if (owner && processIsAlive(owner.pid)) return true;
        releaseStaleLock(lockPath);
        const recoveredOwner = lockOwner(lockPath);
        return Boolean(recoveredOwner && processIsAlive(recoveredOwner.pid));
    }

    delete(id: string): boolean {
        return deleteSession(id, this.workspaceRoot);
    }

    /** Mark runs left active by a prior application process as interrupted. */
    recoverInterrupted(): number {
        let recovered = 0;
        for (const session of this.list()) {
            const path = sessionPath(session.id, this.workspaceRoot);
            const hadRunMarker = existsSync(`${path}.run.lock`);
            if (session.status !== "running" && !hadRunMarker) continue;
            try {
                const changed = withSessionRunLock(session.id, path, () => withSessionLock(session.id, path, () => {
                    const loaded = readSessionFile(path);
                    if (!loaded || (loaded.status !== "running" && !hadRunMarker)) return false;
                    const now = new Date().toISOString();
                    const desktopActivities = loaded.desktopActivities?.map((activity) => activity.state === "running"
                        ? { ...activity, state: "interrupted" as const, updatedAt: now }
                        : activity);
                    const data: SessionData = {
                        ...loaded,
                        revision: sessionRevision(loaded) + 1,
                        status: "interrupted",
                        desktopWaitingFor: undefined,
                        updated: now,
                        ...(desktopActivities ? { desktopActivities } : {}),
                    };
                    atomicWrite(path, JSON.stringify(data, null, 2));
                    return true;
                }));
                if (changed) recovered++;
            } catch (error) {
                if (!(error instanceof SessionBusyError)) throw error;
            }
        }
        return recovered;
    }
}

/** Process-local CLI session target; it never follows another process's latest pointer after selection. */
export class SessionWriter {
    readonly store: SessionStore;
    private current: SessionData | null = null;

    constructor(workspaceRoot?: string) {
        this.store = new SessionStore(projectRoot(workspaceRoot));
    }

    activeId(): string | null {
        return this.current?.id ?? null;
    }

    resume(identifier?: string): SessionData | null {
        const loaded = loadSession(identifier, this.store.workspaceRoot);
        if (!loaded) return null;
        this.current = loaded;
        writeLatest(loaded.id, this.store.workspaceRoot);
        return loaded;
    }

    startNew(): void {
        this.current = null;
        startNewSession(this.store.workspaceRoot);
    }

    save(messages: unknown[], model = ""): SessionData | null {
        if (messages.length === 0) return null;
        const current = this.current ?? this.store.create(model);
        const saved = this.store.save(
            current.id,
            messages,
            model,
            sessionRevision(current),
            "idle",
            current.desktopActivities,
        );
        if (!saved) throw new SessionConflictError(current.id, sessionRevision(current), null);
        this.current = saved;
        writeLatest(saved.id, this.store.workspaceRoot);
        return saved;
    }

    clear(): boolean {
        if (!this.current) return false;
        const cleared = this.store.clear(this.current.id, sessionRevision(this.current));
        if (!cleared) throw new SessionConflictError(this.current.id, sessionRevision(this.current), null);
        this.current = cleared;
        writeLatest(cleared.id, this.store.workspaceRoot);
        return true;
    }

    delete(id: string): boolean {
        const deleted = this.store.delete(id);
        if (deleted && this.current?.id === id) this.current = null;
        return deleted;
    }

    acquireRun(): (() => void) | null {
        return this.current ? this.store.acquireRun(this.current.id, sessionRevision(this.current)) : null;
    }
}
