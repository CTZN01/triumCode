import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorktreeAssociation } from "../shared/contracts.js";

interface WorktreeFile {
    version: 1;
    worktrees: WorktreeAssociation[];
}

function isAssociation(value: unknown): value is WorktreeAssociation {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<WorktreeAssociation>;
    return typeof item.workspaceId === "string"
        && typeof item.workspacePath === "string"
        && typeof item.taskName === "string"
        && typeof item.branchName === "string"
        && typeof item.sourceWorkspaceId === "string"
        && typeof item.sourcePath === "string"
        && (item.sourceBranch === null || typeof item.sourceBranch === "string")
        && typeof item.baseCommit === "string"
        && typeof item.createdAt === "string";
}

export class WorktreeStore {
    private readonly filePath: string;
    private state: WorktreeFile;

    constructor(userDataPath: string) {
        this.filePath = join(userDataPath, "worktrees.json");
        this.state = this.read();
    }

    private read(): WorktreeFile {
        if (!existsSync(this.filePath)) return { version: 1, worktrees: [] };
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<WorktreeFile>;
            return {
                version: 1,
                worktrees: Array.isArray(parsed.worktrees) ? parsed.worktrees.filter(isAssociation) : [],
            };
        } catch {
            return { version: 1, worktrees: [] };
        }
    }

    private persist(): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), "utf-8");
        try { renameSync(temporaryPath, this.filePath); }
        catch {
            writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
        }
    }

    get(workspaceId: string): WorktreeAssociation | null {
        return this.state.worktrees.find((worktree) => worktree.workspaceId === workspaceId) ?? null;
    }

    listForSource(sourceWorkspaceId: string): WorktreeAssociation[] {
        return this.state.worktrees.filter((worktree) => worktree.sourceWorkspaceId === sourceWorkspaceId);
    }

    add(worktree: WorktreeAssociation): void {
        const previous = this.state;
        const remaining = previous.worktrees.filter((item) => item.workspaceId !== worktree.workspaceId);
        this.state = { ...previous, worktrees: [...remaining, worktree] };
        try { this.persist(); }
        catch (error) {
            this.state = previous;
            throw error;
        }
    }

    remove(workspaceId: string): void {
        const previous = this.state;
        this.state = { ...previous, worktrees: previous.worktrees.filter((worktree) => worktree.workspaceId !== workspaceId) };
        try { this.persist(); }
        catch (error) {
            this.state = previous;
            throw error;
        }
    }
}
