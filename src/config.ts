import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { DEFAULT_CONTEXT_WINDOW } from "./context-compression.js";

// ═══════════════════════════════════════════════════════════════
// Global user config — ~/.triumcode/config.json
// ═══════════════════════════════════════════════════════════════
//
// First-run: if no API key is found anywhere, the CLI enters
// interactive setup and saves the key here.  After that, the
// user never needs to touch env vars.
//
// Priority (highest → lowest):
//   1. CLI flags  (--api-key, --api-base, --model)
//   2. ~/.triumcode/config.json  ← this file
//   3. Environment variables
//   4. Built-in defaults
//
// The saved config deliberately outranks the environment: an
// endpoint the user typed in during setup should not be silently
// redirected by a stray exported ANTHROPIC_BASE_URL.  CI and
// one-off runs override with the CLI flags instead.

const CONFIG_DIR = join(os.homedir(), ".triumcode");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/** Same path as CONFIG_FILE, shortened the way the docs write it. */
const CONFIG_FILE_DISPLAY = CONFIG_FILE
    .replace(os.homedir(), "~")
    .replace(/\\/g, "/");

export interface UserConfig {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
    // Accepts a plain token count or a k/M suffix string ("200k", "1M").
    contextWindow?: number | string;
    // Named model presets for the /model command. Each preset may override
    // the model id and, for cross-provider switching, the endpoint and key.
    models?: Record<string, ModelPreset>;
}

export interface ModelPreset {
    model: string;
    apiBase?: string;
    apiKey?: string;
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
    contextWindow: number;
}

/** Where a single resolved field came from. */
export type ConfigSource = "flag" | "config" | "env" | "default";

export const DEFAULT_API_BASE = "https://api.anthropic.com";
export const DEFAULT_MODEL = "claude-sonnet-4-20250514";

interface Sourced<T> {
    value: T;
    source: ConfigSource;
}

/** First non-empty candidate wins; `fallback` is reported as "default". */
function firstOf<T>(
    candidates: Array<[ConfigSource, T | undefined]>,
    fallback: T,
): Sourced<T> {
    for (const [source, value] of candidates) {
        if (value !== undefined && value !== "") return { value, source };
    }
    return { value: fallback, source: "default" };
}

/** A lower-priority source holding a *different* value than the winner. */
export interface ConfigConflict {
    field: string;
    winner: ConfigSource;
    shadowed: ConfigSource;
    /** Never the raw key — masked before it leaves this module. */
    shadowedValue: string;
}

export interface ResolvedConfigBundle {
    config: ResolvedConfig;
    sources: Record<keyof ResolvedConfig, ConfigSource>;
    conflicts: ConfigConflict[];
}

/**
 * Resolve config from all sources, highest priority first:
 *   CLI flags > ~/.triumcode/config.json > environment variables
 *
 * Resolution is per-field, so a config file that sets only the key
 * still picks up ANTHROPIC_BASE_URL from the environment.
 *
 * Also reports which source won each field, plus any lower-priority
 * source that is set to something different — the case that used to
 * redirect requests without the user ever seeing it.
 */
export function resolveConfigDetailed(flags: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
    contextWindow?: number;
}): ResolvedConfigBundle {
    const saved = readConfig();

    const apiKey = firstOf<string>([
        ["flag", flags.apiKey], ["config", saved.apiKey], ["env", process.env.ANTHROPIC_API_KEY],
    ], "");
    const apiBase = firstOf<string>([
        ["flag", flags.apiBase], ["config", saved.apiBase], ["env", process.env.ANTHROPIC_BASE_URL],
    ], DEFAULT_API_BASE);
    const model = firstOf<string>([
        ["flag", flags.model], ["config", saved.model], ["env", process.env.MINI_MODEL],
    ], DEFAULT_MODEL);
    const effort = firstOf<string>([
        ["flag", flags.effort], ["config", saved.effort], ["env", process.env.TRIUMCODE_EFFORT],
    ], "high");
    const contextWindow = firstOf<number>([
        ["flag", flags.contextWindow],
        ["config", parseSizeTokens(saved.contextWindow)],
        ["env", parseSizeTokens(process.env.MINI_CONTEXT_WINDOW)],
    ], DEFAULT_CONTEXT_WINDOW);

    const thinking: Sourced<boolean> =
        flags.thinking !== undefined ? { value: flags.thinking, source: "flag" }
        : saved.thinking !== undefined ? { value: saved.thinking, source: "config" }
        // Thinking on by default: current Claude models think natively, and
        // the effort default below is meaningless without it.
        : { value: true, source: "default" };

    const sources = {
        apiKey: apiKey.source, apiBase: apiBase.source, model: model.source,
        thinking: thinking.source, effort: effort.source,
        contextWindow: contextWindow.source,
    };

    // Only flag a conflict when the shadowed source would actually have
    // changed the outcome — same value means nothing is being overridden.
    const conflicts: ConfigConflict[] = [];
    const compare = (field: string, won: Sourced<string>, other: [ConfigSource, string | undefined]) => {
        const [src, val] = other;
        if (!val || val === won.value) return;
        conflicts.push({
            field,
            winner: won.source,
            shadowed: src,
            shadowedValue: field === "apiKey" ? maskSecret(val) : val,
        });
    };
    compare("apiKey",  apiKey,  ["env", process.env.ANTHROPIC_API_KEY]);
    compare("apiBase", apiBase, ["env", process.env.ANTHROPIC_BASE_URL]);
    compare("model",   model,   ["env", process.env.MINI_MODEL]);

    return {
        config: {
            apiKey: apiKey.value, apiBase: apiBase.value, model: model.value,
            thinking: thinking.value, effort: effort.value,
            contextWindow: contextWindow.value,
        },
        sources,
        conflicts,
    };
}

