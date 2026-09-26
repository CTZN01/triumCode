import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopSettings } from "../shared/contracts.js";
import { parseSettings } from "./settings-input.js";

const settings: DesktopSettings = {
    model: "test-model",
    modelPreset: null,
    apiBase: "https://example.test/v1",
    protocol: "openai-chat",
    auth: "bearer",
    thinking: false,
    effort: "medium",
    contextWindow: 100_000,
    maxParallelRuns: 3,
};

test("settings input keeps a valid route and rejects malformed preset identities", () => {
    assert.deepEqual(parseSettings(settings), settings);
    assert.throws(() => parseSettings({ ...settings, modelPreset: 17 }), /model preset/);
    assert.throws(() => parseSettings({ ...settings, modelPreset: "x".repeat(201) }), /model preset/);
    assert.throws(() => parseSettings({ ...settings, unexpected: true }), /unknown field/);
});

test("settings input refuses secrets and extra URL parts in the base address", () => {
    for (const apiBase of [
        "https://user:secret@example.test/v1",
        "https://example.test/v1?api_key=secret",
        "https://example.test/v1#secret",
    ]) {
        assert.throws(() => parseSettings({ ...settings, apiBase }), /Save the API Key separately/);
    }
});
