import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeSessionReviewFiles } from "./review-cleanup.js";

test("deleting one conversation removes its review runs and keeps other conversations", () => {
    const root = mkdtempSync(join(tmpdir(), "triumcode-review-delete-"));
    const firstRun = "11111111-1111-4111-8111-111111111111";
    const secondRun = "22222222-2222-4222-8222-222222222222";
    const laterRun = "33333333-3333-4333-8333-333333333333";
    try {
        writeFileSync(join(root, `${firstRun}.json`), "encrypted first");
        writeFileSync(join(root, `${secondRun}.json`), "encrypted second");
        writeFileSync(join(root, `${laterRun}.json`), "encrypted later");
        writeFileSync(join(root, "index.json"), JSON.stringify({
            latestBySessionId: { aaaaaaaa: laterRun, bbbbbbbb: secondRun },
            runs: {
                [firstRun]: { sessionId: "aaaaaaaa", startedAt: "2026-09-26T00:00:00.000Z", status: "idle" },
                [secondRun]: { sessionId: "bbbbbbbb", startedAt: "2026-09-26T00:00:00.000Z", status: "idle" },
                [laterRun]: { sessionId: "aaaaaaaa", startedAt: "2026-09-26T00:01:00.000Z", status: "idle" },
            },
        }));
        removeSessionReviewFiles(root, "aaaaaaaa");
        assert.equal(existsSync(join(root, `${firstRun}.json`)), false);
        assert.equal(existsSync(join(root, `${secondRun}.json`)), true);
        assert.equal(existsSync(join(root, `${laterRun}.json`)), false);
        const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8"));
        assert.deepEqual(Object.keys(index.runs), [secondRun]);
        assert.deepEqual(index.latestBySessionId, { bbbbbbbb: secondRun });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("missing or unreadable review metadata cannot be reported as fully removed", () => {
    const root = mkdtempSync(join(tmpdir(), "triumcode-review-delete-"));
    const runId = "11111111-1111-4111-8111-111111111111";
    try {
        writeFileSync(join(root, `${runId}.json`), "encrypted first");
        assert.throws(() => removeSessionReviewFiles(root, "aaaaaaaa"));
        writeFileSync(join(root, "index.json"), "broken json");
        assert.throws(() => removeSessionReviewFiles(root, "aaaaaaaa"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
