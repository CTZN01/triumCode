import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverCustomAgents, getReadOnlyTools, getSubAgentConfig,
    READ_ONLY_TOOLS, SUBAGENT_MAX_TOKENS, clearCustomAgentCache,
} from "./subagent.js";

// ═══════════════════════════════════════════════════════════════
// Sub-agent configuration
// ═══════════════════════════════════════════════════════════════

const toolNames = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

// ── Built-in types ──────────────────────────────────────────

test("the read-only types get read tools and nothing that can write or run", () => {
    // The constraint is physical, not advisory: a tool absent from this list
    // cannot be called, whatever the model decides or the prompt says.
    for (const type of ["explore", "plan"] as const) {
        const names = toolNames(getSubAgentConfig(type).tools);
        assert.deepEqual(names, ["grep_search", "list_files", "read_file"], `${type} tool set`);

        for (const forbidden of ["write_file", "edit_file", "run_command", "memory", "agent"]) {
            assert.ok(!names.includes(forbidden), `${type} must not reach ${forbidden}`);
        }
    }
});

test("explore and plan share one read-only tool set", () => {
    assert.deepEqual(
        toolNames(getSubAgentConfig("explore").tools),
        toolNames(getSubAgentConfig("plan").tools),
    );
    assert.deepEqual(toolNames(getReadOnlyTools()), [...READ_ONLY_TOOLS].sort());
});

test("a general sub-agent has the full set except the agent tool", () => {
    // Without the exclusion, A→B→C nesting multiplies token use per level and
    // a sub-agent can never be reasoned about as a leaf.
    const names = toolNames(getSubAgentConfig("general").tools);
    assert.ok(!names.includes("agent"), "general must not be able to delegate");
    for (const expected of ["read_file", "write_file", "edit_file", "run_command", "todo"]) {
        assert.ok(names.includes(expected), `general should have ${expected}`);
    }
});

test("a sub-agent's contract is its own, with no main-agent persona in it", () => {
    // The system prompt is re-sent on every request the sub-agent makes, so
    // anything that is not this type's contract is a per-request cost for
    // context the sub-agent cannot use.
    const { systemPrompt } = getSubAgentConfig("explore");
    assert.match(systemPrompt, /exploration sub-agent/);
    assert.match(systemPrompt, /Working directory:/, "the tool calls need the cwd");
    assert.doesNotMatch(systemPrompt, /You are TriumCode/);
    assert.doesNotMatch(systemPrompt, /# Skills/);
});

test("each type carries its own contract, and the budget is below the main agent's", () => {
    assert.match(getSubAgentConfig("plan").systemPrompt, /planning sub-agent/);
    assert.match(getSubAgentConfig("general").systemPrompt, /cannot spawn further sub-agents/);
    for (const type of ["explore", "plan", "general"] as const) {
        assert.equal(getSubAgentConfig(type).maxTokens, SUBAGENT_MAX_TOKENS);
        assert.ok(SUBAGENT_MAX_TOKENS < 32_000, "a summary budget, not a document budget");
    }
});

// ── Custom agents ───────────────────────────────────────────

function agentFile(directory: string, name: string, frontmatter: string, body = "Do the thing."): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.md`), `---\n${frontmatter}\n---\n${body}\n`);
}

test("a custom agent is discovered from .claude/agents with its own tools", () => {
    const home = mkdtempSync(join(tmpdir(), "triumcode-agents-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();

    agentFile(join(cwd, ".claude", "agents"), "reviewer", [
        "name: reviewer",
        "description: Reviews a diff",
        "allowed-tools: read_file, grep_search, git_diff",
    ].join("\n"), "Review the change and report findings.");

    const agents = discoverCustomAgents({ cwd, home, refresh: true });
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "reviewer");
    assert.equal(agents[0].description, "Reviews a diff");
    assert.deepEqual(toolNames(agents[0].tools), ["git_diff", "grep_search", "read_file"]);
    assert.equal(agents[0].source, "project");
    assert.equal(agents[0].prompt, "Review the change and report findings.");
});

test("a project agent overrides a user agent of the same name", () => {
    const home = mkdtempSync(join(tmpdir(), "triumcode-agents-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();

    agentFile(join(home, ".claude", "agents"), "explore", "name: explore\ndescription: user version", "user body");
    agentFile(join(cwd, ".claude", "agents"), "explore", "name: explore\ndescription: project version", "project body");

    const agents = discoverCustomAgents({ cwd, home, refresh: true });
    assert.equal(agents.length, 1, "one entry per name");
    assert.equal(agents[0].description, "project version");
    assert.equal(agents[0].source, "project");
});

test("a custom agent cannot hand out the agent tool", () => {
    // The one path around the general type's exclusion: an agent file that
    // lists it. Nested delegation is what the exclusion exists to prevent.
    const home = mkdtempSync(join(tmpdir(), "triumcode-agents-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();

    agentFile(join(cwd, ".claude", "agents"), "recursive", [
        "name: recursive",
        "allowed-tools: read_file, agent",
    ].join("\n"));

    const agents = discoverCustomAgents({ cwd, home, refresh: true });
    assert.deepEqual(toolNames(agents[0].tools), ["read_file"]);
});

test("a custom agent of a built-in name replaces that type's contract and tools", () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();
    agentFile(join(cwd, ".claude", "agents"), "explore", [
        "name: explore",
        "description: project recon",
        "allowed-tools: read_file, grep_search",
    ].join("\n"), "Custom reconnaissance contract.");

    process.chdir(cwd);
    try {
        const config = getSubAgentConfig("explore");
        assert.match(config.systemPrompt, /Custom reconnaissance contract\./);
        assert.deepEqual(toolNames(config.tools), ["grep_search", "read_file"]);
        // The other types are untouched by the override.
        assert.match(getSubAgentConfig("plan").systemPrompt, /planning sub-agent/);
    } finally {
        process.chdir(originalCwd);
        clearCustomAgentCache();
    }
});

test("a custom agent with no allowed-tools gets the general set", () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();
    agentFile(join(cwd, ".claude", "agents"), "migrator", "name: migrator\ndescription: migrates things");

    process.chdir(cwd);
    try {
        const names = toolNames(getSubAgentConfig("migrator").tools);
        assert.ok(names.includes("write_file"), "no declaration means the full set");
        assert.ok(!names.includes("agent"), "except recursion");
    } finally {
        process.chdir(originalCwd);
        clearCustomAgentCache();
    }
});

test("a malformed agent file is skipped, not fatal", () => {
    const home = mkdtempSync(join(tmpdir(), "triumcode-agents-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-agents-proj-"));
    clearCustomAgentCache();

    const directory = join(cwd, ".claude", "agents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "no-frontmatter.md"), "Just a body, no frontmatter.\n");
    writeFileSync(join(directory, "bad name.md"), "---\nname: Bad Name\ndescription: x\n---\nbody\n");
    agentFile(directory, "good", "name: good\ndescription: fine");

    const agents = discoverCustomAgents({ cwd, home, refresh: true });
    assert.deepEqual(agents.map((a) => a.name), ["good"]);
});
