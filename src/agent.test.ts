import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import type { PermissionMode } from "./permissions.js";

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
        usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 4 },
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
    headers: any[];
    requests: number;
    close(): void;
}

async function fakeApi(turns: Turn[], failOn: Set<number> = new Set()): Promise<FakeApi> {
    let n = 0;
    const bodies: any[] = [];
    const headers: any[] = [];

    const server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        headers.push(req.headers);
        try { bodies.push(JSON.parse(raw)); } catch { bodies.push(null); }

        // Indexed before the reply so a request that fails still consumes its
        // slot: the turns after it line up with the ones the caller scripted.
        const index = n++;
        if (failOn.has(index)) {
            // 400, not 5xx: the SDK retries 5xx internally, which would spend
            // the next scripted turn and hide the failure from this test.
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "scripted failure" } }));
            return;
        }

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const write = (event: any) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        write(MESSAGE_START);
        // Repeat the last scripted turn forever, so a loop that fails to
        // terminate shows up as a turn-limit hit rather than a hung test.
        turns[Math.min(index, turns.length - 1)](write);
        res.end();
    });

    const port = await new Promise<number>((r) => {
        server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port));
    });
    return {
        url: `http://127.0.0.1:${port}`,
        bodies,
        headers,
        get requests() { return n; },
        close: () => server.close(),
    };
}

/** Run a chat against a scripted endpoint, capturing all UI output. */
async function runChat(
    turns: Turn[],
    options: {
        maxTurns?: number;
        maxTokens?: number;
        permissionMode?: PermissionMode;
        askUser?: (question: string, options?: string[]) => Promise<string>;
        failOn?: Set<number>;
    } = {},
): Promise<{ agent: Agent; api: FakeApi; output: string; error: any }> {
    // Memory dirs resolve from the cwd (memory.ts), so a memory saved in the
    // developer's own checkout arrives as a side query on the first request and
    // shifts everything asserted below: bodies[0] becomes that side query — a
    // string system prompt, max_tokens 512 — and requests counts one too many.
    // Run from a scratch directory, and restore the cwd before returning (tests
    // in a file are serial, which the memory test below also relies on).
    const originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "triumcode-agent-cwd-")));

    const api = await fakeApi(turns, options.failOn);
    const agent = new Agent({
        model: "test-model", apiKey: "k", apiBase: api.url,
        // Plan mode is the default sandbox: it denies everything that writes,
        // so a test that did not ask for a mode cannot touch the workspace.
        // A test that needs a tool to reach the confirmation prompt passes its
        // own mode instead.
        planMode: options.permissionMode === undefined,
        permissionMode: options.permissionMode,
        maxTurns: options.maxTurns ?? 5,
        maxTokens: options.maxTokens,
    });
    if (options.askUser) agent.setAskUserCallback(options.askUser);

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
        process.chdir(originalCwd);
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

// ── Permission confirmation ─────────────────────────────────

test("a destructive-action confirmation offers the refusal first", async () => {
    // The CLI picker starts on the first option, so if "y" leads, a reflexive
    // Enter allows a destructive command. Refusal first keeps Enter on the
    // default a refusal — which is what Enter did before the picker existed
    // (it skipped, and a skip is not a yes).
    const asked: Array<string[] | undefined> = [];
    const { agent } = await runChat([
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "run_command", input: {} }));
            w(jsonDelta(0, '{"command":"sudo","args":[]}'));
            w(stop(0));
            w(finish("tool_use"));
        },
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "ok"));
            w(stop(0));
            w(finish("end_turn"));
        },
    ], {
        permissionMode: "default",
        askUser: async (_question, options) => {
            asked.push(options);
            return "n";   // what the picker returns for the highlighted refusal
        },
    });

    assert.equal(asked.length, 1, "the command was confirmed exactly once");
    assert.deepEqual(asked[0], ["n", "y"], "the refusal is the default choice");

    // Returning the option's own text must deny: the parser matches on the
    // word, so a refused confirmation cannot be read as consent.
    const toolResult = agent.history().flatMap((m) => Array.isArray(m.content) ? m.content : [])
        .find((b: any) => b.type === "tool_result");
    assert.match(String((toolResult as any).content), /denied/i);
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

// ── Prompt caching ──────────────────────────────────────────

