import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type UIEvent } from "react";
import type {
    BootstrapData,
    ConversationMessage,
    CredentialState,
    CodeReviewSnapshot,
    DesktopEvent,
    DesktopModelPreset,
    DesktopSettings,
    GitFileDiff,
    GitSnapshot,
    GitHistory,
    GitCommitDetail,
    OpenSessionData,
    PendingPermissionRequest,
    PendingUserQuestion,
    SessionActivity,
    SessionSummary,
    DesktopTaskCenterData,
    DesktopTaskSummary,
    WorktreeAssociation,
    WorkspaceSummary,
} from "../shared/contracts.js";
import type { AgentContextUsage, AgentEvent, AgentFailureCategory, AgentUsage } from "../../../src/agent.js";
import { layoutGitGraph } from "../shared/git-graph-layout.js";
import type { PermissionAction, PermissionSource } from "../../../src/permissions.js";
import type { SessionPermissionGrantSummary } from "../../../src/permissions.js";
import { DesktopRunEventTracker } from "../../../src/desktop-events.js";
import { GitChangesPanel } from "./GitChangesPanel.js";
import { DiffViewer } from "./DiffViewer.js";
import { NewWorktreeDialog, WorktreeManagementDialog } from "./NewWorktreeDialog.js";
import { TaskCenterDialog } from "./TaskCenterDialog.js";
import { TerminalPanel } from "./TerminalPanel.js";
import { updateQuestionActivity } from "../shared/question-activity.js";
import { activityLine, activityTarget, editFileName, editLineStats, editResultSnippet, groupConversationActivities, type PlacedActivity } from "../shared/conversation-activity.js";
import { codeLanguage, highlightCodeLines } from "../shared/code-highlight.js";
import { AttachmentList } from "./AttachmentList.js";
import { useAttachmentDraft } from "./useAttachmentDraft.js";

type ActivityRow = PlacedActivity;

interface PanelWidths {
    sidebar: number;
    inspector: number;
}

type AppTheme = "system" | "dark" | "light";

const PANEL_WIDTHS_STORAGE_KEY = "triumcode.desktop.panel-widths.v1";

function fitPanelWidths(widths: PanelWidths, viewportWidth: number): PanelWidths {
    let sidebar = Math.min(340, Math.max(200, Math.round(widths.sidebar)));
    let inspector = Math.min(720, Math.max(230, Math.round(widths.inspector)));
    if (viewportWidth <= 1_020) return { sidebar, inspector };
    const minimumMainWidth = viewportWidth <= 1_190 ? 420 : 460;
    let overflow = Math.max(0, sidebar + inspector + minimumMainWidth + 10 - viewportWidth);
    const reduceInspector = Math.min(overflow, inspector - 230);
    inspector -= reduceInspector;
    overflow -= reduceInspector;
    sidebar = Math.max(200, sidebar - overflow);
    return { sidebar, inspector };
}

function readPanelWidths(): PanelWidths {
    const defaults = { sidebar: 262, inspector: 294 };
    try {
        const saved = JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? "null") as Partial<PanelWidths> | null;
        if (typeof saved?.sidebar !== "number" || !Number.isFinite(saved.sidebar)
            || typeof saved.inspector !== "number" || !Number.isFinite(saved.inspector)) return defaults;
        return fitPanelWidths(saved as PanelWidths, window.innerWidth);
    } catch {
        return defaults;
    }
}

function readThemePreference(): AppTheme {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? "null") as { theme?: unknown } | null;
        return saved?.theme === "light" || saved?.theme === "dark" ? saved.theme : "system";
    } catch {
        return "system";
    }
}

function readFontScale(): number {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? "null") as { fontScale?: unknown } | null;
        return saved?.fontScale === 1 || saved?.fontScale === 1.1 || saved?.fontScale === 1.2 ? saved.fontScale : 1.1;
    } catch { return 1.1; }
}

function readInspectorOpen(): boolean {
    try {
        const saved = JSON.parse(window.localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) ?? "null") as { inspectorOpen?: unknown } | null;
        return saved?.inspectorOpen !== false;
    } catch { return true; }
}

function defaultTerminalHeight(): number {
    const maximum = Math.max(145, Math.floor(window.innerHeight * 0.72));
    return Math.min(maximum, Math.min(560, Math.max(320, Math.round(window.innerHeight * 0.45))));
}

function displayError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function handleTabListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']:not(:disabled)")];
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1 + tabs.length) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    if (tabs.length === 0) return;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
}

function activityTime(value?: string): string {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function appendActivity(activities: ActivityRow[], activity: ActivityRow): ActivityRow[] {
    return [...activities, activity].slice(-200);
}

function permissionSourceLabel(source: PermissionSource): string {
    if (source.kind === "rule") {
        const scope = source.scope === "user" ? "用户规则" : source.scope === "project" ? "项目规则" : "权限规则";
        return `${scope} (${source.settingsFile})`;
    }
    if (source.kind === "builtin") {
        return source.policy === "read-tool" ? "内置只读工具规则 - 自动允许"
            : source.policy === "memory-tool" ? "内置记忆工具规则 - 自动允许"
                : "计划模式控制规则 - 自动允许";
    }
    if (source.kind === "session") return "本会话授权 - 仅相同操作";
    const policy = source.reason === "desktop-default" ? "桌面默认确认策略"
        : source.reason === "plan-restricted" ? "计划模式策略"
            : source.reason === "plan-file" ? "计划文件例外"
                : source.reason === "plan-mode" ? "计划模式策略"
                    : source.reason === "accept-edits" ? "自动允许编辑模式"
                        : source.reason === "desktop-accept-edits" ? "桌面编辑自动允许模式"
                            : source.reason === "bypass" ? "跳过权限确认模式"
                                : source.reason === "dangerous-command" ? "危险命令策略"
                                    : `默认策略 (${source.mode})`;
    const effect = source.effect === "confirm" ? "需要批准" : source.effect === "deny" ? "拒绝" : "允许";
    return `${policy} - ${effect}`;
}

function permissionDecisionLabel(action: PermissionAction): string {
    return action === "allow" ? "策略允许" : action === "deny" ? "策略拒绝" : "等待批准";
}

function permissionOutcomeLabel(outcome: SessionActivity["permissionOutcome"]): string | null {
    if (outcome === "once") return "临时批准 - 仅此一次";
    if (outcome === "session") return "已批准 - 本会话相同操作，随会话保存";
    if (outcome === "denied") return "用户拒绝";
    if (outcome === "expired") return "审批超时，按拒绝处理";
    if (outcome === "cancelled") return "任务停止时撤销了审批";
    return null;
}

function failureCategoryLabel(category: AgentFailureCategory): string {
    switch (category) {
        case "network": return "网络连接问题";
        case "authentication": return "认证失败";
        case "rate-limit": return "服务限流";
        case "provider": return "模型服务或协议错误";
        default: return "Agent 内部错误";
    }
}

function failureNextStep(category: AgentFailureCategory, retryable: boolean): string {
    if (category === "authentication") return "检查 API 密钥和认证方式后再继续。";
    if (category === "rate-limit") return "等待服务限流窗口结束后再继续。";
    if (category === "provider") return retryable
        ? "模型服务暂时不可用，稍后可恢复请求。"
        : "检查 API 地址、模型名称和协议设置。";
    if (category === "network") return "检查网络连接和 API 地址后，确认工作区改动再恢复请求。";
    return retryable ? "检查工作区改动后再恢复请求。" : "查看聊天中运行记录的错误详情，再决定下一步。";
}

function sessionStatusLabel(status: SessionSummary["status"]): string {
    switch (status) {
        case "running": return "运行中";
        case "interrupted": return "意外中断";
        case "cancelled": return "已停止";
        case "failed": return "失败";
        default: return "";
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return Math.round(value).toLocaleString("en-US");
}

function hasMissingPromptUsage(usage: AgentUsage): boolean {
    return usage.outputAvailable && usage.output > 0
        && usage.input + usage.cacheRead + usage.cacheWrite === 0;
}

function usageDetails(usage: AgentUsage): string {
    const entries = ["本会话累计用量（provider 实际报告）"];
    if (usage.inputAvailable && !hasMissingPromptUsage(usage)) entries.push(`未缓存输入：${usage.input.toLocaleString("en-US")} tokens`);
    if (usage.cacheReadAvailable && !hasMissingPromptUsage(usage)) entries.push(`缓存读取：${usage.cacheRead.toLocaleString("en-US")} tokens`);
    if (usage.cacheWriteAvailable && !hasMissingPromptUsage(usage)) entries.push(`缓存写入：${usage.cacheWrite.toLocaleString("en-US")} tokens`);
    if (usage.outputAvailable) entries.push(`输出：${usage.output.toLocaleString("en-US")} tokens`);
    return entries.join("\n");
}

function safeExternalHref(href: string): string | null {
    try {
        const url = new URL(href);
        return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function splitTableCells(line: string): string[] {
    let source = line.trim();
    if (source.startsWith("|")) source = source.slice(1);
    if (source.endsWith("|")) source = source.slice(0, -1);
    const cells: string[] = [];
    let cell = "";
    let codeTicks = 0;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === "`") {
            let run = 1;
            while (source[index + run] === "`") run++;
            if (codeTicks === 0) codeTicks = run;
            else if (codeTicks === run) codeTicks = 0;
            cell += "`".repeat(run);
            index += run - 1;
        } else if (character === "\\" && (source[index + 1] === "|" || source[index + 1] === "\\")) {
            cell += source[++index];
        } else if (character === "|" && codeTicks === 0) {
            cells.push(cell.trim());
            cell = "";
        } else {
            cell += character;
        }
    }
    cells.push(cell.trim());
    return cells;
}

function tableAlignment(separator: string): "left" | "center" | "right" {
    if (separator.startsWith(":") && separator.endsWith(":")) return "center";
    if (separator.endsWith(":")) return "right";
    return "left";
}

function credentialLabel(state: CredentialState): string {
    switch (state) {
        case "secure-key": return "系统安全存储已配置";
        case "environment-key": return "已从环境变量读取";
        case "cli-key-available": return "CLI 配置中有密钥，可安全导入";
        case "unsupported": return "系统安全存储不可用";
        default: return "尚未配置 API 密钥";
    }
}

function hasDesktopCredential(state: CredentialState | undefined): boolean {
    return state === "secure-key" || state === "environment-key";
}

function credentialSetupMessage(state: CredentialState): string {
    if (state === "cli-key-available") return "检测到 CLI 配置中的密钥。请从设置页显式导入后再发送任务。";
    if (state === "unsupported") return "系统安全存储不可用，桌面端不会明文保存密钥。请配置系统环境变量后重启应用。";
    return "先配置模型连接和 API 密钥，再开始任务。";
}

function InlineText({ text }: { text: string }) {
    const parts = text.split(/(`[^`]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return <>{parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(part);
        if (link) {
            const href = safeExternalHref(link[2]);
            if (href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer" title="在默认浏览器打开外部链接"><InlineText text={link[1]} /></a>;
        }
        if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
        return <span key={index}>{part}</span>;
    })}</>;
}

function MessageBody({ text }: { text: string }) {
    const codeBlocks: string[] = [];
    const tokenized = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, language: string, code: string) => {
        codeBlocks.push(`${language}\n${code}`);
        return `\n\n§CODE${codeBlocks.length - 1}§\n\n`;
    });
    const blocks = tokenized.split(/\n{2,}/).filter((block) => block.trim());
    return <div className="message-body">{blocks.map((block, index) => {
        const codeToken = /^§CODE(\d+)§$/.exec(block.trim());
        if (codeToken) {
            const [language, ...code] = codeBlocks[Number(codeToken[1])].split("\n");
            return <pre className="code-block" key={index}>
                <div className="code-header"><span>{language || "code"}</span><CopyButton text={code.join("\n")} title="复制代码" textLabel="复制代码" /></div>
                <code>{code.join("\n")}</code>
            </pre>;
        }
        const lines = block.split("\n");
        if (lines.length >= 2) {
            const headers = splitTableCells(lines[0]);
            const separators = splitTableCells(lines[1]);
            const isSeparator = separators.length > 0
                && (lines[1].includes("|") || separators.length > 1)
                && separators.every((cell) => /^:?-{3,}:?$/.test(cell));
            if (isSeparator && headers.length === separators.length) {
                const alignments = separators.map(tableAlignment);
                const rows = lines.slice(2).filter((line) => line.trim()).map(splitTableCells);
                return <div className="message-table-wrap" key={index}><table className="message-table">
                    <thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex} style={{ textAlign: alignments[cellIndex] }}><InlineText text={cell} /></th>)}</tr></thead>
                    <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex} style={{ textAlign: alignments[cellIndex] }}><InlineText text={row[cellIndex] ?? ""} /></td>)}</tr>)}</tbody>
                </table></div>;
            }
        }
        const heading = /^(#{1,3})\s+(.+)$/.exec(lines[0]);
        if (heading && lines.length === 1) {
            const level = heading[1].length;
            if (level === 1) return <h3 key={index}><InlineText text={heading[2]} /></h3>;
            if (level === 2) return <h4 key={index}><InlineText text={heading[2]} /></h4>;
            return <h5 key={index}><InlineText text={heading[2]} /></h5>;
        }
        if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
            return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*[-*+]\s+/, "")} /></li>)}</ul>;
        }
        if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
            return <ol key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}><InlineText text={line.replace(/^\s*\d+[.)]\s+/, "")} /></li>)}</ol>;
        }
        return <p key={index}>{lines.map((line, lineIndex) => <span key={lineIndex}>{lineIndex > 0 && <br />}<InlineText text={line} /></span>)}</p>;
    })}</div>;
}

const MemoMessageBody = memo(MessageBody);

