import type { DesktopTaskStatus, SessionSummary } from "../shared/contracts.js";

export function desktopTaskStatus(
    sessionStatus: SessionSummary["status"],
    hasPendingApproval: boolean,
    hasPendingQuestion: boolean,
    persistedWait?: "approval" | "user",
): DesktopTaskStatus {
    if (sessionStatus === "running") {
        if (hasPendingApproval || persistedWait === "approval") return "waiting-approval";
        if (hasPendingQuestion || persistedWait === "user") return "waiting-user";
        return "running";
    }
    if (sessionStatus === "idle") return "completed";
    return sessionStatus;
}
