import { existsSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

interface ReviewIndex {
    latestBySessionId: Record<string, string>;
    runs: Record<string, { sessionId: string }>;
}

export function removeSessionReviewFiles(directory: string, sessionId: string): void {
    const indexPath = join(directory, "index.json");
    if (!existsSync(indexPath)) {
        if (existsSync(directory) && readdirSync(directory).some((name) => /^[a-f0-9-]{36}\.json$/i.test(name))) {
            throw new Error("Review snapshots exist without an index.");
        }
        return;
    }
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as ReviewIndex;
    if (!index || typeof index !== "object" || !index.runs || Array.isArray(index.runs)
        || !index.latestBySessionId || Array.isArray(index.latestBySessionId)) {
        throw new Error("Review index is invalid.");
    }
    for (const [runId, run] of Object.entries(index.runs)) {
        if (!run || typeof run.sessionId !== "string") throw new Error("Review index contains an invalid run.");
        if (run.sessionId !== sessionId) continue;
        if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error("Review index contains an invalid run ID.");
        try { unlinkSync(join(directory, `${runId}.json`)); }
        catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
        }
        delete index.runs[runId];
    }
    delete index.latestBySessionId[sessionId];
    const temporary = join(dirname(indexPath), `index.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(index), "utf8");
    try { renameSync(temporary, indexPath); }
    catch {
        try { writeFileSync(indexPath, JSON.stringify(index), "utf8"); }
        finally { rmSync(temporary, { force: true }); }
    }
}
