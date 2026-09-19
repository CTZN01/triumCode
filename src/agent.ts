import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { getActiveToolDefinitions, type ReadFileState, type ToolContext } from "./tools.js";
import { ToolExecutor } from "./tool-executor.js";
import { buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder } from "./prompt.js";
import {
    printToolCall, printToolResult, writeStream, endStream, printCostReport,
    beginStatus, updateStatus, endStatus, printThinkingDuration, pickStatusVerb, printInfo, printTurnEnd,
    printPlanForApproval, printPlanModeEntered, printPlanModeExited,
} from "./ui.js";
import { withRetry } from "./retry.js";
import {
    resolveThinkingMode, applyThinkingParams, applyEffortParams, parseEffort,
    isUnsupportedParamError, filterThinkingBlocks, type EffortLevel,
} from "./thinking.js";
import {
    compactHistory, compressHistory, estimateTokens, prepareToolResult, shouldAutoCompact,
    withCacheBreakpoints, DEFAULT_CONTEXT_WINDOW,
} from "./context-compression.js";
import { PermissionPolicy, type PermissionMode } from "./permissions.js";
import {
    startMemoryPrefetch, formatMemoriesForInjection,
    type MemoryPrefetch, type RelevantMemory, type SideQueryFn,
} from "./memory.js";

// Extended thinking counts towards max_tokens, and endpoints that think by
// default (MiMo, for one) will happily spend the whole budget reasoning and
// then get cut off mid-sentence — or mid-tool-call. 4096 was small enough to
// trigger that constantly.
const DEFAULT_MAX_TOKENS = 32_000;

// System prompt as an array of TextBlockParam. The first block (persona +
// tool guidance) carries cache_control so it is reused across turns without
// being re-processed by the model. The second block (environment, git,
// CLAUDE.md) is rebuilt each turn.
function buildSystemBlocks(planMode: boolean): Anthropic.TextBlockParam[] {
    return [
        {
            type: "text",
            text: buildStaticSystemPrompt(planMode),
            cache_control: { type: "ephemeral" },
        },
        {
            type: "text",
            text: buildDynamicSystemContext(),
        },
    ];
}

/**
 * The SDK puts the whole HTTP response body into error.message, which is far
 * too noisy for a one-line notice. Pull out the API's own message field when
 * there is one, and fall back to a clipped first line otherwise.
 */
function briefApiError(error: any): string {
    const raw = String(error?.message ?? "request rejected");
    const json = /\{[\s\S]*\}/.exec(raw);
    if (json) {
        try {
            const parsed = JSON.parse(json[0]);
            const message = parsed?.error?.message ?? parsed?.message;
            if (typeof message === "string" && message) return message;
        } catch {
            // Not JSON after all — fall through to the text form.
        }
    }
    const first = raw.split("\n")[0];
    return first.length > 100 ? first.slice(0, 97) + "..." : first;
}

export interface AgentUsage {
    input: number;
    output: number;
    cost: number;
}

export interface AgentOptions {
    // These three are normally resolved by config.ts (CLI flag → config.json →
    // env var) and passed in explicitly.  The fallbacks below only apply when
    // an Agent is constructed directly, bypassing the CLI.
    model?: string;       // --model / -m from CLI; else MINI_MODEL env
    apiKey?: string;      // --api-key from CLI; else ANTHROPIC_API_KEY env
    apiBase?: string;     // --api-base from CLI; else ANTHROPIC_BASE_URL env
    thinking?: boolean;   // --thinking flag from CLI
    effort?: string;      // --effort flag from CLI
    maxTokens?: number;   // --max-tokens flag from CLI
    maxTurns?: number;    // --max-turns flag from CLI
    contextWindow?: number; // --context-window, in tokens
    planMode?: boolean;   // --plan flag from CLI
    permissionMode?: PermissionMode;
    sideQuery?: SideQueryFn; // override for the memory-recall side model (tests)
}

