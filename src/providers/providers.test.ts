import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Agent } from "../agent.js";
import { apiRoot, endpoint, PROTOCOLS, parseProtocol, defaultAuthFor } from "./types.js";
import {
    OpenAIChatProvider, ChatStreamTranslator, toChatMessages, toChatTools,
} from "./openai-chat.js";
import {
    OpenAIResponsesProvider, ResponsesStreamTranslator, toResponsesInput, toResponsesTools,
} from "./openai-responses.js";

// ═══════════════════════════════════════════════════════════════
// Protocol translators
// ═══════════════════════════════════════════════════════════════
//
// Two levels here. The translators and body builders get direct unit tests,
// because their job is exact shape-for-shape conversion. Each protocol then
// gets one end-to-end run through a real Agent against a scripted gateway,
// because the property that actually matters is that the Anthropic-shaped
// events these emit drive the existing agent loop unchanged — including the
// tool_use/tool_result pairing that history is built from.

const text = (t: string) => ({ type: "text" as const, text: t });
const toolUse = (id: string, name: string, input: any) => ({ type: "tool_use", id, name, input });

// ── Endpoint plumbing ───────────────────────────────────────

test("apiRoot drops the version segment the docs paste but the SDK re-appends", () => {
    assert.equal(apiRoot("https://opencode.ai/zen/go/v1"), "https://opencode.ai/zen/go");
    assert.equal(apiRoot("https://opencode.ai/zen/go/v1/"), "https://opencode.ai/zen/go");
    assert.equal(apiRoot("https://api.anthropic.com"), "https://api.anthropic.com");
    // Only a trailing version segment goes; a path that merely mentions v1 stays.
    assert.equal(apiRoot("https://gw.example/v1beta"), "https://gw.example/v1beta");
    assert.equal(apiRoot(""), "");
});

test("endpoint resolves one path per protocol from the same base", () => {
    const base = "https://opencode.ai/zen/go/v1";
    assert.equal(endpoint(base, "v1/chat/completions"), "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(endpoint(base, "v1/responses"), "https://opencode.ai/zen/go/v1/responses");
    assert.throws(() => endpoint("", "v1/chat/completions"), /needs an endpoint/);
});

test("protocols parse case-insensitively and refuse anything else", () => {
    assert.equal(parseProtocol("OpenAI-Chat"), "openai-chat");
    assert.equal(parseProtocol("openai-wide"), null);
    assert.equal(defaultAuthFor("anthropic"), "api-key");
    assert.equal(defaultAuthFor("openai-chat"), "bearer");
    assert.equal(PROTOCOLS.length, 3);
});

// ── Request bodies ──────────────────────────────────────────

test("chat history carries tools as tool_calls and role:tool results", () => {
    const messages = toChatMessages(
        [text("You are helpful.")],
        [
            { role: "user", content: "list src" },
            { role: "assistant", content: [text("sure"), toolUse("call_1", "list_files", { directory_path: "src" })] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "agent.ts" }] },
        ] as any,
    );

    assert.deepEqual(messages[0], { role: "system", content: "You are helpful." });
    assert.deepEqual(messages[1], { role: "user", content: "list src" });
    // Text and the call live in one assistant entry, arguments as a string.
    assert.deepEqual(messages[2], {
        role: "assistant",
        content: "sure",
        tool_calls: [{
            id: "call_1", type: "function",
            function: { name: "list_files", arguments: '{"directory_path":"src"}' },
        }],
    });
    assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: "agent.ts" });
});

test("an assistant turn that only calls tools sends null content, not an empty string", () => {
    const messages = toChatMessages([], [
        { role: "assistant", content: [toolUse("c", "read_file", { file_path: "x" })] },
    ] as any);
    assert.equal(messages[0].content, null);
    assert.equal(messages[0].tool_calls.length, 1);
});

test("chat nests the tool schema under function while responses keeps it flat", () => {
    const tools = [{ name: "grep_search", description: "d", input_schema: { type: "object" } } as any];
    assert.deepEqual(toChatTools(tools)[0].function, {
        name: "grep_search", description: "d", parameters: { type: "object" },
    });
    assert.deepEqual(toResponsesTools(tools)[0], {
        type: "function", name: "grep_search", description: "d", parameters: { type: "object" },
    });
});

test("responses history becomes typed items in emission order", () => {
    const input = toResponsesInput([
        { role: "assistant", content: [text("looking"), toolUse("call_9", "list_files", { directory_path: "src" })] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: "a.ts\nb.ts" }] },
    ] as any);

    assert.deepEqual(input.map((i) => i.type), ["message", "function_call", "function_call_output"]);
    assert.deepEqual(input[0].content, [{ type: "output_text", text: "looking" }]);
    assert.equal(input[1].call_id, "call_9");
    assert.equal(input[1].arguments, '{"directory_path":"src"}');
    // The result references the call by call_id, which is the id the loop stored.
    assert.equal(input[2].call_id, "call_9");
    assert.equal(input[2].output, "a.ts\nb.ts");
});

