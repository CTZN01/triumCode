import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as ui from "./ui.js";

// ═══════════════════════════════════════════════════════════════
// Fake terminal
// ═══════════════════════════════════════════════════════════════
//
// Decodes the ANSI subset the UI emits (\n, \r, erase-in-line, SGR) into a
// grid, so tests assert on what the user sees instead of on escape bytes.
// console.log and process.stdout.write both land on process.stdout, so one
// patched stream captures everything.

interface FakeTty {
    screen(): string;
    restore(): void;
}

function installFakeTty(columns = 80): FakeTty {
    // Module state (lineOpen, afterToolOutput) leaks across tests in the same
    // process — every fake terminal starts from a clean slate.
    ui.resetStreamState();
    const stdout = process.stdout as any;
    const orig = { isTTY: stdout.isTTY, columns: stdout.columns, write: stdout.write };

    const rows: string[][] = [[]];
    // One past the highest column actually written on each row. Needed because
    // padding inserted to fill a gap is not content — "You: " must keep its
    // trailing space, while a half-erased row must not.
    const used: number[] = [0];
    let row = 0;
    let col = 0;

    const feed = (s: string): void => {
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];

            if (ch === "\x1b") {
                const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(s.slice(i));
                if (!m) continue;
                if (m[2] === "K") { rows[row] = []; used[row] = 0; col = 0; }   // erase entire line
                else if (m[2] === "J") { rows.length = 0; rows.push([]); row = 0; col = 0; }
                // SGR (m) and anything else: zero-width, ignore.
                i += m[0].length - 1;
                continue;
            }

            if (ch === "\n") { row++; rows[row] ??= []; used[row] ??= 0; col = 0; continue; }
            if (ch === "\r") { col = 0; continue; }

            const line = rows[row];
            while (line.length < col) line.push(" ");
            line[col] = ch;
            col++;
            used[row] = Math.max(used[row], col);
        }
    };

    stdout.isTTY = true;
    stdout.columns = columns;
    stdout.write = (chunk: any): boolean => { feed(String(chunk)); return true; };

    return {
        screen(): string {
            return rows
                .map((r, i) => r.slice(0, used[i]).join(""))
                .join("\n")
                .replace(/\n+$/, "");
        },
        restore(): void {
            stdout.isTTY = orig.isTTY;
            stdout.columns = orig.columns;
            stdout.write = orig.write;
        },
    };
}


// ═══════════════════════════════════════════════════════════════
// Layout regressions
// ═══════════════════════════════════════════════════════════════

