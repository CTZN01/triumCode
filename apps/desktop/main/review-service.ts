import { createFileEditDiff } from "../../../src/file-diff.js";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { safeStorage } from "electron";
import type {
    CodeReviewSnapshot,
    GitFileChange,
    GitSnapshot,
    ReviewFile,
    ReviewRestoreResult,
    SessionSummary,
} from "../shared/contracts.js";
import { readGitDiffFromHead, readGitSnapshot } from "./git-service.js";
import { removeSessionReviewFiles } from "./review-cleanup.js";
import { DesktopServiceError } from "./workspace-store.js";

const MAX_REVIEW_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_RUN_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_FILES = 1_000;
const RETAINED_RUNS_PER_WORKSPACE = 20;

interface StoredFileState {
    existed: boolean;
    base64: string | null;
    hash: string | null;
    mode?: number;
    reason?: string;
}

interface StoredReviewRun {
    workspaceId: string;
    sessionId: string;
    runId: string;
    startedAt: string;
    status: SessionSummary["status"];
    baselineGit: GitSnapshot;
    baselineFiles: Record<string, StoredFileState>;
    toolFiles: Record<string, StoredFileState>;
    coverage: "complete" | "partial";
    notices: string[];
    capturedBytes: number;
}

interface ReviewIndex {
    latestBySessionId: Record<string, string>;
    runs: Record<string, { sessionId: string; startedAt: string; status: SessionSummary["status"] }>;
}

interface EncryptedReviewRun {
    version: 1;
    encrypted: string;
}

interface ReadState extends StoredFileState {
    bytes?: Buffer;
}

function hashBytes(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, "utf8");
    try {
        renameSync(temporary, path);
    } catch {
        try {
            writeFileSync(path, content, "utf8");
        } finally {
            rmSync(temporary, { force: true });
        }
    }
}

function isMissing(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function safeRelativePath(workspaceRoot: string, filePath: string): string {
    const root = realpathSync.native(workspaceRoot);
    const absolute = resolve(root, filePath);
    const rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== absolute) {
        throw new DesktopServiceError("INVALID_REVIEW_PATH", "This file is outside the selected workspace.");
    }
    return rel;
}

function safeAbsolutePath(workspaceRoot: string, relativePath: string): string {
    const root = realpathSync.native(workspaceRoot);
    const absolute = resolve(root, relativePath);
    const rel = relative(root, absolute);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== absolute) {
        throw new DesktopServiceError("INVALID_REVIEW_PATH", "This file is outside the selected workspace.");
    }

    let parent = dirname(absolute);
    while (!existsSync(parent) && parent !== root) parent = dirname(parent);
    let realParent: string;
    try { realParent = realpathSync.native(parent); }
    catch { throw new DesktopServiceError("REVIEW_PATH_UNAVAILABLE", "The file's parent folder is unavailable."); }
    const parentRelative = relative(root, realParent);
    if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) {
        throw new DesktopServiceError("INVALID_REVIEW_PATH", "This file resolves outside the selected workspace.");
    }
    return absolute;
}

function readState(path: string): ReadState {
    let info;
    try { info = lstatSync(path); }
    catch (error) {
        if (isMissing(error)) return { existed: false, base64: null, hash: null };
        return { existed: false, base64: null, hash: null, reason: "无法读取文件状态。" };
    }
    if (info.isSymbolicLink()) return { existed: true, base64: null, hash: null, reason: "符号链接不会被快照或还原。" };
    if (!info.isFile()) return { existed: true, base64: null, hash: null, reason: "此路径不是普通文件。" };
    if (info.size > MAX_REVIEW_FILE_BYTES) {
        return { existed: true, base64: null, hash: null, mode: info.mode, reason: "文件超过 2 MiB 快照上限。" };
    }
    try {
        const bytes = readFileSync(path);
        return {
            existed: true,
            base64: bytes.toString("base64"),
            hash: hashBytes(bytes),
            mode: info.mode,
            bytes,
        };
    } catch {
        return { existed: true, base64: null, hash: null, mode: info.mode, reason: "无法读取文件内容。" };
    }
}

