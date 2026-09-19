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
--api-key KEY     Anthropic API key
--api-base URL    API base URL (default: https://api.anthropic.com)
--model, -m       Model name (default: claude-sonnet-4-20250514)
--thinking        Enable Extended Thinking mode
--resume [id]     Resume latest session, or a specific one by ID prefix
--sessions        List all sessions and exit
--yolo, -y        Bypass all permission prompts
--plan            Plan mode: read-only, no edits
--max-cost N      Stop after $N spent
--max-turns N     Stop after N conversation turns
--help, -h        Show help
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | API key | _(none — required)_ |
| `ANTHROPIC_BASE_URL` | API endpoint | `https://api.anthropic.com` |
| `MINI_MODEL` | Default model | `claude-sonnet-4-20250514` |

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