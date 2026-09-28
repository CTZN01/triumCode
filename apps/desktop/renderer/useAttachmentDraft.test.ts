import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("native image/text paste, repeated paste, drop, send, HTTP images and session reopen work end to end", { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-attachment-draft-ui-"));
    const electron = createRequire(import.meta.url)("electron") as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        const result = await promisify(execFile)(electron, [fileURLToPath(new URL("../main/attachment-ui-fixture.js", import.meta.url)), directory, "draft"], { env, windowsHide: true, timeout: 40_000 });
        assert.match(result.stdout, /attachment-ui-draft-ok/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
