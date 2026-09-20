import { Agent } from "./agent.js";
import * as readline from "node:readline";
import chalk from "chalk";
import {
    saveSession, loadSession, listSessions, deleteSession,
    latestSessionId, type SessionIndex,
} from "./session.js";
import {
    printWelcome, printUserPrompt, printInfo, printError,
    printInterrupted, printHelp, printCostReport, printBlock, printTurnStart, endStatus,
    printConfigReport, printQuestion, printSessionStatus, renderPickList, printDeprecations,
} from "./ui.js";
import { ensureConfig, describeSource, parseSizeTokens, getModelPresets, type ModelPreset } from "./config.js";
import { parseEffort, EFFORT_LEVELS, type EffortLevel } from "./thinking.js";
import {
    parseAuthScheme, parseProtocol, AUTH_SCHEMES, PROTOCOLS,
} from "./providers/types.js";
import { getSkill, resolveSkillPrompt } from "./skills.js";
import { listMemories } from "./memory.js";

// ═══════════════════════════════════════════════════════════════
// Argument parsing
// ═══════════════════════════════════════════════════════════════

interface CliFlags {
    resume: string | null;   // null = no --resume; "" = --resume (latest); "abc" = --resume abc
    sessions: boolean;       // --sessions: list and exit
    model: string;           // --model / -m
    apiKey: string;          // --api-key
    apiBase: string;         // --api-base
    protocol: string;        // --protocol anthropic|openai-chat|openai-responses
    auth: string;            // --auth api-key|bearer
    thinking: boolean | undefined;  // --thinking; undefined = resolve from config/env/default
    noThinking: boolean;     // --no-thinking (thinking is on by default)
    effort: string;          // --effort low|medium|high|xhigh|max
    permissionMode: string;  // --yolo / -y, --plan, --accept-edits, --dont-ask
    maxCost: number | undefined;
    maxTurns: number | undefined;
    maxTokens: number | undefined;
    contextWindow: number | undefined;
    help: boolean;           // --help / -h
    oneShot: string;         // remaining args joined (non-interactive)
}

function parseArgs(argv: string[]): CliFlags {
    const flags: CliFlags = {
        resume: null,
        sessions: false,
        model: "",      // resolved later by config.ts
        apiKey: "",     // resolved later by config.ts
        apiBase: "",    // resolved later by config.ts
        protocol: "",   // resolved later by config.ts
        auth: "",       // resolved later by config.ts
        thinking: undefined,
        noThinking: false,
        effort: "",
        permissionMode: "default",
        maxCost: undefined,
        maxTurns: undefined,
        maxTokens: undefined,
        contextWindow: undefined,
        help: false,
        oneShot: "",
    };
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--api-key") {
            flags.apiKey = argv[++i] || flags.apiKey;
        } else if (arg === "--api-base") {
            flags.apiBase = argv[++i] || flags.apiBase;
        } else if (arg === "--protocol") {
            const v = argv[++i] || "";
            if (parseProtocol(v)) {
                flags.protocol = v;
            } else {
                printError(`--protocol must be one of: ${PROTOCOLS.join(", ")}`);
            }
        } else if (arg === "--auth") {
            const v = argv[++i] || "";
            if (parseAuthScheme(v)) {
                flags.auth = v;
            } else {
                printError(`--auth must be one of: ${AUTH_SCHEMES.join(", ")}`);
            }
        } else if (arg === "--resume") {
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                flags.resume = next;
                i++;
            } else {
                flags.resume = "";
            }
        } else if (arg === "--sessions") {
            flags.sessions = true;
        } else if (arg === "--model" || arg === "-m") {
            flags.model = argv[++i] || flags.model;
        } else if (arg === "--thinking") {
            flags.thinking = true;
        } else if (arg === "--no-thinking") {
            flags.noThinking = true;
        } else if (arg === "--effort") {
            const v = argv[++i] || "";
            if (parseEffort(v)) {
                flags.effort = v;
            } else {
                printError(`--effort must be one of: ${EFFORT_LEVELS.join(", ")}`);
            }
        } else if (arg === "--yolo" || arg === "-y") {
            flags.permissionMode = "bypassPermissions";
        } else if (arg === "--plan") {
            flags.permissionMode = "plan";
        } else if (arg === "--accept-edits") {
            flags.permissionMode = "acceptEdits";
        } else if (arg === "--dont-ask") {
            flags.permissionMode = "dontAsk";
        } else if (arg === "--max-cost") {
            const v = parseFloat(argv[++i]);
            if (!isNaN(v)) flags.maxCost = v;
        } else if (arg === "--max-turns") {
            const v = parseInt(argv[++i], 10);
            if (!isNaN(v)) flags.maxTurns = v;
        } else if (arg === "--max-tokens") {
            const v = parseInt(argv[++i], 10);
            if (!isNaN(v)) flags.maxTokens = v;
        } else if (arg === "--context-window") {
            // Accepts plain token counts and size suffixes: 200k, 1M, 1.5m.
            const v = parseSizeTokens(argv[++i]);
            if (v) flags.contextWindow = v;
            else printError("--context-window must be a positive token count, optionally with a k/M suffix (e.g. 200k, 1M)");
        } else if (arg === "--help" || arg === "-h") {
            flags.help = true;
        } else {
            rest.push(arg);
        }
    }

    flags.oneShot = rest.join(" ").trim();
    return flags;
}

