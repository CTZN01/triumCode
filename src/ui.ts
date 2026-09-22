import chalk from "chalk";
import { isAbsolute, relative, resolve } from "node:path";
import {
    describeSource, maskSecret,
    type ConfigDeprecation, type ResolvedConfigBundle, type ConfigSource,
} from "./config.js";
import { MarkdownStream } from "./markdown.js";

// ═══════════════════════════════════════════════════════════════
// Terminal UI — all user-visible output goes through here
// ═══════════════════════════════════════════════════════════════

// ── Palette ─────────────────────────────────────────────────
// Codex-style terminal palette: cool cyan for interaction, quiet slate for
// structure, and restrained colors reserved for tool state.
const ACCENT = chalk.hex("#67D4E8");   // prompt, live status, choices
const MUTED  = chalk.hex("#7D8796");   // bullets, targets, metadata
const OK     = chalk.hex("#7BCFA3");   // success
const WARN   = chalk.hex("#E3B86B");   // warning
const ERR    = chalk.hex("#F08088");   // failure
// Inline code in model output. A hue of its own on purpose: every colour above
// carries a meaning (success, warning, failure), and code is not one of them.
const CODE   = chalk.hex("#C792EA");

// ── Welcome banner ──────────────────────────────────────────

export function printWelcome(model: string): void {
    console.log(chalk.bold("\n  TriumCode"));
    console.log(chalk.dim(`  model: ${model}`));
    console.log(chalk.dim("  /help for commands · Ctrl+C to interrupt · exit to quit\n"));
}

// ── Line tracking ───────────────────────────────────────────
// Streamed model text is written without a trailing newline, so the cursor
// can be left mid-line. Everything else that prints (tool calls, results,
// info) must break the line first, or it gets glued onto the model's text.

let lineOpen = false;

// True when the last thing printed was tool activity (a call, a result, a
// thinking duration). Model text arriving after it opens with a blank line,
// so each prose block reads as a unit with the tool lines it produced below
// it, instead of everything gluing into one wall.
let afterToolOutput = false;

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

const STATUS_COLOR = ACCENT;
const THINKING_COLOR = chalk.white;

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

// Sweep: a bold head with a short bright trail crosses the label
// left-to-right, then a short still pause before the next pass — a comet,
// not a strobe. Adjacent same-style chars share one SGR run so the frame
// is a handful of escape sequences, not one per character.
const SWEEP_TRAIL = 2;
const SWEEP_PAUSE = 6;

