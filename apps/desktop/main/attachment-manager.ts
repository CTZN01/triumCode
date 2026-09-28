import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, realpath, rm, readdir, open } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { MAX_ATTACHMENTS, MAX_IMAGE_SOURCE_BYTES, MAX_MODEL_IMAGE_BYTES, parseAttachment, type Attachment } from "../../../src/attachments.js";
import { sessionAttachmentDirectory } from "../../../src/session.js";

export interface PreparedImage {
    width: number;
    height: number;
    modelWidth: number;
    modelHeight: number;
    modelMimeType: "image/png" | "image/jpeg";
    modelBytes: Buffer;
    thumbnail: Buffer;
}

export type ImageProcessor = (bytes: Buffer) => Promise<PreparedImage>;
interface SavedAttachment { attachment: Attachment; sent: boolean; created: number }

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".pdf": "application/pdf", ".json": "application/json", ".md": "text/markdown",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const UNSUPPORTED_IMAGES = new Set([".gif", ".bmp", ".svg", ".heic", ".avif", ".tif", ".tiff"]);
const DOCUMENT_NOTICE = "当前仅发送文档路径，不自动解析 PDF/Office 内容；Agent 可尝试使用本机已有工具读取。";

function imageMime(bytes: Buffer): string | null {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    return null;
}

/** The main process owns file access, image snapshots, and draft/sent lifetimes. */
export class AttachmentManager {
    constructor(private readonly processImage: ImageProcessor) {}

    private directory(root: string, sessionId: string, id?: string): string {
        if (id && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new Error("附件 ID 无效。");
        const directory = sessionAttachmentDirectory(sessionId, root);
        return id ? join(directory, id) : directory;
    }

    private async save(root: string, sessionId: string, attachment: Attachment, sent = false): Promise<void> {
        const directory = this.directory(root, sessionId, attachment.id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "attachment.json"), JSON.stringify({ attachment, sent, created: Date.now() } satisfies SavedAttachment));
    }

    private async load(root: string, sessionId: string, id: string): Promise<SavedAttachment> {
        try {
            const saved = JSON.parse(await readFile(join(this.directory(root, sessionId, id), "attachment.json"), "utf8")) as SavedAttachment;
            return { ...saved, attachment: parseAttachment(saved.attachment) };
        } catch { throw new Error("附件不存在或已被删除，请重新添加。"); }
    }

    async addPath(root: string, sessionId: string, path: string): Promise<Attachment> {
        if (!isAbsolute(path)) throw new Error("附件必须使用本地文件的完整路径。");
        let actual: string;
        let info;
        try { actual = await realpath(path); info = await stat(actual); }
        catch { throw new Error(`文件不存在或无法读取：${basename(path)}`); }
        if (!info.isFile()) throw new Error("请添加文件，不能添加文件夹。");
        const suffix = extname(actual).toLowerCase();
        if (UNSUPPORTED_IMAGES.has(suffix)) throw new Error("图片格式不支持，请使用 PNG、JPG、JPEG 或 WebP。");
        const mimeType = MIME_TYPES[suffix] ?? "text/plain";
        if (mimeType.startsWith("image/")) {
            if (info.size > MAX_IMAGE_SOURCE_BYTES) throw new Error("图片不能超过 20 MiB，请先裁剪或压缩后添加。");
            return this.addImage(root, sessionId, await readFile(actual), basename(actual));
        }
        let sample: Buffer;
        try {
            const file = await open(actual, "r");
            try {
                sample = Buffer.alloc(Math.min(info.size, 8000));
                const result = await file.read(sample, 0, sample.length, 0);
                sample = sample.subarray(0, result.bytesRead);
            } finally { await file.close(); }
        } catch { throw new Error(`文件无法读取：${basename(actual)}`); }
        const document = mimeType.startsWith("application/") && mimeType !== "application/json";
        if (!document && sample.includes(0)) throw new Error("不支持此二进制文件。可添加文本、代码、日志、JSON、Markdown、PDF 或 Office 文档。");
        const inside = relative(await realpath(root), actual);
        const type = inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? "workspace_file" : "document";
        const attachment: Attachment = {
            id: randomUUID(), type, path: actual, name: basename(actual), mimeType, size: info.size,
            ...(document ? { notice: DOCUMENT_NOTICE } : {}),
        };
        await this.save(root, sessionId, attachment);
        return attachment;
    }

