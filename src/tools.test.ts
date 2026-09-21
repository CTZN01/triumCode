import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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

// ─── edit_file / multi_edit ──────────────────────────────────
//
// Every edit that misses costs a round trip: the model re-reads the file,
// re-derives its anchor, and re-sends the whole conversation prefix. These
// tests pin the two things that stop that — the tool hands back the region it
// changed, and a miss comes back with the real lines quoted.

test("edit_file returns the edited region, numbered like read_file", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("echo.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const result = await tool.call({ file_path: path, old_string: "const b = 2;", new_string: "const b = 22;" }, {});

    assert.match(result, /^Edited .* at line 2 \(\+1\/-1 lines\)/);
    // Context on both sides, so the next anchor can be quoted from the result
    // instead of from a second read.
    assert.match(result, /^\s*1 \| const a = 1;$/m);
    assert.match(result, /^\s*2 \| const b = 22;$/m);
    assert.match(result, /^\s*3 \| const c = 3;$/m);
});

test("edit_file quotes the closest real lines when old_string is missing", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("miss.ts", "function alpha() {\n    return 1;\n}\n");

    const result = await tool.call({
        file_path: path,
        old_string: "function alpha() {\n    return 2;\n}",
        new_string: "function alpha() {\n    return 3;\n}",
    }, {});

    assert.match(result, /Error: old_string not found/);
    assert.match(result, /closest match is at lines 1-3/);
    // The point of the diagnostic: these are the file's actual bytes, so the
    // retry is a copy rather than another guess.
    assert.match(result, /1 \| function alpha\(\) \{/);
    assert.match(result, /2 \|     return 1;/);
});

test("edit_file matches past invisible trailing whitespace and says so", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("trail.ts", "const a = 1;   \nconst b = 2;\n");

    const result = await tool.call({
        file_path: path,
        old_string: "const a = 1;\nconst b = 2;",
        new_string: "const a = 11;\nconst b = 22;",
    }, {});

    assert.doesNotMatch(result, /^Error/);
    assert.match(result, /Note: matched ignoring trailing whitespace/);
    assert.equal(readFileSync(path, "utf-8"), "const a = 11;\nconst b = 22;\n");
});

test("edit_file reports an indentation mismatch without rewriting the file", async () => {
    const tool = getTool("edit_file")!;
    const original = "function f() {\n\treturn 1;\n}\n";
    const path = tempFile("indent.ts", original);

    const result = await tool.call({
        file_path: path,
        old_string: "function f() {\n    return 1;\n}",
        new_string: "function f() {\n    return 2;\n}",
    }, {});

    assert.match(result, /ignoring indentation/);
    assert.match(result, /2 \| \treturn 1;/);
    // Deliberately not applied: re-indenting the replacement would change code
    // the model did not ask to change.
    assert.equal(readFileSync(path, "utf-8"), original);
});

test("edit_file replace_all changes every occurrence", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("many.ts", "a\nb\na\nb\n");

    const result = await tool.call({ file_path: path, old_string: "a", new_string: "z", replace_all: true }, {});

    assert.match(result, /Edited 2 occurrences/);
    assert.equal(readFileSync(path, "utf-8"), "z\nb\nz\nb\n");
});

test("edit_file replace_all reports the full occurrence count", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("many-more.ts", `${"a\n".repeat(205)}`);

    const result = await tool.call({ file_path: path, old_string: "a", new_string: "z", replace_all: true }, {});

    assert.match(result, /Edited 205 occurrences/);
    assert.equal(readFileSync(path, "utf-8"), "z\n".repeat(205));
});

test("edit_file refuses an ambiguous anchor and offers replace_all", async () => {
    const tool = getTool("edit_file")!;
    const path = tempFile("dup.ts", "a\nb\na\n");

    const result = await tool.call({ file_path: path, old_string: "a", new_string: "z" }, {});

    assert.match(result, /occurs 2 times/);
    assert.match(result, /lines 1, 3/);
    assert.match(result, /replace_all: true/);
});

test("multi_edit applies several edits to one file in one call", async () => {
    const tool = getTool("multi_edit")!;
    const path = tempFile("batch.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const result = await tool.call({
        file_path: path,
        edits: [
            { old_string: "const a = 1;", new_string: "const a = 10;" },
            { old_string: "const c = 3;", new_string: "const c = 30;" },
        ],
    }, {});

    assert.match(result, /Edited 2 regions/);
    assert.equal(readFileSync(path, "utf-8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n");
    assert.match(result, /1 \| const a = 10;/);
    assert.match(result, /3 \| const c = 30;/);
});

test("multi_edit keeps returned regions correct when edits are out of order", async () => {
    const tool = getTool("multi_edit")!;
    const path = tempFile("reverse.ts", "a\nb\nc\n");

    const result = await tool.call({
        file_path: path,
        edits: [
            { old_string: "c", new_string: "c\nnew-c" },
            { old_string: "a", new_string: "a\nnew-a" },
        ],
    }, {});

    assert.match(result, /4 \| c$/m);
    assert.match(result, /5 \| new-c$/m);
    assert.match(result, /1 \| a$/m);
    assert.match(result, /2 \| new-a$/m);
    assert.equal(readFileSync(path, "utf-8"), "a\nnew-a\nb\nc\nnew-c\n");
});

test("multi_edit writes nothing when one edit in the batch fails", async () => {
    const tool = getTool("multi_edit")!;
    const original = "const a = 1;\nconst b = 2;\n";
    const path = tempFile("atomic.ts", original);

    const result = await tool.call({
        file_path: path,
        edits: [
            { old_string: "const a = 1;", new_string: "const a = 10;" },
            { old_string: "not in the file", new_string: "nope" },
        ],
    }, {});

    assert.match(result, /edit 2 of 2 failed/);
    assert.match(result, /whole batch was discarded/);
    assert.equal(readFileSync(path, "utf-8"), original);
});

test("multi_edit rejects an empty batch", async () => {
    const tool = getTool("multi_edit")!;
    const result = await tool.call({ file_path: tempFile("empty.ts", "a\n"), edits: [] }, {});
    assert.match(result, /non-empty array/);
});