// ═══════════════════════════════════════════════════════════════
// Display helpers
// ═══════════════════════════════════════════════════════════════

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function formatDate(iso: string): string {
    if (!iso) return "unknown";
    try {
        const d = new Date(iso);
        return d.toLocaleDateString("en-US", {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit",
            hour12: false,
        });
    } catch {
        return iso.slice(0, 10);
    }
}

function formatModel(model: string): string {
    return model.replace(/-\d{8}$/, "");
}

function printSessionTable(sessions: SessionIndex[], currentId: string | null): void {
    if (sessions.length === 0) {
        printBlock("  (no saved sessions)");
        return;
    }

    const idW = 8;
    const dateW = 18;
    const modelW = 16;
    const msgsW = 5;

    const hdr = [
        "  " + "ID".padEnd(idW),
        "Updated".padEnd(dateW),
        "Model".padEnd(modelW),
        "Msgs".padStart(msgsW),
        "Title",
    ].join("  ");

    // Built as one block so it reaches the terminal in a single write — a
    // multi-line table dribbled out line by line could get a spinner frame
    // appended mid-table.
    const lines = [hdr, "  " + "─".repeat(hdr.length - 2)];

    for (const s of sessions) {
        const marker = s.id === currentId ? " → " : "   ";
        lines.push([
            marker + s.id.slice(0, 8).padEnd(idW - marker.length + 1),
            formatDate(s.updated).padEnd(dateW),
            truncate(formatModel(s.model), modelW - 1).padEnd(modelW),
            String(s.messageCount).padStart(msgsW),
            truncate(s.title, 50),
        ].join("  "));
    }

    if (currentId && sessions.some((s) => s.id === currentId)) {
        lines.push("", `  → = current session (${currentId})`);
    }

    printBlock(lines.join("\n"));
}

