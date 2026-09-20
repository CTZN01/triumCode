import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";

export const TOOL_RESULT_PERSIST_THRESHOLD = 30_000;
export const TOOL_RESULT_TRUNCATE_THRESHOLD = 50_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;

// Tool-output budget, as a fraction of the usable window. The budget runs when
// utilization crosses the trigger and clips back down to the low-water mark.
// The gap between the two is the point: see budget().
export const BUDGET_TRIGGER = 0.6;
export const BUDGET_LOW_WATER = 0.45;

// A clipped tool result keeps this much of itself, so the model still sees
// what the call returned before deciding whether to re-run it.
const BUDGETED_PREVIEW_CHARS = 500;

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
    return toolResultBlocks(messages).length;
}

function toolResultBlocks(messages: Message[]): Block[] {
    const blocks: Block[] = [];
    for (const message of messages) {
        if (message.role !== "user" || !Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
            if (block.type === "tool_result") blocks.push(block);
        }
    }
    return blocks;
}

export function estimateTokens(value: unknown): number {
    return Math.ceil(JSON.stringify(value).length / 4);
}

function snippet(message: Message, label: string, text: string): string {
    const preview = truncateResult(text, PREVIEW_CHARS);
    return `[${label}]\n${preview}`;
}

function toolResultChars(messages: Message[]): number {
    return toolResultBlocks(messages).reduce((sum, block) => sum + textOf(block).length, 0);
}

/**
 * How many characters of tool output fit once the conversation is trimmed back
 * to `targetTokens`. Everything that is not a tool result is fixed cost, so the
 * tool results absorb the whole difference.
 */
function toolResultBudgetChars(messages: Message[], targetTokens: number): number {
    const fixedChars = JSON.stringify(messages).length - toolResultChars(messages);
    return Math.max(0, targetTokens * 4 - fixedChars);
}

/**
 * Cap the tool output the prompt carries, spending the budget on the newest
 * results and letting the oldest fall back to a preview.
 *
 * This used to walk the other way, which was backwards twice over. It kept the
 * oldest results whole, ran the budget out partway through, and then clipped
 * every result after that point to 500 characters — including the file the
 * model had just read. Unable to see it, the model read it again, which costs
 * far more than the characters the clip saved.
 *
 * Every result costs at least a preview, so that much is spent before any
 * result is kept whole.
 */
function budget(messages: Message[], maxChars: number): Message[] {
    const blocks = toolResultBlocks(messages);
    const kept = new Set<Block>();
    let straddle: Block | null = null;
    let straddleChars = 0;
    let remaining = maxChars - blocks.length * BUDGETED_PREVIEW_CHARS;

    for (let i = blocks.length - 1; i >= 0 && remaining > 0; i--) {
        const length = textOf(blocks[i]).length;
        if (length <= remaining) {
            remaining -= length;
            kept.add(blocks[i]);
            continue;
        }
        // The one block the budget runs out inside keeps as much of its head
        // as is left, so the boundary does not lose a result entirely.
        straddle = blocks[i];
        straddleChars = remaining;
        break;
    }

    return replaceToolResults(messages, (block) => {
        if (kept.has(block)) return null;
        const text = textOf(block);
        const limit = block === straddle ? straddleChars : BUDGETED_PREVIEW_CHARS;
        return snippet(block as Message, "tool result budgeted", truncateResult(text, limit));
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

    // Gated on a high-water mark rather than run continuously. Prompt caching
    // matches on a byte-exact prefix, so a budget re-derived on every request
    // slides its boundary by however much the last turn added — and a boundary
    // that moves invalidates the cache for the whole conversation behind it,
    // costing more than the characters it saves. Clipping in one jump down to
    // the low-water mark keeps the prefix byte-stable in between.
    if (utilization > BUDGET_TRIGGER) {
        next = budget(next, toolResultBudgetChars(next, effectiveWindow * BUDGET_LOW_WATER));
    }
    if (utilization > 0.6 && cacheAllowsEdits) next = snip(next);
    if (cold) next = microcompact(next);

    return {
        messages: next,
        stats: { utilization, changed: JSON.stringify(next) !== JSON.stringify(messages), persisted: 0, compacted: false },
    };
}
