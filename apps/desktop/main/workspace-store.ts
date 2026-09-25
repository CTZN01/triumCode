import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { WorkspaceSummary } from "../shared/contracts.js";

interface StoredWorkspace {
    id: string;
    path: string;
    lastOpened: string;
}

interface WorkspaceFile {
    activeWorkspaceId: string | null;
    workspaces: StoredWorkspace[];
}

export class DesktopServiceError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "DesktopServiceError";
        this.code = code;
    }
}

function identityPath(path: string): string {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function workspaceId(path: string): string {
    return createHash("sha256").update(identityPath(path)).digest("hex").slice(0, 20);
}

export class WorkspaceStore {
    private readonly filePath: string;
    private state: WorkspaceFile;

    constructor(userDataPath: string) {
        this.filePath = join(userDataPath, "workspaces.json");
        this.state = this.read();
    }

    private read(): WorkspaceFile {
        if (!existsSync(this.filePath)) return { activeWorkspaceId: null, workspaces: [] };
        try {
            const value = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<WorkspaceFile>;
            const workspaces = Array.isArray(value.workspaces)
                ? value.workspaces.filter((item): item is StoredWorkspace =>
                    Boolean(item && typeof item.id === "string" && typeof item.path === "string" && typeof item.lastOpened === "string"))
                : [];
            const activeWorkspaceId = typeof value.activeWorkspaceId === "string" ? value.activeWorkspaceId : null;
            return { activeWorkspaceId, workspaces };
        } catch {
            return { activeWorkspaceId: null, workspaces: [] };
        }
    }

    private persist(): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(this.state, null, 2), "utf-8");
        try { renameSync(temp, this.filePath); }
        catch {
            writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
        }
    }

    list(): WorkspaceSummary[] {
        return [...this.state.workspaces]
            .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
            .map((entry) => this.describe(entry));
    }

    listForTasks(): WorkspaceSummary[] {
        return [...this.state.workspaces]
            .sort((a, b) => b.lastOpened.localeCompare(a.lastOpened))
            .map((entry) => this.describe(entry, false));
    }

    activeId(): string | null {
        return this.state.activeWorkspaceId;
    }

    getPath(id: string): string {
        const entry = this.state.workspaces.find((workspace) => workspace.id === id);
        if (!entry) throw new DesktopServiceError("WORKSPACE_NOT_FOUND", "This workspace is no longer in the recent list.");
        if (!existsSync(entry.path)) throw new DesktopServiceError("WORKSPACE_MISSING", `Workspace folder is unavailable: ${entry.path}`);
        try {
            if (!statSync(entry.path).isDirectory()) throw new Error("not a directory");
            return realpathSync.native(entry.path);
        } catch {
            throw new DesktopServiceError("WORKSPACE_MISSING", `Workspace folder is unavailable: ${entry.path}`);
        }
    }

    open(path: string): WorkspaceSummary {
        let canonicalPath: string;
        try {
            canonicalPath = realpathSync.native(resolve(path));
            if (!statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
        } catch {
            throw new DesktopServiceError("WORKSPACE_INVALID", "Choose an existing folder to open as a workspace.");
        }
        const id = workspaceId(canonicalPath);
        const lastOpened = new Date().toISOString();
        const retained = this.state.workspaces.filter((item) => item.id !== id);
        this.state = {
            activeWorkspaceId: id,
            workspaces: [{ id, path: canonicalPath, lastOpened }, ...retained].slice(0, 24),
        };
        this.persist();
        return this.describe({ id, path: canonicalPath, lastOpened });
    }

    activate(id: string): WorkspaceSummary {
        const path = this.getPath(id);
        const entry = this.state.workspaces.find((item) => item.id === id)!;
        entry.path = path;
        entry.lastOpened = new Date().toISOString();
        this.state.activeWorkspaceId = id;
        this.persist();
        return this.describe(entry);
    }

    remove(id: string): void {
        this.state.workspaces = this.state.workspaces.filter((item) => item.id !== id);
        if (this.state.activeWorkspaceId === id) this.state.activeWorkspaceId = null;
        this.persist();
    }

    private describe(entry: StoredWorkspace, includeBranch = true): WorkspaceSummary {
        const available = existsSync(entry.path) && (() => {
            try { return statSync(entry.path).isDirectory(); } catch { return false; }
        })();
        return {
            id: entry.id,
            name: basename(entry.path) || entry.path,
            path: entry.path,
            branch: available && includeBranch ? this.branch(entry.path) : null,
            available,
        };
    }

    private branch(path: string): string | null {
        try {
            const branch = execFileSync("git", ["branch", "--show-current"], {
                cwd: path,
                encoding: "utf-8",
                timeout: 2_000,
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            if (branch) return branch;
            const status = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
                cwd: path,
                encoding: "utf-8",
                timeout: 2_000,
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            return status ? `detached ${status}` : null;
        } catch {
            return null;
        }
    }
}
