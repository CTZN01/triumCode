import { execFile, type ExecFileException } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { WorktreeAssociation, WorktreeMergeResult, WorktreeReviewSnapshot, WorktreeSetupData } from "../shared/contracts.js";
import { DesktopServiceError } from "./workspace-store.js";

interface GitResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

class WorktreeGitError extends Error {
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly outputLimitExceeded: boolean;

    constructor(error: ExecFileException, stderr: string) {
        super(error.message);
        this.name = "WorktreeGitError";
        this.exitCode = typeof error.code === "number" ? error.code : null;
        this.stderr = stderr.trim();
        this.outputLimitExceeded = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    }
}

function gitEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
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
    options: { timeout?: number; allowExitCodeOne?: boolean; maxBuffer?: number } = {},
): Promise<GitResult> {
    return new Promise((resolveResult, reject) => {
        execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.quotepath=false", ...args], {
            cwd,
            env: gitEnvironment(),
            encoding: "utf8",
            timeout: options.timeout ?? 8_000,
            maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (!error) {
                resolveResult({ stdout, stderr, exitCode: 0 });
                return;
            }
            if (options.allowExitCodeOne && error.code === 1) {
                resolveResult({ stdout, stderr, exitCode: 1 });
                return;
            }
            reject(new WorktreeGitError(error, stderr));
        });
    });
}

function pathKey(path: string): string {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInside(parent: string, candidate: string): boolean {
    const path = relative(pathKey(parent), pathKey(candidate));
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function slug(value: string): string {
    const normalized = value.normalize("NFKC").trim().toLocaleLowerCase();
    return normalized
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 48) || "task";
}

async function repositoryRoot(workspaceRoot: string): Promise<string> {
    let selectedRoot: string;
    try { selectedRoot = await realpath(workspaceRoot); }
    catch { throw new DesktopServiceError("WORKSPACE_MISSING", "所选工作区目录不可访问。"); }

    try {
        const result = await runGit(selectedRoot, ["rev-parse", "--show-toplevel"]);
        const root = await realpath(result.stdout.trim());
        if (pathKey(root) !== pathKey(selectedRoot)) {
            throw new DesktopServiceError("WORKTREE_REPOSITORY_ROOT_REQUIRED", "请打开 Git 仓库根目录后再创建隔离工作区。");
        }
        return root;
    } catch (error) {
        if (error instanceof DesktopServiceError) throw error;
        throw new DesktopServiceError("WORKTREE_REPOSITORY_REQUIRED", "隔离工作区需要一个有效的 Git 仓库。");
    }
}

async function inspect(root: string): Promise<WorktreeSetupData> {
    const [branchResult, currentResult, headResult, statusResult] = await Promise.all([
        runGit(root, ["for-each-ref", "--format=%(refname:short)%00%(symref)", "refs/heads", "refs/remotes"]),
        runGit(root, ["branch", "--show-current"]),
        runGit(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]).catch(() => null),
        runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    const branches = branchResult.stdout.split(/\r?\n/)
        .map((value) => value.split("\0"))
        .filter(([name, symbolicTarget]) => Boolean(name) && !symbolicTarget)
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b));
    const currentBranch = currentResult.stdout.trim() || null;
    const head = headResult?.stdout.trim() ?? "";
    if (!/^[a-f0-9]{40,64}$/i.test(head)) {
        throw new DesktopServiceError("WORKTREE_EMPTY_REPOSITORY", "仓库还没有提交记录，先创建一次提交再创建隔离工作区。");
    }
    return {
        repositoryName: basename(root),
        currentBranch,
        branches,
        dirty: statusResult.stdout.length > 0,
        defaultBase: currentBranch ?? branches[0] ?? head,
    };
}

export async function getWorktreeSetup(workspaceRoot: string): Promise<WorktreeSetupData> {
    return inspect(await repositoryRoot(workspaceRoot));
}

