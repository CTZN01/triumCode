# TriumCode

A terminal-based coding agent built on the Anthropic SDK. It reads files, edits code, searches a repository, and runs commands through natural-language conversation.

TriumCode supports three API protocols, so it can connect to Anthropic directly or through a model gateway that serves `/messages`, `/chat/completions`, or `/responses`.

## Features

- **Parallel tool execution during streaming** — a tool begins executing as soon as its `tool_use` block is complete, without waiting for the response to finish.
- **Sub-agents** — delegate a broad search or a whole side task to an agent with its own isolated context, and get back only its summary.
- **Three API protocols** — `anthropic`, `openai-chat`, and `openai-responses`, selected per model.
- **Prompt cache–aware context management** — a single cacheable system block, volatile context moved to a per-turn reminder, and a tool-output budget that trims in one pass so the cached prefix stays stable.
- **Persistent memory** — file-based, with project and user layers, semantic recall, and keyword fallback.
- **Permission modes** — `default`, `plan`, `acceptEdits`, `yolo`, and `dontAsk`, plus `allow`/`deny` rules in `settings.json`.
- **Per-project session storage** — the same session list is visible from any subdirectory of a project.
- **Streaming Markdown rendering** — headings, lists, and inline bold or code render as they arrive.

## Requirements

- Node.js 20 or later
- An API key for Anthropic, or for a compatible gateway

## Desktop preview

