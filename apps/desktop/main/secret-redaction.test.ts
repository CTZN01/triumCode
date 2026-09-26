import assert from "node:assert/strict";
import { test } from "node:test";
import { redactConfiguredKey, redactSessionMessages } from "./secret-redaction.js";

test("an arbitrary configured key is removed from visible text", () => {
    const key = "custom-gateway-credential-123";
    assert.equal(redactConfiguredKey(`prefix ${key} suffix`, key), "prefix [REDACTED] suffix");
});

test("saved session messages remove the key without mutating the active Agent history", () => {
    const key = "custom-gateway-credential-123";
    const messages = [{ role: "assistant", content: [{ type: "tool_use", input: { args: [key] } },
        { type: "tool_result", content: `output: ${key}` }] }];
    const safe = redactSessionMessages(messages, key);
    assert.doesNotMatch(JSON.stringify(safe), /custom-gateway-credential-123/);
    assert.match(JSON.stringify(messages), /custom-gateway-credential-123/);
});

test("a short development key does not corrupt ordinary conversation text", () => {
    assert.equal(redactConfiguredKey("a cat", "a"), "a cat");
});

test("key rotation removes both old and new credentials from later session saves", () => {
    const oldKey = "gateway-secret-123";
    const newKey = "gateway-secret-1234";
    const keys = [oldKey, newKey];
    const messages = [{ role: "assistant", content: `${oldKey} then ${newKey}` }];
    assert.deepEqual(redactSessionMessages(messages, keys), [
        { role: "assistant", content: "[REDACTED] then [REDACTED]" },
    ]);
    assert.equal(redactConfiguredKey(`error: ${oldKey}, ${newKey}`, keys),
        "error: [REDACTED], [REDACTED]");
    assert.equal(messages[0].content, `${oldKey} then ${newKey}`);
});
