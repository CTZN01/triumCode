import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, type Dirent } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, basename, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

// `deferred` marks a tool whose schema is withheld until the model asks for it
// by name. Stripped before sending — the API would reject the extra key.
export type ToolDef = Anthropic.Tool & { deferred?: boolean };

export const toolDefinitions: ToolDef[] = [
    {
        name: "read_file",
        description: "Read the contents of a file. Returns the file content with line numbers.",
        input_schema: {
            type: "object",
            properties: { file_path: { type: "string", description: "The path to the file to read" } },
            required: ["file_path"],
        }
    },
    {
        name: "write_file",
        description: "Write content to a file. Create the file if it does not exist, and overwrite it if it does. Returns a success message.",
        input_schema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "The path to the file to write" },
                content: { type: "string", description: "The content to write to the file" }
            },
            required: ["file_path", "content"],
        }
    },
    {
        name: "edit_file",
        description: "Edit a file by replacing an exact string. old_string must occur exactly once in the file — include enough surrounding context to make it unique. Returns the line that changed.",
        input_schema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "The path to the file to edit" },
                old_string: { type: "string", description: "The exact string to find. Must be unique in the file." },
                new_string: { type: "string", description: "The string to replace it with" },
            },
            required: ["file_path", "old_string", "new_string"],
        }
    },
    {
        name: "list_files",
        description: "List files under a directory, recursively. Returns paths relative to that directory, sorted, one per line; directories end with \"/\" and symlinks with \"@\". Does not descend into node_modules/.git/dist-style directories, and stops after 200 entries.",
        input_schema: {
            type: "object",
            properties: {
                directory_path: { type : "string", description: "The path to the directory to list files from" },
                max_depth: { type: "number", description: "How many directory levels to list below directory_path. 1 lists just its immediate contents. Defaults to 4, capped at 10." }
            },
            required: ["directory_path"],
        }
    },
    {
        name: "grep_search",
        description: "Search for a regex pattern in files. Recurses through a directory, or searches a single file. Returns matches as \"path:line: text\", one per line, with paths relative to the searched directory. Skips node_modules/.git/dist-style directories and binary files, stops after 100 matches, and clips very long lines.",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "The regex pattern to search for (JavaScript/RE2-flavoured, unanchored — it matches anywhere in the line)" },
                path: { type: "string", description: "The path to the directory or file to search in" }
            },
            required: ["pattern", "path"]
        }
    },
    {
        name: "run_command",
        description: "Run a program and return its exit code, stdout and stderr. There is NO shell: pipes, redirects, globs and \"&&\" are not interpreted, so pass the program in \"command\" and each argument in \"args\". A non-zero exit code is a normal result, not an error. Times out after 30s.",
        input_schema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The program to run, e.g. \"node\", \"git\", \"python3\"" },
                args: { type: "array", items: { type: "string" }, description: "Each argument as its own array element, e.g. [\"--version\"]" },
                cwd: { type: "string", description: "Working directory. Defaults to the current directory." }
            },
            required: ["command"]
        }
    },
    // Never deferred — it is the door the others are behind.
    {
        name: "tool_search",
        description: "Search for available tools by name or keyword. Returns full schema definitions for matching deferred tools so you can use them. Tools already in your tool list are never deferred and do not need searching.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Tool name or search keywords" }
            },
            required: ["query"]
        }
    }
]

// ─── Deferred tool activation ───────────────────────────────
// Every schema is re-read by the model on every request, so rarely-used tools
// are pure tax. A deferred tool leaves only its name behind (advertised via
// getDeferredToolNames); the model buys the schema back through tool_search,
// and activation is sticky, so it pays once.

const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
    activatedTools.clear();
}

// The array that actually goes to the API: un-activated deferred tools dropped,
// `deferred` flag stripped.
export function getActiveToolDefinitions(allTools: ToolDef[] = toolDefinitions): Anthropic.Tool[] {
    // tool_search only rides along when something is deferred — otherwise it
    // could only ever answer "no matching deferred tools found", at a cost to
    // every request. With nothing deferred, the array is returned unchanged.
    const anyDeferred = allTools.some((t) => t.deferred);

    return allTools
        .filter((t) => t.name !== "tool_search" || anyDeferred)
        .filter((t) => !t.deferred || activatedTools.has(t.name))
        .map(({ deferred, ...rest }) => rest);
}

