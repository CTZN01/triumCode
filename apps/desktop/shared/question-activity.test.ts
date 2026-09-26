import assert from "node:assert/strict";
import { test } from "node:test";
import { updateQuestionActivity } from "./question-activity.js";

test("question activity survives a decision without persisting the answer text", () => {
    const started = updateQuestionActivity([], "request", "run", "Which file?", "2026-09-26T00:00:00.000Z");
    assert.equal(started[0].state, "running");
    const answered = updateQuestionActivity(started, "request", "run", undefined, "2026-09-26T00:00:01.000Z", "answered");
    assert.equal(answered.length, 1);
    assert.equal(answered[0].detail, "Which file?");
    assert.equal(answered[0].startedAt, started[0].startedAt);
    assert.equal(answered[0].output, "已回答");
});

test("skip, expiry, and cancellation remain distinct", () => {
    for (const [outcome, state, output] of [
        ["skipped", "notice", "已跳过"],
        ["expired", "interrupted", "等待超时"],
        ["cancelled", "interrupted", "任务已取消"],
    ] as const) {
        const activity = updateQuestionActivity([], "request", null, "Continue?", "2026-09-26T00:00:00.000Z", outcome)[0];
        assert.equal(activity.state, state);
        assert.equal(activity.output, output);
    }
});