test("volatile context rides on the user message, not the cached system prompt", async () => {
    const { api } = await runChat([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ]);

    // One cacheable block, and nothing in it may change between turns. Prompt
    // caching matches on a byte-exact prefix, so git status sitting here (as it
    // did) re-processed the whole conversation every time the agent wrote a
    // file — the single largest source of wasted tokens in the loop.
    const system = api.bodies[0].system;
    assert.equal(system.length, 1, "the system prompt is one cacheable block");
    assert.equal(system[0].cache_control.type, "ephemeral");
    assert.match(system[0].text, /You are TriumCode/);
    assert.doesNotMatch(system[0].text, /# currentDate/);
    assert.doesNotMatch(system[0].text, /Git branch:/);

    // The date and the git state ride on the user's message instead. That
    // message is new every turn, so it invalidates nothing behind it.
    const first = api.bodies[0].messages[0] as any;
    assert.equal(first.role, "user");
    assert.match(first.content[0].text, /^<system-reminder>/);
    assert.match(first.content[0].text, /# currentDate/);
    assert.match(first.content[0].text, /do the thing/);
});

test("prompt usage is counted once when the gateway echoes it", async () => {
    // Anthropic reports the prompt side in message_start and repeats it in
    // message_delta; MiMo echoes it in both. Taking whichever arrives first
    // counts it exactly once — and reading only message_delta, as this did,
    // counted nothing at all on a first-party endpoint, where the delta
    // carries output_tokens and nothing else.
    const { agent } = await runChat([
        (w) => {
            w(start(0, { type: "text", text: "" }));
            w(textDelta(0, "hi"));
            w(stop(0));
            w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 999, output_tokens: 5 } });
        },
    ]);

    const usage = agent.getUsage();
    assert.equal(usage.input, 1, "the message_start count, not the echo");
    assert.equal(usage.output, 5);
    assert.equal(usage.cacheRead, 4);
    assert.equal(usage.cacheHitRate, 4 / 5);
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

// ── Mid-session reasoning controls ──────────────────────────

test("effort and thinking are adjustable mid-session and apply to the next request", async () => {
    const api = await fakeApi([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ]);
    // test-model is not a default-thinking model, so turn 1 is a plain request.
    const agent = new Agent({ model: "test-model", apiKey: "k", apiBase: api.url });

    try {
        await agent.chat("first");
        assert.equal(api.bodies[0].thinking, undefined);
        assert.equal(api.bodies[0].output_config, undefined);

        agent.setEffort("high"); // implies thinking on
        await agent.chat("second");
        assert.equal(api.bodies[1].thinking.type, "adaptive");
        assert.equal(api.bodies[1].output_config.effort, "high");

        agent.setThinking(false);
        await agent.chat("third");
        assert.equal(api.bodies[2].thinking, undefined);
        assert.equal(api.bodies[2].output_config.effort, "high");
    } finally {
        api.close();
    }
});

// ── Mid-session model switching ─────────────────────────────

test("setModel switches the model for the next request and can retarget the endpoint", async () => {
    const api = await fakeApi([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ]);
    const agent = new Agent({ model: "model-a", apiKey: "k", apiBase: api.url });

    try {
        await agent.chat("first");
        assert.equal(api.bodies[0].model, "model-a");

        agent.setModel({ model: "model-b" });
        await agent.chat("second");
        assert.equal(api.bodies[1].model, "model-b");
        // No endpoint override: the provider (and thus the URL) is untouched.
        assert.equal(api.requests, 2);

        // An endpoint override rebuilds the client — requests go to the new URL.
        agent.setModel({ model: "model-c", apiBase: "http://127.0.0.1:9" }); // nothing listens there
        await agent.chat("third").catch(() => {});
        assert.equal(api.requests, 2); // the third request never reached the first server
    } finally {
        api.close();
    }
});

test("the session status names the preset, not the model string", () => {
    // Two presets can serve one model through different endpoints, so the
    // model id alone does not say which route the session is on.
    const agent = new Agent({ model: "model-a", apiKey: "k", apiBase: "http://127.0.0.1:9" });

    agent.setModel({ model: "deepseek-flash", label: "deepseek-v4.1-flash-official" });
    assert.equal(agent.getSessionStatus().model, "deepseek-v4.1-flash-official");
    assert.equal(agent.getModel(), "deepseek-flash", "the request still carries the model id");

    // Switching by raw id has no preset to name, so the id is the label.
    agent.setModel({ model: "other-model" });
    assert.equal(agent.getSessionStatus().model, "other-model");

    // An endpoint-only retarget leaves the model alone, so it leaves the name
    // alone too — otherwise the footer would lose the route it is describing.
    agent.setModel({ model: "deepseek-flash", label: "deepseek-v4.1-flash-official" });
    agent.setModel({ apiBase: "http://127.0.0.1:8" });
    assert.equal(agent.getSessionStatus().model, "deepseek-v4.1-flash-official");

    // An explicit empty label is a caller saying "there is no preset name".
    agent.setModel({ model: "deepseek-flash", label: "" });
    assert.equal(agent.getSessionStatus().model, "deepseek-flash");
});

test("a bare model switch keeps an explicitly chosen auth scheme", async () => {
    const api = await fakeApi([
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "hi")); w(stop(0)); w(finish("end_turn")); },
    ]);
    // The gateway wants a bearer token; x-api-key would be rejected.
    const agent = new Agent({ model: "model-a", apiKey: "k", apiBase: api.url, auth: "bearer" });

    try {
        await agent.chat("first");
        assert.equal(api.headers[0].authorization, "Bearer k");
        assert.equal(api.headers[0]["x-api-key"], undefined);

        // A model-only switch does not rebuild the provider, so it must not
        // rewrite the scheme either — the next retarget would then rebuild the
        // provider with a scheme the session never actually used.
        agent.setModel({ model: "model-b" });
        agent.setModel({ apiBase: api.url });
        await agent.chat("second");
        assert.equal(api.headers[1].authorization, "Bearer k");
        assert.equal(api.bodies[1].model, "model-b");
    } finally {
        api.close();
    }
});

