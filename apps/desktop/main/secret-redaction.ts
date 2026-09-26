export function redactConfiguredKey(value: string, apiKey: string): string {
    return apiKey.length >= 8 ? value.replaceAll(apiKey, "[REDACTED]") : value;
}

export function redactSessionMessages(messages: unknown[], apiKey: string): unknown[] {
    if (apiKey.length < 8) return messages;
    return JSON.parse(JSON.stringify(messages, (_key, value: unknown) =>
        typeof value === "string" ? redactConfiguredKey(value, apiKey) : value)) as unknown[];
}
