import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEditDiff, FILE_DIFF_LIMIT, parseFileEditDiff } from "./file-diff.js";

test("a one-line edit in a large file has a compact hunk with correct line numbers", () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1}\n`).join("");
    const patch = createFileEditDiff("file.txt", before, before.replace("line 5000\n", "changed\n"));
    assert.equal(patch.added, 1);
    assert.equal(patch.removed, 1);
    assert.equal(patch.truncated, false);
    assert.match(patch.diff, /@@ -4997,7 \+4997,7 @@/);
    assert.doesNotMatch(patch.diff, /line 1\n/);
});

test("separate changes have separate context hunks and preserve trailing newline changes", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const after = before.replace("line 2\n", "two\n").replace("line 25\n", "twenty-five\n");
    assert.equal(createFileEditDiff("file.txt", before, after).diff.match(/^@@/gm)?.length, 2);
    const newline = createFileEditDiff("file.txt", "one", "one\n");
    assert.match(newline.diff, /\\ No newline at end of file/);
    assert.deepEqual([newline.added, newline.removed], [1, 1]);
});

test("line-ending-only changes are explicit without whole-file additions and deletions", () => {
    const edit = createFileEditDiff("file.txt", "one\r\ntwo\r\n", "one\ntwo\n");
    assert.equal(edit.diff, "");
    assert.match(edit.notice!, /LF\/CRLF/);
    assert.notEqual(edit.beforeHash, edit.afterHash);
    assert.deepEqual([edit.added, edit.removed], [0, 0]);
});

test("snapshot limits and binary content have explicit notices", () => {
    assert.equal(createFileEditDiff("file.txt", "before\0", "after\0").diff, "");
    const large = createFileEditDiff("file.txt", "a".repeat(2 * 1024 * 1024 + 1), "new");
    assert.equal(large.truncated, true);
    const difficult = createFileEditDiff("file.txt", "a\n".repeat(2100), "b\n".repeat(2100));
    assert.equal(difficult.truncated, true);
    assert.match(difficult.notice!, /内存/);
    const truncated = createFileEditDiff("file.txt", "a".repeat(40_000) + "\n", "b".repeat(40_000) + "\n");
    assert.equal(truncated.truncated, true);
    assert.ok(Buffer.byteLength(truncated.diff) <= FILE_DIFF_LIMIT);
    assert.ok(truncated.diff.endsWith("\n"));
});

test("stored patches round-trip and reject malformed historical data", () => {
    const patch = createFileEditDiff("file.txt", "a\n", "b\n");
    assert.deepEqual(parseFileEditDiff(JSON.parse(JSON.stringify(patch))), patch);
    assert.equal(parseFileEditDiff({ ...patch, added: -1 }), undefined);
    assert.equal(parseFileEditDiff({ ...patch, beforeHash: "invalid" }), undefined);
    assert.equal(parseFileEditDiff({ ...patch, diff: "x".repeat(FILE_DIFF_LIMIT + 1) }), undefined);
});

test("generated patches apply to their preimages, including empty files and multiple hunks", {
    skip: spawnSync("git", ["--version"], { windowsHide: true }).status !== 0,
}, () => {
    const root = mkdtempSync(join(tmpdir(), "triumcode-patch-"));
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    const cases: Array<[string, string]> = [
        ["", "new\n"], ["old\n", ""], ["one", "one\n"], ["one\n", "one"],
        ["a\nb\n", "a\nnew\nb\n"], ["a\nb\n", "a\n"],
        [long, long.replace("line 3\n", "three\n").replace("line 32\n", "thirty-two\n")],
        ["x\ny\nx\ny\n", "y\nx\ny\nx\n"],
    ];
    try {
        for (const [before, after] of cases) {
            writeFileSync(join(root, "file.txt"), before);
            const patch = createFileEditDiff("file.txt", before, after);
            execFileSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], { cwd: root, input: patch.diff, windowsHide: true });
            assert.equal(readFileSync(join(root, "file.txt"), "utf8"), after);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
