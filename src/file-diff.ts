import { createHash } from "node:crypto";

export interface FileEditDiff {
    path: string;
    diff: string;
    added: number;
    removed: number;
    truncated: boolean;
    beforeHash: string;
    afterHash: string;
    notice?: string;
}

export const FILE_DIFF_LIMIT = 64 * 1024;
const MAX_CELLS = 4_000_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function lines(text: string): string[] {
    return text.replaceAll("\r\n", "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A fixed patch of the bytes used by one successful file operation. */
export function createFileEditDiff(path: string, before: string, after: string): FileEditDiff {
    const result: FileEditDiff = {
        path, diff: "", added: 0, removed: 0, truncated: false,
        beforeHash: createHash("sha256").update(before).digest("hex"),
        afterHash: createHash("sha256").update(after).digest("hex"),
    };
    if (before === after) return result;
    if (Buffer.byteLength(before) > MAX_FILE_BYTES || Buffer.byteLength(after) > MAX_FILE_BYTES) {
        return { ...result, truncated: true, notice: "文件超过 2 MiB，未生成文本差异。" };
    }
    if (before.includes("\0") || after.includes("\0")) {
        return { ...result, notice: "二进制内容无法显示文本差异。" };
    }
    const oldLines = lines(before);
    const newLines = lines(after);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
    const oldEnd = oldLines.length - suffix;
    const newEnd = newLines.length - suffix;
    const width = newEnd - prefix + 1;
    const height = oldEnd - prefix + 1;
    if (width * height > MAX_CELLS) {
        return { ...result, truncated: true, notice: "变更范围过大，无法在内存上限内生成差异。" };
    }
    const table = new Uint32Array(width * height);
    for (let i = height - 2; i >= 0; i--) {
        for (let j = width - 2; j >= 0; j--) {
            table[i * width + j] = oldLines[prefix + i] === newLines[prefix + j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }
    const start = Math.max(0, prefix - 3);
    const ops: Array<{ kind: " " | "-" | "+"; line: string }> = oldLines.slice(start, prefix).map((line) => ({ kind: " ", line }));
    let i = prefix;
    let j = prefix;
    while (i < oldEnd || j < newEnd) {
        if (i < oldEnd && j < newEnd && oldLines[i] === newLines[j]) {
            ops.push({ kind: " ", line: oldLines[i++] });
            j++;
        } else if (i < oldEnd && (j === newEnd || table[(i - prefix + 1) * width + j - prefix] >= table[(i - prefix) * width + j - prefix + 1])) {
            ops.push({ kind: "-", line: oldLines[i++] });
            result.removed++;
        } else {
            ops.push({ kind: "+", line: newLines[j++] });
            result.added++;
        }
    }
    ops.push(...oldLines.slice(oldEnd, oldEnd + Math.min(3, suffix)).map((line) => ({ kind: " " as const, line })));
    if (!result.added && !result.removed) {
        result.notice = "仅 LF/CRLF 换行符发生变化，文本内容未变。";
        return result;
    }
    const ranges: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < ops.length; index++) {
        if (ops[index].kind === " ") continue;
        const from = Math.max(0, index - 3);
        const to = Math.min(ops.length, index + 4);
        const previous = ranges.at(-1);
        if (previous && from <= previous.end) previous.end = to;
        else ranges.push({ start: from, end: to });
    }
    const oldPositions = [start];
    const newPositions = [start];
    for (const op of ops) {
        oldPositions.push(oldPositions.at(-1)! + (op.kind === "+" ? 0 : 1));
        newPositions.push(newPositions.at(-1)! + (op.kind === "-" ? 0 : 1));
    }
    const output = [`--- a/${path}`, `+++ b/${path}`];
    for (const range of ranges) {
        const oldCount = oldPositions[range.end] - oldPositions[range.start];
        const newCount = newPositions[range.end] - newPositions[range.start];
        output.push(`@@ -${oldPositions[range.start] + (oldCount ? 1 : 0)},${oldCount} +${newPositions[range.start] + (newCount ? 1 : 0)},${newCount} @@`);
        for (const op of ops.slice(range.start, range.end)) {
            output.push(op.kind + (op.line.endsWith("\n") ? op.line.slice(0, -1) : op.line));
            if (!op.line.endsWith("\n")) output.push("\\ No newline at end of file");
        }
    }
    const bytes = Buffer.from(output.join("\n") + "\n");
    result.truncated = bytes.length > FILE_DIFF_LIMIT;
    // End at a complete line so a truncated patch cannot invent a partial change.
    const end = result.truncated ? bytes.lastIndexOf(10, FILE_DIFF_LIMIT - 1) + 1 : bytes.length;
    result.diff = bytes.subarray(0, end).toString("utf8");
    if (before.includes("\r\n") !== after.includes("\r\n")) result.notice = "LF/CRLF 换行符也发生了变化；文本差异按行展示。";
    return result;
}

export function parseFileEditDiff(value: unknown): FileEditDiff | undefined {
    if (!value || typeof value !== "object") return undefined;
    const item = value as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.diff !== "string" || Buffer.byteLength(item.diff) > FILE_DIFF_LIMIT
        || typeof item.truncated !== "boolean" || typeof item.beforeHash !== "string" || typeof item.afterHash !== "string"
        || !/^[a-f0-9]{64}$/.test(item.beforeHash) || !/^[a-f0-9]{64}$/.test(item.afterHash)
        || typeof item.added !== "number" || !Number.isSafeInteger(item.added) || item.added < 0
        || typeof item.removed !== "number" || !Number.isSafeInteger(item.removed) || item.removed < 0) return undefined;
    return {
        path: item.path, diff: item.diff, added: item.added, removed: item.removed,
        truncated: item.truncated, beforeHash: item.beforeHash, afterHash: item.afterHash,
        ...(typeof item.notice === "string" ? { notice: item.notice } : {}),
    };
}
