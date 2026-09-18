import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

// ═══════════════════════════════════════════════════════════════
// Global user config — ~/.triumph/config.json
// ═══════════════════════════════════════════════════════════════
//
// First-run: if no API key is found anywhere, the CLI enters
// interactive setup and saves the key here.  After that, the
// user never needs to touch env vars or .env files.
//
// Priority (highest → lowest):
//   1. CLI flags  (--api-key, --api-base, --model)
//   2. Project .env file
//   3. Environment variables
//   4. ~/.triumph/config.json  ← this file

const CONFIG_DIR = join(os.homedir(), ".triumph");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface UserConfig {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
}

function readConfig(): UserConfig {
    if (!existsSync(CONFIG_FILE)) return {};
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
        return {};
    }
}

function writeConfig(config: UserConfig): void {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════════════════
// Config resolution — merge all sources
// ═══════════════════════════════════════════════════════════════

export interface ResolvedConfig {
    apiKey: string;
    apiBase: string;
    model: string;
    thinking: boolean;
    effort: string;
}

/**
 * Resolve config from all sources, highest priority first:
 *   CLI flags > .env (already in process.env) > ~/.triumph/config.json
 */
export function resolveConfig(flags: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
}): ResolvedConfig {
    const saved = readConfig();

    return {
        apiKey:   flags.apiKey   || process.env.ANTHROPIC_API_KEY || saved.apiKey   || "",
        apiBase:  flags.apiBase  || process.env.ANTHROPIC_BASE_URL || saved.apiBase || "https://api.anthropic.com",
        model:    flags.model    || process.env.MINI_MODEL        || saved.model   || "claude-sonnet-4-20250514",
        thinking: flags.thinking ?? saved.thinking ?? false,
        effort:   flags.effort   || process.env.TRIUMPH_EFFORT   || saved.effort   || "",
    };
}

// ═══════════════════════════════════════════════════════════════
// First-run interactive setup
// ═══════════════════════════════════════════════════════════════

async function ask(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            // Strip ANSI escape codes that terminals may inject.
            const clean = answer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
            resolve(clean);
        });
    });
}

/**
 * Run first-time setup if no API key is configured.
 * Returns the resolved config, or null if the user cancelled.
 */
export async function ensureConfig(flags: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
}): Promise<ResolvedConfig | null> {
    const config = resolveConfig(flags);

    // API key already available — nothing to do.
    if (config.apiKey) return config;

    // No key found anywhere — enter interactive setup.
    console.log("\n  Welcome to Triumph Code! Let's get you set up.\n");
    console.log("  You need an Anthropic API key to get started.");
    console.log("  Get one at: https://console.anthropic.com/settings/keys\n");

    const apiKey = await ask("  Enter your API key (sk-ant-...): ");
    if (!apiKey) {
        console.log("\n  Setup cancelled. You can set the key later via:");
        console.log("    triumph --api-key <key>");
        console.log("    export ANTHROPIC_API_KEY=<key>");
        return null;
    }

    const apiBase = await ask("  API base URL [https://api.anthropic.com]: ") || "https://api.anthropic.com";
    const model = await ask("  Default model [claude-sonnet-4-20250514]: ") || "claude-sonnet-4-20250514";

    const toSave: UserConfig = { apiKey, apiBase, model };
    writeConfig(toSave);

    console.log(`\n  ✓ Config saved to ${CONFIG_FILE}`);
    console.log("  You're all set! Run 'triumph' to start.\n");

    return { apiKey, apiBase, model, thinking: false, effort: "" };
}