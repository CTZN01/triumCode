import type { AgentContextUsage, AgentEvent, AgentUsage } from "../../../src/agent.js";
import type { DesktopSessionSettings, SessionActivity } from "../../../src/session.js";
import type { PermissionOutcome, PermissionSource, SessionPermissionGrantSummary } from "../../../src/permissions.js";

export type { SessionActivity };

export type Protocol = "anthropic" | "openai-chat" | "openai-responses";
export type AuthScheme = "api-key" | "bearer";
export type PermissionChoice = "once" | "session" | "deny";

export interface WorkspaceSummary {
    id: string;
    name: string;
    path: string;
    branch: string | null;
    available: boolean;
}

export interface WorkspaceChangedEvent {
    workspaceId: string;
}

export interface SessionSummary {
    id: string;
    created: string;
    updated: string;
    model: string;
    title: string;
    messageCount: number;
    status: "idle" | "running" | "interrupted" | "cancelled" | "failed";
}

export type DesktopTaskStatus = "running" | "waiting-approval" | "waiting-user" | "completed" | "interrupted" | "cancelled" | "failed";

export interface DesktopTaskSummary {
    id: string;
    workspace: WorkspaceSummary;
    session: SessionSummary;
    status: DesktopTaskStatus;
    runId: string | null;
    latestActivityId: string | null;
    latestActivityTitle: string | null;
}

export interface DesktopTaskCenterData {
    tasks: DesktopTaskSummary[];
}

export interface WorktreeSetupData {
    repositoryName: string;
    currentBranch: string | null;
    branches: string[];
    dirty: boolean;
    defaultBase: string;
}

export interface CreateWorktreeRequest {
    taskName: string;
    branchName: string;
    baseRef: string;
    parentPath: string;
    confirmDirtySource: boolean;
}

export interface CreateWorktreeResult {
    workspace: WorkspaceSummary;
    branchName: string;
    baseCommit: string;
    sourceDirty: boolean;
}

export interface WorktreeAssociation {
    workspaceId: string;
    workspacePath: string;
    taskName: string;
    branchName: string;
    sourceWorkspaceId: string;
    sourcePath: string;
    sourceBranch: string | null;
    baseCommit: string;
    createdAt: string;
}

export interface WorktreeReviewSnapshot {
    branchName: string;
    currentCommit: string;
    commitCount: number;
    sourceCurrentBranch: string | null;
    sourceDirty: boolean;
    worktreeDirty: boolean;
    diff: string;
    diffTruncated: boolean;
}

export interface WorktreeMergeResult {
    outcome: "merged" | "conflict";
    message: string;
}

export interface WorktreeRemovalResult {
    sourceWorkspaceId: string;
    branchDeleted: boolean;
    message: string;
}

export interface GitFileChange {
    path: string;
    indexStatus: string;
    worktreeStatus: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
}

export interface GitSnapshot {
    isGit: boolean;
    branch: string | null;
    files: GitFileChange[];
    filesTruncated?: boolean;
    error?: string;
}

export interface GitCommitSummary {
    hash: string;
    subject: string;
    author: string;
    authoredAt: string;
    decorations: string;
    graph: string;
    parents: string[];
}

export interface GitHistory {
    currentBranch: string | null;
    branches: string[];
    dirty: boolean;
    commits: GitCommitSummary[];
}

export interface GitCommitDetail {
    hash: string;
    parents: string[];
    author: string;
    authorEmail: string;
    authoredAt: string;
    message: string;
    stats: string;
    statsTruncated: boolean;
}

export interface GitFileDiff {
    path: string;
    staged: boolean;
    content: string;
    truncated: boolean;
    stale?: boolean;
    notice?: string;
}

export interface ReviewFile {
    path: string;
    status: "added" | "modified" | "deleted";
    source: "agent-file-tool" | "git-status";
    preexisting: boolean;
    indexStatus?: string;
    worktreeStatus?: string;
    baselineHash: string | null;
    currentHash: string | null;
    diff: string;
    truncated: boolean;
    canRestore: boolean;
    notice?: string;
}

export interface CodeReviewSnapshot {
    runId: string | null;
    sessionId: string | null;
    startedAt: string | null;
    status: SessionSummary["status"] | null;
    isGit: boolean;
    git: GitSnapshot;
    files: ReviewFile[];
    preexisting: GitFileChange[];
    coverage: "complete" | "partial" | "unavailable";
    notice?: string;
}

