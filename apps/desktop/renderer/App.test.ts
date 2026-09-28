import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

for (const protocol of ["anthropic", "openai-chat", "openai-responses"]) {
    test(`${protocol}: real desktop composition, image follow-up, interruption, handoff stop and error recovery`, { timeout: 40_000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "triumcode-steering-ui-"));
        const electron = createRequire(import.meta.url)("electron") as string;
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        try {
            const result = await promisify(execFile)(electron, [fileURLToPath(new URL("../main/steering-ui-fixture.js", import.meta.url)), directory, protocol], { env, windowsHide: true, timeout: 35_000 });
            assert.match(result.stdout, new RegExp(`steering-ui-${protocol}-ok`));
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}
