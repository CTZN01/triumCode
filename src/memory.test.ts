import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    saveMemory, listMemories, slugify, memoryFilename, keywordRecall,
    selectRelevantMemories, startMemoryPrefetch, formatMemoriesForInjection,
    buildMemoryPromptSection, truncateIndexText, memoryFreshnessWarning,
    MAX_SESSION_MEMORY_BYTES,
    type MemoryOptions, type SideQueryFn,
} from "./memory.js";

function fixture(): { home: string; cwd: string; options: MemoryOptions } {
    const home = mkdtempSync(join(tmpdir(), "triumcode-mem-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-mem-proj-"));
    return { home, cwd, options: { cwd, home } };
}

function globalDir(home: string): string {
    return join(home, ".triumcode", "memory");
}

function projectDir(cwd: string): string {
    return join(cwd, ".triumcode", "memory");
}

const SIDE_QUERY_NULL: SideQueryFn = async () => "";

test("slugify and filename derivation", () => {
    assert.equal(slugify("Prefers Concise Output!"), "prefers-concise-output");
    assert.equal(memoryFilename("feedback", "No End Summaries"), "feedback_no-end-summaries.md");
});

test("saveMemory writes frontmatter, rebuilds index, listMemories parses it", () => {
    const { cwd, options } = fixture();
    const path = saveMemory({
        name: "deploys to staging",
        description: "User deploys changes to staging first",
        type: "project",
        content: "Deploy to https://staging.example.com before merging.",
    }, options);

    assert.ok(path.startsWith(projectDir(cwd)));
    assert.ok(existsSync(path));
    const raw = readFileSync(path, "utf-8");
    assert.match(raw, /^---\nname: deploys to staging\ndescription: /);
    assert.ok(existsSync(join(projectDir(cwd), "MEMORY.md")));

    const memories = listMemories(options);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].type, "project");
    assert.equal(memories[0].source, "project");
    assert.equal(memories[0].description, "User deploys changes to staging first");
    assert.match(memories[0].content, /staging\.example\.com/);
});

test("project memories override global memories on filename collision", () => {
    const { home, cwd, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    mkdirSync(projectDir(cwd), { recursive: true });
    writeFileSync(join(globalDir(home), "user_editor.md"), "---\nname: editor\ndescription: vim\ntype: user\n---\nuses vim");
    writeFileSync(join(projectDir(cwd), "user_editor.md"), "---\nname: editor\ndescription: emacs\ntype: user\n---\nuses emacs");

    const memories = listMemories(options);
    assert.equal(memories.length, 1);
    assert.equal(memories[0].source, "project");
    assert.equal(memories[0].description, "emacs");
});

test("files without valid frontmatter or type are skipped, MEMORY.md is not a memory", () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "MEMORY.md"), "# Memory Index\n- nothing\n");
    writeFileSync(join(globalDir(home), "not_a_memory.md"), "just prose, no frontmatter");
    writeFileSync(join(globalDir(home), "user_bad.md"), "---\nname: bad\ndescription: no type\ntype: secret\n---\nbody");

    assert.deepEqual(listMemories(options), []);
});

test("truncateIndexText applies both line and byte caps", () => {
    const manyLines = Array.from({ length: 500 }, (_, i) => `- entry ${i}`).join("\n");
    const lineTruncated = truncateIndexText(manyLines);
    assert.ok(lineTruncated.includes("too many memory entries"));
    assert.equal(lineTruncated.split("\n").length, 202); // 200 capped lines + blank + note

    const fewHugeLines = Array.from({ length: 10 }, (_, i) => `- entry ${i}: ${"x".repeat(10_000)}`).join("\n");
    const byteTruncated = truncateIndexText(fewHugeLines);
    assert.ok(byteTruncated.includes("index too large"));
    assert.ok(Buffer.byteLength(byteTruncated, "utf-8") < 10 * 10_000 + 100);
});

test("freshness warning appears only past one day", () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    const fresh = join(globalDir(home), "user_fresh.md");
    const stale = join(globalDir(home), "user_stale.md");
    writeFileSync(fresh, "---\nname: fresh\ndescription: d\ntype: user\n---\nbody");
    writeFileSync(stale, "---\nname: stale\ndescription: d\ntype: user\n---\nbody");
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    utimesSync(stale, fiveDaysAgo, fiveDaysAgo);

    const memories = listMemories(options);
    const byName = new Map(memories.map((m) => [m.name, m]));
    assert.equal(memoryFreshnessWarning(byName.get("fresh")!.mtimeMs), "");
    assert.match(memoryFreshnessWarning(byName.get("stale")!.mtimeMs), /5 days old/);
    assert.match(memoryFreshnessWarning(byName.get("stale")!.mtimeMs), /not live state/);
});