export interface ReviewRestoreResult {
    restored: boolean;
    stale: boolean;
}

export interface TerminalSummary {
    id: string;
    workspaceId: string;
    cwd: string;
    shell: string;
}

export interface TerminalEvent {
    terminalId: string;
    workspaceId: string;
    payload:
        | { type: "data"; data: string }
        | { type: "output-truncated"; droppedBytes: number }
        | { type: "exit"; exitCode: number; signal?: number };
}

export interface ConversationMessage {
    id: string;
    role: "user" | "assistant";
    text: string;
}

export interface ConversationPage {
    messages: ConversationMessage[];
    nextCursor: number | null;
}

export interface DesktopAttachment {
    path: string;
    content: string;
}

export interface DesktopSettings {
    model: string;
    modelPreset: string | null;
    apiBase: string;
    protocol: Protocol;
    auth: AuthScheme;
    thinking: boolean;
    effort: string;
    contextWindow: number;
    maxParallelRuns: number;
}

export interface DesktopModelPreset {
    name: string;
    model: string;
    apiBase?: string;
    protocol?: Protocol;
    auth?: AuthScheme;
    contextWindow?: number;
    hasApiKey: boolean;
}

export type CredentialState = "secure-key" | "cli-key-available" | "environment-key" | "missing" | "unsupported";

export interface BootstrapData {
    workspaces: WorkspaceSummary[];
    activeWorkspaceId: string | null;
    settings: DesktopSettings;
    modelPresets: DesktopModelPreset[];
    credentialState: CredentialState;
}

export interface OpenSessionData {
    session: SessionSummary;
    route: DesktopSessionSettings;
    messages: ConversationMessage[];
    messageCursor: number | null;
    activities: SessionActivity[];
    usage: AgentUsage;
    contextUsage: AgentContextUsage | null;
    runId: string | null;
    externalRun: boolean;
    permissionMode: "desktopDefault" | "desktopAcceptEdits" | "bypassPermissions" | "plan";
    approvals: PendingPermissionRequest[];
    questions: PendingUserQuestion[];
    permissionGrants: SessionPermissionGrantSummary[];
    eventSequence: number;
}

export interface PendingPermissionRequest {
    requestId: string;
    toolCallId: string;
    toolName: string;
    operation: Record<string, unknown>;
    message: string;
    source: PermissionSource;
}

export interface PendingUserQuestion {
    requestId: string;
    question: string;
    options?: string[];
}

export type DesktopEventPayload =
    | { type: "session.status"; status: SessionSummary["status"] }
    | { type: "agent"; event: AgentEvent }
    | {
        type: "permission.requested";
        requestId: string;
        toolCallId: string;
        toolName: string;
        operation: Record<string, unknown>;
        message: string;
        source: PermissionSource;
    }
    | {
        type: "permission.resolved";
        requestId: string;
        toolCallId: string;
        toolName: string;
        operation: Record<string, unknown>;
        source: PermissionSource;
        outcome: PermissionOutcome;
        grantId?: string;
    }
    | {
        type: "question.requested";
        requestId: string;
        question: string;
        options?: string[];
    }
    | {
        type: "question.resolved";
        requestId: string;
        outcome: "answered" | "skipped" | "expired" | "cancelled";
    };

export interface DesktopEvent {
    version: 1;
    eventId: string;
    workspaceId: string;
    sessionId: string;
    runId: string | null;
    sequence: number;
    timestamp: string;
    payload: DesktopEventPayload;
}

export interface DesktopDialogRequest {
    id: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
}

