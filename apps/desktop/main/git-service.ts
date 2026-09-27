import { execFile, type ExecFileException } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitCommitDetail, GitCommitSummary, GitFileChange, GitFileDiff, GitHistory, GitSnapshot } from "../shared/contracts.js";
import { DesktopServiceError } from "./workspace-store.js";

const STATUS_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DIFF_OUTPUT_LIMIT = 512 * 1024;
const FILE_LIST_LIMIT = 1_000;
const COMMAND_TIMEOUT_MS = 8_000;
const GIT_WRITE_TIMEOUT_MS = 60_000;

interface GitOutput {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
}

class GitCommandError extends Error {
    readonly code: string | number | null | undefined;
    readonly stderr: string;

    constructor(error: ExecFileException, stderr: string) {
        super(error.message);
        this.name = "GitCommandError";
        this.code = error.code;
        this.stderr = stderr;
    }
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_LITERAL_PATHSPECS: "1",
    };
    for (const name of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_PREFIX",
    ]) delete env[name];
    return env;
}

function runGit(
    cwd: string,
    args: string[],
    maxBuffer: number,
    allowExitCodeOne = false,
    timeout = COMMAND_TIMEOUT_MS,
): Promise<GitOutput> {
    return new Promise((resolveOutput, reject) => {
        execFile("git", [
            "-c", "core.fsmonitor=false",
            "-c", "core.pager=cat",
            "-c", "core.quotepath=false",
            "--no-optional-locks",
            ...args,
        ], {
            cwd,
            env: gitEnvironment(),
            encoding: "utf8",
            timeout,
            maxBuffer,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const output = { stdout, stderr, exitCode: 0, truncated: false };
            if (!error) {
                resolveOutput(output);
                return;
            }
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                resolveOutput({ ...output, truncated: true });
                return;
            }
            if (allowExitCodeOne && error.code === 1) {
                resolveOutput({ ...output, exitCode: 1 });
                return;
            }
            reject(new GitCommandError(error, stderr));
        });
    });
}

function isNotRepository(error: unknown): boolean {
    return error instanceof GitCommandError && /not a git repository/i.test(error.stderr);
}

function gitErrorMessage(error: unknown): string {
    if (error instanceof GitCommandError && error.code === "ENOENT") {
        return "找不到 Git。安装 Git 并确保它已加入 PATH 后重试。";
    }
    if (error instanceof GitCommandError && error.code === "ETIMEDOUT") {
        return "Git 操作超时。仓库可能过大或暂时不可用，请刷新后重试。";
    }
    if (error instanceof GitCommandError && /dubious ownership/i.test(error.stderr)) {
        return "Git 出于安全原因拒绝读取此仓库。请检查 Git safe.directory 设置。";
    }
    return "无法读取 Git 状态。请检查 Git 安装、仓库权限和工作区状态。";
}

function parseFiles(output: string, outputTruncated: boolean): { files: GitFileChange[]; truncated: boolean } {
    const entries = output.split("\0");
    if (entries.at(-1) === "") entries.pop();
    if (outputTruncated && entries.length > 0) entries.pop();

    const files: GitFileChange[] = [];
    let truncated = outputTruncated;
    for (const entry of entries) {
        if (!entry || entry.startsWith("## ")) continue;
        if (entry.length < 4 || entry[2] !== " ") continue;
        if (files.length >= FILE_LIST_LIMIT) {
            truncated = true;
            break;
        }
        const indexStatus = entry[0];
        const worktreeStatus = entry[1];
        const untracked = indexStatus === "?" && worktreeStatus === "?";
        files.push({
            path: entry.slice(3),
            indexStatus,
            worktreeStatus,
            staged: !untracked && indexStatus !== " ",
            unstaged: !untracked && worktreeStatus !== " ",
            untracked,
        });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { files, truncated };
}

async function currentBranch(cwd: string): Promise<string | null> {
    const branch = await runGit(cwd, ["branch", "--show-current"], 16 * 1024);
    if (branch.stdout.trim()) return branch.stdout.trim();
    try {
        const commit = await runGit(cwd, ["rev-parse", "--short", "HEAD"], 16 * 1024);
        return commit.stdout.trim() ? `detached ${commit.stdout.trim()}` : null;
    } catch {
        return null;
    }
}

export async function readGitSnapshot(workspaceRoot: string): Promise<GitSnapshot> {
    try {
        const check = await runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"], 16 * 1024);
        if (check.stdout.trim() !== "true") return { isGit: false, branch: null, files: [] };
    } catch (error) {
        if (isNotRepository(error)) return { isGit: false, branch: null, files: [] };
        return { isGit: false, branch: null, files: [], error: gitErrorMessage(error) };
    }

    const branch = await currentBranch(workspaceRoot).catch(() => null);
    try {
        const result = await runGit(workspaceRoot, [
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--no-renames",
        ], STATUS_OUTPUT_LIMIT);
        const parsed = parseFiles(result.stdout, result.truncated);
        return { isGit: true, branch, files: parsed.files, filesTruncated: parsed.truncated };
    } catch (error) {
        return { isGit: true, branch, files: [], error: gitErrorMessage(error) };
    }
}

async function localBranches(workspaceRoot: string): Promise<string[]> {
    const result = await runGit(workspaceRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], 128 * 1024);
    return result.stdout.split(/\r?\n/).filter(Boolean).sort((left, right) => left.localeCompare(right));
}