test("keywordRecall scores word overlap and ranks top matches", () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging environment before release");
    writeFileSync(join(globalDir(home), "user_editor.md"),
        "---\nname: editor\ndescription: editor choice\ntype: user\n---\nuser edits with vim");

    const memories = listMemories(options);
    const hits = keywordRecall("how do I deploy to staging", memories);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "deploy");
});

test("selectRelevantMemories uses the side query's JSON pick", async () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");
    writeFileSync(join(globalDir(home), "user_editor.md"),
        "---\nname: editor\ndescription: editor choice\ntype: user\n---\nuses vim");

    const sideQuery: SideQueryFn = async () =>
        'Sure! ```json\n{"selected_memories": ["project_deploy.md"]}\n```';
    const picked = await selectRelevantMemories("deploy question", sideQuery, new Set(), options);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].filename, "project_deploy.md");
    assert.match(picked[0].header, /^Memory \(saved .*: .*project_deploy\.md:$/);
    assert.match(picked[0].content, /deploy staging/);
});

test("selectRelevantMemories falls back to keywords when the side query fails", async () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");
    writeFileSync(join(globalDir(home), "user_editor.md"),
        "---\nname: editor\ndescription: editor choice\ntype: user\n---\nuses vim");

    const failing: SideQueryFn = async () => { throw new Error("no key"); };
    const picked = await selectRelevantMemories("how do I deploy to staging", failing, new Set(), options);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].name, "deploy");
});

test("selectRelevantMemories skips already-surfaced memories", async () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");
    const surfaced = new Set<string>([join(globalDir(home), "project_deploy.md")]);

    const picked = await selectRelevantMemories("deploy question", SIDE_QUERY_NULL, surfaced, options);
    assert.deepEqual(picked, []);
});

test("startMemoryPrefetch gates on query shape, budget and empty store", () => {
    const { home, options } = fixture();
    // No memories at all.
    assert.equal(startMemoryPrefetch("deploy the staging build", SIDE_QUERY_NULL, new Set(), 0, options), null);

    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");

    // Single English word is too short to match meaningfully.
    assert.equal(startMemoryPrefetch("hi", SIDE_QUERY_NULL, new Set(), 0, options), null);
    // But a short CJK query is fine.
    assert.ok(startMemoryPrefetch("部署流程", SIDE_QUERY_NULL, new Set(), 0, options));
    // Session budget exhausted.
    assert.equal(startMemoryPrefetch("deploy the staging build", SIDE_QUERY_NULL, new Set(), MAX_SESSION_MEMORY_BYTES, options), null);
    // Everything already surfaced this session.
    const surfaced = new Set<string>([join(globalDir(home), "project_deploy.md")]);
    assert.equal(startMemoryPrefetch("deploy the staging build", SIDE_QUERY_NULL, surfaced, 0, options), null);

    // Happy path: returns a handle that settles.
    const handle = startMemoryPrefetch("deploy the staging build", SIDE_QUERY_NULL, new Set(), 0, options);
    assert.ok(handle);
    assert.equal(handle!.settled, false);
});

test("startMemoryPrefetch handle settles and selectRelevantMemories resolves", async () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");

    const handle = startMemoryPrefetch("how do I deploy to staging", SIDE_QUERY_NULL, new Set(), 0, options);
    assert.ok(handle);
    const memories = await handle!.promise;
    assert.equal(handle!.settled, true);
    assert.equal(memories.length, 1);
});

test("formatMemoriesForInjection wraps each memory in system-reminder", () => {
    const { home, options } = fixture();
    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "project_deploy.md"),
        "---\nname: deploy\ndescription: staging deploy\ntype: project\n---\ndeploy staging");
    const handle = startMemoryPrefetch("how do I deploy to staging", SIDE_QUERY_NULL, new Set(), 0, options);
    assert.ok(handle);

    return handle!.promise.then((memories) => {
        const text = formatMemoriesForInjection(memories);
        assert.equal(text.match(/<\/system-reminder>/g)?.length, 1);
        assert.match(text, /<system-reminder>\nMemory \(saved/);
        assert.match(text, /deploy staging/);
        void options;
    });
});

test("buildMemoryPromptSection includes taxonomy, rules and the index", () => {
    const { home, options } = fixture();
    // Empty store: still teaches the system, index says so.
    const emptySection = buildMemoryPromptSection(options);
    assert.match(emptySection, /# Memory System/);
    assert.match(emptySection, /What NOT to Save/);
    assert.match(emptySection, /\(No memories saved yet\.\)/);

    mkdirSync(globalDir(home), { recursive: true });
    writeFileSync(join(globalDir(home), "user_prefers_vim.md"),
        "---\nname: prefers-vim\ndescription: uses vim\ntype: user\n---\nbody");
    const section = buildMemoryPromptSection(options);
    assert.match(section, /user_prefers_vim\.md/);
    assert.match(section, /uses vim/);
});
