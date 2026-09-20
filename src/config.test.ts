import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// config.ts resolves the config path from os.homedir() at module load, so a
// test cannot just point an env var at a fixture — it has to import a fresh
// copy of the module with HOME already redirected. Hence the cache-busting
// query below: a cached module would keep reporting the first test's config.
let caseId = 0;

const ENV_KEYS = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "MINI_MODEL", "TRIUMCODE_EFFORT",
    "MINI_CONTEXT_WINDOW", "TRIUMCODE_PROTOCOL", "TRIUMCODE_AUTH",
] as const;

async function loadConfig(
    saved: Record<string, unknown> | null,
    env: Record<string, string> = {},
): Promise<{ mod: typeof import("./config.js"); restore: () => void }> {
    const home = mkdtempSync(join(tmpdir(), "triumcode-config-"));
    if (saved) {
        mkdirSync(join(home, ".triumcode"), { recursive: true });
        writeFileSync(join(home, ".triumcode", "config.json"), JSON.stringify(saved), "utf-8");
    }

    const previous: Record<string, string | undefined> = {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
    };
    for (const key of ENV_KEYS) previous[key] = process.env[key];

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);

    const mod = (await import(`./config.js?case=${caseId++}`)) as typeof import("./config.js");

    const restore = () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    return { mod, restore };
}

// ── Precedence ──────────────────────────────────────────────

test("the saved config outranks environment variables", async (t) => {
    // Regression: env vars used to win, so a stray `export ANTHROPIC_BASE_URL`
    // silently redirected requests away from the endpoint the user had typed
    // into first-run setup — with nothing on screen saying so.
    const { mod, restore } = await loadConfig(
        { apiKey: "sk-ant-saved", apiBase: "https://saved.example/anthropic", model: "saved-model" },
        {
            ANTHROPIC_API_KEY: "sk-ant-from-env",
            ANTHROPIC_BASE_URL: "https://env.example/anthropic",
            MINI_MODEL: "env-model",
        },
    );
    t.after(restore);

    const { config, sources } = mod.resolveConfigDetailed({});
    assert.equal(config.apiBase, "https://saved.example/anthropic");
    assert.equal(config.model, "saved-model");
    assert.equal(config.apiKey, "sk-ant-saved");
    assert.equal(sources.apiBase, "config");
    assert.equal(sources.model, "config");
    assert.equal(sources.apiKey, "config");
});

test("CLI flags outrank both the saved config and the environment", async (t) => {
    const { mod, restore } = await loadConfig(
        { apiKey: "sk-ant-saved", apiBase: "https://saved.example" },
        { ANTHROPIC_API_KEY: "sk-ant-from-env", ANTHROPIC_BASE_URL: "https://env.example" },
    );
    t.after(restore);

    const { config, sources } = mod.resolveConfigDetailed({
        apiKey: "sk-ant-from-flag",
        apiBase: "https://flag.example",
    });
    assert.equal(config.apiKey, "sk-ant-from-flag");
    assert.equal(config.apiBase, "https://flag.example");
    assert.equal(sources.apiKey, "flag");
    assert.equal(sources.apiBase, "flag");
});

test("resolution is per-field, so a key-only config still takes the endpoint from the environment", async (t) => {
    const { mod, restore } = await loadConfig(
        { apiKey: "sk-ant-saved" },
        { ANTHROPIC_BASE_URL: "https://env.example" },
    );
    t.after(restore);

    const { config, sources } = mod.resolveConfigDetailed({});
    assert.equal(config.apiKey, "sk-ant-saved");
    assert.equal(sources.apiKey, "config");
    assert.equal(config.apiBase, "https://env.example");
    assert.equal(sources.apiBase, "env");
});