export async function readGitHistory(workspaceRoot: string): Promise<GitHistory> {
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "此工作区不是 Git 仓库。");
    try {
        const branches = await localBranches(workspaceRoot);
        const refs = await runGit(workspaceRoot, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], 128 * 1024);
        const head = await runGit(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], 128, true);
        if (!refs.stdout.trim() && head.exitCode !== 0) {
            return { currentBranch: snapshot.branch, branches, dirty: snapshot.files.length > 0 || snapshot.filesTruncated === true, commits: [] };
        }
        const result = await runGit(workspaceRoot, [
            "log", "--all", ...(head.exitCode === 0 ? ["HEAD"] : []), "--graph", "--date-order", "--max-count=100",
            "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%D%x1f%P",
        ], 512 * 1024);
        const commits: GitCommitSummary[] = [];
        for (const line of result.stdout.split(/\r?\n/)) {
            const fields = line.split("\x1f");
            if (fields.length !== 6) continue;
            const hash = /[a-f0-9]{40,64}$/i.exec(fields[0])?.[0];
            if (!hash) continue;
            commits.push({
                hash,
                graph: fields[0].slice(0, -hash.length),
                parents: fields[5].split(" ").filter(Boolean),
                subject: fields[1],
                author: fields[2],
                authoredAt: fields[3],
                decorations: fields[4],
            });
        }
        return { currentBranch: snapshot.branch, branches, dirty: snapshot.files.length > 0 || snapshot.filesTruncated === true, commits };
    } catch (error) {
        throw mutationError(error);
    }
}

