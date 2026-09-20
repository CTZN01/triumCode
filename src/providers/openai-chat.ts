import type Anthropic from "@anthropic-ai/sdk";
import {
    authHeaders,
    endpoint,
    joinTextBlocks,
    openaiEffort,
    postForJson,
    postForStream,
    ProviderError,
    readSse,
    stopReasonFromFinish,
    toolResultText,
    type ModelProvider,
    type ModelRequest,
    type ProviderConfig,
    type SideTextRequest,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// OpenAI Chat Completions — /v1/chat/completions
// ═══════════════════════════════════════════════════════════════
//
// DeepSeek, GLM, Kimi and MiMo are served through this API. It is close enough
// to Messages in spirit that only two things need translating: the request body
// (roles and tool schema are laid out differently) and the stream, which sends
// one mixed `delta` per chunk instead of typed content blocks.
//
// The translator below re-emits OpenAI chunks as Anthropic content-block
// events so the agent loop stays as it was — including its handling of a cut-off
// tool call, which is where a hand-rolled OpenAI path usually goes wrong.

const CHAT_PATH = "v1/chat/completions";

/** Turn Anthropic history into the flat role/tag array Chat Completions wants. */
export function toChatMessages(
    system: Anthropic.TextBlockParam[],
    messages: Anthropic.MessageParam[],
): any[] {
    const out: any[] = [];
    const instructions = joinTextBlocks(system);
    if (instructions) out.push({ role: "system", content: instructions });

    for (const message of messages) {
        if (typeof message.content === "string") {
            out.push({ role: message.role, content: message.content });
            continue;
        }

        const text: string[] = [];
        const toolCalls: any[] = [];
        const toolResults: any[] = [];

        for (const block of message.content as any[]) {
            if (block.type === "text") text.push(block.text);
            else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id,
                    type: "function",
                    function: {
                        name: block.name,
                        // Chat carries arguments as a JSON string, unlike
                        // Messages' structured input.
                        arguments: JSON.stringify(block.input ?? {}),
                    },
                });
            } else if (block.type === "tool_result") {
                toolResults.push({
                    role: "tool",
                    tool_call_id: block.tool_use_id,
                    content: toolResultText(block.content),
                });
            }
            // Thinking blocks are dropped before history is stored, so there
            // is nothing to carry here.
        }

        if (message.role === "assistant") {
            // content must be null (not "") alongside tool_calls; endpoints
            // differ on rejecting an empty string.
            const entry: any = { role: "assistant", content: text.length ? text.join("") : null };
            if (toolCalls.length) entry.tool_calls = toolCalls;
            out.push(entry);
        } else {
            // A user turn carrying results becomes one role:"tool" message per
            // call; any text the model should see follows them.
            out.push(...toolResults);
            if (text.length) out.push({ role: "user", content: text.join("") });
        }
    }
    return out;
}

export function toChatTools(tools: Anthropic.Tool[]): any[] {
    return tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
}

/**
 * Accumulates Chat chunks into the block-indexed event sequence the loop reads.
 *
 * OpenAI never says which block a delta belongs to, so lanes (reasoning, text,
 * each tool call) get an index the first time they appear and keep it.
 */
export class ChatStreamTranslator {
    private nextIndex = 0;
    private textIndex: number | null = null;
    private thinkingIndex: number | null = null;
    private tools = new Map<number, { index: number; id: string; name: string }>();
    // Real `index` values are small non-negative integers, so the fallback
    // counter starts far above them: an index-less call must not land on a key
    // an indexed call already owns, or the two merge into one block and the
    // second call's arguments get appended to the first.
    private unindexedKey = 1_000_000;
    private inputTokens = 0;
    private outputTokens = 0;
    private cacheReadTokens = 0;
    private finishReason: string | null = null;
    private done = false;

    push(chunk: any): any[] {
        const events: any[] = [];

        if (chunk?.error) {
            const message = chunk.error.message ?? JSON.stringify(chunk.error);
            throw new ProviderError(200, `stream error: ${message}`);
        }
        if (chunk?.usage) {
            // Chat Completions counts cached tokens inside prompt_tokens, the
            // opposite of Anthropic, which reports them separately. Subtract
            // them so the agent's one accounting model means the same thing on
            // every protocol: `input` is what the cache did not serve.
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            this.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached);
            this.cacheReadTokens = cached;
            this.outputTokens = chunk.usage.completion_tokens ?? this.outputTokens;
        }

        const choice = chunk?.choices?.[0];
        if (!choice) return events;
        if (choice.finish_reason) this.finishReason = choice.finish_reason;

        const delta = choice.delta ?? {};

        // Reasoning text arrives under different field names depending on
        // whose gateway this is; all of them belong in one thinking block,
        // which the loop uses for the "Thought for Ns" line and then drops.
        const reasoning = typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string" ? delta.reasoning : "";
        if (reasoning) {
            if (this.thinkingIndex === null) {
                this.thinkingIndex = this.nextIndex++;
                events.push({
                    type: "content_block_start",
                    index: this.thinkingIndex,
                    content_block: { type: "thinking", thinking: "" },
                });
            }
            events.push({
                type: "content_block_delta",
                index: this.thinkingIndex,
                delta: { type: "thinking_delta", thinking: reasoning },
            });
        }

