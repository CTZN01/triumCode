import type Anthropic from "@anthropic-ai/sdk";

// ═══════════════════════════════════════════════════════════════
// Extended Thinking support
// ═══════════════════════════════════════════════════════════════
//
// Extended Thinking lets the model use a private "scratchpad" for
// multi-step reasoning before producing its visible output.  This is
// especially helpful for coding tasks that require planning.
//
// Three modes:
//   adaptive  — claude-sonnet-4+ models decide for themselves (budget 10000)
//   enabled   --thinking flag explicitly turns it on (budget maximized)
//   disabled  — models that don't support thinking (Claude 3.x, OpenAI)

export type ThinkingMode = "adaptive" | "enabled" | "disabled";

// Models that support Extended Thinking at all.
const THINKING_MODELS = [
    "claude-sonnet-4", "claude-4",
    "claude-opus-4", "claude-3-5-sonnet",
];

// Models that support adaptive thinking (model decides when to think).
const ADAPTIVE_THINKING_MODELS = [
    "claude-sonnet-4", "claude-4",
];

function modelMatches(model: string, prefixes: string[]): boolean {
    const lower = model.toLowerCase();
    return prefixes.some((p) => lower.includes(p));
}

export function modelSupportsThinking(model: string): boolean {
    return modelMatches(model, THINKING_MODELS);
}

export function modelSupportsAdaptiveThinking(model: string): boolean {
    return modelMatches(model, ADAPTIVE_THINKING_MODELS);
}

/**
 * Resolve which thinking mode to use based on the model and the
 * --thinking CLI flag.
 */
export function resolveThinkingMode(model: string, thinkingFlag: boolean): ThinkingMode {
    if (!modelSupportsThinking(model)) return "disabled";
    if (thinkingFlag) return "enabled";
    if (modelSupportsAdaptiveThinking(model)) return "adaptive";
    return "disabled";
}

/**
 * Mutate `params` in-place to add the `thinking` configuration block.
 * `maxTokens` is the model's max_output_tokens — thinking budget is
 * set just below it to stay within API limits.
 */
export function applyThinkingParams(
    params: Record<string, any>,
    mode: ThinkingMode,
    maxTokens: number,
): void {
    if (mode === "enabled") {
        params.thinking = { type: "enabled", budget_tokens: maxTokens - 1 };
    } else if (mode === "adaptive") {
        params.thinking = { type: "enabled", budget_tokens: 10000 };
    }
    // "disabled": no thinking parameter added.
}

/**
 * Filter out thinking blocks from the assistant's response content
 * before storing in conversation history.  Thinking blocks can be
 * thousands of tokens long and provide no value for subsequent turns.
 */
export function filterThinkingBlocks(
    content: Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
    return content.filter((block) => (block as any).type !== "thinking");
}