export async function createGitWorktree(
    workspaceRoot: string,
    input: {
        taskName: string;
        branchName: string;
        baseRef: string;
        parentPath: string;
        confirmDirtySource: boolean;
    },
): Promise<{ path: string; taskName: string; branchName: string; baseCommit: string; sourceBranch: string | null; sourceDirty: boolean }> {
    const root = await repositoryRoot(workspaceRoot);
    const setup = await inspect(root);
    const taskName = input.taskName.trim();
    const branchName = input.branchName.trim();
    const baseRef = input.baseRef.trim();
    if (!taskName || taskName.length > 80 || /[\u0000-\u001f\u007f]/.test(taskName)) {
        throw new DesktopServiceError("INVALID_WORKTREE_TASK_NAME", "任务名称需为 1 到 80 个可见字符。");
    }
    if (!branchName || branchName.startsWith("-") || branchName.length > 120 || /[\u0000-\u001f\u007f]/.test(branchName)) {
        throw new DesktopServiceError("INVALID_WORKTREE_BRANCH", "分支名称无效。");
    }
    if (!baseRef || baseRef.length > 200 || /[\u0000-\u001f\u007f]/.test(baseRef)) {
        throw new DesktopServiceError("INVALID_WORKTREE_BASE", "基准分支或提交无效。");
    }
    if (setup.dirty && !input.confirmDirtySource) {
        throw new DesktopServiceError("WORKTREE_SOURCE_DIRTY", "源工作区有未提交改动。请先提交/暂存这些改动，或确认它们不会复制到新工作区后继续。");
    }
    try { await runGit(root, ["check-ref-format", "--branch", branchName]); }
    catch { throw new DesktopServiceError("INVALID_WORKTREE_BRANCH", "Git 分支名称格式无效。"); }

    let baseCommit: string;
    try {
        baseCommit = (await runGit(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])).stdout.trim();
    } catch {
        throw new DesktopServiceError("INVALID_WORKTREE_BASE", "找不到所选的基准分支或提交。");
    }
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) {
        throw new DesktopServiceError("INVALID_WORKTREE_BASE", "所选基准没有解析为有效提交。");
    }

    const branchExists = await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { allowExitCodeOne: true });
    if (branchExists.exitCode === 0) throw new DesktopServiceError("WORKTREE_BRANCH_EXISTS", `分支 ${branchName} 已存在，请换一个分支名称。`);

    if (!input.parentPath || !isAbsolute(input.parentPath) || input.parentPath.length > 4_096) {
        throw new DesktopServiceError("INVALID_WORKTREE_PARENT", "请选择有效的目标父目录。");
    }
    let parentPath: string;
    try {
        const parentStat = await lstat(input.parentPath);
        if (!parentStat.isDirectory()) throw new Error("not a directory");
        parentPath = await realpath(input.parentPath);
    } catch {
        throw new DesktopServiceError("INVALID_WORKTREE_PARENT", "目标父目录不可访问。");
    }

    const folderName = `triumcode-${slug(basename(root))}-${slug(taskName)}`;
    const targetPath = resolve(parentPath, folderName);
    if (isInside(root, targetPath)) {
        throw new DesktopServiceError("WORKTREE_TARGET_INSIDE_SOURCE", "隔离工作区必须创建在源仓库目录之外。");
    }
    try {
        await lstat(targetPath);
        throw new DesktopServiceError("WORKTREE_TARGET_EXISTS", `目标目录已存在：${targetPath}`);
    } catch (error) {
        if (error instanceof DesktopServiceError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new DesktopServiceError("WORKTREE_TARGET_UNAVAILABLE", "无法检查目标目录，请选择其他父目录。");
        }
    }

    try {
        await runGit(root, ["worktree", "add", "-b", branchName, targetPath, baseCommit], { timeout: 60_000 });
    } catch (error) {
        const detail = error instanceof WorktreeGitError && error.stderr ? error.stderr.slice(0, 800) : "";
        throw new DesktopServiceError("WORKTREE_CREATE_FAILED", detail || "Git 无法创建该工作树。请检查仓库状态、分支名和目标目录后重试。");
    }
    return { path: targetPath, taskName, branchName, baseCommit, sourceBranch: setup.currentBranch, sourceDirty: setup.dirty };
}

