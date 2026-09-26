import { app, BrowserWindow, dialog, screen, session, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHost } from "./agent-host.js";
import { CredentialStore } from "./credential-store.js";
import { registerIpcHandlers } from "./ipc.js";
import { SettingsStore } from "./settings-store.js";
import { TerminalService } from "./terminal-service.js";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceWatchService } from "./workspace-watch-service.js";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("TriumCode");
const dataDirectoryOverride = app.commandLine.getSwitchValue("user-data-dir");
const userDataPath = dataDirectoryOverride ? resolve(dataDirectoryOverride) : join(app.getPath("appData"), "triumcode");
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;
let host: AgentHost | null = null;
let terminals: TerminalService | null = null;
let workspaceWatch: WorkspaceWatchService | null = null;
let closeAfterStopping = false;
let closePromptOpen = false;
let windowStatePath = "";

interface SavedWindowState {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
}

function readWindowState(): SavedWindowState | null {
    if (!windowStatePath || !existsSync(windowStatePath)) return null;
    try {
        const value = JSON.parse(readFileSync(windowStatePath, "utf-8")) as Partial<SavedWindowState>;
        if (typeof value.x !== "number" || !Number.isSafeInteger(value.x)
            || typeof value.y !== "number" || !Number.isSafeInteger(value.y)
            || typeof value.width !== "number" || !Number.isSafeInteger(value.width) || value.width < 920 || value.width > 5_000
            || typeof value.height !== "number" || !Number.isSafeInteger(value.height) || value.height < 620 || value.height > 5_000) return null;
        return {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
            maximized: value.maximized === true,
        };
    } catch {
        return null;
    }
}

function initialWindowBounds(): { bounds: Electron.Rectangle; maximized: boolean } {
    const saved = readWindowState();
    const displays = screen.getAllDisplays();
    const visibleDisplay = saved && displays.find(({ workArea }) => saved.x < workArea.x + workArea.width
        && saved.x + saved.width > workArea.x
        && saved.y < workArea.y + workArea.height
        && saved.y + saved.height > workArea.y);
    const display = visibleDisplay ?? (saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay());
    const area = display.workArea;
    const width = Math.min(saved?.width ?? 1_440, Math.max(920, area.width));
    const height = Math.min(saved?.height ?? 940, Math.max(620, area.height));
    const bounds = saved && visibleDisplay
        ? {
            x: Math.min(Math.max(saved.x, area.x), Math.max(area.x, area.x + area.width - width)),
            y: Math.min(Math.max(saved.y, area.y), Math.max(area.y, area.y + area.height - height)),
            width,
            height,
        }
        : {
            x: Math.round(area.x + (area.width - width) / 2),
            y: Math.round(area.y + (area.height - height) / 2),
            width,
            height,
        };
    return { bounds, maximized: saved?.maximized ?? false };
}

function saveWindowState(window: BrowserWindow): void {
    if (!windowStatePath || window.isDestroyed()) return;
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state: SavedWindowState = { ...bounds, maximized: window.isMaximized() };
    const tempPath = `${windowStatePath}.${process.pid}.tmp`;
    try {
        mkdirSync(dirname(windowStatePath), { recursive: true });
        writeFileSync(tempPath, JSON.stringify(state), "utf-8");
        try { renameSync(tempPath, windowStatePath); }
        catch {
            writeFileSync(windowStatePath, JSON.stringify(state), "utf-8");
        }
    } catch { /* keep the current window usable if local preferences cannot be saved */ }
}

function createWindow(): BrowserWindow {
    const restored = initialWindowBounds();
    const window = new BrowserWindow({
        ...restored.bounds,
        minWidth: 920,
        minHeight: 620,
        show: false,
        backgroundColor: "#111318",
        title: "TriumCode",
        webPreferences: {
            preload: join(here, "../preload/index.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
    });

    window.once("ready-to-show", () => {
        if (restored.maximized) window.maximize();
        window.show();
    });
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleWindowStateSave = (): void => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = undefined;
            saveWindowState(window);
        }, 250);
    };
    window.on("move", scheduleWindowStateSave);
    window.on("resize", scheduleWindowStateSave);
    window.on("close", () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = undefined;
        saveWindowState(window);
    });
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
        void host?.stopAll().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            dialog.showErrorBox("Task could not stop", message);
        });
        void terminals?.closeAll().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            dialog.showErrorBox("Terminal could not close", message);
        });
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
            if (response !== 0) return;
            await Promise.all([host?.stopAll(), terminals?.closeAll()]);
            closeAfterStopping = true;
            if (!window.isDestroyed()) window.close();
        }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            dialog.showErrorBox("TriumCode could not exit cleanly", message);
        }).finally(() => { closePromptOpen = false; });
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
        windowStatePath = join(userData, "window-state.json");
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
        if (closeAfterStopping) return;
        if (!host?.hasRunningTasks() && !terminals?.hasOpenTerminals()) return;
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close();
            return;
        }
        void Promise.all([host?.stopAll(), terminals?.closeAll()]).then(() => {
            closeAfterStopping = true;
            app.quit();
        }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            dialog.showErrorBox("TriumCode could not exit cleanly", message);
        });
    });
    app.on("will-quit", () => workspaceWatch?.close());
}