export interface DesktopApi {
    getBootstrap(): Promise<BootstrapData>;
    listTasks(): Promise<DesktopTaskCenterData>;
    getWorktreeSetup(workspaceId: string): Promise<WorktreeSetupData>;
    getWorktreeAssociation(workspaceId: string): Promise<WorktreeAssociation | null>;
    getWorktreeReview(workspaceId: string): Promise<WorktreeReviewSnapshot>;
    mergeWorktree(workspaceId: string): Promise<WorktreeMergeResult>;
    removeWorktree(workspaceId: string, deleteBranch: boolean): Promise<WorktreeRemovalResult>;
    chooseWorktreeParent(): Promise<string | null>;
    createWorktree(workspaceId: string, request: CreateWorktreeRequest): Promise<CreateWorktreeResult>;
    chooseWorkspace(): Promise<WorkspaceSummary | null>;
    activateWorkspace(workspaceId: string): Promise<WorkspaceSummary>;
    removeWorkspace(workspaceId: string): Promise<void>;
    listSessions(workspaceId: string): Promise<SessionSummary[]>;
    createSession(workspaceId: string): Promise<OpenSessionData>;
    openSession(workspaceId: string, sessionId: string): Promise<OpenSessionData>;
    getEarlierMessages(workspaceId: string, sessionId: string, before: number): Promise<ConversationPage>;
    updateSessionRoute(workspaceId: string, sessionId: string, modelPreset: string | null, effort: string): Promise<void>;
    updatePermissionMode(workspaceId: string, sessionId: string, mode: "desktopDefault" | "desktopAcceptEdits" | "bypassPermissions"): Promise<void>;
    toggleWindowMaximize(): Promise<void>;
    setTitleBarOverlay(theme: "dark" | "light"): Promise<void>;
    onDialogRequest(callback: (request: DesktopDialogRequest) => void): () => void;
    respondDialog(id: string, accepted: boolean): Promise<void>;
    copyText(text: string): Promise<void>;
    renameSession(workspaceId: string, sessionId: string, title: string): Promise<SessionSummary>;
    deleteSession(workspaceId: string, sessionId: string): Promise<{ reviewRemoved: boolean }>;
    getGitSnapshot(workspaceId: string): Promise<GitSnapshot>;
    getGitHistory(workspaceId: string): Promise<GitHistory>;
    getGitCommitDetail(workspaceId: string, hash: string): Promise<GitCommitDetail>;
    switchGitBranch(workspaceId: string, branch: string): Promise<void>;
    createGitBranch(workspaceId: string, branch: string): Promise<void>;
    getGitDiff(workspaceId: string, path: string, staged: boolean): Promise<GitFileDiff>;
    stageGitPath(workspaceId: string, path: string): Promise<void>;
    unstageGitPath(workspaceId: string, path: string): Promise<void>;
    commitGitChanges(workspaceId: string, message: string): Promise<string>;
    getCodeReview(workspaceId: string, sessionId: string): Promise<CodeReviewSnapshot>;
    checkReviewFile(workspaceId: string, runId: string, path: string, expectedCurrentHash: string | null): Promise<boolean>;
    restoreReviewFile(workspaceId: string, runId: string, path: string, expectedCurrentHash: string | null): Promise<ReviewRestoreResult>;
    createTerminal(workspaceId: string, cols: number, rows: number): Promise<TerminalSummary>;
    writeTerminal(terminalId: string, data: string): Promise<void>;
    resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
    closeTerminal(terminalId: string): Promise<void>;
    startRun(workspaceId: string, sessionId: string, text: string, requestId: string): Promise<{ runId: string }>;
    retryRun(workspaceId: string, sessionId: string, requestId: string): Promise<{ runId: string }>;
    cancelRun(runId: string): Promise<void>;
    respondToPermission(requestId: string, choice: PermissionChoice): Promise<void>;
    listPermissionGrants(workspaceId: string, sessionId: string): Promise<SessionPermissionGrantSummary[]>;
    revokePermissionGrant(workspaceId: string, sessionId: string, grantId: string): Promise<boolean>;
    respondToQuestion(requestId: string, answer: string): Promise<void>;
    saveSettings(settings: DesktopSettings): Promise<DesktopSettings>;
    getCredentialState(presetName: string | null): Promise<CredentialState>;
    saveApiKey(apiKey: string, presetName: string | null): Promise<CredentialState>;
    importCliCredential(presetName: string | null): Promise<CredentialState>;
    clearApiKey(presetName: string | null): Promise<CredentialState>;
    testConnection(): Promise<{ ok: boolean; message: string }>;
    onEvent(callback: (event: DesktopEvent) => void): () => void;
    onTerminalEvent(callback: (event: TerminalEvent) => void): () => void;
    onWorkspaceChanged(callback: (event: WorkspaceChangedEvent) => void): () => void;
}
