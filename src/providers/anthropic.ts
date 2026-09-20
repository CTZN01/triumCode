import Anthropic from "@anthropic-ai/sdk";
import { applyEffortParams, applyThinkingParams } from "../thinking.js";
import {
    apiRoot,
    type ModelProvider,
    type ModelRequest,
    type ProviderConfig,
    type SideTextRequest,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════
// Anthropic Messages — the native path
// ═══════════════════════════════════════════════════════════════
//
// The agent loop already speaks this protocol, so this provider mostly hands
// work through to the SDK. Two things live here that used to live in agent.ts:
// the thinking/effort params (their shape is Anthropic-specific), and the
// choice of x-api-key vs Authorization, which the SDK decides from which of
// its two credential fields is populated.

export class AnthropicProvider implements ModelProvider {
    public readonly protocol = "anthropic" as const;
    private client: Anthropic;

    constructor(cfg: ProviderConfig) {
        // An empty base means "the SDK's own default", not "our default".
        const base = apiRoot(cfg.apiBase) || undefined;
        this.client = cfg.auth === "bearer"
            // authToken is what makes the SDK emit `Authorization: Bearer`;
            // apiKey must be explicitly null, or the SDK insists on x-api-key.
            ? new Anthropic({ baseURL: base, apiKey: null, authToken: cfg.apiKey })
            : new Anthropic({ baseURL: base, apiKey: cfg.apiKey });
    }

    async stream(req: ModelRequest, signal?: AbortSignal): Promise<AsyncIterable<any>> {
        const body: Record<string, any> = {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: req.messages,
            tools: req.tools,
            stream: true,
        };
        applyThinkingParams(body, req.thinkingMode, req.maxTokens);
        applyEffortParams(body, req.effort);

        // The SDK returns once the response headers are in, so a rejected turn
        // still surfaces here rather than mid-iteration.
        return await this.client.messages.create({ ...body, signal } as any) as any;
    }

    async completeText(req: SideTextRequest, signal?: AbortSignal): Promise<string> {
        const response: any = await this.client.messages.create({
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            signal,
        } as any);
        const blocks: any[] = response?.content ?? [];
        return blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    }
}
