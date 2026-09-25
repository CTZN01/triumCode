import { getTool, type ToolContext, type ReadFileState } from "./tools.js";

// Maximum number of tools executing concurrently.
const MAX_CONCURRENCY = 10;

// A tool_use block whose JSON input has been fully accumulated from the stream
// and is waiting to execute.
interface PendingItem {
    id: string;           // content_block id from the API
    name: string;
    input: Record<string, any>;
    isConcurrencySafe: boolean;
    resolve: (result: ToolExecutionResult) => void;
}

// A tool that is currently executing.
interface ExecutingItem {
    id: string;
    name: string;
    isConcurrencySafe: boolean;
}

export type ToolExecutionOutcome = "complete" | "failed" | "denied" | "cancelled";

export interface ToolExecutionResult {
    output: string;
    outcome: ToolExecutionOutcome;
    executionStarted: boolean;
}

function legacyToolOutcome(output: string): ToolExecutionOutcome {
    return /^Error\b|^Sub-agent error:|^timed out after \d+s|^Too many matches \(over 8MB\)/i.test(output)
        ? "failed"
        : "complete";
}

export function toolExecutionResult(
    output: string,
    outcome: ToolExecutionOutcome = legacyToolOutcome(output),
    executionStarted = false,
): ToolExecutionResult {
    return { output, outcome, executionStarted };
}

// ─── Concurrency rules ──────────────────────────────────────
//  • Multiple safe tools may execute in parallel, up to MAX_CONCURRENCY.
//  • A non-safe tool requires exclusive access: nothing else executing, and
//    nothing else will be dispatched until it finishes.
//  • A non-safe tool blocks behind any currently-executing safe tools (it will
//    start once they all finish).
//  • Safe tools block behind a queued non-safe tool only while that non-safe
//    tool is executing — they do not block behind a merely-queued one, because
//    the non-safe tool has not acquired exclusive access yet.

function canDispatch(item: PendingItem, executing: Map<string, ExecutingItem>): boolean {
    if (executing.size >= MAX_CONCURRENCY) return false;

    if (item.isConcurrencySafe) {
        // Safe tool: only blocked while a non-safe tool is executing.
        for (const e of executing.values()) {
            if (!e.isConcurrencySafe) return false;
        }
        return true;
    }

    // Non-safe tool: needs exclusive access.
    return executing.size === 0;
}

export class ToolExecutor {
    private pending: PendingItem[] = [];
    private executing = new Map<string, ExecutingItem>();
    private context: ToolContext;
    private allowedTools?: ReadonlySet<string>;
    // Resolvers for drain() callers, notified when the executor goes idle.
    private idleResolvers: Array<() => void> = [];

    constructor(context: ToolContext, allowedTools?: ReadonlySet<string>) {
        this.context = context;
        this.allowedTools = allowedTools;
        context.signal?.addEventListener("abort", () => {
            for (const item of this.pending.splice(0)) {
                item.resolve(toolExecutionResult("Cancelled before the tool started.", "cancelled"));
            }
        }, { once: true });
    }

