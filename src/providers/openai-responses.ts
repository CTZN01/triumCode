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
// OpenAI Responses API — /v1/responses
// ═══════════════════════════════════════════════════════════════
//
// GPT and Grok are served through this API. Two things make it a separate
// provider rather than a variant of chat: the stream is a typed event log
// (response.output_item.added, response.function_call_arguments.delta, ...)
// instead of one mixed delta, and it offers server-side conversation state.
//
// That state is deliberately unused. `store: false` plus a full `input` on
// every request keeps the conversation in agent.ts, where session save/restore,
// context compression and the memory prefetch all already operate on it — a
// previous_response_id would move history the agent cannot compress.

const RESPONSES_PATH = "v1/responses";

export function toResponsesInput(messages: Anthropic.MessageParam[]): any[] {
    const out: any[] = [];

    for (const message of messages) {
        if (typeof message.content === "string") {
            out.push({
                type: "message",
                role: message.role,
                content: [{
                    type: message.role === "assistant" ? "output_text" : "input_text",
                    text: message.content,
                }],
            });
            continue;
        }

        let parts: any[] = [];
        const flush = () => {
            if (!parts.length) return;
            out.push({
                type: "message",
                role: message.role,
                content: parts.map((p) => ({
                    type: message.role === "assistant" ? "output_text" : "input_text",
                    text: p.text,
                })),
            });
            parts = [];
        };

        for (const block of message.content as any[]) {
            if (block.type === "text") {
                parts.push({ text: block.text });
            } else if (block.type === "tool_use") {
                // A call is its own item, so flush the surrounding message
                // first — item order has to match the order it was emitted.
                flush();
                out.push({
                    type: "function_call",
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input ?? {}),
                });
            } else if (block.type === "tool_result") {
                flush();
                out.push({
                    type: "function_call_output",
                    call_id: block.tool_use_id,
                    output: toolResultText(block.content),
                });
            }
        }
        flush();
    }
    return out;
}

export function toResponsesTools(tools: Anthropic.Tool[]): any[] {
    // Flat, unlike chat's nested `function` object.
    return tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
    }));
}

type Lane =
    | { kind: "text"; index: number }
    | { kind: "thinking"; index: number }
    | { kind: "tool"; index: number; id: string; name: string };

/** Item ids key the lanes, and some events carry them as numbers. */
function laneKey(value: unknown): string {
    return value === undefined || value === null ? "" : String(value);
}

/** Re-emits the Responses event log as Anthropic content-block events. */
export class ResponsesStreamTranslator {
    private nextIndex = 0;
    private lanes = new Map<string, Lane>();
    private inputTokens = 0;
    private outputTokens = 0;
    private cacheReadTokens = 0;
    private sawToolCall = false;
    private truncated = false;
    private done = false;

    private startBlock(lane: Lane): any {
        const content_block = lane.kind === "tool"
            ? { type: "tool_use", id: lane.id, name: lane.name, input: {} }
            : lane.kind === "thinking"
                ? { type: "thinking", thinking: "" }
                : { type: "text", text: "" };
        return { type: "content_block_start", index: lane.index, content_block };
    }