This repository also contains a Windows-first Electron desktop alpha. It reuses
the same Agent and tools as the CLI. The alpha includes local workspaces,
workspace-scoped conversations, streamed replies, collapsible tool activity in the chat, approval
cards that identify the default policy or matching user/project rule and record
approval outcomes in activity, stop/cancel, model settings, per-run code review, Git status,
staged/unstaged file diffs with old/new line numbers and collapsible hunks,
selected-file stage/unstage actions, commits that contain staged content only,
and a workspace-bound Windows PowerShell terminal. Creating a commit can run
the repository's local Git hooks.
User-question activity records answered, skipped, expired, and cancelled
outcomes without saving the answer text. Choice questions also offer Skip.
When an API key changes during an open conversation, later visible events and
saved session copies redact both the previous and current keys.
Deleting a conversation removes its saved session and desktop review snapshots;
project files and saved API keys remain. The app reports if review cleanup fails.
New worktrees can start from a local branch, an existing remote-tracking branch,
a tag, or a commit. The branch suggestions do not fetch from remotes.
Closing the window with a running task or open terminal asks whether to stop
them or stay in the app. Exit waits for task cancellation and PowerShell's exit
event; if the shell does not exit, the app reports the failure and stays open.
The global task center aggregates recent tasks across saved workspaces, supports
search and jumps to a session's latest activity, and can stop runs owned by the
current desktop process. Tasks owned by another CLI or desktop process can only
be viewed and refreshed here; their persisted state distinguishes waiting for
approval or a user answer from active work without allowing this window to
resolve or stop a run it does not own.
The desktop settings page controls the concurrent-run limit (1–8, default 3).
When the limit is reached, the draft stays in the composer and the app explains
that a running task must finish before retrying.
Named model presets from the CLI config can be selected in desktop settings.
The composer offers model-preset and reasoning-effort choices for the current
conversation; they apply to its next request and persist after restart. Model and
effort changes are unavailable while a request is running. Settings has a separate Appearance section with System, Light,
and Dark choices. The context-window field accepts exact token counts such as
1,000,000.
The composer groups model selection with a five-step reasoning slider on the right.
On the left, it offers per-conversation permission choices (confirm operations,
accept file edits, or full access without approval except explicit deny rules).
A permission change applies immediately, including while a task is running, and
takes effect for the operations that follow; it persists after restart.
While the Agent runs, the composer remains editable and accepts attachments.
Enter or the send button interrupts the current task and continues in the same
conversation with the new request; Shift+Enter inserts a newline, and IME
confirmation does not send. Stop remains a separate action. A handoff waits for
dispatched tools and session saving to finish, preserves completed changes and
tool results, and never runs two turns in the workspace together. Stop during
handoff cancels the pending follow-up and restores its draft. Invalid attachments
are rejected before interrupting the current task. Conversations running in
another process cannot be interrupted from this window. Each follow-up is one
new user message and one normal model request; the static system prompt and
existing history prefix stay unchanged.
The composer accepts up to eight attachments per message through image paste (Ctrl+V),
drag and drop, or the file picker. Ordinary text paste works as usual. Images show
removable thumbnails; click a draft or sent thumbnail to view the original image.
PNG, JPG/JPEG and WebP are supported. Original images are limited to 20 MiB;
a separate model copy is scaled to at most 1568 pixels per edge and about 1.2 megapixels,
and limited to 4 MiB. The original is preserved. All three protocols send actual visual
inputs, so the selected model/gateway must support images.
Code, text, logs, JSON and Markdown remain local file references; project files are
neither copied nor inserted into the message. The Agent searches and reads relevant
line ranges on demand.
Read/search access to explicitly attached external text files is limited to those
exact files; adding an attachment does not grant write access outside the workspace.
PDF and Office attachments currently send references with an explicit notice;
there is no built-in document parser or provider file upload.
Sessions store attachment metadata, never image base64. Image snapshots and their
model copies stay fixed across retries and reopening a conversation, keeping history
prefixes stable. Image inputs still consume visual tokens; thumbnails never enter
model context, and attachments do not change the static system prompt. Removing a
draft cleans up its managed copies, abandoned drafts expire after 24 hours when the
conversation is opened, and deleting a conversation removes its owned attachments
without deleting referenced source files. Missing files, invalid images and rejected
vision requests report errors.
For tasks that need tools, the Agent first sends a brief progress message before calling them.
The active Agent status and concise progress updates appear in the conversation while a task runs, with
`thinking` shown during model reasoning. The same status indicator stays mounted from startup through streaming and tool execution, with a continuous left-to-right highlight that respects reduced-motion preferences. Recent tool calls appear between progress messages with their original tool names and file, pattern, or command arguments in muted text. Completed edits show green additions and red deletions; expand edit_file or multi_edit to view the fixed diff captured from that call's actual before/after contents, including its net line counts and colored code. Each multi_edit shows the whole batch's net changes. Expanded edits use compact file cards with syntax highlighting, one line-number gutter, red/green change rows, and a copy button; raw arguments, output, and permission details are folded under Call details. Records without a historical patch can show the tool's saved, highlighted post-edit snippet, clearly labeled as a snippet. Later edits, staging, and commits do not alter this history; old records without a captured patch say so explicitly. Patches stay with the latest 200 saved activity records, are limited to 64 KiB each, and do not enter model context. The right panel separately shows cumulative run and current Git changes, respecting Git's configured line-ending handling. Expand the list for older calls and each call for approval details. The
conversation menu provides Rename and Delete actions. Settings has Appearance,
current-conversation Usage, and Model sections; Appearance includes a saved
interface text-size choice. Usage is based on tokens reported by the model
and does not represent the provider account's remaining quota.
Opening a conversation loads its latest 40 visible messages and starts at the
newest message; scroll upward or
use Load earlier messages to fetch older history. Returning to the bottom keeps
only recent messages in the view; earlier messages still present in the session
can be fetched again. The
desktop process also releases older idle conversation runtimes as more sessions
are opened; the visible conversation and running tasks remain loaded.
Each preset and the custom route has its own protected API key slot. A
conversation keeps its selected model route and reasoning settings. Changing
global preferences applies to new conversations; the composer changes the current
conversation only when selected explicitly. The saved route snapshot never contains an
API key.
The short connection test reports whether a failure points to credentials,
rate limits, network access, the model route, or a timeout, without showing
raw provider error text.
The desktop rejects a base URL containing credentials, query parameters, or a
fragment; enter the API key in its protected field. Editing a route or key
clears the previous connection-test result until it is tested again.
Desktop tool activity and newly saved conversation history replace occurrences
of the active provider key when it is at least eight characters long.
The desktop restores the main window's size and position and panel widths. Its
neutral light and dark themes follow the system appearance by default, including
changes while the app is open; you can also choose either theme in Settings. Drag
either vertical divider to resize the workspace sidebar or
inspector; keyboard users can focus a divider and adjust it with the arrow keys.
The button in the title bar collapses or restores the inspector to give the
conversation more room. Its state is saved across app restarts, and reopening it
keeps the previously selected tab. Large diffs scroll inside the inspector while
the conversation composer stays visible.
The context usage popover uses distinct color markers for each token metric.
The changes panel colors file status letters by Git status and shows diff hunk
headers in a muted GitHub-style palette.
Click the branch name in the title bar to open a compact popover for switching
between local branches or creating a new branch. Git Graph opens a larger window
with the latest 100 local commits; selecting one shows its full message and file
summary. The branch popover stays neutral; graph lines follow actual commit parent
links, with color marking branch lanes. The commit list fills the window until a
commit is selected; its detail pane can be closed to restore that space. Click outside the popover or press
Escape to close it. Switching to an existing branch requires a clean worktree;
creating a branch carries local edits into it. Managed isolated worktrees keep
their assigned branch. The terminal and
right inspector open and close with a short motion that respects reduced-motion
settings. Resizing follows the pointer directly and settles without an animation.
Code block headers use the interface font, while code stays monospaced.
Common actions expose the visible `Ctrl+N` / `Ctrl+,` shortcuts on Windows and
their `Command` equivalents on macOS. Inspector and review tabs support arrow,
Home, and End navigation; modal dialogs keep keyboard focus inside, restore it when
closed, and close with Escape. Approval actions, file selection, and collapsible
diff hunks remain reachable by keyboard and expose their selected or status
labels to assistive technology.
For a failed task, the last request can be restored to the composer for review
and editing. Sending it appends a new user message; the app does not replay the
failed run automatically because completed file and command side effects may
remain in the workspace.
Turn failures identify network, authentication, rate-limit, provider/protocol,
or internal errors and suggest the next configuration or recovery step. A safe
retry is available only when a transient failure happened before any tool was
started; it reuses the existing request without adding another visible user
message. After a tool starts, review the workspace and restore the request as a
new message instead.
The workspace sidebar can create an isolated Git worktree from a selected
branch or commit. If the source workspace has uncommitted changes, the user must
confirm that those changes will not be copied. The worktree review dialog shows
the baseline diff and dirty state, merges only a clean worktree into the
original source branch, and directs conflict resolution to the source terminal.
Removing a worktree is blocked while it has uncommitted changes; its branch is
kept by default, and Git must confirm a branch is merged before it can be
deleted. Runtime acceptance is still outstanding.
If saving the desktop worktree association fails after Git creates the worktree,
the app attempts to remove the empty worktree and restore the source workspace;
if cleanup cannot finish, the error identifies the path and branch to recover.
Command approvals explain that programs can still access files outside the
workspace or use the network; approval is not an OS-level sandbox.
While the review panel is open, workspace file changes refresh its Git and
per-run review state automatically.
Review marks Git changes that existed before a task and can restore captured
file versions after a second confirmation and a current-version check. For
non-Git folders it reviews Agent file-tool writes; files changed directly by
shell commands cannot be attributed there. In Git projects, visible command
diffs are listed, but changes hidden by ignore rules or committed during a run
cannot be fully attributed. Review snapshots stay in Electron's
local user-data folder and retain up to 20 completed runs per workspace. Files
over 2 MiB or snapshots over 8 MiB per run may be excluded from restore. This
is not a complete desktop MVP: runtime and recovery acceptance, an OS-level
process sandbox, a signed installer, and an update path are still outstanding.
Delivery is prioritized as a Windows x64 portable preview, followed by the
reliability, task workflow, trust, and supported-release milestones in the
[desktop roadmap](docs/desktop-roadmap.md). Task center, concurrent runs,
worktrees, and Git write actions in the preview branch remain experimental
until Windows and multi-process acceptance is recorded. The full requirements
remain in the [desktop product specification](docs/desktop-plan.md).