function renderAnimatedLabel(label: string): string {
    const text = label || "Working";
    const chars = [...text];
    const head = statusFrame % (chars.length + SWEEP_PAUSE);
    const style = (i: number): "head" | "trail" | "dim" => {
        const d = head - i;
        if (d === 0) return "head";
        if (d > 0 && d <= SWEEP_TRAIL) return "trail";
        return "dim";
    };
    const paint = {
        head: (s: string) => THINKING_COLOR.bold(s),
        trail: (s: string) => THINKING_COLOR(s),
        dim: (s: string) => THINKING_COLOR.dim(s),
    };

    let out = "";
    let run = "";
    let runStyle = style(0);
    for (let i = 0; i < chars.length; i++) {
        const s = style(i);
        if (s !== runStyle) {
            out += paint[runStyle](run);
            run = "";
            runStyle = s;
        }
        run += chars[i];
    }
    if (run) out += paint[runStyle](run);
    return out;
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
    statusFrame++;
    const prefix = "  ";
    const suffix = `... (${formatElapsed(now - statusStartedAt)})`;

    // Truncate the plain text, then colour it — slicing a coloured string can
    // cut an SGR sequence in half.
    const budget = cols - 2 - prefix.length - suffix.length;
    if (budget < 4) return;   // too narrow to say anything useful

    const label = resolveLabel();
    const renderedLabel = renderAnimatedLabel(label.slice(0, budget));
    process.stdout.write("\x1b[2K\r" + THINKING_COLOR(prefix) + renderedLabel + THINKING_COLOR(suffix));
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

export interface SessionStatus {
    model: string;
    effort: string;
    contextPercent: number;
    mode: string;
}

/** Print the compact session footer above the readline prompt. */
export function printSessionStatus(status: SessionStatus): void {
    const percent = Math.max(0, status.contextPercent);
    const context = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
    // Empty effort/mode segments are dropped — an "effort: default" line
    // tells the user nothing.
    const state = [
        status.effort && `effort: ${status.effort}`,
        `context: ${context}`,
        status.mode && `mode: ${status.mode}`,
    ].filter((p): p is string => Boolean(p)).join(" | ");

    const indent = "  ";
    const model = `model: ${status.model}`;
    const cols = process.stdout.columns || 80;
    const budget = isTty() ? Math.max(20, cols - 1) : Infinity;
    const room = budget - indent.length - (state ? state.length + 3 : 0);

    // The model name is the longest segment and the one that changes least, so
    // it is the segment that gives way. Cutting the tail instead — as this did —
    // drops effort, context and mode off the line, and a preset name is easily
    // long enough to do it.
    let text: string;
    if (room >= 8) {
        const shown = model.length <= room ? model : model.slice(0, room - 3) + "...";
        text = indent + shown + (state ? ` | ${state}` : "");
    } else if (room >= 0) {
        // The state fits but the name does not; the state is what the user
        // cannot get anywhere else on screen.
        text = indent + state;
    } else {
        const full = indent + model + (state ? ` | ${state}` : "");
        text = full.slice(0, Math.max(0, budget - 3)) + "...";
    }

    // Every turn, with a blank line above so it doesn't crowd the reply.
    ensureLineBreak();
    console.log();
    logLine(chalk.dim(text));
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
    afterToolOutput = true;
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
    process.stdout.write("\n");
    // The input prompt is owned by readline, not by the status renderer.
    lineOpen = false;
    afterToolOutput = false;
}

/** Add breathing room between the submitted input and model output. */
export function printTurnStart(): void {
    ensureLineBreak();
    process.stdout.write("\n");
}

// ── Info / error / interrupt ────────────────────────────────

export function printInfo(msg: string): void {
    logLine(chalk.dim(`  ${msg}`));
}

export function printError(msg: string): void {
    logLine(ERR(`  Error: ${msg}`));
}

export function printInterrupted(): void {
    ensureLineBreak();
    console.log(WARN("\n  (interrupted)"));
}

/**
 * One-line notice that a saved conversation was restored — at startup via
 * --continue/--resume, or mid-session via /resume. The date is formatted by the
 * caller; everything else here is display only.
 */
export function printSessionResumed(id: string, messageCount: number, title: string, when: string): void {
    const name = title.length <= 50 ? title : title.slice(0, 47) + "...";
    const detail = [
        `${messageCount} message${messageCount === 1 ? "" : "s"}`,
        `"${name}"`,
        when,
    ].filter(Boolean).join(" - ");
    logLine(`  ${OK("✓")} resumed session ${ACCENT(id.slice(0, 8))} ${MUTED(`- ${detail}`)}`);
}

// ── Tool call display ───────────────────────────────────────
// Human-readable verbs and result summaries — the model calls tools,
// the UI translates into Claude Code–style action narration.

const TOOL_VERBS: Record<string, string> = {
    read_file: "Read",
    write_file: "Write",
    edit_file: "Edit",
    multi_edit: "Edit",
    list_files: "List",
    grep_search: "Search",
    run_command: "Run",
    ask_user: "Asking",
    tool_search: "Search tools",
    skill: "Load skill",
    enter_plan_mode: "Enter plan mode",
    exit_plan_mode: "Exit plan mode",
    git_diff: "Git diff",
    todo: "Todo",
};

// Paths read best relative to the cwd — "src/agent.ts" instead of
// "D:\triumph_code\src\agent.ts". Targets outside the cwd keep their absolute
// form; separators are normalized to "/" either way, so Windows paths stop
// eating half the line width. Purely cosmetic: never used for file access.
function displayPath(p: string): string {
    const rel = relative(process.cwd(), resolve(process.cwd(), p));
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        return rel.replaceAll("\\", "/");
    }
    return p.replaceAll("\\", "/");
}

