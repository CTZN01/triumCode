import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { buildToolPromptBlock, getDeferredToolNames } from "./tools.js";
import { buildSkillPromptBlock } from "./skills.js";
import { buildMemoryPromptSection } from "./memory.js";

// ═══════════════════════════════════════════════════════════════
// CLAUDE.md loader — walk up from cwd collecting project instructions
// ═══════════════════════════════════════════════════════════════

// Resolve @include directives: `@include ./path/to/file.md` → file contents,
// resolved relative to the including file's directory. One level only.
const INCLUDE_REGEX = /^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)$/gm;
const MAX_INCLUDE_DEPTH = 5;

function resolveIncludes(
  content: string,
  basePath: string,
  visited: Set<string> = new Set(),
  depth: number = 0
): string {
  if (depth >= MAX_INCLUDE_DEPTH) return content;
  return content.replace(INCLUDE_REGEX, (_match, rawPath: string) => {
    let resolved: string;
    if (rawPath.startsWith("~/")) {
      resolved = join(os.homedir(), rawPath.slice(2));
    } else if (rawPath.startsWith("/")) {
      resolved = rawPath;
    } else {
      resolved = resolve(basePath, rawPath);  // ./relative
    }
    resolved = resolve(resolved);
    if (visited.has(resolved)) return `<!-- circular: ${rawPath} -->`;
    if (!existsSync(resolved)) return `<!-- not found: ${rawPath} -->`;
    try {
      visited.add(resolved);
      const included = readFileSync(resolved, "utf-8");
      return resolveIncludes(included, dirname(resolved), visited, depth + 1);
    } catch {
      return `<!-- error reading: ${rawPath} -->`;
    }
  });
}

// Walk up from `startDir` to the filesystem root, collecting every CLAUDE.md
// found. Files closer to cwd come first (child overrides parent).
function collectClaudeMdFiles(startDir: string): string[] {
    const parts: string[] = [];
    let dir = startDir;

    while (true) {
        const file = join(dir, "CLAUDE.md");
        if (existsSync(file)) {
            try {
                let content = readFileSync(file, "utf-8");
                content = resolveIncludes(content, dir);
                parts.unshift(content);  // parent before child
            } catch { /* unreadable — skip silently */ }
        }
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
    }

    return parts;
}

// Load `.claude/rules/*.md` from the project root (cwd).
function loadRulesDir(cwd: string): string {
    const rulesDir = join(cwd, ".claude", "rules");
    if (!existsSync(rulesDir)) return "";

    let entries: string[];
    try {
        entries = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
        return "";
    }

    const blocks: string[] = [];
    for (const entry of entries) {
        try {
            blocks.push(readFileSync(join(rulesDir, entry), "utf-8"));
        } catch { /* skip unreadable */ }
    }

    return blocks.length > 0
        ? "\n\n# Rules (.claude/rules/)\n" + blocks.join("\n\n---\n\n")
        : "";
}

// Full CLAUDE.md content: walk-up files + rules directory.
export function loadClaudeMd(): string {
    const cwd = process.cwd();
    const parts = collectClaudeMdFiles(cwd);
    const rules = loadRulesDir(cwd);

    const claudeMd = parts.length > 0
        ? "\n\n# Project Instructions (CLAUDE.md)\n" + parts.join("\n\n---\n\n")
        : "";

    return claudeMd + rules;
}

// ═══════════════════════════════════════════════════════════════
// Git context — branch, recent commits, working tree status
// ═══════════════════════════════════════════════════════════════

export function getGitContext(): string {
    try {
        const opts = { encoding: "utf-8" as const, timeout: 3000 };
        const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
        const log = execSync("git log --oneline -5", opts).trim();
        const status = execSync("git status --short", opts).trim();

        let result = `\nGit branch: ${branch}`;
        if (log) result += `\nRecent commits:\n${log}`;
        if (status) result += `\nGit status:\n${status}`;
        return result;
    } catch {
        return "";
    }
}