Desktop dependency installation, development, and packaging require Node.js
22.12 or later. The CLI continues to support Node.js 20:

```bash
npm run desktop:dev
npm run desktop:build
npm run desktop:preview
npm run desktop:package # creates a Windows x64 portable zip under out/desktop-release
```

The portable app does not need Node.js at runtime. It supports Windows x64 only
and currently has no installer, code signing, or automatic updates. Packaging
downloads locked production dependencies. Extract the archive with Windows
Explorer and run `TriumCode.exe`. Removing the extracted folder does not remove
desktop settings and protected credentials from `%APPDATA%\triumcode`, or project
sessions from the TriumCode session directory.

For a fresh development checkout, install dependencies with Node.js 22.12 or
later, then run `npm run desktop:setup` once to download the matching Electron
runtime. `npm run desktop:dev` also checks and installs that runtime before
opening the app.

The CLI commands above remain available. Existing CLI credentials are not
copied automatically; the desktop settings page can import them into the
operating system's protected credential store. API keys are not returned to
the renderer. A key saved in `desktop:dev` is reused after restart and by the
portable app under the same Windows profile. If no credential is ready, the
desktop points to setup and keeps the draft without starting a request. Desktop
settings and workspace recents live in `%APPDATA%\triumcode`; conversation files stay in the existing local TriumCode
session store, including a bounded history of desktop tool and sub-agent
activity that remains visible when a conversation is reopened. Tool activity
shows explicit completed, failed, denied, or cancelled states alongside its
result, which can be copied from its inline activity details. The right panel
contains code review and conversation details. Session grants
you explicitly approve are saved with that conversation and remain active
after restart; only an exact tool call with matching parameters is allowed.
You can revoke a grant from conversation details. Revocation blocks future
matching calls but does not stop a process that has already started. Code review
preimages are encrypted with the operating system's protected storage so files
can be restored after a task ends; older snapshots are pruned after the most
recent 20 completed runs per workspace.
The conversation details show an estimate of context use and remaining usable window for the
last request. Input, output, and cache token totals appear only when the
provider actually reports those fields. Automatic context compaction is recorded
in the activity timeline. Context figures are local estimates, not exact
provider metering or account quota. If a saved conversation has output tokens
but no usable prompt totals, the desktop shows prompt and cache usage as
unavailable; older missing totals cannot be reconstructed.
Desktop conversation messages render Markdown tables and HTTPS links. The main
process asks before opening an external link in the default browser.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# Start an interactive session
node dist/cli.js

# Run a single prompt and exit
node dist/cli.js "read src/agent.ts and summarize what it does"

# Continue the most recent session in this project
node dist/cli.js --continue

# Resume a specific session by ID prefix
node dist/cli.js --resume a3f8

# Force a new session, leaving saved sessions untouched
node dist/cli.js --new

# List all saved sessions
node dist/cli.js --sessions
```

On first launch, TriumCode prompts for an API key, base URL, model, and protocol, then writes them to `~/.triumcode/config.json`. Environment variables and `.env` files are not required.

### Session selection

At most one of `--continue`, `--resume`, and `--new` may be specified per
invocation. Supplying two or more is rejected rather than resolved by
precedence.

## Configuration

### Precedence

Configuration is resolved per field, from the following sources in descending
priority:

| Priority | Source | Example |
|----------|--------|---------|
| 1 | Command-line flags | `--api-key sk-ant-xxx --model claude-sonnet-4` |
| 2 | `~/.triumcode/config.json` | Written by first-run setup |
| 3 | Environment variables | `ANTHROPIC_API_KEY=sk-ant-xxx` |
| 4 | Built-in defaults | `https://api.anthropic.com` |

