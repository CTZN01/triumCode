import { Agent } from "./agent.js";
import * as readline from "node:readline";
import {
    saveSession, loadSession, listSessions, deleteSession,
    latestSessionId, type SessionIndex,
} from "./session.js";
import {
    printWelcome, printUserPrompt, printInfo, printError,
    printInterrupted, printHelp, printCostReport, printBlock, endStatus,
    printConfigReport,
} from "./ui.js";
import { ensureConfig, describeSource } from "./config.js";
import { parseEffort, EFFORT_LEVELS } from "./thinking.js";

// ═══════════════════════════════════════════════════════════════
// Argument parsing
// ═══════════════════════════════════════════════════════════════

interface CliFlags {
    resume: string | null;   // null = no --resume; "" = --resume (latest); "abc" = --resume abc
    sessions: boolean;       // --sessions: list and exit
    model: string;           // --model / -m
    apiKey: string;          // --api-key
    apiBase: string;         // --api-base
    thinking: boolean;       // --thinking
    effort: string;          // --effort low|medium|high|xhigh|max
    permissionMode: string;  // --yolo / -y, --plan, --accept-edits, --dont-ask
    maxCost: number | undefined;
    maxTurns: number | undefined;
    maxTokens: number | undefined;
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
        thinking: false,
        effort: "",
        permissionMode: "default",
        maxCost: undefined,
        maxTurns: undefined,
        maxTokens: undefined,
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

    // Resolve config from all sources (CLI > ~/.triumph/config.json > env).
    // If no API key is found anywhere, enters interactive first-run setup.
    const bundle = await ensureConfig(flags);
    if (!bundle) process.exit(1);
    const config = bundle.config;

    // A lower-priority source holding a different value is exactly how a
    // session ends up talking to an endpoint the user never chose, so say so
    // up front rather than letting it be discovered from a bill.
    if (bundle.conflicts.length > 0) printConfigReport(bundle);

    const agent = new Agent({
        model: config.model,
        apiKey: config.apiKey,
        apiBase: config.apiBase,
        thinking: config.thinking,
        effort: config.effort,
        maxTokens: flags.maxTokens,
        maxTurns: flags.maxTurns,
        planMode: flags.permissionMode === "plan",
    });

    // Wire up auto-save: after each chat(), persist the session.
    agent.setOnChatComplete(() => {
        saveSession(agent.history(), config.model);
    });

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
        await agent.chat(flags.oneShot);
        return;
    }

    // ── Interactive REPL ─────────────────────────────────────────
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    // ── SIGINT handling ──────────────────────────────────────────
    let sigintCount = 0;
    process.on("SIGINT", () => {
        // This handler runs synchronously, before the agent loop unwinds, and
        // askQuestion() below re-prompts immediately — so the status line has
        // to go first, or a tick lands on top of the live prompt.
        endStatus();

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

    printWelcome(config.model);
    printInfo(`endpoint ${config.apiBase}  (${describeSource(bundle.sources.apiBase)}) - /config for details`);

    // ── REPL loop with rl.once (strict serial execution) ─────────
    const askQuestion = (): void => {
        printUserPrompt();
        rl.once("line", async (line) => {
            const input = line.trim();
            sigintCount = 0;

            // Empty line: re-prompt.
            if (!input) { askQuestion(); return; }

            // Exit.
            if (input === "exit" || input === "quit") {
                printBlock("\nBye!\n");
                rl.close();
                return;
            }

            // ── Slash commands ─────────────────────────────────────
            if (input === "/clear") {
                agent.clearHistory();
                saveSession(agent.history(), config.model);
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
                // Future: summarize and compress history.
                printInfo("/compact not yet implemented — coming soon");
                askQuestion();
                return;
            }

            if (input === "/plan") {
                agent.togglePlanMode();
                printInfo(`Plan mode: ${agent.planMode ? "ON" : "OFF"}`);
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

            // ── Chat ──────────────────────────────────────────────
            try {
                await agent.chat(input);
            } catch (e: any) {
                if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
                    printError(e.message);
                }
            }

            askQuestion();
        });
    };

    askQuestion();
}

// Entry point — run when executed directly.
runCli().catch((e) => {
    printError(e.message);
    process.exit(1);
});
