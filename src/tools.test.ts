import { test } from "node:test";
import assert from "node:assert/strict";
import { getTool, type TodoItem, type ToolContext } from "./tools.js";

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