Because resolution is per field, a config file that sets only the API key still
picks up `ANTHROPIC_BASE_URL` from the environment.

The saved configuration deliberately outranks environment variables: an
endpoint entered during first-run setup should not be silently redirected by a
leftover export. Use command-line flags to override for a single run or in CI.

If a lower-priority source holds a different value than the winner, startup
prints an **Overridden** report identifying it. The `/config` command displays
the same table together with the origin of each field.

### Command-line options

```
--api-key KEY       API key
--api-base URL      API base URL. Defaults to https://api.anthropic.com, which
                    is valid only for the anthropic protocol; the OpenAI
                    protocols require the gateway's own URL
--model, -m         Model name (default: claude-sonnet-4-20250514)
--protocol NAME     Protocol: anthropic | openai-chat | openai-responses
--auth SCHEME       Key transport: api-key (x-api-key) | bearer (Authorization)
--thinking          Enable extended thinking (enabled by default)
--no-thinking       Disable extended thinking for this session
--effort LEVEL      Thinking depth: low | medium | high | xhigh | max
                    (default: high; also adjustable with /effort)
--resume [id]       Resume the most recent session, or a specific one by ID prefix
--continue          Resume the most recent session in this project (equivalent
                    to a bare --resume)
--new               Start a new session, leaving saved sessions untouched. This
                    is the default; --continue and --resume override it
--sessions          List all sessions and exit
--yolo, -y          Skip ordinary confirmation prompts (configured deny rules
                    still apply)
--plan              Plan mode: read-only, no edits
--accept-edits      Auto-approve file writes and edits; other actions still prompt
--dont-ask          Auto-deny any action that would have prompted
--max-turns N       Stop after N agent-loop turns
--max-tokens N      Maximum output tokens per request (default: 32000).
                    Thinking counts towards this limit
--context-window N  Context window size in tokens; k/M suffixes are accepted
                    (200k, 1M)
--help, -h          Show help
```

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | API key | _(none — required)_ |
| `ANTHROPIC_BASE_URL` | API endpoint | `https://api.anthropic.com` |
| `TRIUMCODE_MODEL` | Default model | `claude-sonnet-4-20250514` |
| `TRIUMCODE_PROTOCOL` | Protocol | `anthropic` |
| `TRIUMCODE_AUTH` | Key transport | derived from the protocol |
| `TRIUMCODE_EFFORT` | Thinking depth | `high` |
| `TRIUMCODE_CONTEXT_WINDOW` | Context window size in tokens | `200000` |

`MINI_MODEL` and `MINI_CONTEXT_WINDOW` are deprecated aliases for the last two.
They still resolve, as a second choice behind the `TRIUMCODE_*` spelling. A
variable that fails to resolve does so silently: a lost context window only
manifests as history being compressed earlier than the model requires. A
deprecated variable that wins its field is reported once at startup.

The auxiliary model used for memory recall reads `TRIUMCODE_MODEL` as well, so
pointing it at a smaller model reduces recall cost.

### Configuration file

```json
{
  "apiKey": "sk-ant-...",
  "apiBase": "https://api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "protocol": "anthropic",
  "thinking": true,
  "effort": "high",
  "contextWindow": "200k",
  "models": {
    "deep":  { "model": "deepseek-v4", "apiBase": "https://gateway.example/v1", "protocol": "openai-chat", "contextWindow": "128k" },
    "gpt":   { "model": "gpt-5-luna",  "apiBase": "https://gateway.example/v1", "protocol": "openai-responses", "contextWindow": "200k" },
    "mimin": { "model": "minimax-m3",  "apiBase": "https://gateway.example/v1", "protocol": "anthropic", "auth": "api-key" }
  }
}
```

`contextWindow` accepts either a plain token count or a size suffix (`200k`,
`1M`). Every field except `models` can be overridden by a command-line flag.

## Model protocols

TriumCode supports three protocols because a model gateway routes each of its
models through whichever API that model's upstream exposes. A base URL alone is
insufficient; the protocol must also be specified.

| Protocol | Path appended | Typical models behind a gateway |
|----------|---------------|---------------------------------|
| `anthropic` | `/v1/messages` | Claude, MiniMax, Qwen |
| `openai-chat` | `/v1/chat/completions` | DeepSeek, GLM, Kimi, MiMo |
| `openai-responses` | `/v1/responses` | GPT, Grok |

Conversation history is stored internally in Anthropic's message format, so
session persistence, context compression, and memory recall behave identically
on every protocol. If a gateway rejects an optional parameter (`thinking`,
`effort`, `stream_options`, `reasoning`), it is detected on the first HTTP 400
and omitted for the remainder of the session.

```bash
# Run against a gateway
triumcode --api-base https://gateway.example/v1 \
          --protocol openai-chat --model deepseek-v4 "refactor src/tools.ts"
```

Named presets in `~/.triumcode/config.json` carry the protocol, so `/model`
switches backend and protocol in a single step.

