import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopTaskStatus } from "./task-status.js";

test("running tasks expose the user decision they are waiting for", () => {
    assert.equal(desktopTaskStatus("running", true, true), "waiting-approval");
    assert.equal(desktopTaskStatus("running", false, true), "waiting-user");
    assert.equal(desktopTaskStatus("running", false, false), "running");
});

test("terminal session states remain distinct in the task center", () => {
    assert.equal(desktopTaskStatus("idle", false, false), "completed");
    assert.equal(desktopTaskStatus("cancelled", false, false), "cancelled");
    assert.equal(desktopTaskStatus("failed", false, false), "failed");
    assert.equal(desktopTaskStatus("interrupted", false, false), "interrupted");
});
