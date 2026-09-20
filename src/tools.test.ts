import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool, toolResultLimit, type ReadFileState, type TodoItem, type ToolContext } from "./tools.js";

// ─── read_file ─────────────────────────────────────────────
//
// The read path carries three jobs at once: page through a file the model
// cannot hold whole, keep the read-before-write guard honest, and avoid paying
// twice for content the model already has.

/** A fresh file in a fresh directory, so tests cannot see each other's state. */
function tempFile(name: string, content: string | Buffer): string {
    const dir = mkdtempSync(join(tmpdir(), "triumcode-read-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

const numberedLines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

test("read_file pages through a long file with offset and limit", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("long.txt", numberedLines(250));

    const first = await tool.call({ file_path: path, offset: 1, limit: 100 }, {});
    assert.match(first, /^\s*1 \| line 1$/m);
    assert.match(first, /\s*100 \| line 100$/m);
    assert.doesNotMatch(first, /line 101/);
    // The footer is the affordance: without it the model has no way to know
    // the file continued.
    assert.match(first, /\[lines 1-100 of 250\. Continue with offset=101\.\]/);

    const second = await tool.call({ file_path: path, offset: 101, limit: 100 }, {});
    assert.match(second, /\s*101 \| line 101$/m);
    assert.match(second, /\[lines 101-200 of 250\. Continue with offset=201\.\]/);
});

test("read_file stops at the end of the file without a continuation footer", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("tail.txt", numberedLines(30));
    const result = await tool.call({ file_path: path, offset: 20 }, {});
    assert.match(result, /\s*30 \| line 30$/m);
    assert.doesNotMatch(result, /Continue with offset/);
});

test("read_file refuses an offset past the end instead of returning nothing", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("short.txt", numberedLines(3));
    const result = await tool.call({ file_path: path, offset: 99 }, {});
    assert.match(result, /offset 99 is past the end/);
    assert.match(result, /3 lines/);
});

test("read_file falls back to sane bounds when offset or limit is not a number", async () => {
    // The schema is not enforced by the API, so a model that sends a string
    // reaches the line maths. A NaN there renders as "NaN | line" throughout.
    const tool = getTool("read_file")!;
    const path = tempFile("odd.txt", numberedLines(10));

    const result = await tool.call({ file_path: path, offset: "second" as any, limit: null as any }, {});
    assert.match(result, /^\s*1 \| line 1$/m);
    assert.doesNotMatch(result, /NaN/);

    const zero = await tool.call({ file_path: path, offset: 0, limit: 0 }, {});
    assert.match(zero, /^\s*1 \| line 1$/m);
});

test("read_file refuses a binary file rather than flooding the context", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("blob.bin", Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]));
    const result = await tool.call({ file_path: path }, {});
    assert.match(result, /is a binary file/);
});

test("re-reading an unchanged range returns a notice, not the content again", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("again.txt", "alpha\nbeta\ngamma");
    const state: ReadFileState = new Map();

    const first = await tool.call({ file_path: path }, { readFileState: state });
    assert.match(first, /alpha/);

    const second = await tool.call({ file_path: path }, { readFileState: state });
    assert.doesNotMatch(second, /alpha/, "the same content must not be sent twice");
    assert.match(second, /unchanged since you read lines 1-3/);
});

test("reading a different range of an unchanged file returns the content", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("ranged.txt", numberedLines(20));
    const state: ReadFileState = new Map();

    await tool.call({ file_path: path, offset: 1, limit: 5 }, { readFileState: state });
    const other = await tool.call({ file_path: path, offset: 10, limit: 5 }, { readFileState: state });
    assert.match(other, /\s*10 \| line 10$/m);
});

test("a file changed under the model is read again, not short-circuited", async () => {
    const tool = getTool("read_file")!;
    const path = tempFile("mutable.txt", "alpha\nbeta");
    const state: ReadFileState = new Map();
    await tool.call({ file_path: path }, { readFileState: state });

    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(path, "alpha\nbeta\ngamma\ndelta", "utf8");

    const again = await tool.call({ file_path: path }, { readFileState: state });
    assert.match(again, /gamma/, "changed content must be returned");
});

