import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk"
    | "desktopDefault" | "desktopAcceptEdits";
export type PermissionAction = "allow" | "deny" | "confirm";
export type PermissionGrant = boolean | "once" | "session";
export type PermissionOutcome = "once" | "session" | "denied" | "expired" | "cancelled";

export type PermissionRuleScope = "user" | "project" | "unknown";
export type PermissionSettingsFile = ".triumcode/settings.json" | ".claude/settings.json" | "unknown";

export type PermissionSource =
    | {
        kind: "rule";
        effect: "allow" | "deny";
        scope: PermissionRuleScope;
        settingsFile: PermissionSettingsFile;
        rule: string;
    }
    | {
        kind: "mode";
        effect: PermissionAction;
        mode: PermissionMode;
        reason: "default" | "plan-mode" | "plan-file" | "plan-restricted" | "accept-edits"
            | "bypass" | "desktop-default" | "desktop-accept-edits" | "dangerous-command";
    }
    | { kind: "builtin"; effect: "allow"; policy: "plan-control" | "read-tool" | "memory-tool" }
    | { kind: "session"; effect: "allow"; scope: "same-operation"; grantId: string };

export interface SessionPermissionGrant {
    id: string;
    key: string;
    toolName: string;
    operation: string;
    createdAt: string;
}

export interface SessionPermissionGrantSummary {
    id: string;
    toolName: string;
    operation: string;
    createdAt: string;
}

export interface PermissionRequest {
    toolCallId: string;
    toolName: string;
    input: Record<string, any>;
    message: string;
    source: PermissionSource;
    key?: string;
}

export interface ParsedRule {
    tool: string;
    pattern: string | null;
    source?: {
        scope: Exclude<PermissionRuleScope, "unknown">;
        settingsFile: Exclude<PermissionSettingsFile, "unknown">;
    };
}

export interface PermissionRules {
    allow: ParsedRule[];
    deny: ParsedRule[];
}

export interface PermissionDecision {
    action: PermissionAction;
    source: PermissionSource;
    message?: string;
    key?: string;
}

// `agent` is here because a delegation is reconnaissance by construction: the
// parent hands work to a context it cannot see, and the sub-agent inherits
// whatever mode the parent is in. A deny rule on it still wins — checkRules
// runs first — which is the switch for "no sub-agents in this project".
const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "git_diff", "tool_search", "skill", "ask_user", "todo", "agent"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
// The memory tool writes only into its own memory directories, never the
// workspace — allowed like a read tool, plan mode included.
const MEMORY_TOOLS = new Set(["memory"]);

const DANGEROUS_PATTERNS = [
    /\brm\s+(?:-[^\s]*f[^\s]*\s+)?(?:-[^\s]*\s+)*\//i,
    /\bgit\s+(?:push|reset\s+--hard|clean\b|checkout\s+\.)/i,
    /\bsudo\b/i,
    /\bmkfs(?:\.[\w-]+)?\b/i,
    /\bdd\s+if=/i,
    /(?:^|\s)>\s*\/dev\//i,
    /\b(?:kill|pkill|reboot|shutdown)\b/i,
    /\b(?:del|rmdir|format|taskkill|remove-item|stop-process)\b/i,
];

export function isDangerousCommand(command: string, args: string[] = []): boolean {
    return DANGEROUS_PATTERNS.some((pattern) => pattern.test([command, ...args].join(" ")));
}

export function parseRule(rule: string, source?: ParsedRule["source"]): ParsedRule {
    const match = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(rule.trim());
    return match
        ? { tool: match[1], pattern: match[2], ...(source ? { source } : {}) }
        : { tool: rule.trim(), pattern: null, ...(source ? { source } : {}) };
}