// ═══════════════════════════════════════════════════════════════
// Sub-agents — the agent tool, end to end
// ═══════════════════════════════════════════════════════════════
//
// Each case scripts the parent's request and the sub-agent's request against
// the same endpoint. The parent's request is index 0; the sub-agent's is the
// next one it makes, which is what the assertions on bodies[1] read.

/** The scripted turns for a delegation: parent calls agent, sub-agent answers, parent concludes. */
function delegation(
    agentInput: Record<string, any>,
    subAgentTurns: Turn[],
): Turn[] {
    return [
        (w) => {
            w(start(0, { type: "tool_use", id: "t1", name: "agent", input: {} }));
            w(jsonDelta(0, JSON.stringify(agentInput)));
            w(stop(0));
            w(finish("tool_use"));
        },
        ...subAgentTurns,
        (w) => { w(start(0, { type: "text", text: "" })); w(textDelta(0, "parent done")); w(stop(0)); w(finish("end_turn")); },
    ];
}

const subAgentAnswer = (text: string): Turn => (w) => {
    w(start(0, { type: "text", text: "" }));
    w(textDelta(0, text));
    w(stop(0));
    w(finish("end_turn"));
};

/** The text of every tool_result in the parent's history. */
function parentToolResults(agent: Agent): string[] {
    return agent.history()
        .flatMap((m) => Array.isArray(m.content) ? m.content : [])
        .filter((b: any) => b.type === "tool_result")
        .map((b: any) => String(b.content));
}

test("the parent receives the sub-agent's text, and none of its tool calls", async () => {
    const { agent, output } = await runChat(delegation(
        { description: "find the auth code", prompt: "Where is auth handled?", type: "explore" },
        [
            // The sub-agent's own tool use — read_file, and a search.
            (w) => {
                w(start(0, { type: "tool_use", id: "s1", name: "read_file", input: {} }));
                w(jsonDelta(0, '{"file_path":"src/agent.ts"}'));
                w(stop(0));
                w(finish("tool_use"));
            },
            subAgentAnswer("Auth is handled in src/auth.ts:42 and called from src/cli.ts:10."),
        ],
    ), { permissionMode: "default" });

    // The isolation is the whole point: the file body the sub-agent read is in
    // the sub-agent's history, not the parent's.
    const results = parentToolResults(agent);
    assert.equal(results.length, 1, "the parent got exactly one tool result");
    assert.match(results[0], /Auth is handled in src\/auth\.ts:42/);
    assert.doesNotMatch(results[0], /read_file/, "no nested tool call leaked into the parent");
    assert.doesNotMatch(JSON.stringify(agent.history()), /ReadFileState|You are TriumCode/);

    // And the UI says a delegation happened.
    assert.match(output, /Agent explore · find the auth code/);
    assert.match(output, /tokens\)/);
});