async function assertSameRepository(sourceRoot: string, worktreeRoot: string): Promise<void> {
    if (pathKey(sourceRoot) === pathKey(worktreeRoot)) {
        throw new DesktopServiceError("INVALID_WORKTREE", "源仓库和隔离工作区路径不能相同。");
    }
    const [sourceCommon, worktreeCommon] = await Promise.all([
        runGit(sourceRoot, ["rev-parse", "--git-common-dir"]),
        runGit(worktreeRoot, ["rev-parse", "--git-common-dir"]),
    ]);
    const [sourceCommonPath, worktreeCommonPath] = await Promise.all([
        realpath(resolve(sourceRoot, sourceCommon.stdout.trim())),
        realpath(resolve(worktreeRoot, worktreeCommon.stdout.trim())),
    ]);
    if (pathKey(sourceCommonPath) !== pathKey(worktreeCommonPath)) {
        throw new DesktopServiceError("WORKTREE_REPOSITORY_MISMATCH", "该隔离工作区不再属于记录中的源仓库。");
    }
}

async function worktreeRoots(sourcePath: string, worktreePath: string): Promise<[string, string]> {
    const [sourceRoot, worktreeRoot] = await Promise.all([repositoryRoot(sourcePath), repositoryRoot(worktreePath)]);
    await assertSameRepository(sourceRoot, worktreeRoot);
    return [sourceRoot, worktreeRoot];
}

async function assertRegisteredWorktree(sourceRoot: string, worktreeRoot: string, branchName: string): Promise<void> {
    const registered = await runGit(sourceRoot, ["worktree", "list", "--porcelain"]);
    const root = await realpath(worktreeRoot);
    const entries = registered.stdout.split(/\r?\n\r?\n/);
    const entry = entries.find((block) => {
        const lines = block.split(/\r?\n/);
        return lines.some((line) => line.startsWith("worktree ") && pathKey(line.slice("worktree ".length)) === pathKey(root));
    });
    if (!entry || !entry.split(/\r?\n/).includes(`branch refs/heads/${branchName}`)) {
        throw new DesktopServiceError("WORKTREE_REGISTRATION_CHANGED", "Git 中的工作树或分支与本地关联记录不一致，已停止此操作。");
    }
}

export async function readWorktreeReview(
    sourcePath: string,
    worktreePath: string,
    association: WorktreeAssociation,
): Promise<WorktreeReviewSnapshot> {
    const [sourceRoot, worktreeRoot] = await worktreeRoots(sourcePath, worktreePath);
    if (!/^[a-f0-9]{40,64}$/i.test(association.baseCommit)) {
        throw new DesktopServiceError("INVALID_WORKTREE_RECORD", "工作树基准记录无效。");
    }
    await assertRegisteredWorktree(sourceRoot, worktreeRoot, association.branchName);
    const [sourceBranchResult, sourceStatus, branchResult, headResult, statusResult, countResult] = await Promise.all([
        runGit(sourceRoot, ["branch", "--show-current"]),
        runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
        runGit(worktreeRoot, ["branch", "--show-current"]),
        runGit(worktreeRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]),
        runGit(worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
        runGit(worktreeRoot, ["rev-list", "--count", `${association.baseCommit}..HEAD`]),
    ]);
    const currentBranch = branchResult.stdout.trim() || null;
    if (currentBranch !== association.branchName) {
        throw new DesktopServiceError("WORKTREE_BRANCH_CHANGED", "隔离工作区当前分支已变化，不能按原关联执行合并或清理。");
    }
    const currentCommit = headResult.stdout.trim();
    const commitCount = Number(countResult.stdout.trim());
    if (!/^[a-f0-9]{40,64}$/i.test(currentCommit) || !Number.isSafeInteger(commitCount) || commitCount < 0) {
        throw new DesktopServiceError("INVALID_WORKTREE_STATE", "无法读取隔离工作区的提交状态。");
    }

    let diff = "";
    let diffTruncated = false;
    try {
        diff = (await runGit(worktreeRoot, ["diff", "--no-ext-diff", "--unified=3", association.baseCommit, currentCommit], {
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
        })).stdout;
    } catch (error) {
        if (!(error instanceof WorktreeGitError) || !error.outputLimitExceeded) throw error;
        const stat = await runGit(worktreeRoot, ["diff", "--stat", "--no-ext-diff", association.baseCommit, currentCommit], {
            timeout: 15_000,
            maxBuffer: 256 * 1024,
        });
        diff = `差异超过 1 MiB，以下仅显示文件统计；请在终端运行 git diff ${association.baseCommit.slice(0, 12)}..HEAD 查看完整差异。\n\n${stat.stdout}`;
        diffTruncated = true;
    }

    return {
        branchName: association.branchName,
        currentCommit,
        commitCount,
        sourceCurrentBranch: sourceBranchResult.stdout.trim() || null,
        sourceDirty: sourceStatus.stdout.length > 0,
        worktreeDirty: statusResult.stdout.length > 0,
        diff,
        diffTruncated,
    };
}

