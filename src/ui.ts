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

function getToolIcon(name: string): string {
    const icons: Record<string, string> = {
        read_file: "📖",
        write_file: "✏️",
        edit_file: "✏️",
        list_files: "📁",
        grep_search: "🔍",
        run_command: "💻",
        tool_search: "🔧",
    };
    return icons[name] ?? "⚙️";
}

function summarizeInput(name: string, input: Record<string, any>): string {
    switch (name) {
        case "read_file":
        case "list_files":
            return input.file_path ?? input.directory_path ?? "";
        case "write_file":
            return input.file_path ?? "";
        case "edit_file":
            return input.file_path ?? "";
        case "grep_search":
            return `${input.pattern} in ${input.path}`;
        case "run_command": {
            const args = Array.isArray(input.args) ? input.args.join(" ") : "";
            return `${input.command} ${args}`.trim();
        }
        default:
            return JSON.stringify(input).slice(0, 80);
    }
}

export function printToolCall(name: string, input: Record<string, any>): void {
    const icon = getToolIcon(name);
    const summary = summarizeInput(name, input);
    console.log(chalk.yellow(`\n  ${icon} ${name}`) + (summary ? chalk.gray(` ${summary}`) : ""));
}

export function printToolResult(name: string, result: string, elapsedMs: number): void {
    // Show a truncated preview for long results.
    const maxLen = 500;
    const truncated = result.length > maxLen
        ? result.slice(0, maxLen) + chalk.gray(`\n    ... (${result.length} chars total)`)
        : result;

    console.log(chalk.dim(truncated.split("\n").map((l) => "    " + l).join("\n")));
    console.log(chalk.green(`  ✓ ${name}`) + chalk.dim(` (${elapsedMs}ms)`));
}

export function printToolError(name: string, error: string): void {
    console.log(chalk.red(`  ✗ ${name}: ${error}`));
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