export class Agent {
    private client: Anthropic;
    private model: string;
    private messages: Anthropic.MessageParam[] = [];
    private readFileState: ReadFileState = new Map();
    private injectedContextReminder = false;
    private thinkingEnabled: boolean;
    private effort: EffortLevel | null;
    private maxTokens: number;
    private maxTurns: number;
    private contextWindow: number;
    private contextUtilization = 0;
    private permissionMode: PermissionMode;
    // Set once the endpoint has rejected the thinking/effort params, so later
    // turns skip sending them instead of paying a 400 on every request.
    private optionalParamsRejected = false;
    public planMode: boolean;

    // ── Abort support ───────────────────────────────────────────
    private abortController: AbortController | null = null;
    public isProcessing = false;

    // ── Token usage tracking ────────────────────────────────────
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private lastRequestAt = 0;

    // ── Auto-save callback ──────────────────────────────────────
    private onChatComplete?: () => void;

    // ── User question callback ──────────────────────────────────
    private onAskUser?: (question: string, options?: string[]) => Promise<string>;
    private permissionPolicy: PermissionPolicy;

    // ── Plan mode state ─────────────────────────────────────────
    private planFilePath: string | null = null;

    // ── Memory recall state ─────────────────────────────────────
    // Prefetch races the first model call of each turn; surfaced memories and
    // the byte budget live for the whole session so recall stays fresh and
    // bounded.
    private sideQueryFn: SideQueryFn | null;
    private memoryPrefetch: MemoryPrefetch | null = null;
    private alreadySurfacedMemories = new Set<string>();
    private sessionMemoryBytes = 0;

    constructor(options?: AgentOptions) {
        this.model = options?.model || process.env.MINI_MODEL || "claude-sonnet-4-20250514";
        this.client = new Anthropic({
            baseURL: options?.apiBase || process.env.ANTHROPIC_BASE_URL,
            apiKey: options?.apiKey || process.env.ANTHROPIC_API_KEY,
        });
        this.thinkingEnabled = options?.thinking ?? false;
        this.effort = parseEffort(options?.effort);
        this.maxTokens = options?.maxTokens && options.maxTokens > 0
            ? options.maxTokens
            : DEFAULT_MAX_TOKENS;
        this.maxTurns = options?.maxTurns && options.maxTurns > 0
            ? options.maxTurns
            : 0;
        this.contextWindow = options?.contextWindow && options.contextWindow > 0
            ? Math.floor(options.contextWindow)
            : DEFAULT_CONTEXT_WINDOW;
        this.planMode = options?.planMode ?? options?.permissionMode === "plan";
        const permissionMode = options?.permissionMode ?? (this.planMode ? "plan" : "default");
        this.permissionMode = permissionMode;
        this.permissionPolicy = new PermissionPolicy(permissionMode);
        this.sideQueryFn = options?.sideQuery ?? null;
    }

    /** Register a callback invoked after each chat() completes. */
    setOnChatComplete(fn: () => void): void {
        this.onChatComplete = fn;
    }

    /** Register a callback for asking the user questions mid-turn. */
    setAskUserCallback(fn: (question: string, options?: string[]) => Promise<string>): void {
        this.onAskUser = fn;
    }

    /** Toggle plan mode on/off. */
    togglePlanMode(): void {
        this.planMode = !this.planMode;
        this.permissionMode = this.planMode ? "plan" : "default";
        this.permissionPolicy.setMode(this.permissionMode);
        if (this.planMode) this.preparePlanFile();
    }

    // ── Mid-session reasoning controls (REPL /effort, /thinking) ──
    // Both take effect from the next request on: openStream re-applies the
    // params on every turn.

    /** Set reasoning depth; effort only means something while thinking is on, so it turns thinking on. */
    setEffort(level: EffortLevel): void {
        this.effort = level;
        this.thinkingEnabled = true;
    }

    /** Toggle extended thinking. */
    setThinking(enabled: boolean): void {
        this.thinkingEnabled = enabled;
    }

    getEffort(): EffortLevel | null {
        return this.effort;
    }

    isThinkingEnabled(): boolean {
        return this.thinkingEnabled;
    }

