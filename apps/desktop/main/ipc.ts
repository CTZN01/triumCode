import { clipboard, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { CreateWorktreeRequest, PermissionChoice } from "../shared/contracts.js";
import { AgentHost } from "./agent-host.js";
import type { TerminalService } from "./terminal-service.js";
import type { WorkspaceWatchService } from "./workspace-watch-service.js";
import { DesktopServiceError } from "./workspace-store.js";
import { parseSettings } from "./settings-input.js";
import type { EffortLevel } from "../../../src/thinking.js";
import { MAX_ATTACHMENTS, MAX_IMAGE_SOURCE_BYTES } from "../../../src/attachments.js";

interface IpcDependencies {
    host: AgentHost;
    terminals: TerminalService;
    workspaceWatch: WorkspaceWatchService;
    getWindow: () => BrowserWindow | null;
}

const pendingDialogResponses = new Map<string, (accepted: boolean) => void>();
let dialogSequence = 0;

/** Shows the renderer's in-app confirm dialog and resolves with the user's choice. */
export function requestRendererDialog(window: BrowserWindow, message: string, confirmLabel: string, danger = false): Promise<boolean> {
    const id = `dialog-${++dialogSequence}`;
    return new Promise((resolve) => {
        if (window.isDestroyed()) {
            resolve(false);
            return;
        }
        pendingDialogResponses.set(id, resolve);
        window.webContents.send("desktop:dialog-request", { id, message, confirmLabel, danger });
    });
}

function assertTrusted(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | null): void {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
        throw new DesktopServiceError("UNTRUSTED_SENDER", "This request did not come from the TriumCode desktop window.");
    }
}

function stringArg(value: unknown, field: string, maxLength = 1000): string {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
        throw new DesktopServiceError("INVALID_ARGUMENT", `${field} is invalid.`);
    }
    return value;
}

function modelPresetName(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !value || value.length > 200) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "modelPreset is invalid.");
    }
    return value;
}

function workspaceId(value: unknown): string {
    const id = stringArg(value, "workspaceId", 32);
    if (!/^[a-f0-9]{20}$/i.test(id)) throw new DesktopServiceError("INVALID_ARGUMENT", "workspaceId is invalid.");
    return id;
}

function sessionId(value: unknown): string {
    const id = stringArg(value, "sessionId", 8);
    if (!/^[a-f0-9]{8}$/i.test(id)) throw new DesktopServiceError("INVALID_ARGUMENT", "sessionId is invalid.");
    return id;
}

function requestId(value: unknown): string {
    const id = stringArg(value, "requestId", 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "requestId is invalid.");
    }
    return id;
}

function expectedHash(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "The reviewed file version is invalid.");
    }
    return value;
}

function worktreeRequest(value: unknown): CreateWorktreeRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "隔离工作区参数无效。");
    }
    const input = value as Partial<CreateWorktreeRequest>;
    const allowed = new Set(["taskName", "branchName", "baseRef", "parentPath", "confirmDirtySource"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "隔离工作区参数包含未知字段。");
    }
    if (typeof input.taskName !== "string" || input.taskName.length > 80
        || typeof input.branchName !== "string" || input.branchName.length > 120
        || typeof input.baseRef !== "string" || input.baseRef.length > 200
        || typeof input.parentPath !== "string" || input.parentPath.length > 4_096
        || typeof input.confirmDirtySource !== "boolean") {
        throw new DesktopServiceError("INVALID_ARGUMENT", "隔离工作区参数格式无效。");
    }
    return {
        taskName: input.taskName,
        branchName: input.branchName,
        baseRef: input.baseRef,
        parentPath: input.parentPath,
        confirmDirtySource: input.confirmDirtySource,
    };
}

function terminalId(value: unknown): string {
    const id = stringArg(value, "terminalId", 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
        throw new DesktopServiceError("INVALID_ARGUMENT", "terminalId is invalid.");
    }
    return id;
}

function terminalSize(value: unknown, field: string, maximum: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new DesktopServiceError("INVALID_ARGUMENT", `${field} is invalid.`);
    }
    return value;
}