// What the system prompt advertises: names are cheap, schemas are not.
export function getDeferredToolNames(allTools: ToolDef[] = toolDefinitions): string[] {
    return allTools
        .filter((t) => t.deferred && !activatedTools.has(t.name))
        .map((t) => t.name);
}

// Takes an explicit registry so a caller with its own deferred tools (MCP,
// skills) can route through here; executeTool uses the default.
export function toolSearch(query: string, allTools: ToolDef[] = toolDefinitions): string {
    // `.includes("")` is true of any string, so an empty query would activate
    // the whole registry off one malformed call.
    const needle = (query ?? "").trim().toLowerCase();
    if (needle === "") return "Error: query must not be empty. Pass a tool name or keywords.";

    const matches = allTools.filter((t) => t.deferred && (
        t.name.toLowerCase().includes(needle) ||
        (t.description ?? "").toLowerCase().includes(needle)
    ));

    if (matches.length === 0) {
        return `No deferred tools match "${query}". ${getDeferredToolNames(allTools).length} deferred tool(s) available — try a name or keyword.`;
    }

    for (const m of matches) activatedTools.add(m.name);

    // The API's own shape, so what the model reads is what it gets sent.
    return JSON.stringify(matches.map(({ deferred, ...rest }) => rest), null, 2);
}

// ─── Read-before-edit ───────────────────────────────────────
// Guards two failures: a blind edit (old_string written from memory of a state
// that was never current), and a stale overwrite (the user edited the file
// after we read it). The map is threaded in by the caller, not held here —
// "has this been read" is per-conversation, and two agents in one process must
// not license each other's writes.
export type ReadFileState = Map<string, number>;

function recordRead(absPath: string, state: ReadFileState): void {
    // Vanished between read and stat? Record nothing; the next write is a create.
    try { state.set(absPath, statSync(absPath).mtimeMs); } catch { /* raced with a delete */ }
}

// Null when the write may proceed, or the message to hand back to the model.
function staleWrite(absPath: string, verb: string, state: ReadFileState): string | null {
    // A file that does not exist yet has no state to be stale against.
    if (!existsSync(absPath)) return null;

    const seen = state.get(absPath);
    if (seen === undefined) {
        return `Error: You must read this file before ${verb} it. Use read_file first to see its current contents.`;
    }

    let current: number;
    try {
        current = statSync(absPath).mtimeMs;
    } catch (e: any) {
        return `Error: cannot stat ${absPath}: ${e.message}`;
    }

    // `!==`, not `<`: mtimes move backwards too (git checkout, editors that save
    // via temp-file-and-rename). Known limit: resolution is finite (~1ms here),
    // so an external edit landing in the same tick is invisible.
    if (current !== seen) {
        return `Warning: ${absPath} was modified externally since you last read it. Read it again before ${verb} it, so you are working from its current contents.`;
    }
    return null;
}