export async function readGitCommitDetail(workspaceRoot: string, hash: string): Promise<GitCommitDetail> {
    if (!/^[a-f0-9]{40,64}$/i.test(hash)) {
        throw new DesktopServiceError("INVALID_GIT_COMMIT", "提交编号无效。");
    }
    try {
        const [header, stats] = await Promise.all([
            runGit(workspaceRoot, ["show", "--no-color", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B", hash], 128 * 1024),
            runGit(workspaceRoot, ["show", "--no-color", "--stat", "--format=", "--no-renames", "--root", hash], 256 * 1024),
        ]);
        const fields = header.stdout.split("\0");
        return {
            hash: fields[0].trim(),
            parents: fields[1].trim().split(" ").filter(Boolean),
            author: fields[2],
            authorEmail: fields[3],
            authoredAt: fields[4],
            message: fields.slice(5).join("\0").trim(),
            stats: stats.stdout.trim(),
            statsTruncated: stats.truncated,
        };
    } catch (error) {
        throw mutationError(error);
    }
}

export async function switchGitBranch(workspaceRoot: string, branch: string): Promise<void> {
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "此工作区不是 Git 仓库。");
    if (snapshot.files.length > 0 || snapshot.filesTruncated) {
        throw new DesktopServiceError("GIT_WORKTREE_DIRTY", "切换已有分支前，请先提交或清理当前工作区的改动。");
    }
    try {
        if (!(await localBranches(workspaceRoot)).includes(branch)) {
            throw new DesktopServiceError("GIT_BRANCH_NOT_FOUND", "所选本地分支已不存在，请刷新后重试。");
        }
        await runGit(workspaceRoot, ["switch", "--no-guess", branch], 256 * 1024, false, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
        if (error instanceof DesktopServiceError) throw error;
        throw mutationError(error);
    }
}

export async function createGitBranch(workspaceRoot: string, branch: string): Promise<void> {
    const name = branch.trim();
    if (!name || name.length > 120 || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new DesktopServiceError("INVALID_GIT_BRANCH", "分支名称无效。");
    }
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "此工作区不是 Git 仓库。");
    try {
        await runGit(workspaceRoot, ["check-ref-format", "--branch", name], 16 * 1024);
    } catch {
        throw new DesktopServiceError("INVALID_GIT_BRANCH", "Git 分支名称格式无效。");
    }
    try {
        if ((await localBranches(workspaceRoot)).includes(name)) {
            throw new DesktopServiceError("GIT_BRANCH_EXISTS", "该分支已存在，请换一个名称。");
        }
        await runGit(workspaceRoot, ["switch", "-c", name], 256 * 1024, false, GIT_WRITE_TIMEOUT_MS);
    } catch (error) {
        if (error instanceof DesktopServiceError) throw error;
        throw mutationError(error);
    }
}

function safeWorkspacePath(workspaceRoot: string, path: string): string {
    const absolutePath = resolve(workspaceRoot, path);
    const relativePath = relative(workspaceRoot, absolutePath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new DesktopServiceError("INVALID_GIT_PATH", "Git file path is outside this workspace.");
    }
    return relativePath;
}

async function currentGitPath(workspaceRoot: string, path: string, require: "staged" | "unstaged"): Promise<{ relativePath: string; file: GitFileChange }> {
    const relativePath = safeWorkspacePath(workspaceRoot, path);
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "This workspace is not a Git repository.");
    const file = snapshot.files.find((entry) => entry.path === relativePath);
    if (!file) throw new DesktopServiceError("GIT_PATH_STALE", "This file is no longer listed as changed. Refresh Git status and try again.");
    if (require === "staged" && !file.staged) {
        throw new DesktopServiceError("GIT_PATH_NOT_STAGED", "This file has no staged changes.");
    }
    if (require === "unstaged" && !file.unstaged && !file.untracked) {
        throw new DesktopServiceError("GIT_PATH_NOT_UNSTAGED", "This file has no unstaged changes.");
    }
    return { relativePath, file };
}

function mutationError(error: unknown): DesktopServiceError {
    if (error instanceof GitCommandError) {
        if (error.code === "ENOENT" || error.code === "ETIMEDOUT") {
            return new DesktopServiceError("GIT_OPERATION_FAILED", gitErrorMessage(error));
        }
        const detail = error.stderr.trim().slice(0, 1_000);
        if (detail) return new DesktopServiceError("GIT_OPERATION_FAILED", detail);
    }
    return new DesktopServiceError("GIT_OPERATION_FAILED", gitErrorMessage(error));
}

export async function stageGitPath(workspaceRoot: string, path: string): Promise<void> {
    const { relativePath } = await currentGitPath(workspaceRoot, path, "unstaged");
    try {
        await runGit(workspaceRoot, ["add", "-A", "--", relativePath], 256 * 1024);
    } catch (error) {
        throw mutationError(error);
    }
}

export async function unstageGitPath(workspaceRoot: string, path: string): Promise<void> {
    const { relativePath } = await currentGitPath(workspaceRoot, path, "staged");
    try {
        const head = await runGit(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], 16 * 1024, true);
        if (head.exitCode === 0) {
            await runGit(workspaceRoot, ["restore", "--staged", "--", relativePath], 256 * 1024);
        } else {
            // An unborn repository has no HEAD to restore from; removing only the index entry keeps the file on disk.
            await runGit(workspaceRoot, ["rm", "--cached", "--ignore-unmatch", "--", relativePath], 256 * 1024);
        }
    } catch (error) {
        throw mutationError(error);
    }
}