    /** Compact state for the interactive CLI footer. */
    getSessionStatus(): { model: string; effort: string; contextPercent: number; mode: string } {
        // Unset effort and plain "default" mode are omitted by the footer —
        // internal fallback strings mean nothing to the user.
        const modeLabels: Record<PermissionMode, string> = {
            default: "",
            plan: "plan",
            acceptEdits: "accept-edits",
            bypassPermissions: "yolo",
            dontAsk: "dont-ask",
        };
        return {
            model: this.model,
            effort: this.effort ?? "",
            contextPercent: this.contextUtilization * 100,
            mode: modeLabels[this.permissionMode],
        };
    }

    /** Abort the currently-running chat() call. */
    abort(): void {
        this.abortController?.abort();
    }

    /** Token usage for the current session. */
    getUsage(): AgentUsage {
        // Rough cost estimate: $3/M input, $15/M output (Claude Sonnet-tier).
        const cost = (this.totalInputTokens * 3 + this.totalOutputTokens * 15) / 1_000_000;
        return { input: this.totalInputTokens, output: this.totalOutputTokens, cost };
    }

    showCost(): void {
        printCostReport(this.getUsage());
    }

    // ── Session persistence helpers ──────────────────────────────
    // These exist so the CLI can snapshot and restore the conversation
    // without exposing the private messages array.

    /** Current conversation messages (read-only snapshot). */
    history(): Anthropic.MessageParam[] {
        return [...this.messages];
    }

    /** Replace the conversation with a previously saved history. */
    loadHistory(messages: Anthropic.MessageParam[]): void {
        this.messages = messages;
        // Assume the context reminder was already part of the saved state.
        this.injectedContextReminder = true;
    }

    /** Wipe the conversation. Called by /clear. */
    clearHistory(): void {
        this.messages = [];
        this.contextUtilization = 0;
        this.injectedContextReminder = false;
        // Memories already injected belonged to the cleared conversation.
        this.alreadySurfacedMemories.clear();
        this.sessionMemoryBytes = 0;
        this.memoryPrefetch = null;
    }

    /** Replace old turns with a local summary at a safe turn boundary. */
    compact(): void {
        this.messages = compactHistory(this.messages);
    }

    /**
     * Side model for memory recall: a tiny non-streaming call, cheap enough
     * to spend one per turn. Prefers MINI_MODEL (the low-tier model) and
     * falls back to the main model. Overridable via AgentOptions.sideQuery
     * for tests.
     */
    private buildSideQuery(): SideQueryFn | null {
        if (this.sideQueryFn) return this.sideQueryFn;
        const model = process.env.MINI_MODEL || this.model;
        return async (system, user, signal) => {
            const response = await withRetry(
                (retrySignal) => this.client.messages.create({
                    model,
                    max_tokens: 512,
                    system,
                    messages: [{ role: "user", content: user }],
                    signal: retrySignal,
                } as any),
                signal ?? this.abortController?.signal,
            );
            const blocks: any[] = (response as any).content ?? [];
            return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        };
    }

    // Fire the memory prefetch at the moment the user's message arrives, so
    // recall overlaps the first model call instead of adding latency. Any
    // unconsumed prefetch from the previous turn is discarded — it described
    // a question that has already been answered.
    private startTurnMemoryPrefetch(userText: string): void {
        const sideQuery = this.buildSideQuery();
        if (!sideQuery) return;
        this.memoryPrefetch = startMemoryPrefetch(
            userText, sideQuery,
            this.alreadySurfacedMemories, this.sessionMemoryBytes,
            {}, this.abortController?.signal,
        );
    }

    // Non-blocking poll, run before each API call: if the prefetch has
    // settled, inject what it found. The first iteration waits a short
    // bounded window — the side query is tiny and usually lands well inside
    // it, which lets the model use the memories in its very first response.
    // A text-only turn (no tool calls) never reaches a second iteration, so
    // without this window single-turn answers would never see memories at
    // all. Later iterations poll without waiting; the user never blocks on
    // recall — worst case it lands one turn late.
    private async consumeMemoryPrefetch(waitMs = 0): Promise<void> {
        const prefetch = this.memoryPrefetch;
        if (!prefetch || prefetch.consumed) return;
        if (!prefetch.settled && waitMs > 0) {
            const timer = new Promise<void>((r) => setTimeout(r, waitMs).unref?.());
            await Promise.race([prefetch.promise.then(() => {}, () => {}), timer]);
        }
        if (!prefetch.settled || this.abortController?.signal.aborted) return;
        prefetch.consumed = true;
        this.memoryPrefetch = null;

        let memories: RelevantMemory[] = [];
        try { memories = await prefetch.promise; } catch { return; }
        if (memories.length === 0) return;

        this.messages.push({ role: "user", content: formatMemoriesForInjection(memories) });
        for (const m of memories) {
            this.alreadySurfacedMemories.add(m.path);
            this.sessionMemoryBytes += Buffer.byteLength(m.content, "utf-8");
        }
    }

