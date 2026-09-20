import { AnthropicProvider } from "./anthropic.js";
import { OpenAIChatProvider } from "./openai-chat.js";
import { OpenAIResponsesProvider } from "./openai-responses.js";
import type { ModelProvider, Protocol, ProviderConfig } from "./types.js";

export * from "./types.js";

// One line per protocol; the choice is a lookup, not a chain of conditionals
// scattered through the agent.

export function createProvider(protocol: Protocol, cfg: ProviderConfig): ModelProvider {
    switch (protocol) {
        case "openai-chat": return new OpenAIChatProvider(cfg);
        case "openai-responses": return new OpenAIResponsesProvider(cfg);
        default: return new AnthropicProvider(cfg);
    }
}
