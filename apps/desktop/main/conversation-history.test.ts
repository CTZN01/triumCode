import assert from "node:assert/strict";
import { test } from "node:test";
import { findRunMessageIndex, pageConversationMessages } from "./conversation-history.js";

test("conversation pages keep stable history ids across hidden tool messages", () => {
    const history = [
        { role: "user", content: "first" },
        { role: "tool", content: "hidden" },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
        { role: "user", content: "third" },
        { role: "assistant", content: "fourth" },
    ];
    const latest = pageConversationMessages(history, history.length, (text) => text, 2);
    assert.deepEqual(latest.messages.map(({ id, text }) => [id, text]), [
        ["history-3", "third"], ["history-4", "fourth"],
    ]);
    assert.equal(latest.nextCursor, 3);
    const older = pageConversationMessages(history, latest.nextCursor!, (text) => text, 2);
    assert.deepEqual(older.messages.map(({ id, text }) => [id, text]), [
        ["history-0", "first"], ["history-2", "second"],
    ]);
    assert.equal(older.nextCursor, null);
});

test("conversation page redacts text and removes hidden reminders", () => {
    const history = [
        { role: "user", content: "hello<system-reminder>secret</system-reminder> there" },
        { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "key=value" }] },
    ];
    const page = pageConversationMessages(history, 2, (text) => text.replace("value", "[REDACTED]"));
    assert.deepEqual(page.messages.map(({ text }) => text), ["hello  there", "key=[REDACTED]"]);
    assert.equal(page.nextCursor, null);
});

test("conversation pages attach activity runs to the matching user message", () => {
    const history = [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
    ];
    const anchors = new Map([[0, ["run-1", "retry-1"]], [2, ["run-2"]]]);
    const page = pageConversationMessages(history, history.length, (text) => text, 3, anchors);
    assert.deepEqual(page.messages.map(({ runIds }) => runIds ?? []), [
        ["run-1", "retry-1"], [], ["run-2"],
    ]);
});

test("new runs and safe retries anchor to the visible user request", () => {
    const history = [
        { role: "user", content: "request" },
        { role: "assistant", content: "partial reply" },
        { role: "user", content: "<system-reminder>hidden context</system-reminder>" },
    ];
    assert.equal(findRunMessageIndex(history, false), 3);
    assert.equal(findRunMessageIndex(history, true), 0);
});

test("opening a long conversation projects only the latest page", () => {
    const history = Array.from({ length: 10_000 }, (_, index) => ({ role: "user", content: String(index) }));
    let projected = 0;
    const page = pageConversationMessages(history, history.length, (text) => {
        projected++;
        return text;
    });
    assert.equal(page.messages.length, 40);
    assert.equal(page.messages[0].id, "history-9960");
    assert.equal(page.nextCursor, 9960);
    assert.equal(projected, 41);
});