function loadSettings(path: string): { permissions?: { allow?: unknown; deny?: unknown } } | null {
    if (!existsSync(path)) return null;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

/** Load user and project rules. Deny rules are intentionally never discarded. */
export function loadPermissionRules(cwd = process.cwd()): PermissionRules {
    const allow: ParsedRule[] = [];
    const deny: ParsedRule[] = [];
    const paths: Array<{
        path: string;
        scope: "user" | "project";
        settingsFile: Exclude<PermissionSettingsFile, "unknown">;
    }> = [
        { path: join(homedir(), ".triumcode", "settings.json"), scope: "user", settingsFile: ".triumcode/settings.json" },
        { path: join(homedir(), ".claude", "settings.json"), scope: "user", settingsFile: ".claude/settings.json" },
        { path: join(cwd, ".triumcode", "settings.json"), scope: "project", settingsFile: ".triumcode/settings.json" },
        { path: join(cwd, ".claude", "settings.json"), scope: "project", settingsFile: ".claude/settings.json" },
    ];

    for (const entry of paths) {
        const permissions = loadSettings(entry.path)?.permissions;
        if (!permissions || typeof permissions !== "object") continue;
        const source = {
            scope: entry.scope,
            settingsFile: entry.settingsFile,
        };
        for (const rule of Array.isArray(permissions.allow) ? permissions.allow : []) {
            if (typeof rule === "string" && rule.trim()) allow.push(parseRule(rule, source));
        }
        for (const rule of Array.isArray(permissions.deny) ? permissions.deny : []) {
            if (typeof rule === "string" && rule.trim()) deny.push(parseRule(rule, source));
        }
    }
    return { allow, deny };
}

function inputValue(toolName: string, input: Record<string, any>): string | null {
    if (toolName === "run_command") {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return [String(input.command ?? ""), ...args].join(" ");
    }
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.path === "string") return input.path;
    return null;
}

function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
    if (rule.tool !== toolName) return false;
    if (rule.pattern === null) return true;
    const value = inputValue(toolName, input);
    if (value === null) return false;
    return rule.pattern.endsWith("*")
        ? value.startsWith(rule.pattern.slice(0, -1))
        : value === rule.pattern;
}

function checkRules(
    rules: PermissionRules,
    toolName: string,
    input: Record<string, any>,
): { effect: "allow" | "deny"; rule: ParsedRule } | null {
    const denied = rules.deny.find((rule) => matchesRule(rule, toolName, input));
    if (denied) return { effect: "deny", rule: denied };
    const allowed = rules.allow.find((rule) => matchesRule(rule, toolName, input));
    if (allowed) return { effect: "allow", rule: allowed };
    return null;
}

function ruleSource(rule: ParsedRule, effect: "allow" | "deny"): PermissionSource {
    return {
        kind: "rule",
        effect,
        scope: rule.source?.scope ?? "unknown",
        settingsFile: rule.source?.settingsFile ?? "unknown",
        rule: rule.pattern === null ? rule.tool : `${rule.tool}(${rule.pattern})`,
    };
}

function modeDecision(
    action: PermissionAction,
    mode: PermissionMode,
    reason: Extract<PermissionSource, { kind: "mode" }>["reason"],
    message?: string,
    key?: string,
): PermissionDecision {
    return {
        action,
        source: { kind: "mode", effect: action, mode, reason },
        ...(message ? { message } : {}),
        ...(key ? { key } : {}),
    };
}

/** Validate permission provenance loaded from a persisted desktop session. */
export function parsePermissionSource(value: unknown): PermissionSource | null {
    if (!value || typeof value !== "object") return null;
    const source = value as Record<string, unknown>;
    if (source.kind === "rule"
        && (source.effect === "allow" || source.effect === "deny")
        && (source.scope === "user" || source.scope === "project" || source.scope === "unknown")
        && (source.settingsFile === ".triumcode/settings.json" || source.settingsFile === ".claude/settings.json" || source.settingsFile === "unknown")
        && typeof source.rule === "string") {
        return {
            kind: "rule",
            effect: source.effect,
            scope: source.scope,
            settingsFile: source.settingsFile,
            rule: source.rule.slice(0, 300),
        };
    }
    const modes: PermissionMode[] = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "desktopDefault", "desktopAcceptEdits"];
    const reasons: Extract<PermissionSource, { kind: "mode" }>["reason"][] = [
        "default", "plan-mode", "plan-file", "plan-restricted", "accept-edits", "bypass",
        "desktop-default", "desktop-accept-edits", "dangerous-command",
    ];
    if (source.kind === "mode" && modes.includes(source.mode as PermissionMode)
        && (source.effect === "allow" || source.effect === "deny" || source.effect === "confirm")
        && reasons.includes(source.reason as Extract<PermissionSource, { kind: "mode" }>["reason"])) {
        return {
            kind: "mode",
            effect: source.effect,
            mode: source.mode as PermissionMode,
            reason: source.reason as Extract<PermissionSource, { kind: "mode" }>["reason"],
        };
    }
    if (source.kind === "builtin" && source.effect === "allow"
        && (source.policy === "plan-control" || source.policy === "read-tool" || source.policy === "memory-tool")) {
        return { kind: "builtin", effect: "allow", policy: source.policy };
    }
    if (source.kind === "session" && source.effect === "allow" && source.scope === "same-operation") {
        if (typeof source.grantId !== "string" || source.grantId.length > 36) return null;
        return { kind: "session", effect: "allow", scope: "same-operation", grantId: source.grantId };
    }
    return null;
}

