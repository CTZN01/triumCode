export function pruneIdleRuntimes<T>(
    runtimes: Map<string, T>,
    maxIdle: number,
    protectedKey: string | null,
    isRunning: (runtime: T) => boolean,
): void {
    let idleCount = 0;
    for (const runtime of runtimes.values()) if (!isRunning(runtime)) idleCount++;
    for (const [key, runtime] of runtimes) {
        if (idleCount <= maxIdle) break;
        if (key === protectedKey || isRunning(runtime)) continue;
        runtimes.delete(key);
        idleCount--;
    }
}