`--api-base` accepts the URL as printed in vendor documentation, including the
`/v1` suffix: the version segment is normalized away and each protocol appends
its own path. The `https://api.anthropic.com` default belongs to the anthropic
protocol; the OpenAI protocols have no sensible default and require the
gateway's URL. The `auth` field is needed only when a gateway expects the key
in a different form than its protocol implies — `bearer` sends
`Authorization: Bearer`, and `api-key` sends `x-api-key`.

Switching by preset name retains that name as the session's route identity, so
two presets serving the same model string through different gateways remain
distinguishable. Switching by raw model ID clears it, since the ID is then the
only accurate description of what is being served.

## Reasoning

Extended thinking is enabled by default, and depth is controlled by `effort`
(`low` through `max`, default `high`). Both can be changed mid-session:

```
/effort            # arrow-key picker over low..max
/effort xhigh
/thinking off
```

Two request forms exist upstream, and selecting the wrong one produces an HTTP
400:

- `{ thinking: { type: "adaptive" } }` — current models. No token budget; depth
  is controlled by `output_config.effort`.
- `{ thinking: { type: "enabled", budget_tokens: N } }` — models prior to 4.6
  (Haiku 4.5 and earlier), where `budget_tokens` is required.

The required form cannot be derived reliably from a model name, so an
unrecognized model is never rejected outright: the built-in model lists only
determine whether thinking is enabled automatically. `--thinking` always forces
it on. If an endpoint rejects the parameters, the agent omits them for the
remainder of the session rather than failing the turn.

Thinking blocks are the model's private reasoning and are not retained. Their
duration is measured so the interface can report it, and they are discarded
before the turn is written to history.

## Permissions

Every tool call is evaluated against a mode and, optionally, a set of rules.

| Mode | Flag | Behavior |
|------|------|----------|
| `default` | _(none)_ | Read-only tools and memory operations are permitted; dangerous commands prompt |
| `plan` | `--plan` / `/plan` | Read-only. Only the plan file may be written |
| `acceptEdits` | `--accept-edits` | `write_file`, `edit_file` and `multi_edit` are permitted without prompting |
| `bypassPermissions` | `--yolo`, `-y` | All actions are permitted, except those matched by a `deny` rule |
| `dontAsk` | `--dont-ask` | Any action that would have prompted is automatically denied |

Rules are read from `~/.triumcode/settings.json`, `~/.claude/settings.json`,
`<cwd>/.triumcode/settings.json`, and `<cwd>/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["run_command(git status)", "read_file(src/*)"],
    "deny": ["run_command(rm -rf *)"]
  }
}
```

`tool(pattern)` matches a single tool; a trailing `*` performs a prefix match;
a bare `tool` matches every call to it. **Deny rules always take precedence** —
they are evaluated before the mode, so `--yolo` cannot override them.

Commands matching a dangerous pattern (`rm -rf /`, `git push`, `git reset
--hard`, `sudo`, `mkfs`, `dd if=`, writes to `/dev/`, `kill`, `shutdown`,
`del`, `format`, `taskkill`) require explicit `y` / `n` confirmation. The
refusal is presented first, so an accidental Enter never approves a destructive
action.

## Plan mode

`--plan`, `/plan`, or the model calling `enter_plan_mode` switches to a
read-only phase. The agent writes its plan to
`~/.claude/plans/plan-<timestamp>.md` and calls `exit_plan_mode`, which
displays the plan and prompts for how to proceed:

1. Clear context and execute
2. Execute with current context
3. Execute with manual edit confirmations
4. Keep planning

Option 3 returns to `default` mode, so edits prompt again; the others move to
`acceptEdits`.

## Skills

Skills are reusable Markdown prompts stored in `.triumcode/skills/`.

```markdown
---
name: commit
description: Review and create a conventional commit
when_to_use: The user asks to commit changes
allowed-tools: git_diff, run_command
user-invocable: true
mode: inline
---

Review the current changes, then create a commit for $ARGUMENTS.
The skill directory is ${TRIUMCODE_SKILL_DIR}.
```

User skills are loaded from `~/.triumcode/skills/`; project skills are loaded
from `.triumcode/skills/` and override a user skill of the same name. Existing
Claude Code skill directories (`~/.claude/skills/` and project `.claude/skills/`)
are still discovered as a migration fallback. Invoke a user-invocable skill
with `/commit message`, or let the model load one through the `skill` tool.
Setting `user-invocable: false` removes a skill from the
slash-command surface and lists it as model-invocable only.

`allowed-tools` accepts either a comma-separated list or a JSON array. The
supported template variables are `$ARGUMENTS`, `${ARGUMENTS}`, and
`${TRIUMCODE_SKILL_DIR}`. `${CLAUDE_SKILL_DIR}` remains supported for existing
skills. `mode: fork` marks the prompt as isolated sub-agent
work; the current runtime passes that isolation contract to the agent while
tool execution remains in the same process.

## Memory

A persistent, file-based memory in two layers:

```
.triumcode/memory/            ← project memories (higher priority on filename collision)
~/.triumcode/memory/          ← user-global memories
  feedback_keep-diffs-small.md
  user_prefers-concise-output.md
  MEMORY.md                   ← human-readable index, rebuilt on save
```

