import { test } from "node:test";
import assert from "node:assert/strict";
import {
    compressHistory, persistLargeResult, prepareToolResult, truncateResult,
    withCacheBreakpoints,
} from "./context-compression.js";

const tool = (id: string, name: string, input: Record<string, unknown>) => ({
    role: "assistant" as const,
    content: [{ type: "tool_use", id, name, input }],
});

const result = (id: string, content: string) => ({
    role: "user" as const,
    content: [{ type: "tool_result", tool_use_id: id, content }],
});

test("large results persist before head-tail truncation", () => {
    const value = "a".repeat(60_000);
    const prepared = prepareToolResult(value, 123);
    assert.match(prepared, /full tool result saved to/);
    assert.ok(prepared.length <= 50_000);
    assert.match(truncateResult(value), /result truncated/);
    assert.match(persistLargeResult(value, 123), /123-/);
});

test("cache breakpoints do not mutate the original history", () => {
    const messages = [result("r1", "old")] as any;
    const system = [{ type: "text" as const, text: "static" }];
    const next = withCacheBreakpoints(messages, system);
    assert.equal((messages[0].content as any[])[0].cache_control, undefined);
    assert.equal((next.messages[0].content as any[])[0].cache_control.type, "ephemeral");
    assert.equal(next.system[0].cache_control?.type, "ephemeral");
});

test("the tool-output budget is spent on the newest results", () => {
    // The budget used to be spent from the oldest forward, so it ran out
    // partway and clipped everything after that point — including the file the
    // model had just read, which it then read again. Re-reading costs far more
    // than the characters the clip saved.
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
        messages.push(tool(`t${i}`, "read_file", { file_path: `f${i}.ts` }));
        messages.push(result(`t${i}`, `RESULT-${i} ` + "x".repeat(20_000)));
    }

    const compressed = compressHistory(messages, { contextWindow: 100_000, cacheHot: true });
    const contents = compressed.messages
        .flatMap((message: any) => message.content ?? [])
        .filter((block: any) => block.type === "tool_result")
        .map((block: any) => String(block.content));

    const newest = contents[contents.length - 1];
    assert.ok(newest.length > 20_000, `newest result was clipped to ${newest.length}`);
    assert.match(newest, /RESULT-9/);

    assert.ok(contents[0].length < 2_000, `oldest result was not clipped: ${contents[0].length}`);
    assert.match(contents[0], /tool result budgeted/);
});

test("a history below the budget trigger comes back byte-identical", () => {
    // Every rewrite of an earlier block invalidates the cache from that point
    // on, so compression has to leave a small conversation alone. This is what
    // the high-water mark buys: nothing moves between crossings.
    const messages: any[] = [
        tool("u1", "read_file", { file_path: "a.ts" }), result("u1", "x".repeat(20_000)),
        tool("u2", "read_file", { file_path: "b.ts" }), result("u2", "y".repeat(20_000)),
    ];
    const before = JSON.stringify(messages);
    const compressed = compressHistory(messages, { contextWindow: 200_000, cacheHot: true });
    assert.equal(JSON.stringify(compressed.messages), before);
});

test("compression preserves the latest three tool results and snips stale reads", () => {
    const messages = [
        tool("u1", "read_file", { file_path: "a.ts" }), result("u1", "old file"),
        tool("u2", "read_file", { file_path: "a.ts" }), result("u2", "new file"),
        tool("u3", "grep_search", { query: "x" }), result("u3", "search 1"),
        tool("u4", "grep_search", { query: "x" }), result("u4", "search 2"),
        tool("u5", "grep_search", { query: "x" }), result("u5", "search 3"),
        tool("u6", "grep_search", { query: "x" }), result("u6", "search 4"),
    ] as any;
    const compressed = compressHistory(messages, { contextWindow: 20_001, cacheHot: false });
    const contents = compressed.messages.flatMap((message: any) => message.content ?? [])
        .filter((block: any) => block.type === "tool_result").map((block: any) => String(block.content));
    assert.match(contents[0], /older read_file result snipped/);
    assert.match(contents[contents.length - 1], /search 4/);
});