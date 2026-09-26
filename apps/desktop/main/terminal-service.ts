import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
    closingPromise: Promise<void> | null;
    didExit: boolean;
    exited: Promise<void>;
    resolveExit: () => void;
}

function environment(): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function waitForExit(record: TerminalRecord, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            record.exited.then(() => true),
            new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export class TerminalService {
    private readonly workspaces: WorkspaceStore;
    private readonly emitToRenderer: (event: TerminalEvent) => void;
    private readonly terminals = new Map<string, TerminalRecord>();
    private closingAll: Promise<void> | null = null;

    constructor(workspaces: WorkspaceStore, emitToRenderer: (event: TerminalEvent) => void) {
        this.workspaces = workspaces;
        this.emitToRenderer = emitToRenderer;
    }

    create(workspaceId: string, cols: number, rows: number): TerminalSummary {
        if (this.closingAll) throw new DesktopServiceError("APP_STOPPING", "Wait for TriumCode to finish closing its terminals.");
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
            closingPromise: null,
            didExit: false,
            exited,
            resolveExit,
        };
        this.terminals.set(id, record);
        child.onData((data) => this.queueOutput(record, data));
        child.onExit(({ exitCode, signal }) => {
            record.didExit = true;
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

    close(terminalId: string): Promise<void> {
        const record = this.terminals.get(terminalId);
        if (!record) return Promise.resolve();
        if (record.closingPromise) return record.closingPromise;
        record.closing = true;
        this.flushOutput(record);
        record.closingPromise = (async () => {
            try {
                if (!record.didExit) {
                    await new Promise<void>((resolve, reject) => {
                        execFile("taskkill.exe", ["/PID", String(record.process.pid), "/T", "/F"],
                            { windowsHide: true, timeout: 5_000 }, (error) => {
                                if (error && !record.didExit) reject(new DesktopServiceError("TERMINAL_TREE_KILL_FAILED", "Could not stop the PowerShell process tree. Try closing the terminal again."));
                                else resolve();
                            });
                    });
                }
                try { record.process.kill(); } catch { /* the shell may have exited while closing */ }
                if (!await waitForExit(record, 6_000)) {
                    throw new DesktopServiceError("TERMINAL_CLOSE_TIMEOUT", "PowerShell did not exit. Close it before exiting TriumCode.");
                }
            } finally {
                record.closing = false;
                record.closingPromise = null;
            }
        })();
        return record.closingPromise;
    }

    closeAll(): Promise<void> {
        if (this.closingAll) return this.closingAll;
        const closing = Promise.all([...this.terminals.keys()].map((id) => this.close(id))).then(() => undefined);
        this.closingAll = closing;
        void closing.then(
            () => { if (this.closingAll === closing) this.closingAll = null; },
            () => { if (this.closingAll === closing) this.closingAll = null; },
        );
        return closing;
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