Each memory is a Markdown file with `name`, `description`, and `type`
frontmatter. The type taxonomy is closed — `user`, `feedback`, `project`, and
`reference` — because free-form tags degrade recall as they accumulate. The
agent writes memories through the `memory` tool; they can be edited or removed
with any editor.

Recall runs before each turn. A small auxiliary model call selects the few
memories relevant to the current message from a manifest of filenames and
descriptions, and they are injected as a `<system-reminder>` message. The
prefetch runs concurrently with the first model call, so recall normally adds
no latency. Any failure — a missing key, an offline endpoint, an unparsable
reply — falls back to word-overlap scoring, so recall never blocks or interrupts
the main loop.

Budgets prevent a single turn from exhausting the context window: 4 KB per
memory file, 5 memories recalled per turn, and 60 KB of memory content per
session. A memory older than one day carries a freshness notice instructing the
model to verify claims about code before asserting them. `/memory` lists the
saved memories.

## Context management

The prompt is divided deliberately:

- **System prompt** — persona, tool guidance, skills, environment, `CLAUDE.md`,
  and the memory index. One cacheable block, containing nothing volatile.
- **Per-turn reminder** — git branch and status, today's date, and which
  deferred tools remain unloaded. Prepended to the user's message, which is new
  every turn and therefore invalidates nothing behind it.

This division is functional rather than cosmetic. Prompt caching matches on a
byte-exact prefix, and git status changes whenever the agent writes a file.
Placed in the system prompt, it would cause the entire conversation to be
reprocessed at full price on nearly every write.

Tool output is governed by a budget rather than a single size limit:

- Each tool declares its own `maxResultSizeChars`. A 100 KB file read is
  acceptable; a 100 KB grep output is not. A result exceeding its limit retains
  its head and tail, while the full text is written to
  `~/.mini-claude/tool-results/` and a file path is returned in its place.
- Once utilization exceeds 60% of the usable window, tool results are trimmed in
  a single pass down to approximately 45%, retaining the most recent results.
  The gap between the trigger and the target is the point: a boundary
  re-derived on every request shifts by however much the previous turn added,
  and a shifting boundary invalidates the cache for the entire conversation
  behind it.
- Redundant older results are removed. A `read_file` result is superseded only
  by a later read that actually covers its line range, so paged reads are
  retained, and only the three most recent searches are kept in full.
- Once the cache has expired (more than five minutes idle), all but the three
  most recent tool results are discarded.
- At 85% of `contextWindow - 20000`, history is automatically compacted into a
  local summary. `/compact` performs the same operation on demand.

`/cost` reports the prompt cache hit rate alongside token usage and estimated
cost.

## Interactive commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear the current conversation (empties this session) |
| `/new` | Start a new conversation; the previous session is retained |
| `/resume [id]` | Resume a saved session; a bare `/resume` opens a picker |
| `/config` | Show the active endpoint, model, and key, with the origin of each |
| `/cost` | Show token usage, cache hit rate, and estimated cost |
| `/compact` | Compact conversation history into a local summary |
| `/plan` | Toggle plan mode |
| `/effort [level]` | Show or change reasoning effort; a bare `/effort` opens a picker |
| `/thinking [on\|off]` | Show or toggle extended thinking |
| `/model [name]` | Switch model; a bare `/model` selects from configured presets |
| `/memory` | List saved long-term memories |
| `/sessions` | List all saved sessions |
| `/delete <id>` | Delete a saved session |
| `/help` | Show all commands |
| `/‹skill›` | Run any user-invocable skill by name |
| `exit`, `quit` | Exit |

When stdin is a TTY, `/resume`, `/effort`, `/model`, and `ask_user` with
options render an arrow-key picker. Otherwise they fall back to a numbered
prompt.

