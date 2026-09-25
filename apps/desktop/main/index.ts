import { app, BrowserWindow, dialog, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHost } from "./agent-host.js";
import { CredentialStore } from "./credential-store.js";
import { registerIpcHandlers } from "./ipc.js";
import { SettingsStore } from "./settings-store.js";
import { TerminalService } from "./terminal-service.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceWatchService } from "./workspace-watch-service.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let host: AgentHost | null = null;
let terminals: TerminalService | null = null;
let workspaceWatch: WorkspaceWatchService | null = null;
let closeAfterStopping = false;
let closePromptOpen = false;

function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 1440,
        height: 940,
        minWidth: 920,
        minHeight: 620,
        show: false,
        backgroundColor: "#111318",
        title: "TriumCode",
        webPreferences: {
            preload: join(here, "../preload/index.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
    });

    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const parsed = new URL(url);
            if (parsed.protocol === "https:") {
                void dialog.showMessageBox(window, {
                    type: "question",
                    title: "Open external link",
                    message: "Open this link in your default browser?",
                    detail: parsed.hostname,
                    buttons: ["Open link", "Cancel"],
                    defaultId: 1,
                    cancelId: 1,
                    noLink: true,
                }).then(({ response }) => {
                    if (response === 0 && !window.isDestroyed()) void shell.openExternal(url);
                });
            }
        } catch { /* non-URL windows are denied */ }
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => {
        void host?.stopAll();
        void terminals?.closeAll();
    });
    window.on("close", (event) => {
        if (closeAfterStopping || (!host?.hasRunningTasks() && !terminals?.hasOpenTerminals())) return;
        event.preventDefault();
        if (closePromptOpen) return;
        closePromptOpen = true;
        void dialog.showMessageBox(window, {
            type: "warning",
            title: "A task or terminal is still open",
            message: "Stop tasks, close terminals, and exit TriumCode?",
            detail: "Completed file changes stay in your workspace. Pending approvals will be denied, and terminal processes will be stopped.",
            buttons: ["Stop and exit", "Keep TriumCode open"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        }).then(async ({ response }) => {
            closePromptOpen = false;
            if (response !== 0) return;
            await host?.stopAll();
            await terminals?.closeAll();
            closeAfterStopping = true;
            window.close();
        });
    });
    window.on("closed", () => {
        if (mainWindow === window) mainWindow = null;
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) void window.loadURL(rendererUrl);
    else void window.loadFile(join(here, "../renderer/index.html"));
    return window;
}

if (hasSingleInstanceLock) {
    app.on("second-instance", () => {
        if (!mainWindow) mainWindow = createWindow();
        else if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(() => {
        app.setAppUserModelId("com.triumcode.desktop");
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        const userData = app.getPath("userData");
        const workspaces = new WorkspaceStore(userData);
        const settings = new SettingsStore(userData);
        const credentials = new CredentialStore(userData);
        const watchService = new WorkspaceWatchService(workspaces, (event) => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send("desktop:workspace-changed", event);
            }
        });
        workspaceWatch = watchService;
        const activeWorkspaceId = workspaces.activeId();
        if (activeWorkspaceId) watchService.watchWorkspace(activeWorkspaceId);
        terminals = new TerminalService(workspaces, (event) => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send("desktop:terminal-event", event);
            }
        });
        host = new AgentHost(workspaces, settings, credentials, userData, (event) => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send("desktop:event", event);
            }
        });
        registerIpcHandlers({ host, terminals, workspaceWatch: watchService, getWindow: () => mainWindow });
        mainWindow = createWindow();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
        });
    }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox("TriumCode could not start", message);
        app.quit();
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    app.on("before-quit", (event) => {
        workspaceWatch?.close();
        if (closeAfterStopping) return;
        if (!host?.hasRunningTasks() && !terminals?.hasOpenTerminals()) return;
        event.preventDefault();
        void Promise.all([host?.stopAll(), terminals?.closeAll()]).then(() => {
            closeAfterStopping = true;
            app.quit();
        });
    });
}
