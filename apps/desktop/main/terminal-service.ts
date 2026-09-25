import { randomUUID } from "node:crypto";
import * as nodePty from "node-pty";
import type { TerminalEvent, TerminalSummary } from "../shared/contracts.js";
import { DesktopServiceError, WorkspaceStore } from "./workspace-store.js";

const MAX_TERMINALS = 4;
const MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_WRITE_LENGTH = 64 * 1024;
const OUTPUT_FLUSH_MS = 16;

interface TerminalRecord extends TerminalSummary {
    process: nodePty.IPty;
    pendingOutput: string[];
    pendingBytes: number;
    droppedBytes: number;
    flushTimer: ReturnType<typeof setTimeout> | null;
    closing: boolean;
    exited: Promise<void>;
    resolveExit: () => void;
}

function environment(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export class TerminalService {
    private readonly workspaces: WorkspaceStore;
    private readonly emitToRenderer: (event: TerminalEvent) => void;
    private readonly terminals = new Map<string, TerminalRecord>();

    constructor(workspaces: WorkspaceStore, emitToRenderer: (event: TerminalEvent) => void) {
        this.workspaces = workspaces;
        this.emitToRenderer = emitToRenderer;
    }

    create(workspaceId: string, cols: number, rows: number): TerminalSummary {
        if (process.platform !== "win32") {
            throw new DesktopServiceError("TERMINAL_UNSUPPORTED", "The integrated terminal currently supports Windows PowerShell only.");
        }
        if (this.terminals.size >= MAX_TERMINALS) {
            throw new DesktopServiceError("TERMINAL_LIMIT", "Close an existing terminal before opening another one.");
        }
        const cwd = this.workspaces.getPath(workspaceId);
        const id = randomUUID();
        const promptScript = [
            "$utf8 = [System.Text.UTF8Encoding]::new()",
            "[Console]::InputEncoding = $utf8",
            "[Console]::OutputEncoding = $utf8",
            "$OutputEncoding = $utf8",
            "function global:prompt { $cwd = (Get-Location).Path; [Console]::Write(([char]27) + ']0;PowerShell - ' + $cwd + [char]7); return ('PS ' + $cwd + '> ') }",
        ].join("; ");

        let child: nodePty.IPty;
        try {
            child = nodePty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", promptScript], {
                name: "xterm-256color",
                cols,
                rows,
                cwd,
                env: environment(),
                encoding: "utf8",
                useConpty: true,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new DesktopServiceError("TERMINAL_START_FAILED", `Could not start Windows PowerShell: ${reason}`);
        }

        let resolveExit: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
        const record: TerminalRecord = {
            id,
            workspaceId,
            cwd,
            shell: "Windows PowerShell",
            process: child,
            pendingOutput: [],
            pendingBytes: 0,
            droppedBytes: 0,
            flushTimer: null,
            closing: false,
            exited,
            resolveExit,
        };
        this.terminals.set(id, record);
        child.onData((data) => this.queueOutput(record, data));
        child.onExit(({ exitCode, signal }) => {
            record.resolveExit();
            this.flushOutput(record);
            this.terminals.delete(id);
            this.emitToRenderer({ terminalId: id, workspaceId, payload: { type: "exit", exitCode, signal } });
        });
        return { id, workspaceId, cwd, shell: record.shell };
    }

    write(terminalId: string, data: string): void {
        const record = this.requireTerminal(terminalId);
        if (data.length > MAX_WRITE_LENGTH) throw new DesktopServiceError("TERMINAL_INPUT_TOO_LARGE", "Terminal input is too long.");
        try { record.process.write(data); }
        catch { throw new DesktopServiceError("TERMINAL_WRITE_FAILED", "The terminal is no longer accepting input."); }
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const record = this.requireTerminal(terminalId);
        try { record.process.resize(cols, rows); }
        catch { throw new DesktopServiceError("TERMINAL_RESIZE_FAILED", "The terminal could not be resized."); }
    }

    async close(terminalId: string): Promise<void> {
        const record = this.terminals.get(terminalId);
        if (!record || record.closing) return;
        record.closing = true;
        this.flushOutput(record);
        try { record.process.kill(); } catch { /* the shell may have exited while closing */ }
        let timeout: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([record.exited, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 6_000); })]);
        if (timeout) clearTimeout(timeout);
        this.terminals.delete(terminalId);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.terminals.keys()].map((id) => this.close(id)));
    }

    hasOpenTerminals(workspaceId?: string): boolean {
        return [...this.terminals.values()].some((terminal) => !workspaceId || terminal.workspaceId === workspaceId);
    }

    private requireTerminal(id: string): TerminalRecord {
        const record = this.terminals.get(id);
        if (!record || record.closing) throw new DesktopServiceError("TERMINAL_NOT_FOUND", "This terminal is no longer available.");
        return record;
    }

    private queueOutput(record: TerminalRecord, data: string): void {
        record.pendingOutput.push(data);
        record.pendingBytes += Buffer.byteLength(data, "utf-8");
        while (record.pendingBytes > MAX_QUEUED_BYTES && record.pendingOutput.length > 1) {
            const dropped = record.pendingOutput.shift()!;
            const bytes = Buffer.byteLength(dropped, "utf-8");
            record.pendingBytes -= bytes;
            record.droppedBytes += bytes;
        }
        if (record.flushTimer) return;
        record.flushTimer = setTimeout(() => this.flushOutput(record), OUTPUT_FLUSH_MS);
    }

    private flushOutput(record: TerminalRecord): void {
        if (record.flushTimer) clearTimeout(record.flushTimer);
        record.flushTimer = null;
        if (record.droppedBytes > 0) {
            this.emitToRenderer({
                terminalId: record.id,
                workspaceId: record.workspaceId,
                payload: { type: "output-truncated", droppedBytes: record.droppedBytes },
            });
            record.droppedBytes = 0;
        }
        if (record.pendingOutput.length === 0) return;
        const data = record.pendingOutput.join("");
        record.pendingOutput = [];
        record.pendingBytes = 0;
        this.emitToRenderer({ terminalId: record.id, workspaceId: record.workspaceId, payload: { type: "data", data } });
    }
}
