# TriumCode

一个基于 Anthropic SDK 的终端原生编码智能体。通过终端中的自然语言对话，即可读取文件、编辑代码、搜索代码库、运行命令。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 构建
npm run build

# 3. 运行（首次启动会提示输入 API Key）
node dist/cli.js
```

就这么简单。首次启动时，TriumCode 会提示你输入 API Key 并保存到 `~/.triumcode/config.json`。无需手动配置 `.env` 文件或环境变量。

## 使用方法

```bash
# 交互式 REPL
node dist/cli.js

# 单次执行（运行后退出）
node dist/cli.js "读取 src/agent.ts 并总结它的功能"

# 恢复上一次会话
node dist/cli.js --resume

# 通过 ID 前缀恢复指定会话
node dist/cli.js --resume a3f8

# 列出所有已保存的会话
node dist/cli.js --sessions
```

## 配置

配置按优先级从高到低解析：

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | CLI 参数 | `--api-key sk-ant-xxx --model claude-sonnet-4` |
| 2 | `~/.triumcode/config.json` | 首次运行时自动写入 |
| 3 | 环境变量 | `export ANTHROPIC_API_KEY=sk-ant-xxx` |
| 4 | 内置默认值 | `https://api.anthropic.com` |

解析是逐字段进行的：配置文件中只存了 API Key 时，仍会从环境变量取 `ANTHROPIC_BASE_URL`。保存的配置优先级高于环境变量是有意为之 —— 首次引导里亲手填的 endpoint，不该被一个残留的 export 静默改道。单次运行或 CI 场景请用 CLI 参数覆盖。

### CLI 参数

```
--api-key KEY     API Key
--api-base URL    API 基础地址。默认 https://api.anthropic.com 只对 anthropic
                  协议有意义 —— OpenAI 协议必须填网关自己的 URL
--model, -m       模型名称（默认：claude-sonnet-4-20250514）
--protocol NAME   线协议：anthropic | openai-chat | openai-responses
--auth SCHEME     Key 的传递方式：api-key（x-api-key）| bearer（Authorization）
--thinking        启用扩展思维模式
--resume [id]     恢复最近的会话，或通过 ID 前缀恢复指定会话
--sessions        列出所有会话后退出
--yolo, -y        跳过所有权限确认提示
--plan            计划模式：只读，不执行编辑
--max-cost N      花费超过 $N 后停止
--max-turns N     进行 N 轮对话后停止
--help, -h        显示帮助信息
```

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API Key | _（无 — 必填）_ |
| `ANTHROPIC_BASE_URL` | API 端点 | `https://api.anthropic.com` |
| `TRIUMCODE_MODEL` | 默认模型 | `claude-sonnet-4-20250514` |
| `TRIUMCODE_PROTOCOL` | 线协议 | `anthropic` |
| `TRIUMCODE_AUTH` | Key 的传递方式 | 由协议推导 |
| `TRIUMCODE_EFFORT` | 思考深度 | `high` |
| `TRIUMCODE_CONTEXT_WINDOW` | 上下文窗口大小（token） | `200000` |

`MINI_MODEL` 和 `MINI_CONTEXT_WINDOW` 是后两项的旧名字，仍能生效，但排在 `TRIUMCODE_*` 之后，且已废弃 —— 请尽快改名。变量失效是静默的：上下文窗口丢失只会表现为历史被压缩得比模型需要的更早。

### 模型协议

TriumCode 会说三种线协议。原因是模型网关对它旗下的每个模型，走的都是该模型上游真正提供的那套 API —— 光有一个 base URL 不够，还得指定协议：

| 协议 | 拼接的端点 | 网关后常见的模型 |
|------|------------|------------------|
| `anthropic` | `/v1/messages` | Claude、MiniMax、Qwen |
| `openai-chat` | `/v1/chat/completions` | DeepSeek、GLM、Kimi、MiMo |
| `openai-responses` | `/v1/responses` | GPT、Grok |

会话历史在内部始终保存为 Anthropic 的消息形态，所以会话存取、上下文压缩、记忆召回在三种协议下行为一致。网关不接受的可选参数（`thinking`、`effort`、`stream_options`、`reasoning`）会在第一次 400 时被识别，本次会话之后不再发送。

```bash
# 针对网关单次运行
triumcode --api-base https://gateway.example/v1 \
          --protocol openai-chat --model deepseek-v4 "重构 src/tools.ts"
```

`~/.triumcode/config.json` 里的命名预设自带协议，`/model` 一步就能同时切换后端和协议：

```json
{
  "apiBase": "https://api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "models": {
    "deep":  { "model": "deepseek-v4", "apiBase": "https://gateway.example/v1", "protocol": "openai-chat", "contextWindow": "128k" },
    "gpt":   { "model": "gpt-5-luna",  "apiBase": "https://gateway.example/v1", "protocol": "openai-responses", "contextWindow": "200k" },
    "mimin": { "model": "minimax-m3",  "apiBase": "https://gateway.example/v1", "protocol": "anthropic", "auth": "api-key" }
  }
}
```

