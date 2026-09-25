import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopTaskCenterData, DesktopTaskStatus, DesktopTaskSummary } from "../shared/contracts.js";

function SearchIcon() {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>;
}

function CloseIcon() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function taskStatusLabel(status: DesktopTaskStatus, runId: string | null): string {
    if (status === "waiting-approval") return "等待权限确认";
    if (status === "waiting-user") return "等待你的回答";
    if (status === "running") return runId ? "运行中" : "其他进程运行中";
    if (status === "completed") return "已完成";
    if (status === "failed") return "失败";
    if (status === "cancelled") return "已停止";
    return "意外中断";
}

function taskTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TaskCenterDialog({
    data,
    loading,
    error,
    onClose,
    onRefresh,
    onOpen,
    onStop,
}: {
    data: DesktopTaskCenterData | null;
    loading: boolean;
    error: string;
    onClose: () => void;
    onRefresh: () => void;
    onOpen: (task: DesktopTaskSummary) => void;
    onStop: (runId: string) => Promise<void>;
}) {
    const [search, setSearch] = useState("");
    const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
    const [stopError, setStopError] = useState("");
    const dialogRef = useRef<HTMLElement | null>(null);
    const previousFocus = useRef<HTMLElement | null>(null);
    const tasks = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        if (!query) return data?.tasks ?? [];
        return (data?.tasks ?? []).filter((task) =>
            `${task.session.title} ${task.workspace.name} ${task.workspace.path} ${task.latestActivityTitle ?? ""}`
                .toLocaleLowerCase().includes(query));
    }, [data, search]);

    useEffect(() => {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.querySelector<HTMLInputElement>(".task-center-search input")?.focus();
        return () => previousFocus.current?.focus();
    }, []);

    const stopTask = async (runId: string) => {
        if (stoppingRunId) return;
        setStoppingRunId(runId);
        setStopError("");
        try {
            await onStop(runId);
            onRefresh();
        } catch (failure) {
            setStopError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setStoppingRunId(null);
        }
    };

    return <div className="modal-scrim task-center-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section ref={dialogRef} className="task-center-dialog" role="dialog" aria-modal="true" aria-labelledby="task-center-title" tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
                if (event.key !== "Tab") return;
                const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? [])];
                const first = focusable[0];
                const last = focusable.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
            <div className="settings-heading">
                <div><div className="eyebrow">WORK QUEUE</div><h2 id="task-center-title">任务中心</h2><p>查看跨工作区运行、等待和最近结束的任务。</p></div>
                <div className="task-center-heading-actions"><button className="secondary-button compact" onClick={onRefresh} disabled={loading}>{loading ? "刷新中..." : "刷新"}</button><button className="icon-button" onClick={onClose} aria-label="关闭任务中心"><CloseIcon /></button></div>
            </div>
            <div className="task-center-search"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务、项目或活动" aria-label="搜索任务、项目或活动" /></div>
            {error && <div className="task-center-error" role="alert">{error}</div>}
            {stopError && <div className="task-center-error" role="alert">{stopError}</div>}
            <div className="task-center-list" aria-live="polite">
                {loading && !data ? <div className="task-center-empty">正在读取任务...</div>
                    : tasks.length === 0 ? <div className="task-center-empty">{search ? "没有匹配的任务。" : "还没有可显示的任务。开始一个会话后，任务会出现在这里。"}</div>
                        : tasks.map((task) => <article className={`task-center-row ${task.status}`} key={task.id}>
                            <span className={`task-center-status-mark ${task.status}`} aria-hidden="true"><i /></span>
                            <div className="task-center-task-info">
                                <div className="task-center-task-heading"><strong title={task.session.title}>{task.session.title}</strong><span className={`task-center-status ${task.status}`}>{taskStatusLabel(task.status, task.runId)}</span></div>
                                <div className="task-center-project" title={task.workspace.path}>{task.workspace.name}<span>{task.workspace.path}</span></div>
                                <div className="task-center-task-meta"><time dateTime={task.session.updated}>{taskTime(task.session.updated)}</time>{task.latestActivityTitle && <span title={task.latestActivityTitle}>{task.latestActivityTitle}</span>}</div>
                            </div>
                            <div className="task-center-row-actions">
                                {task.runId && <button className="task-center-stop" onClick={() => void stopTask(task.runId!)} disabled={Boolean(stoppingRunId)}>{stoppingRunId === task.runId ? "停止中..." : "停止"}</button>}
                                <button className="secondary-button compact" onClick={() => onOpen(task)}>打开</button>
                            </div>
                        </article>)}
            </div>
            <div className="task-center-footer">本地任务 · 不会上传代码或会话内容</div>
        </section>
    </div>;
}
