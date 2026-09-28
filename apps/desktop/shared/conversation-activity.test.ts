import assert from "node:assert/strict";
import { test } from "node:test";
import { activityFilePath, activityLine, editFileName, editLineStats, editResultSnippet, groupConversationActivities, type PlacedActivity } from "./conversation-activity.js";
import { createFileEditDiff } from "../../../src/file-diff.js";

test("edit line counts use captured net changes rather than multi_edit intermediate steps", () => {
    const row: PlacedActivity = {
        id: "edit", title: "multi_edit", detail: "{}", state: "complete",
        output: "Edited 2 regions in file.txt (+2/-2 lines)",
        fileEdit: createFileEditDiff("file.txt", "A\n", "A\n"),
    };
    assert.deepEqual(editLineStats(row), { added: 0, removed: 0 });
    assert.equal(editLineStats({ ...row, fileEdit: createFileEditDiff("file.txt", "a".repeat(2 * 1024 * 1024 + 1), "b") }), null);
});

const activity = (id: string, extra: Partial<PlacedActivity> = {}): PlacedActivity => ({
    id, title: "read_file", detail: "{}", state: "complete", ...extra,
});

test("legacy edits expose real result snippets without inventing historical deletions", () => {
    const row = activity("legacy", {
        title: "edit_file", detail: JSON.stringify({ file_path: "D:\\project\\App.tsx" }),
        output: 'Edited App.tsx at line 42 (+1/-1 lines)\n\n   41 |   <div>\n   42 |     <span className="label" />\n   43 |   </div>',
    });
    assert.equal(editFileName(row), "App.tsx");
    assert.deepEqual(editResultSnippet(row), [
        { number: 41, text: "  <div>" }, { number: 42, text: '    <span className="label" />' }, { number: 43, text: "  </div>" },
    ]);
    assert.deepEqual(editResultSnippet({ ...row, output: "Error: old_string not found\n   41 | diagnostic" }), []);
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

test("edit activity lines carry the line delta once the result arrives", () => {
    const detail = '{"file_path":"src/agent.ts"}';
    assert.equal(activityLine(activity("edit", { title: "edit_file", detail })), "edit_file src/agent.ts");
    assert.equal(activityLine(activity("edit", {
        title: "edit_file", detail, output: "Edited src/agent.ts at line 254 (+2/-1 lines)\n\n  254 | line",
    })), "edit_file src/agent.ts +2/-1");
    assert.equal(activityLine(activity("multi", {
        title: "multi_edit", detail: '{"file_path":"src/a.py","editCount":4}',
        output: "Edited 4 regions in src/a.py (+5/-4 lines) (showing 3 of 4 regions)",
    })), "multi_edit src/a.py +5/-4");
    assert.equal(activityLine(activity("failed", {
        title: "edit_file", detail, state: "failed", output: "Error: old_string not found in the file.",
    })), "edit_file src/agent.ts");
    assert.deepEqual(editLineStats(activity("edit", {
        title: "edit_file", detail, output: "Edited src/agent.ts at line 254 (+2/-1 lines)",
    })), { added: 2, removed: 1 });
    assert.equal(editLineStats(activity("failed", { title: "edit_file", detail, output: "Error: edit failed" })), null);
});

test("edit activity resolves a file only within its workspace", () => {
    assert.equal(activityFilePath(activity("edit", {
        title: "edit_file", detail: '{"file_path":"D:\\\\Project\\\\src\\\\agent.ts"}',
    }), "D:\\Project"), "src/agent.ts");
    assert.equal(activityFilePath(activity("other", {
        title: "edit_file", detail: '{"file_path":"D:\\\\Project-other\\\\src\\\\agent.ts"}',
    }), "D:\\Project"), null);
});

test("unanchored legacy activity never floats at the end of the current conversation", () => {
    const messages = [{ id: "history-10", role: "assistant" as const, text: "Current reply" }];
    const result = groupConversationActivities(messages, [activity("old")]);
    assert.equal(result.size, 0);
});
