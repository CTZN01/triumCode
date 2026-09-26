import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Agent, type AgentContextUsage, type AgentEvent, type AgentFailureCategory, type AgentUsage } from "../../../src/agent.js";
import { getModelPresets } from "../../../src/config.js";
import { DesktopEventSequencer } from "../../../src/desktop-events.js";
import { createProvider } from "../../../src/providers/index.js";
import {
    parsePermissionSource,
    type PermissionOutcome,
    type PermissionRequest,
    type PermissionSource,
    type SessionPermissionGrant,
} from "../../../src/permissions.js";
import { SessionBusyError, SessionConflictError, SessionStore, type DesktopSessionSettings, type DesktopUsageSnapshot, type SessionActivity, type SessionData, type SessionIndex } from "../../../src/session.js";
import type { EffortLevel } from "../../../src/thinking.js";
import type {
    BootstrapData,
    ConversationMessage,
    DesktopEvent,
    DesktopEventPayload,
    DesktopSettings,
    DesktopTaskCenterData,
    GitFileDiff,
    GitSnapshot,
    CodeReviewSnapshot,
    CreateWorktreeRequest,
    CreateWorktreeResult,
    OpenSessionData,
    PendingPermissionRequest,
    PendingUserQuestion,
    PermissionChoice,
    SessionSummary,
    WorktreeAssociation,
    WorktreeMergeResult,
    WorktreeRemovalResult,
    WorktreeReviewSnapshot,
    WorktreeSetupData,
    WorkspaceSummary,
} from "../shared/contracts.js";
import { updateQuestionActivity } from "../shared/question-activity.js";
import { desktopTaskStatus } from "./task-status.js";
import { connectionFailureMessage } from "./connection-result.js";
import { RunShutdown } from "./run-shutdown.js";
import { redactConfiguredKey, redactSessionMessages, type RedactionKeys } from "./secret-redaction.js";
import { CredentialStore } from "./credential-store.js";
import {
    commitGitChanges as createGitCommit,
    readGitDiff,
    readGitSnapshot,
    stageGitPath as stageWorkspaceGitPath,
    unstageGitPath as unstageWorkspaceGitPath,
} from "./git-service.js";
import { ReviewService } from "./review-service.js";
import { SettingsStore } from "./settings-store.js";
import {
    createGitWorktree,
    getWorktreeSetup as inspectWorktreeSetup,
    mergeGitWorktree,
    readWorktreeReview,
    removeGitWorktree,
} from "./worktree-service.js";
import { WorktreeStore } from "./worktree-store.js";
import { DesktopServiceError, WorkspaceStore } from "./workspace-store.js";

interface PendingPermission {
    workspaceId: string;
    sessionId: string;
    requestId: string;
    toolCallId: string;
    toolName: string;
    operation: Record<string, unknown>;
    message: string;
    source: PermissionSource;
    key?: string;
    resolve: (grant: "once" | "session" | false) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
    workspaceId: string;
    sessionId: string;
    requestId: string;
    question: string;
    options?: string[];
    resolve: (answer: string) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface SessionRuntime {
    workspaceId: string;
    workspaceRoot: string;
    sessionId: string;
    desktopSettings: DesktopSessionSettings;
    revision: number;
    store: SessionStore;
    agent: Agent;
    apiKey: string;
    redactionKeys: string[];
    currentRunId: string | null;
    runPromise: Promise<void> | null;
    releaseRunLease: (() => void) | null;
    cancelRequested: boolean;
    reviewCaptureEnabled: boolean;
    partialAssistantText: string | null;
    activities: SessionActivity[];
    sessionPersistWarningShown: boolean;
    sessionRevisionConflict: boolean;
}

function emptyAgentUsage(): AgentUsage {
    return {
        input: 0,
        inputAvailable: false,
        output: 0,
        outputAvailable: false,
        cacheRead: 0,
        cacheReadAvailable: false,
        cacheWrite: 0,
        cacheWriteAvailable: false,
        cacheHitRate: 0,
        cost: 0,
    };
}

function safeDesktopUsage(value: unknown): DesktopUsageSnapshot | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    const count = (name: string): number | null => {
        const candidate = source[name];
        return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
    };
    const input = count("input");
    const output = count("output");
    const cacheRead = count("cacheRead");
    const cacheWrite = count("cacheWrite");
    const contextTokens = count("contextTokens");
    return {
        input: input ?? 0,
        inputAvailable: source.inputAvailable === true && input !== null,
        output: output ?? 0,
        outputAvailable: source.outputAvailable === true && output !== null,
        cacheRead: cacheRead ?? 0,
        cacheReadAvailable: source.cacheReadAvailable === true && cacheRead !== null,
        cacheWrite: cacheWrite ?? 0,
        cacheWriteAvailable: source.cacheWriteAvailable === true && cacheWrite !== null,
        ...(contextTokens === null ? {} : { contextTokens }),
    };
}

function safeSessionPermissionGrants(value: unknown, apiKey: RedactionKeys = ""): SessionPermissionGrant[] {
    if (!Array.isArray(value)) return [];
    const grants: SessionPermissionGrant[] = [];
    for (const entry of value.slice(-200)) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const timestamp = typeof item.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt))
            ? item.createdAt : null;
        if (typeof item.id !== "string"
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id)
            || typeof item.key !== "string" || !/^[a-f0-9]{64}$/i.test(item.key)
            || typeof item.toolName !== "string" || !item.toolName || item.toolName.length > 120
            || typeof item.operation !== "string" || !timestamp) continue;
        grants.push({
            id: item.id,
            key: item.key,
            toolName: item.toolName,
            operation: redact(item.operation, apiKey).slice(0, 2_000),
            createdAt: timestamp,
        });
    }
    return grants;
}

function usageSnapshot(usage: AgentUsage, context: AgentContextUsage | null): DesktopUsageSnapshot {
    return {
        input: usage.input,
        inputAvailable: usage.inputAvailable,
        output: usage.output,
        outputAvailable: usage.outputAvailable,
        cacheRead: usage.cacheRead,
        cacheReadAvailable: usage.cacheReadAvailable,
        cacheWrite: usage.cacheWrite,
        cacheWriteAvailable: usage.cacheWriteAvailable,
        ...(context === null ? {} : { contextTokens: context.estimatedTokens }),
    };
}

function sessionKey(workspaceId: string, sessionId: string): string {
    return `${workspaceId}:${sessionId}`;
}

