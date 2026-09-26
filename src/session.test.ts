import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { projectRoot, SessionBusyError, SessionConflictError, SessionStore } from "./session.js";

// ── projectRoot ─────────────────────────────────────────────
//
// Every session path is derived from projectRoot(), so where it points decides
// which conversations a run can see. It reads the live cwd and home on each
// call — os.homedir() follows HOME/USERPROFILE from the environment — so both
// can be redirected here without touching the real ones. The lease test uses
// unique workspace hashes and removes only its own session files.

function inFakeHome(fn: (home: string) => void): void {
    const previousCwd = process.cwd();
    const previous: Record<string, string | undefined> = {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
    };
    const home = mkdtempSync(join(tmpdir(), "triumcode-root-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        fn(home);
    } finally {
        process.chdir(previousCwd);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("a directory under home is its own root, not folded into home", () => {
    // Regression: the marker check ran before the home check, and ~/.triumcode
    // — the global config directory this CLI creates — is a marker. The home
    // guard was therefore dead code, and every unmarked directory under home
    // resolved to home, sharing one session store with every other.
    inFakeHome((home) => {
        mkdirSync(join(home, ".triumcode"), { recursive: true });
        const scratch = join(home, "work", "scratch");
        mkdirSync(scratch, { recursive: true });
        process.chdir(scratch);
        assert.equal(projectRoot(), resolve(scratch));
    });
});

test("a project keeps its root however deep it is entered from", () => {
    inFakeHome((home) => {
        const repo = join(home, "work", "repo");
        mkdirSync(join(repo, ".git"), { recursive: true });
        mkdirSync(join(home, ".triumcode"), { recursive: true });
        const deep = join(repo, "src", "nested");
        mkdirSync(deep, { recursive: true });
        process.chdir(deep);
        assert.equal(projectRoot(), resolve(repo));
    });
});

test("home itself stays its own root, so a run started there keeps its sessions", () => {
    inFakeHome((home) => {
        mkdirSync(join(home, ".triumcode"), { recursive: true });
        process.chdir(home);
        assert.equal(projectRoot(), resolve(home));
    });
});

test("desktop wait state is indexed across stores and cleared on completion or crash recovery", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "triumcode-wait-state-"));
    const store = new SessionStore(workspaceRoot);
    let sessionId: string | undefined;
    try {
        const created = store.create("test-model");
        sessionId = created.id;
        const approval = store.save(created.id, [], created.model, created.revision ?? 0, "running",
            undefined, undefined, undefined, undefined, "approval");
        assert.equal(approval?.desktopWaitingFor, "approval");

        const otherStore = new SessionStore(workspaceRoot);
        assert.equal(otherStore.list().find((item) => item.id === created.id)?.desktopWaitingFor, "approval");

        const question = otherStore.save(created.id, [], created.model, approval!.revision!, "running",
            undefined, undefined, undefined, undefined, "user");
        assert.equal(otherStore.list().find((item) => item.id === created.id)?.desktopWaitingFor, "user");

        const completed = otherStore.save(created.id, [], created.model, question!.revision!, "idle");
        assert.equal(completed?.desktopWaitingFor, undefined);
        assert.equal(otherStore.list().find((item) => item.id === created.id)?.desktopWaitingFor, undefined);

        const waitingAgain = otherStore.save(created.id, [], created.model, completed!.revision!, "running",
            undefined, undefined, undefined, undefined, "approval");
        assert.equal(waitingAgain?.desktopWaitingFor, "approval");
        assert.equal(otherStore.recoverInterrupted(), 1);
        const recovered = otherStore.load(created.id);
        assert.equal(recovered?.status, "interrupted");
        assert.equal(recovered?.desktopWaitingFor, undefined);
        assert.equal(otherStore.list().find((item) => item.id === created.id)?.desktopWaitingFor, undefined);
    } finally {
        if (sessionId) store.delete(sessionId);
        rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test("workspace leases serialize runs and Git mutations without blocking another workspace", () => {
    const workspaceA = mkdtempSync(join(tmpdir(), "triumcode-lease-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "triumcode-lease-b-"));
    const storeA = new SessionStore(workspaceA);
    const storeB = new SessionStore(workspaceB);
    const sessionA1 = storeA.create();
    const sessionA2 = storeA.create();
    const sessionB = storeB.create();
    const hashA = createHash("sha256").update(resolve(workspaceA).toLowerCase()).digest("hex").slice(0, 12);
    const hashB = createHash("sha256").update(resolve(workspaceB).toLowerCase()).digest("hex").slice(0, 12);
    const sessionDirectoryA = join(homedir(), ".triumcode", "sessions", hashA);
    const sessionDirectoryB = join(homedir(), ".triumcode", "sessions", hashB);
    let releaseRun: (() => void) | null = null;
    let releaseGit: (() => void) | null = null;

    try {
        releaseRun = storeA.acquireRun(sessionA1.id, sessionA1.revision);
        assert.throws(() => storeA.acquireRun(sessionA2.id, sessionA2.revision), (error: unknown) =>
            error instanceof SessionBusyError && error.scope === "workspace");
        assert.throws(() => storeA.acquireWorkspaceGitMutation(), (error: unknown) =>
            error instanceof SessionBusyError && error.scope === "workspace");

        const releaseOtherWorkspace = storeB.acquireRun(sessionB.id, sessionB.revision);
        releaseOtherWorkspace();

        releaseRun();
        releaseRun = null;
        releaseGit = storeA.acquireWorkspaceGitMutation();
        assert.throws(() => storeA.acquireRun(sessionA2.id, sessionA2.revision), (error: unknown) =>
            error instanceof SessionBusyError && error.scope === "workspace");
        releaseGit();
        releaseGit = null;

        const releaseNextRun = storeA.acquireRun(sessionA2.id, sessionA2.revision);
        releaseNextRun();
    } finally {
        releaseGit?.();
        releaseRun?.();
        rmSync(workspaceA, { recursive: true, force: true });
        rmSync(workspaceB, { recursive: true, force: true });
        rmSync(sessionDirectoryA, { recursive: true, force: true });
        rmSync(sessionDirectoryB, { recursive: true, force: true });
    }
});

test("desktop route changes preserve history and cannot race a run or stale writer", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "triumcode-route-"));
    const store = new SessionStore(workspaceRoot);
    const created = store.create("old-model");
    const hash = createHash("sha256").update(resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 12);
    const sessionDirectory = join(homedir(), ".triumcode", "sessions", hash);
    const messages = [{ role: "user", content: "Keep this request" }];
    const saved = store.save(created.id, messages, created.model, created.revision ?? 0, "failed");
    const route = {
        modelPreset: "new-preset",
        model: "new-model",
        apiBase: "https://example.test",
        protocol: "openai-chat" as const,
        auth: "bearer" as const,
        thinking: true,
        effort: "medium",
        contextWindow: 128_000,
        permissionMode: "bypassPermissions" as const,
    };
    let releaseRun: (() => void) | null = null;
    try {
        releaseRun = store.acquireRun(created.id, saved!.revision);
        assert.throws(() => store.updateDesktopSettings(created.id, saved!.revision!, route), SessionBusyError);
        releaseRun();
        releaseRun = null;

        const updated = store.updateDesktopSettings(created.id, saved!.revision!, route);
        assert.equal(updated?.model, "new-model");
        assert.equal(updated?.status, "failed");
        assert.deepEqual(updated?.messages, messages);
        assert.deepEqual(updated?.desktopSettings, route);
        assert.equal(updated?.revision, saved!.revision! + 1);
        assert.throws(() => store.updateDesktopSettings(created.id, saved!.revision!, route), SessionConflictError);
        assert.deepEqual(store.load(created.id)?.messages, messages);
    } finally {
        releaseRun?.();
        rmSync(workspaceRoot, { recursive: true, force: true });
        rmSync(sessionDirectory, { recursive: true, force: true });
    }
});