    private preparePlanFile(): string {
        if (this.planFilePath) return this.planFilePath;
        const directory = join(os.homedir(), ".claude", "plans");
        mkdirSync(directory, { recursive: true });
        const stamp = new Date().toISOString().replace(/[.:]/g, "-");
        this.planFilePath = join(directory, `plan-${stamp}.md`);
        writeFileSync(this.planFilePath, "# Implementation Plan\n\n", "utf8");
        this.permissionPolicy.setPlanFilePath(this.planFilePath);
        return this.planFilePath;
    }

    private enterPlanModeFromTool(): Promise<string> {
        if (this.planMode) return Promise.resolve(`Already in plan mode. Plan file: ${this.preparePlanFile()}`);
        this.planMode = true;
        this.permissionMode = "plan";
        this.permissionPolicy.setMode("plan");
        const path = this.preparePlanFile();
        printPlanModeEntered(path);
        return Promise.resolve(`Entered plan mode. Read files and write the plan to ${path}. Call exit_plan_mode when ready.`);
    }

    private async exitPlanModeFromTool(): Promise<string> {
        if (!this.planMode) return "Error: the agent is not in plan mode.";
        const path = this.preparePlanFile();
        const content = readFileSync(path, "utf8").trim();
        if (!content || content === "# Implementation Plan") {
            return "Error: write the implementation plan to the plan file before calling exit_plan_mode.";
        }
        printPlanForApproval(content);
        if (!this.onAskUser) return "Error: plan approval is unavailable in this context.";
        const answer = (await this.onAskUser("Review the plan and choose how to proceed.", [
            "clear context and execute",
            "execute with current context",
            "execute with manual edit confirmations",
            "keep planning",
        ])).trim().toLowerCase();

        if (answer === "4" || answer.includes("keep")) {
            return "Plan kept for revision. Continue planning and call exit_plan_mode again when ready.";
        }

        const clear = answer === "1" || answer.includes("clear");
        const manual = answer === "3" || answer.includes("manual");
        if (clear) this.clearHistory();
        this.planMode = false;
        this.permissionMode = manual ? "default" : "acceptEdits";
        this.permissionPolicy.setMode(this.permissionMode);
        this.permissionPolicy.setPlanFilePath(null);
        printPlanModeExited(manual ? "default" : "acceptEdits");
        return clear
            ? "Plan approved. Context cleared; proceed with implementation."
            : "Plan approved. Proceed with implementation.";
    }

    async chat(userText: string): Promise<void> {
        // On the first call, prepend the context reminder (CLAUDE.md, date)
        // to the user message. This keeps it out of the cached system blocks
        // while ensuring the model sees project instructions early.
        let userContent: string = userText;
        if (!this.injectedContextReminder) {
            const reminder = buildUserContextReminder();
            if (reminder) userContent = `${reminder}\n\n${userText}`;
            this.injectedContextReminder = true;
        }

        this.messages.push({ role: "user", content: userContent });
        if (shouldAutoCompact(this.messages, this.contextWindow)) this.compact();

        // Set up abort controller for this turn.
        this.abortController = new AbortController();
        this.isProcessing = true;

        // Recall memories relevant to this question while the loop spins up.
        this.startTurnMemoryPrefetch(userText);

        try {
            await this.runAgentLoop();
        } finally {
            // Safety net: runAgentLoop can bail from several places (abort,
            // no-tool termination, a thrown API error). None of them may leave
            // a spinner frame on screen or its interval ticking.
            endStatus();
            this.isProcessing = false;
            this.abortController = null;
            // Auto-save after each chat() completes.
            this.onChatComplete?.();
        }
    }

