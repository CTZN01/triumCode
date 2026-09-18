import { Agent } from "./agent.js";
import * as readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    saveSession, loadSession, listSessions, deleteSession,
    latestSessionId, type SessionIndex,
} from "./session.js";
import {
    printWelcome, printUserPrompt, printInfo, printError,
    printInterrupted, printHelp, printCostReport,
} from "./ui.js";

// ═══════════════════════════════════════════════════════════════
// .env loader — zero-dependency, reads KEY=VALUE lines
// ═══════════════════════════════════════════════════════════════

function loadDotEnv(): void {
    const envPath = resolve(".env");
    if (!existsSync(envPath)) return;
    try {
        const lines = readFileSync(envPath, "utf-8").split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eq = trimmed.indexOf("=");
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            // Don't overwrite existing env vars — real env takes precedence.
            if (!process.env[key]) process.env[key] = val;
        }
    } catch { /* best effort */ }
}

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
    permissionMode: string;  // --yolo / -y, --plan, --accept-edits, --dont-ask
    maxCost: number | undefined;
    maxTurns: number | undefined;
    help: boolean;           // --help / -h
    oneShot: string;         // remaining args joined (non-interactive)
}

function parseArgs(argv: string[]): CliFlags {
    // Load .env before parsing — env vars become fallback defaults.
    loadDotEnv();

    const flags: CliFlags = {
        resume: null,
        sessions: false,
        model: process.env.MINI_MODEL || "deepseek-mini-1-20260912",
        apiKey: process.env.ANTHROPIC_API_KEY || "",
        apiBase: process.env.ANTHROPIC_BASE_URL || "",
        thinking: false,
        permissionMode: "default",
        maxCost: undefined,
        maxTurns: undefined,
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
        console.log("  (no saved sessions)");
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

    console.log(hdr);
    console.log("  " + "─".repeat(hdr.length - 2));

    for (const s of sessions) {
        const marker = s.id === currentId ? " → " : "   ";
        const row = [
            marker + s.id.slice(0, 8).padEnd(idW - marker.length + 1),
            formatDate(s.updated).padEnd(dateW),
            truncate(formatModel(s.model), modelW - 1).padEnd(modelW),
            String(s.messageCount).padStart(msgsW),
            truncate(s.title, 50),
        ].join("  ");
        console.log(row);
    }

    if (currentId && sessions.some((s) => s.id === currentId)) {
        console.log(`\n  → = current session (${currentId})`);
    }
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

    // Validate API key — fail early with actionable message.
    if (!flags.apiKey) {
        printError("API key required. Set it via one of:");
        printInfo("  1. Create .env file:     echo ANTHROPIC_API_KEY=sk-ant-xxx > .env");
        printInfo("  2. Environment variable: export ANTHROPIC_API_KEY=sk-ant-xxx");
        printInfo("  3. CLI flag:             --api-key sk-ant-xxx");
        process.exit(1);
    }

    const agent = new Agent({
        model: flags.model,
        apiKey: flags.apiKey,
        apiBase: flags.apiBase || undefined,
        thinking: flags.thinking,
    });

    // Wire up auto-save: after each chat(), persist the session.
    agent.setOnChatComplete(() => {
        saveSession(agent.history(), flags.model);
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
        if (agent.isProcessing) {
            agent.abort();
            printInterrupted();
            sigintCount = 0;
            askQuestion();
        } else {
            sigintCount++;
            if (sigintCount >= 2) {
                console.log("\nBye!\n");
                process.exit(0);
            }
            console.log("\n  Press Ctrl+C again to exit.");
            askQuestion();
        }
    });

    printWelcome();

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
                console.log("\nBye!\n");
                rl.close();
                return;
            }

            // ── Slash commands ─────────────────────────────────────
            if (input === "/clear") {
                agent.clearHistory();
                saveSession(agent.history(), flags.model);
                printInfo("history cleared");
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
                // Future: toggle plan mode.
                printInfo("/plan toggle not yet implemented — coming soon");
                askQuestion();
                return;
            }

            if (input === "/sessions") {
                const sessions = listSessions();
                const current = latestSessionId();
                console.log();
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