// ═══════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
    const flags = parseArgs(argv);

    // --help: print usage and exit.
    if (flags.help) {
        printHelp();
        return;
    }

    // --sessions: print table and exit immediately.
    if (flags.sessions) {
        const sessions = listSessions();
        const current = latestSessionId();
        printSessionTable(sessions, current);
        return;
    }

    // Resolve config from all sources (CLI > ~/.triumcode/config.json > env).
    // If no API key is found anywhere, enters interactive first-run setup.
    // --no-thinking is the off switch for thinking's default-on.
    const bundle = await ensureConfig({
        ...flags,
        thinking: flags.thinking ?? (flags.noThinking ? false : undefined),
    });
    if (!bundle) process.exit(1);
    const config = bundle.config;

    // A lower-priority source holding a different value is exactly how a
    // session ends up talking to an endpoint the user never chose, so say so
    // up front rather than letting it be discovered from a bill.
    // Otherwise only the deprecated variables get a mention — the full report
    // already lists them, so printing both would say it twice.
    if (bundle.conflicts.length > 0) printConfigReport(bundle);
    else printDeprecations(bundle.deprecations);

    // A preset name is the route identity shown in the UI. Infer it only
    // when the resolved startup settings identify exactly one preset; equal
    // model IDs on different routes must remain explicit via /model.
    const startupPresets = getModelPresets();
    const startupLabels = Object.entries(startupPresets)
        .filter(([, preset]) => preset.model === config.model)
        .filter(([, preset]) => !preset.apiBase || preset.apiBase === config.apiBase)
        .filter(([, preset]) => !preset.protocol || preset.protocol === config.protocol)
        .filter(([, preset]) => !preset.auth || preset.auth === config.auth)
        .filter(([, preset]) => !preset.apiKey || preset.apiKey === config.apiKey)
        .map(([label]) => label);
    const startupModelLabel = startupLabels.length === 1 ? startupLabels[0] : "";

    const agent = new Agent({
        model: config.model,
        modelLabel: startupModelLabel,
        apiKey: config.apiKey,
        apiBase: config.apiBase,
        protocol: config.protocol,
        auth: config.auth,
        thinking: config.thinking,
        effort: config.effort,
        maxTokens: flags.maxTokens,
        maxTurns: flags.maxTurns,
        contextWindow: config.contextWindow,
        planMode: flags.permissionMode === "plan",
        permissionMode: flags.permissionMode as "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk",
    });

    // Wire up auto-save: after each chat(), persist the session.
    agent.setOnChatComplete(() => {
        saveSession(agent.history(), agent.getSessionStatus().model);
    });

    let pendingAskUser: ((answer: string) => void) | null = null;
    // --resume [id]: reload a saved conversation before doing anything else.
    if (flags.resume !== null) {
        const identifier = flags.resume === "" ? undefined : flags.resume;
        const saved = loadSession(identifier);
        if (saved) {
            agent.loadHistory(saved.messages as any);
            const preview = saved.title.length > 50 ? saved.title.slice(0, 50) + "…" : saved.title;
            printInfo(`resumed session ${saved.id.slice(0, 8)} — ${saved.messages.length} messages — "${preview}"`);
        } else {
            printInfo(`no session found${identifier ? ` matching "${identifier}"` : ""}`);
        }
    }

    // ── One-shot mode ────────────────────────────────────────────
    if (flags.oneShot) {
        agent.setAskUserCallback(async () => "Error: ask_user is unavailable in one-shot mode.");
        await agent.chat(flags.oneShot);
        return;
    }

    // ── Interactive REPL ─────────────────────────────────────────
    // `let` because the strip picker closes and rebuilds the interface
    // around itself (see stripPick).
    let rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // Set while the strip picker owns stdin, cleared by the caller once the
    // promise resolves. The SIGINT handler checks it because Ctrl+C can
    // surface as a signal even in raw mode (Windows).
    let activePickerCancel: (() => void) | null = null;

    /**
     * Codex-style strip picker: the options render as one horizontal line,
     * left/right moves the selection, Enter confirms, Esc or Ctrl+C cancels.
     * Needs a TTY (raw mode); resolves null without one so the caller can
     * fall back to a plain numbered prompt.
     *
     * The main readline interface is CLOSED for the duration, not paused:
     * a paused interface stops stdin's data flow, and keypress events are
     * fed by that flow — the picker would freeze with no way to receive
     * keys. Afterwards a fresh interface takes over.
     */
    const stripPick = (options: readonly string[], initial: number): Promise<number | null> => {
        return new Promise((resolve) => {
            if (!process.stdin.isTTY) {
                resolve(null);
                return;
            }
            let idx = initial;
            let done = false;
            const draw = () => {
                const instruction = "   <-/-> move, Enter confirm, Esc cancel";
                const lines = [...renderPickList(options, idx), chalk.dim(instruction)];
                const moveUp = lines.length > 1 ? `\x1b[${lines.length - 1}A` : "";
                process.stdout.write(moveUp + lines.map((line, i) =>
                    `\x1b[2K\r  ${line}${i < lines.length - 1 ? "\n" : ""}`,
                ).join(""));
            };
            const finish = (result: number | null) => {
                if (done) return;
                done = true;
                process.stdin.removeListener("keypress", onKeypress);
                process.stdin.setRawMode?.(false);
                process.stdout.write("\n");
                // Hand stdin back to a REPL interface; askQuestion() installs
                // its line listener on whatever `rl` holds by then.
                rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                resolve(result);
            };
            const onKeypress = (str: string, key: any) => {
                if (key?.name === "left") {
                    idx = (idx + options.length - 1) % options.length;
                    draw();
                } else if (key?.name === "right") {
                    idx = (idx + 1) % options.length;
                    draw();
                } else if (key?.name === "return" || key?.name === "enter") {
                    finish(idx);
                } else if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
                    // Raw mode delivers Ctrl+C as a keypress on Unix; finish()
                    // is idempotent, so a duplicate SIGINT delivery on Windows
                    // is harmless.
                    finish(null);
                }
            };
            readline.emitKeypressEvents(process.stdin);
            rl.close();
            // close() pauses stdin, and a paused stream emits no data —
            // keypress events are fed by that flow, and a paused stdin also
            // stops keeping the event loop alive (the process would exit
            // right after drawing the strip). Resume it explicitly.
            process.stdin.resume();
            process.stdin.setRawMode?.(true);
            process.stdin.on("keypress", onKeypress);
            activePickerCancel = () => finish(null);
            process.stdout.write("\n");
            draw();
        });
    };

    // ── SIGINT handling ──────────────────────────────────────────
    let sigintCount = 0;
    process.on("SIGINT", () => {
        // This handler runs synchronously, before the agent loop unwinds, and
        // askQuestion() below re-prompts immediately — so the status line has
        // to go first, or a tick lands on top of the live prompt.
        endStatus();

        // The strip picker owns stdin; Ctrl+C cancels the pick instead of
        // counting toward exit. finish() is idempotent, so a Ctrl+C that is
        // delivered both as keypress and as signal (Windows) stays a single
        // cancel.
        if (activePickerCancel) {
            activePickerCancel();
            sigintCount = 0;
            return;
        }

        // If the agent asked a question via ask_user, treat Ctrl+C as "skip".
        if (pendingAskUser) {
            const resolve = pendingAskUser;
            pendingAskUser = null;
            resolve("");
            sigintCount = 0;
            return;
        }

        if (agent.isProcessing) {
            agent.abort();
            printInterrupted();
            sigintCount = 0;
            askQuestion();
        } else {
            sigintCount++;
            if (sigintCount >= 2) {
                printBlock("\nBye!\n");
                process.exit(0);
            }
            printBlock("\n  Press Ctrl+C again to exit.");
            askQuestion();
        }
    });

    printWelcome(agent.getSessionStatus().model);
    printInfo(`endpoint ${config.apiBase} via ${config.protocol}  (${describeSource(bundle.sources.apiBase)}) - /config for details`);

    // ── REPL loop with rl.once (strict serial execution) ─────────
    // The session footer belongs to a completed model exchange — commands
    // like /config or /help clear this flag so they don't drag it along.
    let sessionFooterPending = false;
    const handleLine = async (line: string): Promise<void> => {
            const input = line.trim();
            sigintCount = 0;
            sessionFooterPending = false;

            // Empty line: re-prompt.
            if (!input) {
                // If the agent is waiting for an answer to ask_user, an empty
                // line means "skip" — return an empty string so the agent can
                // continue with its best judgment.
                if (pendingAskUser) {
                    const resolve = pendingAskUser;
                    pendingAskUser = null;
                    resolve("");
                    return;
                }
                askQuestion();
                return;
            }

            // ── ask_user response ─────────────────────────────────
            // If the agent asked a question via ask_user, forward the
            // user's input as the answer (options are validated by the
            // tool, not here — the model decides what to do with it).
            if (pendingAskUser) {
                const resolve = pendingAskUser;
                pendingAskUser = null;
                resolve(input);
                return;
            }

            // Exit.
            if (input === "exit" || input === "quit") {
                printBlock("\nBye!\n");
                rl.close();
                return;
            }

            // ── Slash commands ─────────────────────────────────────
            if (input === "/clear") {
                agent.clearHistory();
                saveSession(agent.history(), agent.getSessionStatus().model);
                printInfo("history cleared");
                askQuestion();
                return;
            }

            if (input === "/config") {
                printConfigReport(bundle);
                askQuestion();
                return;
            }

            if (input === "/cost") {
                printCostReport(agent.getUsage());
                askQuestion();
                return;
            }

            if (input === "/compact") {
                agent.compact();
                saveSession(agent.history(), agent.getSessionStatus().model);
                printInfo("history compacted");
                askQuestion();
                return;
            }

            if (input === "/plan") {
                agent.togglePlanMode();
                printInfo(`Plan mode: ${agent.planMode ? "ON" : "OFF"}`);
                askQuestion();
                return;
            }

            // ── Reasoning controls (adjustable mid-session) ─────────
            if (input === "/effort" || input.startsWith("/effort ")) {
                const arg = input.slice(7).trim();
                if (arg) {
                    const level = parseEffort(arg);
                    if (!level) {
                        printError(`/effort must be one of: ${EFFORT_LEVELS.join(", ")}`);
                    } else {
                        agent.setEffort(level);
                        printInfo(`thinking on, effort ${level}`);
                    }
                    askQuestion();
                    return;
                }
                // No argument: Codex-style strip picker when stdin is a TTY,
                // numbered prompt otherwise.
                endStatus();
                printTurnStart();
                const current = agent.getEffort();
                const initial = Math.max(0, EFFORT_LEVELS.indexOf(current ?? "high"));

                if (process.stdin.isTTY) {
                    const picked = await stripPick(EFFORT_LEVELS, initial);
                    if (picked === null) {
                        printInfo("cancelled");
                    } else {
                        const level = EFFORT_LEVELS[picked];
                        agent.setEffort(level);
                        printInfo(`thinking on, effort ${level}`);
                    }
                    askQuestion();
                    return;
                }

                printQuestion(
                    "Reasoning effort (thinking turns on):",
                    EFFORT_LEVELS.map((l) => `${l}${l === current ? "   <- current" : ""}`),
                );
                process.stdout.write(chalk.cyan("  Your answer: "));
                pendingAskUser = (answer) => {
                    const trimmed = answer.trim().toLowerCase();
                    if (!trimmed) {
                        printInfo("cancelled");
                        askQuestion();
                        return;
                    }
                    const level = (EFFORT_LEVELS as readonly string[]).includes(trimmed)
                        ? (trimmed as EffortLevel)
                        : EFFORT_LEVELS[parseInt(trimmed, 10) - 1];
                    if (!level) {
                        printError(`pick 1-${EFFORT_LEVELS.length} or one of: ${EFFORT_LEVELS.join(", ")}`);
                    } else {
                        agent.setEffort(level);
                        printInfo(`thinking on, effort ${level}`);
                    }
                    askQuestion();
                };
                rl.once("line", handleLine);
                return;
            }

            if (input === "/thinking" || input.startsWith("/thinking ")) {
                const arg = input.slice(9).trim().toLowerCase();
                if (!arg) {
                    const effort = agent.getEffort();
                    printInfo(`thinking is ${agent.isThinkingEnabled() ? "on" : "off"}${effort ? `, effort ${effort}` : ""}`);
                } else if (arg === "on" || arg === "true") {
                    agent.setThinking(true);
                    printInfo("thinking on");
                } else if (arg === "off" || arg === "false") {
                    agent.setThinking(false);
                    printInfo("thinking off");
                } else {
                    printError("usage: /thinking [on|off]");
                }
                askQuestion();
                return;
            }

            // ── Model switching ──────────────────────────────────
            if (input === "/model" || input.startsWith("/model ")) {
                const arg = input.slice(6).trim();
                const presets = getModelPresets();

                const apply = (label: string, preset: ModelPreset): void => {
                    agent.setModel({
                        model: preset.model,
                        apiBase: preset.apiBase,
                        apiKey: preset.apiKey,
                        protocol: preset.protocol,
                        auth: preset.auth,
                        contextWindow: preset.contextWindow,
                        // The preset name is what the footer shows, so two
                        // presets serving one model stay distinguishable.
                        label,
                    });
                    const where = preset.apiBase ? ` @ ${preset.apiBase}` : "";
                    const via = preset.protocol ? ` via ${preset.protocol}` : "";
                    printInfo(`model: ${label || preset.model}${where}${via}`);
                };

                if (arg) {
                    // A preset name wins; anything else is treated as a raw model id.
                    const preset = presets[arg];
                    if (preset) {
                        apply(arg, preset);
                    } else {
                        apply("", { model: arg });
                    }
                    askQuestion();
                    return;
                }

                const names = Object.keys(presets);
                if (names.length === 0) {
                    printError("no model presets - add a \"models\" map to ~/.triumcode/config.json, or use /model <model-id>");
                    askQuestion();
                    return;
                }

                // Bare /model: picker over the presets, current one marked.
                endStatus();
                printTurnStart();

                // Which preset the session is on. The label is the identity: two
                // presets can serve the same model string through different
                // endpoints, and matching on the model alone would mark both as
                // current. With no label, a model string still identifies a
                // preset as long as exactly one claims it.
                const currentIndex = ((): number => {
                    const label = agent.getModelLabel();
                    if (label && presets[label]) return names.indexOf(label);
                    const claimed = names.filter((n) => presets[n].model === agent.getModel());
                    return claimed.length === 1 ? names.indexOf(claimed[0]) : -1;
                })();

                if (process.stdin.isTTY) {
                    const picked = await stripPick(names, Math.max(0, currentIndex));
                    if (picked === null) {
                        printInfo("cancelled");
                    } else {
                        apply(names[picked], presets[names[picked]]);
                    }
                    askQuestion();
                    return;
                }

                printQuestion(
                    "Model:",
                    names.map((n, i) => `${n} (${presets[n].model})${i === currentIndex ? "   <- current" : ""}`),
                );
                process.stdout.write(chalk.cyan("  Your answer: "));
                pendingAskUser = (answer) => {
                    const trimmed = answer.trim();
                    const idx = parseInt(trimmed, 10) - 1;
                    const name = presets[trimmed] ? trimmed : names[idx];
                    if (!name || !presets[name]) {
                        printError(`pick 1-${names.length} or a preset name: ${names.join(", ")}`);
                    } else {
                        apply(name, presets[name]);
                    }
                    askQuestion();
                };
                rl.once("line", handleLine);
                return;
            }

            if (input === "/memory") {
                const memories = listMemories();
                if (memories.length === 0) {
                    printInfo("no memories saved yet");
                } else {
                    printInfo(`${memories.length} memories:`);
                    for (const m of memories) {
                        printInfo(`  [${m.source}] [${m.type}] ${m.name} - ${m.description}`);
                    }
                }
                askQuestion();
                return;
            }

            if (input === "/sessions") {
                const sessions = listSessions();
                const current = latestSessionId();
                printBlock("");
                printSessionTable(sessions, current);
                askQuestion();
                return;
            }

            if (input.startsWith("/delete")) {
                const id = input.slice(7).trim();
                if (!id) {
                    printError("Usage: /delete <session-id>");
                } else if (deleteSession(id)) {
                    printInfo(`session ${id} deleted`);
                } else {
                    printError(`session ${id} not found`);
                }
                askQuestion();
                return;
            }

            if (input === "/help") {
                printHelp();
                askQuestion();
                return;
            }

            // User-invocable skills share the slash-command surface. Skills
            // marked user-invocable=false remain available only through the
            // model's skill tool.
            if (input.startsWith("/")) {
                const [rawName, ...argumentParts] = input.slice(1).split(/\s+/);
                const skill = getSkill(rawName);
                if (skill) {
                    if (!skill.userInvocable) {
                        printError(`skill /${rawName} is model-invocable only`);
                        askQuestion();
                        return;
                    }
                    const prompt = resolveSkillPrompt(rawName, argumentParts.join(" "));
                    if (prompt) {
                        try {
                            printTurnStart();
                            await agent.chat(prompt);
                            sessionFooterPending = true;
                        } catch (e: any) {
                            if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
                                printError(e.message);
                            }
                        }
                        askQuestion();
                        return;
                    }
                }
            }

            // ── Chat ──────────────────────────────────────────────
            try {
                printTurnStart();
                await agent.chat(input);
                sessionFooterPending = true;
            } catch (e: any) {
                if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
                    printError(e.message);
                }
            }

            askQuestion();
    };

    // Wire up ask_user after readline and its line handler are ready. The
    // handler is installed by the question callback itself, because the
    // normal task prompt has already consumed its line by then.
    agent.setAskUserCallback((question, options) => {
        return new Promise<string>((resolve) => {
            endStatus();
            printQuestion(question, options);
            process.stdout.write(chalk.cyan("  Your answer: "));
            pendingAskUser = resolve;
            rl.once("line", handleLine);
        });
    });

    const askQuestion = (): void => {
        // Only after a completed model exchange — not after /config, /help
        // and friends: the footer describes the conversation, and a config
        // viewer has none.
        if (sessionFooterPending && agent.history().length > 0) {
            printSessionStatus(agent.getSessionStatus());
        }
        printUserPrompt();
        rl.once("line", handleLine);
        // Refresh the prompt explicitly so it is visible before the first key
        // press as well as after each completed turn.
        rl.prompt();
    };

    askQuestion();
}

// Entry point — run when executed directly.
runCli().catch((e) => {
    printError(e.message);
    process.exit(1);
});