export async function executeTool(
    name: string,
    input: Record<string, any>,
    // Optional, so existing callers and blind-write scenarios still work. The
    // cost: forget to pass it and the guard is silently absent.
    readFileState?: ReadFileState,
): Promise<string> {
    let result: string;

    switch (name) {
        case "read_file": {
            result = readFile(input as { file_path: string });
            // A failed read must not arm the guard, or "read the wrong path,
            // then edit the right one" would sail through.
            if (readFileState && !result.startsWith("Error")) {
                recordRead(resolve(input.file_path), readFileState);
            }
            break;
        }
        case "write_file": {
            const absPath = resolve(input.file_path);
            if (readFileState) {
                const blocked = staleWrite(absPath, "writing", readFileState);
                if (blocked !== null) return blocked;
            }
            result = writeFile(input as { file_path: string, content: string });
            // Our own write is now the known state — no re-read needed.
            if (readFileState && !result.startsWith("Error")) {
                recordRead(absPath, readFileState);
            }
            break;
        }
        case "edit_file": {
            const absPath = resolve(input.file_path);
            if (readFileState) {
                const blocked = staleWrite(absPath, "editing", readFileState);
                if (blocked !== null) return blocked;
            }
            result = editFile(input as { file_path: string, old_string: string, new_string: string });
            if (readFileState && !result.startsWith("Error")) {
                recordRead(absPath, readFileState);
            }
            break;
        }
        case "list_files": result = listFiles(input as { directory_path: string, max_depth?: number }); break;
        case "grep_search": result = grepSearch(input as { pattern: string, path: string }); break;
        case "run_command": result = await runCommand(input as { command: string, args?: string[], cwd?: string }); break;
        case "tool_search": result = toolSearch(input.query as string); break;
        default: return `Unknown tool: ${name}`;
    }

    return result;
}

function readFile(input: { file_path: string }): string {
    try {
        const content = readFileSync(input.file_path, "utf-8");
        const lines = content.split("\n");
        return lines
            .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
            .join("\n");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }
}

// write_file is the one tool that can destroy existing work, so we make the
// write atomic: the bytes land in a sibling temp file first, and a rename puts
// them in place in one step. If we crash or the disk fills up mid-write, the
// original file is still intact instead of truncated.
function writeFile(input: {file_path: string, content: string}): string {
    const target = input.file_path;
    const dir = dirname(target);
    const tmp = join(dir, `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
        // mkdirSync already does nothing when the directory exists, so there is
        // no reason to existsSync() it first — that was a wasted stat per call.
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, input.content, "utf-8");
        renameSync(tmp, target);
        const lines = input.content.split("\n").length;
        const bytes = Buffer.byteLength(input.content, "utf-8");
        return `Successfully wrote ${target} (${lines} lines, ${bytes} bytes)`;
    } catch (e: any) {
        // Don't let a failed cleanup hide the real error.
        try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
        return `Error writing file: ${e.message}`;
    }
}

function editFile(input: { file_path: string; old_string: string; new_string: string }): string {
    if (input.old_string === "") return "Error: old_string must not be empty.";

    let content: string;
    try {
        content = readFileSync(input.file_path, "utf-8");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }

    let oldString = input.old_string;
    let newString = input.new_string;

    // The file on disk may be CRLF while the model wrote LF; without this, every
    // multi-line edit against a Windows checkout reports "not found".
    if (!oldString.includes("\r\n") && content.includes("\r\n")) {
        oldString = oldString.replace(/\r?\n/g, "\r\n");
        newString = newString.replace(/\r?\n/g, "\r\n");
    }

    if (oldString === newString) return "No change: old_string and new_string are identical.";

    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.file_path}.`;
    if (count > 1) {
        const lines = matchLines(content, oldString).join(", ");
        return `Error: old_string occurs ${count} times in ${input.file_path} (lines ${lines}). Include more surrounding context.`;
    }

    const line = content.slice(0, content.indexOf(oldString)).split("\n").length;
    // split/join, not String.replace: a "$&" in new_string would be substituted.
    const written = writeFile({ file_path: input.file_path, content: content.split(oldString).join(newString) });
    if (written.startsWith("Error")) return written;
    return `Edited ${input.file_path} at line ${line}`;
}

function matchLines(content: string, needle: string): number[] {
    const lines: number[] = [];
    for (let i = content.indexOf(needle); i !== -1 && lines.length < 5; i = content.indexOf(needle, i + needle.length)) {
        lines.push(content.slice(0, i).split("\n").length);
    }
    return lines;
}

// Directories that are almost never what the caller means and can hold tens of
// thousands of entries. We list the name but never walk into it, so the model
// can see it exists without paying for its contents. Naming one as
// directory_path still works: the root is pushed onto the stack directly.
const NOISE_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
    "target", "coverage", "__pycache__", ".venv", "venv", ".next", ".cache",
]);

// A tool result is pasted straight into the model's context window, so an
// unbounded listing is a context bomb rather than a helpful answer.
const LIST_LIMIT = 200;

