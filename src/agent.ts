import Anthropic from "@anthropic-ai/sdk";
import { getActiveToolDefinitions, type ReadFileState, type ToolContext } from "./tools.js";
import { ToolExecutor } from "./tool-executor.js";
import { buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder } from "./prompt.js";

const MODEL = process.env.MINI_MODEL || "deepseek-mini-1-20260912";

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

export class Agent {
    private client: Anthropic;
    private messages: Anthropic.MessageParam[] = [];
    private readFileState: ReadFileState = new Map();
    // Track whether we have already injected the user-context reminder
    // (CLAUDE.md + date) into the conversation.
    private injectedContextReminder = false;

    constructor() {
        this.client = new Anthropic({
            baseURL: process.env.ANTHROPIC_BASE_URL,
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
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

        // Agent loop: keep going as long as the model produces tool calls.
        while (true) {
            const tools = getActiveToolDefinitions();
            const system = buildSystemBlocks();

            const stream = await this.client.messages.create({
                model: MODEL,
                max_tokens: 4096,
                system,
                messages: this.messages,
                tools,
                stream: true,
            });

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

            for await (const event of stream) {
                switch (event.type) {
                    case "content_block_start": {
                        const idx = event.index;
                        const cb = event.content_block;
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
                            process.stdout.write(delta.text);
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
                                console.error(`  ⚠ failed to parse input for ${state.name}, using {}`);
                            }

                            assistantContent.push({
                                type: "tool_use",
                                id: state.id,
                                name: state.name,
                                input,
                            });

                            toolResults.set(state.id, executor.enqueue(state.id, state.name, input));
                        }
                        break;
                    }
                }
            }

            process.stdout.write("\n");

            // Wait for all in-flight tools to finish.
            await executor.drain();

            this.messages.push({ role: "assistant", content: assistantContent });

            // If no tools were called, the model is done.
            if (toolResults.size === 0) return;

            // Build tool results in the same order as tool_use blocks appeared.
            const resultBlocks: Anthropic.ToolResultBlockParam[] = [];
            for (const block of assistantContent) {
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