export async function mergeGitWorktree(
    sourcePath: string,
    worktreePath: string,
    association: WorktreeAssociation,
): Promise<WorktreeMergeResult> {
    const review = await readWorktreeReview(sourcePath, worktreePath, association);
    if (!association.sourceBranch || review.sourceCurrentBranch !== association.sourceBranch) {
        throw new DesktopServiceError("WORKTREE_SOURCE_BRANCH_CHANGED", "源工作区当前分支与创建工作树时不同。请切回原分支后再合并。");
    }
    if (review.sourceDirty) {
        throw new DesktopServiceError("WORKTREE_SOURCE_DIRTY", "源工作区有未提交改动。请先提交或暂存，再合并隔离工作区。");
    }
    if (review.worktreeDirty) {
        throw new DesktopServiceError("WORKTREE_DIRTY", "隔离工作区有未提交改动。请先在该工作区提交这些改动，再合并。");
    }

    try {
        await runGit(sourcePath, ["merge", "--no-ff", "--no-edit", association.branchName], { timeout: 60_000 });
        return { outcome: "merged", message: `已将 ${association.branchName} 合并到 ${association.sourceBranch}。` };
    } catch (error) {
        const mergeHead = await runGit(sourcePath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { allowExitCodeOne: true });
        if (mergeHead.exitCode === 0) {
            const conflicts = await runGit(sourcePath, ["diff", "--name-only", "--diff-filter=U", "--no-ext-diff"], {
                timeout: 8_000,
                maxBuffer: 128 * 1024,
            });
            const conflictCount = conflicts.stdout.split(/\r?\n/).filter(Boolean).length;
            return {
                outcome: "conflict",
                message: conflictCount > 0
                    ? `合并遇到 ${conflictCount} 个冲突文件。打开源工作区终端解决冲突并提交，或运行 git merge --abort 取消合并。`
                    : "合并未完成，Git 保留了合并状态。打开源工作区终端检查 Git 状态，完成或运行 git merge --abort 取消。",
            };
        }
        const detail = error instanceof WorktreeGitError && error.stderr ? error.stderr.slice(0, 800) : "Git 无法完成合并。";
        throw new DesktopServiceError("WORKTREE_MERGE_FAILED", detail);
    }
}

export async function removeGitWorktree(
    sourcePath: string,
    worktreePath: string,
    association: WorktreeAssociation,
    deleteBranch: boolean,
): Promise<{ branchDeleted: boolean; message: string }> {
    const review = await readWorktreeReview(sourcePath, worktreePath, association);
    if (review.worktreeDirty) {
        throw new DesktopServiceError("WORKTREE_DIRTY", "隔离工作区有未提交改动。请先提交、暂存或手动处理后再移除；此操作不会强制删除改动。");
    }
    const [sourceRoot, worktreeRoot] = await worktreeRoots(sourcePath, worktreePath);
    await runGit(sourceRoot, ["worktree", "remove", worktreeRoot], { timeout: 60_000 });

    if (!deleteBranch) {
        return { branchDeleted: false, message: `工作树已移除，分支 ${association.branchName} 已保留。` };
    }
    try {
        await runGit(sourceRoot, ["branch", "-d", association.branchName]);
        return { branchDeleted: true, message: `工作树和已合并分支 ${association.branchName} 均已移除。` };
    } catch {
        return {
            branchDeleted: false,
            message: `工作树已移除，但 Git 未确认分支 ${association.branchName} 已合并，因此保留了该分支。`,
        };
    }
}