// Depth is a soft bound, not the real guard — the entry cap is. Keep it generous,
// because a shallow walk fails silently (a directory at the boundary shows its
// name but not its contents), while a cap announces itself in the footer.
const clampDepth = (d: unknown, fallback: number): number =>
    Number.isFinite(d) ? Math.min(Math.max(Math.trunc(d as number), 1), 10) : fallback;

type WalkEntry = { abs: string; rel: string; kind: "file" | "dir" | "symlink" };

// The shared tree walk. list_files and grep_search need exactly the same
// traversal — same ignore list, same refusal to follow symlinks, same
// deterministic order — so they share one implementation rather than two that
// quietly drift apart. It is a generator so a caller that hits its cap can just
// stop pulling, instead of having the whole tree walked and the result sliced.
//
// Paths are yielded depth-first in sorted order, relative to `root` with forward
// slashes, so the output is the same on every platform.
function* walkTree(
    root: string,
    maxDepth: number,
    onSkipDir: (rel: string) => void,
    onUnreadable: (rel: string, why: string) => void,
): Generator<WalkEntry> {
    // An explicit stack, not recursion: a deep tree cannot blow the call stack.
    const stack: Array<[string, string, number]> = [[root, "", 0]];

    while (stack.length > 0) {
        const [dirAbs, prefix, depth] = stack.pop()!;

        let entries: Dirent[];
        try {
            // withFileTypes returns each entry's type as part of the directory
            // read itself, so we never stat a file just to find out it's a file.
            entries = readdirSync(dirAbs, { withFileTypes: true });
        } catch (e: any) {
            // One unreadable subdirectory must not sink the whole walk.
            onUnreadable(prefix || ".", e.code ?? e.message);
            continue;
        }

        // Deterministic order: the same tree always yields the same output, so
        // the model never sees phantom changes between two identical calls.
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        const descend: Array<[string, string, number]> = [];
        for (const entry of entries) {
            const abs = join(dirAbs, entry.name);
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

            if (entry.isSymbolicLink()) {
                // Reported but never followed: following can loop forever and
                // costs a stat to learn where it even points. This also matches
                // `grep -r`, which skips symlinks instead of recursing through them.
                yield { abs, rel, kind: "symlink" };
            } else if (entry.isDirectory()) {
                yield { abs, rel, kind: "dir" };
                if (NOISE_DIRS.has(entry.name)) { onSkipDir(rel); continue; }
                if (depth + 1 < maxDepth) descend.push([abs, rel, depth + 1]);
            } else {
                yield { abs, rel, kind: "file" };
            }
        }

        // Reverse-push so the stack pops them back in sorted order.
        for (let i = descend.length - 1; i >= 0; i--) stack.push(descend[i]);
    }
}

function listFiles(input: { directory_path: string; max_depth?: number }): string {
    const root = input.directory_path;

    let rootStat;
    try {
        rootStat = statSync(root);
    } catch (e: any) {
        return `Error listing files: ${e.message}`;
    }
    if (!rootStat.isDirectory()) {
        return `Error: ${root} is not a directory. Use read_file to read a file.`;
    }

    const maxDepth = clampDepth(input.max_depth, 4);

    const out: string[] = [];
    const notes: string[] = [];
    const ignored = new Set<string>();
    let truncated = false;

    for (const entry of walkTree(
        root,
        maxDepth,
        (rel) => ignored.add(rel),
        (rel, why) => notes.push(`unreadable ${rel}/ (${why})`),
    )) {
        if (out.length >= LIST_LIMIT) { truncated = true; break; }

        if (entry.kind === "dir") out.push(`${entry.rel}/`);
        else if (entry.kind === "symlink") out.push(`${entry.rel}@`);
        else out.push(entry.rel);
    }

    if (out.length === 0) return `No files found in ${root}.`;

    // Say what was left out. A silently incomplete listing is worse than a
    // truncated one, because the model assumes it saw everything.
    const footer: string[] = [];
    if (truncated) footer.push(`truncated at ${LIST_LIMIT} entries — narrow directory_path or lower max_depth`);
    if (ignored.size > 0) footer.push(`not descended into: ${[...ignored].sort().join(", ")}`);

    const extra = [...footer, ...notes];
    return extra.length === 0 ? out.join("\n"): `${out.join("\n")}\n\n${extra.map((line) => `(${line})`).join("\n")}`;
}