    /**
     * Open the message stream for one turn, with thinking/effort params when
     * they apply.
     *
     * A 400 naming one of those fields means the endpoint doesn't implement it
     * — an ordinary situation when ANTHROPIC_BASE_URL points at a
     * partially-compatible server. Drop them for the rest of the session and
     * retry once, rather than failing a turn that would otherwise work.
     */
    private async openStream(
        system: Anthropic.TextBlockParam[],
        tools: Anthropic.Tool[], 
        messages: Anthropic.MessageParam[],
    ): Promise<any> {
        const base: Record<string, any> = {
            model: this.model,
            max_tokens: this.maxTokens,
            system,
            messages,
            tools,
            stream: true,
        };

        const tuned = { ...base };
        if (!this.optionalParamsRejected) {
            applyThinkingParams(tuned, resolveThinkingMode(this.model, this.thinkingEnabled), this.maxTokens);
            applyEffortParams(tuned, this.effort);
        }

        try {
            // withRetry wraps the API call: 429/503/529 and network
            // errors are retried with exponential backoff + jitter.
            return await withRetry(
                (signal) => this.client.messages.create({ ...tuned, signal } as any),
                this.abortController?.signal,
            );
        } catch (e: any) {
            if (this.optionalParamsRejected || !isUnsupportedParamError(e)) throw e;

            this.optionalParamsRejected = true;
            printInfo(`endpoint does not support thinking/effort (${briefApiError(e)}) — continuing without them`);
            return await withRetry(
                (signal) => this.client.messages.create({ ...base, signal } as any),
                this.abortController?.signal,
            );
        }
    }

