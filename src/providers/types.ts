import type Anthropic from "@anthropic-ai/sdk";
import type { EffortLevel, ThinkingMode } from "../thinking.js";

// ═══════════════════════════════════════════════════════════════
// Model providers — one request shape, three wire protocols
// ═══════════════════════════════════════════════════════════════
//
// The agent loop is written against Anthropic's Messages protocol: history is
// Anthropic.MessageParam, and a turn is consumed as
// content_block_start / content_block_delta / content_block_stop /
// message_delta events (src/agent.ts). That shape stays canonical here rather
// than becoming a common denominator, so an OpenAI-protocol backend needs a
// translator on each side of the HTTP call instead of a second agent loop.
//
// Why three protocols at all: a model gateway routes each model to whichever
// API its upstream actually serves. OpenCode Zen, for one, splits its roster
// across /messages (MiniMax, Qwen), /chat/completions (DeepSeek, GLM, Kimi,
// MiMo) and /responses (GPT, Grok), so choosing a model chooses a protocol.

export type Protocol = "anthropic" | "openai-chat" | "openai-responses";

export const PROTOCOLS: readonly Protocol[] = ["anthropic", "openai-chat", "openai-responses"];

/** How the key travels. Gateways disagree: Anthropic uses x-api-key, OpenAI Bearer. */
export type AuthScheme = "api-key" | "bearer";

export const AUTH_SCHEMES: readonly AuthScheme[] = ["api-key", "bearer"];

export function parseProtocol(value: string | undefined | null): Protocol | null {
    if (!value) return null;
    const lower = value.toLowerCase();
    return (PROTOCOLS as readonly string[]).includes(lower) ? (lower as Protocol) : null;
}

export function parseAuthScheme(value: string | undefined | null): AuthScheme | null {
    if (!value) return null;
    const lower = value.toLowerCase();
    return (AUTH_SCHEMES as readonly string[]).includes(lower) ? (lower as AuthScheme) : null;
}

/** The Bearer scheme is what every OpenAI-compatible gateway expects. */
export function defaultAuthFor(protocol: Protocol): AuthScheme {
    return protocol === "anthropic" ? "api-key" : "bearer";
}

/** One agent-loop turn, in the protocol-neutral form providers translate. */
export interface ModelRequest {
    model: string;
    maxTokens: number;
    system: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    /** Resolved once per request; "disabled" means send no reasoning params. */
    thinkingMode: ThinkingMode;
    effort: EffortLevel | null;
}

/** The small non-streaming call used for memory recall. */
export interface SideTextRequest {
    model: string;
    system: string;
    user: string;
    maxTokens: number;
}

export interface ProviderConfig {
    apiBase: string;
    apiKey: string;
    auth: AuthScheme;
}

/**
 * Yields Anthropic-shaped stream events for one turn.
 *
 * The stream is returned only once the response headers are in, so
 * withRetry() sees the 429/503 that a rejected turn usually carries — an
 * error thrown mid-iteration would not be retried and would also leave a
 * half-printed turn on screen.
 */
export interface ModelProvider {
    readonly protocol: Protocol;
    stream(req: ModelRequest, signal?: AbortSignal): Promise<AsyncIterable<any>>;
    completeText(req: SideTextRequest, signal?: AbortSignal): Promise<string>;
}

/**
 * Carries the HTTP status so retry.ts (429/503/529) and thinking.ts
 * (a 400 naming an optional param) can both read it without parsing strings.
 */
export class ProviderError extends Error {
    public status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ProviderError";
        this.status = status;
    }
}

/**
 * The endpoint root, without a version segment.
 *
 * Users copy the base URL straight out of vendor docs, which write it as
 * ".../v1" — while the Anthropic SDK appends "/v1/messages" to whatever it is
 * given, so ".../v1" becomes ".../v1/v1/messages" and every request 404s.
 * Every provider therefore derives its own path from this root.
 *
 * An unset base stays unset: the Anthropic SDK has its own default, and the
 * OpenAI protocols have none worth inventing here.
 */
export function apiRoot(apiBase: string | undefined | null): string {
    let root = (apiBase ?? "").trim().replace(/\/+$/, "");
    if (/\/v1$/i.test(root)) root = root.slice(0, -3);
    return root;
}

