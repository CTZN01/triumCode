import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildToolPromptBlock, getAllTools, getTool, type Tool } from "./tools.js";
import { parseFrontmatter, parseList, scalar } from "./skills.js";
import { buildEnvironmentContext } from "./prompt.js";

// ═══════════════════════════════════════════════════════════════
// Sub-agents — a main agent's delegated, context-isolated workers
// ═══════════════════════════════════════════════════════════════
//
// A sub-agent is an ordinary Agent instance configured differently (see
// AgentOptions.customTools / customSystemPrompt / isSubAgent). This module owns
// the configuration half: which tools each type may reach, and what contract it
// runs under.
//
// The isolation is the whole point. A sub-agent's tool calls and results stay
// in its own message history and only its final text crosses back, so a search
// that reads forty files costs the main conversation one paragraph instead of
// forty file bodies. Everything here is arranged around that: the read-only
// types carry a tool set with nothing destructive in it, and every contract
// asks for a summary rather than a dump.
//
// The system prompts are deliberately short. A sub-agent is a single-purpose
// call, so it gets its own contract and nothing of the main persona — every
// byte here is re-sent on every request the sub-agent makes.

export type SubAgentType = "explore" | "plan" | "general";

export const SUBAGENT_TYPES: readonly SubAgentType[] = ["explore", "plan", "general"];

export const DEFAULT_SUBAGENT_TYPE: SubAgentType = "general";

/**
 * Sub-agents get a smaller output budget than the main agent's 32k. A
 * sub-agent returns a summary, not a document, and an unbounded budget is one
 * more way a delegated task turns into a runaway one.
 */
export const SUBAGENT_MAX_TOKENS = 4096;

// ── Read-only tool set ───────────────────────────────────────
//
// Explore and Plan share one set. The constraint lives here, at the tool
// layer, rather than in the prompt: a type that cannot be handed write_file
// cannot call it, whatever the model decides. The contracts below restate the
// rule so the model does not waste a turn asking for a tool that is not there.
//
// run_command is deliberately absent even though `ls` and `cat` are read-only
// in practice. It is one classifier bug away from being a write, and a
// sub-agent that needs to run something is a general sub-agent.

const READ_ONLY_TOOL_NAMES = ["read_file", "list_files", "grep_search"] as const;

/** Names the read-only types may reach — exported so tests can assert the block. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOL_NAMES);

export function getReadOnlyTools(): Tool[] {
    return READ_ONLY_TOOL_NAMES
        .map((name) => getTool(name))
        .filter((tool): tool is Tool => tool !== undefined);
}

// ── Contracts ────────────────────────────────────────────────

const EXPLORE_PROMPT = `You are an exploration sub-agent. You answer one question about a codebase and return the answer.

You have read_file, list_files and grep_search. You cannot write, edit or run anything, and no such tool exists here — do not ask for one.

How to work:
- Search before reading. grep_search finds the call sites; read only the ranges that matter.
- Stop as soon as the question is answered. There is no user to ask for clarification.

What to return:
- The answer itself, with file_path:line_number references.
- Only what the caller could not have found by opening one file: where things are, how they connect, what they would otherwise have to search for.
- Never paste file contents or long code blocks. Quote at most the few lines that are the answer.
- If the files do not answer the question, say what you checked and what you did not find. Do not guess.`;

const PLAN_PROMPT = `You are a planning sub-agent. You design an implementation and return the design.

You have read_file, list_files and grep_search. You cannot write, edit or run anything — the plan is your only output, and the caller applies it.

How to work:
- Read the code the change touches before designing around it.
- Follow the conventions of the files you read; a plan that contradicts them is wrong.
- Design the smallest change that does the job. Do not widen the scope.

What to return:
1. The files to change, in the order they should be changed.
2. For each one, what changes and why — enough that the caller can implement it without re-deriving the design.
3. Any decision or risk the caller has to weigh.

Return the plan itself. Reference file_path:line_number; never paste file contents.`;

const GENERAL_PROMPT = `You are a sub-agent. You complete the one task you were given and return its result.

You have the full tool set, except that you cannot spawn further sub-agents. Work the task to completion: read before you edit, verify what you changed, and keep a todo list if it has several steps.

How to work:
- Do exactly the task. Do not expand it, and do not ask questions — no user is watching this conversation.
- Read a file before editing it; the edit is rejected if it was not read, or changed since the read.
- If the task cannot be done as stated, do the part that can and report precisely what blocked the rest.

What to return:
- What you did, where (file_path:line_number), and how you verified it.
- What the caller needs in order to continue: what changed, what is left, what failed.
- Keep it short. This message is all the caller receives — none of your tool output crosses over.`;

const BUILTIN_PROMPTS: Record<SubAgentType, string> = {
    explore: EXPLORE_PROMPT,
    plan: PLAN_PROMPT,
    general: GENERAL_PROMPT,
};

// ── Custom agents (.claude/agents/*.md) ──────────────────────
//
// Same idea as a skill, different unit: the file names a sub-agent type. A
// custom agent named `explore` replaces the built-in one — the project's own
// definition of a task beats the generic one.

export interface CustomAgent {
    name: string;
    description: string;
    /** The tools it declared, resolved against the registry. */
    tools: Tool[];
    /** Whether a tools field was present in frontmatter. */
    toolsDeclared: boolean;
    prompt: string;
    source: "user" | "project";
}

