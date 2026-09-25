import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfig } from "../../../src/config.js";
import type { DesktopSettings } from "../shared/contracts.js";

export class SettingsStore {
    private readonly filePath: string;
    private current: DesktopSettings;

    constructor(userDataPath: string) {
        this.filePath = join(userDataPath, "desktop-settings.json");
        this.current = this.read();
    }

    private defaults(): DesktopSettings {
        const config = resolveConfig({});
        return {
            model: config.model,
            apiBase: config.apiBase,
            protocol: config.protocol,
            auth: config.auth,
            thinking: config.thinking,
            effort: config.effort,
            contextWindow: config.contextWindow,
            maxParallelRuns: 3,
        };
    }

    private read(): DesktopSettings {
        const fallback = this.defaults();
        if (!existsSync(this.filePath)) return fallback;
        try {
            const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<DesktopSettings>;
            return {
                ...fallback,
                ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
                ...(typeof parsed.apiBase === "string" ? { apiBase: parsed.apiBase } : {}),
                ...(parsed.protocol === "anthropic" || parsed.protocol === "openai-chat" || parsed.protocol === "openai-responses"
                    ? { protocol: parsed.protocol } : {}),
                ...(parsed.auth === "api-key" || parsed.auth === "bearer" ? { auth: parsed.auth } : {}),
                ...(typeof parsed.thinking === "boolean" ? { thinking: parsed.thinking } : {}),
                ...(typeof parsed.effort === "string" ? { effort: parsed.effort } : {}),
                ...(typeof parsed.contextWindow === "number" && parsed.contextWindow > 0
                    ? { contextWindow: Math.floor(parsed.contextWindow) } : {}),
                ...(typeof parsed.maxParallelRuns === "number" && Number.isSafeInteger(parsed.maxParallelRuns)
                    && parsed.maxParallelRuns >= 1 && parsed.maxParallelRuns <= 8
                    ? { maxParallelRuns: parsed.maxParallelRuns } : {}),
            };
        } catch {
            return fallback;
        }
    }

    get(): DesktopSettings {
        return { ...this.current };
    }

    save(settings: DesktopSettings): DesktopSettings {
        this.current = { ...settings };
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(this.current, null, 2), "utf-8");
        try { renameSync(temp, this.filePath); }
        catch { writeFileSync(this.filePath, JSON.stringify(this.current, null, 2), "utf-8"); }
        return this.get();
    }
}
