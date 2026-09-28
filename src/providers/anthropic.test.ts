import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicProvider } from "./anthropic.js";

test("Anthropic abort cancels idle streams and pending side requests without sending signal in JSON", { timeout: 5000 }, async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"test","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    assert(address && typeof address !== "string");
    const provider = new AnthropicProvider({ apiBase: `http://127.0.0.1:${address.port}`, apiKey: "test-key", auth: "api-key" });
    const controller = new AbortController();
    const sideController = new AbortController();
    try {
        const stream = await provider.stream({ model: "m", maxTokens: 100, system: [], messages: [{ role: "user", content: "start" }], tools: [], thinkingMode: "disabled", effort: null }, controller.signal);
        const iterator = stream[Symbol.asyncIterator]();
        assert.equal((await iterator.next()).done, false);
        const pending = iterator.next();
        controller.abort();
        assert.equal((await pending).done, true);
        const side = provider.completeText({ model: "m", maxTokens: 100, system: "test", user: "recall" }, sideController.signal);
        while (bodies.length < 2) await new Promise(done => setTimeout(done, 10));
        sideController.abort();
        await assert.rejects(side, /abort/i);
        assert(bodies.every(body => !("signal" in body)));
    } finally {
        controller.abort(); sideController.abort();
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
    }
});
