import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";

// ═══════════════════════════════════════════════════════════════
// Agent loop behaviour, driven by a scripted SSE endpoint
// ═══════════════════════════════════════════════════════════════
//
// Every case here is a way the loop used to stop or misbehave silently.
// An endpoint that thinks by default — and spends max_tokens doing it —
// triggers most of them.

const MESSAGE_START = {
    type: "message_start",
    message: {
        id: "msg_1", type: "message", role: "assistant", model: "m",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
    },
};

const start = (index: number, block: any) => ({ type: "content_block_start", index, content_block: block });
const stop = (index: number) => ({ type: "content_block_stop", index });
const textDelta = (index: number, text: string) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const jsonDelta = (index: number, partial: string) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });
const finish = (stop_reason: string) => ({
    type: "message_delta",
    delta: { stop_reason },
    usage: { output_tokens: 5 },
});

type Turn = (write: (event: any) => void) => void;

interface FakeApi {
    url: string;
    bodies: any[];
    requests: number;
    close(): void;
}

async function fakeApi(turns: Turn[]): Promise<FakeApi> {
    let n = 0;
    const bodies: any[] = [];

    const server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const write = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        write(MESSAGE_START);
        // Repeat the last scripted turn forever, so a loop that fails to
        // terminate shows up as a turn-limit hit rather than a hung test.
        turns[Math.min(n++, turns.length - 1)](write);
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

/** Run a chat against a scripted endpoint, capturing all UI output. */
async function runChat(
    turns: Turn[],
    options: { maxTurns?: number; maxTokens?: number } = {},
): Promise<{ agent: Agent; api: FakeApi; output: string; error: any }> {
    const api = await fakeApi(turns);
    const agent = new Agent({
        model: "test-model", apiKey: "k", apiBase: api.url, planMode: true,
        maxTurns: options.maxTurns ?? 5,
        maxTokens: options.maxTokens,
    });

    // Stub console.log, NOT process.stdout.write. node:test's own reporter
    // writes TAP to process.stdout, and it runs top-level tests concurrently —
    // stubbing stdout swallows other tests' result lines and the runner loses
    // them entirely. All of the agent's UI output goes through logLine ->
    // console.log, so this captures everything asserted below; streamed model
    // text bypasses it and lands on the real stdout, where the TAP parser
    // ignores it as a diagnostic line.
    const originalLog = console.log;
    let output = "";
    console.log = (...args: any[]) => {
        output += args.map((a) => String(a)).join(" ") + "\n";
    };

    let error: any = null;
    try {
        await agent.chat("do the thing");
    } catch (e) {
        error = e;
    } finally {
        console.log = originalLog;
        api.close();
    }
    return { agent, api, output, error };
}

const assistantTurns = (agent: Agent) => agent.history().filter((m) => m.role === "assistant");

// ── Empty / truncated turns ─────────────────────────────────

test("a thinking-only turn is reported, not mistaken for completion", async () => {
    // The original bug: the model thought, got cut off, emitted nothing —
    // and the loop returned silently as if the task were done.
    const { agent, output, api } = await runChat([
        (w) => {
            w(start(0, { type: "thinking", thinking: "" }));
            w({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
            w(stop(0));
            w(finish("max_tokens"));
        },
    ], { maxTurns: 2 });

    assert.match(output, /produced no output/, output);
    assert.match(output, /--max-tokens/, "should point at the remedy");
    // Deliberately NOT retried: the same budget would truncate the same way.
    assert.equal(api.requests, 1, "a truncated empty turn is not retried");
    // The empty assistant message must never reach history.
    assert.equal(assistantTurns(agent).length, 0, "no empty assistant turn in history");
});

test("an empty turn with a normal stop reason gets one retry, then stops", async () => {
    const { agent, output, api } = await runChat([
        () => { /* no content blocks at all */ },
    ], { maxTurns: 5 });

    assert.match(output, /empty turn/, output);
    assert.equal(api.requests, 2, "one retry, then give up");
    assert.equal(assistantTurns(agent).length, 0);
});

test("a truncated turn with content is flagged but still continues", async () => {
    const { output, api } = await runChat([
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "I'll start by reading"));
            w(stop(0));
            w(start(1, { type: "tool_use", id: "t1", name: "list_files", input: {} }));
            w(jsonDelta(1, '{"directory_path":"src","max_depth":1}'));
            w(stop(1));
            w(finish("max_tokens"));
        },
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "done"));
            w(stop(0));
            w(finish("end_turn"));
        },
    ]);

    assert.match(output, /max token limit/, output);
    assert.equal(api.requests, 2, "the loop carried on to a second turn");
});

