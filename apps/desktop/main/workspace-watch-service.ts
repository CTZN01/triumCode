import { watch, type FSWatcher } from "node:fs";
import type { WorkspaceChangedEvent } from "../shared/contracts.js";
import { WorkspaceStore } from "./workspace-store.js";

const CHANGE_DEBOUNCE_MS = 800;
const FALLBACK_POLL_MS = 5_000;

interface ActiveWorkspaceWatch {
    workspaceId: string;
    watcher: FSWatcher | null;
    debounceTimer: NodeJS.Timeout | null;
    fallbackTimer: NodeJS.Timeout | null;
}

export class WorkspaceWatchService {
    private active: ActiveWorkspaceWatch | null = null;

    constructor(
        private readonly workspaces: WorkspaceStore,
        private readonly emit: (event: WorkspaceChangedEvent) => void,
    ) {}

    watchWorkspace(workspaceId: string): void {
        if (this.active?.workspaceId === workspaceId) return;
        this.close();

        let root: string;
        try { root = this.workspaces.getPath(workspaceId); }
        catch { return; }

        const active: ActiveWorkspaceWatch = {
            workspaceId,
            watcher: null,
            debounceTimer: null,
            fallbackTimer: null,
        };
        this.active = active;
        try {
            const watcher = watch(root, { recursive: true }, () => this.scheduleChange(active));
            active.watcher = watcher;
            watcher.on("error", () => this.startFallback(active));
        } catch {
            this.startFallback(active);
        }
    }

    closeWorkspace(workspaceId: string): void {
        if (this.active?.workspaceId === workspaceId) this.close();
    }

    close(): void {
        const active = this.active;
        this.active = null;
        if (!active) return;
        active.watcher?.close();
        if (active.debounceTimer) clearTimeout(active.debounceTimer);
        if (active.fallbackTimer) clearInterval(active.fallbackTimer);
    }

    private scheduleChange(active: ActiveWorkspaceWatch): void {
        if (this.active !== active || active.debounceTimer) return;
        active.debounceTimer = setTimeout(() => {
            active.debounceTimer = null;
            if (this.active === active) this.notify(active.workspaceId);
        }, CHANGE_DEBOUNCE_MS);
    }

    private startFallback(active: ActiveWorkspaceWatch): void {
        if (this.active !== active || active.fallbackTimer) return;
        active.watcher?.close();
        active.watcher = null;
        active.fallbackTimer = setInterval(() => {
            if (this.active === active) this.notify(active.workspaceId);
        }, FALLBACK_POLL_MS);
    }

    private notify(workspaceId: string): void {
        try { this.emit({ workspaceId }); }
        catch { /* Renderer delivery is optional; opening the panel refreshes again. */ }
    }
}