function redact(value: string, apiKey: RedactionKeys = ""): string {
    return redactConfiguredKey(value, apiKey)
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
        .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
        .replace(/\b(api[_-]?key|token|password|secret)(\s*[=:]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
        .replace(/(--?(?:api[-_]?key|token|password|secret)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
        .replace(/(--?(?:api[-_]?key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]");
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function safeToolInput(name: string, input: Record<string, any>, workspaceRoot?: string, apiKey: RedactionKeys = ""): Record<string, unknown> {
    if (name === "run_command") {
        const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : ".";
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return {
            command: redact(stringValue(input.command), apiKey),
            args: args.map((arg, index) => /^--?(?:api[-_]?key|token|password|secret)$/i.test(args[index - 1] ?? "")
                ? "[REDACTED]" : redact(arg, apiKey).slice(0, 240)),
            cwd: workspaceRoot ? redact(resolve(workspaceRoot, cwd), apiKey) : typeof input.cwd === "string" ? redact(input.cwd, apiKey) : undefined,
        };
    }
    const rawFile = typeof input.file_path === "string" ? input.file_path
        : typeof input.path === "string" ? input.path : undefined;
    const file = rawFile ? redact(workspaceRoot ? resolve(workspaceRoot, rawFile) : rawFile, apiKey) : undefined;
    if (name === "write_file") {
        return { file_path: file, bytes: Buffer.byteLength(stringValue(input.content), "utf-8") };
    }
    if (name === "edit_file") {
        return {
            file_path: file,
            oldCharacters: stringValue(input.old_string).length,
            newCharacters: stringValue(input.new_string).length,
        };
    }
    if (name === "multi_edit") {
        return { file_path: file, editCount: Array.isArray(input.edits) ? input.edits.length : 0 };
    }
    const summary: Record<string, unknown> = {};
    for (const key of ["file_path", "path", "pattern", "operation", "name", "type", "question", "options", "offset", "limit", "staged", "cwd"]) {
        const value = input[key];
        if (typeof value === "string") summary[key] = redact(value, apiKey).slice(0, 240);
        else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
        else if (key === "options" && Array.isArray(value)) summary[key] = value.map((entry: unknown) => redact(String(entry), apiKey).slice(0, 160));
    }
    return summary;
}

function safeAgentEvent(event: AgentEvent, workspaceRoot?: string, apiKey: RedactionKeys = ""): AgentEvent {
    if (event.type === "assistant.delta") return { ...event, text: redact(event.text, apiKey) };
    if (event.type === "tool.started" || event.type === "tool.completed") {
        const input = safeToolInput(event.name, event.input, workspaceRoot, apiKey);
        if (event.type === "tool.started") return { ...event, input } as AgentEvent;
        return { ...event, input, output: redact(event.output, apiKey) } as AgentEvent;
    }
    if (event.type === "permission.checked") {
        const source = safePermissionSource(event.source, apiKey);
        return { ...event, input: safeToolInput(event.name, event.input, workspaceRoot, apiKey), source };
    }
    if (event.type === "notice") return { ...event, text: redact(event.text, apiKey) };
    if (event.type === "turn.failed") return { ...event, message: redact(event.message, apiKey) };
    if (event.type === "plan.review") return { ...event, content: redact(event.content, apiKey) };
    if (event.type === "subagent.failed") return { ...event, error: redact(event.error, apiKey) };
    return event;
}

function safePermissionSource(value: unknown, apiKey: RedactionKeys = ""): PermissionSource {
    const source = parsePermissionSource(value);
    if (!source) throw new Error("Invalid permission source.");
    return source.kind === "rule" ? { ...source, rule: redact(source.rule, apiKey).slice(0, 300) } : source;
}

const MAX_SESSION_ACTIVITIES = 200;
const MAX_ACTIVITY_DETAIL_CHARS = 4_000;
const MAX_ACTIVITY_OUTPUT_CHARS = 8_000;

function limitedText(value: string, limit: number, apiKey: RedactionKeys = ""): string {
    const safe = redact(value, apiKey);
    return safe.length <= limit ? safe : `${safe.slice(0, limit)}\n[已截断]`;
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

function safeSessionActivities(value: unknown, apiKey: RedactionKeys = ""): SessionActivity[] {
    if (!Array.isArray(value)) return [];
    const result: SessionActivity[] = [];
    for (const entry of value.slice(-MAX_SESSION_ACTIVITIES)) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const allowedStates: SessionActivity["state"][] = ["running", "complete", "denied", "failed", "notice", "interrupted"];
        if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.detail !== "string"
            || typeof item.state !== "string" || !allowedStates.includes(item.state as SessionActivity["state"])) continue;
        const timestamp = (candidate: unknown): string | undefined => typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))
            ? candidate : undefined;
        result.push({
            id: limitedText(item.id, 200, apiKey),
            ...(typeof item.runId === "string" ? { runId: limitedText(item.runId, 200, apiKey) } : {}),
            title: limitedText(item.title, 120, apiKey),
            detail: limitedText(item.detail, MAX_ACTIVITY_DETAIL_CHARS, apiKey),
            state: item.state as SessionActivity["state"],
            ...(typeof item.output === "string" ? { output: limitedText(item.output, MAX_ACTIVITY_OUTPUT_CHARS, apiKey) } : {}),
            ...(typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0
                ? { durationMs: Math.min(item.durationMs, 86_400_000) } : {}),
            ...(timestamp(item.startedAt) ? { startedAt: timestamp(item.startedAt) } : {}),
            ...(timestamp(item.updatedAt) ? { updatedAt: timestamp(item.updatedAt) } : {}),
            ...(parsePermissionSource(item.permissionSource)
                ? { permissionSource: safePermissionSource(item.permissionSource, apiKey) } : {}),
            ...(item.permissionDecision === "allow" || item.permissionDecision === "deny" || item.permissionDecision === "confirm"
                ? { permissionDecision: item.permissionDecision } : {}),
            ...(item.permissionOutcome === "once" || item.permissionOutcome === "session" || item.permissionOutcome === "denied"
                || item.permissionOutcome === "expired" || item.permissionOutcome === "cancelled"
                ? { permissionOutcome: item.permissionOutcome } : {}),
            ...(typeof item.permissionGrantRevoked === "boolean" ? { permissionGrantRevoked: item.permissionGrantRevoked } : {}),
            ...(item.failureCategory === "network" || item.failureCategory === "authentication" || item.failureCategory === "rate-limit"
                || item.failureCategory === "provider" || item.failureCategory === "internal"
                ? { failureCategory: item.failureCategory } : {}),
            ...(typeof item.retryable === "boolean" ? { retryable: item.retryable } : {}),
            ...(typeof item.safeToRetry === "boolean" ? { safeToRetry: item.safeToRetry } : {}),
        });
    }
    return result;
}

function activityFromEvent(
    activities: SessionActivity[],
    event: AgentEvent,
    runId?: string,
): SessionActivity[] | null {
    const now = new Date().toISOString();
    const upsert = (activity: SessionActivity): SessionActivity[] => {
        const existingIndex = activities.findIndex((item) => item.id === activity.id);
        const next = [...activities];
        if (existingIndex < 0) next.push(activity);
        else next[existingIndex] = { ...next[existingIndex], ...activity, startedAt: next[existingIndex].startedAt ?? activity.startedAt };
        return next.slice(-MAX_SESSION_ACTIVITIES);
    };
    const makeActivity = (
        id: string,
        title: string,
        detail: string,
        state: SessionActivity["state"],
        extra: Pick<SessionActivity,
            "output" | "durationMs" | "permissionSource" | "permissionDecision" | "permissionOutcome"
            | "failureCategory" | "retryable" | "safeToRetry"> = {},
    ): SessionActivity => ({
        id,
        ...(runId ? { runId } : {}),
        title: limitedText(title, 120),
        detail: limitedText(detail, MAX_ACTIVITY_DETAIL_CHARS),
        state,
        ...("output" in extra && extra.output !== undefined ? { output: limitedText(extra.output, MAX_ACTIVITY_OUTPUT_CHARS) } : {}),
            ...(extra.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.min(extra.durationMs, 86_400_000)) }),
            ...(extra.permissionSource === undefined ? {} : { permissionSource: extra.permissionSource }),
            ...(extra.permissionDecision === undefined ? {} : { permissionDecision: extra.permissionDecision }),
            ...(extra.permissionOutcome === undefined ? {} : { permissionOutcome: extra.permissionOutcome }),
            ...(extra.failureCategory === undefined ? {} : { failureCategory: extra.failureCategory }),
            ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
            ...(extra.safeToRetry === undefined ? {} : { safeToRetry: extra.safeToRetry }),
            startedAt: activities.find((item) => item.id === id)?.startedAt ?? now,
            updatedAt: now,
    });

    if (event.type === "tool.started") {
        return upsert(makeActivity(event.id, event.name, JSON.stringify(event.input, null, 2) ?? "{}", "running"));
    }
    if (event.type === "tool.completed") {
        const state: SessionActivity["state"] = event.outcome === "denied" ? "denied"
            : event.outcome === "cancelled" ? "interrupted"
                : event.outcome === "failed" ? "failed" : "complete";
        return upsert(makeActivity(
            event.id,
            event.name,
            JSON.stringify(event.input, null, 2) ?? "{}",
            state,
            { output: event.output, durationMs: event.durationMs },
        ));
    }
    if (event.type === "permission.checked") {
        return upsert(makeActivity(
            event.id,
            event.name,
            JSON.stringify(event.input, null, 2) ?? "{}",
            event.action === "deny" ? "denied" : "running",
            { permissionSource: safePermissionSource(event.source), permissionDecision: event.action },
        ));
    }
    if (event.type === "notice") {
        return upsert(makeActivity(randomUUID(), event.level === "warning" ? "需要留意" : "提示", event.text, "notice"));
    }
    if (event.type === "context.compaction.started") {
        return upsert(makeActivity(`context-${event.id}`, "整理上下文", "上下文接近可用窗口上限，正在整理较早的对话。", "running"));
    }
    if (event.type === "context.compaction.completed") {
        return upsert(makeActivity(`context-${event.id}`, "整理上下文", "对话整理完成，将继续当前任务。", "complete"));
    }
    if (event.type === "plan.review") {
        return upsert(makeActivity(randomUUID(), "计划待审核", event.content, "notice"));
    }
    if (event.type === "plan.mode" && !event.enabled) {
        return upsert(makeActivity(randomUUID(), "已退出计划模式", "当前权限为默认确认。文件写入和程序执行仍会逐项请求批准。", "notice"));
    }
    if (event.type === "subagent.started") {
        return upsert(makeActivity(`sub-${event.id}`, `${event.name} 子代理`, event.description, "running"));
    }
    if (event.type === "subagent.completed") {
        const tokenDetail = event.tokens === null ? "" : `\n\n消耗 ${event.tokens} tokens`;
        return upsert(makeActivity(`sub-${event.id}`, `${event.name} 子代理`, `${event.description}${tokenDetail}`, "complete"));
    }
    if (event.type === "subagent.failed") {
        return upsert(makeActivity(`sub-${event.id}`, `${event.name} 子代理`, event.error, "failed"));
    }
    if (event.type === "turn.failed") {
        return upsert(makeActivity(randomUUID(), `任务失败 - ${failureCategoryLabel(event.category)}`, event.message, "failed", {
            failureCategory: event.category,
            retryable: event.retryable,
            safeToRetry: event.safeToRetry,
        }));
    }
    if (event.type === "turn.cancelled") {
        return upsert(makeActivity(randomUUID(), "任务已停止", "任务已停止，已完成的文件改动仍保留在工作区。", "notice"));
    }
    return null;
}

function projectMessages(messages: unknown[], apiKey: RedactionKeys = ""): ConversationMessage[] {
    const visible: ConversationMessage[] = [];
    for (const [index, value] of messages.entries()) {
        if (!value || typeof value !== "object") continue;
        const message = value as { role?: unknown; content?: unknown };
        if (message.role !== "user" && message.role !== "assistant") continue;
        const blocks = typeof message.content === "string"
            ? [message.content]
            : Array.isArray(message.content)
                ? message.content.flatMap((block: unknown) =>
                    block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                        && typeof (block as { text?: unknown }).text === "string"
                        ? [(block as { text: string }).text] : [])
                : [];
        let text = blocks.join("");
        if (message.role === "user") text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
        if (text.trim()) visible.push({ id: `history-${index}`, role: message.role, text: redact(text, apiKey) });
    }
    return visible;
}

function checkpointAssistantText(
    messages: Anthropic.MessageParam[],
    currentHistoryLength: number,
): string | null {
    if (messages.length <= currentHistoryLength) return null;
    const message = messages.at(-1);
    if (!message || message.role !== "assistant") return null;
    if (typeof message.content === "string") return message.content || null;
    const text = message.content
        .flatMap((block) => block.type === "text" ? [block.text] : [])
        .join("");
    return text || null;
}

function toSummary(item: SessionIndex): SessionSummary {
    const { latestActivity: _latestActivity, ...summary } = item;
    return {
        ...summary,
        status: item.status === "running" || item.status === "interrupted" || item.status === "cancelled" || item.status === "failed"
            ? item.status : "idle",
    };
}

function errorMessage(error: unknown, apiKey: RedactionKeys = ""): string {
    return error instanceof Error ? redact(error.message, apiKey) : redact(String(error), apiKey);
}

function desktopSettingsSnapshot(settings: DesktopSettings): DesktopSessionSettings {
    return {
        modelPreset: settings.modelPreset,
        model: settings.model,
        apiBase: settings.apiBase,
        protocol: settings.protocol,
        auth: settings.auth,
        thinking: settings.thinking,
        effort: settings.effort,
        contextWindow: settings.contextWindow,
    };
}

function safeDesktopSettingsSnapshot(value: unknown): DesktopSessionSettings | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if ((item.modelPreset !== null && typeof item.modelPreset !== "string")
        || typeof item.model !== "string"
        || typeof item.apiBase !== "string"
        || (item.protocol !== "anthropic" && item.protocol !== "openai-chat" && item.protocol !== "openai-responses")
        || (item.auth !== "api-key" && item.auth !== "bearer")
        || typeof item.thinking !== "boolean"
        || typeof item.effort !== "string"
        || typeof item.contextWindow !== "number" || !Number.isSafeInteger(item.contextWindow)
        || item.contextWindow < 1_024 || item.contextWindow > 10_000_000) return null;
    return {
        modelPreset: item.modelPreset,
        model: item.model,
        apiBase: item.apiBase,
        protocol: item.protocol,
        auth: item.auth,
        thinking: item.thinking,
        effort: item.effort,
        contextWindow: item.contextWindow,
    };
}

export class AgentHost {
    private readonly workspaces: WorkspaceStore;
    private readonly settings: SettingsStore;
    private readonly credentials: CredentialStore;
    private readonly reviews: ReviewService;
    private readonly worktreeStore: WorktreeStore;
    private readonly emitToRenderer: (event: DesktopEvent) => void;
    private readonly sessions = new Map<string, SessionRuntime>();
    private readonly gitMutations = new Set<string>();
    private readonly eventSequences = new DesktopEventSequencer();
    private readonly recoveredWorkspaceRoots = new Set<string>();
    private readonly permissions = new Map<string, PendingPermission>();
    private readonly questions = new Map<string, PendingQuestion>();
    private readonly requestRuns = new Map<string, string>();
    private readonly runShutdown = new RunShutdown();

    constructor(
        workspaces: WorkspaceStore,
        settings: SettingsStore,
        credentials: CredentialStore,
        userDataPath: string,
        emitToRenderer: (event: DesktopEvent) => void,
    ) {
        this.workspaces = workspaces;
        this.settings = settings;
        this.credentials = credentials;
        this.reviews = new ReviewService(userDataPath);
        this.worktreeStore = new WorktreeStore(userDataPath);
        this.reviews.recoverInterrupted();
        this.emitToRenderer = emitToRenderer;
        for (const workspace of workspaces.list()) {
            if (workspace.available) this.recoverWorkspaceSessions(workspace.path);
        }
    }

    bootstrap(): BootstrapData {
        const presets = getModelPresets();
        const settings = this.currentSettings();
        return {
            workspaces: this.workspaces.list(),
            activeWorkspaceId: this.workspaces.activeId(),
            settings: {
                ...settings,
                modelPreset: settings.modelPreset && Object.hasOwn(presets, settings.modelPreset)
                    ? settings.modelPreset : null,
            },
            modelPresets: Object.entries(presets).map(([name, preset]) => ({
                name,
                model: preset.model,
                ...(preset.apiBase === undefined ? {} : { apiBase: preset.apiBase }),
                ...(preset.protocol === undefined ? {} : { protocol: preset.protocol }),
                ...(preset.auth === undefined ? {} : { auth: preset.auth }),
                ...(preset.contextWindow === undefined ? {} : { contextWindow: preset.contextWindow }),
                hasApiKey: Boolean(preset.apiKey),
            })),
            credentialState: this.credentialState(settings.modelPreset),
        };
    }

    openWorkspace(path: string): WorkspaceSummary {
        return this.workspaces.open(path);
    }

    activateWorkspace(workspaceId: string): WorkspaceSummary {
        return this.workspaces.activate(workspaceId);
    }

    removeWorkspace(workspaceId: string): void {
        this.assertNoChildWorktrees(workspaceId);
        if (this.gitMutations.has(workspaceId)) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Wait for the current Git operation before removing this workspace from recents.");
        }
        const workspace = this.workspaces.listForTasks().find((item) => item.id === workspaceId);
        const localRun = [...this.sessions.values()].some((runtime) => runtime.workspaceId === workspaceId && runtime.currentRunId !== null);
        if (localRun) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Stop the running task before removing this workspace from recents.");
        }
        if (workspace?.available) this.assertWorkspaceRunsStopped(workspaceId);
        this.removeWorkspaceRecord(workspaceId);
    }

    getGitSnapshot(workspaceId: string): Promise<GitSnapshot> {
        return readGitSnapshot(this.workspaces.getPath(workspaceId));
    }

    assertTerminalCanOpen(workspaceId: string): void {
        if (this.gitMutations.has(workspaceId)) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Wait for the current Git operation before opening a terminal in this workspace.");
        }
    }

    getWorktreeSetup(workspaceId: string): Promise<WorktreeSetupData> {
        return inspectWorktreeSetup(this.workspaces.getPath(workspaceId));
    }

    getWorktreeAssociation(workspaceId: string): WorktreeAssociation | null {
        return this.worktreeStore.get(workspaceId);
    }

    createWorktree(workspaceId: string, input: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
        return this.withWorkspaceGitMutation(workspaceId, async () => {
            const sourcePath = this.workspaces.getPath(workspaceId);
            const result = await createGitWorktree(sourcePath, input);
            let workspace: WorkspaceSummary | null = null;
            try {
                workspace = this.workspaces.open(result.path);
                this.worktreeStore.add({
                    workspaceId: workspace.id,
                    workspacePath: workspace.path,
                    taskName: result.taskName,
                    branchName: result.branchName,
                    sourceWorkspaceId: workspaceId,
                    sourcePath,
                    sourceBranch: result.sourceBranch,
                    baseCommit: result.baseCommit,
                    createdAt: new Date().toISOString(),
                });
                return { workspace, branchName: result.branchName, baseCommit: result.baseCommit, sourceDirty: result.sourceDirty };
            } catch (failure) {
                const cleanupAssociation: WorktreeAssociation = {
                    workspaceId: workspace?.id ?? workspaceId,
                    workspacePath: workspace?.path ?? result.path,
                    taskName: result.taskName,
                    branchName: result.branchName,
                    sourceWorkspaceId: workspaceId,
                    sourcePath,
                    sourceBranch: result.sourceBranch,
                    baseCommit: result.baseCommit,
                    createdAt: new Date().toISOString(),
                };
                let cleanup: Awaited<ReturnType<typeof removeGitWorktree>>;
                try {
                    cleanup = await removeGitWorktree(sourcePath, result.path, cleanupAssociation, true);
                } catch (cleanupFailure) {
                    const registrationMessage = failure instanceof Error ? failure.message : String(failure);
                    const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
                    throw new DesktopServiceError(
                        "WORKTREE_REGISTRATION_FAILED",
                        `工作树已创建，但桌面登记失败且自动清理未完成。工作区仍位于 ${result.path}，分支 ${result.branchName} 可能仍存在。登记错误：${registrationMessage}；清理错误：${cleanupMessage}`,
                    );
                }
                if (workspace) {
                    try { this.workspaces.remove(workspace.id); }
                    catch (cleanupFailure) {
                        const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
                        throw new DesktopServiceError(
                            "WORKTREE_REGISTRATION_RECOVERED_WITH_STALE_WORKSPACE",
                            `工作树和分支已清理，但最近项目记录未能移除。重新启动后可从不可访问项目中移除此记录。错误：${cleanupMessage}`,
                        );
                    }
                    try { this.workspaces.activate(workspaceId); }
                    catch (cleanupFailure) {
                        const cleanupMessage = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
                        throw new DesktopServiceError(
                            "WORKTREE_SOURCE_RESTORE_FAILED",
                            `工作树和分支已清理，但未能恢复源工作区为活动项目。请重新选择源工作区。错误：${cleanupMessage}`,
                        );
                    }
                }
                if (!cleanup.branchDeleted) {
                    throw new DesktopServiceError(
                        "WORKTREE_REGISTRATION_RECOVERED_WITH_BRANCH",
                        `自动清理已移除工作树，但 Git 保留了分支 ${result.branchName}。登记错误：${failure instanceof Error ? failure.message : String(failure)}`,
                    );
                }
                throw failure;
            }
        });
    }

    getWorktreeReview(workspaceId: string): Promise<WorktreeReviewSnapshot> {
        const association = this.requireWorktreeAssociation(workspaceId);
        return readWorktreeReview(
            this.workspaces.getPath(association.sourceWorkspaceId),
            this.workspaces.getPath(workspaceId),
            association,
        );
    }

    mergeWorktree(workspaceId: string): Promise<WorktreeMergeResult> {
        const association = this.requireWorktreeAssociation(workspaceId);
        if (association.sourceWorkspaceId === workspaceId) {
            throw new DesktopServiceError("INVALID_WORKTREE_RECORD", "源工作区与隔离工作区记录冲突。");
        }
        return this.withWorkspaceGitMutation(association.sourceWorkspaceId, () =>
            this.withWorkspaceGitMutation(workspaceId, () => mergeGitWorktree(
                this.workspaces.getPath(association.sourceWorkspaceId),
                this.workspaces.getPath(workspaceId),
                association,
            )));
    }

    removeWorktree(workspaceId: string, deleteBranch: boolean): Promise<WorktreeRemovalResult> {
        const association = this.requireWorktreeAssociation(workspaceId);
        if (association.sourceWorkspaceId === workspaceId) {
            throw new DesktopServiceError("INVALID_WORKTREE_RECORD", "源工作区与隔离工作区记录冲突。");
        }
        this.assertNoChildWorktrees(workspaceId);
        return this.withWorkspaceGitMutation(association.sourceWorkspaceId, () =>
            this.withWorkspaceGitMutation(workspaceId, async () => {
                this.assertNoChildWorktrees(workspaceId);
                const result = await removeGitWorktree(
                    this.workspaces.getPath(association.sourceWorkspaceId),
                    this.workspaces.getPath(workspaceId),
                    association,
                    deleteBranch,
                );
                this.worktreeStore.remove(workspaceId);
                this.removeWorkspaceRecord(workspaceId);
                return { ...result, sourceWorkspaceId: association.sourceWorkspaceId };
            }));
    }

    getGitDiff(workspaceId: string, path: string, staged: boolean): Promise<GitFileDiff> {
        return readGitDiff(this.workspaces.getPath(workspaceId), path, staged);
    }

    async stageGitPath(workspaceId: string, path: string): Promise<void> {
        await this.withWorkspaceGitMutation(workspaceId, () => stageWorkspaceGitPath(this.workspaces.getPath(workspaceId), path));
    }

    async unstageGitPath(workspaceId: string, path: string): Promise<void> {
        await this.withWorkspaceGitMutation(workspaceId, () => unstageWorkspaceGitPath(this.workspaces.getPath(workspaceId), path));
    }

    async commitGitChanges(workspaceId: string, message: string): Promise<string> {
        return this.withWorkspaceGitMutation(workspaceId, () => createGitCommit(this.workspaces.getPath(workspaceId), message));
    }

    getCodeReview(workspaceId: string, sessionId: string): Promise<CodeReviewSnapshot> {
        const workspaceRoot = this.workspaces.getPath(workspaceId);
        if (!this.storeFor(workspaceId).load(sessionId)) {
            throw new DesktopServiceError("SESSION_NOT_FOUND", "This conversation could not be found.");
        }
        return this.reviews.getSnapshot(workspaceId, sessionId, workspaceRoot);
    }

    checkReviewFile(workspaceId: string, runId: string, path: string, expectedCurrentHash: string | null): Promise<boolean> {
        return this.reviews.checkFile(workspaceId, runId, this.workspaces.getPath(workspaceId), path, expectedCurrentHash);
    }

    restoreReviewFile(workspaceId: string, runId: string, path: string, expectedCurrentHash: string | null) {
        const run = this.reviews.getRunStatus(workspaceId, runId);
        if (run === "running") throw new DesktopServiceError("REVIEW_RUN_ACTIVE", "Stop the running task before restoring its files.");
        return this.reviews.restoreFile(workspaceId, runId, this.workspaces.getPath(workspaceId), path, expectedCurrentHash);
    }

    listSessions(workspaceId: string): SessionSummary[] {
        const store = this.storeFor(workspaceId);
        store.recoverInterrupted();
        return store.list().map((item) => {
            const runtime = this.sessions.get(sessionKey(workspaceId, item.id));
            return toSummary(runtime?.currentRunId || store.isRunActive(item.id) ? { ...item, status: "running" } : item);
        });
    }

    listTasks(): DesktopTaskCenterData {
        const tasks: DesktopTaskCenterData["tasks"] = [];
        for (const workspace of this.workspaces.listForTasks()) {
            if (!workspace.available) continue;
            const store = this.storeFor(workspace.id);
            store.recoverInterrupted();
            for (const storedSession of store.list()) {
                const runtime = this.sessions.get(sessionKey(workspace.id, storedSession.id));
                const isRunning = Boolean(runtime?.currentRunId || store.isRunActive(storedSession.id));
                const session = toSummary(isRunning ? { ...storedSession, status: "running" } : storedSession);
                if (session.status === "idle" && session.messageCount === 0) continue;
                const hasPendingApproval = this.pendingPermissionsFor(workspace.id, session.id).length > 0;
                const hasPendingQuestion = this.pendingQuestionsFor(workspace.id, session.id).length > 0;
                const latest = runtime?.activities.at(-1) ?? storedSession.latestActivity;
                tasks.push({
                    id: `${workspace.id}:${session.id}`,
                    workspace,
                    session,
                    status: desktopTaskStatus(session.status, hasPendingApproval, hasPendingQuestion,
                        isRunning ? storedSession.desktopWaitingFor : undefined),
                    runId: runtime?.currentRunId ?? null,
                    latestActivityId: latest?.id ?? null,
                    latestActivityTitle: latest?.title ?? null,
                });
            }
        }

        const priority: Record<DesktopTaskCenterData["tasks"][number]["status"], number> = {
            "waiting-approval": 0,
            "waiting-user": 0,
            running: 0,
            failed: 1,
            interrupted: 1,
            cancelled: 2,
            completed: 3,
        };
        tasks.sort((left, right) => priority[left.status] - priority[right.status]
            || right.session.updated.localeCompare(left.session.updated));
        return { tasks };
    }

    createSession(workspaceId: string): OpenSessionData {
        const store = this.storeFor(workspaceId);
        const settings = this.currentSettings();
        const item = store.create(settings.model, desktopSettingsSnapshot(settings));
        return {
            session: toSummary({ ...item, messageCount: 0 }),
            route: desktopSettingsSnapshot(settings),
            messages: [],
            activities: [],
            usage: emptyAgentUsage(),
            contextUsage: null,
            runId: null,
            externalRun: false,
            permissionMode: "desktopDefault",
            approvals: [],
            questions: [],
            permissionGrants: [],
            eventSequence: 0,
        };
    }

    openSession(workspaceId: string, sessionId: string): OpenSessionData {
        const store = this.storeFor(workspaceId);
        store.recoverInterrupted();
        const item = store.load(sessionId);
        if (!item) throw new DesktopServiceError("SESSION_NOT_FOUND", "This conversation could not be found.");
        const key = sessionKey(workspaceId, sessionId);
        const prior = this.sessions.get(key);
        if (prior && !prior.currentRunId
            && (prior.sessionRevisionConflict || prior.revision !== (item.revision ?? 0))) {
            this.sessions.delete(key);
        }
        const runtime = this.runtimeFor(workspaceId, sessionId, item, store);
        const current = store.list().find((entry) => entry.id === sessionId)!;
        const isRunning = Boolean(runtime.currentRunId || store.isRunActive(sessionId));
        const messages = projectMessages(runtime.agent.history(), runtime.redactionKeys);
        if (runtime.currentRunId && runtime.partialAssistantText) {
            messages.push({ id: `assistant-${runtime.currentRunId}`, role: "assistant", text: redact(runtime.partialAssistantText, runtime.redactionKeys) });
        }
        return {
            session: toSummary(isRunning ? { ...current, status: "running" } : current),
            route: { ...runtime.desktopSettings },
            messages,
            activities: safeSessionActivities(runtime.activities, runtime.redactionKeys),
            usage: runtime.agent.getUsage(),
            contextUsage: runtime.agent.getContextUsage(),
            runId: runtime.currentRunId,
            externalRun: isRunning && !runtime.currentRunId,
            permissionMode: runtime.agent.getSessionStatus().mode === "plan" ? "plan" : "desktopDefault",
            approvals: redactSessionMessages(this.pendingPermissionsFor(workspaceId, sessionId),
                runtime.redactionKeys) as PendingPermissionRequest[],
            questions: redactSessionMessages(this.pendingQuestionsFor(workspaceId, sessionId),
                runtime.redactionKeys) as PendingUserQuestion[],
            permissionGrants: runtime.agent.getSessionPermissionGrants().map((grant) => ({
                ...grant,
                operation: redact(grant.operation, runtime.redactionKeys).slice(0, 2_000),
            })),
            eventSequence: this.eventSequences.current(key),
        };
    }

    updateSessionRoute(workspaceId: string, sessionId: string, modelPreset: string | null, effort: EffortLevel): void {
        const store = this.storeFor(workspaceId);
        const data = store.load(sessionId);
        if (!data) throw new DesktopServiceError("SESSION_NOT_FOUND", "找不到这段会话。");
        if (store.isRunActive(sessionId)) throw new DesktopServiceError("SESSION_BUSY", "请等待当前任务结束后再切换模型。");
        const preset = modelPreset ? getModelPresets()[modelPreset] : undefined;
        if (modelPreset && !preset) throw new DesktopServiceError("MODEL_PRESET_NOT_FOUND", "这个模型预设已不存在，请刷新设置。");
        const runtime = this.runtimeFor(workspaceId, sessionId, data, store);
        if (runtime.currentRunId) throw new DesktopServiceError("SESSION_BUSY", "请等待当前任务结束后再切换模型。");
        const route: DesktopSessionSettings = {
            ...runtime.desktopSettings,
            ...(preset ? {
                modelPreset,
                model: preset.model,
                apiBase: preset.apiBase ?? runtime.desktopSettings.apiBase,
                protocol: preset.protocol ?? runtime.desktopSettings.protocol,
                auth: preset.auth ?? runtime.desktopSettings.auth,
                contextWindow: preset.contextWindow ?? runtime.desktopSettings.contextWindow,
            } : {}),
            effort,
        };
        try {
            const saved = store.updateDesktopSettings(sessionId, runtime.revision, route);
            if (!saved) throw new DesktopServiceError("SESSION_NOT_FOUND", "找不到这段会话。");
            runtime.revision = saved.revision ?? runtime.revision + 1;
        } catch (error) {
            if (error instanceof SessionBusyError || error instanceof SessionConflictError) {
                throw new DesktopServiceError("SESSION_BUSY", "会话已在其他进程中更改，请重新打开后再切换模型。");
            }
            throw error;
        }
        runtime.desktopSettings = route;
        this.setRuntimeApiKey(runtime, this.apiKeyForSettings(route));
        runtime.agent.setModel({ model: route.model, label: route.modelPreset ?? "", apiBase: route.apiBase,
            apiKey: runtime.apiKey, protocol: route.protocol, auth: route.auth,
            contextWindow: route.contextWindow });
        runtime.agent.setEffort(effort);
    }

    listPermissionGrants(workspaceId: string, sessionId: string): OpenSessionData["permissionGrants"] {
        return this.openSession(workspaceId, sessionId).permissionGrants;
    }

    revokePermissionGrant(workspaceId: string, sessionId: string, grantId: string): boolean {
        const store = this.storeFor(workspaceId);
        const item = store.load(sessionId);
        if (!item) throw new DesktopServiceError("SESSION_NOT_FOUND", "This conversation could not be found.");
        const runtime = this.runtimeFor(workspaceId, sessionId, item, store);
        if (!runtime.agent.revokeSessionPermissionGrant(grantId)) return false;
        runtime.activities = runtime.activities.map((activity) => activity.permissionSource?.kind === "session"
            && activity.permissionSource.grantId === grantId
            ? { ...activity, permissionGrantRevoked: true, updatedAt: new Date().toISOString() }
            : activity);
        this.persistSession(runtime);
        return true;
    }

    renameSession(workspaceId: string, sessionId: string, title: string): SessionSummary {
        let item: SessionData | null;
        try {
            item = this.storeFor(workspaceId).rename(sessionId, title);
        } catch (error) {
            if (error instanceof SessionBusyError) {
                throw new DesktopServiceError("SESSION_BUSY", "该会话正在另一个进程中运行，请等待任务完成后再重命名。");
            }
            throw error;
        }
        if (!item) throw new DesktopServiceError("SESSION_RENAME_FAILED", "Enter a non-empty conversation title.");
        const runtime = this.sessions.get(sessionKey(workspaceId, sessionId));
        if (runtime && !runtime.sessionRevisionConflict && (item.revision ?? 0) === runtime.revision + 1) {
            runtime.revision = item.revision ?? 0;
        }
        return toSummary({ ...item, messageCount: item.messages.length });
    }

    deleteSession(workspaceId: string, sessionId: string): void {
        const key = sessionKey(workspaceId, sessionId);
        const runtime = this.sessions.get(key);
        if (runtime?.currentRunId) throw new DesktopServiceError("SESSION_BUSY", "请先停止当前任务，再删除此会话。");
        try {
            if (!this.storeFor(workspaceId).delete(sessionId)) {
                throw new DesktopServiceError("SESSION_NOT_FOUND", "This conversation could not be found.");
            }
        } catch (error) {
            if (error instanceof SessionBusyError) {
                throw new DesktopServiceError("SESSION_BUSY", "该会话正在另一个进程中运行，请等待任务完成后再删除。");
            }
            throw error;
        }
        this.sessions.delete(key);
        this.eventSequences.delete(key);
    }

    async startRun(workspaceId: string, sessionId: string, text: string, requestId: string): Promise<{ runId: string }> {
        const prompt = text.trim();
        if (!prompt) throw new DesktopServiceError("EMPTY_MESSAGE", "Write a message before sending it.");
        if (prompt.length > 100_000) throw new DesktopServiceError("MESSAGE_TOO_LARGE", "Messages must be shorter than 100,000 characters.");
        return this.runShutdown.trackStart(
            () => this.startSessionRun(workspaceId, sessionId, requestId, prompt, false),
            () => new DesktopServiceError("APP_STOPPING", "Wait for TriumCode to finish stopping its current tasks."),
        );
    }

    async retryRun(workspaceId: string, sessionId: string, requestId: string): Promise<{ runId: string }> {
        return this.runShutdown.trackStart(
            () => this.startSessionRun(workspaceId, sessionId, requestId, "", true),
            () => new DesktopServiceError("APP_STOPPING", "Wait for TriumCode to finish stopping its current tasks."),
        );
    }

    private async startSessionRun(
        workspaceId: string,
        sessionId: string,
        requestId: string,
        submittedPrompt: string,
        retryFailedRequest: boolean,
    ): Promise<{ runId: string }> {
        const priorRunId = this.requestRuns.get(requestId);
        if (priorRunId) return { runId: priorRunId };
        if (this.gitMutations.has(workspaceId)) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Wait for the Git operation to finish before starting a task in this workspace.");
        }
        const store = this.storeFor(workspaceId);
        const item = store.load(sessionId);
        if (!item) throw new DesktopServiceError("SESSION_NOT_FOUND", "This conversation could not be found.");
        const runtime = this.runtimeFor(workspaceId, sessionId, item, store);
        if (runtime.sessionRevisionConflict || runtime.revision !== (item.revision ?? 0)) {
            throw new DesktopServiceError("SESSION_CONFLICT", "会话已被其他进程修改。请重新打开此会话后再开始任务。");
        }
        if (runtime.currentRunId) throw new DesktopServiceError("SESSION_BUSY", "此会话已有正在运行的任务。");
        const apiKey = this.apiKeyForSettings(runtime.desktopSettings);
        if (!apiKey) {
            throw new DesktopServiceError("CREDENTIAL_MISSING", "当前会话没有可用的 API Key。请先在设置中保存或导入此模型的密钥。");
        }
        this.setRuntimeApiKey(runtime, apiKey);
        runtime.agent.setModel({ apiKey });
        let prompt = submittedPrompt;
        if (retryFailedRequest) {
            const failedTurn = [...runtime.activities].reverse().find((activity) => activity.failureCategory !== undefined);
            if (item.status !== "failed" || !failedTurn?.retryable || !failedTurn.safeToRetry) {
                throw new DesktopServiceError("RUN_NOT_SAFELY_RETRYABLE", "最近一次失败可能已经执行过工具操作。请检查工作区改动，再恢复请求作为新消息继续。");
            }
            prompt = projectMessages(item.messages).reverse().find((message) => message.role === "user")?.text.trim() ?? "";
            if (!prompt) throw new DesktopServiceError("RUN_RETRY_PROMPT_MISSING", "无法恢复最近失败请求的文本。请从会话内容中恢复请求后继续。");
            if (prompt.length > 100_000) throw new DesktopServiceError("MESSAGE_TOO_LARGE", "Messages must be shorter than 100,000 characters.");
        }
        const activeRuns = [...this.sessions.values()].filter((session) => session.currentRunId !== null).length;
        const maxParallelRuns = this.settings.get().maxParallelRuns;
        if (activeRuns >= maxParallelRuns) {
            throw new DesktopServiceError("CONCURRENCY_LIMIT", `已达到同时运行上限（${maxParallelRuns} 个任务）。等待一个任务结束后即可重试。`);
        }

        try {
            runtime.releaseRunLease = runtime.store.acquireRun(sessionId, runtime.revision);
        } catch (error) {
            if (error instanceof SessionBusyError) {
                if (error.scope === "workspace") {
                    throw new DesktopServiceError("WORKSPACE_BUSY", "该工作区已有会话或 Git 操作正在运行，请等待完成后再开始任务。");
                }
                throw new DesktopServiceError("SESSION_BUSY", "该会话正在另一个进程中运行，请等待任务完成后再继续。");
            }
            if (error instanceof SessionConflictError) {
                throw new DesktopServiceError("SESSION_CONFLICT", "会话版本已变化。请重新打开此会话后再开始任务。");
            }
            throw error;
        }

        const runId = randomUUID();
        runtime.currentRunId = runId;
        runtime.cancelRequested = false;
        runtime.reviewCaptureEnabled = false;
        this.requestRuns.set(requestId, runId);
        while (this.requestRuns.size > 200) this.requestRuns.delete(this.requestRuns.keys().next().value!);
        try {
            await this.reviews.beginRun(workspaceId, sessionId, runId, runtime.workspaceRoot);
            runtime.reviewCaptureEnabled = true;
        } catch (error) {
            this.publish(runtime, {
                type: "notice",
                level: "warning",
                text: `无法保存本机代码审阅基线；本轮文件仍会按已批准操作执行。${errorMessage(error, runtime.redactionKeys)}`,
            });
        }
        if (runtime.cancelRequested) {
            try { this.reviews.finishRun(workspaceId, runId, "cancelled"); }
            catch { /* A missing review snapshot does not prevent stopping the run. */ }
            runtime.reviewCaptureEnabled = false;
            runtime.currentRunId = null;
            this.refreshRuntimeApiKey(runtime);
            runtime.releaseRunLease?.();
            runtime.releaseRunLease = null;
            this.publish(runtime, { type: "session.status", status: "cancelled" }, runId);
            return { runId };
        }

        runtime.activities = runtime.activities.map((activity) => activity.safeToRetry ? { ...activity, safeToRetry: false } : activity);
        const task = retryFailedRequest ? runtime.agent.retryFailedTurn(prompt) : runtime.agent.chat(prompt);
        let finalStatus: NonNullable<SessionData["status"]> = "idle";
        runtime.runPromise = task.then(() => {
            finalStatus = runtime.sessionRevisionConflict ? "failed" : runtime.cancelRequested ? "cancelled" : "idle";
            this.persistSession(runtime, runtime.agent.history(), finalStatus);
        }).catch((error: unknown) => {
            finalStatus = "failed";
            this.persistSession(runtime, runtime.agent.history(), finalStatus);
            this.publish(runtime, { type: "notice", level: "warning", text: errorMessage(error, runtime.redactionKeys) });
        }).finally(() => {
            try { this.reviews.finishRun(workspaceId, runId, finalStatus); }
            catch (error) { this.publish(runtime, { type: "notice", level: "warning", text: `无法更新代码审阅快照：${errorMessage(error, runtime.redactionKeys)}` }); }
            runtime.reviewCaptureEnabled = false;
            runtime.currentRunId = null;
            this.refreshRuntimeApiKey(runtime);
            runtime.runPromise = null;
            runtime.releaseRunLease?.();
            runtime.releaseRunLease = null;
            this.publish(runtime, { type: "session.status", status: finalStatus }, runId);
        });
        return { runId };
    }

    cancelRun(runId: string): void {
        const runtime = [...this.sessions.values()].find((item) => item.currentRunId === runId);
        if (!runtime) return;
        runtime.cancelRequested = true;
        runtime.agent.abort();
        this.dismissPending(runtime);
    }

    respondToPermission(requestId: string, choice: PermissionChoice): void {
        const pending = this.permissions.get(requestId);
        if (!pending) return;
        const runtime = this.sessions.get(sessionKey(pending.workspaceId, pending.sessionId));
        if (choice === "session" && (!pending.key || !runtime)) {
            throw new DesktopServiceError("PERMISSION_SCOPE_UNAVAILABLE", "本会话授权范围不可用。请改为允许一次或拒绝。");
        }
        clearTimeout(pending.timer);
        this.permissions.delete(requestId);
        const outcome: PermissionOutcome = choice === "deny" ? "denied" : choice;
        const grantId = runtime && choice === "session" && pending.key
            ? runtime.agent.confirmSessionPermission(pending.key, pending.toolName, pending.operation)
            : undefined;
        if (runtime) {
            this.recordPermissionOutcome(runtime, pending, outcome);
            this.publish(runtime, {
                type: "permission.resolved",
                requestId,
                toolCallId: pending.toolCallId,
                toolName: pending.toolName,
                operation: pending.operation,
                source: pending.source,
                outcome,
                ...(grantId ? { grantId } : {}),
            });
        }
        pending.resolve(choice === "deny" ? false : choice);
    }

    respondToQuestion(requestId: string, answer: string): void {
        const pending = this.questions.get(requestId);
        if (!pending) return;
        if (pending.options && !pending.options.includes(answer)) {
            throw new DesktopServiceError("INVALID_ANSWER", "Choose one of the displayed options.");
        }
        if (!pending.options && answer.length > 20_000) {
            throw new DesktopServiceError("ANSWER_TOO_LARGE", "Answers must be shorter than 20,000 characters.");
        }
        clearTimeout(pending.timer);
        this.questions.delete(requestId);
        const runtime = this.sessions.get(sessionKey(pending.workspaceId, pending.sessionId));
        if (runtime) {
            const outcome = answer.trim() ? "answered" : "skipped";
            runtime.activities = updateQuestionActivity(runtime.activities, requestId, runtime.currentRunId,
                pending.question, new Date().toISOString(), outcome);
            this.persistSession(runtime);
            this.publish(runtime, {
                type: "question.resolved",
                requestId,
                outcome,
            });
        }
        pending.resolve(answer.trim() ? answer : "The user skipped this question. Do not treat this as a response.");
    }

    saveSettings(settings: DesktopSettings): DesktopSettings {
        const presets = getModelPresets();
        const preset = settings.modelPreset && Object.hasOwn(presets, settings.modelPreset)
            ? presets[settings.modelPreset] : undefined;
        if (settings.modelPreset && !preset) {
            throw new DesktopServiceError("MODEL_PRESET_NOT_FOUND", "这个命名模型预设已从 CLI 配置中移除。刷新设置后重新选择。");
        }
        const effectiveSettings = preset ? {
            ...settings,
            model: preset.model,
            apiBase: preset.apiBase ?? settings.apiBase,
            protocol: preset.protocol ?? settings.protocol,
            auth: preset.auth ?? settings.auth,
            contextWindow: preset.contextWindow ?? settings.contextWindow,
        } : settings;
        const saved = this.settings.save(effectiveSettings);
        const apiKey = this.apiKeyForSettings(saved);
        for (const runtime of this.sessions.values()) {
            if (!runtime.currentRunId && runtime.desktopSettings.modelPreset === saved.modelPreset) {
                runtime.agent.setModel({ apiKey });
                this.setRuntimeApiKey(runtime, apiKey);
            }
        }
        return saved;
    }

    credentialState(presetName?: string | null): BootstrapData["credentialState"] {
        const preset = presetName ? getModelPresets()[presetName] : undefined;
        return this.credentials.state(presetName, Boolean(preset?.apiKey));
    }

    private currentSettings(): DesktopSettings {
        const settings = this.settings.get();
        return settings.modelPreset && !Object.hasOwn(getModelPresets(), settings.modelPreset)
            ? { ...settings, modelPreset: null }
            : settings;
    }

    private assertCredentialPreset(presetName: string | null): void {
        if (presetName && !Object.hasOwn(getModelPresets(), presetName)) {
            throw new DesktopServiceError("MODEL_PRESET_NOT_FOUND", "这个命名模型预设已从 CLI 配置中移除。刷新设置后重新选择。");
        }
    }

    private apiKeyForSettings(settings: Pick<DesktopSessionSettings, "modelPreset">): string {
        return this.credentials.getStoredApiKey(settings.modelPreset)
            || this.credentials.getApiKey(settings.modelPreset);
    }

    private refreshRuntimeApiKey(runtime: SessionRuntime): void {
        this.setRuntimeApiKey(runtime, this.apiKeyForSettings(runtime.desktopSettings));
        runtime.agent.setModel({ apiKey: runtime.apiKey });
    }

    private setRuntimeApiKey(runtime: SessionRuntime, apiKey: string): void {
        this.rememberRuntimeRedactionKey(runtime, apiKey);
        runtime.apiKey = apiKey;
    }

    private rememberRuntimeRedactionKey(runtime: SessionRuntime, apiKey: string): void {
        if (apiKey.length < 8 || runtime.redactionKeys.includes(apiKey)) return;
        runtime.redactionKeys.push(apiKey);
        runtime.activities = safeSessionActivities(runtime.activities, runtime.redactionKeys);
    }

    private pendingPermissionsFor(workspaceId: string, sessionId: string): PendingPermissionRequest[] {
        return [...this.permissions.values()]
            .filter((pending) => pending.workspaceId === workspaceId && pending.sessionId === sessionId)
            .map(({ requestId, toolCallId, toolName, operation, message, source }) => ({ requestId, toolCallId, toolName, operation, message, source }));
    }

    private requireWorktreeAssociation(workspaceId: string): WorktreeAssociation {
        const association = this.worktreeStore.get(workspaceId);
        if (!association) throw new DesktopServiceError("WORKTREE_NOT_FOUND", "这个工作区没有关联的隔离工作树记录。");
        return association;
    }

    private assertNoChildWorktrees(workspaceId: string): void {
        if (this.worktreeStore.listForSource(workspaceId).length > 0) {
            throw new DesktopServiceError("WORKSPACE_HAS_CHILD_WORKTREES", "请先移除这个工作区创建的隔离工作树，再移除当前工作区。");
        }
    }

    private removeWorkspaceRecord(workspaceId: string): void {
        this.workspaces.remove(workspaceId);
        for (const [key, runtime] of this.sessions) {
            if (runtime.workspaceId === workspaceId) this.sessions.delete(key);
        }
    }

    private assertWorkspaceRunsStopped(workspaceId: string): void {
        const localRun = [...this.sessions.values()].some((runtime) => runtime.workspaceId === workspaceId && runtime.currentRunId !== null);
        const store = this.storeFor(workspaceId);
        const externalRun = store.list().some((session) => store.isRunActive(session.id));
        const running = localRun || externalRun;
        if (running) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Stop active CLI or desktop tasks in this workspace before changing its Git state.");
        }
    }

    private async withWorkspaceGitMutation<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
        if (this.gitMutations.has(workspaceId)) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Another Git operation is already running for this workspace.");
        }
        this.assertWorkspaceRunsStopped(workspaceId);
        let releaseWorkspace: (() => void) | null = null;
        try {
            releaseWorkspace = this.storeFor(workspaceId).acquireWorkspaceGitMutation();
        } catch (error) {
            if (error instanceof SessionBusyError) {
                throw new DesktopServiceError("WORKSPACE_BUSY", "该工作区已有会话或 Git 操作正在运行，请等待完成后再修改 Git 状态。");
            }
            throw error;
        }
        this.gitMutations.add(workspaceId);
        try {
            return await action();
        } finally {
            this.gitMutations.delete(workspaceId);
            releaseWorkspace?.();
        }
    }

    private pendingQuestionsFor(workspaceId: string, sessionId: string): PendingUserQuestion[] {
        return [...this.questions.values()]
            .filter((pending) => pending.workspaceId === workspaceId && pending.sessionId === sessionId)
            .map(({ requestId, question, options }) => ({ requestId, question, ...(options ? { options } : {}) }));
    }

    saveApiKey(apiKey: string, presetName: string | null): BootstrapData["credentialState"] {
        this.assertCredentialPreset(presetName);
        this.credentials.save(apiKey, presetName);
        for (const runtime of this.sessions.values()) {
            if (runtime.desktopSettings.modelPreset === presetName) {
                const savedKey = this.apiKeyForSettings(runtime.desktopSettings);
                if (runtime.currentRunId) {
                    this.rememberRuntimeRedactionKey(runtime, savedKey);
                    continue;
                }
                this.setRuntimeApiKey(runtime, savedKey);
                runtime.agent.setModel({ apiKey: runtime.apiKey });
            }
        }
        return this.credentialState(presetName);
    }

    importCliCredential(presetName: string | null): BootstrapData["credentialState"] {
        this.assertCredentialPreset(presetName);
        const preset = presetName ? getModelPresets()[presetName] : undefined;
        this.credentials.importCliCredential(presetName, preset?.apiKey);
        const apiKey = this.apiKeyForSettings({ ...this.settings.get(), modelPreset: presetName });
        for (const runtime of this.sessions.values()) {
            if (runtime.desktopSettings.modelPreset === presetName) {
                if (runtime.currentRunId) {
                    this.rememberRuntimeRedactionKey(runtime, apiKey);
                    continue;
                }
                runtime.agent.setModel({ apiKey });
                this.setRuntimeApiKey(runtime, apiKey);
            }
        }
        return this.credentialState(presetName);
    }

    clearApiKey(presetName: string | null): BootstrapData["credentialState"] {
        this.assertCredentialPreset(presetName);
        this.credentials.clear(presetName);
        const apiKey = this.apiKeyForSettings({ ...this.settings.get(), modelPreset: presetName });
        for (const runtime of this.sessions.values()) {
            if (!runtime.currentRunId && runtime.desktopSettings.modelPreset === presetName) {
                runtime.agent.setModel({ apiKey });
                this.setRuntimeApiKey(runtime, apiKey);
            }
        }
        return this.credentialState(presetName);
    }

    async testConnection(): Promise<{ ok: boolean; message: string }> {
        const settings = this.currentSettings();
        const apiKey = this.apiKeyForSettings(settings);
        if (!apiKey) return { ok: false, message: "当前路由没有可用的 API Key。请先安全保存或导入密钥。" };
        const provider = createProvider(settings.protocol, { apiBase: settings.apiBase, apiKey, auth: settings.auth });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
            const stream = await provider.stream({
                model: settings.model,
                maxTokens: 12,
                system: [],
                messages: [{ role: "user", content: "Reply with OK." }],
                tools: [],
                thinkingMode: "disabled",
                effort: null,
            }, controller.signal);
            for await (const _event of stream) { /* consume the short response */ }
            return { ok: true, message: "Connection succeeded." };
        } catch (error) {
            return { ok: false, message: connectionFailureMessage(error, controller.signal.aborted) };
        } finally {
            clearTimeout(timer);
        }
    }

    async stopAll(): Promise<void> {
        return this.runShutdown.stopAll(() => {
            for (const runtime of this.sessions.values()) {
                if (!runtime.currentRunId) continue;
                runtime.cancelRequested = true;
                runtime.agent.abort();
                this.dismissPending(runtime);
            }
        }, () => [...this.sessions.values()]
            .map((runtime) => runtime.runPromise)
            .filter((promise): promise is Promise<void> => Boolean(promise)));
    }

    hasRunningTasks(): boolean {
        return [...this.sessions.values()].some((runtime) => runtime.currentRunId !== null);
    }

    private storeFor(workspaceId: string): SessionStore {
        const workspaceRoot = this.workspaces.getPath(workspaceId);
        this.recoverWorkspaceSessions(workspaceRoot);
        return new SessionStore(workspaceRoot);
    }

    private recoverWorkspaceSessions(workspaceRoot: string): void {
        const store = new SessionStore(workspaceRoot);
        if (this.recoveredWorkspaceRoots.has(store.workspaceRoot)) return;
        store.recoverInterrupted();
        this.recoveredWorkspaceRoots.add(store.workspaceRoot);
    }

    private runtimeFor(workspaceId: string, sessionId: string, data: SessionData, store: SessionStore): SessionRuntime {
        const key = sessionKey(workspaceId, sessionId);
        const existing = this.sessions.get(key);
        if (existing) return existing;
        const workspaceRoot = this.workspaces.getPath(workspaceId);
        const currentSettings = this.currentSettings();
        const restoredDesktopSettings = safeDesktopSettingsSnapshot(data.desktopSettings);
        const desktopSettings = restoredDesktopSettings ?? {
            ...desktopSettingsSnapshot(currentSettings),
            model: data.model || currentSettings.model,
        };
        const apiKey = this.apiKeyForSettings(desktopSettings);
        let runtime!: SessionRuntime;
        const agent = new Agent({
            model: desktopSettings.model,
            modelLabel: desktopSettings.modelPreset ?? "",
            apiBase: desktopSettings.apiBase,
            apiKey,
            protocol: desktopSettings.protocol,
            auth: desktopSettings.auth,
            thinking: desktopSettings.thinking,
            effort: desktopSettings.effort,
            contextWindow: desktopSettings.contextWindow,
            workspaceRoot,
            permissionMode: "desktopDefault",
            sessionPermissionGrants: safeSessionPermissionGrants(data.desktopPermissionGrants, apiKey),
            onSessionCheckpoint: (messages) => {
                runtime.partialAssistantText = checkpointAssistantText(messages, runtime.agent.history().length);
                this.persistSession(runtime, messages, runtime.currentRunId ? "running" : "idle");
            },
            onEvent: (event) => {
                if (event.type === "tool.completed" && event.name === "run_command" && event.executionStarted
                    && runtime.currentRunId && runtime.reviewCaptureEnabled) {
                    try { this.reviews.noteCommandRun(workspaceId, sessionId, runtime.currentRunId); }
                    catch (error) {
                        this.publish(runtime, {
                            type: "notice",
                            level: "warning",
                            text: `本轮命令执行结果未能写入代码审阅记录。${errorMessage(error, runtime.redactionKeys)}`,
                        });
                    }
                }
                if (event.type === "usage.updated" || event.type === "context.updated") {
                    this.persistSession(runtime);
                }
                const safeEvent = safeAgentEvent(event, runtime.workspaceRoot, runtime.redactionKeys);
                const nextActivities = activityFromEvent(runtime.activities, safeEvent, runtime.currentRunId ?? undefined);
                let shouldPersist = false;
                if (nextActivities) {
                    runtime.activities = nextActivities;
                    shouldPersist = true;
                }
                if (safeEvent.type === "permission.checked" && safeEvent.action === "allow" && safeEvent.source.kind === "session") {
                    shouldPersist = true;
                }
                if (shouldPersist) this.persistSession(runtime);
                this.publish(runtime, safeEvent);
            },
            onPermissionRequest: (request) => this.requestPermission(runtime, request),
            onBeforeFileWrite: (absolutePath) => runtime.currentRunId && runtime.reviewCaptureEnabled
                ? this.reviews.captureBeforeWrite(workspaceId, sessionId, runtime.currentRunId, workspaceRoot, absolutePath)
                : undefined,
        });
        agent.loadHistory(data.messages as Anthropic.MessageParam[]);
        const restoredUsage = safeDesktopUsage(data.desktopUsage);
        agent.restoreSessionUsage(restoredUsage ?? emptyAgentUsage(), restoredUsage?.contextTokens ?? null);
        runtime = {
            workspaceId,
            workspaceRoot,
            sessionId,
            desktopSettings,
            revision: data.revision ?? 0,
            store,
            agent,
            apiKey,
            redactionKeys: apiKey.length >= 8 ? [apiKey] : [],
            currentRunId: null,
            runPromise: null,
            releaseRunLease: null,
            cancelRequested: false,
            reviewCaptureEnabled: false,
            partialAssistantText: null,
            activities: safeSessionActivities(data.desktopActivities, apiKey),
            sessionPersistWarningShown: false,
            sessionRevisionConflict: false,
        };
        agent.setOnChatComplete(() => {
            this.persistSession(runtime);
        });
        agent.setAskUserCallback((question, options) => this.askUser(runtime, question, options));
        this.sessions.set(key, runtime);
        if (!restoredDesktopSettings) this.persistSession(runtime);
        return runtime;
    }

    private persistSession(
        runtime: SessionRuntime,
        messages?: unknown[],
        status: SessionData["status"] = runtime.currentRunId ? "running" : "idle",
    ): void {
        if (runtime.sessionRevisionConflict) return;
        try {
            const snapshot = messages ?? (runtime.partialAssistantText
                ? [
                    ...runtime.agent.history(),
                    { role: "assistant", content: [{ type: "text", text: runtime.partialAssistantText }] },
                ]
                : runtime.agent.history());
            const saved = runtime.store.save(
                runtime.sessionId,
                redactSessionMessages(snapshot, runtime.redactionKeys),
                runtime.agent.getModel(),
                runtime.revision,
                status,
                safeSessionActivities(runtime.activities, runtime.redactionKeys),
                usageSnapshot(runtime.agent.getUsage(), runtime.agent.getContextUsage()),
                safeSessionPermissionGrants(runtime.agent.getPersistedSessionPermissionGrants(), runtime.redactionKeys),
                runtime.desktopSettings,
                [...this.permissions.values()].some((pending) => pending.workspaceId === runtime.workspaceId && pending.sessionId === runtime.sessionId)
                    ? "approval"
                    : [...this.questions.values()].some((pending) => pending.workspaceId === runtime.workspaceId && pending.sessionId === runtime.sessionId)
                        ? "user" : undefined,
            );
            if (!saved) throw new Error("The session no longer exists.");
            runtime.revision = saved.revision ?? runtime.revision + 1;
        } catch (error) {
            if (error instanceof SessionConflictError) {
                runtime.sessionRevisionConflict = true;
                runtime.agent.abort();
                this.dismissPending(runtime);
                runtime.sessionPersistWarningShown = true;
                this.publish(runtime, {
                    type: "notice",
                    level: "warning",
                    text: "会话已被其他进程修改。为避免覆盖内容，当前任务已停止；请重新打开此会话以载入最新版本。",
                });
                return;
            }
            if (runtime.sessionPersistWarningShown) return;
            runtime.sessionPersistWarningShown = true;
            this.publish(runtime, {
                type: "notice",
                level: "warning",
                text: "无法保存部分会话进度；请检查本地会话目录和磁盘空间。",
            });
        }
    }

    private requestPermission(
        runtime: SessionRuntime,
        request: PermissionRequest,
    ): Promise<"once" | "session" | false> {
        const requestId = randomUUID();
        const operation = safeToolInput(request.toolName, request.input, runtime.workspaceRoot, runtime.redactionKeys);
        const message = redact(request.message, runtime.redactionKeys);
        const source = safePermissionSource(request.source, runtime.redactionKeys);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const pending = this.permissions.get(requestId);
                if (!pending) return;
                this.permissions.delete(requestId);
                this.recordPermissionOutcome(runtime, pending, "expired");
                this.publish(runtime, {
                    type: "permission.resolved",
                    requestId,
                    toolCallId: pending.toolCallId,
                    toolName: pending.toolName,
                    operation: pending.operation,
                    source: pending.source,
                    outcome: "expired",
                });
                pending.resolve(false);
            }, 120_000);
            const pending: PendingPermission = {
                workspaceId: runtime.workspaceId,
                sessionId: runtime.sessionId,
                requestId,
                toolCallId: request.toolCallId,
                toolName: request.toolName,
                operation,
                message,
                source,
                ...(request.key ? { key: request.key } : {}),
                resolve,
                timer,
            };
            this.permissions.set(requestId, pending);
            this.persistSession(runtime);
            this.publish(runtime, {
                type: "permission.requested",
                requestId,
                toolCallId: pending.toolCallId,
                toolName: pending.toolName,
                operation,
                message,
                source,
            });
        });
    }

    private recordPermissionOutcome(runtime: SessionRuntime, pending: PendingPermission, outcome: PermissionOutcome): void {
        const now = new Date().toISOString();
        let found = false;
        runtime.activities = runtime.activities.map((activity) => {
            if (activity.id !== pending.toolCallId) return activity;
            found = true;
            return {
                ...activity,
                permissionSource: pending.source,
                permissionDecision: "confirm",
                permissionOutcome: outcome,
                ...(outcome === "denied" || outcome === "expired" ? { state: "denied" as const }
                    : outcome === "cancelled" ? { state: "interrupted" as const } : {}),
                updatedAt: now,
            };
        });
        if (!found) {
            const state: SessionActivity["state"] = outcome === "cancelled" ? "interrupted"
                : outcome === "denied" || outcome === "expired" ? "denied" : "notice";
            runtime.activities = [...runtime.activities, {
                id: pending.toolCallId,
                ...(runtime.currentRunId ? { runId: runtime.currentRunId } : {}),
                title: pending.toolName,
                detail: JSON.stringify(pending.operation, null, 2),
                state,
                permissionSource: pending.source,
                permissionDecision: "confirm" as const,
                permissionOutcome: outcome,
                startedAt: now,
                updatedAt: now,
            }].slice(-MAX_SESSION_ACTIVITIES);
        }
        this.persistSession(runtime);
    }

    private askUser(runtime: SessionRuntime, question: string, options?: string[]): Promise<string> {
        const requestId = randomUUID();
        const safeQuestion = redact(question, runtime.redactionKeys);
        const safeOptions = options?.map((option) => redact(option, runtime.redactionKeys));
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (!this.questions.has(requestId)) return;
                this.questions.delete(requestId);
                runtime.activities = updateQuestionActivity(runtime.activities, requestId, runtime.currentRunId,
                    safeQuestion, new Date().toISOString(), "expired");
                this.persistSession(runtime);
                this.publish(runtime, { type: "question.resolved", requestId, outcome: "expired" });
                resolve("The user did not answer before this question expired. Do not treat this as a response.");
            }, 300_000);
            this.questions.set(requestId, {
                workspaceId: runtime.workspaceId,
                sessionId: runtime.sessionId,
                requestId,
                question: safeQuestion,
                options: safeOptions,
                resolve,
                timer,
            });
            runtime.activities = updateQuestionActivity(runtime.activities, requestId, runtime.currentRunId,
                safeQuestion, new Date().toISOString());
            this.persistSession(runtime);
            this.publish(runtime, {
                type: "question.requested",
                requestId,
                question: safeQuestion,
                options: safeOptions,
            });
        });
    }

    private dismissPending(runtime: SessionRuntime): void {
        for (const [id, pending] of this.permissions) {
            if (pending.workspaceId !== runtime.workspaceId || pending.sessionId !== runtime.sessionId) continue;
            clearTimeout(pending.timer);
            this.permissions.delete(id);
            this.recordPermissionOutcome(runtime, pending, "cancelled");
            this.publish(runtime, {
                type: "permission.resolved",
                requestId: id,
                toolCallId: pending.toolCallId,
                toolName: pending.toolName,
                operation: pending.operation,
                source: pending.source,
                outcome: "cancelled",
            });
            pending.resolve(false);
        }
        for (const [id, pending] of this.questions) {
            if (pending.workspaceId !== runtime.workspaceId || pending.sessionId !== runtime.sessionId) continue;
            clearTimeout(pending.timer);
            this.questions.delete(id);
            runtime.activities = updateQuestionActivity(runtime.activities, id, runtime.currentRunId,
                pending.question, new Date().toISOString(), "cancelled");
            this.persistSession(runtime);
            this.publish(runtime, { type: "question.resolved", requestId: id, outcome: "cancelled" });
            pending.resolve("The task was stopped before the user answered this question.");
        }
    }

    private publish(runtime: SessionRuntime, payload: DesktopEventPayload | AgentEvent, runId = runtime.currentRunId): void {
        const safePayload: DesktopEventPayload = "type" in payload && (payload.type === "session.status"
            || payload.type === "permission.requested" || payload.type === "permission.resolved"
            || payload.type === "question.requested" || payload.type === "question.resolved")
                ? payload
                : { type: "agent", event: safeAgentEvent(payload as AgentEvent, runtime.workspaceRoot, runtime.redactionKeys) };
        try {
            const key = sessionKey(runtime.workspaceId, runtime.sessionId);
            const sequence = this.eventSequences.next(key);
            this.emitToRenderer({
                version: 1,
                eventId: randomUUID(),
                workspaceId: runtime.workspaceId,
                sessionId: runtime.sessionId,
                runId,
                sequence,
                timestamp: new Date().toISOString(),
                payload: redactSessionMessages([safePayload], runtime.redactionKeys)[0] as DesktopEventPayload,
            });
        } catch { /* UI delivery is optional; unanswered approvals time out denied. */ }
    }
}