`--api-base` 可以照厂商文档原样粘贴，带上 `/v1` 也行：版本段会被规范化掉，各协议再拼上自己的路径。`https://api.anthropic.com` 这个默认值是 anthropic 协议自己的；OpenAI 协议没有合理的默认端点，必须填网关的 URL。只有当网关要求 Key 的写法与该协议默认不一致时才需要配 `auth` —— `bearer` 发 `Authorization: Bearer`，`api-key` 发 `x-api-key`。

## REPL 命令

进入交互式 REPL 后可用以下命令：

| 命令 | 说明 |
|------|------|
| `/clear` | 清空对话历史 |
| `/cost` | 显示 Token 使用量、缓存命中率和预估费用 |
| `/sessions` | 列出所有已保存的会话 |
| `/delete <id>` | 删除指定会话 |
| `/help` | 显示所有命令 |
| `exit` / `quit` | 退出 |

**Ctrl+C** 在智能体工作时 → 中断当前操作并返回提示符。
**Ctrl+C** 在空闲状态下连按两次 → 退出程序。

## 内置工具

智能体在对话过程中可使用以下工具：

| 工具 | 功能 |
|------|------|
| `read_file` | 带行号读取文件内容 |
| `write_file` | 写入文件内容（原子操作） |
| `edit_file` | 精确替换文件中的字符串（需先读取文件） |
| `list_files` | 递归列出目录内容，自动跳过 `node_modules`/`.git`/`dist` |
| `grep_search` | 跨文件正则搜索（优先使用系统 `grep`，回退到进程内搜索） |
| `run_command` | 直接运行程序（无 Shell — 不支持管道/重定向） |
| `tool_search` | 按需激活延迟加载的工具 |

### 工具安全机制

- **先读后写保护**：`edit_file` 和 `write_file` 要求先读取文件。如果文件在上次读取后被外部修改，则拒绝写入。
- **并发控制**：只读工具（`read_file`、`list_files`、`grep_search`）可并行执行。写入工具则独占执行。
- **命令分类**：`run_command` 将命令分为只读（`git status`、`ls`、`tsc`）、变更（`npm install`）、破坏性（`rm`）三类，并应用相应的安全规则。

## 架构

```
src/
  cli.ts           入口文件，参数解析，REPL 循环，SIGINT 处理
  config.ts        配置解析 + 首次运行交互式设置
  agent.ts         核心智能体：流式对话循环 + 并行工具执行
  tools.ts         工具注册表 + 所有工具实现
  tool-executor.ts 并发控制的并行工具调度器
  prompt.ts        系统提示词组装（人设、CLAUDE.md、Git 上下文）
  session.ts       会话持久化（原子 JSON 写入、最新指针）
  retry.ts         API 错误指数退避重试
  thinking.ts      扩展思维模式支持
  ui.ts            终端 UI 层（Chalk 颜色、工具调用展示）
```

### 工作流程

```
用户输入消息
       │
       ▼
  Agent.chat()
       │
       ▼
  ┌─ API 调用（withRetry + 流式传输）────────────────────┐
  │                                                       │
  │  文本增量 ──→ writeStream() ──→ 终端输出              │
  │                                                       │
  │  tool_use 块接收完成 ──→ ToolExecutor.enqueue()       │
  │        │                                              │
  │        ▼                                              │
  │  安全工具？ ──→ 立即执行（与流式传输并行）            │
  │  非安全工具？ ──→ 等待独占访问                        │
  │                                                       │
  └───────────────────────────────────────────────────────┘
       │
       ▼
  流结束，drain() 等待剩余工具完成
       │
       ▼
  将助手消息 + 工具结果推入历史记录
       │
       ▼
  若调用了工具则再次请求模型（循环继续）
       │
       ▼
  无工具调用 → 响应完成，自动保存会话
```

### 关键设计决策

**流式并行工具**：工具在流式传输过程中，当其 `tool_use` 块完整接收后立即开始执行，而非等待整个 API 响应结束。文件读取（< 100ms）通常在流结束前就已完成。

**通过 AbortController 中止**：`SIGINT` 中止 HTTP 请求并停止工具循环，不会产生孤立的 API 调用。

**使用 `rl.once` 而非 `rl.on`**：每行输入在处理完成后才接受下一行，防止并发的 `chat()` 调用破坏消息历史。

**会话作为原子 JSON**：先写入临时文件再重命名。写入过程中崩溃不会损坏会话文件。

**过滤思维块**：扩展思维输出（模型的私有思考过程）在存入历史前被丢弃，保持上下文窗口聚焦于有用内容。

## 会话存储

会话存储在 `.triumcode/sessions/`（项目本地）：

```
.triumcode/
  sessions/
    a3f8b2c1.json    ← 会话数据（消息 + 元数据）
    7e0d4f9a.json
    ...
  session-latest     ← 指向最近会话的指针
```

- 最多保留 50 个会话（自动清理最旧的）
- `--resume` 不带参数恢复最近的会话
- `--resume <前缀>` 通过 ID 前缀匹配（例如 `--resume a3f`）

## 开发

```bash
# 构建
npm run build

# 构建并运行
npm run dev

# 仅类型检查，不输出文件
npx tsc --noEmit
```

## 许可证

MIT