function formatCallTarget(name: string, input: Record<string, any>): string {
    switch (name) {
        case "read_file":
        case "write_file":
        case "edit_file":
        case "multi_edit":
            return input.file_path ? displayPath(String(input.file_path)) : "";
        case "list_files":
            return input.directory_path ? displayPath(String(input.directory_path)) : "";
        case "grep_search": {
            const pattern = String(input.pattern ?? "");
            return input.path ? `"${pattern}" in ${displayPath(String(input.path))}` : `"${pattern}"`;
        }
        case "run_command": {
            const args = Array.isArray(input.args) ? input.args.join(" ") : "";
            return `${input.command} ${args}`.trim();
        }
        case "ask_user": {
            const q = String(input.question ?? "");
            const preview = q.length > 60 ? q.slice(0, 57) + "..." : q;
            const opts = Array.isArray(input.options) ? ` (${input.options.length} options)` : "";
            return `"${preview}"${opts}`;
        }
        case "skill":
            return String(input.name ?? "");
        case "git_diff": {
            const parts: string[] = [];
            if (input.staged) parts.push("staged");
            if (input.path) parts.push(displayPath(String(input.path)));
            return parts.join(" ");
        }
        case "todo": {
            if (input.operation === "write") {
                const count = Array.isArray(input.todos) ? input.todos.length : 0;
                return `write ${count} item${count === 1 ? "" : "s"}`;
            }
            return String(input.operation ?? "");
        }
        default:
            return JSON.stringify(input).slice(0, 80);
    }
}

export function printToolCall(name: string, input: Record<string, any>): void {
    const verb = TOOL_VERBS[name] ?? name;
    const target = formatCallTarget(name, input);
    afterToolOutput = true;
    if (!target) {
        logLine(`  ${MUTED("•")} ${verb}`);
        return;
    }
    // Truncate the plain text before colouring it — slicing a coloured string
    // can cut an SGR sequence in half. A long run_command script used to wrap
    // across three rows and bury everything around it.
    const cols = process.stdout.columns || 80;
    const budget = Math.max(12, cols - verb.length - 8);
    const shown = target.length > budget ? target.slice(0, budget - 3) + "..." : target;
    logLine(`  ${MUTED("•")} ${verb} ${MUTED(shown)}`);
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

        case "edit_file":
        case "multi_edit": {
            const single = /^Edited .* at line (\d+)(?: \(([^)]+)\))?/.exec(firstLine);
            if (single) return { text: `Edited at line ${single[1]}${single[2] ? ` ${single[2]}` : ""}`, ok: true };
            // Non-greedy: the first parenthetical is the line stats; a later
            // one ("showing 3 of 4 regions") is a display note, not the summary.
            const many = /^Edited (\d+) \w+ in .*?\(([^)]+)\)/.exec(firstLine);
            if (many) return { text: `Edited ${many[1]} place${many[1] === "1" ? "" : "s"} ${many[2]}`, ok: true };
            return { text: firstLine, ok: true };
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

        case "ask_user": {
            if (firstLine.startsWith("Error")) return { text: firstLine, ok: false };
            if (result === "") return { text: "skipped", ok: true };
            return { text: `answered: ${result.length > 40 ? result.slice(0, 37) + "..." : result}`, ok: true };
        }

        case "todo": {
            if (firstLine.startsWith("Error")) return { text: firstLine, ok: false };
            if (firstLine === "No todos.") return { text: "0 todos", ok: true };
            const totalMatch = /Total: (\d+) \| Completed: (\d+)\/(\d+)/.exec(result);
            if (totalMatch) return { text: `${totalMatch[2]}/${totalMatch[3]} completed`, ok: true };
            return { text: firstLine, ok: true };
        }

        default:
            return { text: `${result.length} chars`, ok: true };
    }
}