    push(event: any): any[] {
        const type = event?.type;
        if (type === "error") {
            throw new ProviderError(200, `stream error: ${event?.message ?? JSON.stringify(event)}`);
        }

        switch (type) {
            case "response.output_item.added": {
                const item = event.item ?? {};
                const key = laneKey(item.id ?? item.call_id);
                if (item.type === "function_call") {
                    this.sawToolCall = true;
                    const lane: Lane = {
                        kind: "tool",
                        index: this.nextIndex++,
                        id: laneKey(item.call_id ?? item.id),
                        name: item.name ?? "",
                    };
                    this.lanes.set(key, lane);
                    return [this.startBlock(lane)];
                }
                if (item.type === "reasoning") {
                    const lane: Lane = { kind: "thinking", index: this.nextIndex++ };
                    this.lanes.set(key, lane);
                    return [this.startBlock(lane)];
                }
                return [];
            }

            case "response.output_text.delta":
            case "response.refusal.delta": {
                const text = event.delta ?? "";
                if (!text) return [];
                const key = laneKey(event.item_id ?? event.output_index);
                let lane = this.lanes.get(key);
                const events: any[] = [];
                if (!lane) {
                    lane = { kind: "text", index: this.nextIndex++ };
                    this.lanes.set(key, lane);
                    events.push(this.startBlock(lane));
                }
                events.push({
                    type: "content_block_delta",
                    index: lane.index,
                    delta: { type: "text_delta", text },
                });
                return events;
            }

            case "response.function_call_arguments.delta": {
                const lane = this.lanes.get(laneKey(event.item_id));
                const fragment = event.delta ?? "";
                if (!lane || lane.kind !== "tool" || !fragment) return [];
                return [{
                    type: "content_block_delta",
                    index: lane.index,
                    delta: { type: "input_json_delta", partial_json: fragment },
                }];
            }

            // Closing at the part level keeps block boundaries tight; the
            // item-level close that follows is then a no-op.
            case "response.output_text.done":
            case "response.refusal.done":
            case "response.function_call_arguments.done":
                return this.close(laneKey(event.item_id));

            // This one carries the item itself, not its id, and it is the only
            // close a reasoning item ever gets — miss it and the thinking block
            // stays open until finish(), which is what the loop times.
            case "response.output_item.done":
                return this.close(laneKey(event.item?.id ?? event.item?.call_id));

            case "response.completed":
            case "response.incomplete": {
                const response = event.response ?? {};
                const usage = response.usage ?? {};
                // Responses counts cached tokens inside input_tokens, the
                // opposite of Anthropic. Subtract them so the agent's one
                // accounting model means the same thing on every protocol:
                // `input` is what the cache did not serve.
                const cached = usage.input_tokens_details?.cached_tokens ?? 0;
                this.inputTokens = Math.max(0, (usage.input_tokens ?? this.inputTokens) - cached);
                this.cacheReadTokens = cached;
                this.outputTokens = usage.output_tokens ?? this.outputTokens;
                if (type === "response.incomplete"
                    && response.incomplete_details?.reason === "max_output_tokens") {
                    this.truncated = true;
                }
                return this.finish();
            }

            case "response.failed":
                throw new ProviderError(200, `response failed: ${JSON.stringify(event.response ?? event)}`);

            default:
                return [];
        }
    }

    private close(key: string): any[] {
        const lane = this.lanes.get(key);
        if (!lane) return [];
        this.lanes.delete(key);
        return [{ type: "content_block_stop", index: lane.index }];
    }

    /** Close whatever is still open, then report the stop reason and usage. */
    finish(): any[] {
        if (this.done) return [];
        this.done = true;
        const events: any[] = [];
        for (const index of [...this.lanes.values()].map((l) => l.index).sort((a, b) => a - b)) {
            events.push({ type: "content_block_stop", index });
        }
        this.lanes.clear();

        events.push({
            type: "message_delta",
            delta: {
                stop_reason: this.truncated ? "max_tokens" : stopReasonFromFinish(null, this.sawToolCall),
            },
            usage: {
                input_tokens: this.inputTokens,
                output_tokens: this.outputTokens,
                cache_read_input_tokens: this.cacheReadTokens,
            },
        });
        return events;
    }
}

async function* responseEvents(res: Response): AsyncGenerator<any> {
    const translator = new ResponsesStreamTranslator();
    for await (const event of readSse(res)) {
        for (const emitted of translator.push(event)) yield emitted;
    }
    for (const emitted of translator.finish()) yield emitted;
}

export class OpenAIResponsesProvider implements ModelProvider {
    public readonly protocol = "openai-responses" as const;
    private cfg: ProviderConfig;

    constructor(cfg: ProviderConfig) {
        this.cfg = cfg;
    }

    async stream(req: ModelRequest, signal?: AbortSignal): Promise<AsyncIterable<any>> {
        const body: Record<string, any> = {
            model: req.model,
            instructions: joinTextBlocks(req.system),
            input: toResponsesInput(req.messages),
            max_output_tokens: req.maxTokens,
            stream: true,
            store: false,
        };
        if (req.tools.length) body.tools = toResponsesTools(req.tools);
        if (req.effort) body.reasoning = { effort: openaiEffort(req.effort) };

        const res = await postForStream(
            endpoint(this.cfg.apiBase, RESPONSES_PATH),
            authHeaders(this.cfg),
            body,
            signal,
        );
        return responseEvents(res);
    }

    async completeText(req: SideTextRequest, signal?: AbortSignal): Promise<string> {
        const json = await postForJson(
            endpoint(this.cfg.apiBase, RESPONSES_PATH),
            authHeaders(this.cfg),
            {
                model: req.model,
                instructions: req.system,
                input: [{
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: req.user }],
                }],
                max_output_tokens: req.maxTokens,
                store: false,
            },
            signal,
        );
        const items: any[] = json?.output ?? [];
        return items
            .filter((i) => i.type === "message")
            .flatMap((i) => i.content ?? [])
            .filter((part: any) => part.type === "output_text")
            .map((part: any) => part.text)
            .join("");
    }
}
