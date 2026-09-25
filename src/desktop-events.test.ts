import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopEventSequencer, DesktopRunEventTracker } from "./desktop-events.js";

test("per-session event sequence continues independently of runtime instances", () => {
    const sequences = new DesktopEventSequencer();

    assert.equal(sequences.next("workspace:session-a"), 1);
    assert.equal(sequences.next("workspace:session-b"), 1);
    assert.equal(sequences.next("workspace:session-a"), 2);
    assert.equal(sequences.current("workspace:session-a"), 2);
});

test("opening a session advances the cursor past already queued events", () => {
    const tracker = new DesktopRunEventTracker();
    tracker.openSession("workspace:session", 10, null);

    assert.equal(tracker.accepts("workspace:session", 9, "old-run", "event"), false);
    assert.equal(tracker.accepts("workspace:session", 10, "old-run", "event"), false);
    assert.equal(tracker.accepts("workspace:session", 11, null, "event"), true);
});

test("finished run events cannot change a later run", () => {
    const tracker = new DesktopRunEventTracker();
    const session = "workspace:session";

    assert.equal(tracker.accepts(session, 1, "run-a", "start"), true);
    assert.equal(tracker.accepts(session, 2, "run-a", "event"), true);
    assert.equal(tracker.accepts(session, 3, "run-a", "finish"), true);
    assert.equal(tracker.accepts(session, 4, "run-a", "event"), false);
    assert.equal(tracker.accepts(session, 5, "run-b", "start"), true);
    assert.equal(tracker.accepts(session, 6, "run-a", "finish"), false);
    assert.equal(tracker.accepts(session, 7, "run-b", "event"), true);
});

test("a run restored from an open session rejects events from a different run", () => {
    const tracker = new DesktopRunEventTracker();
    tracker.openSession("workspace:session", 20, "run-b");

    assert.equal(tracker.accepts("workspace:session", 21, "run-a", "event"), false);
    assert.equal(tracker.accepts("workspace:session", 22, "run-b", "event"), true);
    assert.equal(tracker.accepts("workspace:session", 23, "run-c", "start"), true);
    assert.equal(tracker.accepts("workspace:session", 24, "run-b", "event"), false);
});

test("session deletion clears run IDs and event sequence", () => {
    const tracker = new DesktopRunEventTracker();
    const session = "workspace:session";
    tracker.openSession(session, 20, "run-a");
    tracker.delete(session);

    assert.equal(tracker.accepts(session, 1, "run-b", "start"), true);
    assert.equal(tracker.isFinished(session, "run-a"), false);
});