export function printToolResult(name: string, result: string, elapsedMs: number): void {
    const view = classifyResult(name, result);
    afterToolOutput = true;
    const mark = view.ok ? OK("✓") : view.warn ? WARN("!") : ERR("✗");
    const text = view.ok ? chalk.dim(view.text) : view.warn ? WARN(view.text) : ERR(view.text);
    logLine(chalk.dim("    ↳ ") + `${mark} ${text}` + chalk.dim(` (${elapsedMs}ms)`));
}

export function printToolError(name: string, error: string): void {
    afterToolOutput = true;
    logLine(chalk.dim("    ↳ ") + ERR(`✗ Error: ${error}`));
}

// ── Sub-agent activity ──────────────────────────────────────
// A sub-agent's own output is captured into a buffer (agent.ts), so these two
// lines are the whole trace a delegation leaves on screen. They replace the
// usual tool-call/tool-result pair rather than joining it: the description is
// already the tool call's target, and a one-line "✓ done" for a task that ran
// for a minute says less than the token count does.

export function printSubAgentStart(type: string, description: string): void {
    afterToolOutput = true;
    const label = description ? `${type} · ${description}` : type;
    logLine(`  ${MUTED("•")} ${ACCENT("Agent")} ${MUTED(label)}`);
}

export function printSubAgentEnd(type: string, description: string, tokens: number): void {
    afterToolOutput = true;
    logLine(
        chalk.dim("    ↳ ") + `${OK("✓")} ${chalk.dim(subAgentLabel(type, description))}`
        + chalk.dim(` (${tokens.toLocaleString("en-US")} tokens)`),
    );
}

/** The delegation failed. The parent continues; the user should still see why. */
export function printSubAgentError(type: string, description: string, error: string): void {
    afterToolOutput = true;
    const first = error.split("\n")[0];
    logLine(chalk.dim("    ↳ ") + `${ERR("✗")} ${ERR(subAgentLabel(type, description))} ${chalk.dim(`— ${first}`)}`);
}

function subAgentLabel(type: string, description: string): string {
    return description ? `${type} · ${description}` : type;
}

// ── Interactive question ──────────────────────────────────
// Displayed when the agent calls ask_user to get input mid-turn.

/**
 * The question line alone, for a caller that renders its own option list — the
 * arrow-key picker draws the choices and its own key hint, so numbering them
 * here as well would show the same list twice.
 */
export function printQuestionHead(question: string): void {
    ensureLineBreak();
    // Inquirer-style "?" — an emoji here renders double-width in zh-CN
    // terminals and visually dwarfs the text around it.
    console.log(`\n  ${OK("?")} ${chalk.bold(ACCENT(question))}`);
}

export function printQuestion(question: string, options?: string[]): void {
    printQuestionHead(question);
    if (options && options.length > 0) {
        for (let i = 0; i < options.length; i++) {
            console.log(ACCENT(`    ${i + 1}. ${options[i]}`));
        }
    }
    console.log(chalk.dim("    Press Enter to skip without answering."));
}

/**
 * Echo a choice made with the arrow keys. Selecting with a picker leaves no
 * trace of what was chosen once the highlight is gone, so without this the
 * answer is invisible in the transcript.
 */
export function printAnswer(answer: string): void {
    logLine(`  ${OK("✓")} ${answer}`);
}

// One line of a Codex-style strip picker: `low  [high]  xhigh`. The selection
// is bracketed and accent-colored; ASCII only, so a zh-CN terminal keeps
// every column aligned. Redrawn in place with \r\x1b[K by the caller.
export function renderPickStrip(options: readonly string[], selected: number, maxWidth = Infinity): string {
    const separatorWidth = Math.max(0, options.length - 1);
    const wrapperWidth = options.length * 2;
    const labelWidth = Math.max(3, Math.floor((maxWidth - separatorWidth - wrapperWidth) / Math.max(1, options.length)));
    const labels = options.map((option) => {
        if (option.length <= labelWidth) return option;
        return labelWidth <= 3 ? option.slice(0, labelWidth) : option.slice(0, labelWidth - 3) + "...";
    });
    return labels
        .map((option, i) => (i === selected ? ACCENT(`[${option}]`) : MUTED(` ${option} `)))
        .join(" ");
}

