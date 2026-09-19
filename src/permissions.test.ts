import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionPolicy, isDangerousCommand, parseRule } from "./permissions.js";

test("dangerous command detection covers destructive Unix and Windows commands", () => {
    assert.equal(isDangerousCommand("rm", ["-rf", "/tmp/demo"]), true);
    assert.equal(isDangerousCommand("git", ["push", "origin", "main"]), true);
    assert.equal(isDangerousCommand("Remove-Item", ["important.txt"]), true);
    assert.equal(isDangerousCommand("npm", ["test"]), false);
});

test("deny rules win over broad allow rules", () => {
    const policy = new PermissionPolicy("bypassPermissions", {
        allow: [parseRule("run_command")],
        deny: [parseRule("run_command(git push*)")],
    });

    assert.equal(policy.check("run_command", { command: "git", args: ["push", "origin", "main"] }).action, "deny");
    assert.equal(policy.check("run_command", { command: "npm", args: ["test"] }).action, "allow");
});

test("plan mode blocks writes and commands but permits reads", () => {
    const policy = new PermissionPolicy("plan", { allow: [], deny: [] });

    assert.equal(policy.check("read_file", { file_path: "README.md" }).action, "allow");
    assert.equal(policy.check("write_file", { file_path: "new-file.txt", content: "x" }).action, "deny");
    assert.equal(policy.check("run_command", { command: "npm", args: ["test"] }).action, "deny");
});

test("dangerous commands ask once and then use the session approval", () => {
    const policy = new PermissionPolicy("default", { allow: [], deny: [] });
    const first = policy.check("run_command", { command: "rm", args: ["-rf", "/tmp/demo"] });

    assert.equal(first.action, "confirm");
    assert.ok(first.key);
    policy.confirm(first.key!);
    assert.equal(policy.check("run_command", { command: "rm", args: ["-rf", "/tmp/demo"] }).action, "allow");
});

test("dontAsk denies dangerous commands without asking", () => {
    const policy = new PermissionPolicy("dontAsk", { allow: [], deny: [] });
    const result = policy.check("run_command", { command: "rm", args: ["-rf", "/tmp/demo"] });

    assert.equal(result.action, "deny");
    assert.match(result.message ?? "", /dontAsk/);
});