    async addImage(root: string, sessionId: string, bytes: Buffer, name = "pasted-image.png"): Promise<Attachment> {
        if (!bytes.length || bytes.length > MAX_IMAGE_SOURCE_BYTES) throw new Error("图片不能为空或超过 20 MiB。");
        const mimeType = imageMime(bytes);
        if (!mimeType) throw new Error("图片格式不支持或图片已损坏，请使用 PNG、JPG、JPEG 或 WebP。");
        const image = await this.processImage(bytes);
        if (!image.modelBytes.length || image.modelBytes.length > MAX_MODEL_IMAGE_BYTES) throw new Error("缩放后的图片仍超过 4 MiB，请先裁剪后添加。");
        const id = randomUUID();
        const directory = this.directory(root, sessionId, id);
        await mkdir(directory, { recursive: true });
        try {
            const path = join(directory, `original${mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png"}`);
            const modelPath = join(directory, image.modelMimeType === "image/png" ? "model.png" : "model.jpg");
            await writeFile(path, bytes);
            await writeFile(modelPath, image.modelBytes);
            await writeFile(join(directory, "thumbnail.png"), image.thumbnail);
            const attachment: Attachment = {
                id, type: "image", path, name: basename(name).slice(0, 255), mimeType, size: bytes.length,
                width: image.width, height: image.height, modelWidth: image.modelWidth, modelHeight: image.modelHeight,
                modelPath, modelMimeType: image.modelMimeType, modelSize: image.modelBytes.length,
                modelHash: createHash("sha256").update(image.modelBytes).digest("hex"),
                ...(image.width !== image.modelWidth || image.height !== image.modelHeight ? { notice: `发送 ${image.modelWidth} × ${image.modelHeight} 的缩放副本，原图保留。` } : {}),
            };
            await this.save(root, sessionId, attachment);
            return attachment;
        } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    }

    async forSend(root: string, sessionId: string, ids: string[]): Promise<Attachment[]> {
        if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new Error(`每条消息最多添加 ${MAX_ATTACHMENTS} 个不同附件。`);
        const attachments: Attachment[] = [];
        for (const id of ids) {
            const { attachment } = await this.load(root, sessionId, id);
            try { const info = await stat(attachment.type === "image" ? attachment.modelPath : attachment.path); if (!info.isFile()) throw new Error(); }
            catch { throw new Error(`附件 ${attachment.name} 不存在或已被删除，请重新添加。`); }
            attachments.push(attachment);
        }
        return attachments;
    }

    async markSent(root: string, sessionId: string, attachments: Attachment[]): Promise<() => Promise<void>> {
        const previous = await Promise.all(attachments.map(attachment => this.load(root, sessionId, attachment.id)));
        const restore = async () => {
            for (const saved of previous) await writeFile(join(this.directory(root, sessionId, saved.attachment.id), "attachment.json"), JSON.stringify(saved));
        };
        try { for (const attachment of attachments) await this.save(root, sessionId, attachment, true); }
        catch (error) { await restore(); throw error; }
        return restore;
    }

    async removeDraft(root: string, sessionId: string, id: string): Promise<void> {
        const saved = await this.load(root, sessionId, id);
        if (saved.sent) return;
        await rm(this.directory(root, sessionId, id), { recursive: true, force: true });
    }

    async preview(root: string, sessionId: string, id: string, full = false): Promise<string> {
        const { attachment } = await this.load(root, sessionId, id);
        if (attachment.type !== "image") throw new Error("此附件不是图片。");
        try {
            const bytes = await readFile(full ? attachment.path : join(this.directory(root, sessionId, id), "thumbnail.png"));
            return `data:${full ? attachment.mimeType : "image/png"};base64,${bytes.toString("base64")}`;
        } catch { throw new Error(`无法加载图片 ${attachment.name}，本地副本可能已被删除。`); }
    }

    async discardOldDrafts(root: string, sessionId: string): Promise<void> {
        const directory = this.directory(root, sessionId);
        const ids = await readdir(directory).catch(() => []);
        for (const id of ids) {
            try {
                const saved = await this.load(root, sessionId, id);
                if (!saved.sent && saved.created < Date.now() - 24 * 60 * 60 * 1000) await this.removeDraft(root, sessionId, id);
            } catch { /* An unreadable attachment is reported when the user opens or sends it. */ }
        }
    }
}
