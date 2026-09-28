import assert from "node:assert/strict";
import { test } from "node:test";
import { RunSubmissions, SubmissionCancelledError } from "./run-submissions.js";

test("an interrupt waits for startup, deduplicates request IDs and rejects overlapping handoffs", async () => {
    const submissions = new RunSubmissions<string>();
    let ready!: () => void;
    const gate = new Promise<void>(done => { ready = done; });
    const order: string[] = [];
    const first = submissions.submit("session", "first", false, async () => { await gate; order.push("started"); return "old"; }, () => {});
    const next = submissions.submit("session", "next", true, async () => { order.push("handoff"); return "new"; }, () => {});
    assert.equal(submissions.submit("session", "next", true, async () => "duplicate", () => {}), next);
    assert.throws(() => submissions.submit("session", "third", true, async () => "third", () => {}), /等待/);
    await Promise.resolve();
    assert.deepEqual(order, []);
    ready();
    assert.equal(await first, "old");
    assert.equal(await next, "new");
    assert.deepEqual(order, ["started", "handoff"]);
});

test("stop and shutdown cancel pending follow-ups without blocking other sessions", async () => {
    const submissions = new RunSubmissions<string>();
    let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; });
    let cancelled = 0;
    const first = submissions.submit("session", "first", false, async () => { await gate; return "old"; }, () => { cancelled++; });
    const next = submissions.submit("session", "next", true, async () => "must not start", () => { cancelled++; });
    const rejection = assert.rejects(next, SubmissionCancelledError);
    assert(submissions.cancel("next"));
    assert.equal(await submissions.submit("other", "other", false, async () => "independent", () => {}), "independent");
    submissions.cancelAll();
    finish();
    await first;
    await rejection;
    assert.equal(cancelled, 2);
    assert.equal(submissions.cancel("missing"), false);
});
