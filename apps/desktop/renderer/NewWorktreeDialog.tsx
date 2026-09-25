import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
    CreateWorktreeResult,
    WorktreeAssociation,
    WorktreeReviewSnapshot,
    WorktreeSetupData,
    WorkspaceSummary,
} from "../shared/contracts.js";

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function branchSlug(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 48) || "task";
}

export function NewWorktreeDialog({
    workspace,
    onClose,
    onCreated,
}: {
    workspace: WorkspaceSummary;
    onClose: () => void;
    onCreated: (result: CreateWorktreeResult) => Promise<void>;
}) {
    const [setup, setSetup] = useState<WorktreeSetupData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [taskName, setTaskName] = useState("");
    const [branchName, setBranchName] = useState("codex/task");
    const [branchEdited, setBranchEdited] = useState(false);
    const [baseRef, setBaseRef] = useState("");
    const [parentPath, setParentPath] = useState("");
    const [confirmDirtySource, setConfirmDirtySource] = useState(false);
    const [creating, setCreating] = useState(false);
    const branchOptionsId = useMemo(() => `worktree-branches-${workspace.id}`, [workspace.id]);
    const dialogRef = useRef<HTMLElement | null>(null);
    const previousFocus = useRef<HTMLElement | null>(null);

    useEffect(() => {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => previousFocus.current?.focus();
    }, []);

    useEffect(() => {
        let live = true;
        void window.desktop.getWorktreeSetup(workspace.id).then((result) => {
            if (!live) return;
            setSetup(result);
            setBaseRef(result.defaultBase);
        }).catch((failure: unknown) => {
            if (live) setError(messageOf(failure));
        }).finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [workspace.id]);

    useEffect(() => {
        if (!branchEdited) setBranchName(`codex/${branchSlug(taskName)}`);
    }, [branchEdited, taskName]);

    useEffect(() => {
        if (!loading) dialogRef.current?.querySelector<HTMLInputElement>("input:not([readonly])")?.focus();
    }, [loading]);

    const chooseParent = async () => {
        try {
            const selected = await window.desktop.chooseWorktreeParent();
            if (selected) setParentPath(selected);
        } catch (failure) { setError(messageOf(failure)); }
    };

    const create = async (event: FormEvent) => {
        event.preventDefault();
        if (creating || !setup) return;
        setError("");
        setCreating(true);
        try {
            const result = await window.desktop.createWorktree(workspace.id, {
                taskName,
                branchName,
                baseRef,
                parentPath,
                confirmDirtySource,
            });
            await onCreated(result);
        } catch (failure) {
            setError(messageOf(failure));
            try {
                const refreshed = await window.desktop.getWorktreeSetup(workspace.id);
                if (refreshed.dirty && !setup.dirty) setConfirmDirtySource(false);
                setSetup(refreshed);
            }
            catch { /* Keep the original error visible if the source repository disappeared. */ }
        } finally { setCreating(false); }
    };

    const canCreate = !loading && !creating && Boolean(setup) && taskName.trim().length > 0
        && branchName.trim().length > 0 && baseRef.trim().length > 0 && parentPath.length > 0
        && (!setup?.dirty || confirmDirtySource);

    return <div className="modal-scrim worktree-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) onClose(); }}>
        <section ref={dialogRef} className="worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-title" tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key === "Escape" && !creating) { event.stopPropagation(); onClose(); return; }
                if (event.key !== "Tab") return;
                const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])") ?? [])]
                    .filter((element) => element.getClientRects().length > 0);
                const first = focusable[0];
                const last = focusable.at(-1);
                const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
                if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
                else if (activeIndex < 0) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
            <div className="settings-heading">
                <div><div className="eyebrow">ISOLATED WORKSPACE</div><h2 id="worktree-title">新建隔离工作区</h2><p>为并行任务创建独立 Git 工作树；未提交和被忽略的本地文件不会复制。</p></div>
                <button className="icon-button" onClick={onClose} disabled={creating} aria-label="关闭隔离工作区对话框">×</button>
            </div>
            {loading ? <div className="worktree-loading">正在检查 Git 仓库和工作区状态...</div> : <form className="worktree-form" onSubmit={(event) => void create(event)}>
                {setup && <>
                    <div className="worktree-source"><span>源仓库</span><strong title={workspace.path}>{setup.repositoryName}</strong><code title={workspace.path}>{workspace.path}</code></div>
                    <label className="field wide"><span>任务名称</span><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="例如：修复登录错误" maxLength={80} /></label>
                    <label className="field wide"><span>新分支</span><input value={branchName} onChange={(event) => { setBranchEdited(true); setBranchName(event.target.value); }} placeholder="codex/fix-login" maxLength={120} /><small className="field-help">默认使用 codex/ 前缀；Git 会拒绝已存在或无效的分支名。</small></label>
                    <label className="field wide"><span>基准分支或提交</span><input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} list={branchOptionsId} maxLength={200} placeholder="分支名、标签或提交 SHA" /><datalist id={branchOptionsId}>{setup.branches.map((branch) => <option key={branch} value={branch} />)}<option value="HEAD" /></datalist></label>
                    <div className="field wide worktree-parent-field"><span>新工作区的父目录</span><div><input readOnly value={parentPath} placeholder="选择一个位于源仓库之外的目录" /><button type="button" className="secondary-button compact" onClick={() => void chooseParent()}>选择目录</button></div><small className="field-help">将在此目录下创建独立文件夹，工作区名称由仓库名和任务名生成。</small></div>
                    {setup.dirty && <div className="worktree-dirty-warning"><strong>源工作区有未提交改动</strong><span>新工作树只从已提交的 Git 历史创建；检测到的改动不会复制。请先提交/暂存，或确认后继续。</span><label><input type="checkbox" checked={confirmDirtySource} onChange={(event) => setConfirmDirtySource(event.target.checked)} /><span>我理解检测到的改动不会进入新工作区</span></label></div>}
                </>}
                {error && <div className="task-center-error" role="alert">{error}</div>}
                <div className="worktree-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={creating}>取消</button><button type="submit" className="primary-button" disabled={!canCreate}>{creating ? "正在创建..." : "创建并切换工作区"}</button></div>
            </form>}
        </section>
    </div>;
}