export async function commitGitChanges(workspaceRoot: string, message: string): Promise<string> {
    const commitMessage = message.trim();
    if (!commitMessage || commitMessage.length > 500) {
        throw new DesktopServiceError("INVALID_COMMIT_MESSAGE", "Enter a commit message up to 500 characters.");
    }
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "This workspace is not a Git repository.");

    try {
        const staged = await runGit(workspaceRoot, ["diff", "--cached", "--quiet", "--exit-code"], 16 * 1024, true);
        if (staged.exitCode === 0) {
            throw new DesktopServiceError("GIT_NOTHING_STAGED", "Stage at least one file before creating a commit.");
        }
        const result = await runGit(workspaceRoot, ["commit", "-m", commitMessage], 2 * 1024 * 1024, false, GIT_WRITE_TIMEOUT_MS);
        return result.stdout.trim() || "Commit created.";
    } catch (error) {
        if (error instanceof DesktopServiceError) throw error;
        throw mutationError(error);
    }
}

function limitedText(text: string, maxBytes: number): { content: string; truncated: boolean } {
    const buffer = Buffer.from(text, "utf-8");
    if (buffer.byteLength <= maxBytes) return { content: text, truncated: false };
    return { content: buffer.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

function staleDiff(path: string, staged: boolean): GitFileDiff {
    return { path, staged, content: "", truncated: false, stale: true };
}

export async function readGitDiff(workspaceRoot: string, path: string, staged: boolean): Promise<GitFileDiff> {
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "This workspace is not a Git repository.");

    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file || (staged ? !file.staged : !file.unstaged && !file.untracked)) return staleDiff(path, staged);

    const relativePath = safeWorkspacePath(workspaceRoot, file.path);
    const absolutePath = resolve(workspaceRoot, relativePath);
    const untracked = !staged && file.untracked;
    if (!staged) {
        try {
            const info = await lstat(absolutePath);
            if (info.isSymbolicLink()) {
                return {
                    path,
                    staged,
                    content: "",
                    truncated: false,
                    notice: "这是符号链接。为避免读取工作区外的目标内容，差异面板不会打开链接目标。",
                };
            }
            if (!info.isFile()) {
                return {
                    path,
                    staged,
                    content: "",
                    truncated: false,
                    notice: "此路径当前不是普通文件，差异面板没有读取它的内容。",
                };
            }
        } catch (error) {
            if (untracked || (error instanceof Error && "code" in error && error.code !== "ENOENT")) {
                return staleDiff(path, staged);
            }
        }
    }

    const diffArgs = untracked
        ? ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", "/dev/null", relativePath]
        : ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", relativePath];
    try {
        const result = await runGit(workspaceRoot, diffArgs, DIFF_OUTPUT_LIMIT, untracked);
        const limited = limitedText(result.stdout, DIFF_OUTPUT_LIMIT);
        return {
            path,
            staged,
            content: limited.content,
            truncated: result.truncated || limited.truncated,
        };
    } catch (error) {
        throw new DesktopServiceError("GIT_DIFF_FAILED", gitErrorMessage(error));
    }
}

export async function readGitDiffFromHead(workspaceRoot: string, path: string): Promise<GitFileDiff> {
    const snapshot = await readGitSnapshot(workspaceRoot);
    if (snapshot.error) throw new DesktopServiceError("GIT_UNAVAILABLE", snapshot.error);
    if (!snapshot.isGit) throw new DesktopServiceError("NOT_A_GIT_REPOSITORY", "This workspace is not a Git repository.");

    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file) return staleDiff(path, false);
    if (file.untracked) return readGitDiff(workspaceRoot, path, false);

    const relativePath = safeWorkspacePath(workspaceRoot, file.path);
    try {
        const result = await runGit(workspaceRoot, [
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            relativePath,
        ], DIFF_OUTPUT_LIMIT, true);
        const limited = limitedText(result.stdout, DIFF_OUTPUT_LIMIT);
        return {
            path,
            staged: false,
            content: limited.content,
            truncated: result.truncated || limited.truncated,
        };
    } catch (error) {
        throw new DesktopServiceError("GIT_DIFF_FAILED", gitErrorMessage(error));
    }
}