function operationKey(toolName: string, input: Record<string, any>, workspaceRoot: string, workspaceScoped = true): string {
    const value = inputValue(toolName, input) ?? JSON.stringify(input);
    if (!workspaceScoped) return `${toolName}:${value}`;
    let operation: unknown;
    if (toolName === "run_command") {
        const cwd = typeof input.cwd === "string" && input.cwd ? resolve(workspaceRoot, input.cwd) : workspaceRoot;
        const { cwd: _cwd, ...parameters } = input;
        operation = [toolName, workspaceRoot, cwd, stableValue(parameters)];
    } else if (typeof input.file_path === "string") {
        const { file_path: _filePath, path: _path, ...parameters } = input;
        operation = [toolName, workspaceRoot, resolve(workspaceRoot, input.file_path), stableValue(parameters)];
    } else if (typeof input.path === "string") {
        const { file_path: _filePath, path: _path, ...parameters } = input;
        operation = [toolName, workspaceRoot, resolve(workspaceRoot, input.path), stableValue(parameters)];
    } else {
        operation = [toolName, workspaceRoot, stableValue(input)];
    }
    return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, stableValue(entry)]));
}

function sessionGrantDescription(toolName: string, input: Record<string, any>, workspaceRoot: string): string {
    if (toolName === "run_command") {
        const cwd = typeof input.cwd === "string" && input.cwd ? resolve(workspaceRoot, input.cwd) : workspaceRoot;
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        return `目录: ${cwd}\n命令: ${[String(input.command ?? ""), ...args].join(" ")}`;
    }
    const path = typeof input.file_path === "string" ? input.file_path
        : typeof input.path === "string" ? input.path : null;
    return path === null ? toolName : resolve(workspaceRoot, path);
}

export class SessionPermissionGrantStore {
    private readonly grants = new Map<string, SessionPermissionGrant>();

    constructor(initial: SessionPermissionGrant[] = []) {
        for (const grant of initial) this.grants.set(grant.key, grant);
    }

    get(key: string): SessionPermissionGrant | undefined {
        return this.grants.get(key);
    }

    confirm(key: string, toolName: string, input: Record<string, any>, workspaceRoot: string): string {
        const existing = this.grants.get(key);
        if (existing) return existing.id;
        const grant: SessionPermissionGrant = {
            id: randomUUID(),
            key,
            toolName,
            operation: sessionGrantDescription(toolName, input, workspaceRoot),
            createdAt: new Date().toISOString(),
        };
        this.grants.set(key, grant);
        return grant.id;
    }

    list(): SessionPermissionGrantSummary[] {
        return [...this.grants.values()]
            .map(({ id, toolName, operation, createdAt }) => ({ id, toolName, operation, createdAt }));
    }

    listForPersistence(): SessionPermissionGrant[] {
        return [...this.grants.values()].map((grant) => ({ ...grant }));
    }

    revoke(id: string): boolean {
        for (const [key, grant] of this.grants) {
            if (grant.id !== id) continue;
            this.grants.delete(key);
            return true;
        }
        return false;
    }
}

export class PermissionPolicy {
    private readonly sessionGrantStore: SessionPermissionGrantStore;
    private readonly rules: PermissionRules;
    private readonly workspaceRoot: string;
    private currentMode: PermissionMode;
    private planFilePath: string | null = null;

    constructor(
        mode: PermissionMode = "default",
        rules: PermissionRules = loadPermissionRules(),
        workspaceRoot = process.cwd(),
        sessionGrants: SessionPermissionGrant[] = [],
        sessionGrantStore?: SessionPermissionGrantStore,
    ) {
        this.currentMode = mode;
        this.rules = rules;
        this.workspaceRoot = resolve(workspaceRoot);
        this.sessionGrantStore = sessionGrantStore ?? new SessionPermissionGrantStore(sessionGrants);
    }

    setMode(mode: PermissionMode): void {
        this.currentMode = mode;
    }

    setPlanFilePath(path: string | null): void {
        this.planFilePath = path;
    }

