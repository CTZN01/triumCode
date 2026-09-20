import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { READ_DEFAULT_LINES } from "./tools.js";

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
    /**
     * Paths whose read_file result was rewritten by this pass, so the content
     * is no longer in the conversation. The agent drops its "already shown"
     * claim for these — otherwise read_file would answer a repeat read with a
     * notice pointing at content that is no longer there.
     */
    evictedReadPaths: Set<string>;
}

export function truncateResult(result: string, limit = TOOL_RESULT_TRUNCATE_THRESHOLD): string {
    if (result.length <= limit) return result;
    const marker = `\n\n[... result truncated: ${result.length - limit} characters omitted ...]\n\n`;
    const available = Math.max(0, limit - marker.length);
    const head = Math.ceil(available * 0.65);
    const tail = available - head;
    return result.slice(0, head) + marker + result.slice(-tail);
}

// Write the full text to disk and return the one-line pointer to it. Null when
// the write fails — truncating is still worth doing on its own, and a result
// that came back short beats a turn that failed.
function persistResult(result: string, now: number): string | null {
    try {
        mkdirSync(RESULT_DIR, { recursive: true });
        const digest = createHash("sha256").update(result).digest("hex").slice(0, 16);
        const filePath = join(RESULT_DIR, `${now}-${digest}.txt`);
        if (!existsSync(filePath)) writeFileSync(filePath, result, "utf8");
        return `[full result saved to ${filePath}]`;
    } catch {
        return null;
    }
}

/**
 * Bring a tool result under that tool's own size limit, keeping the full text
 * on disk when it does not fit.
 *
 * The limit is the tool's declared `maxResultSizeChars` rather than a single
 * shared number. One shared number meant a 30 KB read of a source file came
 * back as a 2 KB preview of a file the model then could not see at all — it
 * would answer from the preview, or re-read, or guess. Truncation is a
 * backstop for a result that should never have been that big, not the normal
 * path for reading code.
 */
export function prepareToolResult(
    result: string,
    limit = TOOL_RESULT_TRUNCATE_THRESHOLD,
    now = Date.now(),
): string {
    if (result.length <= limit) return result;
    const pointer = persistResult(result, now);
    const body = truncateResult(result, limit);
    return pointer ? `${pointer}\n${body}` : body;
}

function textOf(block: Block): string {
    return typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
}

