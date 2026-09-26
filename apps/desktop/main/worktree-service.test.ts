import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGitWorktree, getWorktreeSetup } from "./worktree-service.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

test("worktree setup offers fetched remote branches without remote HEAD aliases", { skip: !gitAvailable }, async () => {
    const root = await mkdtemp(join(tmpdir(), "triumcode-worktree-setup-"));
    const parent = await mkdtemp(join(tmpdir(), "triumcode-worktree-parent-"));
    try {
        git(root, "init", "-q", "--initial-branch=main");
        git(root, "config", "user.name", "TriumCode Test");
        git(root, "config", "user.email", "triumcode-test@example.invalid");
        await writeFile(join(root, "tracked.txt"), "initial\n");
        git(root, "add", "tracked.txt");
        git(root, "commit", "-q", "-m", "initial");
        git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
        git(root, "update-ref", "refs/remotes/origin/feature", "HEAD");
        git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

        const setup = await getWorktreeSetup(root);
        assert.equal(setup.defaultBase, "main");
        assert.deepEqual(setup.branches, ["main", "origin/feature", "origin/main"]);

        const created = await createGitWorktree(root, {
            taskName: "Remote choice",
            branchName: "codex/remote-choice",
            baseRef: "origin/feature",
            parentPath: parent,
            confirmDirtySource: false,
        });
        assert.equal(created.baseCommit, git(root, "rev-parse", "HEAD"));
        assert.equal(git(created.path, "branch", "--show-current"), "codex/remote-choice");
        await assert.rejects(createGitWorktree(root, {
            taskName: "Inside source",
            branchName: "codex/inside-source",
            baseRef: "main",
            parentPath: root,
            confirmDirtySource: false,
        }), { code: "WORKTREE_TARGET_INSIDE_SOURCE" });
    } finally {
        await rm(parent, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});