/** Render one model-pick option per line so long names cannot wrap the picker. */
export function renderPickList(options: readonly string[], selected: number): string[] {
    return options.map((option, i) => i === selected ? ACCENT(`[${option}]`) : MUTED(` ${option} `));
}

// ── Turn outcome ────────────────────────────────────────────
// Printed only when a turn stops for a reason the model's own output doesn't
// explain. Silence means the model finished normally — which is exactly the
// distinction that used to be invisible: a truncated turn, an empty turn, and
// a completed turn all just returned to the prompt.

export function printTurnEnd(reason: string): void {
    logLine(WARN(`  ! ${reason}`));
}

// ── Streaming output ────────────────────────────────────────

// Model output is markdown, and it is printed as such: `**bold**` losing its
// asterisks is the difference between reading a reply and reading its source.
// The renderer holds back only undecided characters, so text still appears as
// it arrives (see markdown.ts).
const markdown = new MarkdownStream({ bold: chalk.bold, muted: MUTED, accent: ACCENT, code: CODE });

/** Print already-rendered stream text, opening an indented line if needed. */
function emitStream(rendered: string): void {
    // Ends the status, and does so *before* the write: a frame left on screen
    // would occupy the same row as the first chunk of model text, and the
    // erase would take the text with it.
    endStatus();
    if (!lineOpen && afterToolOutput) {
        process.stdout.write("\n");
        afterToolOutput = false;
    }

    // Indent the margin on every line, not just the one the chunk happens to
    // start on. A chunk is whatever the API sent, so "\n\nnext paragraph"
    // arrives glued to the end of one — indenting only the chunk's first line
    // left the rest of the reply flush against the terminal edge, at a
    // different column from the line above it. Blank lines get no margin, or
    // the terminal shows trailing whitespace on them.
    const parts = rendered.split("\n");
    let out = "";
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) out += "\n";
        const atLineStart = i > 0 || !lineOpen;
        if (atLineStart && parts[i] !== "") out += "  ";
        out += parts[i];
    }

    process.stdout.write(out);
    lineOpen = !rendered.endsWith("\n");
}

export function writeStream(text: string): void {
    const rendered = markdown.write(text);
    // A chunk that was entirely held back prints nothing at all — including no
    // indentation, and without stopping the spinner a beat early.
    if (rendered) emitStream(rendered);
}

/**
 * Print a whole chunk of model text, markdown and all.
 *
 * The same rendering path as writeStream — this is not a second renderer — for
 * callers that hold text rather than stream it. A sub-agent accumulates its
 * output and emits it in one piece, so its markdown has to resolve here too:
 * printing it raw would show the asterisks.
 */
export function printAssistantText(text: string): void {
    writeStream(text);
}

// Terminate the streamed line, but only if one is actually open — a turn that
// emitted no text (tool calls only) must not gain a stray blank line.
export function endStream(): void {
    // Release whatever the renderer was still holding: a trailing `*`, or a
    // line start that never resolved into a list or heading. It is real model
    // output, so it gets printed rather than dropped.
    const held = markdown.flush();
    if (held) emitStream(held);
    ensureLineBreak();
    // A message boundary is a document boundary. Without this, a message that
    // ended on an unclosed `**` or fence would leave bold or code switched on,
    // and the next message would be rendered inside it.
    markdown.reset();
}

/** Reset streaming state. Exported for tests: each fake terminal starts clean. */
export function resetStreamState(): void {
    lineOpen = false;
    afterToolOutput = false;
    markdown.reset();
}

// ── Cost report ─────────────────────────────────────────────