test("a write invalidates what was shown, so the next read returns content", async () => {
    const tool = getTool("read_file")!;
    const write = getTool("write_file")!;
    const path = tempFile("written.txt", "alpha\nbeta");
    const state: ReadFileState = new Map();

    await tool.call({ file_path: path }, { readFileState: state });
    await write.call({ file_path: path, content: "one\ntwo" }, { readFileState: state });

    // The model wrote this content itself, but the file on disk changed under
    // the earlier read, so the earlier range no longer describes it.
    const after = await tool.call({ file_path: path }, { readFileState: state });
    assert.match(after, /one/);
    assert.doesNotMatch(after, /unchanged since/);
});

test("each tool's declared result limit is the one that applies", () => {
    // The field was declared on every tool and read by nothing, so every
    // result was clipped by one shared threshold instead.
    assert.equal(toolResultLimit("read_file"), 100_000);
    assert.equal(toolResultLimit("run_command"), 30_000);
    assert.equal(toolResultLimit("write_file"), 2_000);
    assert.equal(toolResultLimit("no_such_tool"), 50_000, "unknown tools fall back");
});

test("git_diff is registered as a read-only tool", () => {
    const tool = getTool("git_diff");

    assert.ok(tool);
    assert.equal(tool.isReadOnly({}), true);
    assert.equal(tool.isDestructive({}), false);
    assert.equal(tool.isConcurrencySafe({}), true);
    assert.deepEqual(tool.inputSchema.required, []);
});

test("git_diff returns a result for a repository path", async () => {
    const tool = getTool("git_diff");
    assert.ok(tool);

    const result = await tool.call({ cwd: process.cwd(), path: "src/tools.ts" }, {});
    assert.doesNotMatch(result, /^Error: git executable not found/);
    assert.doesNotMatch(result, /^Error running git diff: not a git repository/);
});

test("git_diff reports an invalid working directory cleanly", async () => {
    const tool = getTool("git_diff");
    assert.ok(tool);

    const result = await tool.call({ cwd: "this-directory-does-not-exist" }, {});
    assert.match(result, /working directory does not exist/);
});

// ─── todo tool ─────────────────────────────────────────────

test("todo is registered with correct properties", () => {
    const tool = getTool("todo");
    assert.ok(tool);
    assert.equal(tool.isReadOnly({}), true);
    assert.equal(tool.isDestructive({}), false);
    assert.equal(tool.isConcurrencySafe({}), false);
    assert.deepEqual(tool.inputSchema.required, ["operation"]);
});

test("todo read returns empty list by default", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };
    const result = await tool.call({ operation: "read" }, ctx);
    assert.equal(result, "No todos.");
});

test("todo write creates a list and read returns it", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };

    const writeResult = await tool.call({
        operation: "write",
        todos: [
            { id: 1, content: "Task A", status: "pending" },
            { id: 2, content: "Task B", status: "in_progress" },
            { id: 3, content: "Task C", status: "completed" },
        ],
    }, ctx);

    assert.match(writeResult, /⬜ \[1\] Task A/);
    assert.match(writeResult, /🔄 \[2\] Task B/);
    assert.match(writeResult, /✅ \[3\] Task C/);
    assert.match(writeResult, /Total: 3 \| Completed: 1\/3/);

    const readResult = await tool.call({ operation: "read" }, ctx);
    assert.equal(readResult, writeResult);
    assert.equal(ctx.todos!.length, 3);
});

test("todo write replaces entire list", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };

    await tool.call({
        operation: "write",
        todos: [{ id: 1, content: "Old task", status: "completed" }],
    }, ctx);

    await tool.call({
        operation: "write",
        todos: [
            { id: 1, content: "New task A", status: "pending" },
            { id: 2, content: "New task B", status: "pending" },
        ],
    }, ctx);

    const readResult = await tool.call({ operation: "read" }, ctx);
    assert.match(readResult, /New task A/);
    assert.doesNotMatch(readResult, /Old task/);
    assert.match(readResult, /Total: 2 \| Completed: 0\/2/);
});

test("todo write requires todos array", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };

    const result = await tool.call({ operation: "write" }, ctx);
    assert.match(result, /Error: 'todos' array is required/);
});

test("todo returns error for unknown operation", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };

    const result = await tool.call({ operation: "delete" }, ctx);
    assert.match(result, /Error: unknown operation/);
});

test("todo normalizes invalid status to pending", async () => {
    const tool = getTool("todo");
    assert.ok(tool);
    const ctx: ToolContext = { todos: [] };

    await tool.call({
        operation: "write",
        todos: [{ id: 1, content: "Task", status: "invalid" }],
    }, ctx);

    assert.equal(ctx.todos![0].status, "pending");
});