**Ctrl+C** while the agent is working interrupts the current operation and
returns to the prompt. **Ctrl+C** twice while idle exits.

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read a text file with line numbers. 2000 lines by default; use `offset`/`limit` to page (maximum 5000). Rejects binary files; files over 20 MiB are streamed in bounded chunks, with oversized lines/output truncated |
| `write_file` | Write a file atomically (temporary file, then rename) |
| `edit_file` | Replace an exact, unique string in a file (requires a prior read). Returns the edited region with line numbers, or `replace_all: true` to change every occurrence |
| `multi_edit` | Apply several edits to one file in a single call; validated together and written once, so a failing edit discards the whole batch |
| `list_files` | List a directory recursively, skipping `node_modules`/`.git`/`dist`-style directories; capped at 200 entries |
| `grep_search` | Regex search across files (prefers system `rg`, falls back to `grep`, then to an in-process chunked scanner) |
| `run_command` | Run a program directly (no shell — pipes and redirects are unsupported); 30-second timeout |
| `git_diff` | Show the working-tree or staged diff, optionally limited to a path |
| `ask_user` | Ask the user a question mid-task, with optional arrow-key choices |
| `todo` | Maintain a task list that the agent updates as it works |
| `memory` | Save or list persistent memories |
| `skill` | Load a reusable skill by name |
| `agent` | Delegate a self-contained task to a sub-agent with its own context (see [Sub-agents](#sub-agents)) |
| `enter_plan_mode`, `exit_plan_mode` | Deferred; enter and exit the planning phase |
| `tool_search` | Activate deferred tools on demand |

Deferred tools withhold their schema until the model requests them by name,
keeping the default tool list small. Activation is retained for the remainder
of the session. The system prompt advertises only the tool names, which are
inexpensive; the schemas are not.

### Tool safety

- **Read-before-write**: `edit_file`, `multi_edit` and `write_file` require a
  prior read of the file. A write is rejected if the file was modified
  externally since that read. Re-reading a line range already present in the
  conversation returns a short notice rather than the content again, unless
  compression has evicted it, in which case the claim is dropped.
- **Edits that do not need a re-read**: a successful `edit_file` returns the
  region it changed, numbered the way `read_file` numbers it, so the next edit
  can be anchored on text the model has actually seen. A miss quotes the file's
  real lines back instead of reporting "not found", and a match that differs
  only in trailing whitespace is applied rather than rejected. Indentation
  differences are reported, never applied — re-indenting would change code the
  model did not ask to change.
- **Concurrency**: Read-only tools (`read_file`, `list_files`, `grep_search`,
  `git_diff`) run in parallel, up to ten at a time. Write tools require
  exclusive access; safe tools queued behind one wait only while it actually
  holds the slot.
- **Classification**: `run_command` classifies each call by its arguments as
  read-only (`git status`, `ls`, `tsc`), mutating (`npm install`), or
  destructive (`rm`), and applies the corresponding rules.
- **Argument validation**: A call missing a declared required argument is
  rejected with an error rather than executed, and a `tool_use` block that
  arrived with truncated JSON is reported rather than run with an empty object.

## Sub-agents

A large task pushed through one agent loop saturates the context window: the
intermediate `tool_use` / `tool_result` traffic crowds out the reasoning the
conversation is actually about. The `agent` tool splits the work instead. The
main agent delegates a self-contained task, the sub-agent runs its own tool
loop in a **separate message history**, and only its final text comes back. The
files it read and the commands it ran never enter the main conversation.

```
main agent ──agent(explore, "where is auth handled?")──► sub-agent
                                                            │ read_file, grep_search …
                                                            │ (own history, discarded)
       ◄──────── "Auth is in src/auth.ts:42, called from src/cli.ts:10" ────┘
```

| Type | Tools | Use |
|------|-------|-----|
| `explore` | `read_file`, `list_files`, `grep_search` | Reconnaissance — where something lives, how it connects |
| `plan` | same | Design an implementation before committing to it |
| `general` | all task tools except `agent`, `ask_user`, and plan-mode controls | A whole task: read, change, verify |

An unknown or omitted `type` falls back to `general`.

- **Read-only is enforced by the tool allowlist**, not by the prompt. `explore`
  and `plan` have no write or shell tools in either the request schema or the
  execution layer. Their contracts restate the restriction so they do not
  spend turns asking for a tool that is not there.
- **Plan mode is inherited.** A sub-agent spawned while the session is in plan
  mode runs in plan mode too; everywhere else it runs with permissions already
  granted to the parent. Dropping the mode instead would let a delegation
  become the way around a read-only session.
- **No recursion.** A `general` sub-agent's tool list excludes `agent`, and so
  does a custom agent's. Nesting multiplies token use per level, and one level
  covers the real cases.
- **Bounded parallelism.** Up to three sub-agents run at once; additional
  delegations wait for a slot.
- **Errors are isolated.** A sub-agent that throws returns
  `Sub-agent error: …` as its tool result. The parent continues and decides
  whether to retry, narrow the prompt, or do the work itself.
- **The budget is smaller** (4096 output tokens against the main agent's
  32000), and the prompt asks for a summary with `path:line` references rather
  than pasted file contents.
- **Ctrl+C propagates one way**: interrupting the parent interrupts the
  sub-agent, never the reverse.
- Sub-agent tokens are folded into the parent's counters, so `/cost` reports
  the true total for the session.

### Custom agents

A sub-agent type can be defined in Markdown, in the same places skills live:

```markdown
---
name: reviewer
description: Review a diff and report findings
allowed-tools: read_file, grep_search, git_diff
---

Review the change for correctness and report findings as a list.
```

Project-level `.claude/agents/` overrides user-level `~/.claude/agents/` of the
same name, and either overrides a built-in type — a file named `explore.md`
replaces the built-in `explore` contract and tool set. Omitting `allowed-tools`
grants the general set. A declared list is a strict allowlist; unknown or
excluded names do not broaden it. The tool list is filtered to exclude `agent`,
`ask_user`, `enter_plan_mode` and `exit_plan_mode`.

## Session storage

Sessions are stored globally, one directory per project, keyed by the hash of
the project root — the nearest ancestor containing `.git` or `.triumcode`. The
home directory is never accepted as a project root.

```
~/.triumcode/
  config.json          ← resolved configuration, written by first-run setup
  memory/              ← user-global memories
  sessions/
    <project-hash>/
      a3f8b2c1.json    ← session data (messages and metadata)
      7e0d4f9a.json
      ...
      session-latest   ← pointer to the active session
```

- Keying on the project root rather than the working directory means the same
  session list is visible from any subdirectory of the project.
- Sessions are never shared between projects.
- Session files use revisions and a cross-process write lock. If another CLI or
  desktop process changes a conversation first, a stale save is rejected and
  the CLI requires `/resume` before continuing.
- A cross-process workspace lease allows one Agent run or Git index write at a
  time for a workspace. Different workspaces can run independently; separate
  sessions in one worktree are serialized until task isolation is available.
  Per-session leases still protect conversation history, and a run lease left
  by a crashed process is recovered as an interrupted run by the desktop.
- At most 50 sessions are retained per project; the oldest are pruned
  automatically.
- Sessions in the legacy project-local `.triumcode/sessions/` directory are
  migrated on first use.
- Starting the CLI begins a **new** session; `--continue` and `--resume` restore
  an existing one.
- `--resume` without an argument resumes the most recent session.
- `--resume <prefix>` matches by ID prefix, for example `--resume a3f`.
- `/clear` empties the session in place; `/new` clears the pointer and leaves
  the previous conversation on disk.

## Architecture

```
src/
  cli.ts                  Entry point, argument parsing, REPL loop, pickers, SIGINT handling
  config.ts               Configuration resolution, first-run setup, model presets
  agent.ts                Core agent: streaming loop, tools, permissions, plan mode, memory recall
  tools.ts                Tool registry and all tool implementations
  tool-executor.ts        Concurrency-controlled parallel tool dispatcher
  prompt.ts               System prompt assembly (persona, tools, skills, CLAUDE.md, memory)
  session.ts              Session persistence (atomic JSON writes, project-keyed store)
  context-compression.ts  Context budgeting, result trimming, prompt cache breakpoints
  memory.ts               Persistent file-based memory (save, list, recall, injection)
  permissions.ts          Permission modes, allow/deny rules, dangerous-command detection
  skills.ts               Skill discovery and prompt expansion
  subagent.ts             Sub-agent types, read-only tool sets, .claude/agents discovery
  thinking.ts             Extended thinking and effort resolution, and degradation
  markdown.ts             Streaming Markdown renderer for terminal output
  ui.ts                   Terminal UI layer (Chalk palette, status line, pickers, reports)
  retry.ts                Exponential backoff retry for API errors
  providers/
    index.ts              Protocol to provider lookup
    types.ts              Protocol and auth vocabulary, SSE reader, shared translation helpers
    anthropic.ts          Anthropic Messages
    openai-chat.ts        OpenAI Chat Completions
    openai-responses.ts   OpenAI Responses
```

### Execution flow

```
User submits a message
       │
       ▼
  chat() appends the per-turn reminder and the message text
       │
       ├── memory prefetch starts (auxiliary model, concurrent with the first call)
       ▼
  ┌─ per iteration ────────────────────────────────────────┐
  │  consume prefetch → inject <system-reminder> memories  │
  │  compressHistory()  → budget / trim / light compaction │
  │  withCacheBreakpoints() → 1 system block + tail block  │
  │                                                        │
  │  API call (withRetry + streaming)                      │
  │                                                        │
  │  text delta ──→ MarkdownStream ──→ terminal output     │
  │                                                        │
  │  tool_use block complete ──→ ToolExecutor.enqueue()    │
  │        │                                               │
  │        ▼                                               │
  │  permission check → allow / deny / confirm             │
  │  Safe tool? ──→ execute immediately (parallel with     │
  │                the stream)                             │
  │  Unsafe tool? ──→ wait for exclusive access            │
  └────────────────────────────────────────────────────────┘
       │
       ▼
  drain() waits for remaining tools; results are printed
       │
       ▼
  Push the assistant message and tool results to history
       │
       ▼
  No tool calls → response complete, session saved automatically
```

### Design notes

**Parallel tool execution during streaming.** A tool begins executing as soon
as its `tool_use` block is fully received, rather than after the response ends.
File reads, which complete in under 100 ms, are typically finished before the
stream does.

**Abort via AbortController.** `SIGINT` aborts the HTTP request and stops the
tool loop. No requests are left orphaned, and no partial assistant turn is
written to history.

**`rl.once` rather than `rl.on`.** Each input line is processed to completion
before the next is accepted, preventing concurrent `chat()` calls from
corrupting message history.

**Sessions as atomic JSON.** The file is written to a temporary path and then
renamed, so a crash mid-write cannot corrupt it.

**Thinking blocks are discarded.** Extended thinking output is timed and then
discarded before being stored, keeping the context window focused on useful
content.

**Protocol translation rather than a second loop.** The agent loop is written
against the Anthropic Messages format, and the OpenAI providers translate on
each side of the HTTP call. History, compression, and memory therefore behave
identically across all three protocols.

**Markdown rendering is deliberately partial.** Bold, inline code, headings,
and unordered and ordered lists are handled. Italics are not, because
`snake_case_names` are pervasive in this domain. Content inside a fenced code
block is never modified.

## Development

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Build and run
npx tsc --noEmit     # Type check without emitting
npm test             # Build and run the CLI and desktop test suites
```

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening a pull
request.

## License

[MIT](LICENSE) © CTZN01
