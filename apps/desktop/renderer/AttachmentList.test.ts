import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("real attachment cards and original image preview render in both themes, show missing-image errors and remove only owned files", { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-attachment-cards-ui-"));
    const electron = createRequire(import.meta.url)("electron") as string;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
        const result = await promisify(execFile)(electron, [fileURLToPath(new URL("../main/attachment-ui-fixture.js", import.meta.url)), directory, "cards"], { env, windowsHide: true, timeout: 25_000 });
        assert.match(result.stdout, /attachment-ui-cards-ok/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