const GREP_MATCH_LIMIT = 100;
const GREP_MAX_DEPTH = 10;
const GREP_SCAN_CEILING = 1000;
const GREP_CHUNK_BYTES = 64 * 1024;
const GREP_LINE_WINDOW = GREP_CHUNK_BYTES;
const GREP_LINE_OVERLAP = 512;

type ScanResult = "done" | "stopped" | "unreadable";

function scanFile(abs: string, re: RegExp, onMatch: (lineNo: number, text: string) => boolean): ScanResult {
    let fd: number;
    try {
        fd = openSync(abs, "r");
    } catch {
        return "unreadable";
    }

    try {
        const decoder = new StringDecoder("utf-8");
        const buf = Buffer.allocUnsafe(GREP_CHUNK_BYTES);
        let pending = "";
        let lineNo = 0;
        let firstChunk = true;

        // State for the line being assembled. `hit`, `pre` and `head` only become
        // meaningful once a line outgrows the window and is dropped.
        let hit = false;    // pattern already seen on this line
        let pre = "";       // scanned tail of this line, kept for overlap
        let head = "";      // opening of an over-long line, kept for display

        const endLine = (text: string): boolean => {
            const display = head === "" ? text : head;
            const matched = hit || re.test(pre + text);
            lineNo++;
            hit = false; pre = ""; head = "";
            return matched && onMatch(lineNo, display);
        };

        for (;;) {
            const read = readSync(fd, buf, 0, buf.length, null);
            const last = read === 0;
            pending += decoder.write(buf.subarray(0, read));
            if (last) pending += decoder.end();

            // grep -I decides "binary" from the opening block, so we do too.
            if (firstChunk) {
                if (pending.includes("\0")) return "done";
                firstChunk = false;
            }

            // Index-walk instead of slicing a line off the front each time: the
            // slice-per-line version copies the rest of the chunk for every line
            // in it, which is quadratic on a file of many short lines.
            let start = 0;
            for (;;) {
                const nl = pending.indexOf("\n", start);
                if (nl === -1) break;
                const line = pending.slice(start, nl);
                start = nl + 1;
                if (endLine(line)) return "stopped";
            }
            pending = pending.slice(start);

            // A line with no newline in sight: scan what we have, then keep only
            // its tail. This is about bounding memory, not about the answer — a
            // match 200KB into a single-line file is still a match.
            if (pending.length > GREP_LINE_WINDOW) {
                if (re.test(pre + pending)) hit = true;
                pre = (pre + pending).slice(-GREP_LINE_OVERLAP);
                // +1 so the display clip kicks in and marks the line as cut.
                if (head === "") head = pending.slice(0, MAX_MATCH_CHARS + 1);
                pending = "";
            }

            if (last) break;
        }

        // A file that does not end in a newline still has a final line.
        if (pending !== "" || pre !== "") {
            if (endLine(pending)) return "stopped";
        }
        return "done";
    } finally {
        closeSync(fd);
    }
}

// One minified bundle can hold a million-character line; pasting that into the
// context window buries every other match. Clip each match to a single line.
const MAX_MATCH_CHARS = 400;

function formatMatch(relPath: string, lineNo: number, text: string): string {
    const clipped = text.length > MAX_MATCH_CHARS ? `${text.slice(0, MAX_MATCH_CHARS)}…` : text;
    return `${relPath}:${lineNo}:${clipped}`;
}

type Match = { file: string; line: number; text: string };