function Icon({ name, size = 16 }: { name: "plus" | "folder" | "settings" | "search" | "more" | "close" | "trash" | "copy" | "check" | "thumb-up" | "thumb-down" | "arrow" | "spark" | "chevron" | "branch" | "alert" | "panel-right"; size?: number }) {
    const paths: Record<string, ReactNode> = {
        plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
        folder: <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
        settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z" /></>,
        search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4" /></>,
        more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
        close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
        trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="m5 7 1 13h12l1-13" /><path d="M9 7V4h6v3" /></>,
        copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
        check: <path d="m5 12.5 4.7 4.7L19 7.5" />,
        "thumb-up": <><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /></>,
        "thumb-down": <><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" /></>,
        arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
        spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
        chevron: <path d="m9 18 6-6-6-6" />,
        branch: <><circle cx="7" cy="5" r="2" /><circle cx="17" cy="19" r="2" /><circle cx="17" cy="7" r="2" /><path d="M7 7v4a4 4 0 0 0 4 4h4a2 2 0 0 0 2-2V9" /><path d="M7 3v0" /></>,
        alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" /></>,
        "panel-right": <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>,
    };
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function CopyButton({ text, title, className, size = 13, textLabel }: { text: string; title: string; className?: string; size?: number; textLabel?: string }) {
    const [copied, setCopied] = useState(false);
    const resetTimer = useRef<number | null>(null);
    useEffect(() => () => {
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    }, []);
    const copy = async () => {
        try {
            await window.desktop.copyText(text);
        } catch {
            return;
        }
        setCopied(true);
        if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    };
    const classes = ["copy-button", className, copied ? "copied" : ""].filter(Boolean).join(" ");
    return <button type="button" className={classes} title={copied ? "已复制" : title} aria-label={title} onClick={() => void copy()}>
        {copied ? <Icon name="check" size={size} /> : <Icon name="copy" size={size} />}
        {textLabel != null && <span>{copied ? "已复制" : textLabel}</span>}
    </button>;
}

function MessageActions({ text, showFeedback }: { text: string; showFeedback: boolean }) {
    const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
    const toggle = (value: "up" | "down") => setFeedback((current) => (current === value ? null : value));
    return <div className="message-actions">
        <CopyButton text={text} title="复制消息" className="message-copy" />
        {showFeedback && <button type="button" className={`message-thumb${feedback === "up" ? " active-up" : ""}`} title="赞" aria-label="赞" aria-pressed={feedback === "up"} onClick={() => toggle("up")}><Icon name="thumb-up" size={13} /></button>}
        {showFeedback && <button type="button" className={`message-thumb${feedback === "down" ? " active-down" : ""}`} title="踩" aria-label="踩" aria-pressed={feedback === "down"} onClick={() => toggle("down")}><Icon name="thumb-down" size={13} /></button>}
    </div>;
}

function ActivityEditDiff({ activity }: { activity: SessionActivity }) {
    const edit = activity.fileEdit;
    const fileName = editFileName(activity);
    const stats = editLineStats(activity);
    const snippet = useMemo(() => edit ? [] : editResultSnippet(activity), [activity, edit]);
    const code = snippet.map((line) => line.text).join("\n");
    const highlighted = useMemo(() => highlightCodeLines(code, codeLanguage(fileName)), [code, fileName]);
    const copyText = edit?.diff || code;
    return <div className="activity-edit-diff">
        <div className="activity-edit-diff-heading">
            <span className="activity-edit-file" title={activityTarget(activity)}>{fileName}</span>
            {stats && <span className="activity-edit-stats"><span className="activity-edit-added">+{stats.added}</span> <span className="activity-edit-removed">-{stats.removed}</span></span>}
            {edit?.truncated && <span className="activity-edit-kind">已截断</span>}
            {copyText && <CopyButton text={copyText} title={edit ? "复制本次差异" : "复制代码片段"} className="activity-copy activity-edit-copy" size={14} />}
        </div>
        <div className="activity-edit-code">
            {edit?.diff ? <DiffViewer diff={edit.diff} compact filePath={edit.path} /> : snippet.length ? <div className="diff-viewer compact-diff" role="group" aria-label="编辑后的代码片段">
                {snippet.map((line, index) => <div className="diff-line context" key={index}>
                    <span className="diff-line-number">{line.number}</span>
                    <span className="diff-line-text"><span className="diff-code" dangerouslySetInnerHTML={{ __html: highlighted[index] }} /></span>
                </div>)}
            </div> : <div className="activity-edit-diff-note">{edit?.notice ?? (edit ? "本次调用未产生文本变化。" : "此记录未保存历史差异或代码片段。")}</div>}
        </div>
        {edit?.notice && edit.diff && <div className="activity-edit-diff-note">{edit.notice}</div>}
    </div>;
}

function ActivityOperationDetails({ activity }: { activity: SessionActivity }) {
    return <>
        <pre>{activity.detail}</pre>
        {activity.permissionSource && <div className="activity-policy"><span>策略来源</span><strong>{permissionSourceLabel(activity.permissionSource)}</strong>{activity.permissionDecision && <small>{permissionDecisionLabel(activity.permissionDecision)}</small>}</div>}
        {permissionOutcomeLabel(activity.permissionOutcome) && <div className="activity-policy outcome"><span>审批结果</span><strong>{permissionOutcomeLabel(activity.permissionOutcome)}</strong></div>}
        {activity.permissionGrantRevoked && <div className="activity-policy outcome"><span>授权状态</span><strong>已撤销，不再放行后续匹配操作</strong></div>}
        {activity.output && <div className="activity-output"><div className="activity-output-heading"><span>结果</span><CopyButton text={activity.output} title="复制当前结果" className="activity-copy" size={12} /></div><pre>{activity.output}</pre></div>}
    </>;
}

const ActivityGroup = memo(function ActivityGroup({ activities, running, focusId, onFocusHandled }: {
    activities: ActivityRow[];
    running: boolean;
    focusId: string | null;
    onFocusHandled: () => void;
}) {
    const [open, setOpen] = useState(true);
    const [showAll, setShowAll] = useState(false);
    const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(() => new Set());
    const groupRef = useRef<HTMLElement | null>(null);
    useEffect(() => {
        if (!focusId || !activities.some((activity) => activity.id === focusId)) return;
        setOpen(true);
        setShowAll(true);
        const frame = requestAnimationFrame(() => {
            const row = [...(groupRef.current?.querySelectorAll<HTMLDetailsElement>("[data-activity-id]") ?? [])]
                .find((item) => item.dataset.activityId === focusId);
            if (row) {
                row.open = true;
                row.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            onFocusHandled();
        });
        return () => cancelAnimationFrame(frame);
    }, [focusId, activities, onFocusHandled]);
    const failed = activities.some((activity) => activity.state === "failed" || activity.state === "denied");
    const visibleActivities = showAll ? activities : activities.slice(-3);
    return <section className="chat-activity-group" ref={groupRef}>
        <button type="button" className="chat-activity-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            <span className={`chat-activity-mark ${running ? "running" : failed ? "failed" : "complete"}`} aria-hidden="true">{running ? "" : failed ? "!" : "✓"}</span>
            <span className="chat-activity-count">{activities.length} 项操作</span><Icon name="chevron" size={13} />
        </button>
        {open && <div className="chat-activity-items">{visibleActivities.map((activity) => {
            const stats = editLineStats(activity);
            const isEdit = activity.title === "edit_file" || activity.title === "multi_edit";
            return <details className={`activity-row ${activity.state}`} key={activity.id} data-activity-id={activity.id} onToggle={(event) => {
                const expanded = event.currentTarget.open;
                setExpandedActivityIds((current) => {
                    if (expanded) return new Set(current).add(activity.id);
                    if (!current.has(activity.id)) return current;
                    const next = new Set(current);
                    next.delete(activity.id);
                    return next;
                });
            }}>
            <summary>
                <span className="activity-state-mark">{activity.state === "complete" ? "✓" : activity.state === "denied" || activity.state === "failed" ? "×" : activity.state === "interrupted" ? "!" : activity.state === "running" ? <i /> : "·"}</span>
                <span className="activity-title" title={activityLine(activity)}>{isEdit ? `${activity.state === "complete" ? "已编辑" : "编辑"} ${editFileName(activity)}` : activityTarget(activity)}</span>
                {stats && !expandedActivityIds.has(activity.id) && <span className="activity-edit-stats"><span className="activity-edit-added">+{stats.added}</span>/<span className="activity-edit-removed">-{stats.removed}</span></span>}
                <span className={`activity-state-label ${activity.state}`}>{activity.state === "complete" ? "已完成" : activity.state === "denied" ? "已拒绝" : activity.state === "failed" ? "失败" : activity.state === "interrupted" ? "已取消" : activity.state === "running" ? "运行中" : "提示"}</span>
                {activity.updatedAt && <time className="activity-time" dateTime={activity.updatedAt}>{activityTime(activity.updatedAt)}</time>}
                {activity.durationMs !== undefined && <span className="activity-duration">{activity.durationMs < 1000 ? `${activity.durationMs}ms` : `${(activity.durationMs / 1000).toFixed(1)}s`}</span>}
            </summary>
            <div className="activity-detail">
                {isEdit && (activity.state === "complete" || activity.fileEdit) && expandedActivityIds.has(activity.id) && <ActivityEditDiff activity={activity} />}
                {isEdit ? <details className="activity-technical-details"><summary>调用详情</summary><ActivityOperationDetails activity={activity} /></details> : <ActivityOperationDetails activity={activity} />}
            </div>
        </details>;
        })}{activities.length > 3 && <button type="button" className="chat-activity-more" onClick={() => setShowAll((current) => !current)}>{showAll ? "只看最近 3 项" : `查看其余 ${activities.length - 3} 项`}</button>}</div>}
    </section>;
});

function ContextRing({ utilization }: { utilization: number | null }) {
    const circumference = 2 * Math.PI * 9;
    const value = utilization === null ? 0 : Math.min(1, Math.max(0, utilization));
    return <svg className="context-ring" width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="9" strokeWidth="2.5" />
        <circle className="context-ring-arc" cx="12" cy="12" r="9" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(circumference * value).toFixed(2)} ${circumference.toFixed(2)}`} transform="rotate(-90 12 12)" />
    </svg>;
}

type PendingDialog =
    | { kind: "confirm"; message: string; confirmLabel: string; danger: boolean; resolve: (accepted: boolean) => void }
    | { kind: "prompt"; message: string; value: string; resolve: (value: string | null) => void };

function GitBranchDialog({ workspace, managed, onClose, onChanged, onOpenGraph }: {
    workspace: WorkspaceSummary;
    managed: boolean;
    onClose: (restoreFocus?: boolean) => void;
    onChanged: () => Promise<void>;
    onOpenGraph: (history: GitHistory) => void;
}) {
    const [history, setHistory] = useState<GitHistory | null>(null);
    const [search, setSearch] = useState("");
    const [newBranch, setNewBranch] = useState("codex/");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const dialog = useRef<HTMLElement | null>(null);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            setHistory(await window.desktop.getGitHistory(workspace.id));
            setError("");
        } catch (failure) { setError(displayError(failure)); }
        finally { setLoading(false); }
    }, [workspace.id]);

    useEffect(() => {
        dialog.current?.querySelector<HTMLInputElement>(".git-branch-search")?.focus();
        void reload();
    }, [reload]);

    useEffect(() => {
        const closeOnOutside = (event: PointerEvent): void => {
            if (event.target instanceof Node && !dialog.current?.parentElement?.contains(event.target) && !busy) onClose();
        };
        const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
            if (event.key === "Escape" && !busy) {
                event.stopPropagation();
                onClose(true);
            }
        };
        document.addEventListener("pointerdown", closeOnOutside);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutside);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [busy, onClose]);

    const changeBranch = async (branch: string | null) => {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            if (branch === null) await window.desktop.createGitBranch(workspace.id, newBranch.trim());
            else await window.desktop.switchGitBranch(workspace.id, branch);
            await onChanged();
            await reload();
            if (branch === null) setNewBranch("codex/");
        } catch (failure) { setError(displayError(failure)); }
        finally { setBusy(false); }
    };

    const visibleBranches = history?.branches.filter((branch) => branch.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
    return <section ref={dialog} id="git-branch-popover" className="git-history-dialog" role="dialog" aria-labelledby="git-history-title">
            <div className="git-history-head"><div><small>GIT</small><h2 id="git-history-title">分支</h2><p>{workspace.name} · {history?.currentBranch ?? workspace.branch ?? "无当前分支"}</p></div><div><button type="button" onClick={() => void reload()} disabled={loading || busy}>刷新</button><button type="button" onClick={() => onClose(true)} disabled={busy} aria-label="关闭分支窗口">×</button></div></div>
            {error && <div className="task-center-error" role="alert">{error}</div>}
            <section className="git-branch-section" aria-label="本地分支"><div className="git-history-section-title"><h3>切换分支</h3><span>{history?.branches.length ?? 0} 个本地分支</span></div>
                <input className="git-branch-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索本地分支" aria-label="搜索本地分支" />
                <div className="git-branch-list">{loading && <span className="git-history-empty">正在读取 Git 历史...</span>}{visibleBranches.map((branch) => <button className={branch === history?.currentBranch ? "current" : ""} key={branch} type="button" disabled={busy || managed || history?.dirty || branch === history?.currentBranch} onClick={() => void changeBranch(branch)}><Icon name="branch" size={14} /><span>{branch}</span>{branch === history?.currentBranch && <strong>当前</strong>}</button>)}{!loading && visibleBranches.length === 0 && <span className="git-history-empty">没有匹配的本地分支</span>}</div>
                {history?.dirty && <p className="git-history-note">工作区有未提交改动；请先提交或清理，再切换已有分支。新建分支会保留这些改动。</p>}
                {managed && <p className="git-history-note">此隔离工作区的分支用于审阅和合并，不能在这里切换或新建分支。</p>}
            </section>
            <form className="git-create-branch" onSubmit={(event) => { event.preventDefault(); void changeBranch(null); }}><label htmlFor="git-new-branch">新建分支</label><input id="git-new-branch" value={newBranch} onChange={(event) => setNewBranch(event.target.value)} maxLength={120} placeholder="codex/new-feature" disabled={busy || managed} /><button type="submit" disabled={busy || managed || !newBranch.trim() || newBranch.trim() === "codex/"}>创建并切换</button></form>
            <button className="git-graph-open" type="button" disabled={!history || busy} onClick={() => { if (history) onOpenGraph(history); }}><span><strong>Git Graph</strong><small>在大窗口查看最近 {history?.commits.length ?? 0} 条提交</small></span><Icon name="chevron" size={16} /></button>
    </section>;
}

const GIT_GRAPH_COLORS = ["light-dark(#0969da, #20a7f5)", "light-dark(#a50072, #f222af)", "light-dark(#1f883d, #3fb950)", "light-dark(#8250df, #b78cff)", "light-dark(#bf8700, #d29922)"];

function GitGraphDialog({ workspace, initialHistory, onClose }: {
    workspace: WorkspaceSummary;
    initialHistory: GitHistory;
    onClose: () => void;
}) {
    const [history, setHistory] = useState(initialHistory);
    const [detail, setDetail] = useState<GitCommitDetail | null>(null);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    const [error, setError] = useState("");
    const dialog = useRef<HTMLElement | null>(null);
    const detailRequest = useRef(0);
    const graph = useMemo(() => layoutGitGraph(history.commits), [history.commits]);
    const graphWidth = Math.max(70, graph.width);

    useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>(".git-graph-close")?.focus(); }, []);

    const reload = async () => {
        setLoading(true);
        setError("");
        try {
            setHistory(await window.desktop.getGitHistory(workspace.id));
            detailRequest.current += 1;
            setDetail(null);
            setSelectedHash(null);
            setDetailLoading(false);
        } catch (failure) { setError(displayError(failure)); }
        finally { setLoading(false); }
    };

    const loadDetail = async (hash: string) => {
        const request = ++detailRequest.current;
        setSelectedHash(hash);
        setDetail(null);
        setDetailLoading(true);
        setError("");
        try {
            const result = await window.desktop.getGitCommitDetail(workspace.id, hash);
            if (request === detailRequest.current) setDetail(result);
        } catch (failure) { if (request === detailRequest.current) setError(displayError(failure)); }
        finally { if (request === detailRequest.current) setDetailLoading(false); }
    };

    return <div className="modal-scrim git-graph-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section ref={dialog} className="git-graph-dialog" role="dialog" aria-modal="true" aria-labelledby="git-graph-title" tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
                if (event.key !== "Tab") return;
                const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
                const first = focusable[0];
                const last = focusable.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
            <div className="git-graph-dialog-head"><div><small>GIT HISTORY</small><h2 id="git-graph-title">Git Graph</h2><p>{workspace.name} · {history.currentBranch ?? "无当前分支"} · 最近 {history.commits.length} 条</p></div><div><button type="button" onClick={() => void reload()} disabled={loading}>刷新</button><button className="git-graph-close" type="button" onClick={onClose} aria-label="关闭 Git Graph">×</button></div></div>
            {error && <div className="task-center-error" role="alert">{error}</div>}
            <div className={`git-graph-dialog-body ${selectedHash ? "with-detail" : ""}`}><div className="git-graph-list" style={{ "--git-graph-width": `${graphWidth}px` } as CSSProperties}><div className="git-graph-columns"><span>Graph</span><span>提交</span><span>日期</span><span>作者</span><span>Hash</span></div>
                <div className="git-graph-rows"><svg className="git-graph-lines" width={graphWidth} height={graph.height} viewBox={`0 0 ${graphWidth} ${graph.height}`} aria-hidden="true">{graph.edges.map((edge) => <path key={`${edge.child}-${edge.parent}`} d={edge.path} fill="none" stroke={GIT_GRAPH_COLORS[edge.color % GIT_GRAPH_COLORS.length]} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />)}{graph.nodes.map((node) => <circle key={node.hash} cx={node.x} cy={node.y} r="4.2" fill={history.commits[node.row].decorations.includes("HEAD ->") ? "var(--surface)" : GIT_GRAPH_COLORS[node.color % GIT_GRAPH_COLORS.length]} stroke={GIT_GRAPH_COLORS[node.color % GIT_GRAPH_COLORS.length]} strokeWidth="2" />)}</svg>
                {history.commits.map((commit) => <button className={`git-graph-row ${selectedHash === commit.hash ? "selected" : ""}`} aria-pressed={selectedHash === commit.hash} key={commit.hash} type="button" onClick={() => void loadDetail(commit.hash)}><span aria-hidden="true" /><span className="git-graph-subject" title={commit.subject}>{commit.decorations && <em className={commit.decorations.includes("HEAD ->") ? "current" : ""}>{commit.decorations}</em>}{commit.subject}</span><time>{new Date(commit.authoredAt).toLocaleDateString("zh-CN")}</time><span className="git-graph-author">{commit.author}</span><code>{commit.hash.slice(0, 8)}</code></button>)}</div>
                {history.commits.length === 0 && <div className="git-history-empty">还没有可显示的提交记录。</div>}
            </div>{selectedHash && <aside className="git-commit-detail" aria-label="提交详情"><button className="git-commit-detail-close" type="button" onClick={() => { detailRequest.current += 1; setSelectedHash(null); setDetail(null); setDetailLoading(false); }}>关闭详情</button>{detailLoading ? <p>正在读取提交详情...</p> : detail ? <><strong>{detail.message.split("\n")[0]}</strong><code>{detail.hash}</code><p>{detail.author} &lt;{detail.authorEmail}&gt;</p><time>{new Date(detail.authoredAt).toLocaleString("zh-CN")}</time>{detail.parents.length > 0 && <small>父提交：{detail.parents.map((parent) => parent.slice(0, 8)).join(", ")}</small>}<pre>{detail.message}</pre><pre>{detail.stats}{detail.statsTruncated ? "\n...文件统计已截断" : ""}</pre></> : null}</aside>}</div>
        </section>
    </div>;
}

export function App() {
    const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
    const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceSummary | null>(null);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
    const [sessionRoute, setSessionRoute] = useState<OpenSessionData["route"] | null>(null);
    const [effortChoice, setEffortChoice] = useState("high");
    const [sessionCredentialState, setSessionCredentialState] = useState<CredentialState | null>(null);
    const [messages, setMessages] = useState<ConversationMessage[]>([]);
    const [messageCursor, setMessageCursor] = useState<number | null>(null);
    const [olderLoading, setOlderLoading] = useState(false);
    const [activities, setActivities] = useState<ActivityRow[]>([]);
    const [tokenUsage, setTokenUsage] = useState<AgentUsage | null>(null);
    const [contextUsage, setContextUsage] = useState<AgentContextUsage | null>(null);
    const [approvals, setApprovals] = useState<PendingPermissionRequest[]>([]);
    const [permissionGrants, setPermissionGrants] = useState<SessionPermissionGrantSummary[]>([]);
    const [questions, setQuestions] = useState<PendingUserQuestion[]>([]);
    const [questionDraft, setQuestionDraft] = useState("");
    const [draft, setDraft] = useState("");
    const [attachmentDragOver, setAttachmentDragOver] = useState(false);
    const [modelPickerOpen, setModelPickerOpen] = useState(false);
    const [permissionPickerOpen, setPermissionPickerOpen] = useState(false);
    const [contextPickerOpen, setContextPickerOpen] = useState(false);
    const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
    const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
    const [retryNotice, setRetryNotice] = useState("");
    const [search, setSearch] = useState("");
    const [gitView, setGitView] = useState<{ workspaceId: string; snapshot: GitSnapshot } | null>(null);
    const [reviewView, setReviewView] = useState<{ workspaceId: string; sessionId: string; snapshot: CodeReviewSnapshot } | null>(null);
    const [gitLoading, setGitLoading] = useState(false);
    const [reviewLoading, setReviewLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [externalRun, setExternalRun] = useState(false);
    const [runId, setRunId] = useState<string | null>(null);
    const [statusLabel, setStatusLabel] = useState("就绪");
    const [permissionMode, setPermissionMode] = useState<OpenSessionData["permissionMode"]>("desktopDefault");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
    const [worktreeManagerOpen, setWorktreeManagerOpen] = useState(false);
    const [gitHistoryOpen, setGitHistoryOpen] = useState(false);
    const [gitGraphHistory, setGitGraphHistory] = useState<{ workspaceId: string; history: GitHistory } | null>(null);
    const gitBranchButtonRef = useRef<HTMLButtonElement | null>(null);
    const [terminalOpen, setTerminalOpen] = useState(false);
    const [terminalMounted, setTerminalMounted] = useState(false);
    const [terminalHeight, setTerminalHeight] = useState(defaultTerminalHeight);
    const [terminalWorkspaceId, setTerminalWorkspaceId] = useState<string | null>(null);
    const [rightPanel, setRightPanel] = useState<"details" | "changes">("changes");
    const [taskCenterOpen, setTaskCenterOpen] = useState(false);
    const [taskCenterData, setTaskCenterData] = useState<DesktopTaskCenterData | null>(null);
    const [taskCenterLoading, setTaskCenterLoading] = useState(false);
    const [taskCenterError, setTaskCenterError] = useState("");
    const [activityFocusId, setActivityFocusId] = useState<string | null>(null);
    const [worktreeAssociation, setWorktreeAssociation] = useState<WorktreeAssociation | null>(null);
    const [error, setError] = useState("");
    const [starting, setStarting] = useState(true);
    const { attachments, pending: attachmentPending, restore: setAttachments, clear: clearAttachments,
        addFiles: addAttachmentFiles, choose: chooseAttachments, paste: pasteAttachments, remove: removeAttachment } = useAttachmentDraft(activeWorkspace?.id ?? null, activeSession?.id ?? null, setError);
    const [panelWidths, setPanelWidths] = useState(readPanelWidths);
    const [inspectorOpen, setInspectorOpen] = useState(readInspectorOpen);
    const [theme, setTheme] = useState<AppTheme>(readThemePreference);
    const [fontScale, setFontScale] = useState(readFontScale);
    const [quickSettingsSaving, setQuickSettingsSaving] = useState(false);
    const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
    const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
    const commandModifier = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
    const appShellRef = useRef<HTMLDivElement | null>(null);
    const terminalCloseTimer = useRef<number | null>(null);
    const resizingPanel = useRef<{ panel: "sidebar" | "inspector"; pointerId: number; widths: PanelWidths; next: PanelWidths } | null>(null);
    const conversationRef = useRef<HTMLDivElement | null>(null);
    const historyRequestSequence = useRef(0);
    const olderRequestPending = useRef(false);
    const recentRequestPending = useRef(false);
    const stickToBottom = useRef(true);
    const lastConversationScrollTop = useRef(0);
    const historyCompacted = useRef(false);
    const scrollAnchor = useRef<{ id: string; top: number } | null>(null);
    const pendingLatestScroll = useRef<string | null>(null);
    const composerInput = useRef<HTMLTextAreaElement | null>(null);
    const [composerDock, setComposerDock] = useState<HTMLDivElement | null>(null);
    const [composerSpace, setComposerSpace] = useState(0);
    useEffect(() => {
        if (!composerDock) return;
        const observer = new ResizeObserver(() => setComposerSpace(composerDock.offsetHeight));
        observer.observe(composerDock);
        return () => observer.disconnect();
    }, [composerDock]);
    const activeRef = useRef({ workspaceId: "", sessionId: "" });
    const eventTracker = useMemo(() => new DesktopRunEventTracker(), []);
    const pendingStartStops = useRef(new Set<string>());
    const pendingSubmissions = useRef(new Map<string, { requestId: string; message: ConversationMessage; interrupt: boolean; shown: boolean; stopped: boolean }>());
    const [sendingSessions, setSendingSessions] = useState<string[]>([]);
    const submitting = sendingSessions.includes(`${activeWorkspace?.id}:${activeSession?.id}`);
    const visibleSubmission = pendingSubmissions.current.get(`${activeWorkspace?.id}:${activeSession?.id}`);
    const workingStatus = submitting ? visibleSubmission?.stopped ? "正在停止..."
        : visibleSubmission?.interrupt ? "正在中断并继续..." : "正在启动任务" : statusLabel;
    const gitRequestSequence = useRef(0);
    const reviewRequestSequence = useRef(0);
    const taskRequestSequence = useRef(0);
    const worktreeRequestSequence = useRef(0);
    const pendingAssistantDelta = useRef<{ key: string; messageId: string; text: string } | null>(null);
    const assistantDeltaFrame = useRef<number | null>(null);
    const assistantSegment = useRef<{ runId: string; index: number } | null>(null);

    const invalidateMessageRequests = useCallback(() => {
        historyRequestSequence.current++;
        olderRequestPending.current = false;
        recentRequestPending.current = false;
        setOlderLoading(false);
    }, []);

    const resetMessageHistory = useCallback((cursor: number | null) => {
        invalidateMessageRequests();
        stickToBottom.current = true;
        lastConversationScrollTop.current = 0;
        historyCompacted.current = false;
        scrollAnchor.current = null;
        setMessageCursor(cursor);
    }, [invalidateMessageRequests]);

    const flushAssistantDelta = useCallback(() => {
        if (assistantDeltaFrame.current !== null) window.cancelAnimationFrame(assistantDeltaFrame.current);
        assistantDeltaFrame.current = null;
        const pending = pendingAssistantDelta.current;
        pendingAssistantDelta.current = null;
        if (!pending || `${activeRef.current.workspaceId}:${activeRef.current.sessionId}` !== pending.key) return;
        setMessages((current) => {
            const id = pending.messageId;
            const index = current.findIndex((message) => message.id === id);
            if (index < 0) return [...current, { id, role: "assistant", text: pending.text }];
            const next = [...current];
            next[index] = { ...next[index], text: next[index].text + pending.text };
            return next;
        });
    }, []);

    useEffect(() => () => {
        if (assistantDeltaFrame.current !== null) window.cancelAnimationFrame(assistantDeltaFrame.current);
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            try { window.localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify({ ...panelWidths, theme, fontScale, inspectorOpen })); }
            catch { /* panel width preferences are optional */ }
        }, 180);
        return () => window.clearTimeout(timer);
    }, [panelWidths, theme, fontScale, inspectorOpen]);

    const confirmInApp = useCallback((message: string, confirmLabel = "确定", danger = false): Promise<boolean> => {
        return new Promise((resolve) => { setPendingDialog({ kind: "confirm", message, confirmLabel, danger, resolve }); });
    }, []);

    const promptInApp = useCallback((message: string, value: string): Promise<string | null> => {
        return new Promise((resolve) => { setPendingDialog({ kind: "prompt", message, value, resolve }); });
    }, []);

    useEffect(() => {
        if (typeof window.desktop.onDialogRequest !== "function") return;
        return window.desktop.onDialogRequest((request) => {
            void confirmInApp(request.message, request.confirmLabel, request.danger).then((accepted) => {
                void window.desktop.respondDialog(request.id, accepted).catch(() => undefined);
            });
        });
    }, [confirmInApp]);

    useEffect(() => {
        if (!pendingDialog) return;
        const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            if (pendingDialog.kind === "confirm") pendingDialog.resolve(false);
            else pendingDialog.resolve(null);
            setPendingDialog(null);
        };
        document.addEventListener("keydown", closeOnEscape);
        return () => document.removeEventListener("keydown", closeOnEscape);
    }, [pendingDialog]);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty("--font-scale", String(fontScale));
        if (typeof window.desktop.setTitleBarOverlay === "function") {
            void window.desktop.setTitleBarOverlay(resolvedTheme).catch(() => undefined);
        }
    }, [theme, fontScale, resolvedTheme]);

    useEffect(() => {
        if (sessionRoute) setEffortChoice(sessionRoute.effort);
    }, [sessionRoute]);

    useEffect(() => {
        const preference = window.matchMedia("(prefers-color-scheme: dark)");
        const update = (): void => setSystemDark(preference.matches);
        preference.addEventListener("change", update);
        return () => preference.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        const resize = (): void => setPanelWidths((current) => fitPanelWidths(current, window.innerWidth));
        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, []);

    const resizePanelAt = (panel: "sidebar" | "inspector", clientX: number): void => {
        const drag = resizingPanel.current;
        const bounds = appShellRef.current?.getBoundingClientRect();
        if (!drag || !bounds) return;
        drag.next = fitPanelWidths({
            ...drag.widths,
            [panel]: panel === "sidebar" ? clientX - bounds.left : bounds.right - clientX,
        }, bounds.width);
        appShellRef.current?.style.setProperty("--sidebar-width", `${drag.next.sidebar}px`);
        appShellRef.current?.style.setProperty("--inspector-width", `${drag.next.inspector}px`);
    };

    const startPanelResize = (panel: "sidebar" | "inspector", event: ReactPointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) return;
        event.preventDefault();
        resizingPanel.current = { panel, pointerId: event.pointerId, widths: panelWidths, next: panelWidths };
        appShellRef.current?.classList.add("resizing-panels");
        document.body.classList.add("panel-resizing");
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const movePanelResize = (panel: "sidebar" | "inspector", event: ReactPointerEvent<HTMLDivElement>): void => {
        if (resizingPanel.current?.panel !== panel || resizingPanel.current.pointerId !== event.pointerId) return;
        resizePanelAt(panel, event.clientX);
        event.currentTarget.setAttribute("aria-valuenow", String(resizingPanel.current.next[panel]));
    };

    const finishPanelResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
        const drag = resizingPanel.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        resizingPanel.current = null;
        setPanelWidths(drag.next);
        appShellRef.current?.classList.remove("resizing-panels");
        document.body.classList.remove("panel-resizing");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const resizePanelFromKeyboard = (panel: "sidebar" | "inspector", event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 12 : -12;
        setPanelWidths((current) => fitPanelWidths({
            ...current,
            [panel]: current[panel] + (panel === "sidebar" ? delta : -delta),
        }, appShellRef.current?.getBoundingClientRect().width ?? window.innerWidth));
    };

    const selectRightPanel = (panel: "details" | "changes"): void => {
        setRightPanel(panel);
        setInspectorOpen(true);
        if (panel === "changes" && activeWorkspace?.available) {
            void refreshGitSnapshot(activeWorkspace.id);
            if (activeSession) void refreshCodeReview(activeWorkspace.id, activeSession.id);
        }
    };

    const refreshTaskCenter = useCallback(async () => {
        const request = ++taskRequestSequence.current;
        setTaskCenterLoading(true);
        try {
            const data = await window.desktop.listTasks();
            if (request !== taskRequestSequence.current) return;
            setTaskCenterData(data);
            setTaskCenterError("");
        } catch (failure) {
            if (request === taskRequestSequence.current) setTaskCenterError(displayError(failure));
        } finally {
            if (request === taskRequestSequence.current) setTaskCenterLoading(false);
        }
    }, []);

    const refreshSessions = useCallback(async (workspaceId: string) => {
        const next = await window.desktop.listSessions(workspaceId);
        if (activeRef.current.workspaceId === workspaceId) {
            setSessions(next);
            setActiveSession((current) => current ? next.find((session) => session.id === current.id) ?? current : null);
        }
        return next;
    }, []);

    const refreshPermissionGrants = useCallback(async (workspaceId: string, sessionId: string) => {
        try {
            const grants = await window.desktop.listPermissionGrants(workspaceId, sessionId);
            if (activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setPermissionGrants(grants);
            }
        } catch (failure) {
            if (activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setError(displayError(failure));
            }
        }
    }, []);

    const refreshGitSnapshot = useCallback(async (workspaceId: string) => {
        if (activeRef.current.workspaceId !== workspaceId) return;
        const request = ++gitRequestSequence.current;
        setGitLoading(true);
        try {
            const snapshot = await window.desktop.getGitSnapshot(workspaceId);
            if (request !== gitRequestSequence.current || activeRef.current.workspaceId !== workspaceId) return;
            setGitView({ workspaceId, snapshot });
            if (!snapshot.error) {
                const branch = snapshot.isGit ? snapshot.branch : null;
                setActiveWorkspace((current) => current?.id === workspaceId ? { ...current, branch } : current);
                setBootstrap((current) => current ? {
                    ...current,
                    workspaces: current.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, branch } : workspace),
                } : current);
            }
        } catch (failure) {
            if (request === gitRequestSequence.current && activeRef.current.workspaceId === workspaceId) {
                setGitView({ workspaceId, snapshot: { isGit: false, branch: null, files: [], error: displayError(failure) } });
            }
        } finally {
            if (request === gitRequestSequence.current && activeRef.current.workspaceId === workspaceId) setGitLoading(false);
        }
    }, []);

    const refreshCodeReview = useCallback(async (workspaceId: string, sessionId: string) => {
        if (activeRef.current.workspaceId !== workspaceId || activeRef.current.sessionId !== sessionId) return;
        const request = ++reviewRequestSequence.current;
        setReviewLoading(true);
        try {
            const review = await window.desktop.getCodeReview(workspaceId, sessionId);
            if (request === reviewRequestSequence.current
                && activeRef.current.workspaceId === workspaceId
                && activeRef.current.sessionId === sessionId) {
                setReviewView({ workspaceId, sessionId, snapshot: review });
            }
        } catch {
            if (request === reviewRequestSequence.current
                && activeRef.current.workspaceId === workspaceId
                && activeRef.current.sessionId === sessionId) {
                setReviewView(null);
            }
        } finally {
            if (request === reviewRequestSequence.current
                && activeRef.current.workspaceId === workspaceId
                && activeRef.current.sessionId === sessionId) setReviewLoading(false);
        }
    }, []);

    const openSession = useCallback(async (workspaceId: string, sessionId: string) => {
        const opened = await window.desktop.openSession(workspaceId, sessionId);
        const routeCredentialState = await window.desktop.getCredentialState(opened.route.modelPreset);
        const key = `${workspaceId}:${sessionId}`;
        eventTracker.openSession(key, opened.eventSequence, opened.runId);
        if (assistantDeltaFrame.current !== null) window.cancelAnimationFrame(assistantDeltaFrame.current);
        assistantDeltaFrame.current = null;
        pendingAssistantDelta.current = null;
        const lastUser = opened.messages.map((message) => message.role).lastIndexOf("user");
        const completedSegments = opened.messages.slice(lastUser + 1)
            .filter((message) => message.role === "assistant" && /^history-\d+$/.test(message.id)).length;
        assistantSegment.current = opened.runId ? { runId: opened.runId, index: completedSegments } : null;
        resetMessageHistory(opened.messageCursor);
        activeRef.current = { workspaceId, sessionId };
        pendingLatestScroll.current = key;
        setActiveSession(opened.session);
        setSessionRoute(opened.route);
        setSessionCredentialState(routeCredentialState);
        setSessions((current) => current.some((item) => item.id === opened.session.id)
            ? current.map((item) => item.id === opened.session.id ? opened.session : item)
            : [opened.session, ...current]);
        setMessages(opened.messages);
        setRetryNotice("");
        setActivities(opened.activities);
        setPermissionGrants(opened.permissionGrants);
        setTokenUsage(opened.usage);
        setContextUsage(opened.contextUsage);
        setApprovals(opened.approvals);
        setQuestions(opened.questions);
        setQuestionDraft("");
        setRunId(opened.runId);
        setExternalRun(opened.externalRun);
        setBusy(Boolean(opened.runId));
        setPermissionMode(opened.permissionMode);
        setStatusLabel(opened.externalRun ? "其他进程正在运行"
            : opened.approvals.length > 0 ? "等待权限确认"
            : opened.questions.length > 0 ? "等待你的回答"
                : opened.session.status === "interrupted" ? "上次运行意外中断"
            : opened.session.status === "cancelled" ? "上次任务已停止"
                : opened.session.status === "failed" ? "上次请求失败"
                    : opened.session.status === "running" ? "任务运行中" : "就绪");
        setError("");
        void refreshCodeReview(workspaceId, sessionId);
    }, [eventTracker, refreshCodeReview, resetMessageHistory]);

    const loadOlderMessages = useCallback(async () => {
        const before = messageCursor;
        const { workspaceId, sessionId } = activeRef.current;
        if (before === null || olderRequestPending.current || recentRequestPending.current || !workspaceId || !sessionId) return;
        const request = ++historyRequestSequence.current;
        olderRequestPending.current = true;
        setOlderLoading(true);
        try {
            const page = await window.desktop.getEarlierMessages(workspaceId, sessionId, before);
            if (request !== historyRequestSequence.current
                || activeRef.current.workspaceId !== workspaceId || activeRef.current.sessionId !== sessionId) return;
            if (page.messages.length) {
                const first = conversationRef.current?.querySelector<HTMLElement>("[data-message-id]");
                scrollAnchor.current = first?.dataset.messageId
                    ? { id: first.dataset.messageId, top: first.getBoundingClientRect().top } : null;
                setMessages((current) => {
                    const existing = new Set(current.map((message) => message.id));
                    return [...page.messages.filter((message) => !existing.has(message.id)), ...current];
                });
            }
            setMessageCursor(page.nextCursor);
        } catch (failure) {
            if (request === historyRequestSequence.current) setError(displayError(failure));
        } finally {
            if (request === historyRequestSequence.current) {
                olderRequestPending.current = false;
                setOlderLoading(false);
            }
        }
    }, [messageCursor]);

    const refreshRecentMessages = useCallback(async () => {
        const { workspaceId, sessionId } = activeRef.current;
        if (!workspaceId || !sessionId || recentRequestPending.current || olderRequestPending.current) return;
        const request = ++historyRequestSequence.current;
        recentRequestPending.current = true;
        try {
            const page = await window.desktop.getEarlierMessages(workspaceId, sessionId, Number.MAX_SAFE_INTEGER);
            if (request !== historyRequestSequence.current || !stickToBottom.current
                || activeRef.current.workspaceId !== workspaceId || activeRef.current.sessionId !== sessionId) return;
            historyCompacted.current = false;
            setMessages(page.messages);
            setMessageCursor(page.nextCursor);
        } catch (failure) {
            if (request === historyRequestSequence.current) setError(displayError(failure));
        } finally {
            if (request === historyRequestSequence.current) recentRequestPending.current = false;
        }
    }, []);

    const changeSessionRoute = async (modelPreset: string | null, effort: string) => {
        if (!activeWorkspace || !activeSession || !sessionRoute || busy || submitting || externalRun || quickSettingsSaving) return;
        setQuickSettingsSaving(true);
        try {
            await window.desktop.updateSessionRoute(activeWorkspace.id, activeSession.id, modelPreset, effort);
            await openSession(activeWorkspace.id, activeSession.id);
        } catch (failure) { setError(displayError(failure)); }
        finally { setQuickSettingsSaving(false); }
    };

    const openWorkspace = useCallback(async (workspace: WorkspaceSummary, activate = true, preferredSessionId?: string) => {
        try {
            const selected = activate ? await window.desktop.activateWorkspace(workspace.id) : workspace;
            const wasCurrent = activeRef.current.workspaceId === selected.id;
            setActiveWorkspace(selected);
            activeRef.current = { workspaceId: selected.id, sessionId: "" };
            resetMessageHistory(null);
            setBusy(false);
            setExternalRun(false);
            setRunId(null);
            setPermissionMode("desktopDefault");
            reviewRequestSequence.current += 1;
            setReviewView(null);
            setReviewLoading(false);
            setActiveSession(null);
            setSessionRoute(null);
            setSessionCredentialState(null);
            setRetryNotice("");
            setMessages([]);
            clearAttachments();
            setActivities([]);
            setPermissionGrants([]);
            setTokenUsage(null);
            setContextUsage(null);
            setApprovals([]);
            setQuestions([]);
            setQuestionDraft("");
            if (!selected.available) {
                gitRequestSequence.current += 1;
                reviewRequestSequence.current += 1;
                setSessions([]);
                setGitView(null);
                setReviewView(null);
                setGitLoading(false);
                setReviewLoading(false);
                setError(`项目目录不可访问：${selected.path}`);
                return;
            }
            if (wasCurrent) void refreshGitSnapshot(selected.id);
            setError("");
            const list = await refreshSessions(selected.id);
            const nextSession = preferredSessionId ? list.find((session) => session.id === preferredSessionId) : list[0];
            if (preferredSessionId && !nextSession) {
                setError("这个任务已不存在或无法访问，请刷新任务中心后重试。");
                return;
            }
            if (nextSession) await openSession(selected.id, nextSession.id);
            const next = await window.desktop.getBootstrap();
            setBootstrap(next);
        } catch (failure) {
            setError(displayError(failure));
        }
    }, [openSession, refreshGitSnapshot, refreshSessions, resetMessageHistory]);

    const openTask = useCallback(async (task: DesktopTaskSummary) => {
        setTaskCenterOpen(false);
        setActivityFocusId(null);
        await openWorkspace(task.workspace, true, task.session.id);
        if (activeRef.current.workspaceId !== task.workspace.id || activeRef.current.sessionId !== task.session.id) return;
        setActivityFocusId(task.latestActivityId);
    }, [openWorkspace]);

    const stopTask = useCallback(async (runIdToStop: string) => {
        await window.desktop.cancelRun(runIdToStop);
    }, []);

    const refreshExternalSession = async () => {
        if (!activeWorkspace || !activeSession) return;
        try {
            await openSession(activeWorkspace.id, activeSession.id);
            await refreshSessions(activeWorkspace.id);
        } catch (failure) {
            setError(displayError(failure));
        }
    };

    useEffect(() => {
        let live = true;
        void window.desktop.getBootstrap().then(async (data) => {
            if (!live) return;
            setBootstrap(data);
            const selected = data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId);
            if (selected) await openWorkspace(selected, false);
        }).catch((failure: unknown) => {
            if (live) setError(displayError(failure));
        }).finally(() => { if (live) setStarting(false); });
        return () => { live = false; };
    }, [openWorkspace]);

    useEffect(() => {
        if (!taskCenterOpen) return;
        const refreshWhenVisible = () => {
            if (!document.hidden) void refreshTaskCenter();
        };
        refreshWhenVisible();
        const timer = window.setInterval(refreshWhenVisible, 5_000);
        document.addEventListener("visibilitychange", refreshWhenVisible);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", refreshWhenVisible);
        };
    }, [refreshTaskCenter, taskCenterOpen]);

    useEffect(() => window.desktop.onEvent((event) => {
        const key = `${event.workspaceId}:${event.sessionId}`;
        const payload = event.payload;
        const appendRunActivity = (items: ActivityRow[], activity: ActivityRow): ActivityRow[] =>
            appendActivity(items, event.runId ? {
                ...activity,
                runId: event.runId,
                ...(assistantSegment.current?.runId === event.runId
                    ? { afterMessageId: `assistant-${event.runId}-${assistantSegment.current.index}` } : {}),
            } : activity);
        const isRunStart = payload.type === "agent" && payload.event.type === "turn.started";
        const kind = payload.type === "session.status" ? "finish" : isRunStart ? "start" : "event";
        if (!eventTracker.accepts(key, event.sequence, event.runId, kind)) return;
        if (event.workspaceId === activeRef.current.workspaceId) {
            if (payload.type === "session.status") {
                setSessions((current) => current.map((session) => session.id === event.sessionId
                    ? { ...session, status: payload.status } : session));
            } else if (payload.type === "agent" && payload.event.type === "turn.started") {
                setSessions((current) => current.map((session) => session.id === event.sessionId
                    ? { ...session, status: "running" } : session));
            }
        }
        if (event.workspaceId !== activeRef.current.workspaceId || event.sessionId !== activeRef.current.sessionId) return;
        if (payload.type !== "agent" || payload.event.type !== "assistant.delta") flushAssistantDelta();
        if (isRunStart) invalidateMessageRequests();
        if (event.runId) {
            setRunId(event.runId);
            setExternalRun(false);
        }
        if (payload.type === "session.status") {
            void refreshGitSnapshot(event.workspaceId);
            void refreshCodeReview(event.workspaceId, event.sessionId);
            setBusy(false);
            setRunId(null);
            setStatusLabel(payload.status === "cancelled" ? "已停止"
                : payload.status === "failed" ? "请求失败" : payload.status === "interrupted" ? "上次运行意外中断" : "已完成");
            setActiveSession((current) => current?.id === event.sessionId ? { ...current, status: payload.status } : current);
            return;
        }
        if (payload.type === "permission.requested") {
            setApprovals((items) => items.some((item) => item.requestId === payload.requestId) ? items : [...items, {
                requestId: payload.requestId,
                toolCallId: payload.toolCallId,
                toolName: payload.toolName,
                operation: payload.operation,
                message: payload.message,
                source: payload.source,
            }]);
            setBusy(true);
            setStatusLabel("等待权限确认");
            return;
        }
        if (payload.type === "permission.resolved") {
            setApprovals((items) => items.filter((item) => item.requestId !== payload.requestId));
            if (payload.outcome === "session") {
                void refreshPermissionGrants(event.workspaceId, event.sessionId);
            }
            setActivities((items) => {
                const previous = items.find((activity) => activity.id === payload.toolCallId);
                const next: ActivityRow = {
                    ...previous,
                    id: payload.toolCallId,
                    title: previous?.title ?? payload.toolName,
                    detail: previous?.detail ?? JSON.stringify(payload.operation, null, 2),
                    state: payload.outcome === "denied" || payload.outcome === "expired" ? "denied"
                        : payload.outcome === "cancelled" ? "interrupted" : previous?.state ?? "notice",
                    permissionSource: payload.source,
                    permissionDecision: "confirm",
                    permissionOutcome: payload.outcome,
                    startedAt: previous?.startedAt ?? event.timestamp,
                    updatedAt: event.timestamp,
                };
                return previous
                    ? items.map((activity) => activity.id === payload.toolCallId ? next : activity)
                    : appendRunActivity(items, next);
            });
            return;
        }
        if (payload.type === "question.requested") {
            setQuestions((items) => items.some((item) => item.requestId === payload.requestId) ? items : [...items, {
                requestId: payload.requestId,
                question: payload.question,
                options: payload.options,
            }]);
            setBusy(true);
            setStatusLabel("等待你的回答");
            setActivities((items) => updateQuestionActivity(items, payload.requestId, event.runId,
                payload.question, event.timestamp));
            return;
        }
        if (payload.type === "question.resolved") {
            setQuestions((items) => items.filter((item) => item.requestId !== payload.requestId));
            setQuestionDraft("");
            setActivities((items) => updateQuestionActivity(items, payload.requestId, event.runId,
                undefined, event.timestamp, payload.outcome));
            return;
        }
        const agentEvent = payload.event;
        if (agentEvent.type === "tool.completed") void refreshCodeReview(event.workspaceId, event.sessionId);
        if (agentEvent.type === "context.compaction.completed") {
            invalidateMessageRequests();
            historyCompacted.current = true;
            setMessageCursor(null);
        }
        if (agentEvent.type === "context.updated") {
            setContextUsage(agentEvent.context);
        } else if (agentEvent.type === "usage.updated") {
            setTokenUsage(agentEvent.usage);
        } else if (agentEvent.type === "turn.started") {
            const submission = pendingSubmissions.current.get(key);
            if (submission && !submission.shown) {
                submission.shown = true;
                setMessages(current => [...current, { ...submission.message, runIds: event.runId ? [event.runId] : undefined }]);
            }
            setBusy(true);
            setStatusLabel("thinking");
            if (event.runId) assistantSegment.current = { runId: event.runId, index: 0 };
            setActiveSession((current) => current?.id === event.sessionId ? { ...current, status: "running" } : current);
            if (event.runId) setMessages((current) => {
                const index = current.map((message) => message.role).lastIndexOf("user");
                if (index < 0 || current[index].runIds?.includes(event.runId!)) return current;
                const next = [...current];
                next[index] = { ...next[index], runIds: [...(next[index].runIds ?? []), event.runId!] };
                return next;
            });
            if (event.runId) setMessages((current) => current.some((message) => message.id === `assistant-${event.runId}-0`)
                ? current
                : [...current, { id: `assistant-${event.runId}-0`, role: "assistant", text: "" }]);
        } else if (agentEvent.type === "assistant.delta") {
            if (!event.runId) return;
            const segment = assistantSegment.current;
            const messageId = `assistant-${event.runId}-${segment?.runId === event.runId ? segment.index : 0}`;
            const pending = pendingAssistantDelta.current;
            if (pending && (pending.key !== key || pending.messageId !== messageId)) flushAssistantDelta();
            if (pendingAssistantDelta.current) pendingAssistantDelta.current.text += agentEvent.text;
            else pendingAssistantDelta.current = { key, messageId, text: agentEvent.text };
            if (assistantDeltaFrame.current === null) assistantDeltaFrame.current = window.requestAnimationFrame(flushAssistantDelta);
        } else if (agentEvent.type === "assistant.message.end") {
            if (event.runId && assistantSegment.current?.runId === event.runId) assistantSegment.current.index++;
        } else if (agentEvent.type === "status.changed") {
            setStatusLabel(agentEvent.status === "thinking" ? "thinking"
                : agentEvent.status === "running-tools" ? agentEvent.label || "Running tools"
                    : agentEvent.status === "working" ? agentEvent.label || "正在处理" : "整理结果中");
        } else if (agentEvent.type === "tool.started") {
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: agentEvent.id,
                title: agentEvent.name,
                detail: JSON.stringify(agentEvent.input, null, 2),
                state: "running",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
        } else if (agentEvent.type === "tool.completed") {
            const state = agentEvent.outcome === "denied" ? "denied" as const
                : agentEvent.outcome === "cancelled" ? "interrupted" as const
                    : agentEvent.outcome === "failed" ? "failed" as const : "complete" as const;
            setActivities((current) => {
                const previous = current.find((activity) => activity.id === agentEvent.id);
                const timestamp = new Date().toISOString();
                const next = {
                    ...previous,
                    id: agentEvent.id,
                    title: agentEvent.name,
                    detail: JSON.stringify(agentEvent.input, null, 2),
                    state,
                    output: agentEvent.output,
                    fileEdit: agentEvent.fileEdit,
                    durationMs: agentEvent.durationMs,
                    startedAt: previous?.startedAt ?? timestamp,
                    updatedAt: timestamp,
                };
                return previous ? current.map((activity) => activity.id === agentEvent.id ? next : activity) : appendRunActivity(current, next);
            });
        } else if (agentEvent.type === "permission.checked") {
            setActivities((current) => {
                const previous = current.find((activity) => activity.id === agentEvent.id);
                const timestamp = new Date().toISOString();
                const next: ActivityRow = {
                    ...previous,
                    id: agentEvent.id,
                    title: agentEvent.name,
                    detail: JSON.stringify(agentEvent.input, null, 2),
                    state: agentEvent.action === "deny" ? "denied" : previous?.state ?? "running",
                    permissionSource: agentEvent.source,
                    permissionDecision: agentEvent.action,
                    startedAt: previous?.startedAt ?? timestamp,
                    updatedAt: timestamp,
                };
                return previous ? current.map((activity) => activity.id === agentEvent.id ? next : activity) : appendRunActivity(current, next);
            });
            if (agentEvent.action === "allow" && agentEvent.source.kind === "session") {
                void refreshPermissionGrants(event.workspaceId, event.sessionId);
            }
        } else if (agentEvent.type === "notice") {
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: event.eventId,
                title: agentEvent.level === "warning" ? "需要留意" : "提示",
                detail: agentEvent.text,
                state: "notice",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
        } else if (agentEvent.type === "context.compaction.started") {
            const timestamp = new Date().toISOString();
            setStatusLabel("正在整理上下文");
            setActivities((current) => appendRunActivity(current, {
                id: `context-${agentEvent.id}`,
                title: "整理上下文",
                detail: "上下文接近可用窗口上限，正在整理较早的对话。",
                state: "running",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
        } else if (agentEvent.type === "context.compaction.completed") {
            const timestamp = new Date().toISOString();
            setStatusLabel("上下文整理完成");
            setActivities((current) => {
                const id = `context-${agentEvent.id}`;
                const previous = current.find((activity) => activity.id === id);
                const completed: ActivityRow = {
                    id,
                    title: "整理上下文",
                    detail: "对话整理完成，将继续当前任务。",
                    state: "complete",
                    startedAt: previous?.startedAt ?? timestamp,
                    updatedAt: timestamp,
                };
                return previous ? current.map((activity) => activity.id === id ? completed : activity) : appendRunActivity(current, completed);
            });
        } else if (agentEvent.type === "plan.review") {
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: event.eventId,
                title: "计划待审核",
                detail: agentEvent.content,
                state: "notice",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
        } else if (agentEvent.type === "plan.mode") {
            setPermissionMode(agentEvent.enabled ? "plan" : "desktopDefault");
            setStatusLabel(agentEvent.enabled ? "计划模式 - 只读与规划" : "默认模式 - 操作逐项确认");
            if (!agentEvent.enabled) {
                const timestamp = new Date().toISOString();
                setActivities((current) => appendRunActivity(current, {
                    id: event.eventId,
                    title: "已退出计划模式",
                    detail: "当前权限为默认确认。文件写入和程序执行仍会逐项请求批准。",
                    state: "notice",
                    startedAt: timestamp,
                    updatedAt: timestamp,
                }));
            }
        } else if (agentEvent.type === "subagent.started") {
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: `sub-${agentEvent.id}`,
                title: `${agentEvent.name} 子代理`,
                detail: agentEvent.description,
                state: "running",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
        } else if (agentEvent.type === "subagent.completed") {
            setActivities((current) => current.map((activity) => activity.id === `sub-${agentEvent.id}`
                ? { ...activity, detail: agentEvent.tokens === null ? agentEvent.description : `${agentEvent.description}\n\n消耗 ${agentEvent.tokens} tokens`, state: "complete", updatedAt: new Date().toISOString() } : activity));
        } else if (agentEvent.type === "subagent.failed") {
            setActivities((current) => current.map((activity) => activity.id === `sub-${agentEvent.id}`
                ? { ...activity, detail: agentEvent.error, state: "failed", updatedAt: new Date().toISOString() } : activity));
        } else if (agentEvent.type === "turn.completed") {
            setTokenUsage(agentEvent.usage);
            setBusy(false);
            setRunId(null);
            setStatusLabel("已完成");
            setApprovals([]);
            setQuestions([]);
            setQuestionDraft("");
            if (activeRef.current.workspaceId) void refreshSessions(activeRef.current.workspaceId);
        } else if (agentEvent.type === "turn.cancelled") {
            setBusy(false);
            setRunId(null);
            setStatusLabel("已停止");
            setApprovals([]);
            setQuestions([]);
            setQuestionDraft("");
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: event.eventId,
                title: "任务已停止",
                detail: "任务已停止，已完成的文件改动仍保留在工作区。",
                state: "notice",
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
            if (activeRef.current.workspaceId) void refreshSessions(activeRef.current.workspaceId);
        } else if (agentEvent.type === "turn.failed") {
            setBusy(false);
            setRunId(null);
            setStatusLabel("请求失败");
            const category = failureCategoryLabel(agentEvent.category);
            setError(`${category}：${agentEvent.message}\n${failureNextStep(agentEvent.category, agentEvent.retryable)}`);
            setApprovals([]);
            setQuestions([]);
            setQuestionDraft("");
            const timestamp = new Date().toISOString();
            setActivities((current) => appendRunActivity(current, {
                id: event.eventId,
                title: `任务失败 - ${category}`,
                detail: agentEvent.message,
                state: "failed",
                failureCategory: agentEvent.category,
                retryable: agentEvent.retryable,
                safeToRetry: agentEvent.safeToRetry,
                startedAt: timestamp,
                updatedAt: timestamp,
            }));
            if (activeRef.current.workspaceId) void refreshSessions(activeRef.current.workspaceId);
        } else if (agentEvent.type === "turn.cancel_requested") {
            setStatusLabel("正在停止...");
        }
    }), [eventTracker, flushAssistantDelta, invalidateMessageRequests, refreshCodeReview, refreshGitSnapshot, refreshPermissionGrants, refreshSessions]);

    useEffect(() => window.desktop.onWorkspaceChanged(({ workspaceId }) => {
        if (workspaceId !== activeRef.current.workspaceId || rightPanel !== "changes") return;
        void refreshGitSnapshot(workspaceId);
        const sessionId = activeRef.current.sessionId;
        if (sessionId) void refreshCodeReview(workspaceId, sessionId);
    }), [refreshCodeReview, refreshGitSnapshot, rightPanel]);

    useEffect(() => {
        if (activeWorkspace?.available) {
            void refreshGitSnapshot(activeWorkspace.id);
        } else {
            gitRequestSequence.current += 1;
            reviewRequestSequence.current += 1;
            setGitView(null);
            setReviewView(null);
            setGitLoading(false);
            setReviewLoading(false);
        }
    }, [activeWorkspace?.id, activeWorkspace?.available, refreshGitSnapshot]);

    useEffect(() => {
        const workspaceId = activeWorkspace?.id;
        const request = ++worktreeRequestSequence.current;
        if (!workspaceId || !activeWorkspace?.available) {
            setWorktreeAssociation(null);
            return;
        }
        void window.desktop.getWorktreeAssociation(workspaceId).then((association) => {
            if (request === worktreeRequestSequence.current && activeRef.current.workspaceId === workspaceId) {
                setWorktreeAssociation(association);
            }
        }).catch(() => {
            if (request === worktreeRequestSequence.current && activeRef.current.workspaceId === workspaceId) {
                setWorktreeAssociation(null);
            }
        });
        return () => { if (worktreeRequestSequence.current === request) worktreeRequestSequence.current++; };
    }, [activeWorkspace?.id, activeWorkspace?.available]);

    useLayoutEffect(() => {
        const container = conversationRef.current;
        if (!container) return;
        const key = `${activeRef.current.workspaceId}:${activeRef.current.sessionId}`;
        if (pendingLatestScroll.current === key) {
            pendingLatestScroll.current = null;
            stickToBottom.current = true;
            const scrollToLatest = () => {
                if (conversationRef.current !== container
                    || `${activeRef.current.workspaceId}:${activeRef.current.sessionId}` !== key) return;
                container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
                stickToBottom.current = true;
            };
            scrollToLatest();
            const frame = requestAnimationFrame(scrollToLatest);
            return () => cancelAnimationFrame(frame);
        }
        const anchor = scrollAnchor.current;
        if (anchor) {
            scrollAnchor.current = null;
            const item = [...container.querySelectorAll<HTMLElement>("[data-message-id]")]
                .find((element) => element.dataset.messageId === anchor.id);
            if (item) container.scrollTo({ top: container.scrollTop + item.getBoundingClientRect().top - anchor.top, behavior: "instant" });
        } else if (stickToBottom.current) {
            container.scrollTop = container.scrollHeight;
        }
    }, [messages, activities, approvals, questions, busy, statusLabel]);

    const handleConversationScroll = (event: UIEvent<HTMLDivElement>) => {
        const container = event.currentTarget;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (container.scrollTop < lastConversationScrollTop.current - 1 || distanceFromBottom < 80) {
            stickToBottom.current = distanceFromBottom < 80;
        }
        lastConversationScrollTop.current = container.scrollTop;
        const openingLatest = pendingLatestScroll.current
            === `${activeRef.current.workspaceId}:${activeRef.current.sessionId}`;
        if (!openingLatest && container.scrollTop < 180 && distanceFromBottom > 1 && messageCursor !== null) {
            void loadOlderMessages();
        }
        if (!stickToBottom.current || messages.length <= 160 || olderRequestPending.current) return;
        if (historyCompacted.current) {
            if (!busy && !runId) void refreshRecentMessages();
            return;
        }
        const recent = messages.slice(-120);
        const firstHistory = recent.find((message) => /^history-\d+$/.test(message.id));
        if (!firstHistory) {
            if (!busy && !runId) void refreshRecentMessages();
            return;
        }
        setMessages(recent);
        setMessageCursor(Number(firstHistory.id.slice("history-".length)));
    };

    useEffect(() => {
        if (!busy && !runId && stickToBottom.current && messages.length > 160
            && (historyCompacted.current || !messages.some((message) => /^history-\d+$/.test(message.id)))) {
            void refreshRecentMessages();
        }
    }, [busy, runId, messages, refreshRecentMessages]);

    useEffect(() => {
        if (!sessionMenuId) return;
        const closeMenu = (event: MouseEvent): void => {
            if (!(event.target instanceof Element) || !event.target.closest(".session-actions")) setSessionMenuId(null);
        };
        const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
            if (event.key === "Escape") setSessionMenuId(null);
        };
        document.addEventListener("click", closeMenu);
        document.addEventListener("keydown", closeOnEscape);
        return () => { document.removeEventListener("click", closeMenu); document.removeEventListener("keydown", closeOnEscape); };
    }, [sessionMenuId]);

    useEffect(() => {
        if (!modelPickerOpen && !permissionPickerOpen) return;
        const closeOnOutside = (event: PointerEvent): void => {
            if (!(event.target instanceof Element)) return;
            if (!event.target.closest(".model-picker")) setModelPickerOpen(false);
            if (!event.target.closest(".permission-picker")) setPermissionPickerOpen(false);
        };
        const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
            if (event.key === "Escape") { setModelPickerOpen(false); setPermissionPickerOpen(false); }
        };
        document.addEventListener("pointerdown", closeOnOutside);
        document.addEventListener("keydown", closeOnEscape);
        return () => { document.removeEventListener("pointerdown", closeOnOutside); document.removeEventListener("keydown", closeOnEscape); };
    }, [modelPickerOpen, permissionPickerOpen]);

    const activitiesAfterMessage = useMemo(
        () => groupConversationActivities(messages, activities),
        [messages, activities],
    );
    const clearActivityFocus = useCallback(() => setActivityFocusId(null), []);

    const visibleSessions = useMemo(() => {
        const needle = search.trim().toLowerCase();
        return needle ? sessions.filter((session) => session.title.toLowerCase().includes(needle)) : sessions;
    }, [search, sessions]);
    const failedPrompt = activeSession?.status === "failed"
        ? [...messages].reverse().find((message) => message.role === "user")?.text ?? ""
        : "";
    const failedTurnActivity = [...activities].reverse().find((activity) => activity.failureCategory !== undefined);

    const restoreFailedPrompt = () => {
        if (!failedPrompt || draft.trim()) return;
        setDraft(failedPrompt);
        setRetryNotice("请求已放回输入框。发送后会作为新消息追加到本会话。失败前已完成的文件或命令操作可能仍保留；请检查活动和改动，编辑后再发送。");
        setStatusLabel("失败请求已放回输入框");
        window.requestAnimationFrame(() => composerInput.current?.focus());
    };

    const retryFailedPrompt = async () => {
        if (!failedPrompt || failedTurnActivity?.safeToRetry !== true || busy || externalRun || !activeWorkspace || !activeSession) return;
        if (!hasDesktopCredential(sessionCredentialState ?? bootstrap?.credentialState)) {
            setError(credentialSetupMessage(sessionCredentialState ?? bootstrap?.credentialState ?? "missing"));
            setSettingsOpen(true);
            return;
        }
        const workspaceId = activeWorkspace.id;
        const sessionId = activeSession.id;
        const sessionKey = `${workspaceId}:${sessionId}`;
        pendingStartStops.current.delete(sessionKey);
        invalidateMessageRequests();
        setRetryNotice("");
        setBusy(true);
        setExternalRun(false);
        setRunId(null);
        setStatusLabel("正在安全重试");
        setError("");
        try {
            const response = await window.desktop.retryRun(workspaceId, sessionId, crypto.randomUUID());
            const runStarted = eventTracker.begin(sessionKey, response.runId);
            if (pendingStartStops.current.delete(sessionKey)) {
                await window.desktop.cancelRun(response.runId);
            } else if (runStarted && activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setRunId(response.runId);
            }
            void refreshCodeReview(workspaceId, sessionId);
        } catch (failure) {
            pendingStartStops.current.delete(sessionKey);
            if (activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setBusy(false);
                setStatusLabel("请求失败");
                setError(displayError(failure));
            }
        }
    };

    const handleChooseWorkspace = async () => {
        try {
            const chosen = await window.desktop.chooseWorkspace();
            if (!chosen) return;
            const data = await window.desktop.getBootstrap();
            setBootstrap(data);
            await openWorkspace(chosen, false);
        } catch (failure) { setError(displayError(failure)); }
    };

    const toggleTerminal = async () => {
        if (!terminalOpen) {
            if (!activeWorkspace?.available) return;
            if (terminalCloseTimer.current !== null) window.clearTimeout(terminalCloseTimer.current);
            terminalCloseTimer.current = null;
            setTerminalWorkspaceId(activeWorkspace.id);
            setTerminalMounted(true);
            requestAnimationFrame(() => setTerminalOpen(true));
            return;
        }
        if (!(await confirmInApp("关闭终端会结束此 PowerShell 会话和它启动的前台程序。继续吗？", "继续"))) return;
        setTerminalOpen(false);
        terminalCloseTimer.current = window.setTimeout(() => {
            setTerminalMounted(false);
            setTerminalWorkspaceId(null);
            terminalCloseTimer.current = null;
        }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
    };

    useEffect(() => () => {
        if (terminalCloseTimer.current !== null) window.clearTimeout(terminalCloseTimer.current);
    }, []);

    const handleNewSession = useCallback(async () => {
        if (!activeWorkspace?.available) return;
        try {
            const created = await window.desktop.createSession(activeWorkspace.id);
            setSessions((current) => [created.session, ...current]);
            eventTracker.openSession(`${activeWorkspace.id}:${created.session.id}`, created.eventSequence, created.runId);
            activeRef.current = { workspaceId: activeWorkspace.id, sessionId: created.session.id };
            resetMessageHistory(null);
            setActiveSession(created.session);
            setSessionRoute(created.route);
            setSessionCredentialState(await window.desktop.getCredentialState(created.route.modelPreset));
            setMessages([]);
            clearAttachments();
            setRetryNotice("");
            setActivities([]);
            setPermissionGrants([]);
            setTokenUsage(created.usage);
            setContextUsage(created.contextUsage);
            setApprovals([]);
            setQuestions([]);
            setQuestionDraft("");
            setBusy(false);
            setExternalRun(false);
            setRunId(created.runId);
            setPermissionMode("desktopDefault");
            setStatusLabel("就绪");
            setError("");
        } catch (failure) { setError(displayError(failure)); }
    }, [activeWorkspace, eventTracker, resetMessageHistory]);

    useEffect(() => {
        const onShortcut = (event: globalThis.KeyboardEvent): void => {
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (target?.matches("input, textarea, select, [contenteditable='true']") || target?.closest("[role='dialog']")) return;
            if (event.key.toLowerCase() === "n") {
                event.preventDefault();
                if (!busy) void handleNewSession();
            } else if (event.key === ",") {
                event.preventDefault();
                setSettingsOpen(true);
            }
        };
        window.addEventListener("keydown", onShortcut);
        return () => window.removeEventListener("keydown", onShortcut);
    }, [busy, handleNewSession]);

    const handleSend = async (event?: FormEvent) => {
        event?.preventDefault();
        const text = draft.trim() || (attachments.length ? "请查看附件。" : "");
        if (!text || attachmentPending || !activeWorkspace || !activeSession) return;
        if (externalRun) {
            setError("这个会话正在另一个 CLI 或桌面进程中运行。请刷新会话状态，任务结束后再继续发送。");
            return;
        }
        if (!hasDesktopCredential(sessionCredentialState ?? bootstrap?.credentialState)) {
            setError(credentialSetupMessage(sessionCredentialState ?? bootstrap?.credentialState ?? "missing"));
            setSettingsOpen(true);
            return;
        }
        const workspaceId = activeWorkspace.id;
        const sessionId = activeSession.id;
        const sessionKey = `${workspaceId}:${sessionId}`;
        if (pendingSubmissions.current.has(sessionKey)) return;
        const interrupt = busy;
        const requestId = crypto.randomUUID();
        setRetryNotice("");
        pendingStartStops.current.delete(sessionKey);
        invalidateMessageRequests();
        const optimistic: ConversationMessage = { id: `user-${crypto.randomUUID()}`, role: "user", text, ...(attachments.length ? { attachments } : {}) };
        const submission = { requestId, message: optimistic, interrupt, shown: !interrupt, stopped: false };
        pendingSubmissions.current.set(sessionKey, submission);
        setSendingSessions(current => [...current, sessionKey]);
        flushAssistantDelta();
        if (!interrupt) setMessages((current) => [...current, optimistic]);
        setDraft("");
        clearAttachments(false);
        setBusy(true);
        setExternalRun(false);
        setStatusLabel(interrupt ? "正在中断并继续..." : "正在启动任务");
        setError("");
        try {
            const response = await window.desktop.startRun(workspaceId, sessionId, text, requestId, attachments.map(file => file.id), interrupt);
            if (activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                const show = !submission.shown;
                submission.shown = true;
                setMessages(current => (show ? [...current, optimistic] : current).map(message => message.id === optimistic.id
                    ? { ...message, runIds: [response.runId] } : message));
            }
            const runStarted = eventTracker.begin(sessionKey, response.runId);
            if (pendingStartStops.current.delete(sessionKey)) {
                await window.desktop.cancelRun(response.runId);
            } else if (runStarted && activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setRunId(response.runId);
            }
            void refreshCodeReview(workspaceId, sessionId);
        } catch (failure) {
            pendingStartStops.current.delete(sessionKey);
            if (activeRef.current.workspaceId === workspaceId && activeRef.current.sessionId === sessionId) {
                setMessages((current) => current.filter((message) => message.id !== optimistic.id));
                setDraft(current => draft && current ? `${draft}\n${current}` : draft || current);
                setAttachments(current => [...attachments, ...current]);
                const stillRunning = Boolean(runId && !eventTracker.isFinished(sessionKey, runId));
                setBusy(stillRunning);
                const message = displayError(failure);
                setStatusLabel(submission.stopped ? "已停止" : /concurrency|同时运行上限|并发/i.test(message) ? "并发任务已满"
                    : /another process|另一个进程/i.test(message) ? "任务正在另一个进程中运行" : stillRunning ? "继续当前任务" : "就绪");
                setError(submission.stopped ? "" : message);
            }
        } finally {
            pendingSubmissions.current.delete(sessionKey);
            setSendingSessions(current => current.filter(key => key !== sessionKey));
        }
    };

    const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            void handleSend();
        }
    };

    const handleStop = async () => {
        const submission = pendingSubmissions.current.get(`${activeRef.current.workspaceId}:${activeRef.current.sessionId}`);
        if (submission) {
            submission.stopped = true;
            setStatusLabel("正在停止...");
            try { await window.desktop.cancelSubmittedRun(submission.requestId); }
            catch (failure) { setError(displayError(failure)); }
            return;
        }
        if (!runId) {
            if (activeRef.current.workspaceId && activeRef.current.sessionId) {
                pendingStartStops.current.add(`${activeRef.current.workspaceId}:${activeRef.current.sessionId}`);
                setStatusLabel("正在停止...");
            }
            return;
        }
        setStatusLabel("正在停止...");
        try { await window.desktop.cancelRun(runId); }
        catch (failure) { setError(displayError(failure)); }
    };

    const chooseSession = async (session: SessionSummary) => {
        if (!activeWorkspace) return;
        setSessionMenuId(null);
        setModelPickerOpen(false);
        setPermissionPickerOpen(false);
        clearAttachments();
        try { await openSession(activeWorkspace.id, session.id); }
        catch (failure) { setError(displayError(failure)); }
    };

    const changePermissionMode = async (mode: "desktopDefault" | "desktopAcceptEdits" | "bypassPermissions") => {
        if (!activeWorkspace || !activeSession || externalRun || quickSettingsSaving) return;
        if (typeof window.desktop.updatePermissionMode !== "function") {
            setError("桌面服务仍在运行旧版本。请完全退出并重新启动 TriumCode 后再调整权限。");
            return;
        }
        setQuickSettingsSaving(true);
        try {
            await window.desktop.updatePermissionMode(activeWorkspace.id, activeSession.id, mode);
            setPermissionMode(mode);
        } catch (failure) { setError(displayError(failure)); }
        finally { setQuickSettingsSaving(false); }
    };

    const removeWorkspace = async (workspace: WorkspaceSummary) => {
        if (!(await confirmInApp(`从最近项目中移除 ${workspace.name}？项目文件不会被删除。`, "移除", true))) return;
        try {
            await window.desktop.removeWorkspace(workspace.id);
            const next = await window.desktop.getBootstrap();
            setBootstrap(next);
            if (activeWorkspace?.id === workspace.id) {
                setActiveWorkspace(null);
                setActiveSession(null);
                setSessions([]);
                resetMessageHistory(null);
                setMessages([]);
                setTokenUsage(null);
                setContextUsage(null);
                setActivities([]);
                setPermissionGrants([]);
                setBusy(false);
                setExternalRun(false);
                setRunId(null);
                activeRef.current = { workspaceId: "", sessionId: "" };
            }
        } catch (failure) { setError(displayError(failure)); }
    };

    const renameSession = async (session: SessionSummary) => {
        if (!activeWorkspace) return;
        const title = await promptInApp("为这个会话命名", session.title);
        if (!title?.trim()) return;
        try {
            const updated = await window.desktop.renameSession(activeWorkspace.id, session.id, title);
            setSessions((current) => current.map((item) => item.id === session.id ? updated : item));
            if (activeSession?.id === session.id) setActiveSession(updated);
        } catch (failure) { setError(displayError(failure)); }
    };

    const deleteSession = async (session: SessionSummary) => {
        if (!activeWorkspace || !(await confirmInApp(`删除会话“${session.title}”及其本地审阅快照？工作区文件和 API Key 不会被删除。`, "删除", true))) return;
        try {
            const result = await window.desktop.deleteSession(activeWorkspace.id, session.id);
            const key = `${activeWorkspace.id}:${session.id}`;
            eventTracker.delete(key);
            const remaining = await refreshSessions(activeWorkspace.id);
            if (activeSession?.id === session.id) {
                setActiveSession(null);
                resetMessageHistory(null);
                setMessages([]);
                setActivities([]);
                setPermissionGrants([]);
                setTokenUsage(null);
                setContextUsage(null);
                activeRef.current = { workspaceId: activeWorkspace.id, sessionId: "" };
                if (remaining.length) await openSession(activeWorkspace.id, remaining[0].id);
            }
            if (!result.reviewRemoved) setError("会话已删除，但审阅快照未能完全清除。请检查本机用户数据目录中的 reviews 文件夹。");
        } catch (failure) { setError(displayError(failure)); }
    };

    const respondPermission = async (approval: PendingPermissionRequest, choice: "once" | "session" | "deny") => {
        try {
            await window.desktop.respondToPermission(approval.requestId, choice);
            setApprovals((current) => current.filter((item) => item.requestId !== approval.requestId));
        }
        catch (failure) { setError(displayError(failure)); }
    };

    const revokePermissionGrant = async (grantId: string) => {
        const workspaceId = activeRef.current.workspaceId;
        const sessionId = activeRef.current.sessionId;
        if (!workspaceId || !sessionId) return;
        try {
            const revoked = await window.desktop.revokePermissionGrant(workspaceId, sessionId, grantId);
            if (!revoked || activeRef.current.workspaceId !== workspaceId || activeRef.current.sessionId !== sessionId) return;
            setPermissionGrants((grants) => grants.filter((grant) => grant.id !== grantId));
            setActivities((items) => items.map((activity) => activity.permissionSource?.kind === "session"
                && activity.permissionSource.grantId === grantId
                ? { ...activity, permissionGrantRevoked: true, updatedAt: new Date().toISOString() }
                : activity));
        } catch (failure) { setError(displayError(failure)); }
    };

    const respondQuestion = async (question: PendingUserQuestion, answer: string) => {
        try {
            await window.desktop.respondToQuestion(question.requestId, answer);
            setQuestions((current) => current.filter((item) => item.requestId !== question.requestId));
            setQuestionDraft("");
        }
        catch (failure) { setError(displayError(failure)); }
    };

    if (starting) return <div className="launch-screen"><span>正在启动 TriumCode...</span></div>;

    return <div ref={appShellRef} className={`app-shell ${activeWorkspace && inspectorOpen ? "" : "no-inspector"}`}
        style={{ "--sidebar-width": `${panelWidths.sidebar}px`, "--inspector-width": `${panelWidths.inspector}px` } as CSSProperties}>
        <header className="titlebar" onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            void window.desktop.toggleWindowMaximize();
        }}>
            <span className="brand-name">TriumCode</span>
            <div className="breadcrumbs">
                {activeWorkspace ? <><span className="crumb-project">{activeWorkspace.name}</span><Icon name="chevron" size={14} /><span className="crumb-session">{activeSession?.title || "新会话"}</span></> : <span className="crumb-session">桌面工作区</span>}
            </div>
            <div className="topbar-actions">
                {activeWorkspace?.branch && <div className="git-branch-picker"><button ref={gitBranchButtonRef} type="button" className="topbar-chip git-branch-toggle" title="切换分支并查看提交历史" aria-haspopup="dialog" aria-controls="git-branch-popover" aria-expanded={gitHistoryOpen} onClick={() => setGitHistoryOpen((open) => !open)}><span className="git-branch-icon"><Icon name="branch" size={15} /></span><span className="git-branch-label">{activeWorkspace.branch}</span><Icon name="chevron" size={12} /></button>
                    {gitHistoryOpen && <GitBranchDialog key={activeWorkspace.id} workspace={activeWorkspace} managed={worktreeAssociation?.workspaceId === activeWorkspace.id} onClose={(restoreFocus) => { setGitHistoryOpen(false); if (restoreFocus) gitBranchButtonRef.current?.focus(); }} onOpenGraph={(history) => { setGitHistoryOpen(false); setGitGraphHistory({ workspaceId: activeWorkspace.id, history }); }} onChanged={async () => {
                        await refreshGitSnapshot(activeWorkspace.id);
                        if (activeSession) await refreshCodeReview(activeWorkspace.id, activeSession.id);
                    }} />}
                </div>}
                <button className={`topbar-chip task-center-toggle ${taskCenterOpen ? "selected" : ""}`} onClick={() => setTaskCenterOpen(true)} title="查看所有工作区的任务">任务中心</button>
                <button className={`topbar-chip terminal-toggle ${terminalOpen ? "selected" : ""}`} onClick={toggleTerminal} disabled={!terminalOpen && !activeWorkspace?.available} title={terminalOpen ? "关闭工作区终端" : "打开绑定当前工作区的 PowerShell 终端"}>终端</button>
                {activeWorkspace && <button className={`icon-button inspector-toggle ${inspectorOpen ? "panel-selected" : ""}`} title={inspectorOpen ? "收起右侧面板" : "展开右侧面板"} aria-label={inspectorOpen ? "收起右侧面板" : "展开右侧面板"} aria-expanded={inspectorOpen} onClick={() => setInspectorOpen((current) => !current)}><Icon name="panel-right" size={17} /></button>}
            </div>
        </header>
        <div className="app-columns">
        <aside className="sidebar">
            <div className="sidebar-primary">
                <button className="new-task-button" onClick={() => void handleNewSession()} disabled={!activeWorkspace?.available}
                    aria-keyshortcuts={commandModifier === "⌘" ? "Meta+N" : "Control+N"}>
                    <Icon name="plus" /><span>新建会话</span><kbd>{commandModifier} N</kbd>
                </button>
                <div className="search-box"><Icon name="search" size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索会话" /></div>
            </div>
            <div className="side-scroll">
                <section className="nav-section">
                    <div className="section-head"><span>工作区</span><div className="workspace-section-actions">
                        <button className="icon-button small" title="新建隔离工作区" aria-label="新建隔离工作区" disabled={!activeWorkspace?.available} onClick={() => setWorktreeDialogOpen(true)}><Icon name="branch" size={14} /></button>
                        <button className="icon-button small" title="打开项目文件夹" aria-label="打开项目文件夹" onClick={() => void handleChooseWorkspace()}><Icon name="plus" size={15} /></button>
                    </div></div>
                    {bootstrap?.workspaces.map((workspace) => <div className={`workspace-row ${activeWorkspace?.id === workspace.id ? "selected" : ""}`} key={workspace.id}>
                        <button className="workspace-select" aria-current={activeWorkspace?.id === workspace.id ? "page" : undefined} onClick={() => void openWorkspace(workspace)}>
                            <span className={`workspace-dot ${workspace.available ? "" : "missing"}`} />
                            <span className="workspace-name">{workspace.name}</span>
                            {!workspace.available && <span className="workspace-state">不可访问</span>}
                            {workspace.branch && <span className="branch-chip">{workspace.branch}</span>}
                        </button>
                        <button className="row-action" title="从最近项目移除" aria-label={`从最近项目移除工作区：${workspace.name}`} onClick={() => void removeWorkspace(workspace)}><Icon name="close" size={13} /></button>
                    </div>)}
                    {!bootstrap?.workspaces.length && <div className="side-empty">打开一个本地代码项目，开始使用 Agent。</div>}
                </section>
                <section className="nav-section sessions-section">
                    <div className="section-head"><span>会话</span>{activeWorkspace && <button className="icon-button small" title="新建会话" onClick={() => void handleNewSession()}><Icon name="plus" size={15} /></button>}</div>
                    {!activeWorkspace && <div className="side-empty">先选择一个工作区。</div>}
                    {activeWorkspace && visibleSessions.map((session) => <div className={`session-row ${activeSession?.id === session.id ? "selected" : ""}`} key={session.id}>
                        <button className="session-select" aria-current={activeSession?.id === session.id ? "page" : undefined} onClick={() => void chooseSession(session)}>
                            <span className="session-title">{session.title}</span>
                            {sessionStatusLabel(session.status) && <span className={`session-state-label ${session.status}`}>{sessionStatusLabel(session.status)}</span>}
                        </button>
                        <div className="session-actions">
                            <button className="row-action" title="会话操作" aria-label={`会话操作：${session.title}`} aria-expanded={sessionMenuId === session.id} onClick={() => setSessionMenuId((current) => current === session.id ? null : session.id)}><Icon name="more" size={15} /></button>
                            {sessionMenuId === session.id && <div className="session-menu"><button onClick={() => { setSessionMenuId(null); void renameSession(session); }}>重命名</button><button onClick={() => { setSessionMenuId(null); void deleteSession(session); }}>删除会话</button></div>}
                        </div>
                    </div>)}
                    {activeWorkspace && sessions.length === 0 && <div className="side-empty">此工作区还没有会话。</div>}
                </section>
            </div>
            <div className="sidebar-bottom">
                <button className={`settings-entry ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen(true)} aria-keyshortcuts={commandModifier === "⌘" ? "Meta+," : "Control+,"}><Icon name="settings" size={16} /><span>设置</span></button>
            </div>
        </aside>

        <div className="column-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度"
            aria-valuemin={200} aria-valuemax={340} aria-valuenow={panelWidths.sidebar} tabIndex={0}
            onPointerDown={(event) => startPanelResize("sidebar", event)}
            onPointerMove={(event) => movePanelResize("sidebar", event)}
            onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} onLostPointerCapture={finishPanelResize}
            onKeyDown={(event) => resizePanelFromKeyboard("sidebar", event)} />

        <main className="main-column">
            {externalRun && activeSession && <div className="external-run-banner" role="status">
                <div><strong>此任务正在另一个进程中运行</strong><span>当前窗口可以查看已保存的对话，但无法发送消息、回复审批或停止这个任务。</span></div>
                <button className="secondary-button compact" onClick={() => void refreshExternalSession()}>刷新会话状态</button>
            </div>}

            {activeWorkspace?.available && bootstrap && !hasDesktopCredential(sessionCredentialState ?? bootstrap.credentialState) && <div className="credential-setup-banner" role="status">
                <span>{credentialSetupMessage(sessionCredentialState ?? bootstrap.credentialState)}</span>
                <button className="secondary-button compact" onClick={() => setSettingsOpen(true)}>配置模型</button>
            </div>}

            {!activeWorkspace ? <div className="welcome-area">
                <h1>让代码任务从这里开始</h1>
                <p>选择一个本地项目，描述你要完成的工作。Agent 会在你查看和确认的过程中协助修改代码。</p>
                <div className="welcome-actions">
                    <button className="primary-button" onClick={() => void handleChooseWorkspace()}><Icon name="folder" size={17} />打开项目文件夹<Icon name="arrow" size={15} /></button>
                    <button className="secondary-button" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={15} />配置模型</button>
                </div>
                {bootstrap && <div className={`welcome-credential ${hasDesktopCredential(bootstrap.credentialState) ? "ready" : "needs-setup"}`}>
                    <span className="setup-indicator" />{credentialLabel(bootstrap.credentialState)}
                </div>}
                <div className="welcome-footnote">文件留在本机 · 写入和命令逐项审批</div>
            </div> : !activeWorkspace.available ? <div className="missing-workspace"><div className="missing-icon">!</div><h2>找不到这个项目文件夹</h2><p>{activeWorkspace.path}</p><button className="secondary-button" onClick={() => void handleChooseWorkspace()}>打开其他项目</button></div> : <>
                <div className="conversation-zone">
                <div className="conversation" key={activeSession?.id || "none"} ref={conversationRef} onScroll={handleConversationScroll} style={{ "--composer-space": `${composerSpace}px` } as CSSProperties}>
                    {!activeSession ? <div className="empty-conversation">
                        <h2>在 {activeWorkspace.name} 中开始新任务</h2>
                        <p>描述一个问题、功能或代码问题。所有写入和命令都会先等待你的确认。</p>
                        <button className="suggestion-card" onClick={() => setDraft("先熟悉这个项目的结构，并告诉我主要模块之间的关系。")}><span className="suggestion-icon"><Icon name="search" size={15} /></span><span><strong>了解项目</strong><small>先阅读代码，再概述主要模块</small></span><Icon name="arrow" size={14} /></button>
                    </div> : <div className="message-list">
                        {messages.length === 0 && <div className="empty-conversation compact-empty"><h2>准备好开始了</h2><p>用自然语言描述你想完成的任务。</p></div>}
                        {messageCursor !== null && <button type="button" className="older-messages" disabled={olderLoading} onClick={() => void loadOlderMessages()}>{olderLoading ? "正在加载更早消息..." : "加载更早消息"}</button>}
                        {messages.map((message) => <Fragment key={message.id}>{(message.text || message.attachments?.length) && <article className={`message ${message.role}`} data-message-id={message.id}>
                            <div className="message-content">
                                <div className="message-meta"><span>{message.role === "user" ? "你" : "TriumCode"}</span></div>
                                <MemoMessageBody text={message.text} />
                                {message.attachments?.length && activeSession && <AttachmentList attachments={message.attachments} workspaceId={activeWorkspace.id} sessionId={activeSession.id} />}
                                <MessageActions text={message.text} showFeedback={message.role === "assistant"} />
                            </div>
                        </article>}
                            {activitiesAfterMessage.has(message.id) && <ActivityGroup key={`${message.id}-activity`} activities={activitiesAfterMessage.get(message.id)!} running={busy && activitiesAfterMessage.get(message.id)!.some((activity) => activity.runId === runId && activity.state === "running")} focusId={activityFocusId} onFocusHandled={clearActivityFocus} />}
                        </Fragment>)}
                        {(busy || submitting) && <div className="agent-working" role="status"><span className="working-glint">{workingStatus}<span className="working-glint-highlight" aria-hidden="true">{workingStatus}</span></span></div>}
                    </div>}
                </div>

                <div className="composer-dock" ref={setComposerDock}>
                {(approvals.length > 0 || questions.length > 0) && <div className="decision-stack">
                    {approvals.map((approval) => <section className="approval-card" key={approval.requestId}>
                        <div className="decision-heading"><span className="decision-icon warning">!</span><div><strong>需要批准一项操作</strong><small>拒绝后 Agent 会收到结果并决定如何继续。</small></div></div>
                        <div className="approval-operation"><div className="operation-name">{approval.toolName}</div><pre>{JSON.stringify(approval.operation, null, 2)}</pre><div className="operation-reason">{approval.message}</div><div className="approval-policy"><span>策略来源</span>{permissionSourceLabel(approval.source)}</div></div>
                        {approval.toolName === "run_command" && <div className="approval-boundary" role="note"><strong>访问边界</strong><span>该程序仍可能访问工作区外文件或网络；此审批不提供 OS 级沙箱。</span></div>}
                        <div className="approval-actions"><button className="danger-quiet" onClick={() => void respondPermission(approval, "deny")}>拒绝</button><span className="approval-spacer" /><button className="secondary-button compact" onClick={() => void respondPermission(approval, "session")}>本会话允许相同操作</button><button className="primary-button compact" onClick={() => void respondPermission(approval, "once")}>允许一次</button></div>
                        <small className="approval-session-note">本会话授权会随这段对话保存；可在“会话信息”中撤销。</small>
                    </section>)}
                    {questions.map((question) => <section className="question-card" key={question.requestId}>
                        <div className="decision-heading"><span className="decision-icon question">?</span><div><strong>Agent 需要你的回答</strong><small>{question.question}</small></div></div>
                        {question.options?.length ? <div className="question-options">{question.options.map((option) => <button type="button" key={option} className="secondary-button" onClick={() => void respondQuestion(question, option)}>{option}</button>)}<button type="button" className="secondary-button compact" onClick={() => void respondQuestion(question, "")}>跳过</button></div> : <form className="question-answer" onSubmit={(event) => { event.preventDefault(); void respondQuestion(question, questionDraft); }}><input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} placeholder="输入回答，留空后按跳过" /><button type="submit" className="primary-button compact">发送</button><button type="button" className="secondary-button compact" onClick={() => void respondQuestion(question, "")}>跳过</button></form>}
                    </section>)}
                </div>}

                {activeSession && <form className="composer-wrap" onSubmit={(event) => void handleSend(event)}>
                    <div className={`composer ${busy || submitting ? "is-busy" : ""}${attachmentDragOver ? " attachment-drag-over" : ""}`}
                        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = externalRun ? "none" : "copy"; if (!externalRun) setAttachmentDragOver(true); } }}
                        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setAttachmentDragOver(false); }}
                        onDrop={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setAttachmentDragOver(false); if (!externalRun) addAttachmentFiles([...event.dataTransfer.files]); } }}>
                        <AttachmentList attachments={attachments} workspaceId={activeWorkspace.id} sessionId={activeSession.id} onRemove={removeAttachment} disabled={externalRun} />
                        {attachmentPending && <div className="attachment-loading" role="status">正在准备附件...</div>}
                        <textarea ref={composerInput} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKey} onPaste={pasteAttachments} disabled={externalRun} placeholder={externalRun ? "其他进程正在运行此任务..." : busy ? "补充要求，Enter 中断当前任务并继续" : "描述任务，或粘贴图片、拖入文件"} rows={Math.min(4, Math.max(1, draft.split("\n").length))} />
                        <div className="composer-bottom">
                            <div className="composer-left"><button type="button" className="composer-attach" title="添加图片或文件" aria-label="添加文件" disabled={externalRun} onClick={chooseAttachments}><Icon name="plus" size={17} /></button>
                                <div className="permission-picker"><button type="button" className={`picker-trigger ${permissionMode === "bypassPermissions" ? "warning" : ""}`} aria-label="当前会话权限" aria-expanded={permissionPickerOpen} disabled={externalRun || quickSettingsSaving || permissionMode === "plan"} onClick={() => { setPermissionPickerOpen((current) => !current); setModelPickerOpen(false); }}>{permissionMode === "bypassPermissions" && <Icon name="alert" size={14} />}{permissionMode === "plan" ? "计划模式" : permissionMode === "bypassPermissions" ? "完全访问" : permissionMode === "desktopAcceptEdits" ? "自动接受编辑" : "默认 - 逐项确认"}<span className="picker-chevron"><Icon name="chevron" size={12} /></span></button>
                                    {permissionPickerOpen && <div className="composer-popover permission-popover" role="menu" aria-label="选择会话权限">{([{"mode": "desktopDefault", "label": "默认 - 逐项确认", "hint": "文件写入和命令执行前询问"}, {"mode": "desktopAcceptEdits", "label": "自动接受编辑", "hint": "文件编辑自动允许，命令仍需确认"}, {"mode": "bypassPermissions", "label": "完全访问", "hint": "自动运行工具，仍遵守明确拒绝规则"}] as const).map((choice) => <button type="button" role="menuitemradio" aria-checked={permissionMode === choice.mode} key={choice.mode} onClick={() => { setPermissionPickerOpen(false); void changePermissionMode(choice.mode); }}><span><strong>{choice.label}</strong><small>{choice.hint}</small></span>{permissionMode === choice.mode && <span className="picker-check">✓</span>}</button>)}</div>}
                                </div>
                            </div>
                            <div className="composer-right"><div className="context-picker" onMouseEnter={() => setContextPickerOpen(true)} onMouseLeave={() => setContextPickerOpen(false)}><button type="button" className="picker-trigger" aria-label="上下文用量" aria-expanded={contextPickerOpen}><ContextRing utilization={contextUsage ? contextUsage.utilization : null} /></button>
                                {contextPickerOpen && contextUsage && <div className="composer-popover context-popover" aria-label="上下文用量详情">
                                    <div className="context-popover-heading"><strong>上下文容量</strong><span>{formatTokenCount(contextUsage.estimatedTokens)} / {formatTokenCount(contextUsage.contextWindow)} ({Math.round(contextUsage.utilization * 100)}%)</span></div>
                                    <div className="context-popover-bar"><span style={{ width: `${Math.min(100, Math.round(contextUsage.utilization * 100))}%` }} /></div>
                                    <div className="context-popover-rows">
                                        {tokenUsage ? <>
                                            <div className="context-metric metric-input"><span className="context-metric-label">输入 tokens</span><strong>{tokenUsage.inputAvailable && !hasMissingPromptUsage(tokenUsage) ? formatTokenCount(tokenUsage.input) : "暂无数据"}</strong></div>
                                            <div className="context-metric metric-output"><span className="context-metric-label">输出 tokens</span><strong>{tokenUsage.outputAvailable ? formatTokenCount(tokenUsage.output) : "暂无数据"}</strong></div>
                                            <div className="context-metric metric-cache-read"><span className="context-metric-label">缓存读取</span><strong>{tokenUsage.cacheReadAvailable && !hasMissingPromptUsage(tokenUsage) ? formatTokenCount(tokenUsage.cacheRead) : "暂无数据"}</strong></div>
                                            <div className="context-metric metric-cache-write"><span className="context-metric-label">缓存写入</span><strong>{tokenUsage.cacheWriteAvailable && !hasMissingPromptUsage(tokenUsage) ? formatTokenCount(tokenUsage.cacheWrite) : "暂无数据"}</strong></div>
                                            <div className="context-metric metric-cache-hit"><span className="context-metric-label">平均缓存命中率</span><strong>{tokenUsage.cacheReadAvailable && tokenUsage.input + tokenUsage.cacheRead + tokenUsage.cacheWrite > 0 ? `${Math.round(tokenUsage.cacheHitRate * 100)}%` : "暂无数据"}</strong></div>
                                        </> : <div><span>发送任务后显示 token 用量。</span></div>}
                                    </div>
                                    <small className="context-popover-note">仅统计当前会话的模型窗口占用；服务商账户额度以账单为准。</small>
                                </div>}
                            </div>
                                <div className="model-picker"><button type="button" className="picker-trigger" aria-label="调整模型和思考强度" aria-expanded={modelPickerOpen} onClick={() => { setModelPickerOpen((current) => !current); setPermissionPickerOpen(false); }}>{sessionRoute?.modelPreset ?? sessionRoute?.model ?? "模型"} <span>{({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" } as Record<string, string>)[sessionRoute?.effort ?? "high"]}</span><span className="picker-chevron"><Icon name="chevron" size={12} /></span></button>
                                {modelPickerOpen && <div className="composer-popover model-popover" role="menu" aria-label="选择模型">
                                    {bootstrap?.modelPresets.length ? <div className="model-menu-list">{bootstrap.modelPresets.map((preset) => <button type="button" role="menuitemradio" aria-checked={sessionRoute?.modelPreset === preset.name} key={preset.name} disabled={!sessionRoute || busy || submitting || externalRun || quickSettingsSaving} onClick={() => { setModelPickerOpen(false); if (sessionRoute?.modelPreset !== preset.name) void changeSessionRoute(preset.name, effortChoice); }}><span>{preset.name}</span>{sessionRoute?.modelPreset === preset.name && <span className="picker-check">✓</span>}</button>)}</div>
                                    : <div className="model-menu-empty">还没有可用的模型预设，先到设置里配置一个模型。</div>}
                                    <div className="model-menu-divider" />
                                    <div className="effort-heading"><span>思考强度</span><strong>{({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" } as Record<string, string>)[effortChoice]}</strong></div>
                                    <input type="range" aria-label="当前会话思考强度" min={0} max={4} step={1} disabled={!sessionRoute || busy || submitting || externalRun || quickSettingsSaving} value={["low", "medium", "high", "xhigh", "max"].indexOf(effortChoice)} onChange={(event) => setEffortChoice(["low", "medium", "high", "xhigh", "max"][Number(event.target.value)])} onPointerUp={() => { if (effortChoice !== sessionRoute?.effort) void changeSessionRoute(sessionRoute?.modelPreset ?? null, effortChoice); }} onKeyUp={() => { if (effortChoice !== sessionRoute?.effort) void changeSessionRoute(sessionRoute?.modelPreset ?? null, effortChoice); }} />
                                    <div className="effort-scale"><span>低</span><span>高</span></div>
                                </div>}</div>
                                {(busy || submitting) && <button type="button" className="stop-button" onClick={() => void handleStop()}><span className="stop-square" />停止</button>}
                                <button type="submit" className="send-button" disabled={(!draft.trim() && attachments.length === 0) || externalRun || attachmentPending || submitting} aria-label={busy ? "中断并继续" : "发送消息"} title={externalRun ? "任务由另一个进程运行" : busy ? "中断当前任务，按补充要求继续" : "发送消息"}><Icon name="arrow" size={17} /></button>
                            </div>
                        </div>
                    </div>
                    {failedPrompt && !draft.trim() && !busy && !externalRun && <div className="composer-footer retry-actions">{failedTurnActivity?.safeToRetry === true && <button type="button" className="retry-prompt-button" title="仅在失败前未发起工具操作时可用；重用原请求，不新增用户消息。" onClick={() => void retryFailedPrompt()}>安全重试</button>}<button type="button" className="retry-prompt-button" onClick={restoreFailedPrompt}>恢复请求</button></div>}
                    {retryNotice && <div className="retry-disclosure" role="status">{retryNotice}</div>}
                </form>}
                </div>
                </div>
            </>}
            {error && <div className="toast-error" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError("")}><Icon name="close" size={14} /></button></div>}
            {pendingDialog && <div className="modal-scrim confirm-scrim" onMouseDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (pendingDialog.kind === "confirm") pendingDialog.resolve(false);
                else pendingDialog.resolve(null);
                setPendingDialog(null);
            }}>
                <section className="confirm-dialog" role="alertdialog" aria-modal="true">
                    {pendingDialog.kind === "prompt"
                        ? <form onSubmit={(event) => { event.preventDefault(); pendingDialog.resolve(pendingDialog.value.trim() || null); setPendingDialog(null); }}>
                            <strong>{pendingDialog.message}</strong>
                            <input autoFocus value={pendingDialog.value} onChange={(event) => setPendingDialog({ ...pendingDialog, value: event.target.value })} />
                            <div className="confirm-actions"><button type="button" className="secondary-button compact" onClick={() => { pendingDialog.resolve(null); setPendingDialog(null); }}>取消</button><button type="submit" className="primary-button compact">保存</button></div>
                        </form>
                        : <>
                            <strong>{pendingDialog.message}</strong>
                            <div className="confirm-actions"><button className="secondary-button compact" onClick={() => { pendingDialog.resolve(false); setPendingDialog(null); }}>取消</button><button autoFocus className={pendingDialog.danger ? "danger-button compact" : "primary-button compact"} onClick={() => { pendingDialog.resolve(true); setPendingDialog(null); }}>{pendingDialog.confirmLabel}</button></div>
                        </>}
                </section>
            </div>}
            <div className={`terminal-drawer ${terminalOpen ? "open" : ""}`} aria-hidden={!terminalOpen} inert={!terminalOpen} style={{ height: terminalOpen ? `${terminalHeight}px` : "0px" }}>
                {terminalMounted && terminalWorkspaceId && bootstrap && (() => {
                const workspace = bootstrap.workspaces.find((item) => item.id === terminalWorkspaceId);
                return workspace ? <TerminalPanel
                    key={workspace.id}
                    theme={resolvedTheme}
                    panelHeight={terminalHeight}
                    onPanelHeightChange={setTerminalHeight}
                    workspaceId={workspace.id}
                    workspaceName={workspace.name}
                    workspacePath={workspace.path}
                    confirm={confirmInApp}
                    onClose={toggleTerminal}
                    onCopySelection={(selection) => {
                        const text = selection.trimEnd();
                        const combined = draft.trim() ? `${draft.trimEnd()}\n${text}` : text;
                        if (combined.length > 100_000) {
                            setError("选中的终端内容超过输入上限，请缩小选区后重试。");
                            return;
                        }
                        setDraft(combined);
                    }}
                /> : null;
                })()}
            </div>
        </main>

        <div className="column-resizer inspector-resizer" role="separator" aria-orientation="vertical" aria-label="调整右侧面板宽度"
            aria-valuemin={230} aria-valuemax={720} aria-valuenow={panelWidths.inspector} tabIndex={0}
            onPointerDown={(event) => startPanelResize("inspector", event)}
            onPointerMove={(event) => movePanelResize("inspector", event)}
            onPointerUp={finishPanelResize} onPointerCancel={finishPanelResize} onLostPointerCapture={finishPanelResize}
            onKeyDown={(event) => resizePanelFromKeyboard("inspector", event)} />

        {activeWorkspace && <aside className="inspector" aria-label="工作区检查面板" aria-hidden={!inspectorOpen} inert={!inspectorOpen}>
            <div className="inspector-tabs">
                <div className="inspector-tablist" role="tablist" aria-label="检查面板" onKeyDown={handleTabListKeyDown}>
                    <button id="inspector-tab-changes" role="tab" aria-selected={rightPanel === "changes"} aria-controls="inspector-panel-content" tabIndex={rightPanel === "changes" ? 0 : -1} className={rightPanel === "changes" ? "selected" : ""} onClick={() => selectRightPanel("changes")}>改动{reviewView?.workspaceId === activeWorkspace.id && reviewView.sessionId === activeSession?.id && reviewView.snapshot.files.length > 0 ? <span>{reviewView.snapshot.files.length}</span> : gitView?.workspaceId === activeWorkspace.id && gitView.snapshot.isGit && gitView.snapshot.files.length > 0 && <span>{gitView.snapshot.files.length}</span>}</button>
                    <button id="inspector-tab-details" role="tab" aria-selected={rightPanel === "details"} aria-controls="inspector-panel-content" tabIndex={rightPanel === "details" ? 0 : -1} className={rightPanel === "details" ? "selected" : ""} onClick={() => selectRightPanel("details")}>会话信息</button>
                </div>
                <button className="inspector-collapse" title="收起右侧面板" aria-label="收起右侧面板" onClick={() => setInspectorOpen(false)}><Icon name="chevron" size={15} /></button>
            </div>
            <div id="inspector-panel-content" className="inspector-panel-content" role="tabpanel" aria-labelledby={`inspector-tab-${rightPanel}`} tabIndex={0}>
            {rightPanel === "changes" ? activeWorkspace.available
                ? <GitChangesPanel
                    workspaceId={activeWorkspace.id}
                    sessionId={activeSession?.id ?? null}
                    snapshot={gitView?.workspaceId === activeWorkspace.id ? gitView.snapshot : null}
                    review={reviewView?.workspaceId === activeWorkspace.id && reviewView.sessionId === activeSession?.id ? reviewView.snapshot : null}
                    loading={gitLoading || reviewLoading}
                    busy={busy}
                    onRefresh={async () => { await Promise.all([refreshGitSnapshot(activeWorkspace.id), activeSession ? refreshCodeReview(activeWorkspace.id, activeSession.id) : Promise.resolve()]); }}
                />
                : <div className="git-panel-state">工作区目录不可访问，无法读取 Git 状态。</div>
                : <div className="details-panel">
                {worktreeAssociation && <div className="detail-card worktree-info-card"><span className="detail-label">隔离工作区</span><strong>{worktreeAssociation.taskName}</strong><code>{worktreeAssociation.branchName}</code><small>基准 {worktreeAssociation.baseCommit.slice(0, 12)} · 源分支 {worktreeAssociation.sourceBranch || "分离头指针"}</small><code title={worktreeAssociation.sourcePath}>{worktreeAssociation.sourcePath}</code><button className="secondary-button compact" onClick={() => setWorktreeManagerOpen(true)}>审阅、合并或移除...</button><button className="secondary-button compact" disabled={!bootstrap?.workspaces.some((workspace) => workspace.id === worktreeAssociation.sourceWorkspaceId)} onClick={() => {
                    const source = bootstrap?.workspaces.find((workspace) => workspace.id === worktreeAssociation.sourceWorkspaceId);
                    if (source) void openWorkspace(source);
                }}>打开源工作区</button></div>}
                <div className="detail-card"><span className="detail-label">工作区</span><strong>{activeWorkspace.name}</strong><code>{activeWorkspace.path}</code></div>
                <div className="detail-card"><span className="detail-label">当前分支</span><strong>{activeWorkspace.branch || "非 Git 项目"}</strong></div>
                <div className="detail-card"><span className="detail-label">模型</span><strong>{sessionRoute?.modelPreset || sessionRoute?.model || "未配置"}</strong><small>{sessionRoute ? `${sessionRoute.model} · ${sessionRoute.protocol} · 思考 ${sessionRoute.effort}` : ""}</small></div>
                {contextUsage && <div className="detail-card"><span className="detail-label">上下文</span><strong>{Math.round(contextUsage.utilization * 100)}% 已使用</strong><small>剩余约 {formatTokenCount(contextUsage.remainingTokens)} tokens · 模型窗口 {formatTokenCount(contextUsage.contextWindow)}</small></div>}
                {tokenUsage && (tokenUsage.inputAvailable || tokenUsage.outputAvailable) && <div className="detail-card"><span className="detail-label">Token 用量</span><strong>{[tokenUsage.inputAvailable && !hasMissingPromptUsage(tokenUsage) ? `输入 ${formatTokenCount(tokenUsage.input)}` : "", tokenUsage.outputAvailable ? `输出 ${formatTokenCount(tokenUsage.output)}` : ""].filter(Boolean).join(" · ")}</strong><small>{usageDetails(tokenUsage)}</small></div>}
                <div className="detail-card"><span className="detail-label">权限模式</span><strong>{permissionMode === "plan" ? "计划模式" : permissionMode === "bypassPermissions" ? "完全访问" : permissionMode === "desktopAcceptEdits" ? "自动接受编辑" : "默认 - 逐项确认"}</strong><small>{permissionMode === "plan" ? "仅允许读取、提问和写计划文件。" : permissionMode === "bypassPermissions" ? "工具操作自动运行；用户或项目的明确拒绝规则仍然生效。" : permissionMode === "desktopAcceptEdits" ? "文件编辑自动允许；其他操作仍按规则确认。" : "读取自动允许；文件写入和命令执行需审批。"}</small></div>
                <div className="detail-card grant-card"><span className="detail-label">本会话授权</span>{permissionGrants.length === 0
                    ? <small>当前没有本会话授权。</small>
                    : <div className="grant-list">{permissionGrants.map((grant) => <div className="grant-row" key={grant.id}>
                        <div><strong>{grant.toolName}</strong><code>{grant.operation}</code></div>
                        <button className="danger-quiet" onClick={() => void revokePermissionGrant(grant.id)}>撤销</button>
                    </div>)}</div>}
                    {permissionGrants.length > 0 && <small>授权已随此会话保存；仅完全相同的工具参数会自动允许。撤销只阻止后续匹配操作，不会停止已启动的程序。</small>}
                </div>
                <div className="detail-card"><span className="detail-label">会话状态</span><strong>{activeSession?.status === "interrupted" ? "上次意外中断"
                    : activeSession?.status === "cancelled" ? "上次任务已停止"
                        : activeSession?.status === "failed" ? "上次请求失败" : statusLabel}</strong></div>
                <button className="settings-inline" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={15} />打开模型与连接设置<Icon name="arrow" size={14} /></button>
            </div>}
            </div>
        </aside>}
        </div>

        {settingsOpen && bootstrap && <SettingsDialog
            settings={bootstrap.settings}
            modelPresets={bootstrap.modelPresets}
            credentialState={bootstrap.credentialState}
            theme={theme}
            fontScale={fontScale}
            usage={tokenUsage}
            contextUsage={contextUsage}
            permissionMode={permissionMode}
            onClose={() => setSettingsOpen(false)}
            onThemeChanged={setTheme}
            onFontScaleChanged={setFontScale}
            onPermissionModeChanged={(mode) => void changePermissionMode(mode)}
            onSettingsSaved={(settings) => {
                setBootstrap((current) => current ? { ...current, settings } : current);
                void window.desktop.getBootstrap().then(setBootstrap).catch(() => undefined);
            }}
            onCredentialChanged={(credentialState, presetName) => {
                setBootstrap((current) => current
                    && current.settings.modelPreset === presetName ? { ...current, credentialState } : current);
                if (sessionRoute?.modelPreset === presetName) setSessionCredentialState(credentialState);
            }}
            onError={setError}
        />}
        {taskCenterOpen && <TaskCenterDialog
            data={taskCenterData}
            loading={taskCenterLoading}
            error={taskCenterError}
            onClose={() => setTaskCenterOpen(false)}
            onRefresh={() => void refreshTaskCenter()}
            onOpen={(task) => void openTask(task)}
            onStop={stopTask}
        />}
        {activeWorkspace && gitGraphHistory?.workspaceId === activeWorkspace.id && <GitGraphDialog key={activeWorkspace.id} workspace={activeWorkspace} initialHistory={gitGraphHistory.history} onClose={() => { setGitGraphHistory(null); gitBranchButtonRef.current?.focus(); }} />}
        {worktreeDialogOpen && activeWorkspace && <NewWorktreeDialog
            workspace={activeWorkspace}
            onClose={() => setWorktreeDialogOpen(false)}
            onCreated={async (result) => {
                setWorktreeDialogOpen(false);
                try {
                    setBootstrap(await window.desktop.getBootstrap());
                    setError("");
                    await openWorkspace(result.workspace, false);
                } catch (failure) { setError(displayError(failure)); }
            }}
        />}
        {worktreeManagerOpen && activeWorkspace && worktreeAssociation && <WorktreeManagementDialog
            workspace={activeWorkspace}
            association={worktreeAssociation}
            sourceWorkspace={bootstrap?.workspaces.find((workspace) => workspace.id === worktreeAssociation.sourceWorkspaceId) ?? null}
            onClose={() => setWorktreeManagerOpen(false)}
            onOpenSourceTerminal={async (source) => {
                setWorktreeManagerOpen(false);
                await openWorkspace(source, false);
                setTerminalWorkspaceId(source.id);
                setTerminalOpen(true);
            }}
            onRemoved={async (sourceWorkspaceId) => {
                setWorktreeManagerOpen(false);
                const next = await window.desktop.getBootstrap();
                setBootstrap(next);
                const source = next.workspaces.find((workspace) => workspace.id === sourceWorkspaceId);
                if (source) await openWorkspace(source, false);
            }}
        />}
    </div>;
}