// ═══════════════════════════════════════════════════════════════
// System prompt assembly — one cacheable block + a volatile reminder
// ═══════════════════════════════════════════════════════════════
//
// The split here is not cosmetic, it is the difference between a cache hit and
// a full re-read of the conversation.
//
// The system prompt sits at the front of the request, ahead of every message,
// and prompt caching matches on a byte-exact prefix. Anything that changes
// between two requests therefore invalidates the cache not just for itself but
// for the entire history behind it — the whole conversation is re-processed at
// full price. Git status changes every time the agent writes a file, which is
// constantly, so a `git status` call in the system prompt costs a full history
// re-read on almost every write.
//
// So: everything session-stable goes in the system prompt (cached once), and
// everything volatile goes in a <system-reminder> prepended to the user's
// message, which is a new message every turn and invalidates nothing.

const PERSONA = `You are TriumCode, an interactive coding agent that helps with software engineering tasks.

# Doing tasks

When given a task, do exactly what was asked — no more, no less.

- Do not propose changes to code you haven't read. Read files first.
- Do not create files unless necessary. Prefer editing existing files.
- When fixing a bug, identify the root cause before changing code.

# Planning

Before making changes to more than one file, or when the task has multiple steps, outline your approach first:

1. Read the relevant files to understand the current state.
2. Present a concise plan: what files to change, what the changes are, and why.
3. Wait for the user to approve, reject, or modify the plan.
4. Execute only after approval.

Skip the plan when the task is trivial — a single edit, a one-line fix, or a question you can answer from what you have already read.

Use the todo tool to create a task list at the start of multi-step work. Update todo status as you progress (pending → in_progress → completed). This helps track progress and keeps you focused.

# Asking questions

When you are unsure, ask. Do not guess and proceed.

- If the task is ambiguous or admits multiple valid approaches, ask the user which one they prefer before starting.
- If you discover something unexpected while reading code (e.g. the architecture differs from what you assumed), pause and confirm your understanding before continuing.
- If a decision has lasting consequences (naming, API shape, which library to use), ask before committing to it.

Frame questions concisely — a short sentence with 2-3 options is better than a paragraph of analysis. The user is a developer; they can ask for details if they want them.

Anti-patterns to avoid:
- Do NOT expand scope. Fixing a bug does not license refactoring surrounding code. Three similar lines of code are better than a premature abstraction.
- Do NOT add defensive code for scenarios that cannot happen. If a function only receives validated input, do not wrap it in try-catch or add null checks "just in case."
- Do NOT over-abstract. If you see three lines of similar code, leave them. An abstraction is justified only when the pattern has diverged at least twice and is likely to diverge again.
- Do NOT add comments, docstrings, or JSDoc to code you didn't write unless the user asks for it.
- Do NOT rename variables, reorder imports, or change formatting in files you are not otherwise modifying.

# Acting with care

Every action has a blast radius. Classify before you act.

| | Reversible | Irreversible |
|---|---|---|
| **Local only** | Edit a file, run a local test | Write a file that didn't exist before |
| **Shared / external** | Commit to a local branch | Push to remote, delete cloud resources, publish a package |

- Local + reversible = proceed without asking.
- Irreversible or shared = confirm with the user first.
- One user approval covers only the current action. Permission to do X once does not imply permission to do X again or Y similarly.

Destructive patterns that always require confirmation: \`rm -rf\`, \`git push --force\`, dropping databases, deleting cloud resources, publishing packages.

# Using your tools

Use the dedicated tools — they have structured I/O, fine-grained permissions, and parallelism built in.

| Instead of... | Use... | Why |
|---|---|---|
| cat / head / tail | read_file | Tracks read state, enforces read-before-write |
| sed / awk | edit_file | Exact string match, rejects stale writes |
| find / ls -R | list_files | Filters noise (node_modules, .git), depth-limited |
| grep / rg | grep_search | Structured output, scan ceiling, regex validation |
| shell execution | run_command | No shell — safer, explicit args, timeout enforced |

- If several tool calls are independent, make them in parallel.
- Always read a file before editing or writing to it. The edit will be rejected if the file hasn't been read or was modified since.
- Reserve run_command for actual program execution (node, python, git, npm). Do not use it to simulate shell builtins.

# Tone and style

- Lead with the answer. Explain only when the user asks or when the explanation prevents a mistake.
- Keep responses short. The user is a developer — do not narrate what you are about to do; just do it.
- Planning is not narration. When the task is non-trivial, present the plan and wait — that is the work, not preamble.
- Do not narrate between tool calls. Saying "Let me read the file" before read_file is noise — just call the tool. The UI shows what you are doing.
- Reference code as file_path:line_number (e.g. \`src/agent.ts:42\`).
- Do not apologize for things that are not your fault.
- Use the user's language. If they write in Chinese, respond in Chinese.

# Output efficiency

- Do not summarize what you just did at the end of a turn — the user can see the tool output.
- Do not repeat the same information in prose that is already visible in a code block or tool result.
- When multiple small changes are needed in the same file, batch them into one edit_file call rather than making several sequential edits.
- When the task is simple (one file, one edit), respond with just the tool call and a one-line confirmation. No preamble.`;

