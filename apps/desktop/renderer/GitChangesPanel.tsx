import { useEffect, useState } from "react";
import type { CodeReviewSnapshot, GitFileChange, GitFileDiff, GitSnapshot, ReviewFile } from "../shared/contracts.js";
import { DiffViewer } from "./DiffViewer.js";

type FileFilter = "all" | "unstaged" | "staged";
type ReviewView = "run" | "preexisting" | "worktree";

function fileMark(file: GitFileChange): string {
    if (file.untracked) return "?";
    return file.worktreeStatus !== " " ? file.worktreeStatus : file.indexStatus;
}

function statusMark(status: ReviewFile["status"]): string {
    return status === "added" ? "A" : status === "deleted" ? "D" : "M";
}

function markClass(mark: string): string {
    if (mark === "?" || mark === "A") return "added";
    if (mark === "D") return "deleted";
    return "modified";
}

export function GitChangesPanel({
    workspaceId,
    sessionId,
    snapshot,
    review,
    loading,
    busy,
    onRefresh,
}: {
    workspaceId: string;
    sessionId: string | null;
    snapshot: GitSnapshot | null;
    review: CodeReviewSnapshot | null;
    loading: boolean;
    busy: boolean;
    onRefresh: () => void;
}) {
    const [view, setView] = useState<ReviewView>("run");
    const [filter, setFilter] = useState<FileFilter>("all");
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [selectedStaged, setSelectedStaged] = useState(false);
    const [diff, setDiff] = useState<GitFileDiff | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [diffError, setDiffError] = useState("");
    const [fileStale, setFileStale] = useState(false);
    const [restoreConfirm, setRestoreConfirm] = useState(false);
    const [restoreBusy, setRestoreBusy] = useState(false);
    const [restoreMessage, setRestoreMessage] = useState("");
    const [gitActionBusy, setGitActionBusy] = useState(false);
    const [gitActionMessage, setGitActionMessage] = useState("");
    const [commitResult, setCommitResult] = useState("");
    const [commitMessage, setCommitMessage] = useState("");

    const currentFiles = snapshot?.isGit ? snapshot.files : [];
    const files = view === "run" ? review?.files ?? []
        : view === "preexisting" ? review?.preexisting ?? []
            : currentFiles;
    const selectedReviewFile = view === "run" ? (review?.files.find((file) => file.path === selectedPath) ?? null) : null;
    const selectedFile = view === "run" ? null : (files.find((file) => file.path === selectedPath) as GitFileChange | undefined) ?? null;
    const visibleFiles = view === "worktree" && filter !== "all"
        ? (files as GitFileChange[]).filter((file) => filter === "staged" ? file.staged : file.unstaged || file.untracked)
        : files;

    useEffect(() => {
        setSelectedPath((current) => files.some((file) => file.path === current) ? current : files[0]?.path ?? null);
        setRestoreConfirm(false);
        setRestoreMessage("");
    }, [view, review?.runId, snapshot, files]);

    useEffect(() => {
        if (!selectedFile) {
            setDiff(null);
            setDiffError("");
            setDiffLoading(false);
            return;
        }
        const hasSelectedSide = selectedStaged ? selectedFile.staged : selectedFile.unstaged || selectedFile.untracked;
        if (!hasSelectedSide) setSelectedStaged(selectedFile.staged && !selectedFile.unstaged && !selectedFile.untracked);
    }, [selectedFile?.path, selectedFile?.staged, selectedFile?.unstaged, selectedFile?.untracked, selectedStaged, view]);

    useEffect(() => {
        if (view === "run" || !selectedFile || !snapshot?.isGit) {
            setDiff(null);
            setDiffError("");
            setDiffLoading(false);
            return;
        }
        const staged = selectedStaged;
        let live = true;
        setDiff(null);
        setDiffError("");
        setDiffLoading(true);
        void window.desktop.getGitDiff(workspaceId, selectedFile.path, staged).then((result) => {
            if (live) setDiff(result);
        }).catch((error: unknown) => {
            if (live) setDiffError(error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (live) setDiffLoading(false);
        });
        return () => { live = false; };
    }, [view, snapshot, workspaceId, selectedFile?.path, selectedFile?.staged, selectedFile?.unstaged, selectedFile?.untracked, selectedStaged]);

    useEffect(() => {
        if (view !== "run" || !selectedReviewFile || !review?.runId
            || (selectedReviewFile.currentHash === null && selectedReviewFile.status !== "deleted")) {
            setFileStale(false);
            return;
        }
        let live = true;
        const check = () => {
            void window.desktop.checkReviewFile(workspaceId, review.runId!, selectedReviewFile.path, selectedReviewFile.currentHash).then((matches) => {
                if (live) setFileStale(!matches);
            }).catch(() => {
                if (live) setFileStale(true);
            });
        };
        check();
        const timer = window.setInterval(check, 1800);
        return () => { live = false; window.clearInterval(timer); };
    }, [view, workspaceId, review?.runId, selectedReviewFile?.path, selectedReviewFile?.currentHash]);

    const selectFile = (file: GitFileChange) => {
        setSelectedPath(file.path);
        setSelectedStaged(file.staged && !file.unstaged && !file.untracked);
    };

    const selectStagedSide = (staged: boolean) => {
        if (!selectedFile) return;
        if (staged ? selectedFile.staged : selectedFile.unstaged || selectedFile.untracked) setSelectedStaged(staged);
    };

    const restoreSelected = async () => {
        if (!selectedReviewFile?.canRestore || !review?.runId || restoreBusy) return;
        setRestoreBusy(true);
        setRestoreMessage("");
        try {
            const result = await window.desktop.restoreReviewFile(workspaceId, review.runId, selectedReviewFile.path, selectedReviewFile.currentHash);
            if (result.stale) {
                setFileStale(true);
                setRestoreMessage("文件在确认期间又发生了变化，没有执行还原。刷新后重新检查差异。");
            } else {
                setRestoreConfirm(false);
                setRestoreMessage("文件已恢复到本机审阅快照记录的版本。");
                onRefresh();
            }
        } catch (error) {
            setRestoreMessage(error instanceof Error ? error.message : String(error));
        } finally {
            setRestoreBusy(false);
        }
    };

    const stageSelected = async () => {
        if (!selectedFile || !selectedFile.unstaged && !selectedFile.untracked || gitActionBusy || busy) return;
        setGitActionBusy(true);
        setGitActionMessage("");
        try {
            await window.desktop.stageGitPath(workspaceId, selectedFile.path);
            setGitActionMessage(`已暂存 ${selectedFile.path}`);
            onRefresh();
        } catch (error) {
            setGitActionMessage(error instanceof Error ? error.message : String(error));
        } finally {
            setGitActionBusy(false);
        }
    };

    const unstageSelected = async () => {
        if (!selectedFile?.staged || gitActionBusy || busy) return;
        setGitActionBusy(true);
        setGitActionMessage("");
        try {
            await window.desktop.unstageGitPath(workspaceId, selectedFile.path);
            setGitActionMessage(`已取消暂存 ${selectedFile.path}`);
            onRefresh();
        } catch (error) {
            setGitActionMessage(error instanceof Error ? error.message : String(error));
        } finally {
            setGitActionBusy(false);
        }
    };

    const commitStagedChanges = async () => {
        if (!commitMessage.trim() || !canCommitStagedChanges || gitActionBusy || busy) return;
        setGitActionBusy(true);
        setCommitResult("");
        try {
            const result = await window.desktop.commitGitChanges(workspaceId, commitMessage);
            setCommitMessage("");
            setCommitResult(result);
            onRefresh();
        } catch (error) {
            setCommitResult(error instanceof Error ? error.message : String(error));
        } finally {
            setGitActionBusy(false);
        }
    };

    const stagedCount = currentFiles.filter((file) => file.staged).length;
    const unstagedCount = currentFiles.filter((file) => file.unstaged || file.untracked).length;
    const canCommitStagedChanges = stagedCount > 0 || Boolean(snapshot?.filesTruncated);
    const canShowWorktree = Boolean(snapshot && (snapshot.isGit || snapshot.error));

    return <section className="git-changes-panel" aria-label="代码审阅和 Git 改动">
        <div className="git-panel-toolbar">
            <div className="git-panel-heading"><div><strong>代码审阅</strong><small>{review?.startedAt ? `最近任务 ${new Date(review.startedAt).toLocaleString()}` : "按任务检查改动"}</small></div><button className="secondary-button compact" onClick={onRefresh} disabled={loading}>{loading ? "刷新中..." : "刷新"}</button></div>
            <div className="review-tabs" role="tablist" aria-label="代码审阅范围">
                <button className={view === "run" ? "selected" : ""} onClick={() => setView("run")}>本轮任务{review?.files.length ? <span>{review.files.length}</span> : null}</button>
                <button className={view === "preexisting" ? "selected" : ""} onClick={() => setView("preexisting")}>运行前已有{review?.preexisting.length ? <span>{review.preexisting.length}</span> : null}</button>
                <button className={view === "worktree" ? "selected" : ""} onClick={() => setView("worktree")} disabled={!canShowWorktree}>当前工作树</button>
            </div>
            {view === "run" && review?.notice && <p className="git-scope-note">{review.notice}</p>}
            {view === "run" && review?.coverage === "partial" && <p className="git-scope-note">这轮审阅有覆盖范围限制；请同时查看提示、任务活动和当前工作树。</p>}
            {view === "preexisting" && <p className="git-scope-note">这些 Git 改动在本轮开始前已存在。这里只标记当时的文件状态；右侧差异显示当前文件内容。</p>}
            {view === "worktree" && <p className="git-scope-note">这里显示整个工作区的当前 Git 状态，包括任务开始前的改动。</p>}
        </div>

        {loading && !snapshot ? <div className="git-panel-state">正在读取工作区...</div>
            : view === "worktree" && snapshot?.error ? <div className="git-panel-state git-panel-error"><strong>无法读取 Git 状态</strong><p>{snapshot.error}</p></div>
                : view === "worktree" && !snapshot?.isGit ? <div className="git-panel-state"><strong>未初始化 Git</strong><p>此目录仍可用于代码工作。Git 状态只在初始化仓库后显示。</p></div>
                    : <>
                        {view === "worktree" && <>
                            <div className="git-count-row"><span>{currentFiles.length}{snapshot?.filesTruncated ? "+" : ""} 个变更文件</span><span>{stagedCount} 已暂存</span><span>{unstagedCount} 未暂存</span></div>
                            {snapshot?.filesTruncated && <div className="git-truncated-notice">仓库改动较多，当前仅列出前 1,000 个文件。</div>}
                            <div className="git-commit-box">
                                <label htmlFor="git-commit-message">提交说明</label>
                                <textarea id="git-commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} maxLength={500} rows={2} placeholder="描述这次提交" disabled={busy || gitActionBusy} />
                                <small>{snapshot?.filesTruncated ? "文件列表已截断，统计不完整；提交仍会按完整 Git 暂存区执行。" : "只提交已暂存内容。"}提交时本地 Git hooks 可能运行程序。</small>
                                <button className="primary-button compact" onClick={() => void commitStagedChanges()} disabled={busy || gitActionBusy || !canCommitStagedChanges || !commitMessage.trim()}>{gitActionBusy ? "处理中..." : "提交已暂存更改"}</button>
                                {commitResult && <div className="git-mutation-message" role="status">{commitResult}</div>}
                            </div>
                            <div className="git-file-filters" role="tablist" aria-label="文件状态筛选">
                                <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部</button>
                                <button className={filter === "unstaged" ? "selected" : ""} onClick={() => setFilter("unstaged")}>未暂存</button>
                                <button className={filter === "staged" ? "selected" : ""} onClick={() => setFilter("staged")}>已暂存</button>
                            </div>
                        </>}
                        {view !== "worktree" && <div className="git-count-row"><span>{files.length} 个文件</span>{view === "run" && review?.status && <span>{review.status === "running" ? "任务进行中" : "最近一轮"}</span>}</div>}
                        {files.length === 0 ? <div className="git-clean-state">{view === "run" ? review?.runId ? "最近一轮没有记录到文件变化。" : sessionId ? "发送任务后，这里会显示 Agent 文件工具和 Git 变化。" : "先创建或打开一个会话，再查看本轮任务改动。" : view === "preexisting" ? review?.isGit ? "本轮开始前没有 Git 改动。" : "非 Git 工作区无法分类运行前的既有文件改动。" : "工作区干净，没有 Git 改动。"}</div> :
                            <div className="git-file-list">
                                {visibleFiles.map((entry) => {
                                    const reviewFile = view === "run" ? entry as ReviewFile : null;
                                    const gitFile = view === "run" ? null : entry as GitFileChange;
                                    const mark = reviewFile ? statusMark(reviewFile.status) : fileMark(gitFile!);
                                    const isSelected = selectedPath === entry.path;
                                    return <button className={`git-file-row ${isSelected ? "selected" : ""}`} key={entry.path} onClick={() => reviewFile ? setSelectedPath(reviewFile.path) : selectFile(gitFile!)} title={entry.path}>
                                        <span className={`git-file-mark ${markClass(mark)}`}>{mark}</span>
                                        <span className="git-file-path">{entry.path}</span>
                                        {reviewFile?.preexisting && <span className="git-side-badge">既有文件</span>}
                                        {reviewFile && <span className="git-side-badge staged">{reviewFile.source === "agent-file-tool" ? "Agent 文件工具" : "Git 状态"}</span>}
                                        {gitFile?.staged && <span className="git-side-badge staged">暂存</span>}
                                        {gitFile && (gitFile.unstaged || gitFile.untracked) && <span className="git-side-badge">{gitFile.untracked ? "未跟踪" : "工作区"}</span>}
                                    </button>;
                                })}
                            </div>}

                        {files.length > 0 && <div className="git-diff-section">
                            {(selectedReviewFile || selectedFile) ? <>
                                <div className="git-diff-heading">
                                    <div className="git-diff-path" title={selectedPath ?? ""}>{selectedPath}</div>
                                    {selectedReviewFile && selectedReviewFile.canRestore && <button
                                        className="review-restore-button"
                                        disabled={review?.status === "running" || fileStale || restoreBusy}
                                        onClick={() => { setRestoreConfirm(true); setRestoreMessage(""); }}
                                    >还原</button>}
                                    {selectedReviewFile && fileStale && <span className="review-stale-badge">文件已变化</span>}
                                    {selectedFile && <div className="git-diff-sides">
                                        {selectedFile.staged && <button className={selectedStaged ? "selected" : ""} onClick={() => selectStagedSide(true)}>暂存</button>}
                                        {(selectedFile.unstaged || selectedFile.untracked) && <button className={!selectedStaged ? "selected" : ""} onClick={() => selectStagedSide(false)}>工作区</button>}
                                    </div>}
                                    {selectedFile && view === "worktree" && (selectedFile.unstaged || selectedFile.untracked) && <button className="git-write-button" onClick={() => void stageSelected()} disabled={busy || gitActionBusy}>{gitActionBusy ? "处理中..." : "暂存文件"}</button>}
                                    {selectedFile && view === "worktree" && selectedFile.staged && <button className="git-write-button" onClick={() => void unstageSelected()} disabled={busy || gitActionBusy}>{gitActionBusy ? "处理中..." : "取消暂存"}</button>}
                                </div>
                                {selectedFile && view === "worktree" && (selectedFile.unstaged || selectedFile.untracked) && <div className="git-stage-note">暂存会将此文件当前全部内容放入 Git 暂存区。</div>}
                                {gitActionMessage && view === "worktree" && <div className="git-mutation-message" role="status">{gitActionMessage}</div>}
                                {restoreConfirm && selectedReviewFile && <div className="review-restore-confirm">
                                    <strong>确认还原 {selectedReviewFile.path}？</strong>
                                    <p>将恢复到审阅快照记录的版本，覆盖当前工作区文件；Git 暂存区不会改变。文件版本若已变化，还原会被阻止。</p>
                                    <div><button className="secondary-button compact" onClick={() => setRestoreConfirm(false)} disabled={restoreBusy}>取消</button><button className="danger-button compact" onClick={() => void restoreSelected()} disabled={restoreBusy || fileStale}>{restoreBusy ? "还原中..." : "确认还原"}</button></div>
                                </div>}
                                {restoreMessage && <div className={restoreMessage.includes("已恢复") ? "review-restore-success" : "git-truncated-notice"}>{restoreMessage}</div>}
                                <div className="git-diff-content" aria-live="polite">
                                    {view === "run" ? <>
                                        {selectedReviewFile?.notice && <div className="git-truncated-notice">{selectedReviewFile.notice}</div>}
                                        {selectedReviewFile?.diff ? <>
                                            {selectedReviewFile.truncated && <div className="git-truncated-notice">差异超过显示上限，已截断。</div>}
                                            {selectedReviewFile.preexisting && <div className="git-truncated-notice">此文件在本轮开始前已有改动；差异比较的是任务基线与当前文件。</div>}
                                            <DiffViewer diff={selectedReviewFile.diff} />
                                        </> : !selectedReviewFile?.notice && <div className="git-panel-state">文件状态已读取，但当前没有可显示的文本差异。</div>}
                                    </>
                                        : diffLoading ? <div className="git-panel-state">正在生成差异...</div>
                                            : diffError ? <div className="git-panel-state git-panel-error">{diffError}</div>
                                                : diff?.stale ? <div className="git-panel-state">这个文件的 Git 状态刚刚变化。刷新列表后重新选择。</div>
                                                    : diff?.notice ? <div className="git-panel-state">{diff.notice}</div>
                                                        : diff?.content ? <>
                                                            {diff.truncated && <div className="git-truncated-notice">差异超过 512 KiB，已截断显示。</div>}
                                                            <DiffViewer diff={diff.content} />
                                                        </>
                                                            : <div className="git-panel-state">文件状态已读取，但当前没有可显示的文本差异。</div>}
                                </div>
                            </> : <div className="git-panel-state">选择一个文件查看差异。</div>}
                        </div>}
                    </>}
    </section>;
}
