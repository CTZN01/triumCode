import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLine, groupConversationActivities, type PlacedActivity } from "./conversation-activity.js";

const activity = (id: string, extra: Partial<PlacedActivity> = {}): PlacedActivity => ({
    id, title: "read_file", detail: "{}", state: "complete", ...extra,
});

test("live activity follows the assistant progress message that preceded it", () => {
    const messages = [
        { id: "user-1", role: "user" as const, text: "fix it", runIds: ["run-1"] },
        { id: "assistant-run-1-0", role: "assistant" as const, text: "I will inspect the layout." },
        { id: "assistant-run-1-1", role: "assistant" as const, text: "I found the cause." },
    ];
    const result = groupConversationActivities(messages, [
        activity("read", { runId: "run-1", afterMessageId: "assistant-run-1-0" }),
        activity("edit", { runId: "run-1", afterMessageId: "assistant-run-1-1" }),
    ]);
    assert.deepEqual([...result].map(([id, rows]) => [id, rows.map((row) => row.id)]), [
        ["assistant-run-1-0", ["read"]], ["assistant-run-1-1", ["edit"]],
    ]);
});

test("saved activity follows its assistant history entry and hidden tool-only replies fall back to visible progress", () => {
    const messages = [
        { id: "history-4", role: "user" as const, text: "fix it", runIds: ["run-1"] },
        { id: "history-5", role: "assistant" as const, text: "I will inspect it." },
        { id: "history-8", role: "assistant" as const, text: "Here is the result." },
    ];
    const result = groupConversationActivities(messages, [
        activity("read", { runId: "run-1", messageIndex: 4, afterMessageIndex: 5 }),
        activity("search", { runId: "run-1", messageIndex: 4, afterMessageIndex: 7 }),
    ]);
    assert.deepEqual(result.get("history-5")?.map((row) => row.id), ["read", "search"]);
    assert.equal(result.has("history-8"), false);
});

test("a tool-only live segment stays beside the preceding visible progress", () => {
    const messages = [
        { id: "user-1", role: "user" as const, text: "fix it", runIds: ["run-1"] },
        { id: "assistant-run-1-0", role: "assistant" as const, text: "I am checking the files." },
        { id: "assistant-run-1-2", role: "assistant" as const, text: "Done." },
    ];
    const result = groupConversationActivities(messages, [
        activity("search", { runId: "run-1", afterMessageId: "assistant-run-1-1" }),
    ]);
    assert.deepEqual(result.get("assistant-run-1-0")?.map((row) => row.id), ["search"]);
});

test("activity lines expose the tool target and command arguments", () => {
    assert.equal(activityLine(activity("read", { title: "read_file", detail: '{"file_path":"src/agent.ts"}' })), "read_file src/agent.ts");
    assert.equal(activityLine(activity("search", { title: "grep_search", detail: '{"pattern":"TODO","path":"src"}', state: "running" })), "grep_search TODO · src");
    assert.equal(activityLine(activity("run", { title: "run_command", detail: '{"command":"git","args":["diff","--","a file.ts"]}' })), 'run_command git diff -- "a file.ts"');
});

test("unanchored legacy activity never floats at the end of the current conversation", () => {
    const messages = [{ id: "history-10", role: "assistant" as const, text: "Current reply" }];
    const result = groupConversationActivities(messages, [activity("old")]);
    assert.equal(result.size, 0);
});
