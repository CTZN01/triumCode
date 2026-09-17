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
    // Resolvers for drain() callers, notified when the executor goes idle.
    private idleResolvers: Array<() => void> = [];

    constructor(context: ToolContext) {
        this.context = context;
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
        // Look up the tool and use its input-aware safety classification.
        const tool = getTool(name);
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

        // Log which tool is starting, with concurrency indicator.
        const tag = item.isConcurrencySafe ? "⚡" : "🔒";
        console.log(`  ${tag} ${item.name}(${JSON.stringify(item.input)})`);

        const start = Date.now();

        const tool = getTool(item.name);
        const exec = tool
            ? tool.call(item.input, this.context)
            : Promise.resolve(`Unknown tool: ${item.name}`);

        exec
            .then((result) => {
                const ms = Date.now() - start;
                console.log(`  ✓ ${item.name} (${ms}ms)`);
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
