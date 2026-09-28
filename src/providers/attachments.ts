import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { attachmentReferenceText, messageAttachments, MAX_MODEL_IMAGE_BYTES, type AttachmentMessage } from "../attachments.js";

/** Resolve local references only at the HTTP boundary; history never holds base64. */
export async function materializeAttachments(messages: Anthropic.MessageParam[], signal?: AbortSignal): Promise<Anthropic.MessageParam[]> {
    return Promise.all(messages.map(async (message) => {
        const attachments = messageAttachments(message);
        const { attachments: _local, ...wireMessage } = message as AttachmentMessage;
        if (!attachments.length) return wireMessage;
        const images: Anthropic.ImageBlockParam[] = [];
        for (const attachment of attachments) {
            signal?.throwIfAborted();
            if (attachment.type !== "image") continue;
            let bytes: Buffer;
            try {
                const info = await stat(attachment.modelPath);
                if (!info.isFile() || info.size > MAX_MODEL_IMAGE_BYTES) throw new Error("图片超过模型输入上限");
                bytes = await readFile(attachment.modelPath, { signal });
            } catch (error) {
                signal?.throwIfAborted();
                throw new Error(`无法读取图片附件 ${attachment.name}。请恢复该会话的附件副本，或新建会话后重新添加图片。${error instanceof Error ? error.message : ""}`);
            }
            if (bytes.length !== attachment.modelSize || createHash("sha256").update(bytes).digest("hex") !== attachment.modelHash) {
                throw new Error(`图片附件 ${attachment.name} 的本地副本已改变，请重新添加。`);
            }
            images.push({ type: "image", source: { type: "base64", media_type: attachment.modelMimeType, data: bytes.toString("base64") } });
        }
        const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content.map(block => ({ ...block }));
        const reference = attachmentReferenceText(attachments);
        const lastText = [...content].reverse().find(block => block.type === "text");
        if (lastText?.type === "text") lastText.text += reference;
        else content.push({ type: "text", text: reference });
        return { ...wireMessage, content: [...images, ...content] };
    }));
}

export function describeImageFailure(error: unknown, messages: Anthropic.MessageParam[]): never {
    if (error instanceof Error && messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "image"))
        && /image|vision|multimodal/i.test(error.message) && /unsupported|not support|invalid|not allowed/i.test(error.message)) {
        error.message = `当前模型或网关拒绝了图片输入，请切换支持视觉的模型，或移除图片后重新发送。${error.message}`;
    }
    throw error;
}