    private async runAgentLoop(): Promise<void> {
        let turns = 0;
        // An empty response is usually a transient blip, so give it one retry.
        // Bounded at one: if the cause is a too-small max_tokens, retrying
        // just spends another call to be truncated the same way.
        let emptyTurnRetried = false;

        // Agent loop: keep going as long as the model produces tool calls.
        while (true) {
            if (this.maxTurns > 0 && turns >= this.maxTurns) {
                printTurnEnd(`stopped after ${this.maxTurns} turns — the task may be unfinished`);
                return;
            }
            turns++;

            // Pick up the memory prefetch — short bounded wait on the first
            // iteration, no wait afterwards.
            await this.consumeMemoryPrefetch(turns === 1 ? 2_000 : 0);

            // Each iteration is a fresh "model is working" phase, so the
            // elapsed clock restarts. The defensive endStatus() guarantees
            // that even if a phase left the status active.
            endStatus();
            beginStatus(pickStatusVerb());

            const tools = getActiveToolDefinitions();
            const compressed = compressHistory(this.messages, {
                contextWindow: this.contextWindow,
                cacheHot: this.lastRequestAt > 0 && Date.now() - this.lastRequestAt < 5 * 60_000,
                idleMs: this.lastRequestAt > 0 ? Date.now() - this.lastRequestAt : 0,
            });
            const cached = withCacheBreakpoints(compressed.messages, buildSystemBlocks(this.planMode));
            this.contextUtilization = estimateTokens({
                system: cached.system,
                messages: cached.messages,
                tools,
            }) / Math.max(1, this.contextWindow - 20_000);
            this.lastRequestAt = Date.now();

            let stream: any;
            try {
                stream = await this.openStream(cached.system, tools, cached.messages);
            } catch (e: any) {
                if (e.name === "AbortError" || this.abortController?.signal.aborted) {
                    // User interrupted — don't push a partial assistant turn.
                    return;
                }
                throw e;
            }

            // ── Streaming accumulation state ────────────────────────
            const assistantContent: Anthropic.ContentBlockParam[] = [];
            let currentText = "";
            // "end_turn" / "tool_use" / "max_tokens" / "refusal" / ...
            // max_tokens is the one that matters: it means the turn was cut off.
            let stopReason: string | null = null;

            // Per-block parser state, keyed by content_block index.
            interface BlockState {
                type: "text" | "tool_use";
                id?: string;
                name?: string;
                jsonChunks: string[];
            }
            const blocks = new Map<number, BlockState>();

            // Thinking blocks are skipped entirely at content_block_start, so
            // they never enter `blocks`. Track their indices separately or the
            // content_block_stop handler's `if (!state) break` swallows them.
            const thinkingIdx = new Set<number>();
            let thinkingStartedAt = 0;

            const context: ToolContext = {
                readFileState: this.readFileState,
                askUser: this.onAskUser,
                permissionPolicy: this.permissionPolicy,
                confirmPermission: async (message) => {
                    if (!this.onAskUser) return false;
                    const answer = await this.onAskUser(`Allow this potentially destructive action?\n  ${message}`, ["y", "n"]);
                    return answer.trim().toLowerCase().startsWith("y");
                },
                enterPlanMode: () => this.enterPlanModeFromTool(),
                exitPlanMode: () => this.exitPlanModeFromTool(),
                todos: [],
            };
            const executor = new ToolExecutor(context);
            const toolResults = new Map<string, Promise<string>>();
            const toolStartTimes = new Map<string, number>();

            try {
                for await (const event of stream) {
                    // Check abort between events.
                    if (this.abortController?.signal.aborted) {
                        // Mirror the catch below. Breaking out instead would
                        // fall through to drain() and push an assistant turn
                        // plus a tool_result turn for tools the user just
                        // cancelled — then issue one more doomed API call.
                        endStream();
                        return;
                    }

                    switch (event.type) {
                        case "content_block_start": {
                            const idx = event.index;
                            const cb = event.content_block;
                            // Skip thinking blocks entirely — they are the
                            // model's private scratchpad and too expensive
                            // to store in conversation history. Time them so
                            // the UI can report "Thought for Ns".
                            if (cb.type === "thinking") {
                                thinkingIdx.add(idx);
                                thinkingStartedAt = Date.now();
                                updateStatus("Thinking");
                                break;
                            }
                            if (cb.type === "tool_use") {
                                blocks.set(idx, {
                                    type: "tool_use",
                                    id: cb.id,
                                    name: cb.name,
                                    jsonChunks: [],
                                });
                            } else if (cb.type === "text") {
                                blocks.set(idx, { type: "text", jsonChunks: [] });
                            }
                            break;
                        }
                        case "content_block_delta": {
                            const idx = event.index;
                            const delta = event.delta;
                            if (delta.type === "text_delta") {
                                writeStream(delta.text);
                                currentText += delta.text;
                            } else if (delta.type === "input_json_delta") {
                                blocks.get(idx)?.jsonChunks.push(delta.partial_json);
                            }
                            break;
                        }
                        case "content_block_stop": {
                            const idx = event.index;

                            if (thinkingIdx.has(idx)) {
                                const ms = Date.now() - thinkingStartedAt;
                                if (ms >= 1000) printThinkingDuration(ms);
                                break;
                            }

                            const state = blocks.get(idx);
                            if (!state) break;

                            if (state.type === "text") {
                                if (currentText.length > 0) {
                                    assistantContent.push({ type: "text", text: currentText });
                                    currentText = "";
                                }
                            } else if (state.type === "tool_use" && state.id && state.name) {
                                const raw = state.jsonChunks.join("");
                                let input: Record<string, any> = {};
                                let inputError: string | null = null;

                                if (raw.trim() === "") {
                                    // No arguments arrived at all — the call was
                                    // cut off mid-stream. Running it with {} gives
                                    // a baffling downstream error (write_file({})
                                    // dies deep inside a path call), so don't.
                                    inputError = `the ${state.name} call arrived with no arguments — it was cut off`;
                                } else {
                                    try {
                                        input = JSON.parse(raw);
                                    } catch {
                                        inputError = `the ${state.name} arguments were not valid JSON — the call was cut off`;
                                    }
                                }

                                // Still recorded so the tool_result below has a
                                // matching tool_use to pair with.
                                assistantContent.push({
                                    type: "tool_use",
                                    id: state.id,
                                    name: state.name,
                                    input,
                                });

                                printToolCall(state.name, input);
                                toolStartTimes.set(state.id, Date.now());

                                if (inputError) {
                                    // Answer with an error instead of executing, so
                                    // the model can re-issue the call correctly.
                                    toolResults.set(state.id, Promise.resolve(
                                        `Error: ${inputError}. Re-issue the call with the full arguments.`,
                                    ));
                                } else {
                                    toolResults.set(state.id, executor.enqueue(state.id, state.name, input));
                                }
                            }
                            break;
                        }
                        case "message_delta": {
                            // Track token usage from the stream.
                            const usage = (event as any).usage;
                            if (usage) {
                                this.totalInputTokens += usage.input_tokens ?? 0;
                                this.totalOutputTokens += usage.output_tokens ?? 0;
                            }
                            // Discarding this was why a truncated turn looked
                            // identical to a finished one.
                            const reason = (event as any).delta?.stop_reason;
                            if (reason) stopReason = reason;
                            break;
                        }
                    }
                }
            } catch (e: any) {
                if (e.name === "AbortError" || this.abortController?.signal.aborted) {
                    endStream();
                    return;
                }
                throw e;
            }

            endStream();
            endStatus();

            // Wait for all in-flight tools to finish.
            //
            // Parallel execution by design: tools were dispatched as their
            // content_block_stop events arrived during streaming. Safe tools
            // (read_file, list_files, grep_search) start immediately via
            // ToolExecutor.dispatch(), overlapping with the model generating
            // subsequent content. drain() only waits for stragglers — most
            // tools are already complete by the time the stream ends.
            //
            // A straggler is the one silent gap left in a turn, so cover it.
            if (!executor.isIdle) {
                beginStatus(() => {
                    const running = executor.running;
                    if (running.length === 1) return `Running ${running[0]}`;
                    if (running.length > 1) return `Running ${running.length} tools`;
                    return "Working";
                });
            }
            await executor.drain();
            // Must end here, not after the results print: leaving it active
            // would carry this phase's elapsed time into the next iteration,
            // which then reports a fresh API call as already 6s old.
            endStatus();

            // Drop thinking blocks before storing in history: they are the
            // model's scratchpad and can be thousands of tokens long.
            // Unconditional because the stream loop skips thinking blocks at
            // content_block_start and never adds them — this is belt-and-braces
            // for a case the loop can't currently produce.
            const filtered = filterThinkingBlocks(assistantContent);

            // A turn with no text and no tool use is not a finished turn. It
            // used to be treated as one — silently — and the empty assistant
            // message was pushed into history, which can also wedge the next
            // request. Endpoints that spend max_tokens on thinking hit this
            // constantly: the model thinks, gets cut off, and says nothing.
            if (filtered.length === 0) {
                // Truncated: retrying just buys another call to be cut off the
                // same way. The budget is the problem, and only the user can
                // raise it.
                if (stopReason === "max_tokens") {
                    printTurnEnd(
                        "the model produced no output — it is spending the whole token budget on thinking. Raise --max-tokens",
                    );
                    return;
                }
                // Not truncated: a genuinely empty response, usually transient.
                if (!emptyTurnRetried) {
                    printTurnEnd("the model returned an empty turn — retrying once");
                    emptyTurnRetried = true;
                    continue;
                }
                printTurnEnd("the model returned an empty turn again — nothing to continue with");
                return;
            }

            this.messages.push({ role: "assistant", content: filtered });

            // A truncated turn is reported even when it continues below: the
            // model may have been cut off mid-sentence or mid-tool-call.
            if (stopReason === "max_tokens") {
                printTurnEnd("response hit the max token limit — this turn may be incomplete");
            }

            // If no tools were called, the model is done.
            if (toolResults.size === 0) return;

            // Build tool results in the same order as tool_use blocks appeared.
            const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
            for (const block of filtered) {
                if (block.type !== "tool_use") continue;
                const output = prepareToolResult(await toolResults.get(block.id)!);
                const elapsed = Date.now() - (toolStartTimes.get(block.id) ?? Date.now());
                printToolResult(block.name, output, elapsed);
                resultBlocks.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                });
            }
            this.messages.push({ role: "user", content: resultBlocks });
        }
    }
}