test("the parent's history holds the sub-agent's summary, not its transcript", async () => {
    const { agent } = await runChat(delegation(
        { description: "survey", prompt: "Survey the providers.", type: "explore" },
        [
            // The sub-agent reads a file, then answers.
            (w) => {
                w(start(0, { type: "tool_use", id: "s1", name: "read_file", input: {} }));
                w(jsonDelta(0, '{"file_path":"src/providers/index.ts"}'));
                w(stop(0));
                w(finish("tool_use"));
            },
            subAgentAnswer("There are three providers: anthropic, openai-chat, openai-responses."),
        ],
    ), { permissionMode: "default" });

    // Four turns, all the parent's: its request, its call, the result, its
    // reply. The sub-agent's read_file turn and the file body it pulled in are
    // not among them — that is the saving.
    assert.equal(agent.history().length, 4);

    const assistant = agent.history()[1].content as any[];
    assert.equal(assistant[0].name, "agent");
    assert.equal(assistant[0].input.type, "explore");

    const toolResult = (agent.history()[2].content as any[])[0];
    assert.match(String(toolResult.content), /three providers/);
});

test("a sub-agent's system prompt is its contract, not the parent's persona", async () => {
    const { api } = await runChat(delegation(
        { description: "recon", prompt: "Find the tool registry.", type: "explore" },
        [subAgentAnswer("It is in src/tools.ts.")],
    ), { permissionMode: "default" });

    const parentSystem = api.bodies[0].system[0].text;
    const subSystem = api.bodies[1].system[0].text;
    assert.match(parentSystem, /You are TriumCode/);
    assert.doesNotMatch(subSystem, /You are TriumCode/);
    assert.match(subSystem, /exploration sub-agent/);
    // The main agent's own model budget does not apply to a summary.
    assert.equal(api.bodies[0].max_tokens, 32_000);
    assert.equal(api.bodies[1].max_tokens, 4096);
});

test("an explore sub-agent is never offered a write tool", async () => {
    const { api } = await runChat(delegation(
        { description: "recon", prompt: "Read something.", type: "explore" },
        [subAgentAnswer("done")],
    ), { permissionMode: "default" });

    const subTools = api.bodies[1].tools.map((t: any) => t.name).sort();
    assert.deepEqual(subTools, ["grep_search", "list_files", "read_file"]);
    // The parent still has everything, minus nothing.
    const parentTools = api.bodies[0].tools.map((t: any) => t.name);
    assert.ok(parentTools.includes("write_file"));
    assert.ok(parentTools.includes("agent"));
});

test("plan mode is inherited, so a sub-agent cannot write around it", async () => {
    // The security property: a plan-mode session may delegate read-only work,
    // but the delegation must not become the way to write.
    const { api } = await runChat(delegation(
        { description: "recon", prompt: "Look around.", type: "explore" },
        [subAgentAnswer("nothing to report")],
    ), { permissionMode: "plan" });

    // The plan-mode parent could still delegate: the agent tool is read-only.
    assert.equal(api.requests, 3, "parent, sub-agent, parent");
    // And the sub-agent's own tool list has nothing that writes.
    assert.deepEqual(
        api.bodies[1].tools.map((t: any) => t.name).sort(),
        ["grep_search", "list_files", "read_file"],
    );
    // It is also told, rather than left to discover it from refused calls.
    assert.match(api.bodies[1].system[0].text, /strict plan mode/);
});

test("plan mode reaches a general sub-agent too, whose tools do write", async () => {
    // The case the inheritance actually protects: a general sub-agent has
    // write_file, and only the inherited mode stops it from being used.
    const { api } = await runChat(delegation(
        { description: "implement", prompt: "Change it.", type: "general" },
        [subAgentAnswer("changed nothing")],
    ), { permissionMode: "plan" });

    assert.ok(api.bodies[1].tools.some((t: any) => t.name === "write_file"));
    assert.match(api.bodies[1].system[0].text, /strict plan mode/);
});

test("a general sub-agent cannot delegate again", async () => {
    const { api } = await runChat(delegation(
        { description: "implement", prompt: "Do the change.", type: "general" },
        [subAgentAnswer("changed src/thing.ts")],
    ), { permissionMode: "default" });

    const subTools = api.bodies[1].tools.map((t: any) => t.name);
    assert.ok(!subTools.includes("agent"), "no recursion");
    assert.ok(subTools.includes("write_file"), "but it can write");
});