export function printCostReport(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheHitRate: number;
    cost: number;
}): void {
    const count = (n: number) => n.toLocaleString("en-US");
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

    logLine(chalk.bold("\n  Token usage:"));
    logLine(`    Input:        ${chalk.cyan(count(usage.input))}  ${chalk.dim("(uncached)")}`);
    // The cache line is the one worth watching: a rate that drops is the
    // signature of something volatile sitting in the cached prefix, and every
    // point it loses is a full re-read of the conversation.
    logLine(`    Cache read:   ${chalk.cyan(count(usage.cacheRead))}  ${chalk.dim(`(${(usage.cacheHitRate * 100).toFixed(1)}% of ${count(prompt)} prompt tokens)`)}`);
    logLine(`    Cache write:  ${chalk.cyan(count(usage.cacheWrite))}`);
    logLine(`    Output:       ${chalk.cyan(count(usage.output))}`);
    if (usage.cost > 0) {
        logLine(`    Cost:         ${chalk.yellow("$" + usage.cost.toFixed(4))}`);
    }
}

// ── Plan approval ──────────────────────────────────────────

export function printPlanForApproval(planContent: string): void {
    ensureLineBreak();
    console.log(ACCENT("\n  ━━━ Plan for Approval ━━━"));
    const lines = planContent.split("\n");
    const maxLines = 60;
    const display = lines.slice(0, maxLines);
    for (const line of display) {
        console.log(chalk.white("  " + line));
    }
    if (lines.length > maxLines) {
        console.log(chalk.gray(`  ... (${lines.length - maxLines} more lines)`));
    }
    console.log(ACCENT("  ━━━━━━━━━━━━━━━━━━━━━━\n"));
}

export function printPlanApprovalOptions(): void {
    console.log(WARN("  Choose an option:"));
    console.log("    1) Clear context and execute — fresh start with auto-accept edits");
    console.log("    2) Execute — keep context, auto-accept edits");
    console.log("    3) Manual — keep context, confirm each edit");
    console.log("    4) Keep planning — provide feedback to revise");
}

export function printPlanModeEntered(planFilePath: string): void {
    printInfo(`Entered plan mode (read-only). Plan file: ${planFilePath}`);
}

export function printPlanModeExited(targetMode: string): void {
    printInfo(`Exited plan mode → ${targetMode} mode`);
}

// ── Config report ───────────────────────────────────────────
//
// Answers "where is this actually coming from?" before the user has to ask.
// ASCII only — see maskSecret(); a double-width glyph would skew the columns
// in a zh-CN terminal.

export function printConfigReport(bundle: ResolvedConfigBundle): void {
    const { config, sources, conflicts, deprecations } = bundle;

    const rows: Array<[string, string, ConfigSource]> = [
        ["endpoint", config.apiBase, sources.apiBase],
        ["model",    config.model,   sources.model],
        ["protocol", config.protocol, sources.protocol],
        ["auth",     config.auth,    sources.auth],
        ["api key",  maskSecret(config.apiKey), sources.apiKey],
        ["thinking", config.thinking ? "on" : "off", sources.thinking],
        ["effort",   config.effort || "-", sources.effort],
    ];

    const labelW = Math.max(...rows.map(([l]) => l.length));
    const valueW = Math.max(...rows.map(([, v]) => v.length));

    const lines = [chalk.bold("\n  Configuration"), ""];
    for (const [label, value, source] of rows) {
        lines.push(
            `    ${chalk.dim(label.padEnd(labelW))}  ${value.padEnd(valueW)}  ${chalk.dim(`(${describeSource(source)})`)}`,
        );
    }

    if (conflicts.length > 0) {
        lines.push("", chalk.yellow("  Overridden:"));
        for (const c of conflicts) {
            lines.push(chalk.yellow(
                `    ${c.field} = ${c.shadowedValue}  (from ${describeSource(c.shadowed)}, ignored)`,
            ));
        }
        lines.push(chalk.dim("    The values above win. Unset the variable, or pass the CLI flag."));
    }

    if (deprecations.length > 0) {
        lines.push("", chalk.yellow("  Deprecated:"));
        for (const d of deprecations) {
            lines.push(chalk.yellow(
                `    ${d.variable} is still read, but is named from before the rename`,
            ));
            lines.push(chalk.dim(`    rename it to ${d.replacement} to keep the setting when it goes`));
        }
    }

    printBlock(lines.join("\n"));
}

