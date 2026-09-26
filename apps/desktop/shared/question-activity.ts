import type { SessionActivity } from "../../../src/session.js";

export type QuestionOutcome = "answered" | "skipped" | "expired" | "cancelled";

export function updateQuestionActivity(
    activities: SessionActivity[],
    requestId: string,
    runId: string | null,
    question: string | undefined,
    timestamp: string,
    outcome?: QuestionOutcome,
): SessionActivity[] {
    const id = `question-${requestId}`;
    const previous = activities.find((item) => item.id === id);
    const state: SessionActivity["state"] = outcome === "answered" ? "complete"
        : outcome === "skipped" ? "notice"
            : outcome ? "interrupted" : "running";
    const label = outcome === "answered" ? "已回答"
        : outcome === "skipped" ? "已跳过"
            : outcome === "expired" ? "等待超时"
                : outcome === "cancelled" ? "任务已取消" : undefined;
    const next: SessionActivity = {
        id,
        ...(runId ? { runId } : previous?.runId ? { runId: previous.runId } : {}),
        title: "用户问题",
        detail: previous?.detail ?? question ?? "问题内容不可用",
        state,
        ...(label ? { output: label } : {}),
        startedAt: previous?.startedAt ?? timestamp,
        updatedAt: timestamp,
    };
    return previous
        ? activities.map((item) => item.id === id ? next : item)
        : [...activities, next].slice(-200);
}