function toStored(state: ReadState): StoredFileState {
    return {
        existed: state.existed,
        base64: state.base64,
        hash: state.hash,
        ...(state.mode === undefined ? {} : { mode: state.mode }),
        ...(state.reason ? { reason: state.reason } : {}),
    };
}

function decode(state: StoredFileState): Buffer | null {
    if (state.base64 === null) return null;
    return Buffer.from(state.base64, "base64");
}

function textDiff(path: string, before: Buffer, after: Buffer): { diff: string; truncated: boolean; notice?: string } {
    let oldText: string;
    let newText: string;
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        oldText = decoder.decode(before);
        newText = decoder.decode(after);
    } catch {
        return { diff: "", truncated: false, notice: "二进制或非 UTF-8 文件；可查看变更状态，无法显示文本差异。" };
    }

    return createFileEditDiff(path, oldText, newText);
}

function statusMap(files: GitFileChange[]): Map<string, GitFileChange> {
    return new Map(files.map((file) => [file.path, file]));
}

function fileStatus(before: StoredFileState, current: ReadState): ReviewFile["status"] | null {
    if (!before.existed && current.existed) return "added";
    if (before.existed && !current.existed) return "deleted";
    if (before.reason || current.reason) return "modified";
    if (before.hash !== current.hash) return "modified";
    return null;
}

function restoreFile(root: string, path: string, before: StoredFileState, expectedCurrentHash: string | null): boolean {
    const absolute = safeAbsolutePath(root, path);
    if (before.reason || (before.existed && before.base64 === null)) {
        throw new DesktopServiceError("REVIEW_BASELINE_UNAVAILABLE", before.reason ?? "The run-start file snapshot is unavailable.");
    }
    const stillMatches = (): boolean => {
        const current = readState(absolute);
        return !current.reason && current.hash === expectedCurrentHash;
    };
    if (!stillMatches()) return false;

    if (!before.existed) {
        const current = readState(absolute);
        if (current.reason || current.hash !== expectedCurrentHash) return false;
        if (!current.existed) return true;
        const info = lstatSync(absolute);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new DesktopServiceError("REVIEW_FILE_CHANGED", "This path is no longer a regular file; it was left untouched.");
        }
        if (!stillMatches()) return false;
        unlinkSync(absolute);
        return true;
    }

    const bytes = decode(before);
    if (!bytes) throw new DesktopServiceError("REVIEW_BASELINE_UNAVAILABLE", "The run-start file snapshot is unavailable.");
    const temp = resolve(dirname(absolute), `.${basename(absolute)}.triumcode-${randomUUID()}.tmp`);
    mkdirSync(dirname(absolute), { recursive: true });
    try {
        // Directory creation may traverse an unexpected link; validate its parent chain again.
        safeAbsolutePath(root, path);
        writeFileSync(temp, bytes, { flag: "wx", mode: before.mode });
        // Preparing the replacement may take time; preserve edits made in the meantime.
        if (!stillMatches()) return false;
        try {
            renameSync(temp, absolute);
        } catch {
            throw new DesktopServiceError("REVIEW_RESTORE_FAILED", "The file could not be replaced atomically; it was left unchanged.");
        }
    } finally {
        rmSync(temp, { force: true });
    }
    return true;
}

export class ReviewService {
    private readonly root: string;

    constructor(userDataPath: string) {
        this.root = resolve(userDataPath, "reviews");
    }

    removeSession(workspaceId: string, sessionId: string): void {
        removeSessionReviewFiles(this.directory(workspaceId), sessionId);
    }

    recoverInterrupted(): void {
        let workspaces: string[];
        try { workspaces = readdirSync(this.root); }
        catch { return; }
        for (const workspaceId of workspaces) {
            if (!/^[a-f0-9]{20}$/i.test(workspaceId)) continue;
            try {
                const index = this.readIndex(workspaceId);
                for (const run of Object.values(index.runs)) {
                    if (run.status === "running") run.status = "interrupted";
                }
                atomicWrite(resolve(this.directory(workspaceId), "index.json"), JSON.stringify(index));
                this.prune(workspaceId);
            } catch { /* Review recovery must not prevent the desktop from opening. */ }
        }
    }

