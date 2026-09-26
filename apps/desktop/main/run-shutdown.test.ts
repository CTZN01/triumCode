import assert from "node:assert/strict";
import { test } from "node:test";
import { RunShutdown } from "./run-shutdown.js";

test("shutdown waits for a run that is still preparing and then for its execution", async () => {
    const lifecycle = new RunShutdown();
    let finishPreparation!: () => void;
    let finishRun!: () => void;
    const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
    const run = new Promise<void>((resolve) => { finishRun = resolve; });
    let cancelled = false;
    let started = false;
    let stopped = false;
    const start = lifecycle.trackStart(async () => {
        await preparation;
        if (!cancelled) started = true;
    }, () => new Error("stopping"));
    const shutdown = lifecycle.stopAll(() => { cancelled = true; }, () => [run]);
    void shutdown.then(() => { stopped = true; });
    assert.throws(() => lifecycle.trackStart(async () => undefined, () => new Error("stopping")), /stopping/);
    finishPreparation();
    await start;
    await Promise.resolve();
    assert.equal(started, false);
    assert.equal(stopped, false);
    finishRun();
    await shutdown;
    assert.equal(stopped, true);
    await lifecycle.trackStart(async () => undefined, () => new Error("stopping"));
});
