import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
export type PermissionAction = "allow" | "deny" | "confirm";

interface ParsedRule {
    tool: string;
    pattern: string | null;
}

export interface PermissionRules {
    allow: ParsedRule[];
    deny: ParsedRule[];
}

export interface PermissionDecision {
    action: PermissionAction;
    message?: string;
    key?: string;
}

// `agent` is here because a delegation is reconnaissance by construction: the
// parent hands work to a context it cannot see, and the sub-agent inherits
// whatever mode the parent is in. A deny rule on it still wins — checkRules
// runs first — which is the switch for "no sub-agents in this project".
const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "tool_search", "ask_user", "todo", "agent"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
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

export function parseRule(rule: string): ParsedRule {
    const match = /^([a-z_][a-z0-9_]*)\((.*)\)$/.exec(rule.trim());
    return match ? { tool: match[1], pattern: match[2] } : { tool: rule.trim(), pattern: null };
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
    const paths = [
        join(homedir(), ".triumcode", "settings.json"),
        join(homedir(), ".claude", "settings.json"),
        join(cwd, ".triumcode", "settings.json"),
        join(cwd, ".claude", "settings.json"),
    ];

    for (const path of paths) {
        const permissions = loadSettings(path)?.permissions;
        if (!permissions || typeof permissions !== "object") continue;
        for (const rule of Array.isArray(permissions.allow) ? permissions.allow : []) {
            if (typeof rule === "string" && rule.trim()) allow.push(parseRule(rule));
        }
        for (const rule of Array.isArray(permissions.deny) ? permissions.deny : []) {
            if (typeof rule === "string" && rule.trim()) deny.push(parseRule(rule));
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

function checkRules(rules: PermissionRules, toolName: string, input: Record<string, any>): "allow" | "deny" | null {
    if (rules.deny.some((rule) => matchesRule(rule, toolName, input))) return "deny";
    if (rules.allow.some((rule) => matchesRule(rule, toolName, input))) return "allow";
    return null;
}

function operationKey(toolName: string, input: Record<string, any>): string {
    const value = inputValue(toolName, input) ?? JSON.stringify(input);
    return `${toolName}:${value}`;
}

export class PermissionPolicy {
    private readonly confirmed = new Set<string>();
    private readonly rules: PermissionRules;
    private currentMode: PermissionMode;
    private planFilePath: string | null = null;

    constructor(
        mode: PermissionMode = "default",
        rules: PermissionRules = loadPermissionRules(),
    ) {
        this.currentMode = mode;
        this.rules = rules;
    }

    setMode(mode: PermissionMode): void {
        this.currentMode = mode;
    }

    setPlanFilePath(path: string | null): void {
        this.planFilePath = path;
    }

    check(toolName: string, input: Record<string, any>): PermissionDecision {
        const ruleResult = checkRules(this.rules, toolName, input);
        if (ruleResult === "deny") {
            return { action: "deny", message: `Denied by permission rule for ${toolName}` };
        }

        // Plan mode tools are always allowed
        if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") {
            return { action: "allow" };
        }

        if (this.currentMode === "plan") {
            // Allow read tools and the memory tool (its writes stay in the
            // memory directories, outside the workspace)
            if (READ_TOOLS.has(toolName) || MEMORY_TOOLS.has(toolName)) {
                return { action: "allow" };
            }
            // Allow writing/editing the plan file itself
            if (this.planFilePath && EDIT_TOOLS.has(toolName)) {
                const filePath = input.file_path || input.path;
                if (typeof filePath === "string" && resolve(filePath) === resolve(this.planFilePath)) {
                    return { action: "allow" };
                }
            }
            // Block everything else in plan mode
            return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
        }

        if (this.currentMode === "bypassPermissions") return { action: "allow" };
        if (ruleResult === "allow" || READ_TOOLS.has(toolName) || MEMORY_TOOLS.has(toolName)) return { action: "allow" };

        if (this.currentMode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { action: "allow" };

        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        if (toolName === "run_command" && isDangerousCommand(String(input.command ?? ""), args)) {
            const command = [String(input.command ?? ""), ...args].join(" ");
            const key = operationKey(toolName, input);
            if (this.confirmed.has(key)) return { action: "allow" };
            if (this.currentMode === "dontAsk") return { action: "deny", message: `Auto-denied (dontAsk mode): ${command}` };
            return { action: "confirm", message: command, key };
        }

        return { action: "allow" };
    }

    confirm(key: string): void {
        this.confirmed.add(key);
    }
}