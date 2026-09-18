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

// ── Line tracking ───────────────────────────────────────────
// Streamed model text is written without a trailing newline, so the cursor
// can be left mid-line. Everything else that prints (tool calls, results,
// info) must break the line first, or it gets glued onto the model's text.

let lineOpen = false;

// Emit a newline if the cursor is currently mid-line.
//
// Suspending the status line belongs here rather than in logLine(): once a
// status frame is drawn, the cursor is sitting on that row, so *any* write
// that moves the cursor has to erase it first. printUserPrompt() and
// printInterrupted() call this directly and would otherwise bypass the erase.
function ensureLineBreak(): void {
    suspendStatus();
    if (lineOpen) {
        process.stdout.write("\n");
        lineOpen = false;
    }
}

// console.log for output that may interleave with streaming.
function logLine(text: string): void {
    ensureLineBreak();
    console.log(text);
}

// Multi-line output that is not a single status-aware line (help text, the
// session table). Ends on a fresh line so a redrawn spinner lands below it.
export function printBlock(text: string): void {
    ensureLineBreak();
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

// ── Runtime status line ─────────────────────────────────────
// A one-line spinner pinned to the bottom of the terminal while the model is
// working, so a long API call or a slow tool never looks like a hang.
//
// Two flags, plus the invariant that ties them together:
//   statusActive  — a status is conceptually running
//   statusVisible — a frame is on screen, i.e. the cursor is on that row
// Every writer must go through ensureLineBreak()/writeStream(), which suspend
// the frame before touching the cursor. Erase is guarded by statusVisible and
// is never unconditional: an unconditional \x1b[2K\r at a live prompt would
// wipe the "You: " line the user is typing into.
//
// Frames are braille and labels are ASCII. Do not "improve" this with ✳ or …:
// both are East_Asian_Width=Ambiguous, so a zh-CN terminal renders them two
// columns wide and the truncation maths below breaks.

const STATUS_TICK_MS = 80;

// Hold off this long before drawing. Without it a fast API call would draw and
// erase a single frame every turn; it also throttles the redraw after output.
const STATUS_ARM_MS = 250;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const SPINNER_VERBS = [
    "Pondering", "Deciphering", "Noodling", "Percolating", "Synthesizing",
    "Cogitating", "Mulling", "Deliberating", "Ruminating", "Conjuring",
];

const STATUS_COLOR = chalk.hex("#D97757");

/** A label, or a function re-evaluated every frame (for live counts). */
export type StatusLabel = string | (() => string);

let statusActive = false;
let statusVisible = false;
let statusArmedAt = 0;
let statusStartedAt = 0;
let statusLabel: StatusLabel = "";
let statusFrame = 0;
let statusTimer: NodeJS.Timeout | null = null;

// Read lazily so tests can stub process.stdout.
function isTty(): boolean {
    return Boolean(process.stdout.isTTY);
}

/** Pick a random gerund for a turn, Claude Code style. */
export function pickStatusVerb(): string {
    return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

function resolveLabel(): string {
    try {
        return typeof statusLabel === "function" ? statusLabel() : statusLabel;
    } catch {
        return "";
    }
}

/**
 * Draw a frame. Called by the tick; exported so tests can drive frames
 * against a frozen clock instead of racing a real timer. `force` repaints a
 * frame that is already on screen (used when the label changes).
 */
export function renderStatus(now: number, force = false): void {
    if (!isTty() || !statusActive) return;
    if (!force && now - statusArmedAt < STATUS_ARM_MS) return;

    // Repaint in place. Do NOT skip when already visible — anything that
    // prints calls suspendStatus() first, so a still-visible frame is by
    // definition the last thing on screen, and skipping here would freeze both
    // the animation and the elapsed counter at their first-frame values.
    if (statusVisible) process.stdout.write("\x1b[2K\r");

    const cols = process.stdout.columns || 80;
    const frame = SPINNER_FRAMES[statusFrame++ % SPINNER_FRAMES.length];
    const prefix = `  ${frame} `;
    const suffix = `... (${formatElapsed(now - statusStartedAt)})`;

    // Truncate the plain text, then colour it — slicing a coloured string can
    // cut an SGR sequence in half.
    const budget = cols - 2 - prefix.length - suffix.length;
    if (budget < 4) return;   // too narrow to say anything useful

    process.stdout.write("\x1b[2K\r" + STATUS_COLOR(prefix + resolveLabel().slice(0, budget) + suffix));
    statusVisible = true;
}

// Erase the frame, keeping the status active so the next tick redraws it below
// whatever was just printed.
function suspendStatus(): void {
    if (!isTty()) return;
    if (statusVisible) {
        process.stdout.write("\x1b[2K\r");
        statusVisible = false;
    }
    statusArmedAt = Date.now();
}

function ensureStatusTimer(): void {
    if (statusTimer) return;
    statusTimer = setInterval(() => renderStatus(Date.now()), STATUS_TICK_MS);
    // A spinner must never be the reason the process stays alive.
    statusTimer.unref();
}

/** Start (or resume) the status line. Restarts the clock only when inactive. */
export function beginStatus(label?: StatusLabel): void {
    if (!isTty()) return;
    if (label !== undefined) statusLabel = label;
    if (!statusActive) {
        statusActive = true;
        statusStartedAt = Date.now();
    }
    statusArmedAt = Date.now();
    ensureStatusTimer();
}

/** Change the label without restarting the clock. */
export function updateStatus(label: StatusLabel): void {
    if (!isTty()) return;
    statusLabel = label;
    if (statusActive && statusVisible) renderStatus(Date.now(), true);
    else statusArmedAt = Date.now();
}

/** Stop the status line and clear the timer. Idempotent. */
export function endStatus(): void {
    if (!isTty()) return;
    suspendStatus();
    statusActive = false;
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
}

/** Current status state. Exported for tests. */
export function statusSnapshot(): { active: boolean; visible: boolean; label: string } {
    return { active: statusActive, visible: statusVisible, label: resolveLabel() };
}

function formatElapsed(ms: number): string {
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs}s`;
    return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

/** "Thought for 2s" — shown when the API returns a thinking block. */
export function printThinkingDuration(ms: number): void {
    logLine(chalk.dim(`  Thought for ${formatElapsed(ms)}`));
}

// ── User prompt ─────────────────────────────────────────────

export function printUserPrompt(): void {
    // Hard stop, not just a hide: readline re-renders the prompt row from its
    // own buffer, so a tick firing 80ms from now would erase the prompt and
    // desync the cursor for everything the user types. The SIGINT handler
    // calls askQuestion() synchronously, before the agent loop's finally runs,
    // so this is the only place that can guarantee the teardown.
    endStatus();
    ensureLineBreak();
    process.stdout.write(chalk.cyan("\nYou: "));
    // The line is ended by the user's own echo + Enter, not by us.
    lineOpen = false;
}

// ── Info / error / interrupt ────────────────────────────────

export function printInfo(msg: string): void {
    logLine(chalk.dim(`  ${msg}`));
}

export function printError(msg: string): void {
    logLine(chalk.red(`  Error: ${msg}`));
}

export function printInterrupted(): void {
    ensureLineBreak();
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
    logLine(chalk.yellow(`  ⏺ ${verb}`) + (detail ? ` ${detail}` : ""));
}

export interface ResultView {
    text: string;
    ok: boolean;
    // Finished, but did not do what the model asked. Only tools.ts:97 does
    // this today: a write rejected because the file changed under us.
    warn?: boolean;
}

/**
 * Reduce a tool result to a one-line summary plus a success state.
 *
 * The repo-wide convention is that every tool failure returns a string
 * starting with "Error" (tools.ts) and that ToolExecutor turns a thrown tool
 * into "Error executing <name>: ..." (tool-executor.ts). "Warning:" is the one
 * non-Error signal that still means nothing happened.
 *
 * A non-zero run_command exit is deliberately NOT an error (see the tool
 * description in tools.ts) but is still worth marking as a failure here.
 */
export function classifyResult(name: string, result: string): ResultView {
    const firstLine = result.split("\n")[0];

    if (result.startsWith("Error") || result.startsWith("Unknown tool:")) {
        return { text: firstLine, ok: false };
    }
    if (firstLine.startsWith("Warning:")) {
        return { text: firstLine, ok: false, warn: true };
    }

    switch (name) {
        case "read_file":
            return { text: `${result.split("\n").length} lines`, ok: true };

        case "write_file":
            return { text: firstLine, ok: true };

        case "edit_file": {
            const m = /^Edited .* at line (\d+)$/.exec(firstLine);
            return { text: m ? `Edited at line ${m[1]}` : firstLine, ok: true };
        }

        case "list_files": {
            if (firstLine.startsWith("No files found")) return { text: "no files", ok: true };
            const entries = result.split("\n").filter((l) => l !== "" && !l.startsWith("(")).length;
            return { text: `${entries} entr${entries === 1 ? "y" : "ies"}`, ok: true };
        }

        case "grep_search": {
            if (firstLine.startsWith("No matches found")) return { text: "no matches", ok: true };
            // A capped search fails to answer the question, so it is not "ok".
            if (firstLine.startsWith("Too many matches")) {
                return { text: firstLine, ok: false, warn: true };
            }
            // The footer carries the true total when the list was truncated.
            const footer = result.split("\n").find((l) => l.startsWith("(showing"));
            const total = footer ? /of (\d+)\+? matches/.exec(footer) : null;
            if (total) return { text: `${total[1]} matches`, ok: true };
            const count = result.split("\n").filter((l) => !l.startsWith("(") && /:\d+:/.test(l)).length;
            return { text: `${count} match${count === 1 ? "" : "es"}`, ok: true };
        }

        case "run_command": {
            // First line is "<status> · <ms>ms" (tools.ts) — the timing is
            // dropped because printToolResult appends its own.
            const status = firstLine.replace(/ · \d+ms$/, "");
            const exit = /^exit (\d+)$/.exec(status);
            return { text: status, ok: exit ? exit[1] === "0" : false };
        }

        default:
            return { text: `${result.length} chars`, ok: true };
    }
}

export function printToolResult(name: string, result: string, elapsedMs: number): void {
    const view = classifyResult(name, result);
    const mark = view.ok ? chalk.green("✓") : view.warn ? chalk.yellow("!") : chalk.red("✗");
    const paint = view.ok ? chalk.dim : view.warn ? chalk.yellow : chalk.red;
    logLine(paint(`    ↳ ${mark} ${view.text} (${elapsedMs}ms)`));
}

export function printToolError(name: string, error: string): void {
    logLine(chalk.red(`    ↳ ✗ Error: ${error}`));
}

// ── Turn outcome ────────────────────────────────────────────
// Printed only when a turn stops for a reason the model's own output doesn't
// explain. Silence means the model finished normally — which is exactly the
// distinction that used to be invisible: a truncated turn, an empty turn, and
// a completed turn all just returned to the prompt.

export function printTurnEnd(reason: string): void {
    logLine(chalk.yellow(`  ! ${reason}`));
}

// ── Streaming output ────────────────────────────────────────

export function writeStream(text: string): void {
    // Ends the status, and does so *before* the write: a frame left on screen
    // would occupy the same row as the first chunk of model text, and the
    // erase would take the text with it.
    endStatus();
    process.stdout.write(text);
    lineOpen = !text.endsWith("\n");
}

// Terminate the streamed line, but only if one is actually open — a turn that
// emitted no text (tool calls only) must not gain a stray blank line.
export function endStream(): void {
    ensureLineBreak();
}

// ── Cost report ─────────────────────────────────────────────

export function printCostReport(usage: { input: number; output: number; cost: number }): void {
    logLine(chalk.bold("\n  Token usage:"));
    logLine(`    Input:  ${chalk.cyan(String(usage.input))}`);
    logLine(`    Output: ${chalk.cyan(String(usage.output))}`);
    if (usage.cost > 0) {
        logLine(`    Cost:   ${chalk.yellow("$" + usage.cost.toFixed(4))}`);
    }
}

// ── Help text ───────────────────────────────────────────────

export function printHelp(): void {
    printBlock(`
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
  --max-tokens N   Max output tokens per request (default: 32000). Thinking
                   counts towards this, so raise it if reasoning eats the reply
  --max-turns N    Stop after N agent-loop turns (default: 25)
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