    async beginRun(workspaceId: string, sessionId: string, runId: string, workspaceRoot: string): Promise<void> {
        const baselineGit = await readGitSnapshot(workspaceRoot);
        const run: StoredReviewRun = {
            workspaceId,
            sessionId,
            runId,
            startedAt: new Date().toISOString(),
            status: "running",
            baselineGit,
            baselineFiles: Object.create(null) as Record<string, StoredFileState>,
            toolFiles: Object.create(null) as Record<string, StoredFileState>,
            coverage: baselineGit.error || baselineGit.filesTruncated ? "partial" : "complete",
            notices: [],
            capturedBytes: 0,
        };
        if (baselineGit.error) run.notices.push(`任务开始时无法完整读取 Git 状态：${baselineGit.error}`);
        if (baselineGit.filesTruncated) run.notices.push("任务开始时的 Git 文件列表超过上限，基线不完整。");
        if (!baselineGit.isGit && !baselineGit.error) {
            run.coverage = "partial";
            run.notices.push("此目录没有 Git；仅记录 Agent 文件工具的修改，命令直接写入的文件无法按任务归属。");
        } else if (baselineGit.isGit) {
            run.coverage = "partial";
            run.notices.push("Git 状态能标记任务前的既有改动和任务期间可见的差异；终端或外部编辑器在任务期间的改动无法与 Agent 来源完全区分。");
        }

        const paths = baselineGit.files.slice(0, MAX_REVIEW_FILES);
        if (baselineGit.files.length > paths.length) run.coverage = "partial";
        const root = realpathSync.native(workspaceRoot);
        for (const file of paths) {
            try {
                const absolute = safeAbsolutePath(root, file.path);
                const state = readState(absolute);
                const bytes = state.base64 ? Buffer.byteLength(state.base64, "utf8") : 0;
                if (run.capturedBytes + bytes > MAX_REVIEW_RUN_BYTES) {
                    run.baselineFiles[file.path] = {
                        existed: state.existed,
                        base64: null,
                        hash: state.hash,
                        reason: "此任务的本机快照空间已达上限。",
                    };
                    run.coverage = "partial";
                } else {
                    run.baselineFiles[file.path] = toStored(state);
                    run.capturedBytes += bytes;
                    if (state.reason) run.coverage = "partial";
                }
            } catch {
                run.baselineFiles[file.path] = { existed: false, base64: null, hash: null, reason: "无法快照此路径。" };
                run.coverage = "partial";
            }
        }
        if (run.coverage === "partial" && !run.notices.length) run.notices.push("部分文件未能创建可恢复快照；这些文件仍可查看当前 Git 差异。");

        this.writeRun(run);
        // Publish the new run only after its encrypted snapshot is written. If
        // encryption or disk I/O fails, keep the previous review available.
        this.updateLatest(workspaceId, sessionId, runId);
        this.prune(workspaceId);
    }

    async captureBeforeWrite(workspaceId: string, sessionId: string, runId: string, workspaceRoot: string, absolutePath: string): Promise<void> {
        const run = this.readRun(workspaceId, runId);
        if (!run || run.sessionId !== sessionId || run.status !== "running") return;
        const path = safeRelativePath(workspaceRoot, absolutePath);
        if (Object.hasOwn(run.toolFiles, path)) return;
        if (Object.hasOwn(run.baselineFiles, path)) {
            run.toolFiles[path] = run.baselineFiles[path];
            this.writeRun(run);
            return;
        }
        const state = toStored(readState(safeAbsolutePath(workspaceRoot, path)));
        const size = state.base64 ? Buffer.byteLength(state.base64, "utf8") : 0;
        if (run.capturedBytes + size > MAX_REVIEW_RUN_BYTES) {
            run.toolFiles[path] = {
                existed: state.existed,
                base64: null,
                hash: state.hash,
                reason: "此任务的本机快照空间已达上限。",
            };
            run.coverage = "partial";
        } else {
            run.toolFiles[path] = state;
            run.capturedBytes += size;
            if (state.reason) run.coverage = "partial";
        }
        this.writeRun(run);
    }