test("with nothing configured, the environment is used and the rest falls back to defaults", async (t) => {
    const { mod, restore } = await loadConfig(null, { ANTHROPIC_API_KEY: "sk-ant-from-env" });
    t.after(restore);

    const { config, sources } = mod.resolveConfigDetailed({});
    assert.equal(sources.apiKey, "env");
    assert.equal(config.apiBase, mod.DEFAULT_API_BASE);
    assert.equal(config.model, mod.DEFAULT_MODEL);
    assert.equal(sources.apiBase, "default");
    assert.equal(sources.model, "default");
    assert.equal(sources.thinking, "default");
    assert.equal(config.contextWindow, 200_000);
    assert.equal(sources.contextWindow, "default");
});

test("context window follows CLI, config, then environment precedence", async (t) => {
    const { mod, restore } = await loadConfig(
        { contextWindow: 900_000 },
        { MINI_CONTEXT_WINDOW: "1000000" },
    );
    t.after(restore);

    assert.equal(mod.resolveConfigDetailed({}).config.contextWindow, 900_000);
    assert.equal(mod.resolveConfigDetailed({ contextWindow: 1_000_000 }).config.contextWindow, 1_000_000);
    assert.equal(mod.resolveConfigDetailed({}).sources.contextWindow, "config");
});

// ── Conflict reporting ──────────────────────────────────────

test("a shadowed environment variable holding a different value is reported", async (t) => {
    const { mod, restore } = await loadConfig(
        { apiBase: "https://saved.example" },
        { ANTHROPIC_BASE_URL: "https://env.example" },
    );
    t.after(restore);

    const { conflicts } = mod.resolveConfigDetailed({});
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, "apiBase");
    assert.equal(conflicts[0].winner, "config");
    assert.equal(conflicts[0].shadowed, "env");
    assert.equal(conflicts[0].shadowedValue, "https://env.example");
});

test("an environment variable holding the same value is not a conflict", async (t) => {
    // Nothing is being overridden, so warning about it would just be noise.
    const { mod, restore } = await loadConfig(
        { apiBase: "https://same.example" },
        { ANTHROPIC_BASE_URL: "https://same.example" },
    );
    t.after(restore);

    assert.deepEqual(mod.resolveConfigDetailed({}).conflicts, []);
});

test("the shadowed api key is masked in the conflict report", async (t) => {
    const { mod, restore } = await loadConfig(
        { apiKey: "sk-ant-saved" },
        { ANTHROPIC_API_KEY: "sk-live-abcdefghijklmnop" },
    );
    t.after(restore);

    const { conflicts } = mod.resolveConfigDetailed({});
    assert.equal(conflicts[0].field, "apiKey");
    assert.ok(!conflicts[0].shadowedValue.includes("abcdefg"), conflicts[0].shadowedValue);
});

// ── Masking ─────────────────────────────────────────────────

test("maskSecret reveals only a constant, non-secret prefix", async () => {
    const { mod } = await loadConfig(null);
    // Regression: a fixed-width prefix slice leaked the first characters of
    // any gateway key that does not start with the literal "sk-ant-".
    assert.equal(mod.maskSecret("sk-ant-api03-AAAAAAAAAAAAAAAAAAAA1234"), "sk-ant-...1234");
    assert.equal(mod.maskSecret("sk-abcdefghijklmnopqrstuvwxyz1234"), "...1234");
    assert.equal(mod.maskSecret("shortkey"), "(set)");
    assert.equal(mod.maskSecret(""), "(not set)");
});

test("describeSource names the file it means", async () => {
    const { mod } = await loadConfig(null);
    assert.equal(mod.describeSource("flag"), "CLI flag");
    assert.equal(mod.describeSource("env"), "environment");
    assert.equal(mod.describeSource("default"), "built-in default");
    assert.match(mod.describeSource("config"), /\.triumcode\/config\.json$/);
});

// ── Size suffixes + reasoning defaults ──────────────────────

