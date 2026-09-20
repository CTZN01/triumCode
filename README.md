# TriumCode

A terminal-native coding agent powered by the Anthropic SDK. Reads files, edits code, searches your codebase, and runs commands — all through natural conversation in your terminal.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Run (first time will prompt for API key)
node dist/cli.js
```

That's it. On first launch, TriumCode asks for your API key and saves it to `~/.triumcode/config.json`. No `.env` files or environment variables to set up manually.

## Usage

```bash
# Interactive REPL
node dist/cli.js

# Single-shot (run and exit)
node dist/cli.js "read src/agent.ts and summarize what it does"

# Resume last session
node dist/cli.js --resume

# Resume a specific session by ID prefix
node dist/cli.js --resume a3f8

# List all saved sessions
node dist/cli.js --sessions
```

## Configuration

Config is resolved from highest to lowest priority:

| Priority | Source | Example |
|----------|--------|---------|
| 1 | CLI flags | `--api-key sk-ant-xxx --model claude-sonnet-4` |
| 2 | `~/.triumcode/config.json` | Written by first-run setup |
| 3 | Environment variables | `export ANTHROPIC_API_KEY=sk-ant-xxx` |
| 4 | Built-in defaults | `https://api.anthropic.com` |

Resolution is per-field, so a config file holding only the API key still picks
up `ANTHROPIC_BASE_URL` from the environment. The saved config deliberately
outranks environment variables — an endpoint you typed in during setup should
not be silently redirected by a stray export. Use the CLI flags to override for
a single run, or in CI.

### CLI Flags

```
--api-key KEY     API key
--api-base URL    API base URL. Defaults to https://api.anthropic.com, which
                  only makes sense for the anthropic protocol — an OpenAI
                  protocol needs the gateway's own URL
--model, -m       Model name (default: claude-sonnet-4-20250514)
--protocol NAME   Wire protocol: anthropic | openai-chat | openai-responses
--auth SCHEME     Key transport: api-key (x-api-key) | bearer (Authorization)
--thinking        Enable Extended Thinking mode
--resume [id]     Resume latest session, or a specific one by ID prefix
--sessions        List all sessions and exit
--yolo, -y        Bypass all permission prompts
--plan            Plan mode: read-only, no edits
--max-cost N      Stop after $N spent
--max-turns N     Stop after N conversation turns
--context-window N  Context window size in tokens (use 1000000 for 1M models)
--help, -h        Show help
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | API key | _(none — required)_ |
| `ANTHROPIC_BASE_URL` | API endpoint | `https://api.anthropic.com` |
| `TRIUMCODE_MODEL` | Default model | `claude-sonnet-4-20250514` |
| `TRIUMCODE_PROTOCOL` | Wire protocol | `anthropic` |
| `TRIUMCODE_AUTH` | Key transport | derived from the protocol |
| `TRIUMCODE_EFFORT` | Thinking depth | `high` |
| `TRIUMCODE_CONTEXT_WINDOW` | Context window size in tokens | `200000` |

`MINI_MODEL` and `MINI_CONTEXT_WINDOW` are the older names for the last two.
They still resolve, as a second choice behind the `TRIUMCODE_*` spelling, and
are deprecated — rename them now. A dropped variable is silent: losing the
context window only shows up as history compressed earlier than the model needs.

### Model Protocols

TriumCode speaks three wire protocols, because a model gateway serves each of
its models through whichever API that model's upstream actually exposes. One
base URL is not enough — you also pick a protocol:

| Protocol | Endpoint appended | Typical models behind a gateway |
|----------|-------------------|---------------------------------|
| `anthropic` | `/v1/messages` | Claude, MiniMax, Qwen |
| `openai-chat` | `/v1/chat/completions` | DeepSeek, GLM, Kimi, MiMo |
| `openai-responses` | `/v1/responses` | GPT, Grok |

Conversation history stays in Anthropic's message shape internally, so sessions,
context compression and memory recall behave the same on every protocol. A
gateway that rejects an optional parameter (`thinking`, `effort`,
`stream_options`, `reasoning`) is detected on the first 400 and stops being sent
that parameter for the rest of the session.

```bash
# One-off run against a gateway
triumcode --api-base https://gateway.example/v1 \
          --protocol openai-chat --model deepseek-v4 "refactor src/tools.ts"
```

Named presets in `~/.triumcode/config.json` carry the protocol, so `/model`
switches backend and protocol in one step:

```json
{
  "apiBase": "https://api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "models": {
    "deep":  { "model": "deepseek-v4",   "apiBase": "https://gateway.example/v1", "protocol": "openai-chat",     "contextWindow": "128k" },
    "gpt":   { "model": "gpt-5-luna",    "apiBase": "https://gateway.example/v1", "protocol": "openai-responses", "contextWindow": "200k" },
    "mimin": { "model": "minimax-m3",    "apiBase": "https://gateway.example/v1", "protocol": "anthropic",        "auth": "api-key" }
  }
}
```

`--api-base` accepts the URL exactly as vendor docs print it, `/v1` included:
the version segment is normalized away and each protocol appends its own path.
The `https://api.anthropic.com` default is the Anthropic protocol's own; the
OpenAI protocols have no sensible default, so give them the gateway's URL.
`auth` is only needed when a gateway wants the key spelled differently from what
its protocol implies — `bearer` sends `Authorization: Bearer`, `api-key` sends
`x-api-key`.

