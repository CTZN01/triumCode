import { printInfo } from "./ui.js";

// ═══════════════════════════════════════════════════════════════
// Retry with exponential backoff + jitter
// ═══════════════════════════════════════════════════════════════
//
// Retriable errors: 429 (rate limit), 503 (overloaded), 529 (overloaded),
// ECONNRESET, ETIMEDOUT, or messages containing "overloaded".
//
// Non-retriable: 400 (bad request), 401 (auth), 404 (not found) — these
// reflect code or config problems that retry won't fix.
//
// Backoff: min(1000 * 2^attempt, 30000) + random(0, 1000) ms
// The exponential part controls retreat speed, the 30s cap prevents
// excessive waits, and random jitter prevents retry storms when many
// clients hit the same endpoint simultaneously.

export function isRetryable(error: any): boolean {
    const status = error?.status || error?.statusCode;
    if ([429, 503, 529].includes(status)) return true;
    if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
    if (error?.message?.includes("overloaded")) return true;
    return false;
}

export async function withRetry<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    maxRetries = 3,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn(signal);
        } catch (error: any) {
            // If the user aborted, don't retry — propagate immediately.
            if (signal?.aborted) throw error;
            if (attempt >= maxRetries || !isRetryable(error)) throw error;

            const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
                        + Math.random() * 1000;
            const reason = error?.status
                ? `HTTP ${error.status}`
                : error?.code || "network error";

            printInfo(`retry ${attempt + 1}/${maxRetries} (${reason}) — waiting ${Math.round(delay)}ms`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}