/**
 * The deprecation notice for a normal startup.
 *
 * Kept apart from printConfigReport so a run with nothing else to report stays
 * quiet: the report is long, and the startup path only needs to mention the
 * variable that is about to stop working.
 */
export function printDeprecations(deprecations: ConfigDeprecation[]): void {
    for (const d of deprecations) {
        logLine(WARN(`  ! ${d.variable} is deprecated — rename it to ${d.replacement}`));
    }
}

// ── Help text ───────────────────────────────────────────────

export function printHelp(): void {
    printBlock(`
Usage: triumcode [options] [prompt]

Options:
  --api-key KEY    API key (or saved in ~/.triumcode/config.json)
  --api-base URL   API base URL (or saved in ~/.triumcode/config.json)
  --model, -m      Model to use
  --protocol NAME  Wire protocol: anthropic (default) | openai-chat |
                   openai-responses. A model gateway serves each model through
                   one of these, so the model choice usually decides this
  --auth SCHEME    How the key travels: api-key (x-api-key) | bearer
                   (Authorization). Defaults to what the protocol expects
  --thinking       Enable extended thinking. On by default for current Claude
                   models, and on by default for everything else too; this
                   forces it on for any other model as well
  --no-thinking    Disable extended thinking for this session
  --effort LEVEL   Thinking depth: low | medium | high | xhigh | max
                   (default: high; also adjustable mid-session via /effort)
  --resume [id]    Resume a saved session: the most recent one, or by ID
                   prefix. Each project's sessions are stored separately, keyed
                   by its root directory
  --continue       Resume the most recent session in this project (the same as
                   a bare --resume)
  --new            Start a new session, leaving saved ones untouched. This is
                   the default; --continue and --resume override it
  --sessions       List all sessions and exit
    --yolo, -y       Bypass ordinary prompts (configured deny rules still apply)
  --plan           Plan mode: read-only, no edits
  --max-cost N     Stop after $N spent
  --max-tokens N   Max output tokens per request (default: 32000). Thinking
                   counts towards this, so raise it if reasoning eats the reply
    --context-window N  Context window size in tokens; k/M suffixes work
                        (e.g. 200k, 1M)
  --max-turns N    Stop after N agent-loop turns (default: 25)
  --help, -h       Show this help

Configuration (in order of priority):
  1. CLI flags (--api-key, --model, --api-base, --protocol, --auth)
  2. ~/.triumcode/config.json (saved by first-run setup)
  3. Environment variables (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL,
     TRIUMCODE_MODEL, TRIUMCODE_PROTOCOL, TRIUMCODE_AUTH,
     TRIUMCODE_EFFORT, TRIUMCODE_CONTEXT_WINDOW)
     The older MINI_MODEL and MINI_CONTEXT_WINDOW still work, but are
     deprecated and will stop being read in a future release
  4. Built-in defaults

REPL Commands:
  /clear           Clear the current conversation (empties this session)
  /new             Start a new conversation; the previous session is kept and
                   stays visible under /sessions
  /resume [id]     Resume a saved session. A bare /resume opens a picker over
                   this project's sessions
  /config          Show the active endpoint, model and API key, and which
                   source each one came from
  /cost            Show token usage and estimated cost
  /compact         Compress conversation history (future)
  /plan            Toggle plan mode
  /effort [level]  Show or change reasoning effort (low..max); a bare /effort
                   opens a picker (up/down arrows, Enter confirms).
                   Thinking turns on with it
  /thinking [on|off]  Show or toggle extended thinking
  /model [name]    Switch model; a bare /model opens a picker over the
                   "models" presets in ~/.triumcode/config.json. A preset may
                   also retarget the endpoint, key, protocol and context window
  /memory          List saved long-term memories
  /sessions        List all saved sessions
  /delete <id>     Delete a saved session
  /help            Show this help
  exit, quit       Exit the REPL
`);
}
