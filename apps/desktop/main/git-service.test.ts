import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { layoutGitGraph } from "../shared/git-graph-layout.js";
import { commitGitChanges, createGitBranch, readGitCommitDetail, readGitHistory, readGitSnapshot, stageGitPath, switchGitBranch, unstageGitPath } from "./git-service.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function createRepository(): Promise<{ root: string; dispose: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), "triumcode-git-service-"));
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "TriumCode Test");
    git(root, "config", "user.email", "triumcode-test@example.invalid");
    git(root, "config", "core.autocrlf", "false");
    return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function seedCommit(root: string, files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
        await writeFile(join(root, path), content, "utf8");
    }
    git(root, "add", "--", ...Object.keys(files));
    git(root, "commit", "-q", "-m", "initial");
}

test("stageGitPath stages only the selected changed path, including dash-prefixed names", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "tracked.txt": "before\n" });
        await writeFile(join(repository.root, "tracked.txt"), "after\n", "utf8");
        await writeFile(join(repository.root, "-draft.txt"), "new\n", "utf8");

        await stageGitPath(repository.root, "-draft.txt");

        const snapshot = await readGitSnapshot(repository.root);
        assert.equal(snapshot.files.find((file) => file.path === "-draft.txt")?.staged, true);
        assert.equal(snapshot.files.find((file) => file.path === "tracked.txt")?.staged, false);
    } finally {
        await repository.dispose();
    }
});

test("stageGitPath rejects paths outside the workspace and paths absent from current Git status", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await assert.rejects(stageGitPath(repository.root, "../outside.txt"), { code: "INVALID_GIT_PATH" });
        await assert.rejects(stageGitPath(repository.root, "missing.txt"), { code: "GIT_PATH_STALE" });
    } finally {
        await repository.dispose();
    }
});

test("unstageGitPath preserves working tree edits", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "tracked.txt": "before\n" });
        await writeFile(join(repository.root, "tracked.txt"), "after\n", "utf8");
        git(repository.root, "add", "--", "tracked.txt");

        await unstageGitPath(repository.root, "tracked.txt");

        assert.equal(await readFile(join(repository.root, "tracked.txt"), "utf8"), "after\n");
        const file = (await readGitSnapshot(repository.root)).files.find((entry) => entry.path === "tracked.txt");
        assert.equal(file?.staged, false);
        assert.equal(file?.unstaged, true);
    } finally {
        await repository.dispose();
    }
});

test("unstageGitPath in an unborn repository keeps the file on disk", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await writeFile(join(repository.root, "first.txt"), "content\n", "utf8");
        git(repository.root, "add", "--", "first.txt");

        await unstageGitPath(repository.root, "first.txt");

        assert.equal(await readFile(join(repository.root, "first.txt"), "utf8"), "content\n");
        assert.equal((await readGitSnapshot(repository.root)).files[0]?.untracked, true);
    } finally {
        await repository.dispose();
    }
});

test("commitGitChanges commits staged content only and rejects an empty staged area", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "staged.txt": "before\n", "unstaged.txt": "before\n" });
        await writeFile(join(repository.root, "staged.txt"), "commit this\n", "utf8");
        await writeFile(join(repository.root, "unstaged.txt"), "leave this out\n", "utf8");
        git(repository.root, "add", "--", "staged.txt");

        const output = await commitGitChanges(repository.root, "  Add staged change  ");

        assert.match(output, /Add staged change/);
        assert.equal(git(repository.root, "log", "-1", "--format=%s"), "Add staged change");
        assert.equal(git(repository.root, "show", "HEAD:staged.txt"), "commit this");
        assert.equal(git(repository.root, "show", "HEAD:unstaged.txt"), "before");
        await assert.rejects(commitGitChanges(repository.root, "nothing to commit"), { code: "GIT_NOTHING_STAGED" });
    } finally {
        await repository.dispose();
    }
});

test("Git history lists branches and commits, and commit detail includes the full message", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "tracked.txt": "before\n" });
        git(repository.root, "commit", "--amend", "-q", "-m", "Initial subject", "-m", "Detail line");
        const history = await readGitHistory(repository.root);
        assert.deepEqual(history.branches, ["main"]);
        assert.equal(history.currentBranch, "main");
        assert.equal(history.commits[0]?.subject, "Initial subject");
        assert.match(history.commits[0]?.graph ?? "", /\*/);

        const detail = await readGitCommitDetail(repository.root, history.commits[0].hash);
        assert.match(detail.message, /Detail line/);
        assert.match(detail.stats, /tracked\.txt/);
        await assert.rejects(readGitCommitDetail(repository.root, "HEAD"), { code: "INVALID_GIT_COMMIT" });
    } finally {
        await repository.dispose();
    }
});

test("Git history exposes real parent links across branches", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "base.txt": "base\n" });
        git(repository.root, "checkout", "-q", "-b", "feature");
        await seedCommit(repository.root, { "feature.txt": "feature\n" });
        git(repository.root, "checkout", "-q", "main");
        await seedCommit(repository.root, { "main.txt": "main\n" });

        const history = await readGitHistory(repository.root);
        assert.equal(history.commits.length, 3);
        const base = history.commits.find((commit) => commit.parents.length === 0);
        assert.ok(base);
        assert.equal(history.commits.filter((commit) => commit.parents.includes(base.hash)).length, 2);
    } finally {
        await repository.dispose();
    }
});

test("Git graph lines match both parents of a real merge commit", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "base.txt": "base\n" });
        git(repository.root, "checkout", "-q", "-b", "feature");
        await seedCommit(repository.root, { "feature.txt": "feature\n" });
        git(repository.root, "checkout", "-q", "main");
        await seedCommit(repository.root, { "main.txt": "main\n" });
        git(repository.root, "merge", "-q", "--no-ff", "feature", "-m", "Merge feature");

        const history = await readGitHistory(repository.root);
        const merge = history.commits.find((commit) => commit.subject === "Merge feature");
        assert.ok(merge);
        assert.equal(merge.parents.length, 2);
        const edges = layoutGitGraph(history.commits).edges.filter((edge) => edge.child === merge.hash);
        assert.deepEqual(edges.map((edge) => edge.parent), merge.parents);
    } finally {
        await repository.dispose();
    }
});

test("branch creation keeps local edits while switching existing branches requires a clean worktree", { skip: !gitAvailable }, async () => {
    const repository = await createRepository();
    try {
        await seedCommit(repository.root, { "tracked.txt": "before\n" });
        await writeFile(join(repository.root, "tracked.txt"), "draft\n", "utf8");
        await createGitBranch(repository.root, "feature/new-work");
        assert.equal(git(repository.root, "branch", "--show-current"), "feature/new-work");
        assert.equal(await readFile(join(repository.root, "tracked.txt"), "utf8"), "draft\n");
        await assert.rejects(switchGitBranch(repository.root, "main"), { code: "GIT_WORKTREE_DIRTY" });
        git(repository.root, "add", "tracked.txt");
        git(repository.root, "commit", "-q", "-m", "Save draft");
        const history = await readGitHistory(repository.root);
        assert.equal(history.commits.length, 2);
        assert.equal(history.currentBranch, "feature/new-work");
        assert.equal(history.dirty, false);
        await switchGitBranch(repository.root, "main");
        assert.equal(git(repository.root, "branch", "--show-current"), "main");
        assert.equal(await readFile(join(repository.root, "tracked.txt"), "utf8"), "before\n");
        await assert.rejects(createGitBranch(repository.root, "bad name"), { code: "INVALID_GIT_BRANCH" });
    } finally {
        await repository.dispose();
    }
});