// ── Stream translators ──────────────────────────────────────

const collect = (translator: { push(c: any): any[]; finish(): any[] }, chunks: any[]) => {
    const events: any[] = [];
    for (const chunk of chunks) events.push(...translator.push(chunk));
    events.push(...translator.finish());
    return events;
};

const deltasOf = (events: any[], index: number) => events
    .filter((e) => e.type === "content_block_delta" && e.index === index)
    .map((e) => e.delta.text ?? e.delta.partial_json ?? e.delta.thinking)
    .join("");

test("chat chunks rebuild text and tool blocks, closing every block before the stop", () => {
    const events = collect(new ChatStreamTranslator(), [
        { choices: [{ delta: { content: "hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"file' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a.ts"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { usage: { prompt_tokens: 12, completion_tokens: 5 } },
    ]);

    assert.equal(events[0].type, "content_block_start");
    assert.equal(events[0].content_block.type, "text");
    assert.equal(deltasOf(events, 0), "hello");
    // The two argument fragments reassemble into parseable JSON.
    assert.equal(deltasOf(events, 1), '{"file_path":"a.ts"}');
    assert.equal(events.find((e) => e.type === "content_block_start" && e.index === 1).content_block.id, "call_a");

    const stops = events.filter((e) => e.type === "content_block_stop").map((e) => e.index);
    assert.deepEqual(stops, [0, 1], "blocks close in index order");

    const delta = events[events.length - 1];
    assert.equal(delta.type, "message_delta");
    assert.equal(delta.delta.stop_reason, "tool_use");
    assert.deepEqual(delta.usage, { input_tokens: 12, output_tokens: 5 });
});

test("chat reasoning text becomes a thinking block that the loop can time and drop", () => {
    const events = collect(new ChatStreamTranslator(), [
        { choices: [{ delta: { reasoning_content: "thinking hard" } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

    assert.equal(events[0].content_block.type, "thinking");
    assert.equal(deltasOf(events, 0), "thinking hard");
    assert.equal(events.find((e) => e.type === "content_block_start" && e.index === 1).content_block.type, "text");
    assert.equal(events[events.length - 1].delta.stop_reason, "end_turn");
});

test("a truncated chat turn reports max_tokens", () => {
    const events = collect(new ChatStreamTranslator(), [
        { choices: [{ delta: { content: "cut" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    assert.equal(events[events.length - 1].delta.stop_reason, "max_tokens");
});

test("responses events rebuild the same block sequence as chat", () => {
    const events = collect(new ResponsesStreamTranslator(), [
        { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "checking" },
        { type: "response.output_text.done", item_id: "msg_1" },
        { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_b", name: "list_files" } },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"directory_path":' },
        { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"src"}' },
        { type: "response.output_item.done", item: { id: "fc_1" } },
        { type: "response.completed", response: { usage: { input_tokens: 30, output_tokens: 9 } } },
    ]);

    assert.equal(deltasOf(events, 0), "checking");
    assert.equal(deltasOf(events, 1), '{"directory_path":"src"}');
    const toolStart = events.find((e) => e.content_block?.type === "tool_use");
    assert.equal(toolStart.content_block.id, "call_b", "call_id becomes the tool_use id the loop pairs results on");
    assert.equal(events[events.length - 1].delta.stop_reason, "tool_use");
    assert.deepEqual(events[events.length - 1].usage, { input_tokens: 30, output_tokens: 9 });
});

test("an incomplete responses turn reports max_tokens", () => {
    const events = collect(new ResponsesStreamTranslator(), [
        { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "half" },
        { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    assert.equal(events[events.length - 1].delta.stop_reason, "max_tokens");
    // The open text block must still close, or the text is never stored.
    assert.ok(events.some((e) => e.type === "content_block_stop"));
});

test("a reasoning item closes its thinking block at the item, not at finish()", () => {
    // A reasoning item gets no part-level close, so this event is the only one
    // that ends its block. Left open, the loop times the block from finish() —
    // which reports the whole turn as "Thought for Ns".
    const translator = new ResponsesStreamTranslator();
    const events: any[] = [];
    events.push(...translator.push({ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } }));
    events.push(...translator.push({ type: "response.output_item.done", item: { id: "rs_1", type: "reasoning" } }));

    assert.deepEqual(events.map((e) => e.type), ["content_block_start", "content_block_stop"]);
    assert.equal(events[0].content_block.type, "thinking");
});

// ── End-to-end against a scripted gateway ───────────────────

type Frames = (write: (payload: any) => void) => void;

interface FakeGateway {
    url: string;
    bodies: any[];
    requests: number;
    close(): void;
}

/**
 * A stand-in for a model gateway: replies with server-sent events in the shape
 * the given protocol uses. `reject` can fail a request by body field name,
 * which is how partial-compatibility paths get exercised.
 */
async function gateway(
    protocol: "openai-chat" | "openai-responses",
    turns: Frames[],
    reject?: (body: any) => string | null,
    prettyErrors = false,
): Promise<FakeGateway> {
    let n = 0;
    const bodies: any[] = [];

    const server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);

        const path = (req.url ?? "").split("?")[0];
        const expected = protocol === "openai-chat" ? "/v1/chat/completions" : "/v1/responses";
        if (path !== expected) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `no route ${path}` } }));
            return;
        }

        const reason = reject?.(body);
        if (reason) {
            // Real gateways name the offending field, which is what the
            // degrade path keys on. Some print it over several lines.
            const payload = { error: { message: `Unsupported parameter: '${reason}'` } };
            res.writeHead(400, { "content-type": "application/json" });
            res.end(prettyErrors ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
            return;
        }

        bodies.push(body);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const write = (payload: any) => {
            const frame = protocol === "openai-responses"
                ? `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
                : `data: ${JSON.stringify(payload)}\n\n`;
            res.write(frame);
        };
        turns[Math.min(n++, turns.length - 1)](write);
        res.write("data: [DONE]\n\n");
        res.end();
    });

    const port = await new Promise<number>((r) => {
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
    });
    return {
        url: `http://127.0.0.1:${port}`,
        bodies,
        get requests() { return n; },
        close: () => server.close(),
    };
}

async function runOn(
    protocol: "openai-chat" | "openai-responses",
    turns: Frames[],
    options: {
        reject?: (body: any) => string | null;
        effort?: string;
        prettyErrors?: boolean;
    } = {},
): Promise<{ agent: Agent; api: FakeGateway; output: string; error: any }> {
    const api = await gateway(protocol, turns, options.reject, options.prettyErrors);
    const agent = new Agent({
        model: "gateway-model", apiKey: "k", apiBase: api.url,
        protocol, auth: "bearer", planMode: true, maxTurns: 4,
        effort: options.effort,
        // Memory recall would otherwise spend a request of its own on the
        // scripted gateway and shift every body index below.
        sideQuery: async () => "[]",
    });

    const originalLog = console.log;
    let output = "";
    console.log = (...args: any[]) => { output += args.map((a) => String(a)).join(" ") + "\n"; };

    let error: any = null;
    try {
        await agent.chat("list the src directory and say done");
    } catch (e) {
        error = e;
    } finally {
        console.log = originalLog;
        api.close();
    }
    return { agent, api, output, error };
}

const toolResultTurnOf = (agent: Agent) => agent.history().find(
    (m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[])[0]?.type === "tool_result",
);

const chatToolTurn: Frames = (w) => {
    w({ choices: [{ delta: { content: "listing" } }] });
    w({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_files", arguments: '{"directory' } }] } }] });
    w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"src","max_depth":1}' } }] } }] });
    w({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    w({ usage: { prompt_tokens: 10, completion_tokens: 6 } });
};

const chatFinalTurn: Frames = (w) => {
    w({ choices: [{ delta: { content: "done" } }] });
    w({ choices: [{ delta: {}, finish_reason: "stop" }] });
    w({ usage: { prompt_tokens: 20, completion_tokens: 2 } });
};

const responsesToolTurn: Frames = (w) => {
    w({ type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "list_files" } });
    w({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"directory_path":"src","max_depth":1}' });
    w({ type: "response.output_item.done", item: { id: "fc_1" } });
    w({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 6 } } });
};

const responsesFinalTurn: Frames = (w) => {
    w({ type: "response.output_item.added", item: { id: "msg_2", type: "message" } });
    w({ type: "response.output_text.delta", item_id: "msg_2", delta: "done" });
    w({ type: "response.output_text.done", item_id: "msg_2" });
    w({ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 2 } } });
};

test("openai-chat drives the agent loop: tool call, result, and a clean finish", async () => {
    const { agent, api, error } = await runOn("openai-chat", [chatToolTurn, chatFinalTurn]);
    assert.equal(error, null, `chat turn failed: ${error?.message}`);

    const assistant = agent.history().find((m) => m.role === "assistant") as any;
    assert.equal(assistant.content[1].type, "tool_use");
    assert.equal(assistant.content[1].name, "list_files");
    assert.deepEqual(assistant.content[1].input, { directory_path: "src", max_depth: 1 });

    const result = (toolResultTurnOf(agent)!.content as any[])[0];
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "call_1");
    assert.match(String(result.content), /agent\.ts/, "the tool really ran");

    // What goes back to the gateway is the converted form, keyed by the same id.
    assert.equal(api.requests, 2);
    const second = api.bodies[1].messages;
    assert.equal(second.find((m: any) => m.role === "tool").tool_call_id, "call_1");
    assert.equal(second.find((m: any) => m.role === "assistant").tool_calls[0].function.name, "list_files");
    assert.equal(api.bodies[0].tools[0].function.parameters.type, "object");
    assert.equal(agent.getUsage().input, 30);
    assert.equal(agent.getUsage().output, 8);
});

test("openai-responses drives the same loop through its typed event log", async () => {
    const { agent, api, error } = await runOn("openai-responses", [responsesToolTurn, responsesFinalTurn]);
    assert.equal(error, null, `responses turn failed: ${error?.message}`);

    const assistant = agent.history().find((m) => m.role === "assistant") as any;
    assert.equal(assistant.content[0].type, "tool_use");
    assert.equal(assistant.content[0].id, "call_1", "call_id becomes the id the loop pairs results on");

    const result = (toolResultTurnOf(agent)!.content as any[])[0];
    assert.match(String(result.content), /agent\.ts/);

    assert.equal(api.bodies[1].store, false, "the agent keeps owning the history");
    const outputItem = api.bodies[1].input.find((i: any) => i.type === "function_call_output");
    assert.equal(outputItem.call_id, "call_1");
    assert.match(outputItem.output, /agent\.ts/);
    assert.equal(api.bodies[0].tools[0].parameters.type, "object", "tools stay flat for this API");
});

test("a gateway that rejects the reasoning param degrades instead of failing", async () => {
    const { api, output, error } = await runOn(
        "openai-chat",
        [chatFinalTurn],
        { effort: "high", reject: (b) => (b.reasoning_effort ? "reasoning_effort" : null) },
    );
    assert.equal(error, null);
    assert.match(output, /does not support thinking\/effort/, output);
    assert.equal(api.bodies[0].reasoning_effort, undefined, "the retry dropped it");
});

test("a pretty-printed 400 still degrades — the whole body survives, not its first line", async () => {
    // Cutting the payload at the first newline leaves "{" — enough to lose both
    // the field name the degrade path matches and the message the user reads.
    const { api, output, error } = await runOn(
        "openai-chat",
        [chatFinalTurn],
        { effort: "high", reject: (b) => (b.reasoning_effort ? "reasoning_effort" : null), prettyErrors: true },
    );
    assert.equal(error, null);
    assert.match(output, /does not support thinking\/effort/, output);
    assert.match(output, /reasoning_effort/, "the gateway's own message is quoted");
    assert.equal(api.bodies[0].reasoning_effort, undefined, "the retry dropped it");
});

test("a gateway that rejects stream_options is not asked again", async () => {
    const { api, error } = await runOn(
        "openai-chat",
        [chatToolTurn, chatFinalTurn],
        { reject: (b) => (b.stream_options ? "stream_options" : null) },
    );
    assert.equal(error, null);
    // Two turns, both accepted: the retry that dropped the field happens
    // inside the provider, so a rejected attempt never lands in `bodies`.
    assert.equal(api.requests, 2, "the session kept streaming after the drop");
    assert.ok(api.bodies.every((b) => b.stream_options === undefined), "never sent again");
});

// ── The non-streaming side call (memory recall) ─────────────

async function jsonServer(path: string, reply: any) {
    const bodies: any[] = [];
    const server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        bodies.push(JSON.parse(raw));

        if ((req.url ?? "").split("?")[0] !== path) {
            res.writeHead(404).end("{}");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
    });
    const port = await new Promise<number>((r) => {
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
    });
    return { bodies, url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("completeText answers the memory-recall call in each protocol's shape", async () => {
    const chat = await jsonServer("/v1/chat/completions", {
        choices: [{ message: { content: "from chat" } }],
    });
    const responses = await jsonServer("/v1/responses", {
        output: [{ type: "message", content: [{ type: "output_text", text: "from responses" }] }],
    });

    const cfg = (apiBase: string) => ({ apiBase, apiKey: "k", auth: "bearer" as const });
    const ask = { model: "m", system: "s", user: "u", maxTokens: 64 };
    try {
        assert.equal(await new OpenAIChatProvider(cfg(chat.url)).completeText(ask), "from chat");
        assert.equal(await new OpenAIResponsesProvider(cfg(responses.url)).completeText(ask), "from responses");

        assert.equal(chat.bodies[0].stream, undefined, "a side query is not a stream");
        assert.equal(chat.bodies[0].messages[0].role, "system");
        assert.equal(responses.bodies[0].store, false);
        assert.equal(responses.bodies[0].input[0].role, "user");
    } finally {
        chat.close();
        responses.close();
    }
});
