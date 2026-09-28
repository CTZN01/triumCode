import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentManager } from "./attachment-manager.js";
import { sessionAttachmentDirectory } from "../../../src/session.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const manager = new AttachmentManager(async bytes => ({ width: 3000, height: 2000, modelWidth: 1341, modelHeight: 894, modelBytes: bytes, modelMimeType: "image/png", thumbnail: bytes }));

test("workspace and external files stay references; PDF support is explicit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-attachment-files-"));
    const outside = await mkdtemp(join(tmpdir(), "triumcode-attachment-outside-"));
    const sessionId = "abc12345";
    try {
        await writeFile(join(directory, "code.ts"), "const answer = 42;\n".repeat(4000));
        await writeFile(join(outside, "log.txt"), "line\n".repeat(30_000));
        await writeFile(join(outside, "guide.pdf"), "%PDF-1.7\n");
        const code = await manager.addPath(directory, sessionId, join(directory, "code.ts"));
        const log = await manager.addPath(directory, sessionId, join(outside, "log.txt"));
        const pdf = await manager.addPath(directory, sessionId, join(outside, "guide.pdf"));
        assert.equal(code.type, "workspace_file");
        assert.equal(code.path, join(directory, "code.ts"));
        assert.equal(log.type, "document");
        assert(!("content" in code));
        assert.match(pdf.notice!, /不自动解析/);
        assert.deepEqual(await manager.forSend(directory, sessionId, [code.id, log.id, pdf.id]), [code, log, pdf]);
        await manager.removeDraft(directory, sessionId, code.id);
        assert(await stat(code.path), "removing a reference must never delete the original file");
        await rm(log.path);
        await assert.rejects(manager.forSend(directory, sessionId, [log.id]), /不存在或已被删除/);
        await assert.rejects(manager.addPath(directory, sessionId, join(outside, "missing.png")), /文件不存在/);
        await assert.rejects(manager.addPath(directory, sessionId, outside), /不能添加文件夹/);
        await assert.rejects(manager.preview(directory, sessionId, "../../other"), /不存在或已被删除/);
    } finally {
        await rm(sessionAttachmentDirectory(sessionId, directory), { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
    }
});

test("image snapshots survive original deletion and sent attachments cannot be removed as drafts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triumcode-attachment-images-"));
    const sessionId = "abc12345";
    try {
        const source = join(directory, "screenshot.png");
        await writeFile(source, png);
        const image = await manager.addPath(directory, sessionId, source);
        assert.equal(image.type, "image");
        if (image.type !== "image") throw new Error("expected image");
        assert.notEqual(image.path, source);
        assert.match(image.notice!, /原图保留/);
        await rm(source);
        await manager.markSent(directory, sessionId, [image]);
        await manager.removeDraft(directory, sessionId, image.id);
        assert.deepEqual(await manager.forSend(directory, sessionId, [image.id]), [image]);
        assert.match(await manager.preview(directory, sessionId, image.id), /^data:image\/png;base64,/);
        assert.deepEqual(await readFile(image.path), png);
        const draft = await manager.addImage(directory, sessionId, png);
        await manager.removeDraft(directory, sessionId, draft.id);
        await assert.rejects(manager.forSend(directory, sessionId, [draft.id]), /附件不存在/);
        await assert.rejects(manager.addImage(directory, sessionId, Buffer.from("broken")), /图片格式不支持/);
        await assert.rejects(manager.addImage(directory, sessionId, Buffer.alloc(20 * 1024 * 1024 + 1)), /20 MiB/);
        await assert.rejects(manager.forSend(directory, sessionId, Array(9).fill(image.id)), /最多添加 8/);
        const expired = await manager.addImage(directory, sessionId, png);
        const metadataPath = join(sessionAttachmentDirectory(sessionId, directory), expired.id, "attachment.json");
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        metadata.created -= 25 * 60 * 60 * 1000;
        await writeFile(metadataPath, JSON.stringify(metadata));
        await manager.discardOldDrafts(directory, sessionId);
        await assert.rejects(manager.forSend(directory, sessionId, [expired.id]), /附件不存在/);
        assert.deepEqual(await manager.forSend(directory, sessionId, [image.id]), [image], "sent snapshots never expire as drafts");
    } finally {
        await rm(sessionAttachmentDirectory(sessionId, directory), { recursive: true, force: true });
        await rm(directory, { recursive: true, force: true });
    }
});
