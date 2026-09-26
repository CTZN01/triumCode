import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopDialogRequest, DesktopEvent, TerminalEvent, WorkspaceChangedEvent } from "../shared/contracts.js";

const api: DesktopApi = {
    getBootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
    listTasks: () => ipcRenderer.invoke("desktop:tasks"),
    getWorktreeSetup: (workspaceId) => ipcRenderer.invoke("desktop:worktree-setup", workspaceId),
    getWorktreeAssociation: (workspaceId) => ipcRenderer.invoke("desktop:worktree-association", workspaceId),
    getWorktreeReview: (workspaceId) => ipcRenderer.invoke("desktop:worktree-review", workspaceId),
    mergeWorktree: (workspaceId) => ipcRenderer.invoke("desktop:worktree-merge", workspaceId),
    removeWorktree: (workspaceId, deleteBranch) => ipcRenderer.invoke("desktop:worktree-remove", workspaceId, deleteBranch),
    chooseWorktreeParent: () => ipcRenderer.invoke("desktop:choose-worktree-parent"),
    createWorktree: (workspaceId, request) => ipcRenderer.invoke("desktop:worktree-create", workspaceId, request),
    chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
    activateWorkspace: (workspaceId) => ipcRenderer.invoke("desktop:activate-workspace", workspaceId),
    removeWorkspace: (workspaceId) => ipcRenderer.invoke("desktop:remove-workspace", workspaceId),
    listSessions: (workspaceId) => ipcRenderer.invoke("desktop:list-sessions", workspaceId),
    createSession: (workspaceId) => ipcRenderer.invoke("desktop:create-session", workspaceId),
    openSession: (workspaceId, sessionId) => ipcRenderer.invoke("desktop:open-session", workspaceId, sessionId),
    updateSessionRoute: (workspaceId, sessionId, modelPreset, effort) => ipcRenderer.invoke("desktop:session-route", workspaceId, sessionId, modelPreset, effort),
    updatePermissionMode: (workspaceId, sessionId, mode) => ipcRenderer.invoke("desktop:permission-mode", workspaceId, sessionId, mode),
    toggleWindowMaximize: () => ipcRenderer.invoke("desktop:toggle-window-maximize"),
    setTitleBarOverlay: (theme) => ipcRenderer.invoke("desktop:set-titlebar-overlay", theme),
    renameSession: (workspaceId, sessionId, title) => ipcRenderer.invoke("desktop:rename-session", workspaceId, sessionId, title),
    deleteSession: (workspaceId, sessionId) => ipcRenderer.invoke("desktop:delete-session", workspaceId, sessionId),
    getGitSnapshot: (workspaceId) => ipcRenderer.invoke("desktop:git-snapshot", workspaceId),
    getGitDiff: (workspaceId, path, staged) => ipcRenderer.invoke("desktop:git-diff", workspaceId, path, staged),
    stageGitPath: (workspaceId, path) => ipcRenderer.invoke("desktop:git-stage-path", workspaceId, path),
    unstageGitPath: (workspaceId, path) => ipcRenderer.invoke("desktop:git-unstage-path", workspaceId, path),
    commitGitChanges: (workspaceId, message) => ipcRenderer.invoke("desktop:git-commit", workspaceId, message),
    getCodeReview: (workspaceId, sessionId) => ipcRenderer.invoke("desktop:code-review", workspaceId, sessionId),
    checkReviewFile: (workspaceId, runId, path, expectedCurrentHash) => ipcRenderer.invoke(
        "desktop:review-file-check", workspaceId, runId, path, expectedCurrentHash,
    ),
    restoreReviewFile: (workspaceId, runId, path, expectedCurrentHash) => ipcRenderer.invoke(
        "desktop:review-file-restore", workspaceId, runId, path, expectedCurrentHash,
    ),
    createTerminal: (workspaceId, cols, rows) => ipcRenderer.invoke("desktop:terminal-create", workspaceId, cols, rows),
    writeTerminal: (terminalId, data) => ipcRenderer.invoke("desktop:terminal-write", terminalId, data),
    resizeTerminal: (terminalId, cols, rows) => ipcRenderer.invoke("desktop:terminal-resize", terminalId, cols, rows),
    closeTerminal: (terminalId) => ipcRenderer.invoke("desktop:terminal-close", terminalId),
    startRun: (workspaceId, sessionId, text, requestId) => ipcRenderer.invoke("desktop:start-run", workspaceId, sessionId, text, requestId),
    retryRun: (workspaceId, sessionId, requestId) => ipcRenderer.invoke("desktop:retry-run", workspaceId, sessionId, requestId),
    cancelRun: (runId) => ipcRenderer.invoke("desktop:cancel-run", runId),
    respondToPermission: (requestId, choice) => ipcRenderer.invoke("desktop:permission-response", requestId, choice),
    listPermissionGrants: (workspaceId, sessionId) => ipcRenderer.invoke("desktop:permission-grants", workspaceId, sessionId),
    revokePermissionGrant: (workspaceId, sessionId, grantId) => ipcRenderer.invoke(
        "desktop:permission-grant-revoke", workspaceId, sessionId, grantId,
    ),
    respondToQuestion: (requestId, answer) => ipcRenderer.invoke("desktop:question-response", requestId, answer),
    saveSettings: (settings) => ipcRenderer.invoke("desktop:settings-save", settings),
    getCredentialState: (presetName) => ipcRenderer.invoke("desktop:credential-state", presetName),
    saveApiKey: (apiKey, presetName) => ipcRenderer.invoke("desktop:credential-save", apiKey, presetName),
    importCliCredential: (presetName) => ipcRenderer.invoke("desktop:credential-import-cli", presetName),
    clearApiKey: (presetName) => ipcRenderer.invoke("desktop:credential-clear", presetName),
    testConnection: () => ipcRenderer.invoke("desktop:test-connection"),
    onEvent: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: DesktopEvent): void => callback(payload);
        ipcRenderer.on("desktop:event", listener);
        return () => ipcRenderer.removeListener("desktop:event", listener);
    },
    onTerminalEvent: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: TerminalEvent): void => callback(payload);
        ipcRenderer.on("desktop:terminal-event", listener);
        return () => ipcRenderer.removeListener("desktop:terminal-event", listener);
    },
    onWorkspaceChanged: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: WorkspaceChangedEvent): void => callback(payload);
        ipcRenderer.on("desktop:workspace-changed", listener);
        return () => ipcRenderer.removeListener("desktop:workspace-changed", listener);
    },
    onDialogRequest: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: DesktopDialogRequest): void => callback(payload);
        ipcRenderer.on("desktop:dialog-request", listener);
        return () => ipcRenderer.removeListener("desktop:dialog-request", listener);
    },
    respondDialog: (id, accepted) => ipcRenderer.invoke("desktop:dialog-response", id, accepted),
};

contextBridge.exposeInMainWorld("desktop", api);