### Skills

Skills are reusable Markdown prompts stored in `.claude/skills/`.

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
The skill directory is ${CLAUDE_SKILL_DIR}.
```

User skills are loaded from `~/.claude/skills/`; project skills are loaded from
`.claude/skills/` and override a user skill with the same name. Use `/commit
message` for a user-invocable skill, or let the model load one with the
`skill` tool. `user-invocable: false` hides a skill from slash commands.

`allowed-tools` accepts either a comma-separated list or a JSON array. The
supported template variables are `$ARGUMENTS`, `${ARGUMENTS}`, and
`${CLAUDE_SKILL_DIR}`. `mode: fork` marks the prompt as isolated sub-agent
work; the current runtime returns that isolation contract to the agent while
keeping tool execution in the same process.

## REPL Commands

Once inside the interactive REPL:

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/cost` | Show token usage and estimated cost |
| `/sessions` | List all saved sessions |
| `/delete <id>` | Delete a saved session |
| `/help` | Show all commands |
| `exit` / `quit` | Exit |

**Ctrl+C** while the agent is working → interrupt and return to prompt.
**Ctrl+C** twice while idle → exit.

## Built-in Tools

The agent has access to these tools during conversation:

| Tool | What it does |
|------|-------------|
| `read_file` | Read a file with line numbers |
| `write_file` | Write content to a file (atomic) |
| `edit_file` | Replace an exact string in a file (requires prior read) |
| `list_files` | List directory contents recursively, skipping `node_modules`/`.git`/`dist` |
| `grep_search` | Regex search across files (uses system `grep` when available, falls back to in-process) |
| `run_command` | Run a program directly (no shell — pipes/redirects don't work) |
| `tool_search` | Activate deferred tools on demand |

### Tool Safety

- **Read-before-write guard**: `edit_file` and `write_file` require reading the file first. Stale writes (file modified externally since last read) are rejected.
- **Concurrency**: Read-only tools (`read_file`, `list_files`, `grep_search`) run in parallel. Write tools get exclusive access.
- **Classification**: `run_command` classifies commands as read-only (`git status`, `ls`, `tsc`), mutating (`npm install`), or destructive (`rm`) and applies appropriate safety rules.

## Architecture

```
src/
  cli.ts           Entry point, argument parsing, REPL loop, SIGINT handling
  config.ts        Config resolution + first-run interactive setup
  agent.ts         Core agent: conversation loop with streaming + parallel tools
  tools.ts         Tool registry + all tool implementations
  tool-executor.ts Concurrency-controlled parallel tool dispatcher
  prompt.ts        System prompt assembly (persona, CLAUDE.md, git context)
  session.ts       Session persistence (atomic JSON writes, latest-pointer)
  retry.ts         Exponential backoff retry for API errors
  thinking.ts      Extended Thinking mode support
  ui.ts            Terminal UI layer (chalk colors, tool call display)
```

### How It Works

```
User types message
       │
       ▼
  Agent.chat()
       │
       ▼
  ┌─ API call (withRetry + streaming) ─────────────────┐
  │                                                     │
  │  text delta ──→ writeStream() ──→ terminal output   │
  │                                                     │
  │  tool_use block completes ──→ ToolExecutor.enqueue() │
  │        │                                            │
  │        ▼                                            │
  │  Safe tool? ──→ execute NOW (parallel with stream)  │
  │  Unsafe tool? ──→ wait for exclusive access         │
  │                                                     │
  └─────────────────────────────────────────────────────┘
       │
       ▼
  Stream ends, drain() waits for remaining tools
       │
       ▼
  Push assistant message + tool results to history
       │
       ▼
  Model called again if tools were used (loop continues)
       │
       ▼
  No tools → response complete, auto-save session
```

### Key Design Decisions

**Streaming parallel tools**: Tools start executing as soon as their `tool_use` block is fully received during streaming, not after the entire API response ends. File reads (< 100ms) are typically done before the stream finishes.

**Abort via AbortController**: `SIGINT` aborts the HTTP request and stops the tool loop. No orphaned API calls.

**`rl.once` not `rl.on`**: Each input line is processed completely before the next is accepted. Prevents concurrent `chat()` calls from corrupting message history.

**Session as atomic JSON**: Written to temp file then renamed. A crash mid-write never corrupts the session file.

**Thinking blocks filtered**: Extended Thinking output (the model's private scratchpad) is discarded before storing in history. Keeps context window focused on useful content.

## Session Storage

Sessions are stored in `.triumcode/sessions/` (project-local):

```
.triumcode/
  sessions/
    a3f8b2c1.json    ← session data (messages + metadata)
    7e0d4f9a.json
    ...
  session-latest     ← pointer to most recent session
```

- Max 50 sessions (oldest auto-pruned)
- `--resume` with no argument resumes the latest
- `--resume <prefix>` matches by ID prefix (e.g. `--resume a3f`)

## Development

```bash
# Build
npm run build

# Build + run
npm run dev

# Type check without emitting
npx tsc --noEmit
```

## License

MIT