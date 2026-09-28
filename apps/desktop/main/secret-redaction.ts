import { FILE_DIFF_LIMIT, parseFileEditDiff, type FileEditDiff } from "../../../src/file-diff.js";

export type RedactionKeys = string | readonly string[];

export function redactConfiguredKey(value: string, apiKeys: RedactionKeys): string {
    const keys = typeof apiKeys === "string" ? [apiKeys] : apiKeys;
    return [...keys].sort((left, right) => right.length - left.length)
        .reduce((text, key) => key.length >= 8 ? text.replaceAll(key, "[REDACTED]") : text, value);
}

export function redactFileEditDiff(value: unknown, apiKeys: RedactionKeys): FileEditDiff | undefined {
    const edit = parseFileEditDiff(value);
    if (!edit) return undefined;
    const bytes = Buffer.from(redactConfiguredKey(edit.diff, apiKeys));
    const truncated = bytes.length > FILE_DIFF_LIMIT;
    const end = truncated ? bytes.lastIndexOf(10, FILE_DIFF_LIMIT - 1) + 1 : bytes.length;
    return {
        ...edit,
        path: redactConfiguredKey(edit.path, apiKeys),
        diff: bytes.subarray(0, end).toString("utf8"),
        truncated: edit.truncated || truncated,
        ...(edit.notice ? { notice: redactConfiguredKey(edit.notice, apiKeys) } : {}),
    };
}

export function redactSessionMessages(messages: unknown[], apiKeys: RedactionKeys): unknown[] {
    if (!(typeof apiKeys === "string" ? [apiKeys] : apiKeys).some((key) => key.length >= 8)) return messages;
    return JSON.parse(JSON.stringify(messages, (_key, value: unknown) =>
        typeof value === "string" ? redactConfiguredKey(value, apiKeys) : value)) as unknown[];
}