/**
 * Token counts accept size suffixes: "1000000", "200k", "1M", "1.5m".
 * Suffixes are decimal (k = 1e3, M = 1e6) — model context windows are
 * quoted that way. Returns undefined for anything unparsable or <= 0.
 */
export function parseSizeTokens(value: string | number | undefined): number | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    if (!text) return undefined;
    const match = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(text);
    if (!match) return undefined;
    const mult = match[2].toLowerCase() === "k" ? 1e3
        : match[2].toLowerCase() === "m" ? 1e6
        : 1;
    const tokens = Math.floor(parseFloat(match[1]) * mult);
    return tokens > 0 ? tokens : undefined;
}

export function resolveConfig(flags: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
    contextWindow?: number;
}): ResolvedConfig {
    return resolveConfigDetailed(flags).config;
}

/**
 * Named model presets from the config file's "models" map, for /model.
 * Read fresh on every call so edits to config.json show up without a
 * restart. An absent or malformed map yields an empty set.
 */
export function getModelPresets(): Record<string, ModelPreset> {
    const models = readConfig().models;
    if (!models || typeof models !== "object" || Array.isArray(models)) return {};
    const presets: Record<string, ModelPreset> = {};
    for (const [name, preset] of Object.entries(models)) {
        if (!preset || typeof preset !== "object" || !preset.model) continue;
        presets[name] = {
            model: String(preset.model),
            apiBase: preset.apiBase ? String(preset.apiBase) : undefined,
            apiKey: preset.apiKey ? String(preset.apiKey) : undefined,
        };
    }
    return presets;
}

/**
 * `sk-ant-...a1b2` — enough to tell two keys apart, not enough to use one.
 *
 * Only a constant, non-secret prefix is ever revealed. Slicing a fixed
 * number of leading characters would expose real key material on any
 * gateway whose keys don't start with a known literal (they all start
 * `sk-`, but what follows is secret).
 *
 * ASCII only: the report this lands in relies on character-count alignment,
 * and East-Asian-Ambiguous glyphs (…, —) render double-width in zh-CN
 * terminals, which would skew every column.
 */
export function maskSecret(value: string): string {
    if (!value) return "(not set)";
    if (value.length <= 8) return "(set)";
    const prefix = value.startsWith("sk-ant-") ? "sk-ant-" : "";
    return `${prefix}...${value.slice(-4)}`;
}

/** Human-readable label for where a field's value came from. */
export function describeSource(source: ConfigSource): string {
    switch (source) {
        case "flag":    return "CLI flag";
        case "config":  return CONFIG_FILE_DISPLAY;
        case "env":     return "environment";
        case "default": return "built-in default";
    }
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
 * Returns the resolved config plus source provenance, or null if the
 * user cancelled.
 */
export async function ensureConfig(flags: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    thinking?: boolean;
    effort?: string;
    contextWindow?: number;
}): Promise<ResolvedConfigBundle | null> {
    const bundle = resolveConfigDetailed(flags);

    // API key already available — nothing to do.
    if (bundle.config.apiKey) return bundle;

    // No key found anywhere — enter interactive setup.
    console.log("\n  Welcome to TriumCode! Let's get you set up.\n");
    console.log("  You need an Anthropic API key to get started.");
    console.log("  Get one at: https://console.anthropic.com/settings/keys\n");

    const apiKey = await ask("  Enter your API key (sk-ant-...): ");
    if (!apiKey) {
        console.log("\n  Setup cancelled. You can set the key later via:");
        console.log("    triumcode --api-key <key>");
        console.log("    export ANTHROPIC_API_KEY=<key>");
        return null;
    }

    const apiBase = await ask(`  API base URL [${DEFAULT_API_BASE}]: `) || DEFAULT_API_BASE;
    const model = await ask(`  Default model [${DEFAULT_MODEL}]: `) || DEFAULT_MODEL;

    const toSave: UserConfig = { apiKey, apiBase, model };
    writeConfig(toSave);

    console.log(`\n  ✓ Config saved to ${CONFIG_FILE}`);

    // Everything just came from the file we wrote — say so explicitly, so
    // the user knows which endpoint is now in effect without having to ask.
    return {
        config: {
            apiKey, apiBase, model,
            thinking: flags.thinking ?? true,
            effort: flags.effort || "high",
            contextWindow: flags.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        },
        sources: {
            apiKey: "config", apiBase: "config", model: "config",
            thinking: flags.thinking !== undefined ? "flag" : "default",
            effort: flags.effort ? "flag" : "default",
            contextWindow: flags.contextWindow ? "flag" : "default",
        },
        // Setup just overwrote the file, so nothing is shadowing it.
        conflicts: [],
    };
}