test("model text and a following tool call land on separate lines", () => {
    const vt = installFakeTty();
    try {
        ui.printUserPrompt();
        ui.writeStream("我再补充几个经典算法。");
        ui.printToolCall("edit_file", { file_path: "src/a.py" });
        ui.endStream();
        ui.printToolResult("edit_file", "Edited src/a.py at line 211", 81);

        assert.equal(vt.screen(), [
            "",
            "  我再补充几个经典算法。",
            "  • Edit src/a.py",
            "    ↳ ✓ Edited at line 211 (81ms)",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("a turn with only tool calls gains no blank line before the result", () => {
    const vt = installFakeTty();
    try {
        ui.printToolCall("read_file", { file_path: "src/a.py" });
        ui.endStream();
        ui.printToolResult("read_file", "a\nb\nc", 74);

        assert.equal(vt.screen(), [
            "  • Read src/a.py",
            "    ↳ ✓ 3 lines (74ms)",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("endStream adds a newline only when text left the cursor mid-line", () => {
    const vt = installFakeTty();
    try {
        ui.endStream();                       // nothing streamed: no-op
        assert.equal(vt.screen(), "");

        ui.writeStream("hi");
        ui.endStream();
        assert.equal(vt.screen(), "  hi");
    } finally {
        vt.restore();
    }
});

test("every streamed line gets the margin, not just the first", () => {
    // A chunk is whatever the API sent, so a paragraph break arrives glued to
    // the end of the previous one. Indenting only the chunk's first line left
    // the rest of the reply at a different column from the line above it.
    const vt = installFakeTty();
    try {
        ui.writeStream("para one\n\npara two\n- item");
        ui.endStream();

        assert.deepEqual(vt.screen().split("\n"), [
            "  para one",
            "",
            "  para two",
            "  • item",
        ]);
    } finally {
        vt.restore();
    }
});

test("streamed model text is rendered as markdown", () => {
    const vt = installFakeTty();
    try {
        ui.writeStream("**Done** — see `src/ui.ts`\n\n## Next\n1. run tests");
        ui.endStream();

        assert.deepEqual(vt.screen().split("\n"), [
            "  Done — see src/ui.ts",
            "",
            "  Next",
            "  1. run tests",
        ]);
    } finally {
        vt.restore();
    }
});

// ═══════════════════════════════════════════════════════════════
// Tool result states
// ═══════════════════════════════════════════════════════════════

test("classifyResult marks failures, warnings and successes", () => {
    const cases: Array<[string, string, string, boolean, boolean]> = [
        // [tool, result, expected text, ok, warn]
        ["read_file", "a\nb\nc", "3 lines", true, false],
        ["read_file", "Error reading file: ENOENT", "Error reading file: ENOENT", false, false],
        ["write_file", "Successfully wrote src/a.py (12 lines, 340 bytes)",
            "Successfully wrote src/a.py (12 lines, 340 bytes)", true, false],
        ["write_file", "Warning: D:\\x.py was modified externally since you last read it. Read it again before writing it, so you are working from its current contents.",
            "Warning: D:\\x.py was modified externally since you last read it. Read it again before writing it, so you are working from its current contents.", false, true],
        ["edit_file", "Edited src/a.py at line 211", "Edited at line 211", true, false],
        ["edit_file", "No change: old_string and new_string are identical.", "No change: old_string and new_string are identical.", true, false],
        // The first parenthetical is the line stats; a trailing display note
        // must not be captured in its place.
        ["multi_edit", "Edited 1 region in src/a.py (+1/-1 lines)", "Edited 1 place +1/-1 lines", true, false],
        ["multi_edit", "Edited 4 regions in src/a.py (+5/-4 lines) (showing 3 of 4 regions)", "Edited 4 places +5/-4 lines", true, false],
        ["list_files", "src/a.py\nsrc/b.py", "2 entries", true, false],
        ["list_files", "src/a.py", "1 entry", true, false],
        // Regression: a single-line "No files found" used to count as "1 entries".
        ["list_files", "No files found in src/empty.", "no files", true, false],
        ["grep_search", "src/a.py:12:const x = 1\nsrc/a.py:40:const y = 2", "2 matches", true, false],
        ["grep_search", "src/a.py:12:const x = 1", "1 match", true, false],
        ["grep_search", "No matches found.", "no matches", true, false],
        // Regression: a capped search used to report "0 matches".
        ["grep_search", "Too many matches (over 8MB) — narrow the path or the pattern.",
            "Too many matches (over 8MB) — narrow the path or the pattern.", false, true],
        ["grep_search", "src/a.py:1:x\n\n(showing 1 of 250+ matches — narrow the path or the pattern)", "250 matches", true, false],
        ["run_command", "exit 0 · 71ms\nok", "exit 0", true, false],
        ["run_command", "exit 1 · 12ms\nboom", "exit 1", false, false],
        ["run_command", "timed out after 30s — killed\n", "timed out after 30s — killed", false, false],
        ["run_command", "killed by SIGTERM\n", "killed by SIGTERM", false, false],
        ["unknown", "Unknown tool: frobnicate", "Unknown tool: frobnicate", false, false],
        ["read_file", "Error executing read_file: EPERM", "Error executing read_file: EPERM", false, false],
    ];

    for (const [name, result, text, ok, warn] of cases) {
        const view = ui.classifyResult(name, result);
        assert.deepEqual(
            { text: view.text, ok: view.ok, warn: view.warn ?? false },
            { text, ok, warn },
            `${name} <- ${JSON.stringify(result.slice(0, 40))}`,
        );
    }
});

test("printToolResult renders ✓ / ! / ✗", () => {
    const vt = installFakeTty();
    try {
        ui.printToolResult("read_file", "a\nb", 3);
        ui.printToolResult("write_file", "Warning: stale", 4);
        ui.printToolResult("run_command", "exit 1 · 9ms\nboom", 5);

        assert.equal(vt.screen(), [
            "    ↳ ✓ 2 lines (3ms)",
            "    ↳ ! Warning: stale (4ms)",
            "    ↳ ✗ exit 1 (5ms)",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

// ═══════════════════════════════════════════════════════════════
// Tool call display
// ═══════════════════════════════════════════════════════════════

test("a blank line separates tool output from the next text block", () => {
    const vt = installFakeTty();
    try {
        ui.printToolCall("read_file", { file_path: "src/a.py" });
        ui.endStream();
        ui.printToolResult("read_file", "a\nb", 3);
        ui.writeStream("Now I know what to change.");
        ui.endStream();

        assert.equal(vt.screen(), [
            "  • Read src/a.py",
            "    ↳ ✓ 2 lines (3ms)",
            "",
            "  Now I know what to change.",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("consecutive tool lines gain no blank line between them", () => {
    const vt = installFakeTty();
    try {
        ui.printToolCall("read_file", { file_path: "src/a.py" });
        ui.printToolCall("grep_search", { pattern: "x", path: "src" });
        ui.printToolResult("read_file", "a\nb", 3);
        ui.printToolResult("grep_search", "src/a.py:1:x", 5);
        ui.printToolResult("read_file", "a\nb", 3);   // second turn, no text in between

        assert.equal(vt.screen(), [
            "  • Read src/a.py",
            "  • Search \"x\" in src",
            "    ↳ ✓ 2 lines (3ms)",
            "    ↳ ✓ 1 match (5ms)",
            "    ↳ ✓ 2 lines (3ms)",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("file paths under the cwd display relative to it", () => {
    const vt = installFakeTty();
    try {
        const abs = join(process.cwd(), "src", "agent.ts");
        ui.printToolCall("read_file", { file_path: abs });
        ui.printToolCall("read_file", { file_path: "D:\\some\\other\\place\\file.py" });

        assert.equal(vt.screen(), [
            "  • Read src/agent.ts",
            "  • Read D:/some/other/place/file.py",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("read_file calls show the window they asked for", () => {
    const vt = installFakeTty();
    try {
        ui.printToolCall("read_file", { file_path: "src/a.ts", offset: 100, limit: 50 });
        ui.printToolCall("read_file", { file_path: "src/a.ts", offset: 300 });
        ui.printToolCall("read_file", { file_path: "src/a.ts" });
        ui.printToolResult("read_file", "  1 | const a = 1;\n  2 | const b = 2;", 74, { file_path: "src/a.ts" });

        // Two pages of one file must not print as identical lines, and the
        // result names the file because parallel calls batch their results
        // after the fact.
        assert.equal(vt.screen(), [
            "  • Read src/a.ts:100-149",
            "  • Read src/a.ts:300+",
            "  • Read src/a.ts",
            "    ↳ ✓ src/a.ts:1-2 (74ms)",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("read_file summaries report the range actually delivered", () => {
    const numbered = "  1 | const a = 1;\n  2 | const b = 2;";
    assert.deepEqual(
        { ...ui.classifyResult("read_file", numbered, { file_path: "src/a.ts" }) },
        { text: "src/a.ts:1-2", ok: true },
    );

    // The continuation footer carries the file's total.
    const paged = "200 | x\n201 | y\n\n[lines 200-201 of 3500. Continue with offset=202.]";
    assert.equal(
        ui.classifyResult("read_file", paged, { file_path: "src/big.ts" }).text,
        "src/big.ts:200-201 of 3500",
    );

    // The repeat-read notice names the range it refused to re-send.
    const notice = "src/a.ts is unchanged since you read lines 3-5 of it, and that content is already above in this conversation.";
    assert.equal(
        ui.classifyResult("read_file", notice, { file_path: "src/a.ts" }).text,
        "src/a.ts:3-5 unchanged",
    );

    // Output with no numbered lines keeps the old line count.
    assert.equal(ui.classifyResult("read_file", "a\nb").text, "2 lines");
});

test("a long run_command target is truncated to one row, not wrapped", () => {
    const vt = installFakeTty(60);
    try {
        const script = "node -e " + "console.log(1);".repeat(30);
        ui.printToolCall("run_command", { command: "node", args: ["-e", script] });

        const line = vt.screen();
        assert.equal(line.split("\n").length, 1, "must stay on one row");
        assert.ok(line.length <= 60, `expected <= 60 columns, got ${line.length}`);
        assert.match(line, /\.\.\.$/);
        assert.match(line, /^  • Run /);
    } finally {
        vt.restore();
    }
});

test("todo and git_diff calls render a summary instead of raw JSON", () => {
    const vt = installFakeTty();
    try {
        ui.printToolCall("todo", {
            operation: "write",
            todos: [
                { id: 1, content: "a", status: "pending" },
                { id: 2, content: "b", status: "pending" },
            ],
        });
        ui.printToolCall("todo", { operation: "read" });
        ui.printToolCall("git_diff", { staged: true, path: "src/tools.ts" });
        ui.printToolCall("git_diff", {});

        assert.equal(vt.screen(), [
            "  • Todo write 2 items",
            "  • Todo read",
            "  • Git diff staged src/tools.ts",
            "  • Git diff",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

// ═══════════════════════════════════════════════════════════════
// Status line lifecycle
// ═══════════════════════════════════════════════════════════════

test("the status line waits out the arm delay before its first frame", () => {
    const vt = installFakeTty();
    try {
        ui.beginStatus("Pondering");
        const t0 = Date.now();

        ui.renderStatus(t0, false);                 // immediately: too early
        assert.equal(ui.statusSnapshot().visible, false);
        assert.equal(vt.screen(), "");

        ui.renderStatus(t0 + 1000, false);          // past the delay
        assert.equal(ui.statusSnapshot().visible, true);
        assert.match(vt.screen(), /  Pondering\.{1,3} +\(1s\)$/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("consecutive ticks animate the frame and advance the clock", () => {
    const vt = installFakeTty();
    try {
        const t0 = Date.now();
        ui.beginStatus("Pondering");
        ui.renderStatus(t0 + 1000, false);
        const first = vt.screen();

        ui.renderStatus(t0 + 2000, false);
        const second = vt.screen();

        assert.match(first, /\(1s\)$/);
        assert.match(second, /\(2s\)$/);
        // Regression: skipping the repaint when a frame was already visible
        // froze the spinner and the counter at their first-frame values.
        assert.notEqual(first, second, "the frame must animate, not freeze");
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("printed output erases the frame and the next tick redraws below it", () => {
    const vt = installFakeTty();
    try {
        const t0 = Date.now();
        ui.beginStatus("Pondering");
        ui.renderStatus(t0 + 1000, false);

        ui.printInfo("hello");
        assert.equal(ui.statusSnapshot().visible, false);
        assert.equal(vt.screen(), "  hello");

        ui.renderStatus(t0 + 1000, false);
        assert.equal(vt.screen().split("\n")[0], "  hello");
        assert.match(vt.screen(), /  Pondering\.{1,3} +\(1s\)$/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("streamed text replaces the frame instead of colliding with it", () => {
    const vt = installFakeTty();
    try {
        const t0 = Date.now();
        ui.beginStatus("Pondering");
        ui.renderStatus(t0 + 1000, false);

        ui.writeStream("模型输出");
        ui.endStream();
        assert.equal(vt.screen(), "  模型输出");
        assert.equal(ui.statusSnapshot().active, false);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("printInterrupted clears the frame (the Ctrl+C path)", () => {
    const vt = installFakeTty();
    try {
        ui.beginStatus("Pondering");
        ui.renderStatus(Date.now() + 1000, false);

        ui.printInterrupted();
        ui.endStatus();

        assert.doesNotMatch(vt.screen(), /Pondering/);
        assert.match(vt.screen(), /\(interrupted\)/);
    } finally {
        vt.restore();
    }
});

test("printUserPrompt stops the status outright, timer and all", () => {
    const vt = installFakeTty();
    try {
        const created: any[] = [];
        const cleared: any[] = [];
        const realSet = globalThis.setInterval;
        const realClear = globalThis.clearInterval;
        (globalThis as any).setInterval = (fn: any, ms: any) => {
            const t = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
            created.push(t);
            return t;
        };
        (globalThis as any).clearInterval = (t: any) => { cleared.push(t); };

        try {
            ui.beginStatus("Pondering");
            ui.beginStatus("Pondering");          // repeated: must not leak intervals
            assert.equal(created.length, 1, "one interval per active status");
            assert.equal(created[0].unrefCalled, true, "interval must be unref'd");

            ui.renderStatus(Date.now() + 1000, false);
            ui.printUserPrompt();

            assert.equal(ui.statusSnapshot().active, false);
            assert.equal(ui.statusSnapshot().visible, false);
            assert.equal(cleared.length, 1, "printUserPrompt clears the interval");
            // The prompt itself must survive.
            assert.equal(vt.screen().split("\n").pop(), "");
        } finally {
            (globalThis as any).setInterval = realSet;
            (globalThis as any).clearInterval = realClear;
            ui.endStatus();
        }
    } finally {
        vt.restore();
    }
});

test("endStatus is idempotent and silences further frames", () => {
    const vt = installFakeTty();
    try {
        ui.beginStatus("Pondering");
        ui.renderStatus(Date.now() + 1000, false);
        ui.endStatus();
        const after = vt.screen();

        ui.endStatus();
        ui.renderStatus(Date.now() + 5000, false);

        assert.equal(vt.screen(), after);
        assert.deepEqual(ui.statusSnapshot(), { active: false, visible: false, label: "Pondering" });
    } finally {
        vt.restore();
    }
});

test("updateStatus repaints immediately with the new label", () => {
    const vt = installFakeTty();
    try {
        const t0 = Date.now();
        ui.beginStatus("Pondering");
        ui.renderStatus(t0 + 1000, false);

        // Repainted on the spot, without waiting for a tick. The elapsed time
        // comes from the real clock here, so only the label is asserted.
        ui.updateStatus("Running read_file");
        assert.equal(ui.statusSnapshot().label, "Running read_file");
        assert.match(vt.screen(), /^  Running read_file\.{1,3} +\(\d+s\)$/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("a function label is re-evaluated every frame", () => {
    const vt = installFakeTty();
    try {
        let n = 1;
        ui.beginStatus(() => `Running ${n} tools`);
        ui.renderStatus(Date.now() + 1000, false);
        assert.match(vt.screen(), /Running 1 tools/);

        n = 2;
        ui.endStatus();
        ui.beginStatus(() => `Running ${n} tools`);
        ui.renderStatus(Date.now() + 1000, false);
        assert.match(vt.screen(), /Running 2 tools/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

// ═══════════════════════════════════════════════════════════════
// TTY contract
// ═══════════════════════════════════════════════════════════════

test("status is a no-op when stdout is not a TTY", () => {
    const vt = installFakeTty();
    try {
        (process.stdout as any).isTTY = false;

        ui.beginStatus("Pondering");
        ui.renderStatus(Date.now() + 5000, false);
        ui.updateStatus("Thinking");
        ui.endStatus();
        assert.equal(vt.screen(), "");
        // Every status entry point is inert without a TTY. The label is module
        // state shared across tests, so only the flags are asserted.
        const snap = ui.statusSnapshot();
        assert.equal(snap.active, false);
        assert.equal(snap.visible, false);

        // ...but streamed text still goes out.
        ui.writeStream("plain");
        ui.endStream();
        assert.equal(vt.screen(), "  plain");
    } finally {
        vt.restore();
    }
});

test("the status line is truncated to the terminal width", () => {
    const vt = installFakeTty(20);
    try {
        ui.beginStatus("A".repeat(200));
        ui.renderStatus(Date.now() + 1000, false);

        const line = vt.screen();
        assert.ok(line.length <= 18, `expected <= 18 columns, got ${line.length}: ${line}`);
        assert.match(line, /(?:\.{1,3}| {3}) +\(1s\)$/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("nothing is drawn into a terminal too narrow to hold a frame", () => {
    const vt = installFakeTty(8);
    try {
        ui.beginStatus("Pondering");
        ui.renderStatus(Date.now() + 1000, false);
        assert.equal(vt.screen(), "");
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("printThinkingDuration formats seconds and minutes", () => {
    const vt = installFakeTty();
    try {
        ui.printThinkingDuration(2400);
        ui.printThinkingDuration(75_000);
        assert.equal(vt.screen(), [
            "  Thought for 2s",
            "  Thought for 1m 15s",
        ].join("\n"));
    } finally {
        vt.restore();
    }
});

test("Thinking uses the white animated label instead of a spinner", () => {
    const vt = installFakeTty();
    try {
        ui.beginStatus("Thinking");
        ui.renderStatus(Date.now() + 1000, false);
        assert.match(vt.screen(), /^  Thinking(?:\.{1,3}| {3}) +\(1s\)$/);
    } finally {
        ui.endStatus();
        vt.restore();
    }
});

test("session footer stays compact and includes the active state", () => {
    const vt = installFakeTty();
    try {
        ui.printSessionStatus({ model: "claude-sonnet-4-6", effort: "high", contextPercent: 12.4, mode: "plan" });
        // Blank line above: the footer must not crowd the reply text.
        assert.deepEqual(vt.screen().split("\n"), [
            "",
            "  model: claude-sonnet-4-6 | effort: high | context: 12% | mode: plan",
        ]);
    } finally {
        vt.restore();
    }
});

test("a long model name gives way to the session state", () => {
    // A preset name is much longer than a model id, and the footer used to cut
    // the line from the right — which pushed effort, context and mode off it.
    const vt = installFakeTty(80);
    try {
        ui.printSessionStatus({ model: "deepseek-v4.1-flash-official", effort: "high", contextPercent: 12.4, mode: "plan" });
        const [blank, line] = vt.screen().split("\n");
        assert.equal(blank, "");
        assert.ok(line.length <= 79, `expected <= 79 columns, got ${line.length}: ${line}`);
        assert.match(line, /\.\.\./, "the name is what gets shortened");
        assert.match(line, /model: deepseek-v4\.1-flash/);
        assert.match(line, /mode: plan$/, "the live state survives");
    } finally {
        vt.restore();
    }
});

test("the model picker renders one option per line", () => {
    const rendered = ui.renderPickList([
        "mimo-v2.5", "mimo-v2.5-pro", "deepseek-v4.1-flash-official", "deepseek-v4.1-flash-volc",
    ], 2).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(rendered.length, 4);
    assert.deepEqual(rendered, [
        " mimo-v2.5 ",
        " mimo-v2.5-pro ",
        "[deepseek-v4.1-flash-official]",
        " deepseek-v4.1-flash-volc ",
    ]);
});

// ── ask_user ────────────────────────────────────────────────

test("the question head leaves the option list to the picker", () => {
    // The picker draws the choices itself, with a highlight. Numbering them
    // here as well would print the same list twice, and the static list has no
    // highlight to say which row Enter would take.
    const vt = installFakeTty();
    try {
        ui.printQuestionHead("Which storage layout?");
        const lines = vt.screen().split("\n");
        assert.match(lines[1], /\?.*Which storage layout\?/);
        assert.doesNotMatch(vt.screen(), /1\./, "no numbered duplicate list");
        assert.doesNotMatch(vt.screen(), /Press Enter to skip/, "the picker states its own keys");
    } finally {
        vt.restore();
    }
});

test("the typed question keeps its numbered options and skip hint", () => {
    const vt = installFakeTty();
    try {
        ui.printQuestion("Which storage layout?", ["per-project", "global"]);
        const screen = vt.screen();
        assert.match(screen, /1\. per-project/);
        assert.match(screen, /2\. global/);
        assert.match(screen, /Press Enter to skip without answering\./);
    } finally {
        vt.restore();
    }
});

test("a picked answer is echoed back", () => {
    // Selecting with the picker leaves the highlight on a row that the next
    // print overwrites, so without the echo the choice is invisible.
    const vt = installFakeTty();
    try {
        ui.printAnswer("global");
        assert.match(vt.screen(), /✓ global/);
    } finally {
        vt.restore();
    }
});

test("session footer omits unset effort and plain default mode", () => {
    const vt = installFakeTty();
    try {
        ui.printSessionStatus({ model: "mimo-v2.5", effort: "", contextPercent: 0.5, mode: "" });
        assert.deepEqual(vt.screen().split("\n"), ["", "  model: mimo-v2.5 | context: 0.5%"]);
    } finally {
        vt.restore();
    }
});
