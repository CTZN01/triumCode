import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearSkillCache, discoverSkills, expandSkill, getSkill, resolveSkillPrompt } from "./skills.js";

function fixture(): { home: string; cwd: string } {
    const home = mkdtempSync(join(tmpdir(), "triumcode-skills-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "triumcode-skills-project-"));
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "skills"), { recursive: true });
    return { home, cwd };
}

test("project skills override user skills and parse supported frontmatter", () => {
    const { home, cwd } = fixture();
    writeFileSync(join(home, ".claude", "skills", "commit.md"), "---\nname: commit\ndescription: user\n---\nuser prompt");
    writeFileSync(join(cwd, ".claude", "skills", "commit.md"), "---\nname: commit\ndescription: project\nallowed-tools: [\"git_diff\", \"run_command\"]\nwhen-to-use: before commit\n---\nCommit $ARGUMENTS from ${CLAUDE_SKILL_DIR}");
    clearSkillCache();
    const skill = getSkill("commit", { home, cwd });
    assert.equal(skill?.description, "project");
    assert.deepEqual(skill?.allowedTools, ["git_diff", "run_command"]);
    assert.equal(skill?.whenToUse, "before commit");
    assert.match(expandSkill(skill!, "the changes"), /the changes/);
    assert.match(expandSkill(skill!, "the changes"), new RegExp(skill!.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("TriumCode skill directories are preferred over legacy Claude directories", () => {
    const { home, cwd } = fixture();
    mkdirSync(join(home, ".triumcode", "skills"), { recursive: true });
    mkdirSync(join(cwd, ".triumcode", "skills"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "user.md"), "---\nname: user\ndescription: legacy user\n---\nlegacy");
    writeFileSync(join(home, ".triumcode", "skills", "user.md"), "---\nname: user\ndescription: TriumCode user\n---\nnative");
    writeFileSync(join(cwd, ".claude", "skills", "project.md"), "---\nname: project\ndescription: legacy project\n---\nlegacy");
    writeFileSync(join(cwd, ".triumcode", "skills", "project.md"), "---\nname: project\ndescription: TriumCode project\n---\nnative");
    clearSkillCache();

    const skills = discoverSkills({ home, cwd });
    assert.equal(skills.find((skill) => skill.name === "user")?.description, "TriumCode user");
    assert.equal(skills.find((skill) => skill.name === "project")?.description, "TriumCode project");
});

test("non-user-invocable skills remain discoverable for model invocation", () => {
    const { home, cwd } = fixture();
    writeFileSync(join(cwd, ".claude", "skills", "internal.md"), "---\nname: internal\ndescription: internal\nuser-invocable: false\n---\nsecret");
    clearSkillCache();
    assert.equal(discoverSkills({ home, cwd }).length, 1);
    assert.equal(resolveSkillPrompt("internal", "", { home, cwd })?.includes("secret"), true);
});