    noteCommandRun(workspaceId: string, sessionId: string, runId: string): void {
        const run = this.readRun(workspaceId, runId);
        if (!run || run.sessionId !== sessionId || run.status !== "running") return;
        const notice = "本轮执行过命令；可见 Git 差异会列出，但命令造成的 ignored 文件或提交后的改动不能完整归属审阅。";
        if (!run.notices.includes(notice)) run.notices.push(notice);
        run.coverage = "partial";
        this.writeRun(run);
    }

    finishRun(workspaceId: string, runId: string, status: SessionSummary["status"]): void {
        this.updateRunStatus(workspaceId, runId, status);
        let run: StoredReviewRun | null = null;
        try { run = this.readRun(workspaceId, runId); }
        catch {
            this.prune(workspaceId);
            return;
        }
        if (run) {
            run.status = status;
            this.writeRun(run);
        }
        this.prune(workspaceId);
    }

    async getSnapshot(workspaceId: string, sessionId: string, workspaceRoot: string): Promise<CodeReviewSnapshot> {
        const git = await readGitSnapshot(workspaceRoot);
        const index = this.readIndex(workspaceId);
        const runId = index.latestBySessionId[sessionId];
        let run: StoredReviewRun | null = null;
        let reviewUnavailable = false;
        try { run = runId ? this.readRun(workspaceId, runId) : null; }
        catch { reviewUnavailable = true; }
        if (run && runId && index.runs[runId]) run.status = index.runs[runId].status;
        if (runId && !run) reviewUnavailable = true;
        if (!run) {
            return {
                runId: null,
                sessionId: null,
                startedAt: null,
                status: null,
                isGit: git.isGit,
                git,
                files: [],
                preexisting: [],
                coverage: "unavailable",
                ...(reviewUnavailable ? { notice: "无法读取或解密本机代码审阅快照；请检查系统安全存储是否可用。" } : {}),
            };
        }

        const baselineStatus = statusMap(run.baselineGit.files);
        const currentStatus = statusMap(git.files);
        const candidates = new Set([
            ...Object.keys(run.baselineFiles),
            ...Object.keys(run.toolFiles),
            ...git.files.map((file) => file.path),
        ]);
        const files: ReviewFile[] = [];
        let coverage = run.coverage;
        if (git.error || git.filesTruncated) coverage = "partial";
        for (const path of candidates) {
            let before = run.baselineFiles[path] ?? run.toolFiles[path];
            const status = currentStatus.get(path);
            const preexisting = baselineStatus.has(path);
            if (preexisting && before?.reason && !run.toolFiles[path]) continue;
            if (!before && status && run.baselineGit.isGit && !preexisting) {
                let current: ReadState;
                try { current = readState(safeAbsolutePath(workspaceRoot, path)); }
                catch (error) {
                    current = { existed: false, base64: null, hash: null, reason: error instanceof Error ? error.message : "无法读取文件。" };
                }
                const gitDiff = await readGitDiffFromHead(workspaceRoot, path).catch(() => null);
                const statusCode = status.worktreeStatus === "D" || status.indexStatus === "D" ? "deleted"
                    : status.worktreeStatus === "A" || status.indexStatus === "A" || status.untracked ? "added" : "modified";
                files.push({
                    path,
                    status: statusCode,
                    source: "git-status",
                    preexisting: false,
                    indexStatus: status.indexStatus,
                    worktreeStatus: status.worktreeStatus,
                    baselineHash: null,
                    currentHash: current.hash,
                    diff: gitDiff?.content ?? "",
                    truncated: gitDiff?.truncated ?? false,
                    canRestore: false,
                    notice: current.reason ?? (status.untracked
                        ? "Git 检测到新出现的未跟踪文件，但无法确认它在任务开始时是否为被忽略文件，因此不提供撤销。"
                        : "通过 Git 状态发现了任务开始后的差异，但没有文件级运行前快照，因此不提供撤销。"),
                });
                if (!gitDiff || current.reason) coverage = "partial";
                continue;
            }
            if (!before) continue;

            let current: ReadState;
            try { current = readState(safeAbsolutePath(workspaceRoot, path)); }
            catch (error) {
                current = { existed: false, base64: null, hash: null, reason: error instanceof Error ? error.message : "无法读取文件。" };
            }
            const changeStatus = fileStatus(before, current);
            if (!changeStatus) {
                if (before.reason || current.reason) coverage = "partial";
                continue;
            }

            const oldBytes = before.existed ? decode(before) : Buffer.alloc(0);
            const newBytes = current.existed ? current.bytes ?? (current.base64 ? Buffer.from(current.base64, "base64") : null) : Buffer.alloc(0);
            const diff = oldBytes && newBytes ? textDiff(path, oldBytes, newBytes) : { diff: "", truncated: false };
            const restoreBlocker = before.reason ?? current.reason;
            const notice = restoreBlocker ?? diff.notice;
            const gitStatus = status;
            files.push({
                path,
                status: changeStatus,
                source: run.toolFiles[path] ? "agent-file-tool" : "git-status",
                preexisting,
                ...(gitStatus ? { indexStatus: gitStatus.indexStatus, worktreeStatus: gitStatus.worktreeStatus } : {}),
                baselineHash: before.hash,
                currentHash: current.hash,
                diff: diff.diff,
                truncated: diff.truncated,
                canRestore: !restoreBlocker && (before.base64 !== null || !before.existed),
                ...(notice ? { notice } : {}),
            });
        }
        files.sort((left, right) => left.path.localeCompare(right.path));
        const notices = [...run.notices];
        if (git.error) notices.push(git.error);
        if (git.filesTruncated) notices.push("当前工作树差异超过文件列表上限，审阅结果可能不完整。");
        if (!git.isGit && run.status === "running") notices.push("运行中的非 Git 快照会在文件工具写入前刷新。");
        return {
            runId: run.runId,
            sessionId: run.sessionId,
            startedAt: run.startedAt,
            status: run.status,
            isGit: git.isGit,
            git,
            files,
            preexisting: run.baselineGit.files,
            coverage,
            ...(notices.length ? { notice: notices.join(" ") } : {}),
        };
    }

