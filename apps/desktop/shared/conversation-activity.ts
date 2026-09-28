import type { SessionActivity } from "../../../src/session.js";
import type { ConversationMessage } from "./contracts.js";

export type PlacedActivity = SessionActivity & { afterMessageId?: string };

export function activityLine(activity: SessionActivity): string {
    const stats = editLineStats(activity);
    return `${activityTarget(activity)}${stats ? ` +${stats.added}/-${stats.removed}` : ""}`;
}

export function editFileName(activity: SessionActivity): string {
    const path = activity.fileEdit?.path ?? activityInput(activity).file_path;
    return typeof path === "string" ? path.replaceAll("\\", "/").split("/").at(-1)! : activity.title;
}

export function editResultSnippet(activity: SessionActivity): Array<{ number: number; text: string }> {
    if ((activity.title !== "edit_file" && activity.title !== "multi_edit") || !activity.output?.startsWith("Edited ")) return [];
    return activity.output.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+\| ?(.*)$/.exec(line);
        return match ? [{ number: Number(match[1]), text: match[2] }] : [];
    });
}

// New records use the captured net change; legacy records retain their tool-reported counts.
export function editLineStats(activity: SessionActivity): { added: number; removed: number } | null {
    if (activity.title !== "edit_file" && activity.title !== "multi_edit") return null;
    if (activity.fileEdit) {
        if (!activity.fileEdit.diff && (activity.fileEdit.truncated || activity.fileEdit.notice)) return null;
        return { added: activity.fileEdit.added, removed: activity.fileEdit.removed };
    }
    const stats = /^Edited .*\(\+(\d+)\/-(\d+) lines\)/.exec(activity.output?.split("\n", 1)[0] ?? "");
    return stats ? { added: Number(stats[1]), removed: Number(stats[2]) } : null;
}

export function activityFilePath(activity: SessionActivity, workspaceRoot: string): string | null {
    if (activity.title !== "edit_file" && activity.title !== "multi_edit") return null;
    const filePath = activityInput(activity).file_path;
    if (typeof filePath !== "string") return null;
    const file = filePath.replaceAll("\\", "/");
    const root = workspaceRoot.replaceAll("\\", "/").replace(/\/$/, "");
    const compare = /^[A-Za-z]:\//.test(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
    if (!compare(file).startsWith(`${compare(root)}/`)) return null;
    return file.slice(root.length + 1);
}

export function activityTarget(activity: SessionActivity): string {
    const input = activityInput(activity);
    const value = (key: string): string => typeof input[key] === "string" ? input[key] : "";
    if (value("command")) {
        const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [];
        const command = [value("command"), ...args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg)].join(" ");
        return `${activity.title} ${command}`;
    }
    if (value("file_path")) return `${activity.title} ${value("file_path")}`;
    if (value("pattern")) return `${activity.title} ${value("pattern")}${value("path") ? ` · ${value("path")}` : ""}`;
    if (value("directory_path")) return `${activity.title} ${value("directory_path")}`;
    if (value("path")) return `${activity.title} ${value("path")}`;
    if (value("description")) return `${activity.title} ${value("description")}`;
    return activity.title;
}

function activityInput(activity: SessionActivity): Record<string, unknown> {
    let input: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(activity.detail) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
    } catch { /* Notices and old activity may contain plain text. */ }
    return input;
}

export function groupConversationActivities<T extends PlacedActivity>(
    messages: readonly ConversationMessage[],
    activities: readonly T[],
): Map<string, T[]> {
    const fallbackMessageByRun = new Map<string, string>();
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== "user" || !message.runIds?.length) continue;
        let target = message;
        for (let next = index + 1; next < messages.length && messages[next].role !== "user"; next++) {
            if (messages[next].role === "assistant") target = messages[next];
        }
        for (const id of message.runIds) fallbackMessageByRun.set(id, target.id);
    }
    const visibleMessageIds = new Set(messages.map((message) => message.id));
    const afterMessage = new Map<string, T[]>();
    for (const activity of activities) {
        let target = activity.afterMessageId && visibleMessageIds.has(activity.afterMessageId)
            ? activity.afterMessageId : undefined;
        if (!target && activity.afterMessageId && activity.runId) {
            const prefix = `assistant-${activity.runId}-`;
            if (activity.afterMessageId.startsWith(prefix)) {
                const segment = Number(activity.afterMessageId.slice(prefix.length));
                if (Number.isSafeInteger(segment)) {
                    for (let previous = segment - 1; previous >= 0; previous--) {
                        const id = `${prefix}${previous}`;
                        if (visibleMessageIds.has(id)) { target = id; break; }
                    }
                }
            }
        }
        if (!target && activity.afterMessageIndex !== undefined) {
            for (const message of messages) {
                const index = /^history-(\d+)$/.exec(message.id)?.[1];
                if (index !== undefined && Number(index) >= (activity.messageIndex ?? 0)
                    && Number(index) <= activity.afterMessageIndex) target = message.id;
            }
        }
        target ??= activity.runId ? fallbackMessageByRun.get(activity.runId) : undefined;
        if (target) afterMessage.set(target, [...(afterMessage.get(target) ?? []), activity]);
    }
    return afterMessage;
}
