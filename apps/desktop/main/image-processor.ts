import { BrowserWindow, nativeImage, type NativeImage } from "electron";
import { MAX_MODEL_IMAGE_BYTES } from "../../../src/attachments.js";
import type { PreparedImage } from "./attachment-manager.js";

const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 1568;
const MAX_MODEL_PIXELS = 1_200_000;

async function decodeImage(bytes: Buffer): Promise<NativeImage> {
    let image = nativeImage.createFromBuffer(bytes);
    if (!image.isEmpty()) return image;
    if (bytes.toString("ascii", 8, 12) !== "WEBP") throw new Error("图片解码失败，请检查文件是否损坏。");
    // nativeImage guarantees PNG/JPEG; Chromium supplies WebP without another dependency.
    const decoder = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
        await decoder.loadURL("data:text/html,<meta http-equiv=Content-Security-Policy content=\"default-src 'none'; img-src data:\">");
        const png: number[] = await decoder.webContents.executeJavaScript(`(async () => {
            const binary = atob(${JSON.stringify(bytes.toString("base64"))});
            const buffer = Uint8Array.from(binary, character => character.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([buffer], { type: "image/webp" }));
            try {
                if (bitmap.width * bitmap.height > ${MAX_PIXELS} || Math.max(bitmap.width, bitmap.height) > 16000) throw new Error("图片尺寸过大，请先裁剪后添加。");
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                canvas.getContext("2d").drawImage(bitmap, 0, 0);
                return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
            } finally { bitmap.close(); }
        })()`);
        image = nativeImage.createFromBuffer(Buffer.from(png));
        if (image.isEmpty()) throw new Error("图片解码失败。");
        return image;
    } catch (error) { throw new Error(`WebP 图片解码失败。${error instanceof Error ? error.message : ""}`); }
    finally { decoder.destroy(); }
}

export async function processAttachmentImage(bytes: Buffer): Promise<PreparedImage> {
    const original = await decodeImage(bytes);
    const { width, height } = original.getSize();
    if (width * height > MAX_PIXELS || Math.max(width, height) > 16000) throw new Error("图片尺寸过大，请先裁剪后添加。");
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_MODEL_PIXELS / (width * height)));
    const modelWidth = Math.max(1, Math.round(width * scale));
    const modelHeight = Math.max(1, Math.round(height * scale));
    const model = scale < 1 ? original.resize({ width: modelWidth, height: modelHeight, quality: "best" }) : original;
    let modelBytes = model.toPNG();
    let modelMimeType: PreparedImage["modelMimeType"] = "image/png";
    if (modelBytes.length > MAX_MODEL_IMAGE_BYTES) { modelBytes = model.toJPEG(85); modelMimeType = "image/jpeg"; }
    const thumbnailScale = Math.min(1, 240 / Math.max(width, height));
    const thumbnail = original.resize({ width: Math.max(1, Math.round(width * thumbnailScale)), height: Math.max(1, Math.round(height * thumbnailScale)), quality: "good" }).toPNG();
    return { width, height, modelWidth, modelHeight, modelBytes, modelMimeType, thumbnail };
}
