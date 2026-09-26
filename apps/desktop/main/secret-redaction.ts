export type RedactionKeys = string | readonly string[];

export function redactConfiguredKey(value: string, apiKeys: RedactionKeys): string {
    const keys = typeof apiKeys === "string" ? [apiKeys] : apiKeys;
    return [...keys].sort((left, right) => right.length - left.length)
        .reduce((text, key) => key.length >= 8 ? text.replaceAll(key, "[REDACTED]") : text, value);
}

export function redactSessionMessages(messages: unknown[], apiKeys: RedactionKeys): unknown[] {
    if (!(typeof apiKeys === "string" ? [apiKeys] : apiKeys).some((key) => key.length >= 8)) return messages;
    return JSON.parse(JSON.stringify(messages, (_key, value: unknown) =>
        typeof value === "string" ? redactConfiguredKey(value, apiKeys) : value)) as unknown[];
}
