import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigDetailed } from "../../../src/config.js";
import type { CredentialState } from "../shared/contracts.js";

interface StoredCredential {
    version: 2;
    encryptedApiKey?: string;
    encryptedPresetApiKeys: Record<string, string>;
}

export class CredentialStore {
    private readonly filePath: string;

    constructor(userDataPath: string) {
        this.filePath = join(userDataPath, "credentials.json");
    }

    state(presetName?: string | null, presetApiKeyAvailable = false): CredentialState {
        const encryptionAvailable = safeStorage.isEncryptionAvailable();
        if (encryptionAvailable && existsSync(this.filePath) && this.readStoredKey(presetName)) return "secure-key";
        const bundle = resolveConfigDetailed({});
        if (process.env.ANTHROPIC_API_KEY) return "environment-key";
        if (presetApiKeyAvailable) return encryptionAvailable ? "cli-key-available" : "unsupported";
        if (!encryptionAvailable) return "unsupported";
        if (bundle.sources.apiKey === "config" && bundle.config.apiKey) return "cli-key-available";
        return "missing";
    }

    getApiKey(presetName?: string | null): string {
        return this.readStoredKey(presetName) || process.env.ANTHROPIC_API_KEY || "";
    }

    getStoredApiKey(presetName?: string | null): string {
        return this.readStoredKey(presetName);
    }

    save(apiKey: string, presetName?: string | null): CredentialState {
        const value = apiKey.trim();
        if (!value) throw new Error("Enter a non-empty API key.");
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this system.");
        const payload = this.readStoredCredentials();
        const encrypted = safeStorage.encryptString(value).toString("base64");
        if (presetName) payload.encryptedPresetApiKeys[presetName] = encrypted;
        else payload.encryptedApiKey = encrypted;
        this.write(payload);
        return this.state(presetName);
    }

    importCliCredential(presetName?: string | null, presetApiKey?: string): CredentialState {
        const bundle = resolveConfigDetailed({});
        const apiKey = presetApiKey || bundle.config.apiKey;
        if (!apiKey) throw new Error("No API key is configured in the CLI settings or environment.");
        return this.save(apiKey, presetName);
    }

    clear(presetName?: string | null): CredentialState {
        if (existsSync(this.filePath) && safeStorage.isEncryptionAvailable()) {
            const payload = this.readStoredCredentials();
            if (presetName) delete payload.encryptedPresetApiKeys[presetName];
            else delete payload.encryptedApiKey;
            if (payload.encryptedApiKey || Object.keys(payload.encryptedPresetApiKeys).length > 0) {
                try { this.write(payload); } catch { /* report the resulting state */ }
            } else {
                try { unlinkSync(this.filePath); } catch { /* report the resulting state */ }
            }
        }
        return this.state(presetName);
    }

    clearStoredApiKey(presetName?: string | null): void {
        if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return;
        const payload = this.readStoredCredentials();
        if (presetName) delete payload.encryptedPresetApiKeys[presetName];
        else delete payload.encryptedApiKey;
        if (payload.encryptedApiKey || Object.keys(payload.encryptedPresetApiKeys).length > 0) this.write(payload);
        else unlinkSync(this.filePath);
    }

    private write(payload: StoredCredential): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(payload), "utf-8");
        try { renameSync(temp, this.filePath); }
        catch { writeFileSync(this.filePath, JSON.stringify(payload), "utf-8"); }
    }

    private readStoredKey(presetName?: string | null): string {
        if (!existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return "";
        const payload = this.readStoredCredentials();
        const encrypted = presetName ? payload.encryptedPresetApiKeys[presetName] : payload.encryptedApiKey;
        if (!encrypted) return "";
        try { return safeStorage.decryptString(Buffer.from(encrypted, "base64")); }
        catch { return ""; }
    }

    private readStoredCredentials(): StoredCredential {
        const empty: StoredCredential = { version: 2, encryptedPresetApiKeys: Object.create(null) as Record<string, string> };
        if (!existsSync(this.filePath)) return empty;
        try {
            const stored = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
                version?: unknown;
                encryptedApiKey?: unknown;
                encryptedPresetApiKeys?: unknown;
            };
            if (stored.version === 1 && typeof stored.encryptedApiKey === "string") {
                return { ...empty, encryptedApiKey: stored.encryptedApiKey };
            }
            if (stored.version !== 2 || !stored.encryptedPresetApiKeys || typeof stored.encryptedPresetApiKeys !== "object"
                || Array.isArray(stored.encryptedPresetApiKeys)) return empty;
            const presetKeys: Record<string, string> = Object.create(null) as Record<string, string>;
            for (const [name, value] of Object.entries(stored.encryptedPresetApiKeys)) {
                if (name && typeof value === "string") presetKeys[name] = value;
            }
            return {
                version: 2,
                ...(typeof stored.encryptedApiKey === "string" ? { encryptedApiKey: stored.encryptedApiKey } : {}),
                encryptedPresetApiKeys: presetKeys,
            };
        } catch {
            return empty;
        }
    }
}
