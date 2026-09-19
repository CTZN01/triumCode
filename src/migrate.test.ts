import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateDir } from "./migrate.js";

/** A throwaway directory to stage legacy/current pairs inside. */
function scratch(): string {
    return mkdtempSync(join(tmpdir(), "triumcode-migrate-"));
}

function seed(dir: string, file: string, contents: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), contents, "utf-8");
}

test("adopts the legacy directory when the current one does not exist", () => {
    const root = scratch();
    const legacy = join(root, ".triumph");
    const current = join(root, ".triumcode");
    seed(legacy, "config.json", '{"apiKey":"sk-ant-saved"}');

    assert.equal(migrateDir(legacy, current), true);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(join(current, "config.json"), "utf-8"), '{"apiKey":"sk-ant-saved"}');
});

test("an existing current directory wins outright", () => {
    // Regression guard for the second run: adopting the legacy directory
    // again would move it back over the live one, discarding everything
    // written since the migration.
    const root = scratch();
    const legacy = join(root, ".triumph");
    const current = join(root, ".triumcode");
    seed(legacy, "config.json", '{"apiKey":"sk-ant-stale"}');
    seed(current, "config.json", '{"apiKey":"sk-ant-current"}');

    assert.equal(migrateDir(legacy, current), false);
    assert.equal(readFileSync(join(current, "config.json"), "utf-8"), '{"apiKey":"sk-ant-current"}');
    // The stale directory is left untouched rather than deleted — it is not
    // this function's data to remove.
    assert.equal(existsSync(legacy), true);
});

test("a first run with no legacy directory is a no-op", () => {
    const root = scratch();
    assert.equal(migrateDir(join(root, ".triumph"), join(root, ".triumcode")), false);
    assert.equal(existsSync(join(root, ".triumcode")), false);
});

test("a failure to adopt is reported, not thrown", () => {
    // renameSync refuses to move into a missing parent. No real call site can
    // produce that, but it is the cheapest portable way to reach the catch —
    // a locked or read-only directory fails identically on Windows, and the
    // CLI has to keep starting either way.
    const root = scratch();
    const legacy = join(root, ".triumph");
    seed(legacy, "config.json", '{"apiKey":"sk-ant-saved"}');

    assert.equal(migrateDir(legacy, join(root, "missing", ".triumcode")), false);
    // Left in place rather than half-moved, so the data is still there to
    // adopt on a later run.
    assert.equal(existsSync(legacy), true);
});