const PLAN_MODE = `

# Plan mode (strict)

You are in strict plan mode. ALWAYS present a plan before making any changes, even for trivial tasks.
During planning you may read files and search code, but do NOT edit, write, or run commands that modify files.
Execute only after the user explicitly approves the plan.`;

// The system prompt: everything constant for the session, in the order the
// model reads it. Cached as one block by the caller.
//
// The memory index is the one part that can change mid-session (the agent
// saves a memory, and the index should show it on the next turn). That costs
// one cache miss per save, which is rare and worth the freshness.
export function buildStaticSystemPrompt(planMode = false): string {
    const toolBlock = buildToolPromptBlock();
    const skillBlock = buildSkillPromptBlock();
    const persona = planMode ? PERSONA + PLAN_MODE : PERSONA;
    return [
        persona,
        toolBlock,
        skillBlock,
        buildEnvironmentContext(),
        loadClaudeMd(),
        buildMemoryPromptSection(),
    ].filter(Boolean).join("\n\n");
}

// Probe common development tools on Windows to give the model actionable
// context about .cmd shims and available runtimes. The result cannot change
// within a session, so it is probed once and memoized — it used to spawn two
// processes on every single request.
let probedTools: string | null = null;

function probeWindowsTools(): string {
    if (probedTools !== null) return probedTools;
    probedTools = probeWindowsToolsUncached();
    return probedTools;
}

function probeWindowsToolsUncached(): string {
    if (process.platform !== "win32") return "";

    const probes: string[] = [];
    const opts = { encoding: "utf-8" as const, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[] };

    try {
        const nodeVersion = execSync("node -v", opts).trim();
        probes.push(`node: ${nodeVersion}`);
    } catch {
        probes.push("node: not found");
    }

    try {
        const npmPaths = execSync("where npm", opts).trim().split(/\r?\n/);
        const npmCmd = npmPaths.find(l => l.trim().toLowerCase().endsWith(".cmd"));
        if (npmCmd) probes.push(`npm: ${npmCmd.trim()} (run_command auto-resolves this .cmd shim)`);
    } catch {
        probes.push("npm: not found");
    }

    if (probes.length === 0) return "";

    return `\nKnown tool paths:\n${probes.map(p => `- ${p}`).join("\n")}`;
}

// Where the session is running. Constant for the whole session, so it belongs
// in the cached system prompt rather than in the per-turn reminder.
function buildEnvironmentContext(): string {
    const platform = `${os.platform()} ${os.arch()}`;
    const shell = process.platform === "win32"
        ? (process.env.ComSpec || "cmd.exe")
        : (process.env.SHELL || "/bin/sh");

    return [
        "# Environment",
        `Working directory: ${process.cwd()}`,
        `Platform: ${platform}`,
        `Shell: ${shell}`,
        probeWindowsTools(),
    ].filter((s) => s.length > 0).join("\n");
}

// The volatile half: git state, the date, and which deferred tools are still
// behind tool_search. Prepended to the user's message for the turn.
//
// This must not move into the system prompt. Git status changes on every file
// the agent writes, and a changing byte in the system prompt invalidates the
// cache for the whole conversation behind it. Here it costs its own few dozen
// tokens, on a message that is new anyway, and invalidates nothing.
export function buildTurnContextReminder(): string {
    const date = new Date().toISOString().split("T")[0];

    const parts: string[] = [];
    const git = getGitContext().trim();
    if (git) parts.push(git);

    const deferred = getDeferredToolNames();
    if (deferred.length > 0) {
        parts.push(`Deferred tools (activate via tool_search): ${deferred.join(", ")}`);
    }
    parts.push(`# currentDate\nToday's date is ${date}.`);

    return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
}
