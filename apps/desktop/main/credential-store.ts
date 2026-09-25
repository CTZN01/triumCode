import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigDetailed } from "../../../src/config.js";
import type { CredentialState } from "../shared/contracts.js";

interface StoredCredential {
    version: 1;
    encryptedApiKey: string;
}

export class CredentialStore {
    private readonly filePath: string;

    constructor(userDataPath: string) {
        this.filePath = join(userDataPath, "credentials.json");
    }

    state(): CredentialState {
        if (existsSync(this.filePath)) {
            if (!safeStorage.isEncryptionAvailable()) return "unsupported";
            if (this.readStoredKey()) return "secure-key";
        }
        const bundle = resolveConfigDetailed({});
        if (bundle.sources.apiKey === "env") return "environment-key";
        if (!safeStorage.isEncryptionAvailable()) return "unsupported";
        if (bundle.sources.apiKey === "config" && bundle.config.apiKey) return "cli-key-available";
        return "missing";
    }

    getApiKey(): string {
        return this.readStoredKey() || process.env.ANTHROPIC_API_KEY || "";
    }

    save(apiKey: string): CredentialState {
        const value = apiKey.trim();
        if (!value) throw new Error("Enter a non-empty API key.");
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system.");
        const payload: StoredCredential = {
            version: 1,
            encryptedApiKey: safeStorage.encryptString(value).toString("base64"),
        };
        this.write(payload);
        return "secure-key";
    }

    importCliCredential(): CredentialState {
        const bundle = resolveConfigDetailed({});
        if (!bundle.config.apiKey) throw new Error("No API key is configured in the CLI settings or environment.");
        return this.save(bundle.config.apiKey);
    }

    clear(): CredentialState {
        if (existsSync(this.filePath)) {
            try { unlinkSync(this.filePath); } catch { /* report the resulting state */ }
        }
        return this.state();
    }

    private write(payload: StoredCredential): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(payload), "utf-8");
        try { renameSync(temp, this.filePath); }
        catch { writeFileSync(this.filePath, JSON.stringify(payload), "utf-8"); }
    }

    private readStoredKey(): string {
        if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return "";
        try {
            const stored = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoredCredential;
            if (stored.version !== 1 || typeof stored.encryptedApiKey !== "string") return "";
            return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
        } catch {
            return "";
        }
    }
}
