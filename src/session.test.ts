import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { projectRoot } from "./session.js";

// ── projectRoot ─────────────────────────────────────────────
//
// Every session path is derived from projectRoot(), so where it points decides
// which conversations a run can see. It reads the live cwd and home on each
// call — os.homedir() follows HOME/USERPROFILE from the environment — so both
// can be redirected here without touching the real ones. (SESSIONS_ROOT is
// fixed at module load and is deliberately left alone; nothing below writes.)

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
