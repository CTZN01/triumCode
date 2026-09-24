import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SkillMode = "inline" | "fork";

export interface Skill {
    name: string;
    description: string;
    whenToUse: string;
    allowedTools: string[];
    userInvocable: boolean;
    mode: SkillMode;
    directory: string;
    prompt: string;
    source: "user" | "project";
}

export interface SkillIndexOptions {
    cwd?: string;
    home?: string;
    refresh?: boolean;
}

const cache = new Map<string, Skill[]>();
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function scalar(value: string | undefined): string {
    const text = (value ?? "").trim();
    if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
    return text;
}

// Shared with subagent.ts — a comma list or a JSON array, the two spellings
// skill and agent frontmatter use for allowed-tools.
export function parseList(value: string | undefined): string[] {
    const text = (value ?? "").trim();
    if (!text) return [];
    if (text.startsWith("[")) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
        } catch { return []; }
    }
    return text.split(",").map((item) => scalar(item)).map((item) => item.trim()).filter(Boolean);
}

function boolean(value: string | undefined, fallback: boolean): boolean {
    const text = (value ?? "").trim().toLowerCase();
    if (!text) return fallback;
    return text === "true" || text === "yes" || text === "1";
}

// Shared with memory.ts — both skills and memories are .md files with
// simple key: value frontmatter, so one hand-rolled parser serves both.
export function parseFrontmatter(content: string): { values: Map<string, string>; prompt: string } | null {
    const match = FRONTMATTER.exec(content.trimStart());
    if (!match) return null;
    const values = new Map<string, string>();
    for (const line of match[1].split(/\r?\n/)) {
        const separator = line.indexOf(":");
        if (separator <= 0) continue;
        values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    return { values, prompt: match[2].trim() };
}

function parseSkill(filePath: string, source: Skill["source"]): Skill | null {
    try {
        const parsed = parseFrontmatter(readFileSync(filePath, "utf8"));
        if (!parsed) return null;
        const values = parsed.values;
        const name = scalar(values.get("name")) || filePath.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
        return {
            name,
            description: scalar(values.get("description")),
            whenToUse: scalar(values.get("when_to_use") ?? values.get("when-to-use")),
            allowedTools: parseList(values.get("allowed-tools")),
            userInvocable: boolean(values.get("user-invocable"), true),
            mode: scalar(values.get("mode")) === "fork" ? "fork" : "inline",
            directory: dirname(filePath),
            prompt: parsed.prompt,
            source,
        };
    } catch { return null; }
}

function readSkillDirectory(directory: string, source: Skill["source"]): Skill[] {
    if (!existsSync(directory)) return [];
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return []; }
    return entries.filter((entry) => entry.toLowerCase().endsWith(".md")).sort()
        .map((entry) => parseSkill(join(directory, entry), source))
        .filter((skill): skill is Skill => Boolean(skill));
}

export function discoverSkills(options: SkillIndexOptions = {}): Skill[] {
    const cwd = resolve(options.cwd ?? process.cwd());
    const home = resolve(options.home ?? homedir());
    const key = `${cwd}\0${home}`;
    if (!options.refresh && cache.has(key)) return cache.get(key)!;
    const merged = new Map<string, Skill>();
    // Keep reading Claude Code's directories as a migration fallback. Within
    // each scope, TriumCode's own directory wins; project skills always win
    // over user skills.
    for (const skill of readSkillDirectory(join(home, ".claude", "skills"), "user")) merged.set(skill.name, skill);
    for (const skill of readSkillDirectory(join(home, ".triumcode", "skills"), "user")) merged.set(skill.name, skill);
    for (const skill of readSkillDirectory(join(cwd, ".claude", "skills"), "project")) merged.set(skill.name, skill);
    for (const skill of readSkillDirectory(join(cwd, ".triumcode", "skills"), "project")) merged.set(skill.name, skill);
    const result = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    cache.set(key, result);
    return result;
}

export function clearSkillCache(): void { cache.clear(); }

export function getSkill(name: string, options: SkillIndexOptions = {}): Skill | undefined {
    return discoverSkills(options).find((skill) => skill.name === name);
}

export function expandSkill(skill: Skill, argumentsText = ""): string {
    return skill.prompt
        .replace(/\$\{TRIUMCODE_SKILL_DIR\}|\$TRIUMCODE_SKILL_DIR|\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR/g, skill.directory)
        .replace(/\$\{ARGUMENTS\}|\$ARGUMENTS/g, argumentsText);
}

export function resolveSkillPrompt(name: string, argumentsText = "", options: SkillIndexOptions = {}): string | null {
    const skill = getSkill(name, options);
    if (!skill) return null;
    const expanded = expandSkill(skill, argumentsText);
    return skill.mode === "fork"
        ? `<skill name="${skill.name}" mode="fork">\nRun this skill in an isolated sub-agent context.\n\n${expanded}\n</skill>`
        : `<skill name="${skill.name}" mode="inline">\n${expanded}\n</skill>`;
}

export function buildSkillPromptBlock(options: SkillIndexOptions = {}): string {
    const skills = discoverSkills(options);
    if (skills.length === 0) return "";
    const manual = skills.filter((skill) => skill.userInvocable);
    const automatic = skills.filter((skill) => !skill.userInvocable);
    const format = (skill: Skill): string => `- ${skill.name}: ${skill.description}${skill.whenToUse ? ` (when to use: ${skill.whenToUse})` : ""}`;
    const blocks: string[] = ["# Skills"];
    if (manual.length) blocks.push("User-invocable skills (use /name):\n" + manual.map(format).join("\n"));
    if (automatic.length) blocks.push("Model-invocable skills (do not expose as slash commands):\n" + automatic.map(format).join("\n"));
    blocks.push("Use the skill tool to load a skill's full prompt. Respect its allowed-tools and execution mode.");
    return blocks.join("\n\n");
}

export function isAllowedSkillTool(skill: Skill, toolName: string): boolean {
    return skill.allowedTools.length === 0 || skill.allowedTools.includes("*") || skill.allowedTools.includes(toolName);
}
