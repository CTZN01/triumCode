import assert from "node:assert/strict";
import { test } from "node:test";
import { pruneIdleRuntimes } from "./runtime-cache.js";

test("runtime cache evicts oldest idle entries while retaining visible and running sessions", () => {
    const runtimes = new Map([
        ["old", { running: false }],
        ["visible", { running: false }],
        ["active", { running: true }],
        ["recent", { running: false }],
    ]);
    pruneIdleRuntimes(runtimes, 2, "visible", (runtime) => runtime.running);
    assert.deepEqual([...runtimes.keys()], ["visible", "active", "recent"]);
    runtimes.get("active")!.running = false;
    pruneIdleRuntimes(runtimes, 2, "visible", (runtime) => runtime.running);
    assert.deepEqual([...runtimes.keys()], ["visible", "recent"]);
});

test("runtime cache keeps all running sessions above the idle limit", () => {
    const runtimes = new Map([
        ["one", { running: true }],
        ["two", { running: true }],
        ["three", { running: false }],
    ]);
    pruneIdleRuntimes(runtimes, 0, null, (runtime) => runtime.running);
    assert.deepEqual([...runtimes.keys()], ["one", "two"]);
});