function SettingsDialog({
    settings,
    modelPresets,
    credentialState,
    theme,
    fontScale,
    usage,
    contextUsage,
    permissionMode,
    onClose,
    onThemeChanged,
    onFontScaleChanged,
    onPermissionModeChanged,
    onSettingsSaved,
    onCredentialChanged,
    onError,
}: {
    settings: DesktopSettings;
    modelPresets: DesktopModelPreset[];
    credentialState: CredentialState;
    theme: AppTheme;
    fontScale: number;
    usage: AgentUsage | null;
    contextUsage: AgentContextUsage | null;
    permissionMode: OpenSessionData["permissionMode"];
    onClose: () => void;
    onThemeChanged: (theme: AppTheme) => void;
    onFontScaleChanged: (scale: number) => void;
    onPermissionModeChanged: (mode: "desktopDefault" | "desktopAcceptEdits" | "bypassPermissions") => void;
    onSettingsSaved: (settings: DesktopSettings) => void;
    onCredentialChanged: (state: CredentialState, presetName: string | null) => void;
    onError: (message: string) => void;
}) {
    const [form, setForm] = useState(settings);
    const [section, setSection] = useState<"general" | "appearance" | "usage" | "model">("general");
    const [key, setKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState("");
    const [testSucceeded, setTestSucceeded] = useState(false);
    const [saved, setSaved] = useState(false);
    const [routeCredentialState, setRouteCredentialState] = useState(credentialState);
    const credentialLookup = useRef(0);
    const dialogRef = useRef<HTMLElement | null>(null);
    const previousFocus = useRef<HTMLElement | null>(null);

    useEffect(() => {
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialogRef.current?.querySelector<HTMLElement>("select, input, button")?.focus();
        return () => previousFocus.current?.focus();
    }, []);

    const refreshCredentialState = async (presetName: string | null) => {
        const lookup = ++credentialLookup.current;
        try {
            const state = await window.desktop.getCredentialState(presetName);
            if (lookup === credentialLookup.current) setRouteCredentialState(state);
        } catch (failure) { onError(displayError(failure)); }
    };

    useEffect(() => {
        if (form.modelPreset === settings.modelPreset) setRouteCredentialState(credentialState);
    }, [credentialState, form.modelPreset, settings.modelPreset]);

    const update = <K extends keyof DesktopSettings>(field: K, value: DesktopSettings[K]) => {
        const clearsPreset = ["model", "apiBase", "protocol", "auth"].includes(field);
        setForm((current) => ({
            ...current,
            [field]: value,
            ...(clearsPreset ? { modelPreset: null } : {}),
        }));
        setSaved(false);
        setTestResult("");
        setTestSucceeded(false);
        if (clearsPreset && form.modelPreset !== null) void refreshCredentialState(null);
    };
    const chooseModelPreset = (name: string) => {
        if (!name) {
            update("modelPreset", null);
            void refreshCredentialState(null);
            return;
        }
        const preset = modelPresets.find((item) => item.name === name);
        if (!preset) return;
        setForm((current) => ({
            ...current,
            modelPreset: preset.name,
            model: preset.model,
            apiBase: preset.apiBase ?? current.apiBase,
            protocol: preset.protocol ?? current.protocol,
            auth: preset.auth ?? current.auth,
            contextWindow: preset.contextWindow ?? current.contextWindow,
        }));
        setSaved(false);
        setTestResult("");
        setTestSucceeded(false);
        void refreshCredentialState(preset.name);
    };
    const saveSettings = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        try {
            const result = await window.desktop.saveSettings(form);
            setForm(result);
            onSettingsSaved(result);
            void refreshCredentialState(result.modelPreset);
            setSaved(true);
            setTestResult("");
            setTestSucceeded(false);
        } catch (failure) { onError(displayError(failure)); }
        finally { setSaving(false); }
    };
    const testConnection = async () => {
        setTesting(true);
        setTestResult("");
        try {
            const settings = await window.desktop.saveSettings(form);
            setForm(settings);
            onSettingsSaved(settings);
            const result = await window.desktop.testConnection();
            setTestResult(result.message);
            setTestSucceeded(result.ok);
        } catch (failure) {
            setTestResult(displayError(failure));
            setTestSucceeded(false);
        } finally { setTesting(false); }
    };
    const saveKey = async () => {
        if (!key.trim()) return;
        try {
            const state = await window.desktop.saveApiKey(key, form.modelPreset);
            setKey("");
            setRouteCredentialState(state);
            onCredentialChanged(state, form.modelPreset);
            setSaved(false);
            setTestResult("");
            setTestSucceeded(false);
        } catch (failure) { onError(displayError(failure)); }
    };
    const importCliKey = async () => {
        try {
            const state = await window.desktop.importCliCredential(form.modelPreset);
            setRouteCredentialState(state);
            onCredentialChanged(state, form.modelPreset);
            setTestResult("");
            setTestSucceeded(false);
        }
        catch (failure) { onError(displayError(failure)); }
    };
    const clearKey = async () => {
        try {
            const state = await window.desktop.clearApiKey(form.modelPreset);
            setRouteCredentialState(state);
            onCredentialChanged(state, form.modelPreset);
            setTestResult("");
            setTestSucceeded(false);
        }
        catch (failure) { onError(displayError(failure)); }
    };

    return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
                if (event.key !== "Tab") return;
                const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled):not([type='hidden']), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])") ?? [])]
                    .filter((element) => element.getClientRects().length > 0);
                const first = focusable[0];
                const last = focusable.at(-1);
                const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
                if (!first) { event.preventDefault(); dialogRef.current?.focus(); }
                else if (activeIndex < 0) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
                else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            }}>
            <aside className="settings-sidebar"><strong>设置</strong><span>个人</span><nav className="settings-nav" aria-label="设置分类"><button className={section === "general" ? "selected" : ""} onClick={() => setSection("general")}>常规</button><button className={section === "appearance" ? "selected" : ""} onClick={() => setSection("appearance")}>外观</button><button className={section === "usage" ? "selected" : ""} onClick={() => setSection("usage")}>使用情况</button><button className={section === "model" ? "selected" : ""} onClick={() => setSection("model")}>模型与连接</button></nav></aside>
            <div className="settings-main"><div className="settings-heading"><div><h2 id="settings-title">{section === "general" ? "常规" : section === "appearance" ? "外观" : section === "usage" ? "使用情况" : "模型与连接"}</h2><p>{section === "usage" ? "查看当前会话的模型用量" : "设置只保存在这台设备上"}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭设置"><Icon name="close" /></button></div>
            <form onSubmit={(event) => void saveSettings(event)}>
                {section === "general" && <div className="settings-page"><section className="settings-section"><h3>权限</h3><div className="settings-list"><div className="settings-row stacked"><div><strong>当前会话权限</strong><small>可随时调整；任务运行中切换会立即对后续操作生效。</small></div><div className="settings-permission-options">{([{"mode": "desktopDefault", "label": "默认", "hint": "逐项确认"}, {"mode": "desktopAcceptEdits", "label": "接受编辑", "hint": "命令仍需确认"}, {"mode": "bypassPermissions", "label": "完全访问", "hint": "工具免审批"}] as const).map((choice) => <button type="button" key={choice.mode} className={permissionMode === choice.mode ? "selected" : ""} disabled={permissionMode === "plan"} aria-pressed={permissionMode === choice.mode} onClick={() => onPermissionModeChanged(choice.mode)}><strong>{choice.label}</strong><small>{choice.hint}</small></button>)}</div></div></div></section><section className="settings-section"><h3>任务</h3><div className="settings-list"><label className="settings-row"><span><strong>同时运行上限</strong><small>不同工作区可并行，同一工作树一次运行一个任务。</small></span><select value={form.maxParallelRuns} onChange={(event) => update("maxParallelRuns", Number(event.target.value))}>{Array.from({ length: 8 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count} 个任务</option>)}</select></label></div><div className="settings-actions settings-page-actions"><button className="primary-button" disabled={saving}>{saving ? "保存中..." : saved ? "已保存" : "保存设置"}</button></div></section></div>}
                {section === "appearance" && <section className="settings-section" aria-labelledby="appearance-heading"><h3 id="appearance-heading">外观</h3><div className="settings-list"><div className="settings-row stacked"><div><strong>应用主题</strong><small>跟随系统会在系统外观变化时自动切换。</small></div><div className="appearance-options" role="group" aria-label="外观主题">{(["system", "light", "dark"] as const).map((option) => <button key={option} type="button" className={theme === option ? "selected" : ""} aria-pressed={theme === option} onClick={() => onThemeChanged(option)}>{option === "system" ? "跟随系统" : option === "light" ? "浅色" : "深色"}</button>)}</div></div><label className="settings-row"><span><strong>界面字号</strong><small>同时调整对话、导航和面板文字。</small></span><select aria-label="界面字号" value={fontScale} onChange={(event) => onFontScaleChanged(Number(event.target.value))}><option value={1}>标准</option><option value={1.1}>较大</option><option value={1.2}>最大</option></select></label></div></section>}
                {section === "usage" && <section className="settings-section usage-section"><h3>当前会话用量</h3>{usage ? <><div className="usage-grid"><div><span>输入 tokens</span><strong>{usage.inputAvailable && !hasMissingPromptUsage(usage) ? usage.input.toLocaleString("en-US") : "暂无数据"}</strong></div><div><span>输出 tokens</span><strong>{usage.outputAvailable ? usage.output.toLocaleString("en-US") : "暂无数据"}</strong></div><div><span>缓存读取</span><strong>{usage.cacheReadAvailable && !hasMissingPromptUsage(usage) ? usage.cacheRead.toLocaleString("en-US") : "暂无数据"}</strong></div><div><span>缓存写入</span><strong>{usage.cacheWriteAvailable && !hasMissingPromptUsage(usage) ? usage.cacheWrite.toLocaleString("en-US") : "暂无数据"}</strong></div></div>{contextUsage && <div className="usage-context"><span>上下文已用 {Math.round(contextUsage.utilization * 100)}%</span><progress value={contextUsage.utilization} max={1} /></div>}</> : <p>打开会话后可查看模型返回的用量。</p>}<p>这些数字仅统计当前会话；服务商账户限额和剩余额度以服务商账单为准。</p></section>}
                {section === "model" && <><section className="settings-section" aria-labelledby="model-heading"><h3 id="model-heading">模型与连接</h3>
                <div className="settings-form-grid">
                    <label className="field wide"><span>命名模型预设</span><select value={form.modelPreset ?? ""} onChange={(event) => chooseModelPreset(event.target.value)} disabled={modelPresets.length === 0}><option value="">自定义配置</option>{modelPresets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name}</option>)}</select>
                        <small className="field-help">{modelPresets.find((preset) => preset.name === form.modelPreset)?.hasApiKey
                            ? "此预设在 CLI 配置中包含 API Key，可安全导入到此预设专属槽位。手动输入的密钥不会被预设覆盖。"
                            : modelPresets.length === 0 ? "未找到 CLI 命名预设。可在 ~/.triumcode/config.json 的 models 字段中配置。"
                                : "预设来自 CLI 配置；手动修改模型路由字段后会切换为自定义配置。"}</small>
                    </label>
                    <label className="field wide"><span>API 协议</span><select value={form.protocol} onChange={(event) => update("protocol", event.target.value as DesktopSettings["protocol"])}><option value="anthropic">Anthropic Messages</option><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select></label>
                    <label className="field wide"><span>模型名称</span><input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="例如 claude-sonnet-4-20250514" maxLength={200} /></label>
                    <label className="field wide"><span>API Base URL</span><input value={form.apiBase} onChange={(event) => update("apiBase", event.target.value)} placeholder="https://api.anthropic.com" maxLength={2000} /></label>
                    <label className="field"><span>认证方式</span><select value={form.auth} onChange={(event) => update("auth", event.target.value as DesktopSettings["auth"])}><option value="api-key">API Key Header</option><option value="bearer">Bearer Token</option></select></label>
                    <label className="field"><span>思考深度</span><select value={form.effort} onChange={(event) => update("effort", event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="max">最大</option></select></label>
                    <label className="field"><span>上下文窗口 (tokens)</span><input type="number" min={1024} max={10000000} step={1} value={form.contextWindow} onChange={(event) => update("contextWindow", Number(event.target.value))} /></label>
                    <label className="toggle-row"><input type="checkbox" checked={form.thinking} onChange={(event) => update("thinking", event.target.checked)} /><span><strong>启用扩展思考</strong><small>支持时向模型发送思考深度参数。</small></span></label>
                </div>
                </section>
                <div className="settings-divider" />
                <div className="credential-header"><div><strong>API 密钥</strong><small>{credentialLabel(routeCredentialState)}</small></div>{routeCredentialState === "secure-key" && <button type="button" className="text-button danger-text" onClick={() => void clearKey()}>删除</button>}</div>
                <div className="key-entry"><input type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={routeCredentialState === "secure-key" ? "此路由已设置密钥，可输入新密钥替换" : "粘贴 API 密钥"} maxLength={10000} /><button type="button" className="secondary-button compact" disabled={!key.trim()} onClick={() => void saveKey()}>安全保存</button></div>
                {routeCredentialState === "cli-key-available" && <button type="button" className="text-button import-key" onClick={() => void importCliKey()}>从现有 CLI 配置安全导入密钥</button>}
                <div className="settings-footer">
                    <div className={`test-result ${testResult ? (testSucceeded ? "success" : "failure") : ""}`}>{testResult || "连接测试会发送一条很短的请求，并可能产生少量模型费用。"}</div>
                    <div className="settings-actions"><button type="button" className="secondary-button" disabled={testing} onClick={() => void testConnection()}>{testing ? "正在测试..." : "测试连接"}</button><button className="primary-button" disabled={saving}>{saving ? "保存中..." : saved ? "已保存" : "保存设置"}</button></div>
                </div>
                </>}
            </form>
            </div>
        </section>
    </div>;
}
