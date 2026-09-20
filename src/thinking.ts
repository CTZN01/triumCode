import type Anthropic from "@anthropic-ai/sdk";

// ═══════════════════════════════════════════════════════════════
// Extended thinking + effort
// ═══════════════════════════════════════════════════════════════
//
// Two request shapes exist and picking the wrong one is a hard 400:
//
//   adaptive  { thinking: { type: "adaptive" } }
//     Current models (Claude 4.6 and later). No token budget — the model
//     decides how much to think, and depth is tuned with
//     output_config.effort. Sending budget_tokens alongside it is rejected.
//
//   budget    { thinking: { type: "enabled", budget_tokens: N } }
//     Pre-4.6 models (Haiku 4.5 and earlier). budget_tokens is REQUIRED here,
//     constrained by the SDK to ">=1024 and less than max_tokens". Sending it
//     to a current model is a 400, and setting it >= max_tokens is a 400 on
//     every model.
//
// Which shape a given endpoint wants cannot be derived from a model name with
// any confidence, and this agent runs against arbitrary ANTHROPIC_BASE_URLs.
// So an unrecognised model is never *blocked*: the model lists below only
// decide whether thinking turns on by itself. --thinking always forces it, and
// agent.ts falls back to a plain request if the endpoint rejects the params.

export type ThinkingMode = "adaptive" | "budget" | "disabled";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Thinking is on by default on the current first-party models, matching the
// Claude API's own behaviour. Purely a default — it never gates --thinking.
const DEFAULT_ON_MODELS = [
    "claude-opus-5", "claude-sonnet-5",
    "claude-fable-5", "claude-mythos-5",
    "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
    "claude-sonnet-4-6",
];

// The only models that still take an explicit token budget.
const BUDGET_TOKEN_MODELS = [
    "claude-haiku-4-5",
    "claude-3-", "claude-3.5",
];

// SDK constraint on budget_tokens: "Must be >=1024 and less than max_tokens".
const MIN_BUDGET_TOKENS = 1024;

function modelMatches(model: string, prefixes: string[]): boolean {
    const lower = model.toLowerCase();
    return prefixes.some((p) => lower.includes(p));
}

/** Whether thinking turns on without --thinking. */
export function modelEnablesThinkingByDefault(model: string): boolean {
    return modelMatches(model, DEFAULT_ON_MODELS);
}

/** Whether this model needs the legacy explicit token budget. */
export function modelRequiresBudgetTokens(model: string): boolean {
    return modelMatches(model, BUDGET_TOKEN_MODELS);
}

/**
 * Resolve which thinking mode to use. The flag always wins: an unrecognised
 * model (a custom or self-hosted one) is allowed to try rather than being
 * silently refused, because only the endpoint knows what it supports.
 */
export function resolveThinkingMode(model: string, thinkingFlag: boolean): ThinkingMode {
    if (!thinkingFlag && !modelEnablesThinkingByDefault(model)) return "disabled";
    return modelRequiresBudgetTokens(model) ? "budget" : "adaptive";
}

/**
 * Mutate `params` in place to add the `thinking` block.
 * `maxTokens` is the request's max_output_tokens.
 */
export function applyThinkingParams(
    params: Record<string, any>,
    mode: ThinkingMode,
    maxTokens: number,
): void {
    if (mode === "disabled") return;

    if (mode === "adaptive") {
        params.thinking = { type: "adaptive" };
        return;
    }

    // budget_tokens counts towards max_tokens, so it must stay strictly below
    // it. Below the 1024 floor there is no room to think at all — better to
    // send no thinking block than one the API will reject.
    const budget = Math.min(maxTokens - 1, 32_000);
    if (budget < MIN_BUDGET_TOKENS) return;
    params.thinking = { type: "enabled", budget_tokens: budget };
}

/** Parse and validate an --effort value. Returns null when unset or invalid. */
export function parseEffort(value: string | undefined): EffortLevel | null {
    if (!value) return null;
    const lower = value.toLowerCase();
    return (EFFORT_LEVELS as readonly string[]).includes(lower)
        ? (lower as EffortLevel)
        : null;
}

/**
 * Mutate `params` in place to add `output_config.effort`. This is the current
 * depth control for thinking on Claude 4.6+; `budget_tokens` no longer tunes it.
 * The installed SDK predates `output_config`, so this relies on the request
 * body being passed through verbatim — hence the `as any` at the call site.
 */
export function applyEffortParams(params: Record<string, any>, effort: EffortLevel | null): void {
    if (!effort) return;
    params.output_config = { ...(params.output_config ?? {}), effort };
}

/**
 * True when a 400 looks like the endpoint rejecting the thinking/effort
 * parameters rather than something wrong with the conversation. Used to
 * degrade to a plain request instead of failing the whole session: custom
 * endpoints often implement a subset of the API.
 *
 * Deliberately narrow — a 400 that doesn't name one of these fields is a real
 * error and must surface.
 */
export function isUnsupportedParamError(error: any): boolean {
    if (error?.status !== 400) return false;
    const message = String(error?.message ?? "").toLowerCase();
    if (!message) return false;
    // `reasoning` covers the OpenAI protocols' spelling of the same idea
    // (reasoning_effort, reasoning.effort).
    return ["thinking", "budget_tokens", "effort", "output_config", "reasoning"].some((k) =>
        message.includes(k),
    );
}

/**
 * Filter out thinking blocks from the assistant's response content
 * before storing in conversation history. Thinking blocks can be
 * thousands of tokens long and provide no value for subsequent turns.
 */
export function filterThinkingBlocks(
    content: Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
    return content.filter((block) => (block as any).type !== "thinking");
}