export interface CustomAgentOptions {
    cwd?: string;
    home?: string;
    refresh?: boolean;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const cache = new Map<string, CustomAgent[]>();

function resolveTools(names: string[]): Tool[] {
    return names
        .map((name) => getTool(name))
        .filter((tool): tool is Tool => tool !== undefined)
        .filter((tool) => !SUBAGENT_EXCLUDED.has(tool.name));
}

function parseCustomAgent(filePath: string, source: CustomAgent["source"]): CustomAgent | null {
    let parsed;
    try {
        parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
    if (!parsed) return null;

    const values = parsed.values;
    const name = scalar(values.get("name")) || filePath.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
    if (!NAME_PATTERN.test(name)) return null;

    return {
        name,
        description: scalar(values.get("description")),
        tools: resolveTools(parseList(values.get("allowed-tools") ?? values.get("tools"))),
        toolsDeclared: values.has("allowed-tools") || values.has("tools"),
        prompt: parsed.prompt,
        source,
    };
}

function readAgentDirectory(directory: string, source: CustomAgent["source"]): CustomAgent[] {
    if (!existsSync(directory)) return [];
    let entries: string[];
    try {
        entries = readdirSync(directory);
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.toLowerCase().endsWith(".md"))
        .sort()
        .map((entry) => parseCustomAgent(join(directory, entry), source))
        .filter((agent): agent is CustomAgent => agent !== null);
}

/**
 * Project-level definitions win over user-level ones of the same name, so a
 * repository can pin the shape of a shared agent without editing $HOME.
 */
export function discoverCustomAgents(options: CustomAgentOptions = {}): CustomAgent[] {
    const cwd = resolve(options.cwd ?? process.cwd());
    const home = resolve(options.home ?? homedir());
    const key = `${cwd}\0${home}`;
    if (!options.refresh && cache.has(key)) return cache.get(key)!;

    const merged = new Map<string, CustomAgent>();
    for (const agent of readAgentDirectory(join(home, ".claude", "agents"), "user")) merged.set(agent.name, agent);
    for (const agent of readAgentDirectory(join(cwd, ".claude", "agents"), "project")) merged.set(agent.name, agent);

    const result = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache.set(key, result);
    return result;
}

export function clearCustomAgentCache(): void {
    cache.clear();
}

/** Advertised in the agent tool's prompt block, so the model knows they exist. */
export function describeCustomAgents(): string {
    const agents = discoverCustomAgents();
    if (agents.length === 0) return "";
    const listed = agents
        .map((agent) => `- ${agent.name}${agent.description ? `: ${agent.description}` : ""}`)
        .join("\n");
    return `Custom sub-agents defined in .claude/agents/ — pass the name as "type":\n${listed}`;
}

// ── Configuration ────────────────────────────────────────────

export interface SubAgentConfig {
    systemPrompt: string;
    tools: Tool[];
    maxTokens: number;
}

/**
 * Tools a delegated task cannot use meaningfully: `agent` would recurse,
 * `ask_user` has no user callback, and plan mode belongs to the parent session.
 */
const SUBAGENT_EXCLUDED = new Set(["agent", "ask_user", "enter_plan_mode", "exit_plan_mode"]);

function getGeneralTools(): Tool[] {
    return getAllTools().filter((tool) => !SUBAGENT_EXCLUDED.has(tool.name));
}

/**
 * The configuration for one sub-agent type, by name.
 *
 * A custom agent of the same name wins outright — its prompt, its tools, its
 * source — because it is the project's own answer to "what is an explore
 * agent". Without one, the built-in contract applies. A name that is neither
 * is served the general configuration: an unrecognised type is a naming
 * mistake, and a delegation that runs is more useful than one that refuses.
 */
export function getSubAgentConfig(type: string): SubAgentConfig {
    const name = type.trim().toLowerCase();
    const custom = discoverCustomAgents().find((agent) => agent.name === name);
    if (custom) {
        // Omitting allowed-tools opts into the general set. A declared list is
        // an allowlist: unknown or excluded names are dropped, and an empty
        // result stays empty instead of silently granting broader access.
        const tools = custom.toolsDeclared ? custom.tools : getGeneralTools();
        return {
            systemPrompt: buildSubAgentSystemPrompt(custom.prompt, tools),
            tools,
            maxTokens: SUBAGENT_MAX_TOKENS,
        };
    }

    const builtin = isSubAgentType(name) ? name : DEFAULT_SUBAGENT_TYPE;
    const tools = builtin === "general" ? getGeneralTools() : getReadOnlyTools();
    return {
        systemPrompt: buildSubAgentSystemPrompt(BUILTIN_PROMPTS[builtin], tools),
        tools,
        maxTokens: SUBAGENT_MAX_TOKENS,
    };
}

export function isSubAgentType(name: string): name is SubAgentType {
    return (SUBAGENT_TYPES as readonly string[]).includes(name);
}

/**
 * The type name to run under: a built-in, a custom agent, or the general
 * fallback. Used by the caller as well as here, so the label it prints and the
 * configuration it gets always agree.
 */
export function resolveSubAgentName(value: unknown): string {
    const name = String(value ?? "").trim().toLowerCase();
    if (isSubAgentType(name)) return name;
    if (discoverCustomAgents().some((agent) => agent.name === name)) return name;
    return DEFAULT_SUBAGENT_TYPE;
}

/**
 * The sub-agent system prompt: its contract, then its tool guidance, then where
 * it is running. Nothing from the main prompt — the persona, the skills index,
 * CLAUDE.md and the memory index are all about a conversation the sub-agent is
 * not having, and re-sending them per request is the cost this feature exists
 * to avoid.
 */
function buildSubAgentSystemPrompt(contract: string, tools: Tool[]): string {
    return [
        contract,
        tools.length > 0 ? buildToolPromptBlock(tools) : "No tools are available to this sub-agent.",
        buildEnvironmentContext(),
    ].filter((part) => part.length > 0).join("\n\n");
}