// ── Malformed tool calls ────────────────────────────────────

test("a tool call that arrived with no arguments is not executed", async () => {
    // Regression: raw === "" silently became {}, so write_file ran with no
    // file_path and died with "paths[0] must be of type string".
    const { output, api, agent } = await runChat([
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "write_file", input: {} }));
            w(stop(0));
            w(finish("tool_use"));
        },
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "ok"));
            w(stop(0));
            w(finish("end_turn"));
        },
    ]);

    assert.match(output, /arrived with no arguments/, output);
    assert.doesNotMatch(output, /paths\[0\]/, "the Node internals error must not surface");

    // The error goes back to the model as a tool_result, paired with its call.
    const toolResultTurn = agent.history().find(
        (m) => m.role === "user" && Array.isArray(m.content) && (m.content as any[])[0]?.type === "tool_result",
    );
    assert.ok(toolResultTurn, "an error tool_result was returned");
    assert.match(String((toolResultTurn!.content as any[])[0].content), /Re-issue the call/);
    assert.equal(api.requests, 2, "the model got a chance to retry");
});

test("a well-formed call missing a required argument is refused cleanly", async () => {
    const { output } = await runChat([
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "write_file", input: {} }));
            w(jsonDelta(0, "{}"));   // valid JSON, but no fields
            w(stop(0));
            w(finish("tool_use"));
        },
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "ok"));
            w(stop(0));
            w(finish("end_turn"));
        },
    ]);

    assert.match(output, /missing required argument.*file_path/, output);
    assert.doesNotMatch(output, /paths\[0\]/, "no Node internals leak");
});

test("a tool call with truncated JSON is refused, not run on garbage", async () => {
    const { output } = await runChat([
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "read_file", input: {} }));
            w(jsonDelta(0, '{"file_path":"src/agent'));   // cut off mid-string
            w(stop(0));
            w(finish("max_tokens"));
        },
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "ok"));
            w(stop(0));
            w(finish("end_turn"));
        },
    ]);

    assert.match(output, /not valid JSON/, output);
});

// ── Loop bounds and request shape ───────────────────────────

test("a tool that keeps succeeding cannot loop forever", async () => {
    // Without the cap this ran 600+ times in testing before being killed.
    const { output, api } = await runChat([
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "list_files", input: {} }));
            w(jsonDelta(0, '{"directory_path":"src","max_depth":1}'));
            w(stop(0));
            w(finish("tool_use"));
        },
    ], { maxTurns: 3 });

    assert.equal(api.requests, 3, "stopped at the turn limit");
    assert.match(output, /stopped after 3 turns/, output);
});

test("max_tokens defaults generously and is overridable", async () => {
    const byDefault = await runChat([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ]);
    assert.equal(byDefault.api.bodies[0].max_tokens, 32_000);

    const overridden = await runChat([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ], { maxTokens: 8000 });
    assert.equal(overridden.api.bodies[0].max_tokens, 8000);
});

test("a clean finish prints no turn-end notice", async () => {
    const { output } = await runChat([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "all done")); w(stop(0)); w(finish("end_turn")); },
    ]);
    assert.doesNotMatch(output, /^ {2}! /m, `unexpected notice in:\n${output}`);
});

// ── Memory recall ────────────────────────────────────────────

test("a settled memory prefetch is injected before the first model call", async () => {
    // Memory dirs resolve from cwd, so run this scenario inside a temp
    // project and restore cwd before returning (tests in a file are serial).
    const originalCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "triumcode-agent-mem-"));
    mkdirSync(join(dir, ".triumcode", "memory"), { recursive: true });
    writeFileSync(
        join(dir, ".triumcode", "memory", "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy target\ntype: project\n---\nDeploy to https://staging.example.com.",
    );
    process.chdir(dir);

    const api = await fakeApi([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "done")); w(stop(0)); w(finish("end_turn")); },
    ]);
    const agent = new Agent({
        model: "test-model", apiKey: "k", apiBase: api.url,
        sideQuery: async () => '{"selected_memories": ["project_deploy.md"]}',
    });

    try {
        await agent.chat("where should I deploy to test?");
    } finally {
        process.chdir(originalCwd);
        api.close();
    }

    // First request: the user's message plus the injected reminder turn.
    const userTexts = api.bodies[0].messages
        .filter((m: any) => m.role === "user")
        .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
    assert.equal(userTexts.length, 2);
    assert.match(userTexts[0], /where should I deploy/);
    // The second user turn is the recalled-memory reminder.
    assert.match(userTexts[1], /^<system-reminder>\nMemory \(saved/);
    assert.match(userTexts[1], /Deploy to https:\/\/staging\.example\.com\./);
});
