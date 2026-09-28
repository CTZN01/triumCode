import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalService } from "./terminal-service.js";
import { WorkspaceStore } from "./workspace-store.js";

test("closing a Windows terminal waits for its exit event", { skip: process.platform !== "win32", timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "triumcode-terminal-test-"));
    const events: string[] = [];
    let output = "";
    let resolveChild!: (pid: number) => void;
    const childPid = new Promise<number>((resolve) => { resolveChild = resolve; });
    const workspaces = new WorkspaceStore(root);
    const service = new TerminalService(workspaces, (event) => {
        events.push(event.payload.type);
        if (event.payload.type !== "data") return;
        output += event.payload.data;
        const match = /TRIUM_CHILD_PID=(\d+)/.exec(output);
        if (match) resolveChild(Number(match[1]));
    });
    try {
        const workspace = workspaces.open(root);
        const terminal = service.create(workspace.id, 80, 24);
        assert.equal(service.hasOpenTerminals(workspace.id), true);
        service.write(terminal.id, "$child = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; [Console]::WriteLine('TRIUM_CHILD_PID=' + $child.Id)\r");
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const pid = await Promise.race([
            childPid,
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Child PID was not reported")), 5_000); }),
        ]).finally(() => { if (timeout) clearTimeout(timeout); });
        assert.doesNotThrow(() => process.kill(pid, 0));
        const firstClose = service.close(terminal.id);
        const secondClose = service.close(terminal.id);
        assert.equal(firstClose, secondClose);
        const shutdown = service.closeAll();
        assert.throws(() => service.create(workspace.id, 80, 24), /closing its terminals/);
        await firstClose;
        await shutdown;
        assert.equal(service.hasOpenTerminals(), false);
        assert.ok(events.includes("exit"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
        await service.closeAll();
        await rm(root, { recursive: true, force: true });
    }
});