export function WorktreeManagementDialog({
    workspace,
    association,
    sourceWorkspace,
    onClose,
    onOpenSourceTerminal,
    onRemoved,
}: {
    workspace: WorkspaceSummary;
    association: WorktreeAssociation;
    sourceWorkspace: WorkspaceSummary | null;
    onClose: () => void;
    onOpenSourceTerminal: (workspace: WorkspaceSummary) => Promise<void>;
    onRemoved: (sourceWorkspaceId: string) => Promise<void>;
}) {
    const [snapshot, setSnapshot] = useState<WorktreeReviewSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
    const [pendingAction, setPendingAction] = useState<"merge" | "remove" | null>(null);
    const [deleteBranch, setDeleteBranch] = useState(false);
    const dialogRef = useRef<HTMLElement | null>(null);
    const previousFocus = useRef<HTMLElement | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setSnapshot(null);
        setError("");
        try { setSnapshot(await window.desktop.getWorktreeReview(workspace.id)); }
        catch (failure) { setError(messageOf(failure)); }
        finally { setLoading(false); }
    }, [workspace.id]);

    useEffect(() => {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.focus();
        void refresh();
        return () => previousFocus.current?.focus();
    }, [refresh]);

    const sourceBranchMatches = Boolean(snapshot && association.sourceBranch
        && snapshot.sourceCurrentBranch === association.sourceBranch);
    const canMerge = Boolean(!loading && snapshot && sourceWorkspace?.available && sourceBranchMatches
        && snapshot.commitCount > 0 && !snapshot.sourceDirty && !snapshot.worktreeDirty);
    const canRemove = Boolean(!loading && snapshot && sourceWorkspace?.available && !snapshot.worktreeDirty);

    const confirmAction = async () => {
        if (!pendingAction || busy || !snapshot || !sourceWorkspace?.available) return;
        const action = pendingAction;
        setBusy(true);
        setError("");
        setNotice(null);
        try {
            if (action === "merge") {
                const result = await window.desktop.mergeWorktree(workspace.id);
                setNotice({ tone: result.outcome === "merged" ? "success" : "warning", message: result.message });
                setPendingAction(null);
                await refresh();
                return;
            }
            const result = await window.desktop.removeWorktree(workspace.id, deleteBranch);
            setNotice({ tone: "success", message: result.message });
            await onRemoved(result.sourceWorkspaceId);
        } catch (failure) {
            setError(messageOf(failure));
        } finally { setBusy(false); }
    };

    return <div className="modal-scrim worktree-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
        <section ref={dialogRef} className="worktree-dialog worktree-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-manage-title" tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); return; }
                if (event.key !== "Tab") return;
                const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])") ?? [])]
                    .filter((element) => element.getClientRects().length > 0);
                const first = focusable[0];
                const last = focusable.at(-1);
                const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
                if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
                else if (activeIndex < 0) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
            <div className="settings-heading">
                <div><div className="eyebrow">WORKTREE REVIEW</div><h2 id="worktree-manage-title">审阅与收尾隔离工作区</h2><p>先检查基线差异和未提交状态，再合并或安全移除。</p></div>
                <div className="task-center-heading-actions"><button className="secondary-button compact" onClick={() => void refresh()} disabled={loading || busy}>{loading ? "刷新中..." : "刷新"}</button><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭工作树审阅">×</button></div>
            </div>
            <div className="worktree-manage-content">
                <div className="worktree-source"><span>隔离工作区</span><strong>{association.taskName} · {association.branchName}</strong><code title={workspace.path}>{workspace.path}</code></div>
                <div className="worktree-source"><span>源工作区</span><strong>{sourceWorkspace?.name ?? "源工作区记录不可用"} · {association.sourceBranch ?? "分离头指针"}</strong><code title={association.sourcePath}>{association.sourcePath}</code></div>
                {!sourceWorkspace?.available && <div className="worktree-dirty-warning"><strong>{sourceWorkspace ? "源工作区当前不可访问" : "无法访问源工作区记录"}</strong><span>为避免丢失 Git 关联，合并和移除操作已停用。恢复源项目目录后再试。</span></div>}
                {loading && <div className="worktree-loading">正在读取工作树状态和基线差异...</div>}
                {snapshot && <>
                    <div className="worktree-review-summary">
                        <div><span>基准提交</span><strong>{association.baseCommit.slice(0, 12)}</strong></div>
                        <div><span>当前提交</span><strong>{snapshot.currentCommit.slice(0, 12)}</strong></div>
                        <div><span>领先提交</span><strong>{snapshot.commitCount}</strong></div>
                    </div>
                    <div className="worktree-review-status" aria-live="polite">
                        <span className={snapshot.sourceDirty ? "warning" : "ok"}>源工作区 {snapshot.sourceDirty ? "有未提交改动" : "干净"}</span>
                        <span className={snapshot.worktreeDirty ? "warning" : "ok"}>隔离工作区 {snapshot.worktreeDirty ? "有未提交改动" : "干净"}</span>
                        <span className={sourceBranchMatches ? "ok" : "warning"}>源分支 {snapshot.sourceCurrentBranch ?? "分离头指针"}{sourceBranchMatches ? "（匹配）" : "（与创建时不同）"}</span>
                    </div>
                    {snapshot.worktreeDirty && <div className="worktree-dirty-warning"><strong>隔离工作区有未提交改动</strong><span>合并和移除都会停用。先在该工作区提交、暂存后处理，或手动复制需要保留的内容；应用不会强制丢弃这些改动。</span></div>}
                    {snapshot.diffTruncated && <div className="worktree-dirty-warning"><strong>差异内容已截断</strong><span>完整差异超过显示上限。请使用源工作区终端按提示查看完整内容，再决定是否合并。</span></div>}
                    <details className="worktree-review-diff" open>
                        <summary>基线差异 · {snapshot.commitCount} 个提交</summary>
                        <pre>{snapshot.diff || "当前没有已提交差异。"}</pre>
                    </details>
                </>}
                {error && <div className="task-center-error" role="alert">{error}</div>}
                {notice && <div className={`worktree-action-notice ${notice.tone}`} role="status">{notice.message}</div>}
                {notice?.tone === "warning" && <button className="secondary-button compact" onClick={() => void onOpenSourceTerminal(sourceWorkspace!)} disabled={!sourceWorkspace?.available}>打开源工作区终端处理</button>}
                {pendingAction && <div className={`worktree-confirmation ${pendingAction}`} role="group" aria-label="确认工作树操作">
                    {pendingAction === "merge"
                        ? <><strong>确认将 {association.branchName} 合并到 {association.sourceBranch}</strong><span>合并会修改源工作区当前分支；若出现冲突，Git 会保留冲突状态供你在终端处理。</span></>
                        : <><strong>确认移除隔离工作区目录</strong><span>将移除 {workspace.path}。未提交改动会阻止操作。分支默认保留。</span><label><input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} /><span>移除后尝试删除已合并分支；Git 不确认已合并的分支会保留</span></label></>}
                    <div className="worktree-actions"><button className="secondary-button" onClick={() => setPendingAction(null)} disabled={busy}>返回检查</button><button className={pendingAction === "remove" ? "danger-button" : "primary-button"} onClick={() => void confirmAction()} disabled={busy || (pendingAction === "merge" ? !canMerge : !canRemove)}>{busy ? "正在处理..." : pendingAction === "merge" ? "确认合并" : "确认移除"}</button></div>
                </div>}
                <div className="worktree-actions worktree-manage-actions">
                    <button className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
                    <button className="secondary-button" onClick={() => setPendingAction("remove")} disabled={busy || !canRemove}>移除工作树...</button>
                    <button className="primary-button" onClick={() => setPendingAction("merge")} disabled={busy || !canMerge}>合并到源分支...</button>
                </div>
            </div>
        </section>
    </div>;
}
