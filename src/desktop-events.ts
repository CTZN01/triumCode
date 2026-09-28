export type DesktopRunEventKind = "start" | "event" | "finish";

export class DesktopEventSequencer {
    private readonly sequences = new Map<string, number>();

    current(sessionKey: string): number {
        return this.sequences.get(sessionKey) ?? 0;
    }

    next(sessionKey: string): number {
        const sequence = this.current(sessionKey) + 1;
        this.sequences.set(sessionKey, sequence);
        return sequence;
    }

    delete(sessionKey: string): void {
        this.sequences.delete(sessionKey);
    }
}

export class DesktopRunEventTracker {
    private readonly sequences = new Map<string, number>();
    private readonly activeRunIds = new Map<string, string>();
    private readonly finishedRunIds = new Map<string, string[]>();

    openSession(sessionKey: string, sequence: number, runId: string | null): void {
        this.sequences.set(sessionKey, Math.max(this.sequences.get(sessionKey) ?? 0, sequence));
        if (runId) {
            this.begin(sessionKey, runId);
            return;
        }
        const activeRunId = this.activeRunIds.get(sessionKey);
        if (activeRunId) this.finish(sessionKey, activeRunId);
    }

    accepts(
        sessionKey: string,
        sequence: number,
        runId: string | null,
        kind: DesktopRunEventKind,
    ): boolean {
        if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
        if (sequence <= (this.sequences.get(sessionKey) ?? 0)) return false;
        this.sequences.set(sessionKey, sequence);

        if ((kind === "start" || kind === "finish") && !runId) return false;
        if (!runId) return true;
        if (this.isFinished(sessionKey, runId)) return false;

        if (kind === "start") return this.begin(sessionKey, runId);
        if (kind === "finish") return this.finish(sessionKey, runId);

        const activeRunId = this.activeRunIds.get(sessionKey);
        if (activeRunId && activeRunId !== runId) return false;
        if (!activeRunId) return this.begin(sessionKey, runId);
        return true;
    }

    begin(sessionKey: string, runId: string): boolean {
        if (this.isFinished(sessionKey, runId)) return false;
        const previousRunId = this.activeRunIds.get(sessionKey);
        if (previousRunId && previousRunId !== runId) this.finish(sessionKey, previousRunId);
        this.activeRunIds.set(sessionKey, runId);
        return true;
    }

    finish(sessionKey: string, runId: string): boolean {
        const activeRunId = this.activeRunIds.get(sessionKey);
        if (activeRunId && activeRunId !== runId) return false;
        if (activeRunId === runId) this.activeRunIds.delete(sessionKey);
        const previous = this.finishedRunIds.get(sessionKey) ?? [];
        this.finishedRunIds.set(sessionKey, [...previous.filter((id) => id !== runId), runId].slice(-32));
        return true;
    }

    isFinished(sessionKey: string, runId: string): boolean {
        return (this.finishedRunIds.get(sessionKey) ?? []).includes(runId);
    }

    delete(sessionKey: string): void {
        this.sequences.delete(sessionKey);
        this.activeRunIds.delete(sessionKey);
        this.finishedRunIds.delete(sessionKey);
    }
}
