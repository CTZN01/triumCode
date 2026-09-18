import chalk from "chalk";

// ═══════════════════════════════════════════════════════════════
// Terminal UI — all user-visible output goes through here
// ═══════════════════════════════════════════════════════════════

// ── Welcome banner ──────────────────────────────────────────

export function printWelcome(model: string): void {
    console.log(chalk.bold("\n  triumph code"));
    console.log(chalk.dim(`  model: ${model}`));
    console.log(chalk.dim("  /help for commands · Ctrl+C to interrupt · exit to quit\n"));
}

// ── User prompt ─────────────────────────────────────────────

export function printUserPrompt(): void {
    process.stdout.write(chalk.cyan("\nYou: "));
}

// ── Info / error / interrupt ────────────────────────────────

export function printInfo(msg: string): void {
    console.log(chalk.dim(`  ${msg}`));
}

export function printError(msg: string): void {
    console.log(chalk.red(`  Error: ${msg}`));
}

export function printInterrupted(): void {
    console.log(chalk.yellow("\n  (interrupted)"));
}

// ── Tool call display ───────────────────────────────────────
// Human-readable verbs and result summaries — the model calls tools,
// the UI translates into Claude Code–style action narration.

const TOOL_VERBS: Record<string, string> = {
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    list_files: "List",
    grep_search: "Search",
    run_command: "Run",
    tool_search: "Search tools",
};

function formatCallTarget(name: string, input: Record<string, any>): string {
    switch (name) {
        case "read_file":
        case "write_file":
        case "edit_file":
            return input.file_path ?? "";
        case "list_files":
            return input.directory_path ?? "";
        case "grep_search":
            return `"${input.pattern}" in ${input.path}`;
        case "run_command": {
            const args = Array.isArray(input.args) ? input.args.join(" ") : "";
            return `${input.command} ${args}`.trim();
        }
        default:
            return JSON.stringify(input).slice(0, 80);
    }
}

export function printToolCall(name: string, input: Record<string, any>): void {
    const verb = TOOL_VERBS[name] ?? name;
    const target = formatCallTarget(name, input);
    const detail = target ? chalk.gray(`(${target})`) : "";
    console.log(chalk.yellow(`  ⏺ ${verb}`) + (detail ? ` ${detail}` : ""));
}

function summarizeResult(name: string, result: string): string {
    if (result.startsWith("Error")) return chalk.red(result.split("\n")[0]);

    switch (name) {
        case "read_file": {
            const lines = result.split("\n").length;
            return `${lines} lines`;
        }
        case "write_file":
        case "edit_file":
            return result.split("\n")[0];
        case "list_files": {
            const entries = result.split("\n").filter(l => !l.startsWith("(")).length;
            return `${entries} entries`;
        }
        case "grep_search": {
            const matchCount = result.split("\n").filter(l => l.includes(":")).length;
            if (result.includes("No matches")) return "no matches";
            return `${matchCount} matches`;
        }
        case "run_command": {
            return result.split("\n")[0];
        }
        default:
            return `${result.length} chars`;
    }
}

export function printToolResult(name: string, result: string, elapsedMs: number): void {
    const summary = summarizeResult(name, result);
    console.log(chalk.dim(`    ↳ ${summary} (${elapsedMs}ms)`));
}

export function printToolError(name: string, error: string): void {
    console.log(chalk.red(`    ↳ Error: ${error}`));
}

// ── Streaming output ────────────────────────────────────────

export function writeStream(text: string): void {
    process.stdout.write(text);
}

export function endStream(): void {
    process.stdout.write("\n");
}

// ── Cost report ─────────────────────────────────────────────

export function printCostReport(usage: { input: number; output: number; cost: number }): void {
    console.log(chalk.bold("\n  Token usage:"));
    console.log(`    Input:  ${chalk.cyan(String(usage.input))}`);
    console.log(`    Output: ${chalk.cyan(String(usage.output))}`);
    if (usage.cost > 0) {
        console.log(`    Cost:   ${chalk.yellow("$" + usage.cost.toFixed(4))}`);
    }
}

// ── Help text ───────────────────────────────────────────────

export function printHelp(): void {
    console.log(`
Usage: triumph [options] [prompt]

Options:
  --api-key KEY    Anthropic API key (or set ANTHROPIC_API_KEY / .env)
  --api-base URL   API base URL (or set ANTHROPIC_BASE_URL / .env)
  --model, -m      Model to use (default: from MINI_MODEL env or .env)
  --thinking       Enable thinking/reasoning mode
  --resume [id]    Resume a saved session (latest, or by ID prefix)
  --sessions       List all sessions and exit
  --yolo, -y       Bypass all permission prompts
  --plan           Plan mode: read-only, no edits
  --max-cost N     Stop after $N spent
  --max-turns N    Stop after N conversation turns
  --help, -h       Show this help

Configuration (in order of priority):
  1. CLI flags (--api-key, --model, --api-base)
  2. .env file in project root
  3. Environment variables
  4. ~/.triumph/config.json (saved by first-run setup)

REPL Commands:
  /clear           Clear conversation history
  /cost            Show token usage and estimated cost
  /compact         Compress conversation history (future)
  /plan            Toggle plan mode
  /sessions        List all saved sessions
  /delete <id>     Delete a saved session
  /help            Show this help
  exit, quit       Exit the REPL
`);
}
