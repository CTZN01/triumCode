import Anthropic from "@anthropic-ai/sdk";
import { getActiveToolDefinitions, type ReadFileState, type ToolContext } from "./tools.js";
import { ToolExecutor } from "./tool-executor.js";
import { buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder } from "./prompt.js";
import { printToolCall, printToolResult, printToolError, writeStream, endStream, printCostReport } from "./ui.js";
import { withRetry } from "./retry.js";
import { resolveThinkingMode, applyThinkingParams, filterThinkingBlocks, type ThinkingMode } from "./thinking.js";

const MAX_TOKENS = 4096;

// System prompt as an array of TextBlockParam. The first block (persona +
// tool guidance) carries cache_control so it is reused across turns without
// being re-processed by the model. The second block (environment, git,
// CLAUDE.md) is rebuilt each turn.
function buildSystemBlocks(): Anthropic.TextBlockParam[] {
    return [
        {
            type: "text",
            text: buildStaticSystemPrompt(),
            cache_control: { type: "ephemeral" },
        },
        {
            type: "text",
            text: buildDynamicSystemContext(),
        },
    ];
}

export interface AgentUsage {
    input: number;
    output: number;
    cost: number;
}

export interface AgentOptions {
    model?: string;       // --model / -m from CLI, falls back to MINI_MODEL env
    thinking?: boolean;   // --thinking flag from CLI
}

export class Agent {
    private client: Anthropic;
    private model: string;
    private messages: Anthropic.MessageParam[] = [];
    private readFileState: ReadFileState = new Map();
    private injectedContextReminder = false;
    private thinkingEnabled: boolean;

    // ── Abort support ───────────────────────────────────────────
    private abortController: AbortController | null = null;
    public isProcessing = false;

    // ── Token usage tracking ────────────────────────────────────
    private totalInputTokens = 0;
    private totalOutputTokens = 0;

    // ── Auto-save callback ──────────────────────────────────────
    private onChatComplete?: () => void;

    constructor(options?: AgentOptions) {
        this.model = options?.model || process.env.MINI_MODEL || "deepseek-mini-1-20260912";
        this.client = new Anthropic({
            baseURL: process.env.ANTHROPIC_BASE_URL,
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
        this.thinkingEnabled = options?.thinking ?? false;
    }

    /** Register a callback invoked after each chat() completes. */
    setOnChatComplete(fn: () => void): void {
        this.onChatComplete = fn;
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
        this.injectedContextReminder = false;
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

        // Set up abort controller for this turn.
        this.abortController = new AbortController();
        this.isProcessing = true;

        try {
            await this.runAgentLoop();
        } finally {
            this.isProcessing = false;
            this.abortController = null;
            // Auto-save after each chat() completes.
            this.onChatComplete?.();
        }
    }

    private async runAgentLoop(): Promise<void> {
        // Resolve thinking mode once per conversation.
        const thinkingMode = resolveThinkingMode(this.model, this.thinkingEnabled);
        const thinkingParams: Record<string, any> = {};
        if (thinkingMode !== "disabled") {
            applyThinkingParams(thinkingParams, thinkingMode, MAX_TOKENS);
        }

        // Agent loop: keep going as long as the model produces tool calls.
        while (true) {
            const tools = getActiveToolDefinitions();
            const system = buildSystemBlocks();

            let stream: any;
            try {
                // withRetry wraps the API call: 429/503/529 and network
                // errors are retried with exponential backoff + jitter.
                stream = await withRetry(async (signal) => {
                    return this.client.messages.create({
                        model: this.model,
                        max_tokens: MAX_TOKENS,
                        system,
                        messages: this.messages,
                        tools,
                        stream: true,
                        signal,
                        ...thinkingParams,
                    } as any);
                }, this.abortController?.signal);
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

            // Per-block parser state, keyed by content_block index.
            interface BlockState {
                type: "text" | "tool_use";
                id?: string;
                name?: string;
                jsonChunks: string[];
            }
            const blocks = new Map<number, BlockState>();

            const context: ToolContext = { readFileState: this.readFileState };
            const executor = new ToolExecutor(context);
            const toolResults = new Map<string, Promise<string>>();

            try {
                for await (const event of stream) {
                    // Check abort between events.
                    if (this.abortController?.signal.aborted) break;

                    switch (event.type) {
                        case "content_block_start": {
                            const idx = event.index;
                            const cb = event.content_block;
                            // Skip thinking blocks entirely — they are the
                            // model's private scratchpad and too expensive
                            // to store in conversation history.
                            if (cb.type === "thinking") break;
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
                            const state = blocks.get(idx);
                            if (!state) break;

                            if (state.type === "text") {
                                if (currentText.length > 0) {
                                    assistantContent.push({ type: "text", text: currentText });
                                    currentText = "";
                                }
                            } else if (state.type === "tool_use" && state.id && state.name) {
                                const raw = state.jsonChunks.join("");
                                let input: Record<string, any>;
                                try {
                                    input = raw === "" ? {} : JSON.parse(raw);
                                } catch {
                                    input = {};
                                    printToolError(state.name, "failed to parse input, using {}");
                                }

                                assistantContent.push({
                                    type: "tool_use",
                                    id: state.id,
                                    name: state.name,
                                    input,
                                });

                                printToolCall(state.name, input);
                                toolResults.set(state.id, executor.enqueue(state.id, state.name, input));
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

            // Wait for all in-flight tools to finish.
            //
            // Parallel execution by design: tools were dispatched as their
            // content_block_stop events arrived during streaming. Safe tools
            // (read_file, list_files, grep_search) start immediately via
            // ToolExecutor.dispatch(), overlapping with the model generating
            // subsequent content. drain() only waits for stragglers — most
            // tools are already complete by the time the stream ends.
            await executor.drain();

            // Filter thinking blocks before storing in history.
            const filtered = thinkingMode !== "disabled"
                ? filterThinkingBlocks(assistantContent)
                : assistantContent;

            this.messages.push({ role: "assistant", content: filtered });

            // If no tools were called, the model is done.
            if (toolResults.size === 0) return;

            // Build tool results in the same order as tool_use blocks appeared.
            const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
            for (const block of filtered) {
                if (block.type !== "tool_use") continue;
                const output = await toolResults.get(block.id)!;
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
