import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { materializeAttachments, describeImageFailure } from "./attachments.js";
import { toChatMessages } from "./openai-chat.js";
import { toResponsesInput } from "./openai-responses.js";
import { withCacheBreakpoints } from "../context-compression.js";
import type { Attachment, AttachmentMessage } from "../attachments.js";

test("local images become real visual inputs on all three protocols without mutating history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-image-wire-"));
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBe0AAAAASUVORK5CYII=", "base64");
    const path = join(directory, "model.png");
    const attachment: Attachment = { id: "ad4200a2-8a16-4468-9005-c720fc4478cc", type: "image", path, modelPath: path, name: "UI.png", mimeType: "image/png", size: bytes.length,
        width: 1, height: 1, modelWidth: 1, modelHeight: 1, modelMimeType: "image/png", modelSize: bytes.length, modelHash: createHash("sha256").update(bytes).digest("hex") };
    try {
        await writeFile(path, bytes);
        const history: AttachmentMessage[] = [{ role: "user", content: [{ type: "text", text: "explain this image" }], attachments: [attachment] }];
        const original = JSON.stringify(history);
        const cached = withCacheBreakpoints(history, [{ type: "text", text: "stable system" }]);
        const wire = await materializeAttachments(cached.messages);
        assert.equal(JSON.stringify(history), original);
        assert(!original.includes(bytes.toString("base64")));
        assert(!("attachments" in wire[0]));
        assert(Array.isArray(wire[0].content));
        const content = wire[0].content;
        assert.deepEqual(content[0], { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } });
        const cachedText = content.at(-1);
        assert(cachedText?.type === "text");
        assert.deepEqual(cachedText.cache_control, { type: "ephemeral" });
        assert.deepEqual(await materializeAttachments(cached.messages), wire, "repeated requests keep their image bytes and prefix identical");
        const chat = toChatMessages([], wire)[0].content;
        assert.equal(chat[0].type, "image_url");
        assert.equal(chat[0].image_url.url, `data:image/png;base64,${bytes.toString("base64")}`);
        const responses = toResponsesInput(wire)[0].content;
        assert.equal(responses[0].type, "input_image");
        assert.equal(responses[0].image_url, chat[0].image_url.url);
        await writeFile(path, "changed");
        await assert.rejects(materializeAttachments(history), /本地副本已改变/);
        await rm(path);
        await assert.rejects(materializeAttachments(history), /无法读取图片附件/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("text-only request bytes stay unchanged and unsupported vision errors are actionable", async () => {
    const messages: AttachmentMessage[] = [{ role: "user", content: [{ type: "text", text: "same bytes", cache_control: { type: "ephemeral" } }] }];
    assert.equal(JSON.stringify(await materializeAttachments(messages)), JSON.stringify(messages));
    assert.throws(() => describeImageFailure(new Error("model does not support image input"), [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }]), /切换支持视觉的模型/);
});
