import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "./tool-executor.js";

test("queued edits preserve each actual write even when results are collected after later edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "triumcode-edit-history-"));
    const file = join(root, "file.txt");
    writeFileSync(file, "A\n");
    try {
        const executor = new ToolExecutor({ workspaceRoot: root, captureFileEdits: true });
        const first = executor.enqueue("first", "edit_file", { file_path: file, old_string: "A", new_string: "B" });
        const second = executor.enqueue("second", "edit_file", { file_path: file, old_string: "B", new_string: "C" });
        await executor.drain();
        const a = (await first).fileEdit!;
        const b = (await second).fileEdit!;
        assert.match(a.diff, /-A\n\+B/);
        assert.match(b.diff, /-B\n\+C/);
        assert.equal(a.afterHash, b.beforeHash);
        assert.equal(a.path, "file.txt");
        writeFileSync(file, "external\n");
        assert.match(a.diff, /\+B/);
        assert.doesNotMatch(a.diff, /external/);
        assert.equal((await first).output.includes("--- a/"), false);

        writeFileSync(file, "A\n");
        const batch = await executor.enqueue("batch", "multi_edit", { file_path: file, edits: [
            { old_string: "A", new_string: "B" }, { old_string: "B", new_string: "A" },
        ] });
        assert.equal(batch.fileEdit!.diff, "");
        assert.deepEqual([batch.fileEdit!.added, batch.fileEdit!.removed], [0, 0]);
        const failed = await executor.enqueue("failed", "multi_edit", { file_path: file, edits: [
            { old_string: "A", new_string: "B" }, { old_string: "missing", new_string: "C" },
        ] });
        assert.equal(failed.fileEdit, undefined);
        assert.equal(readFileSync(file, "utf8"), "A\n");
        const cli = await new ToolExecutor({ workspaceRoot: root }).enqueue("cli", "edit_file", { file_path: file, old_string: "A", new_string: "D" });
        assert.equal(cli.fileEdit, undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
