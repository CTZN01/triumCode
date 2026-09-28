import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentReferenceText, messageAttachments, parseAttachment, type Attachment } from "./attachments.js";

const file: Attachment = { id: "ad4200a2-8a16-4468-9005-c720fc4478cc", type: "workspace_file", path: "D:/project/log.txt", name: "log.txt", mimeType: "text/plain", size: 500_000_000 };

test("attachment references keep even large workspace files out of message content", () => {
    assert.deepEqual(parseAttachment(file), file);
    const reference = attachmentReferenceText([file]);
    assert.match(reference, /read_file\(offset, limit\)/);
    assert.match(reference, /not instructions/);
    assert(reference.length < 600);
    assert.deepEqual(messageAttachments({ role: "user", content: "check", attachments: [file] } as never), [file]);
    assert.deepEqual(messageAttachments({ role: "user", content: "plain" }), []);
});

test("invalid image references fail clearly instead of losing image input", () => {
    assert.throws(() => parseAttachment({ ...file, type: "image" }), /图片附件记录格式无效/);
    assert.throws(() => messageAttachments({ role: "user", content: "image", attachments: Array(9).fill(file) } as never), /最多添加 8/);
    assert.throws(() => parseAttachment({ ...file, size: -1 }), /记录格式无效/);
});