    async checkFile(workspaceId: string, runId: string, workspaceRoot: string, path: string, expectedCurrentHash: string | null): Promise<boolean> {
        const run = this.requireRun(workspaceId, runId);
        const absolute = safeAbsolutePath(workspaceRoot, path);
        const current = readState(absolute);
        if (current.reason) return false;
        return current.hash === expectedCurrentHash;
    }

    getRunStatus(workspaceId: string, runId: string): SessionSummary["status"] {
        return this.requireRun(workspaceId, runId).status;
    }

    async restoreFile(
        workspaceId: string,
        runId: string,
        workspaceRoot: string,
        path: string,
        expectedCurrentHash: string | null,
    ): Promise<ReviewRestoreResult> {
        const run = this.requireRun(workspaceId, runId);
        if (run.status === "running") {
            throw new DesktopServiceError("REVIEW_RUN_ACTIVE", "Stop the running task before restoring its files.");
        }
        const relativePath = safeRelativePath(workspaceRoot, path);
        const absolute = safeAbsolutePath(workspaceRoot, relativePath);
        const current = readState(absolute);
        if (current.reason || current.hash !== expectedCurrentHash) return { restored: false, stale: true };
        const before = run.baselineFiles[relativePath] ?? run.toolFiles[relativePath];
        if (!before) throw new DesktopServiceError("REVIEW_BASELINE_UNAVAILABLE", "A run-start snapshot is not available for this file.");
        const restored = restoreFile(workspaceRoot, relativePath, before, expectedCurrentHash);
        return { restored, stale: !restored };
    }

    private requireRun(workspaceId: string, runId: string): StoredReviewRun {
        const run = this.readRun(workspaceId, runId);
        if (!run) throw new DesktopServiceError("REVIEW_NOT_FOUND", "This review snapshot has expired or was removed.");
        const indexed = this.readIndex(workspaceId).runs[runId];
        if (indexed) run.status = indexed.status;
        return run;
    }

