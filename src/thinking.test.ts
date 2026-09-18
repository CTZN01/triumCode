import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveThinkingMode, applyThinkingParams, applyEffortParams, parseEffort,
    isUnsupportedParamError, modelEnablesThinkingByDefault, modelRequiresBudgetTokens,
} from "./thinking.js";

// The agent's max_output_tokens; budget_tokens has to stay below it.
const MAX_TOKENS = 4096;

function buildParams(mode: ReturnType<typeof resolveThinkingMode>, maxTokens = MAX_TOKENS) {
    const params: Record<string, any> = {};
    applyThinkingParams(params, mode, maxTokens);
    return params;
}

// ── Mode selection ──────────────────────────────────────────

test("an unrecognised model can still be forced into thinking", () => {
    // Regression: the old model allowlist vetoed --thinking outright, so any
    // custom or self-hosted model was refused before the request was sent.
    assert.equal(resolveThinkingMode("mimo-v2.5[1m]", false), "disabled");
    assert.equal(resolveThinkingMode("mimo-v2.5[1m]", true), "adaptive");
    assert.equal(resolveThinkingMode("some-local-llm", true), "adaptive");
});

test("current Claude models enable thinking without the flag", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8"]) {
        assert.equal(resolveThinkingMode(model, false), "adaptive", model);
        assert.equal(modelEnablesThinkingByDefault(model), true, model);
    }
});

test("legacy models get the explicit budget shape", () => {
    for (const model of ["claude-haiku-4-5", "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]) {
        assert.equal(resolveThinkingMode(model, true), "budget", model);
        assert.equal(modelRequiresBudgetTokens(model), true, model);
    }
    // ...and stay off without the flag.
    assert.equal(resolveThinkingMode("claude-haiku-4-5", false), "disabled");
});

test("thinking is disabled when neither the flag nor the default applies", () => {
    assert.equal(resolveThinkingMode("gpt-4o", false), "disabled");
    assert.equal(resolveThinkingMode("", false), "disabled");
});

// ── Parameter shape ─────────────────────────────────────────

test("adaptive sends no budget_tokens", () => {
    // Regression: the old adaptive branch sent {type:"enabled",budget_tokens:10000},
    // which is both the wrong shape and 10000 > max_tokens = a guaranteed 400.
    const params = buildParams("adaptive");
    assert.deepEqual(params.thinking, { type: "adaptive" });
    assert.equal("budget_tokens" in params.thinking, false);
});

test("budget stays within the SDK's documented bounds", () => {
    // SDK: "Must be >=1024 and less than max_tokens".
    const params = buildParams("budget");
    assert.equal(params.thinking.type, "enabled");
    assert.ok(params.thinking.budget_tokens >= 1024, "at least 1024");
    assert.ok(params.thinking.budget_tokens < MAX_TOKENS, "strictly below max_tokens");
    assert.equal(params.thinking.budget_tokens, MAX_TOKENS - 1);
});

test("no thinking block is sent when max_tokens leaves no room for a budget", () => {
    assert.deepEqual(buildParams("budget", 1000), {});
    assert.deepEqual(buildParams("budget", 1024), {});
    // 1025 is the first value that admits a valid budget.
    assert.equal(buildParams("budget", 1025).thinking.budget_tokens, 1024);
});

test("disabled adds nothing", () => {
    assert.deepEqual(buildParams("disabled"), {});
});

// ── Effort ──────────────────────────────────────────────────

test("effort is written into output_config", () => {
    const params: Record<string, any> = {};
    applyEffortParams(params, "xhigh");
    assert.deepEqual(params.output_config, { effort: "xhigh" });
});

test("effort merges with an existing output_config", () => {
    const params: Record<string, any> = { output_config: { format: "x" } };
    applyEffortParams(params, "low");
    assert.deepEqual(params.output_config, { format: "x", effort: "low" });
});

test("no effort leaves output_config untouched", () => {
    const params: Record<string, any> = {};
    applyEffortParams(params, null);
    assert.deepEqual(params, {});
});

test("parseEffort accepts the five levels, case-insensitively, and rejects the rest", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
        assert.equal(parseEffort(level), level);
        assert.equal(parseEffort(level.toUpperCase()), level);
    }
    for (const bad of ["", undefined, "turbo", "highest", "none"]) {
        assert.equal(parseEffort(bad), null, String(bad));
    }
});

// ── Endpoint-capability detection ───────────────────────────

test("isUnsupportedParamError only fires on a 400 naming a known field", () => {
    const err = (status: any, message: string) => ({ status, message });

    assert.equal(isUnsupportedParamError(err(400, "thinking: Extra inputs are not permitted")), true);
    assert.equal(isUnsupportedParamError(err(400, "budget_tokens must be less than max_tokens")), true);
    assert.equal(isUnsupportedParamError(err(400, "unknown field output_config")), true);
    assert.equal(isUnsupportedParamError(err(400, "unsupported parameter: effort")), true);

    // A 400 about something else is a real error and must surface.
    assert.equal(isUnsupportedParamError(err(400, "messages: must have at least one message")), false);
    assert.equal(isUnsupportedParamError(err(400, "invalid api key")), false);
    // Only 400.
    assert.equal(isUnsupportedParamError(err(429, "thinking rate limited")), false);
    assert.equal(isUnsupportedParamError(err(500, "thinking blew up")), false);
    assert.equal(isUnsupportedParamError(new Error("thinking")), false);
    assert.equal(isUnsupportedParamError(undefined), false);
});
