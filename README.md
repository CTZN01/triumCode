# Triumph Code

A coding agent powered by Anthropic SDK, with built-in file tools (read, write, edit, list, grep, run command).

## Setup

```bash
npm install
```

## Environment Variables

```bash
export ANTHROPIC_API_KEY=your-key
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional
export MINI_MODEL=deepseek-mini-1-20260912            # optional, defaults to deepseek-mini
```

## Build & Run

```bash
npm run build
npm start
```

Or in dev mode:

```bash
npm run dev
```

## Project Structure

```
src/
  agent.ts   - Agent class: conversation loop with tool calling
  tools.ts   - Tool definitions & execution (file I/O, grep, run command)
  cli.ts     - Interactive CLI entry point
```