    // Enqueue a completed tool_use block for execution. Returns a promise that
    // resolves with the tool's output and structured outcome once execution finishes. The caller
    // does NOT need to await this immediately — it will resolve whenever the
    // executor gets to it.
    enqueue(
        id: string,
        name: string,
        input: Record<string, any>,
    ): Promise<ToolExecutionResult> {
        if (this.context.signal?.aborted) return Promise.resolve(toolExecutionResult("Cancelled before the tool started.", "cancelled"));
        if (this.allowedTools && !this.allowedTools.has(name)) {
            return Promise.resolve(toolExecutionResult(`Error: tool ${name} is not available to this agent.`, "failed"));
        }

        const tool = getTool(name);

        // Generic required-argument guard, checked before anything else so a
        // malformed call never reaches the safety classifier or the tool body.
        // Without it, write_file({}) dies inside a path call with a Node
        // internals message ("paths[0] must be of type string") that tells the
        // model nothing about what to fix.
        // The SDK types inputSchema loosely, so narrow it at runtime rather
        // than trusting the declared shape.
        const declared = (tool?.inputSchema as { required?: unknown } | undefined)?.required;
        const missing = (Array.isArray(declared) ? declared : [])
            .filter((key): key is string => typeof key === "string")
            .filter((key) => input[key] === undefined);
        if (missing.length > 0) {
            return Promise.resolve(toolExecutionResult(
                `Error: missing required argument${missing.length > 1 ? "s" : ""} for ${name}: `
                + `${missing.join(", ")}. Re-issue the call with every required argument.`,
                "failed",
            ));
        }

        const permission = this.context.permissionPolicy?.check(name, input);
        if (permission) this.context.onPermissionDecision?.(permission, id, name, input);
        if (permission?.action === "deny") {
            return Promise.resolve(toolExecutionResult(`Action denied: ${permission.message}`, "denied"));
        }
        if (permission?.action === "confirm") {
            const confirmPermission = this.context.confirmPermission;
            if (!confirmPermission) {
                return Promise.resolve(toolExecutionResult(
                    `Action denied: confirmation is unavailable for ${permission.message ?? name}`,
                    "denied",
                ));
            }
            return new Promise<ToolExecutionResult>((resolve) => {
                let settled = false;
                const finish = (result: ToolExecutionResult): void => {
                    if (settled) return;
                    settled = true;
                    this.context.signal?.removeEventListener("abort", onAbort);
                    resolve(result);
                };
                const onAbort = (): void => finish(toolExecutionResult("Cancelled before the tool started.", "cancelled"));
                this.context.signal?.addEventListener("abort", onAbort, { once: true });
                if (this.context.signal?.aborted) {
                    onAbort();
                    return;
                }
                confirmPermission({
                    toolCallId: id,
                    toolName: name,
                    input,
                    message: permission.message ?? name,
                    source: permission.source,
                    ...(permission.key ? { key: permission.key } : {}),
                }).then((grant) => {
                    if (settled) return;
                    if (!grant) {
                        finish(toolExecutionResult("User denied this action.", "denied"));
                        return;
                    }
                    if (permission.key && grant !== "once") {
                        this.context.permissionPolicy?.confirm(permission.key, name, input);
                        const granted = this.context.permissionPolicy?.check(name, input);
                        if (granted) this.context.onPermissionDecision?.(granted, id, name, input);
                    }
                    this.enqueueAllowed(id, name, input, tool).then(finish);
                }).catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    finish(toolExecutionResult(`Error requesting permission: ${message}`, "failed"));
                });
            });
        }

        return this.enqueueAllowed(id, name, input, tool);
    }

    private enqueueAllowed(
        id: string,
        name: string,
        input: Record<string, any>,
        tool: ReturnType<typeof getTool>,
    ): Promise<ToolExecutionResult> {
        if (this.context.signal?.aborted) return Promise.resolve(toolExecutionResult("Cancelled before the tool started.", "cancelled"));
        // Look up the tool and use its input-aware safety classification.
        const isConcurrencySafe_ = tool?.isConcurrencySafe(input) ?? false;

        return new Promise<ToolExecutionResult>((resolve) => {
            this.pending.push({ id, name, input, isConcurrencySafe: isConcurrencySafe_, resolve });
            this.dispatch();
        });
    }

    // Greedily dispatch all pending items whose constraints are satisfied.
    private dispatch(): void {
        let progress = true;
        while (progress) {
            progress = false;
            for (let i = 0; i < this.pending.length; i++) {
                const item = this.pending[i];
                if (canDispatch(item, this.executing)) {
                    this.pending.splice(i, 1);
                    i--;
                    this.launch(item);
                    progress = true;
                }
            }
        }
    }

    // Fire-and-forget execution. On completion, the item's resolve callback
    // delivers the result to the enqueuer, and dispatch() is called again to
    // drain anything that was waiting for this slot.
    private launch(item: PendingItem): void {
        const entry: ExecutingItem = {
            id: item.id,
            name: item.name,
            isConcurrencySafe: item.isConcurrencySafe,
        };
        this.executing.set(item.id, entry);

        const tool = getTool(item.name);
        const exec = tool
            ? tool.call(item.input, this.context)
            : Promise.resolve(`Error: unknown tool: ${item.name}`);

        exec
            .then((result) => {
                item.resolve(this.context.signal?.aborted
                    ? toolExecutionResult(result, "cancelled", true)
                    : toolExecutionResult(result, undefined, true));
            })
            .catch((err: any) => {
                item.resolve(toolExecutionResult(`Error executing ${item.name}: ${err.message ?? err}`, "failed", true));
            })
            .finally(() => {
                this.executing.delete(item.id);
                this.dispatch();   // wake anything blocked on this slot
                this.notifyIfIdle();
            });
    }

    // True when the queue is empty and nothing is running.
    get isIdle(): boolean {
        return this.pending.length === 0 && this.executing.size === 0;
    }

    // Names of tools whose call() is in flight — what a status line should
    // report as "running". Tools that have finished but whose results have not
    // been collected yet are in neither list, so this can undercount; it never
    // overcounts, which is the honest direction for a progress label.
    get running(): string[] {
        return [...this.executing.values()].map((e) => e.name);
    }

    // Names of tools enqueued but blocked behind a non-safe tool. Non-empty
    // implies running is non-empty: dispatch() runs to a fixed point, so the
    // only way a safe tool stays queued is an unsafe tool holding the slot.
    get queued(): string[] {
        return this.pending.map((p) => p.name);
    }

    private notifyIfIdle(): void {
        if (!this.isIdle) return;
        for (const resolve of this.idleResolvers) resolve();
        this.idleResolvers.length = 0;
    }

    // Wait until all queued and executing tools have finished. Call this after
    // the stream ends to collect all results.
    async drain(): Promise<void> {
        if (this.isIdle) return;
        return new Promise<void>((resolve) => {
            this.idleResolvers.push(resolve);
        });
    }
}