test("a failing sub-agent returns an error string and the parent keeps going", async () => {
    // The sub-agent's own request (index 1) is the one that fails.
    const { agent, output, error, api } = await runChat(delegation(
        { description: "doomed recon", prompt: "Look.", type: "explore" },
        [subAgentAnswer("unused")],
    ), { permissionMode: "default", failOn: new Set([1]) });

    assert.equal(error, null, "the parent must not throw");
    assert.match(output, /✗ explore · doomed recon/, output);
    assert.match(output, /scripted failure/, "the API's own message, not the raw body");

    const results = parentToolResults(agent);
    assert.match(results[0], /^Sub-agent error: /, "the model gets a string it can act on");
    assert.match(results[0], /scripted failure/);

    // The parent issued its follow-up request, so the loop carried on.
    assert.equal(api.requests, 3);
    const last = agent.history().filter((m) => m.role === "assistant").pop() as any;
    assert.match(JSON.stringify(last.content), /parent done/);
});

test("an unknown type falls back to general instead of failing", async () => {
    const { api } = await runChat(delegation(
        { description: "typo", prompt: "Do it.", type: "generall" },
        [subAgentAnswer("ok")],
    ), { permissionMode: "default" });

    const subTools = api.bodies[1].tools.map((t: any) => t.name);
    assert.ok(subTools.includes("write_file"), "served the general configuration");
    assert.ok(!subTools.includes("agent"));
});

test("a missing prompt is refused without spawning anything", async () => {
    const { output, api } = await runChat(delegation(
        { description: "empty", prompt: "", type: "explore" },
        [subAgentAnswer("unused")],
    ), { permissionMode: "default" });

    assert.match(output, /needs a prompt/);
    // Two requests: the parent's call and its follow-up. No sub-agent ran.
    assert.equal(api.requests, 2);
});

test("sub-agent tokens are added to the parent's total exactly once", async () => {
    // The fake endpoint reports input_tokens 1 and cache_read 4 per request,
    // and 5 output tokens per message_delta.
    const { agent } = await runChat(delegation(
        { description: "recon", prompt: "Look.", type: "explore" },
        [subAgentAnswer("done")],
    ), { permissionMode: "default" });

    // Three requests total: parent, sub-agent, parent. Each contributes its
    // own usage, and nothing is counted twice.
    const usage = agent.getUsage();
    assert.equal(usage.input, 3, "one prompt count per request, no echo");
    assert.equal(usage.output, 15, "5 output tokens per request");
    assert.equal(usage.cacheRead, 12, "4 cached prompt tokens per request");
    assert.equal(usage.cacheHitRate, 12 / 15);
});

test("the sub-agent's text is buffered, not streamed to the terminal", async () => {
    // streamed text bypasses console.log (see runChat), so a sub-agent that
    // printed would show up on the real stdout — and interleave two
    // conversations on one screen.
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => { chunks.push(String(chunk)); return true; };

    try {
        const { output } = await runChat(delegation(
            { description: "recon", prompt: "Look.", type: "explore" },
            [subAgentAnswer("SECRET SUB-AGENT NARRATION")],
        ), { permissionMode: "default" });

        assert.doesNotMatch(chunks.join(""), /SECRET SUB-AGENT NARRATION/, "sub-agent text must not reach stdout");
        // The parent's own reply still prints.
        assert.match(chunks.join(""), /parent done/);
        assert.match(output, /Agent explore/, "but the delegation itself is announced");
    } finally {
        (process.stdout as any).write = originalWrite;
    }
});

test("a sub-agent does not trigger the auto-save callback", async () => {
    const originalCwd = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "triumcode-agent-sub-")));
    const api = await fakeApi(delegation(
        { description: "recon", prompt: "Look.", type: "explore" },
        [subAgentAnswer("done")],
    ));

    let saves = 0;
    const agent = new Agent({
        model: "test-model", apiKey: "k", apiBase: api.url,
        permissionMode: "default", maxTurns: 5,
    });
    agent.setOnChatComplete(() => { saves++; });

    const originalLog = console.log;
    console.log = () => {};
    try {
        await agent.chat("delegate the thing");
    } finally {
        console.log = originalLog;
        api.close();
        process.chdir(originalCwd);
    }

    // The parent saves once; the sub-agent's own chat() must not save at all,
    // or it would file a delegated task as this project's session.
    assert.equal(saves, 1);
});
