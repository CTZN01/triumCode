import type { ConversationMessage, ConversationPage } from "../shared/contracts.js";

export const CONVERSATION_PAGE_SIZE = 40;

function visibleMessage(value: unknown, index: number, redact: (text: string) => string): ConversationMessage | null {
    if (!value || typeof value !== "object") return null;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "user" && message.role !== "assistant") return null;
    const blocks = typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
            ? message.content.flatMap((block: unknown) =>
                block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                    && typeof (block as { text?: unknown }).text === "string"
                    ? [(block as { text: string }).text] : [])
            : [];
    let text = blocks.join("");
    if (message.role === "user") text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
    return text.trim() ? { id: `history-${index}`, role: message.role, text: redact(text) } : null;
}

export function pageConversationMessages(
    history: readonly unknown[],
    before: number,
    redact: (text: string) => string,
    limit = CONVERSATION_PAGE_SIZE,
): ConversationPage {
    const messages: ConversationMessage[] = [];
    let index = Math.min(before, history.length) - 1;
    while (index >= 0 && messages.length < limit) {
        const message = visibleMessage(history[index], index, redact);
        if (message) messages.push(message);
        index--;
    }
    let probe = index;
    while (probe >= 0 && !visibleMessage(history[probe], probe, redact)) probe--;
    return { messages: messages.reverse(), nextCursor: probe >= 0 ? index + 1 : null };
}
