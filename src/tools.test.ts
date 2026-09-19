import { test } from "node:test";
import assert from "node:assert/strict";
import { getTool } from "./tools.js";

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