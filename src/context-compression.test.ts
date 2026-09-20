import { test } from "node:test";
import assert from "node:assert/strict";
import {
    compressHistory, prepareToolResult, truncateResult,
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

test("a result over the tool's limit is truncated, with the full text kept on disk", () => {
    const value = "a".repeat(60_000);
    const prepared = prepareToolResult(value, 50_000, 123);
    assert.match(prepared, /full result saved to/);
    // The body is exactly the limit; only the one-line pointer sits on top.
    assert.ok(prepared.length <= 50_100, `kept ${prepared.length}`);
    assert.match(truncateResult(value), /result truncated/);
});

test("a result within the tool's limit passes through untouched", () => {
    // The per-tool limit is what stops a 30 KB read of a source file from
    // arriving as a 2 KB preview of a file the model then cannot see at all.
    const value = "a".repeat(40_000);
    assert.equal(prepareToolResult(value, 100_000), value);
});

test("compression reports the reads it evicted", () => {
    // read_file answers a repeat read with a notice instead of the content,
    // which is only honest while that content is still in the conversation.
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
        messages.push(tool(`t${i}`, "read_file", { file_path: `f${i}.ts` }));
        messages.push(result(`t${i}`, `RESULT-${i} ` + "x".repeat(20_000)));
    }

    const compressed = compressHistory(messages, { contextWindow: 100_000, cacheHot: true });
    assert.ok(!compressed.stats.evictedReadPaths.has("f9.ts"), "the newest read survived, so it is not evicted");
    assert.ok(compressed.stats.evictedReadPaths.has("f0.ts"), "the clipped read must be reported");
});

test("nothing is reported as evicted when compression changes nothing", () => {
    const messages: any[] = [
        tool("u1", "read_file", { file_path: "a.ts" }), result("u1", "small"),
    ];
    const compressed = compressHistory(messages, { contextWindow: 200_000, cacheHot: true });
    assert.equal(compressed.stats.evictedReadPaths.size, 0);
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

// Three trailing search results, so the reads before them fall outside the
// "keep the last three" window and are candidates for snipping.
const trailingSearches = () => [
    tool("s1", "grep_search", { query: "x" }), result("s1", "search 1"),
    tool("s2", "grep_search", { query: "x" }), result("s2", "search 2"),
    tool("s3", "grep_search", { query: "x" }), result("s3", "search 3"),
];

const toolResultTexts = (compressed: { messages: any[] }) => compressed.messages
    .flatMap((message: any) => message.content ?? [])
    .filter((block: any) => block.type === "tool_result")
    .map((block: any) => String(block.content));

test("a later full read supersedes an earlier one", () => {
    const compressed = compressHistory([
        tool("u1", "read_file", { file_path: "a.ts" }), result("u1", "OLD CONTENT"),
        tool("u2", "read_file", { file_path: "a.ts" }), result("u2", "NEW CONTENT"),
        ...trailingSearches(),
    ] as any, { contextWindow: 20_001, cacheHot: false });

    const texts = toolResultTexts(compressed);
    assert.match(texts[0], /older read_file result snipped/);
    assert.doesNotMatch(texts[1], /snipped/, "the read that superseded it stays whole");
});

test("paging through one file does not snipe the earlier pages", () => {
    // Superseding used to key on the file alone, which held while every read
    // returned the whole file. With offset/limit the model pages through a long
    // file, and page two says nothing about whether page one is still needed —
    // snipping it would delete half the file from the conversation.
    const compressed = compressHistory([
        tool("u1", "read_file", { file_path: "big.ts", offset: 1, limit: 1000 }), result("u1", "FIRST PAGE"),
        tool("u2", "read_file", { file_path: "big.ts", offset: 1001, limit: 1000 }), result("u2", "SECOND PAGE"),
        ...trailingSearches(),
    ] as any, { contextWindow: 20_001, cacheHot: false });

    const texts = toolResultTexts(compressed);
    assert.doesNotMatch(texts[0], /snipped/);
    assert.doesNotMatch(texts[1], /snipped/);
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