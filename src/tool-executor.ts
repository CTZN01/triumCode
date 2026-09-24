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
    resolve: (result: string) => void;
}

// A tool that is currently executing.
interface ExecutingItem {
    id: string;
    name: string;
    isConcurrencySafe: boolean;
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
    }

    // Enqueue a completed tool_use block for execution. Returns a promise that
    // resolves with the tool's output string once execution finishes. The caller
    // does NOT need to await this immediately — it will resolve whenever the
    // executor gets to it.
    enqueue(
        id: string,
        name: string,
        input: Record<string, any>,
    ): Promise<string> {
        if (this.allowedTools && !this.allowedTools.has(name)) {
            return Promise.resolve(`Error: tool ${name} is not available to this agent.`);
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
            return Promise.resolve(
                `Error: missing required argument${missing.length > 1 ? "s" : ""} for ${name}: `
                + `${missing.join(", ")}. Re-issue the call with every required argument.`,
            );
        }

        const permission = this.context.permissionPolicy?.check(name, input);
        if (permission?.action === "deny") {
            return Promise.resolve(`Action denied: ${permission.message}`);
        }
        if (permission?.action === "confirm" && permission.message) {
            if (!this.context.confirmPermission) {
                return Promise.resolve(`Action denied: confirmation is unavailable for ${permission.message}`);
            }
            return this.context.confirmPermission(permission.message).then((confirmed) => {
                if (!confirmed) return "User denied this action.";
                if (permission.key) this.context.permissionPolicy?.confirm(permission.key);
                return this.enqueueAllowed(id, name, input, tool);
            });
        }

        return this.enqueueAllowed(id, name, input, tool);
    }

    private enqueueAllowed(
        id: string,
        name: string,
        input: Record<string, any>,
        tool: ReturnType<typeof getTool>,
    ): Promise<string> {
        // Look up the tool and use its input-aware safety classification.
        const isConcurrencySafe_ = tool?.isConcurrencySafe(input) ?? false;

        return new Promise<string>((resolve) => {
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
            : Promise.resolve(`Unknown tool: ${item.name}`);

        exec
            .then((result) => {
                item.resolve(result);
            })
            .catch((err: any) => {
                item.resolve(`Error executing ${item.name}: ${err.message ?? err}`);
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