function replaceToolResults(
    messages: Message[],
    replacer: (block: Block, index: number) => string | null,
    evicted?: Set<string>,
): Message[] {
    let toolIndex = 0;
    return messages.map((message): Message => {
        if (message.role !== "user" || !Array.isArray(message.content)) return message;
        let changed = false;
        const content = (message.content as Block[]).map((block) => {
            if (block.type !== "tool_result") return block;
            const replacement = replacer(block, toolIndex++);
            if (replacement === null) return block;
            changed = true;
            if (evicted && block.tool_use_id) evicted.add(String(block.tool_use_id));
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
function budget(messages: Message[], maxChars: number, evicted: Set<string>): Message[] {
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
    }, evicted);
}

/**
 * The line range a read_file call asked for, with the tool's own defaults
 * applied. Clamping to the file's length is not repeated here — the question
 * is whether one request covers another, and both sides are expressed the same
 * way, so an unclamped comparison answers it.
 */
function readRangeOf(input: any): [number, number] {
    const offset = Number(input?.offset);
    const limit = Number(input?.limit);
    const start = Number.isFinite(offset) && offset >= 1 ? Math.floor(offset) : 1;
    const count = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : READ_DEFAULT_LINES;
    return [start, start + count - 1];
}

function covers(outer: [number, number], inner: [number, number]): boolean {
    return outer[0] <= inner[0] && outer[1] >= inner[1];
}

function snip(messages: Message[], evicted: Set<string>): Message[] {
    const all = messages.flatMap((message) =>
        message.role === "user" && Array.isArray(message.content)
            ? (message.content as Block[]).filter((block) => block.type === "tool_result") : []);
    const keep = new Set(all.slice(-3));
    const toolMeta = new Map<string, { name: string; file?: string; range?: [number, number] }>();
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
            if (block.type === "tool_use" && block.id) {
                const isRead = block.name === "read_file";
                toolMeta.set(block.id, {
                    name: block.name,
                    file: isRead ? block.input?.file_path : undefined,
                    range: isRead ? readRangeOf(block.input) : undefined,
                });
            }
        }
    }

    // A later read only makes an earlier one redundant when it covers it. It
    // used to be enough that the file had been read again at all, which held
    // while every read returned the whole file — but a model now pages through
    // a long file with offset/limit, and each page is needed. Treating page two
    // as a replacement for page one would delete half the file from the
    // conversation.
    const readsByFile = new Map<string, Array<{ id: string; range: [number, number] }>>();
    const searchIds: string[] = [];
    for (const [id, meta] of toolMeta) {
        if (meta.file && meta.range) {
            const list = readsByFile.get(meta.file) ?? [];
            list.push({ id, range: meta.range });  // insertion order is conversation order
            readsByFile.set(meta.file, list);
        }
        if (meta.name === "grep_search" || meta.name === "semantic_search") searchIds.push(id);
    }
    const superseded = new Set<string>();
    for (const list of readsByFile.values()) {
        list.forEach((earlier, i) => {
            if (list.slice(i + 1).some((later) => covers(later.range, earlier.range))) {
                superseded.add(earlier.id);
            }
        });
    }

    const recentSearches = new Set(searchIds.slice(-3));
    return replaceToolResults(messages, (block) => {
        if (keep.has(block)) return null;
        const id = String(block.tool_use_id ?? "");
        const meta = toolMeta.get(id);
        if (meta?.file && superseded.has(id)) {
            return snippet(block as Message, "older read_file result snipped", textOf(block));
        }
        if (meta && (meta.name === "grep_search" || meta.name === "semantic_search") && !recentSearches.has(id)) {
            return snippet(block as Message, "older search result snipped", textOf(block));
        }
        return null;
    }, evicted).map((message) => message);
}

function microcompact(messages: Message[], evicted: Set<string>): Message[] {
    const total = toolResultCount(messages);
    const keepFrom = Math.max(0, total - 3);
    let index = 0;
    return replaceToolResults(messages, (block) => {
        const shouldKeep = index++ >= keepFrom;
        return shouldKeep ? null : "[older tool result omitted after context cache cooled]";
    }, evicted);
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
    // Ids of every tool result this pass rewrites, so the agent can tell which
    // read_file results are no longer in the conversation.
    const evicted = new Set<string>();
    if (utilization > BUDGET_TRIGGER) {
        next = budget(next, toolResultBudgetChars(next, effectiveWindow * BUDGET_LOW_WATER), evicted);
    }
    if (utilization > 0.6 && cacheAllowsEdits) next = snip(next, evicted);
    if (cold) next = microcompact(next, evicted);

    return {
        messages: next,
        stats: {
            utilization,
            changed: JSON.stringify(next) !== JSON.stringify(messages),
            persisted: 0,
            compacted: false,
            evictedReadPaths: readPathsOf(messages, evicted),
        },
    };
}

/**
 * The file paths behind a set of evicted tool_use ids, for read_file results
 * only. Built from the assistant turns, which carry the call arguments — the
 * tool result itself records nothing but its own id.
 */
function readPathsOf(messages: Message[], evicted: Set<string>): Set<string> {
    const paths = new Set<string>();
    if (evicted.size === 0) return paths;
    for (const message of messages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
            if (block.type !== "tool_use" || !block.id) continue;
            if (block.name !== "read_file") continue;
            const file = block.input?.file_path;
            if (typeof file === "string" && evicted.has(String(block.id))) paths.add(file);
        }
    }
    return paths;
}