// Both backends funnel through here, so the model gets one shape regardless of
// which one ran. Sorting happens before the cap: grep and walkTree traverse in
// different orders, so without it the same query could report a different set of
// files on a machine with grep than on one without.
function renderMatches(matches: Match[], notes: string[], capped = false): string {
    matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

    const shown = matches.slice(0, GREP_MATCH_LIMIT);
    const body = shown.length === 0
        ? "No matches found."
        : shown.map((m) => formatMatch(m.file, m.line, m.text)).join("\n");

    const footer = [...notes];
    if (matches.length > shown.length) {
        // One noisy file — a lockfile, a log, a generated bundle — can eat the
        // whole budget and push every other file out of view. Left unsaid that
        // reads as "the pattern only occurs here", which is silently wrong.
        const perFile = new Map<string, number>();
        for (const m of shown) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
        const [topFile, topCount] = [...perFile].sort((a, b) => b[1] - a[1])[0];
        const culprit = topCount > shown.length / 2 ? `, ${topCount} of them from ${topFile}` : "";
        // "+" only when the total is a lower bound, so a complete count is not
        // hedged into looking uncertain.
        const atLeast = capped ? "+" : "";
        footer.unshift(`showing ${shown.length} of ${matches.length}${atLeast} matches${culprit} — narrow the path or the pattern`);
    }

    return footer.length === 0 ? body : `${body}\n\n${footer.map((line) => `(${line})`).join("\n")}`;
}

// grep_search is the mirror image of list_files: same tree, but you read the
// leaves instead of walking the branches.
function grepSearch(input: { pattern: string; path: string }): string {
    // Validate the regex once, here. A bad pattern should be a clean error from
    // the tool, not a cryptic failure from whichever backend happened to run.
    let re: RegExp;
    try {
        re = new RegExp(input.pattern);
    } catch (e: any) {
        return `Error: invalid regex: ${e.message}`;
    }

    let stat;
    try {
        stat = statSync(input.path);
    } catch (e: any) {
        return `Error searching: ${e.message}`;
    }

    // Search from the target's parent directory, so every reported path is
    // relative. Absolute Windows paths would put a drive-letter colon inside the
    // "path:line:" framing and make the output ambiguous to parse.
    const isFile = !stat.isDirectory();
    const root = isFile ? dirname(input.path) : input.path;
    const operand = isFile ? basename(input.path) : ".";

    // System grep when we have it: it is C, it is benchmarked to death, and it
    // handles files far larger than we are willing to buffer.
    const viaSystem = grepWithSystemGrep(input.pattern, root, operand);
    if (typeof viaSystem === "string") return viaSystem;
    if (viaSystem !== null) return renderMatches(viaSystem, []);

    const { matches, notes, capped } = grepInProcess(re, root, operand, isFile);
    return renderMatches(matches, notes, capped);
}