    private directory(workspaceId: string): string {
        return resolve(this.root, workspaceId);
    }

    private runPath(workspaceId: string, runId: string): string {
        if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new DesktopServiceError("INVALID_RUN_ID", "Run id is invalid.");
        return resolve(this.directory(workspaceId), `${runId}.json`);
    }

    private readRun(workspaceId: string, runId: string): StoredReviewRun | null {
        const path = this.runPath(workspaceId, runId);
        try {
            const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<EncryptedReviewRun>;
            if (stored.version !== 1 || typeof stored.encrypted !== "string") return null;
            if (!safeStorage.isEncryptionAvailable()) {
                throw new DesktopServiceError("REVIEW_STORAGE_UNAVAILABLE", "System-protected storage is unavailable.");
            }
            const plaintext = safeStorage.decryptString(Buffer.from(stored.encrypted, "base64"));
            const run = JSON.parse(plaintext) as StoredReviewRun;
            Object.setPrototypeOf(run.baselineFiles, null);
            Object.setPrototypeOf(run.toolFiles, null);
            return run.workspaceId === workspaceId && run.runId === runId ? run : null;
        } catch (error) {
            if (error instanceof DesktopServiceError) throw error;
            return null;
        }
    }

    private writeRun(run: StoredReviewRun): void {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new DesktopServiceError("REVIEW_STORAGE_UNAVAILABLE", "System-protected storage is unavailable; review snapshots were not saved.");
        }
        const stored: EncryptedReviewRun = {
            version: 1,
            encrypted: safeStorage.encryptString(JSON.stringify(run)).toString("base64"),
        };
        atomicWrite(this.runPath(run.workspaceId, run.runId), JSON.stringify(stored));
    }

    private readIndex(workspaceId: string): ReviewIndex {
        try {
            const value = JSON.parse(readFileSync(resolve(this.directory(workspaceId), "index.json"), "utf8")) as Partial<ReviewIndex>;
            return {
                latestBySessionId: value.latestBySessionId ?? {},
                runs: value.runs ?? {},
            };
        } catch { return { latestBySessionId: {}, runs: {} }; }
    }

    private updateLatest(workspaceId: string, sessionId: string, runId: string): void {
        const index = this.readIndex(workspaceId);
        index.latestBySessionId[sessionId] = runId;
        index.runs[runId] = { sessionId, startedAt: new Date().toISOString(), status: "running" };
        atomicWrite(resolve(this.directory(workspaceId), "index.json"), JSON.stringify(index));
    }

    private updateRunStatus(workspaceId: string, runId: string, status: SessionSummary["status"]): void {
        const index = this.readIndex(workspaceId);
        const existing = index.runs[runId];
        if (!existing) return;
        existing.status = status;
        atomicWrite(resolve(this.directory(workspaceId), "index.json"), JSON.stringify(index));
    }

    private prune(workspaceId: string): void {
        const directory = this.directory(workspaceId);
        try {
            const index = this.readIndex(workspaceId);
            const runs = Object.entries(index.runs)
                .map(([runId, meta]) => ({ runId, ...meta }))
                .filter((run) => run.status !== "running")
                .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
            const retained = new Set(runs.slice(0, RETAINED_RUNS_PER_WORKSPACE).map((run) => run.runId));
            for (const [runId, meta] of Object.entries(index.runs)) {
                if (meta.status === "running") retained.add(runId);
            }
            for (const run of Object.keys(index.runs)) {
                if (!retained.has(run)) {
                    try { unlinkSync(this.runPath(workspaceId, run)); } catch { /* best effort */ }
                    delete index.runs[run];
                }
            }
            for (const [sessionId, latestRunId] of Object.entries(index.latestBySessionId)) {
                if (index.runs[latestRunId]) continue;
                const replacement = runs.find((run) => run.sessionId === sessionId && retained.has(run.runId));
                if (replacement) index.latestBySessionId[sessionId] = replacement.runId;
                else delete index.latestBySessionId[sessionId];
            }
            atomicWrite(resolve(directory, "index.json"), JSON.stringify(index));
        } catch { return; }
    }
}
