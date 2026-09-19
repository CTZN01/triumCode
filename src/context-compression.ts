import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_RESULT_PERSIST_THRESHOLD = 30_000;
export const TOOL_RESULT_TRUNCATE_THRESHOLD = 50_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

const RESULT_DIR = join(os.homedir(), ".mini-claude", "tool-results");
const PREVIEW_CHARS = 2_000;

type Message = Anthropic.MessageParam;
type Block = Record<string, any>;

export interface CompressionOptions {
    contextWindow?: number;
    cacheHot?: boolean;
    idleMs?: number;
    now?: number;
}

export interface CompressionStats {
    utilization: number;
    changed: boolean;
    persisted: number;
    compacted: boolean;
}

export function truncateResult(result: string, limit = TOOL_RESULT_TRUNCATE_THRESHOLD): string {
    if (result.length <= limit) return result;
    const marker = `\n\n[... result truncated: ${result.length - limit} characters omitted ...]\n\n`;
    const available = Math.max(0, limit - marker.length);
    const head = Math.ceil(available * 0.65);
    const tail = available - head;
    return result.slice(0, head) + marker + result.slice(-tail);
}

export function persistLargeResult(result: string, now = Date.now()): string {
    if (result.length <= TOOL_RESULT_PERSIST_THRESHOLD) return result;
    try {
        mkdirSync(RESULT_DIR, { recursive: true });
        const digest = createHash("sha256").update(result).digest("hex").slice(0, 16);
        const filePath = join(RESULT_DIR, `${now}-${digest}.txt`);
        if (!existsSync(filePath)) writeFileSync(filePath, result, "utf8");
        return `[full tool result saved to ${filePath}]\n${truncateResult(result, PREVIEW_CHARS)}`;
    } catch {
        return result;
    }
}

export function prepareToolResult(result: string, now = Date.now()): string {
    return truncateResult(persistLargeResult(result, now));
}

function textOf(block: Block): string {
    return typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
}

function replaceToolResults(messages: Message[], replacer: (block: Block, index: number) => string | null): Message[] {
    let toolIndex = 0;
    return messages.map((message): Message => {
        if (message.role !== "user" || !Array.isArray(message.content)) return message;
        let changed = false;
        const content = (message.content as Block[]).map((block) => {
            if (block.type !== "tool_result") return block;
            const replacement = replacer(block, toolIndex++);
            if (replacement === null) return block;
            changed = true;
            return { ...block, content: replacement };
        });
        return changed ? { ...message, content } as Message : message;
    });
}

function toolResultCount(messages: Message[]): number {
    return messages.reduce((count, message) => count +
        (message.role === "user" && Array.isArray(message.content)
            ? (message.content as Block[]).filter((block) => block.type === "tool_result").length : 0), 0);
}

function estimateTokens(messages: Message[]): number {
    return Math.ceil(JSON.stringify(messages).length / 4);
}

function snippet(message: Message, label: string, text: string): string {
    const preview = truncateResult(text, PREVIEW_CHARS);
    return `[${label}]\n${preview}`;
}

function budget(messages: Message[], maxChars: number): Message[] {
    let remaining = maxChars;
    return replaceToolResults(messages, (block) => {
        const text = textOf(block);
        if (text.length <= remaining) {
            remaining -= text.length;
            return null;
        }
        const kept = Math.max(500, remaining);
        remaining = 0;
        return snippet(block as Message, "tool result budgeted", truncateResult(text, kept));
    });
}

function snip(messages: Message[]): Message[] {
    const all = messages.flatMap((message) =>
        message.role === "user" && Array.isArray(message.content)
            ? (message.content as Block[]).filter((block) => block.type === "tool_result") : []);
    const keep = new Set(all.slice(-3));
    const toolMeta = new Map<string, { name: string; file?: string }>();
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
            if (block.type === "tool_use" && block.id) {
                toolMeta.set(block.id, {
                    name: block.name,
                    file: block.name === "read_file" ? block.input?.file_path : undefined,
                });
            }
        }
    }
    const latestRead = new Map<string, string>();
    const searchIds: string[] = [];
    for (const [id, meta] of toolMeta) {
        if (meta.file) latestRead.set(meta.file, id);
        if (meta.name === "grep_search" || meta.name === "semantic_search") searchIds.push(id);
    }
    const recentSearches = new Set(searchIds.slice(-3));
    return replaceToolResults(messages, (block) => {
        if (keep.has(block)) return null;
        const id = String(block.tool_use_id ?? "");
        const meta = toolMeta.get(id);
        if (meta?.file && latestRead.get(meta.file) !== id) {
            return snippet(block as Message, "older read_file result snipped", textOf(block));
        }
        if (meta && (meta.name === "grep_search" || meta.name === "semantic_search") && !recentSearches.has(id)) {
            return snippet(block as Message, "older search result snipped", textOf(block));
        }
        return null;
    }).map((message) => message);
}

function microcompact(messages: Message[]): Message[] {
    const total = toolResultCount(messages);
    const keepFrom = Math.max(0, total - 3);
    let index = 0;
    return replaceToolResults(messages, (block) => {
        const shouldKeep = index++ >= keepFrom;
        return shouldKeep ? null : "[older tool result omitted after context cache cooled]";
    });
}

export function withCacheBreakpoints(messages: Message[], system: Anthropic.TextBlockParam[]): {
    messages: Message[];
    system: Anthropic.TextBlockParam[];
} {
    const nextSystem: Anthropic.TextBlockParam[] = system.map((block, index) => index === 0
        ? { ...block, cache_control: { type: "ephemeral" as const } } : { ...block });
    const nextMessages = messages.map((message) => ({ ...message }));
    const last = nextMessages[nextMessages.length - 1];
    if (last && Array.isArray(last.content) && last.content.length > 0) {
        const content = [...last.content] as Block[];
        content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
        nextMessages[nextMessages.length - 1] = { ...last, content } as Message;
    }
    return { messages: nextMessages, system: nextSystem };
}

export function compactHistory(messages: Message[]): Message[] {
    if (messages.length <= 4) return messages.map((message) => ({ ...message }));
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const source = messages.slice(0, -1).map((message) => `${message.role}: ${JSON.stringify(message.content)}`).join("\n");
    const summary = `Conversation summary (local compact):\n${truncateResult(source, 12_000)}`;
    return [{ role: "user", content: summary }, ...(latestUser ? [latestUser] : [])];
}

export function shouldAutoCompact(messages: Message[], contextWindow = DEFAULT_CONTEXT_WINDOW): boolean {
    return estimateTokens(messages) > Math.max(1, contextWindow - 20_000) * 0.85;
}

export function compressHistory(messages: Message[], options: CompressionOptions = {}): {
    messages: Message[];
    stats: CompressionStats;
} {
    const contextWindow = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const effectiveWindow = Math.max(1, contextWindow - 20_000);
    const before = estimateTokens(messages);
    const utilization = before / effectiveWindow;
    const cold = (options.idleMs ?? 0) > 5 * 60_000;
    const cacheAllowsEdits = !options.cacheHot || utilization >= 0.75;
    let next = messages.map((message) => ({ ...message }));

    if (utilization > 0.5) next = budget(next, utilization > 0.7 ? 15_000 * 4 : 30_000 * 4);
    if (utilization > 0.6 && cacheAllowsEdits) next = snip(next);
    if (cold) next = microcompact(next);

    return {
        messages: next,
        stats: { utilization, changed: JSON.stringify(next) !== JSON.stringify(messages), persisted: 0, compacted: false },
    };
}