// Returns the matches, a finished message (error / no matches), or null when
// there is no usable system grep and the caller should fall back.
function grepWithSystemGrep(pattern: string, root: string, operand: string): Match[] | string | null {
    // -I (--binary-files=without-match) skips binaries instead of dumping them
    // into the context window. --exclude-dir keeps the walk out of the same
    // directories list_files refuses to enter — without it grep -r cheerfully
    // walks all of node_modules, which is the single biggest cost in this tool.
    // -H forces the filename prefix even for a single-file search, where grep
    // would otherwise print a bare "12:content" and we would lose the path.
    const args = ["--line-number", "--with-filename", "--color=never", "--recursive", "-I"];
    for (const dir of NOISE_DIRS) args.push(`--exclude-dir=${dir}`);
    // Leading "--" so a pattern starting with "-" is not read as a flag.
    args.push("--", pattern, operand);

    let out: string;
    try {
        out = execFileSync("grep", args, {
            cwd: root,
            encoding: "utf-8",
            maxBuffer: 8 * 1024 * 1024,
            timeout: 10_000,
            // execFileSync with an argument array never goes through a shell, so
            // pattern, path and filenames cannot be interpreted as shell syntax.
            // stderr is dropped: we branch on the exit status instead.
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (e: any) {
        if (e.code === "ENOENT") return null;               // no grep on this box
        if (e.status === 1) return "No matches found.";     // grep's "no matches" exit
        if (e.code === "ETIMEDOUT") return `Error: search timed out after 10s — narrow the path or the pattern.`;
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            return `Too many matches (over 8MB) — narrow the path or the pattern.`;
        }
        return `Error searching: ${e.message}`;
    }

    const matches: Match[] = [];
    let unparsed = 0;
    for (const raw of out.split("\n")) {
        if (raw === "") continue;
        // Re-frame into the shape both backends share.
        const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(raw);
        if (m) matches.push({ file: m[1].replace(/^\.\//, ""), line: Number(m[2]), text: m[3] });
        else unparsed++;   // a filename containing ":", in practice never
    }

    // Report lines we could not frame rather than dropping them on the floor.
    return unparsed === 0 ? matches : renderMatches(matches, [`could not parse ${unparsed} line(s) of grep output`]);
}

// The fallback for machines without grep — stock Windows, mostly. It is
// deliberately costlier per byte than grep and says so in the footer, because the
// honest signal is "this was slower and here is why", not a result that looks
// identical while quietly skipping files.
function grepInProcess(re: RegExp, root: string, operand: string, isFile: boolean): { matches: Match[]; notes: string[]; capped: boolean } {
    const matches: Match[] = [];
    const notes: string[] = [];
    const unreadableDirs: string[] = [];
    let unreadableFiles = 0;
    let capped = false;

    const candidates = isFile
        ? [{ abs: join(root, operand), rel: operand, kind: "file" as const }]
        : walkTree(root, GREP_MAX_DEPTH, () => {}, (rel, why) => unreadableDirs.push(`unreadable ${rel}/ (${why})`));

    for (const entry of candidates) {
        // Symlinks are skipped, matching `grep -r`, which does not recurse
        // through them either.
        if (entry.kind !== "file") continue;

        const result = scanFile(entry.abs, re, (lineNo, text) => {
            matches.push({ file: entry.rel, line: lineNo, text });
            // Stopping bounds the work at the cost of knowing the exact total;
            // renderMatches marks the count as a lower bound when this trips.
            return matches.length >= GREP_SCAN_CEILING;
        });

        if (result === "unreadable") {
            // Raced with a delete, or no permission. Unlike a binary file this
            // one *could* have matched, so it gets reported.
            unreadableFiles++;
        } else if (result === "stopped") {
            capped = true;
            break;
        }
    }

    if (unreadableFiles > 0) notes.push(`could not read ${unreadableFiles} file(s)`);
    notes.push(...unreadableDirs);

    return { matches, notes, capped };
}

const RUN_TIMEOUT_MS = 30_000;

// A command that prints forever would otherwise fill the heap and the context
// window with the same bytes. We keep the head of each stream and keep counting
// the rest, so the footer can still say how much was thrown away.
const RUN_MAX_CHARS = 30_000;

// Killing the direct child is not enough: npm spawns node, make spawns cc, and
// the grandchildren outlive their parent. On POSIX the child gets its own
// process group so the whole group can be signalled; Windows has no equivalent
// reachable from Node, so taskkill walks the tree instead.
function killTree(child: ChildProcess): void {
    if (child.pid === undefined) return;    // never actually started
    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch { /* already gone */ }
    } else {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch { /* already gone */ }
    }
}

// A missing executable is the most common way this tool fails, and the cause is
// usually structural rather than a typo, so the message says what to do instead.
function noExecutable(command: string, args: string[]): string {
    const hints: string[] = [];
    if (args.length === 0 && /\s/.test(command)) {
        hints.push(`"${command}" contains a space — put the program in "command" and each argument in "args".`);
    }
    if (process.platform === "win32") {
        hints.push(
            "This tool runs programs directly, without a shell, so Windows .cmd/.bat shims " +
            "(npm, npx, yarn, tsc, ...) cannot be launched. Invoke the underlying program with " +
            "\"node\" instead — command \"node\", args [\"node_modules/<pkg>/bin/<entry>.js\", ...]."
        );
    }
    return [`Error: no such executable: ${command}`, ...hints].join("\n");
}

// run_command is the one tool that runs arbitrary code, so its safety property is
// structural rather than a list of banned strings: there is no shell. The program
// and each argument go to the OS as a vector, so a ";" or a "|" inside an argument
// is a byte in a filename and never a second command. That is what the split
// between `command` and `args` in the schema is for — and why shell pipelines
// genuinely do not work here.
//
// Which commands are *allowed* is not this function's business. That is policy,
// and it belongs in the agent loop's permission gate (see steps/canonical/ts/
// permissions.ts), where it can see the mode and the user's answers.
function runCommand(input: { command: string; args?: string[]; cwd?: string }): Promise<string> {
    // Coerced rather than rejected: a number in the args array is a slip, not a
    // reason to fail the whole call.
    const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];

    return new Promise<string>((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(input.command, args, {
                cwd: input.cwd || process.cwd(),
                shell: false,                                       // the whole point
                detached: process.platform !== "win32",             // so killTree can reach descendants
                // stdin is /dev/null, so a program that reads it gets EOF and
                // exits instead of hanging until the timeout. Which is the real
                // hazard: `cat` with a pipe would stall for 30s and look hung.
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch (e: any) {
            resolve(`Error running ${input.command}: ${e.message}`);
            return;
        }

        const started = Date.now();
        const outDecoder = new StringDecoder("utf-8");
        const errDecoder = new StringDecoder("utf-8");
        let out = "";
        let err = "";
        let outBytes = 0;
        let errBytes = 0;
        let clippedOut = false;
        let clippedErr = false;
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, RUN_TIMEOUT_MS);

        const finish = (result: string): void => {
            if (settled) return;        // "error" and "close" can both fire
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        const capture = (chunk: Buffer, decoder: StringDecoder, stream: "out" | "err"): void => {
            const text = decoder.write(chunk);
            if (stream === "out") {
                outBytes += chunk.length;
                if (out.length < RUN_MAX_CHARS) out += text; else clippedOut = true;
            } else {
                errBytes += chunk.length;
                if (err.length < RUN_MAX_CHARS) err += text; else clippedErr = true;
            }
        };

        child.stdout?.on("data", (c: Buffer) => capture(c, outDecoder, "out"));
        child.stderr?.on("data", (c: Buffer) => capture(c, errDecoder, "err"));

        child.on("error", (e: any) => {
            if (e.code === "ENOENT" || (process.platform === "win32" && e.code === "EINVAL")) {
                finish(noExecutable(input.command, args));
                return;
            }
            finish(`Error running ${input.command}: ${e.message}`);
        });

        child.on("close", (code, signal) => {
            // Flush the decoders, then cut to the cap exactly: appending whole
            // chunks overshoots it, and a footer that says "30000 chars" while
            // showing 30006 is a small lie the reader has no way to check.
            out = (out + outDecoder.end()).slice(0, RUN_MAX_CHARS);
            err = (err + errDecoder.end()).slice(0, RUN_MAX_CHARS);

            const status = timedOut
                ? `timed out after ${RUN_TIMEOUT_MS / 1000}s — killed`
                : signal !== null
                    ? `killed by ${signal}`
                    : `exit ${code}`;

            const body: string[] = [];
            if (out.trim() !== "") body.push(out.trimEnd());
            if (err.trim() !== "") body.push(`stderr:\n${err.trimEnd()}`);
            if (body.length === 0) body.push("(no output)");

            const footer: string[] = [];
            if (clippedOut) footer.push(`stdout truncated at ${RUN_MAX_CHARS} chars (${outBytes} bytes total)`);
            if (clippedErr) footer.push(`stderr truncated at ${RUN_MAX_CHARS} chars (${errBytes} bytes total)`);

            // The exit code leads, because it is the thing the model acts on, and
            // a non-zero exit is reported as a result rather than as an "Error:" —
            // a failing test run is information, and dressing it up as a tool
            // failure would make the model retry instead of read.
            const text = `${status} · ${Date.now() - started}ms\n${body.join("\n\n")}`;
            finish(footer.length === 0 ? text : `${text}\n\n${footer.map((l) => `(${l})`).join("\n")}`);
        });
    });
}
