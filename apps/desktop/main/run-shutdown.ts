export class RunShutdown {
    private readonly starts = new Set<Promise<unknown>>();
    private stopping: Promise<void> | null = null;

    trackStart<T>(start: () => Promise<T>, onStopping: () => Error): Promise<T> {
        if (this.stopping) throw onStopping();
        const promise = start();
        this.starts.add(promise);
        void promise.then(
            () => this.starts.delete(promise),
            () => this.starts.delete(promise),
        );
        return promise;
    }

    stopAll(cancel: () => void, running: () => Promise<void>[]): Promise<void> {
        if (this.stopping) return this.stopping;
        const stopping = (async () => {
            cancel();
            await Promise.allSettled([...this.starts]);
            await Promise.allSettled(running());
        })();
        this.stopping = stopping;
        void stopping.then(
            () => { if (this.stopping === stopping) this.stopping = null; },
            () => { if (this.stopping === stopping) this.stopping = null; },
        );
        return stopping;
    }
}