export function endpoint(apiBase: string | undefined | null, path: string): string {
    const root = apiRoot(apiBase);
    if (!root) {
        throw new Error(`/${path} needs an endpoint — pass --api-base (or set apiBase in the config file)`);
    }
    return `${root}/${path.replace(/^\/+/, "")}`;
}

/** Anthropic allows several system blocks; the OpenAI protocols take one string. */
export function joinTextBlocks(blocks: Anthropic.TextBlockParam[] | undefined): string {
    if (!blocks) return "";
    return blocks
        .filter((b) => b && (b as any).type === "text")
        .map((b) => b.text)
        .join("\n\n");
}

export function authHeaders(cfg: ProviderConfig): Record<string, string> {
    return cfg.auth === "bearer"
        ? { Authorization: `Bearer ${cfg.apiKey}` }
        : { "x-api-key": cfg.apiKey };
}

/** POST the body and wait for the status line — the retryable failure point. */
export async function postForStream(
    url: string,
    headers: Record<string, string>,
    body: Record<string, any>,
    signal?: AbortSignal,
): Promise<Response> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw await statusError(res);
    return res;
}

export async function postForJson(
    url: string,
    headers: Record<string, string>,
    body: Record<string, any>,
    signal?: AbortSignal,
): Promise<any> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw await statusError(res);
    return await res.json();
}

/**
 * Keep the API's own JSON error payload intact: agent.ts briefApiError() digs
 * the message field out of it, and throwing away the body is what made
 * third-party endpoints undebuggable.
 *
 * The whole body is kept, not its first line — a pretty-printed payload would
 * lose that message field, and with it the parameter name
 * isUnsupportedParamError() keys on. That is the difference between degrading
 * the turn and failing it.
 */
async function statusError(res: Response): Promise<ProviderError> {
    const raw = (await res.text().catch(() => "")).trim();
    return new ProviderError(res.status, raw || `HTTP ${res.status} from ${res.url}`);
}

// ── Server-sent events ────────────────────────────────────────
//
// Frames are separated by a blank line and may carry several `data:` lines,
// which join with newlines before parsing. `event:`/`id:` fields are ignored:
// every payload examined here repeats its type inside the JSON.

export async function* readSse(res: Response): AsyncGenerator<Record<string, any>> {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";

    const emit: Record<string, any>[] = [];
    const flushFrame = (frame: string): boolean => {
        const lines = frame.split("\n");
        const data: string[] = [];
        for (const line of lines) {
            if (line.startsWith(":")) continue;         // keepalive comment
            if (!line.startsWith("data:")) continue;    // event:/id:/retry:
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length === 0) return false;
        const payload = data.join("\n").trim();
        if (!payload || payload === "[DONE]") return payload === "[DONE]";
        try {
            emit.push(JSON.parse(payload));
        } catch {
            // A frame that isn't JSON is a proxy status line or a partial
            // write; skipping it beats killing a turn that is streaming fine.
        }
        return false;
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let cut = buffer.indexOf("\n\n");
            while (cut >= 0) {
                const frame = buffer.slice(0, cut);
                buffer = buffer.slice(cut + 2);
                if (flushFrame(frame)) return;
                while (emit.length) yield emit.shift()!;
                cut = buffer.indexOf("\n\n");
            }
        }
        if (buffer.trim() && flushFrame(buffer)) return;
        while (emit.length) yield emit.shift()!;
    } finally {
        reader.releaseLock();
    }
}

// ── Shared translation helpers ────────────────────────────────

/** Anthropic's content blocks, flattened to the plain text a tool result wants. */
export function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part: any) => (part?.type === "text" ? part.text : JSON.stringify(part)))
            .join("\n");
    }
    return content === undefined || content === null ? "" : JSON.stringify(content);
}

/**
 * Effort levels are Anthropic's vocabulary. OpenAI's `reasoning_effort` has no
 * top rung, so `max` lands on the deepest setting that does exist rather than
 * being dropped — silently losing depth is worse than approximating it.
 */
export function openaiEffort(effort: EffortLevel): string {
    return effort === "max" ? "high" : effort;
}

export function stopReasonFromFinish(finishReason: string | null | undefined, sawToolCall: boolean): string {
    switch (finishReason) {
        case "tool_calls": return "tool_use";
        case "length": return "max_tokens";
        case "content_filter": return "refusal";
        case "stop":
        case null:
        case undefined: return sawToolCall ? "tool_use" : "end_turn";
        default: return sawToolCall ? "tool_use" : "end_turn";
    }
}