        if (typeof delta.content === "string" && delta.content.length) {
            if (this.textIndex === null) {
                this.textIndex = this.nextIndex++;
                events.push({
                    type: "content_block_start",
                    index: this.textIndex,
                    content_block: { type: "text", text: "" },
                });
            }
            events.push({
                type: "content_block_delta",
                index: this.textIndex,
                delta: { type: "text_delta", text: delta.content },
            });
        }

        for (const call of delta.tool_calls ?? []) {
            // `index` is positional but not always sent; fall back to arrival
            // order so a second call does not overwrite the first.
            const key = typeof call.index === "number" ? call.index : this.unindexedKey++;
            let tool = this.tools.get(key);
            if (!tool) {
                tool = { index: this.nextIndex++, id: call.id ?? `call_${key}`, name: call.function?.name ?? "" };
                if (call.id) tool.id = call.id;
                if (call.function?.name) tool.name = call.function.name;
                this.tools.set(key, tool);
                events.push({
                    type: "content_block_start",
                    index: tool.index,
                    content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
                });
            } else {
                if (call.id && !tool.id) tool.id = call.id;
                if (call.function?.name && !tool.name) tool.name = call.function.name;
            }

            const fragment = call.function?.arguments;
            if (typeof fragment === "string" && fragment.length) {
                events.push({
                    type: "content_block_delta",
                    index: tool.index,
                    delta: { type: "input_json_delta", partial_json: fragment },
                });
            }
        }

        return events;
    }

    /** Close open blocks in index order, then report the stop reason and usage. */
    finish(): any[] {
        if (this.done) return [];
        this.done = true;
        const events: any[] = [];
        const open = [this.thinkingIndex, this.textIndex].filter((i): i is number => i !== null);
        for (const tool of this.tools.values()) open.push(tool.index);
        open.sort((a, b) => a - b);
        for (const index of open) events.push({ type: "content_block_stop", index });

        events.push({
            type: "message_delta",
            delta: { stop_reason: stopReasonFromFinish(this.finishReason, this.tools.size > 0) },
            usage: {
                input_tokens: this.inputTokens,
                output_tokens: this.outputTokens,
                cache_read_input_tokens: this.cacheReadTokens,
            },
        });
        return events;
    }
}

async function* chatEvents(res: Response): AsyncGenerator<any> {
    const translator = new ChatStreamTranslator();
    for await (const chunk of readSse(res)) {
        for (const event of translator.push(chunk)) yield event;
    }
    // finish() closes the open blocks. A stream that ends without a
    // finish_reason chunk still needs those, or a tool call never registers.
    for (const event of translator.finish()) yield event;
}

export class OpenAIChatProvider implements ModelProvider {
    public readonly protocol = "openai-chat" as const;
    private cfg: ProviderConfig;
    // Some gateways reject unknown fields, and `stream_options` is the only one
    // here that is an optimisation (usage on the final chunk) rather than part
    // of the request. Drop it for the session instead of failing the turn.
    private includeUsage = true;

    constructor(cfg: ProviderConfig) {
        this.cfg = cfg;
    }

    private body(req: ModelRequest): Record<string, any> {
        const body: Record<string, any> = {
            model: req.model,
            messages: toChatMessages(req.system, req.messages),
            max_tokens: req.maxTokens,
            stream: true,
        };
        if (req.tools.length) body.tools = toChatTools(req.tools);
        if (req.effort) body.reasoning_effort = openaiEffort(req.effort);
        if (this.includeUsage) body.stream_options = { include_usage: true };
        return body;
    }

    async stream(req: ModelRequest, signal?: AbortSignal): Promise<AsyncIterable<any>> {
        const url = endpoint(this.cfg.apiBase, CHAT_PATH);
        const headers = authHeaders(this.cfg);

        let res: Response;
        try {
            res = await postForStream(url, headers, this.body(req), signal);
        } catch (e: any) {
            const namesStreamOptions = String(e?.message ?? "").toLowerCase().includes("stream_options");
            if (this.includeUsage && e instanceof ProviderError && e.status === 400 && namesStreamOptions) {
                this.includeUsage = false;
                res = await postForStream(url, headers, this.body(req), signal);
            } else {
                throw e;
            }
        }

        return chatEvents(res);
    }

    async completeText(req: SideTextRequest, signal?: AbortSignal): Promise<string> {
        const body: Record<string, any> = {
            model: req.model,
            messages: [
                { role: "system", content: req.system },
                { role: "user", content: req.user },
            ],
            max_tokens: req.maxTokens,
        };
        const json = await postForJson(endpoint(this.cfg.apiBase, CHAT_PATH), authHeaders(this.cfg), body, signal);
        return json?.choices?.[0]?.message?.content ?? "";
    }
}
