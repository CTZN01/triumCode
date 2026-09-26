import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionFailureMessage } from "./connection-result.js";

test("connection errors give a specific next step without returning provider text", () => {
    assert.match(connectionFailureMessage({ status: 401, message: "secret response" }, false), /API Key/);
    assert.match(connectionFailureMessage({ status: 429 }, false), /限流/);
    assert.match(connectionFailureMessage({ status: 503 }, false), /模型名称/);
    assert.match(connectionFailureMessage({ cause: { code: "ECONNREFUSED" } }, false), /网络/);
    assert.doesNotMatch(connectionFailureMessage({ status: 401, message: "secret response" }, false), /secret response/);
});

test("a timed out test names the timeout even if abort has no network status", () => {
    assert.match(connectionFailureMessage(new Error("aborted"), true), /20 秒/);
});
