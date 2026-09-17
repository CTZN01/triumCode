import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { buildToolPromptBlock, getDeferredToolNames } from "./tools.js";

// ═══════════════════════════════════════════════════════════════
// CLAUDE.md loader — walk up from cwd collecting project instructions
// ═══════════════════════════════════════════════════════════════

// Resolve @include directives: `@include ./path/to/file.md` → file contents,
// resolved relative to the including file's directory. One level only.
function resolveIncludes(content: string, baseDir: string): string {
    return content.replace(
        /^@include\s+(.+)$/gm,
        (_match, target: string) => {
            const absPath = resolve(baseDir, target.trim());
            try {
                return readFileSync(absPath, "utf-8");
            } catch {
                return `<!-- @include not found: ${target.trim()} -->`;
            }
        },
    );
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
// System prompt assembly — static (cacheable) + dynamic blocks
// ═══════════════════════════════════════════════════════════════

const PERSONA = `You are Triumph Code, a small coding agent CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.
 - When fixing a bug, identify the root cause before changing code.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push --force,
   dropping tables), confirm with the user before proceeding.
 - Do not run commands that modify the system globally unless explicitly asked.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell equivalents
   (cat, sed, ls, grep). Reserve run_command for actual program execution.
 - If several tool calls are independent, make them in parallel.
 - Always read a file before editing or writing to it.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.
 - Do not apologize for things that are not your fault.
 - Use the user's language (Chinese if they write in Chinese).`;

// Static block: persona + tool usage guidance. Constant within a session,
// cacheable across turns via prompt caching.
export function buildStaticSystemPrompt(): string {
    const toolBlock = buildToolPromptBlock();
    return toolBlock ? `${PERSONA}\n\n${toolBlock}` : PERSONA;
}

// Dynamic block: environment, git, CLAUDE.md, deferred tools.
// Rebuilt each turn because git status and deferred tools can change.
export function buildDynamicSystemContext(): string {
    const platform = `${os.platform()} ${os.arch()}`;
    const shell = process.platform === "win32"
        ? (process.env.ComSpec || "cmd.exe")
        : (process.env.SHELL || "/bin/sh");

    const deferred = getDeferredToolNames();
    const deferredLine = deferred.length > 0
        ? `\n\nDeferred tools (activate via tool_search): ${deferred.join(", ")}`
        : "";

    return [
        "# Environment",
        `Working directory: ${process.cwd()}`,
        `Platform: ${platform}`,
        `Shell: ${shell}`,
        getGitContext(),
        deferredLine,
        loadClaudeMd(),
    ].filter((s) => s.length > 0).join("\n");
}

// User-context reminder: CLAUDE.md + current date. Injected once as a
// <system-reminder> block in the first user message, so the model sees it
// without it being part of the (cached) system prompt.
export function buildUserContextReminder(): string {
    const date = new Date().toISOString().split("T")[0];
    const claudeMd = loadClaudeMd();

    const parts: string[] = [];
    if (claudeMd) parts.push(claudeMd);
    parts.push(`# currentDate\nToday's date is ${date}.`);

    return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
}