    check(toolName: string, input: Record<string, any>): PermissionDecision {
        const ruleResult = checkRules(this.rules, toolName, input);
        if (ruleResult?.effect === "deny") {
            return {
                action: "deny",
                source: ruleSource(ruleResult.rule, "deny"),
                message: `Denied by permission rule for ${toolName}`,
            };
        }

        // Plan mode tools are always allowed
        if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") {
            return { action: "allow", source: { kind: "builtin", effect: "allow", policy: "plan-control" } };
        }

        if (this.currentMode === "plan") {
            // Allow read tools and the memory tool (its writes stay in the
            // memory directories, outside the workspace)
            if (READ_TOOLS.has(toolName) || MEMORY_TOOLS.has(toolName)) {
                return {
                    action: "allow",
                    source: { kind: "builtin", effect: "allow", policy: MEMORY_TOOLS.has(toolName) ? "memory-tool" : "read-tool" },
                };
            }
            // Allow writing/editing the plan file itself
            if (this.planFilePath && EDIT_TOOLS.has(toolName)) {
                const filePath = input.file_path || input.path;
                if (typeof filePath === "string" && resolve(filePath) === resolve(this.planFilePath)) {
                    return modeDecision("allow", "plan", "plan-file");
                }
            }
            // Block everything else in plan mode
            return modeDecision("deny", "plan", "plan-restricted", `Blocked in plan mode: ${toolName}`);
        }

        if (this.currentMode === "bypassPermissions") return modeDecision("allow", "bypassPermissions", "bypass");
        if (ruleResult?.effect === "allow") {
            return { action: "allow", source: ruleSource(ruleResult.rule, "allow") };
        }
        if (READ_TOOLS.has(toolName) || MEMORY_TOOLS.has(toolName)) {
            return {
                action: "allow",
                source: { kind: "builtin", effect: "allow", policy: MEMORY_TOOLS.has(toolName) ? "memory-tool" : "read-tool" },
            };
        }

        if (this.currentMode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
            return modeDecision("allow", "acceptEdits", "accept-edits");
        }

        if (this.currentMode === "desktopDefault" || this.currentMode === "desktopAcceptEdits") {
            if (this.currentMode === "desktopAcceptEdits" && EDIT_TOOLS.has(toolName)) {
                return modeDecision("allow", "desktopAcceptEdits", "desktop-accept-edits");
            }
            const key = operationKey(toolName, input, this.workspaceRoot);
            const grant = this.sessionGrantStore.get(key);
            if (grant) {
                return { action: "allow", source: { kind: "session", effect: "allow", scope: "same-operation", grantId: grant.id } };
            }
            const message = toolName === "run_command"
                ? [String(input.command ?? ""), ...(Array.isArray(input.args) ? input.args.map(String) : [])].join(" ")
                : `${toolName}: ${String(input.file_path ?? input.path ?? JSON.stringify(input))}`;
            return modeDecision("confirm", "desktopDefault", "desktop-default", message, key);
        }

        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        if (toolName === "run_command" && isDangerousCommand(String(input.command ?? ""), args)) {
            const command = [String(input.command ?? ""), ...args].join(" ");
            const key = operationKey(toolName, input, this.workspaceRoot, false);
            const grant = this.sessionGrantStore.get(key);
            if (grant) {
                return { action: "allow", source: { kind: "session", effect: "allow", scope: "same-operation", grantId: grant.id } };
            }
            if (this.currentMode === "dontAsk") {
                return modeDecision("deny", "dontAsk", "dangerous-command", `Auto-denied (dontAsk mode): ${command}`);
            }
            return modeDecision("confirm", this.currentMode, "dangerous-command", command, key);
        }

        return modeDecision("allow", this.currentMode, "default");
    }

    confirm(key: string, toolName = "unknown", input: Record<string, any> = {}): string {
        return this.sessionGrantStore.confirm(key, toolName, input, this.workspaceRoot);
    }

    getSessionGrants(): SessionPermissionGrantSummary[] {
        return this.sessionGrantStore.list();
    }

    getPersistedSessionGrants(): SessionPermissionGrant[] {
        return this.sessionGrantStore.listForPersistence();
    }

    getSessionGrantStore(): SessionPermissionGrantStore {
        return this.sessionGrantStore;
    }

    revokeSessionGrant(id: string): boolean {
        return this.sessionGrantStore.revoke(id);
    }
}