test("context window accepts k/M suffixes; thinking and effort default on", async (t) => {
    const { mod, restore } = await loadConfig({ contextWindow: "1M" });
    t.after(restore);

    // The config file may declare the window as a suffixed string.
    assert.equal(mod.resolveConfigDetailed({}).config.contextWindow, 1_000_000);
    assert.equal(mod.resolveConfigDetailed({ contextWindow: 200_000 }).config.contextWindow, 200_000);
    // Thinking defaults on, effort defaults to high (meaningless without thinking).
    assert.equal(mod.resolveConfigDetailed({}).config.thinking, true);
    assert.equal(mod.resolveConfigDetailed({}).config.effort, "high");

    assert.equal(mod.parseSizeTokens("200k"), 200_000);
    assert.equal(mod.parseSizeTokens("1M"), 1_000_000);
    assert.equal(mod.parseSizeTokens("1.5m"), 1_500_000);
    assert.equal(mod.parseSizeTokens("1000000"), 1_000_000);
    assert.equal(mod.parseSizeTokens("bogus"), undefined);
    assert.equal(mod.parseSizeTokens("0"), undefined);
    assert.equal(mod.parseSizeTokens("-5"), undefined);
    assert.equal(mod.parseSizeTokens(undefined), undefined);
});

// ── Model presets ───────────────────────────────────────────

test("getModelPresets reads the models map and drops malformed entries", async (t) => {
    const { mod, restore } = await loadConfig({
        model: "default-model",
        models: {
            mimo: { model: "mimo-v2.5" },
            sonnet: { model: "claude-sonnet-4-5", apiBase: "https://api.anthropic.com" },
            // A gateway serves each model through one of its APIs, so a preset
            // has to carry the protocol, the auth header, and the window the
            // model actually publishes.
            deep: {
                model: "deepseek-v4",
                apiBase: "https://opencode.ai/zen/go/v1",
                protocol: "openai-chat",
                auth: "bearer",
                contextWindow: "128k",
            },
            typo: { model: "whatever", protocol: "openai-wide" },
            broken: { apiBase: "https://no.model/" },
        },
    });
    t.after(restore);

    const presets = mod.getModelPresets();
    assert.deepEqual(presets.mimo, {
        model: "mimo-v2.5", apiBase: undefined, apiKey: undefined,
        protocol: undefined, auth: undefined, contextWindow: undefined,
    });
    assert.equal(presets.sonnet?.apiBase, "https://api.anthropic.com");
    assert.equal(presets.deep?.protocol, "openai-chat");
    assert.equal(presets.deep?.auth, "bearer");
    assert.equal(presets.deep?.contextWindow, 128_000);
    assert.equal(presets.typo?.protocol, undefined, "an unknown protocol is not guessed at");
    assert.equal(presets.broken, undefined);
});

test("protocol resolves by precedence and auth derives from it", async (t) => {
    const { mod, restore } = await loadConfig(
        { apiKey: "k", apiBase: "https://gateway.example/v1", protocol: "openai-chat" },
        { TRIUMCODE_PROTOCOL: "openai-responses" },
    );
    t.after(restore);

    const flagged = mod.resolveConfigDetailed({ protocol: "anthropic" });
    assert.equal(flagged.config.protocol, "anthropic");
    assert.equal(flagged.sources.protocol, "flag");
    // Anthropic's own scheme wins when the protocol changes under it.
    assert.equal(flagged.config.auth, "api-key");
    assert.equal(flagged.sources.auth, "default");

    const fromConfig = mod.resolveConfigDetailed({});
    assert.equal(fromConfig.config.protocol, "openai-chat", "the saved value outranks env");
    assert.equal(fromConfig.config.auth, "bearer");
});

test("protocol defaults to anthropic, and its auth to x-api-key", async (t) => {
    const { mod, restore } = await loadConfig(null, {});
    t.after(restore);

    const { config, sources } = mod.resolveConfigDetailed({});
    assert.equal(config.protocol, "anthropic");
    assert.equal(sources.protocol, "default");
    assert.equal(config.auth, "api-key");
    assert.equal(sources.auth, "default");
});

test("getModelPresets returns an empty set without a models map", async (t) => {
    const { mod, restore } = await loadConfig({ model: "default-model" });
    t.after(restore);
    assert.deepEqual(mod.getModelPresets(), {});
});
