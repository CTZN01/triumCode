import type { DesktopTaskStatus, SessionSummary } from "../shared/contracts.js";

export function desktopTaskStatus(
    sessionStatus: SessionSummary["status"],
    hasPendingApproval: boolean,
    hasPendingQuestion: boolean,
): DesktopTaskStatus {
    if (sessionStatus === "running") {
        if (hasPendingApproval) return "waiting-approval";
        if (hasPendingQuestion) return "waiting-user";
        return "running";
    }
    if (sessionStatus === "idle") return "completed";
    return sessionStatus;
}
