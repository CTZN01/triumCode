import type { DesktopSettings } from "../shared/contracts.js";
import { DesktopServiceError } from "./workspace-store.js";

export function parseSettings(value: unknown): DesktopSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Settings are invalid.");
    }
    const input = value as Partial<DesktopSettings>;
    const allowed = new Set(["model", "modelPreset", "apiBase", "protocol", "auth", "thinking", "effort", "contextWindow", "maxParallelRuns"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Settings contain an unknown field.");
    }
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Enter a model name up to 200 characters.");
    }
    if (input.modelPreset !== null && (typeof input.modelPreset !== "string"
        || !input.modelPreset || input.modelPreset.length > 200)) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Select a valid model preset or custom configuration.");
    }
    if (typeof input.apiBase !== "string" || input.apiBase.length > 2000) {
        throw new DesktopServiceError("INVALID_SETTINGS", "API base URL is invalid.");
    }
    if (input.apiBase.trim()) {
        let url: URL;
        try { url = new URL(input.apiBase); }
        catch { throw new DesktopServiceError("INVALID_SETTINGS", "API base URL must be an http or https URL."); }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new DesktopServiceError("INVALID_SETTINGS", "API base URL must be an http or https URL.");
        }
        if (url.username || url.password || url.search || url.hash) {
            throw new DesktopServiceError("INVALID_SETTINGS", "API base URL cannot contain credentials, query parameters, or a fragment. Save the API Key separately.");
        }
    }
    if (input.protocol !== "anthropic" && input.protocol !== "openai-chat" && input.protocol !== "openai-responses") {
        throw new DesktopServiceError("INVALID_SETTINGS", "Select a supported API protocol.");
    }
    if (input.auth !== "api-key" && input.auth !== "bearer") {
        throw new DesktopServiceError("INVALID_SETTINGS", "Select a supported authentication scheme.");
    }
    if (typeof input.thinking !== "boolean") throw new DesktopServiceError("INVALID_SETTINGS", "Thinking must be enabled or disabled.");
    if (!input.effort || !["low", "medium", "high", "xhigh", "max"].includes(input.effort)) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Select a supported reasoning effort.");
    }
    if (typeof input.contextWindow !== "number" || !Number.isSafeInteger(input.contextWindow)
        || input.contextWindow < 1024 || input.contextWindow > 10_000_000) {
        throw new DesktopServiceError("INVALID_SETTINGS", "Context window must be between 1,024 and 10,000,000 tokens.");
    }
    if (typeof input.maxParallelRuns !== "number" || !Number.isSafeInteger(input.maxParallelRuns)
        || input.maxParallelRuns < 1 || input.maxParallelRuns > 8) {
        throw new DesktopServiceError("INVALID_SETTINGS", "同时运行任务数必须是 1 到 8 之间的整数。");
    }
    return {
        model: input.model.trim(),
        modelPreset: input.modelPreset,
        apiBase: input.apiBase.trim(),
        protocol: input.protocol,
        auth: input.auth,
        thinking: input.thinking,
        effort: input.effort,
        contextWindow: input.contextWindow,
        maxParallelRuns: input.maxParallelRuns,
    };
}
