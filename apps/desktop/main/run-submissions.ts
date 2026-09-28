export class SubmissionCancelledError extends Error {
    constructor() { super("发送已取消，补充要求已恢复到草稿。"); }
}

interface Submission<T> {
    key: string;
    interrupt: boolean;
    cancelled: boolean;
    cancel: () => void;
    promise: Promise<T>;
}

/** Serialize startup/handoff, while execution itself remains owned by AgentHost. */
export class RunSubmissions<T> {
    private readonly sessions = new Map<string, Submission<T>>();
    private readonly requests = new Map<string, Submission<T>>();

    submit(key: string, requestId: string, interrupt: boolean, start: (checkCancelled: () => void) => Promise<T>, cancel: () => void): Promise<T> {
        const duplicate = this.requests.get(requestId);
        if (duplicate) {
            if (duplicate.key !== key) throw new Error("请求 ID 已用于另一个会话。");
            return duplicate.promise;
        }
        const previous = this.sessions.get(key);
        if (previous && (!interrupt || previous.interrupt)) throw new Error("这条消息正在发送或中断，请等待完成。");
        let submission: Submission<T>;
        const checkCancelled = () => { if (submission.cancelled) throw new SubmissionCancelledError(); };
        const promise = Promise.resolve().then(async () => {
            if (previous) await previous.promise.catch(() => {});
            checkCancelled();
            return start(checkCancelled);
        }).finally(() => {
            this.requests.delete(requestId);
            if (this.sessions.get(key) === submission) this.sessions.delete(key);
        });
        submission = { key, interrupt, cancelled: false, cancel, promise };
        this.sessions.set(key, submission);
        this.requests.set(requestId, submission);
        return submission.promise;
    }

    cancel(requestId: string): boolean {
        const submission = this.requests.get(requestId);
        if (!submission) return false;
        if (!submission.cancelled) { submission.cancelled = true; submission.cancel(); }
        return true;
    }

    cancelSession(key: string): void {
        for (const [id, submission] of this.requests) if (submission.key === key) this.cancel(id);
    }

    cancelAll(): void {
        for (const id of this.requests.keys()) this.cancel(id);
    }
}