export function registerIpcHandlers({ host, terminals, workspaceWatch, getWindow }: IpcDependencies): void {
    const handle = (channel: string, callback: (...args: unknown[]) => unknown | Promise<unknown>): void => {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
            assertTrusted(event, getWindow);
            return callback(...args);
        });
    };

    handle("desktop:dialog-response", (id, accepted) => {
        const key = stringArg(id, "id", 64);
        const resolve = pendingDialogResponses.get(key);
        if (!resolve) return;
        pendingDialogResponses.delete(key);
        resolve(accepted === true);
    });
    handle("desktop:copy-text", (text) => {
        clipboard.writeText(stringArg(text, "text", 200_000));
    });

    handle("desktop:bootstrap", () => host.bootstrap());
    handle("desktop:tasks", () => host.listTasks());
    handle("desktop:worktree-setup", (workspace) => host.getWorktreeSetup(workspaceId(workspace)));
    handle("desktop:worktree-association", (workspace) => host.getWorktreeAssociation(workspaceId(workspace)));
    handle("desktop:choose-worktree-parent", async () => {
        const window = getWindow();
        if (!window) return null;
        const result = await dialog.showOpenDialog(window, {
            title: "选择隔离工作区的父目录",
            properties: ["openDirectory"],
        });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });
    handle("desktop:worktree-create", async (workspace, request) => {
        const created = await host.createWorktree(workspaceId(workspace), worktreeRequest(request));
        workspaceWatch.watchWorkspace(created.workspace.id);
        return created;
    });
    handle("desktop:worktree-review", (workspace) => host.getWorktreeReview(workspaceId(workspace)));
    handle("desktop:worktree-merge", (workspace) => {
        const targetId = workspaceId(workspace);
        const association = host.getWorktreeAssociation(targetId);
        if (association && (terminals.hasOpenTerminals(targetId) || terminals.hasOpenTerminals(association.sourceWorkspaceId))) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "关闭源工作区和隔离工作区的终端后再合并。");
        }
        return host.mergeWorktree(targetId);
    });
    handle("desktop:worktree-remove", async (workspace, deleteBranch) => {
        const targetId = workspaceId(workspace);
        if (typeof deleteBranch !== "boolean") throw new DesktopServiceError("INVALID_ARGUMENT", "分支保留选择无效。");
        const association = host.getWorktreeAssociation(targetId);
        if (association && (terminals.hasOpenTerminals(targetId) || terminals.hasOpenTerminals(association.sourceWorkspaceId))) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "关闭源工作区和隔离工作区的终端后再移除工作树。");
        }
        const result = await host.removeWorktree(targetId, deleteBranch);
        workspaceWatch.closeWorkspace(targetId);
        return result;
    });
    handle("desktop:choose-workspace", async () => {
        const window = getWindow();
        if (!window) return null;
        const result = await dialog.showOpenDialog(window, {
            title: "Open a project folder",
            properties: ["openDirectory", "createDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        const workspace = host.openWorkspace(result.filePaths[0]);
        workspaceWatch.watchWorkspace(workspace.id);
        return workspace;
    });
    handle("desktop:activate-workspace", (id) => {
        const workspace = host.activateWorkspace(workspaceId(id));
        workspaceWatch.watchWorkspace(workspace.id);
        return workspace;
    });
    handle("desktop:remove-workspace", (id) => {
        const targetId = workspaceId(id);
        if (terminals.hasOpenTerminals(targetId)) {
            throw new DesktopServiceError("WORKSPACE_BUSY", "Close this workspace's terminal before removing it from recents.");
        }
        host.removeWorkspace(targetId);
        workspaceWatch.closeWorkspace(targetId);
    });
    handle("desktop:list-sessions", (id) => host.listSessions(workspaceId(id)));
    handle("desktop:create-session", (id) => host.createSession(workspaceId(id)));
    handle("desktop:open-session", (workspace, session) => host.openSession(workspaceId(workspace), sessionId(session)));
    handle("desktop:earlier-messages", (workspace, session, before) => {
        if (typeof before !== "number" || !Number.isSafeInteger(before) || before < 0) {
            throw new DesktopServiceError("INVALID_ARGUMENT", "Message cursor is invalid.");
        }
        return host.getEarlierMessages(workspaceId(workspace), sessionId(session), before);
    });
    handle("desktop:rename-session", (workspace, session, title) =>
        host.renameSession(workspaceId(workspace), sessionId(session), stringArg(title, "title", 120)));
    handle("desktop:delete-session", (workspace, session) => host.deleteSession(workspaceId(workspace), sessionId(session)));
    handle("desktop:git-snapshot", (workspace) => host.getGitSnapshot(workspaceId(workspace)));
    handle("desktop:git-history", (workspace) => host.getGitHistory(workspaceId(workspace)));
    handle("desktop:git-commit-detail", (workspace, hash) =>
        host.getGitCommitDetail(workspaceId(workspace), stringArg(hash, "hash", 64)));
    handle("desktop:git-switch-branch", (workspace, branch) =>
        host.switchGitBranch(workspaceId(workspace), stringArg(branch, "branch", 120)));
    handle("desktop:git-create-branch", (workspace, branch) =>
        host.createGitBranch(workspaceId(workspace), stringArg(branch, "branch", 120)));
    handle("desktop:git-diff", (workspace, path, staged) => {
        if (typeof staged !== "boolean") throw new DesktopServiceError("INVALID_ARGUMENT", "Diff type is invalid.");
        return host.getGitDiff(workspaceId(workspace), stringArg(path, "path", 32_000), staged);
    });
    handle("desktop:git-diffs", (workspace, path) =>
        host.getGitDiffs(workspaceId(workspace), stringArg(path, "path", 32_000)));
    handle("desktop:git-stage-path", (workspace, path) =>
        host.stageGitPath(workspaceId(workspace), stringArg(path, "path", 32_000)));
    handle("desktop:git-unstage-path", (workspace, path) =>
        host.unstageGitPath(workspaceId(workspace), stringArg(path, "path", 32_000)));
    handle("desktop:git-commit", (workspace, message) =>
        host.commitGitChanges(workspaceId(workspace), stringArg(message, "message", 500)));
    handle("desktop:code-review", (workspace, session) => host.getCodeReview(workspaceId(workspace), sessionId(session)));
    handle("desktop:review-file-check", (workspace, run, path, hash) => host.checkReviewFile(
        workspaceId(workspace),
        requestId(run),
        stringArg(path, "path", 32_000),
        expectedHash(hash),
    ));
    handle("desktop:review-file-restore", (workspace, run, path, hash) => host.restoreReviewFile(
        workspaceId(workspace),
        requestId(run),
        stringArg(path, "path", 32_000),
        expectedHash(hash),
    ));
    handle("desktop:terminal-create", (workspace, cols, rows) => {
        const targetId = workspaceId(workspace);
        host.assertTerminalCanOpen(targetId);
        return terminals.create(
            targetId,
            terminalSize(cols, "cols", 500),
            terminalSize(rows, "rows", 200),
        );
    });
    handle("desktop:terminal-write", (id, data) => {
        if (typeof data !== "string" || data.length > 64 * 1024) {
            throw new DesktopServiceError("INVALID_ARGUMENT", "Terminal input is invalid.");
        }
        terminals.write(terminalId(id), data);
    });
    handle("desktop:terminal-resize", (id, cols, rows) => terminals.resize(
        terminalId(id),
        terminalSize(cols, "cols", 500),
        terminalSize(rows, "rows", 200),
    ));
    handle("desktop:terminal-close", (id) => terminals.close(terminalId(id)));
    handle("desktop:attachment-path", (workspace, session, path) => host.addAttachmentPath(
        workspaceId(workspace), sessionId(session), stringArg(path, "filePath", 4096),
    ));
    handle("desktop:attachment-image", (workspace, session, bytes, name) => {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_IMAGE_SOURCE_BYTES) throw new Error("图片不能为空或超过 20 MiB。");
        return host.addAttachmentImage(workspaceId(workspace), sessionId(session), Buffer.from(bytes), stringArg(name, "fileName", 255));
    });
    handle("desktop:attachment-clipboard", async (workspace, session) => {
        const items = await clipboard.read();
        for (const item of items) {
            const mime = item.types.find(type => ["image/png", "image/jpeg", "image/webp"].includes(type));
            if (!mime) continue;
            const blob = await item.getType(mime);
            if (!(blob instanceof Blob) || blob.size > MAX_IMAGE_SOURCE_BYTES) throw new Error("图片不能超过 20 MiB。");
            return host.addAttachmentImage(workspaceId(workspace), sessionId(session), Buffer.from(await blob.arrayBuffer()), `pasted-image.${mime.split("/")[1]}`);
        }
        throw new Error("剪贴板中没有可读取的图片。");
    });
    handle("desktop:attachment-choose", async (workspace, session) => {
        const workspaceValue = workspaceId(workspace);
        const sessionValue = sessionId(session);
        const window = getWindow();
        if (!window) throw new Error("窗口不可用。");
        const selected = await dialog.showOpenDialog(window, { title: "添加图片或文件", properties: ["openFile", "multiSelections"] });
        if (selected.canceled) return [];
        if (selected.filePaths.length > MAX_ATTACHMENTS) throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS} 个附件。`);
        const added = [];
        try {
            for (const path of selected.filePaths) added.push(await host.addAttachmentPath(workspaceValue, sessionValue, path));
            return added;
        } catch (error) {
            await Promise.all(added.map(attachment => host.removeAttachment(workspaceValue, sessionValue, attachment.id)));
            throw error;
        }
    });
    handle("desktop:attachment-remove", (workspace, session, id) => host.removeAttachment(workspaceId(workspace), sessionId(session), stringArg(id, "attachmentId", 36)));
    handle("desktop:attachment-preview", (workspace, session, id, full) => host.getAttachmentPreview(workspaceId(workspace), sessionId(session), stringArg(id, "attachmentId", 36), full === true));
    handle("desktop:start-run", (workspace, session, text, request, ids = [], interrupt = false) => {
        if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || !ids.every(id => typeof id === "string" && id.length === 36)) throw new Error("附件 ID 列表无效。");
        if (typeof text !== "string" || text.length > 100_000) throw new Error("消息文本无效或过长。");
        if (typeof interrupt !== "boolean") throw new Error("中断参数无效。");
        return host.startRun(
            workspaceId(workspace), sessionId(session), text, requestId(request), ids, interrupt,
        );
    });
    handle("desktop:retry-run", (workspace, session, request) => host.retryRun(
        workspaceId(workspace),
        sessionId(session),
        requestId(request),
    ));
    handle("desktop:cancel-run", (run) => host.cancelRun(stringArg(run, "runId", 36)));
    handle("desktop:cancel-submitted-run", (request) => host.cancelSubmittedRun(requestId(request)));
    handle("desktop:permission-response", (request, choice) => {
        const value = stringArg(choice, "choice", 16) as PermissionChoice;
        if (value !== "once" && value !== "session" && value !== "deny") {
            throw new DesktopServiceError("INVALID_ARGUMENT", "Approval choice is invalid.");
        }
        host.respondToPermission(requestId(request), value);
    });
    handle("desktop:permission-grants", (workspace, session) => host.listPermissionGrants(
        workspaceId(workspace),
        sessionId(session),
    ));
    handle("desktop:permission-grant-revoke", (workspace, session, grant) => host.revokePermissionGrant(
        workspaceId(workspace),
        sessionId(session),
        requestId(grant),
    ));
    handle("desktop:question-response", (request, answer) => {
        if (typeof answer !== "string" || answer.length > 20_000) {
            throw new DesktopServiceError("INVALID_ARGUMENT", "Answer is invalid.");
        }
        host.respondToQuestion(requestId(request), answer);
    });
    handle("desktop:settings-save", (settings) => host.saveSettings(parseSettings(settings)));
    handle("desktop:session-route", (workspace, session, preset, effort) => {
        const level = stringArg(effort, "effort", 8);
        if (!["low", "medium", "high", "xhigh", "max"].includes(level)) {
            throw new DesktopServiceError("INVALID_ARGUMENT", "思考深度无效。");
        }
        host.updateSessionRoute(workspaceId(workspace), sessionId(session), modelPresetName(preset), level as EffortLevel);
    });
    handle("desktop:permission-mode", (workspace, session, mode) => {
        const selected = stringArg(mode, "mode", 32);
        if (selected !== "desktopDefault" && selected !== "desktopAcceptEdits" && selected !== "bypassPermissions") {
            throw new DesktopServiceError("INVALID_ARGUMENT", "权限模式无效。");
        }
        host.updatePermissionMode(workspaceId(workspace), sessionId(session), selected);
    });
    handle("desktop:toggle-window-maximize", () => {
        const window = getWindow();
        if (!window) return;
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
    });
    handle("desktop:set-titlebar-overlay", (theme) => {
        const window = getWindow();
        if (!window || process.platform !== "win32") return;
        const selected = stringArg(theme, "theme", 8);
        if (selected !== "dark" && selected !== "light") {
            throw new DesktopServiceError("INVALID_ARGUMENT", "主题无效。");
        }
        window.setTitleBarOverlay(selected === "dark"
            ? { color: "#13151a", symbolColor: "#e8e8e8" }
            : { color: "#f1f3f7", symbolColor: "#242424" });
    });
    handle("desktop:credential-state", (preset) => host.credentialState(modelPresetName(preset)));
    handle("desktop:credential-save", (key, preset) => host.saveApiKey(
        stringArg(key, "apiKey", 10_000),
        modelPresetName(preset),
    ));
    handle("desktop:credential-import-cli", (preset) => host.importCliCredential(modelPresetName(preset)));
    handle("desktop:credential-clear", (preset) => host.clearApiKey(modelPresetName(preset)));
    handle("desktop:test-connection", () => host.testConnection());
}
