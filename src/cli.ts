import { Agent } from "./agent.js";
import * as readline from "node:readline";
import {
    saveSession, loadSession, listSessions, deleteSession,
    latestSessionId, type SessionIndex,
} from "./session.js";

const MODEL = process.env.MINI_MODEL || "deepseek-mini-1-20260912";

// ═══════════════════════════════════════════════════════════════
// Argument parsing
// ═══════════════════════════════════════════════════════════════

interface CliFlags {
    resume: string | null;   // null = no --resume; "" = --resume (latest); "abc" = --resume abc
    sessions: boolean;       // --sessions: list and exit
    oneShot: string;         // remaining args joined (non-interactive)
}

function parseArgs(argv: string[]): CliFlags {
    const flags: CliFlags = { resume: null, sessions: false, oneShot: "" };
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--resume") {
            // Next arg might be an ID prefix (not starting with --).
            const next = argv[i + 1];
            if (next && !next.startsWith("--")) {
                flags.resume = next;
                i++;
            } else {
                flags.resume = "";
            }
        } else if (arg === "--sessions") {
            flags.sessions = true;
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
    // Strip date suffix: "deepseek-mini-1-20260912" → "deepseek-mini-1"
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

    // --sessions: print table and exit immediately.
    if (flags.sessions) {
        const sessions = listSessions();
        const current = latestSessionId();
        printSessionTable(sessions, current);
        return;
    }

    const agent = new Agent();

    // --resume [id]: reload a saved conversation before doing anything else.
    if (flags.resume !== null) {
        const identifier = flags.resume === "" ? undefined : flags.resume;
        const saved = loadSession(identifier);
        if (saved) {
            agent.loadHistory(saved.messages as any);
            const preview = saved.title.length > 50 ? saved.title.slice(0, 50) + "…" : saved.title;
            console.log(`(resumed session ${saved.id.slice(0, 8)} — ${saved.messages.length} messages — "${preview}")`);
        } else {
            console.log(`(no session found${identifier ? ` matching "${identifier}"` : ""})`);
        }
    }

    // ── One-shot mode ────────────────────────────────────────────
    if (flags.oneShot) {
        await agent.chat(flags.oneShot);
        saveSession(agent.history(), MODEL);
        return;
    }

    // ── Interactive REPL ─────────────────────────────────────────
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const prompt = (): void => {
        rl.question("\nYou: ", async (line) => {
            const input = line.trim();

            if (input === "" || input === "exit" || input === "quit") {
                rl.close();
                return;
            }

            if (input === "/clear") {
                agent.clearHistory();
                saveSession(agent.history(), MODEL);
                console.log("(history cleared)");
                prompt();
                return;
            }

            if (input === "/sessions") {
                const sessions = listSessions();
                const current = latestSessionId();
                console.log();
                printSessionTable(sessions, current);
                prompt();
                return;
            }

            if (input.startsWith("/delete")) {
                const id = input.slice(7).trim();
                if (!id) {
                    console.log("Usage: /delete <session-id>");
                } else if (deleteSession(id)) {
                    console.log(`(session ${id} deleted)`);
                } else {
                    console.log(`(session ${id} not found)`);
                }
                prompt();
                return;
            }

            await agent.chat(input);
            saveSession(agent.history(), MODEL);
            prompt();
        });
    };

    prompt();
}