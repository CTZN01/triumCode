# TriumCode

一个运行在终端中的编码智能体，基于 Anthropic SDK。通过自然语言对话即可读取文件、编辑代码、搜索代码库、执行命令。

TriumCode 支持三种 API 协议，可直连 Anthropic，也可通过提供 `/messages`、`/chat/completions` 或 `/responses` 的模型网关接入。

## 功能特性

- **流式传输期间并行执行工具** —— `tool_use` 块接收完整后工具即开始执行，无需等待整个响应结束。
- **子 agent** —— 把大范围搜索或整块子任务委派给拥有独立上下文的 agent，只取回它的摘要。
- **支持三种 API 协议** —— `anthropic`、`openai-chat`、`openai-responses`，按模型选择。
- **面向提示词缓存的上下文管理** —— 系统提示词仅保留一个可缓存块，易变内容移至每轮提醒；工具输出一次性裁剪到位，使缓存前缀保持稳定。
- **持久记忆** —— 基于文件，分项目层与用户层，支持语义召回与关键词回退。
- **权限模式** —— `default`、`plan`、`acceptEdits`、`yolo`、`dontAsk`，并支持 `settings.json` 中的 `allow`/`deny` 规则。
- **按项目存储会话** —— 从项目的任意子目录启动，均可看到同一批会话。
- **流式 Markdown 渲染** —— 标题、列表以及行内加粗与代码随内容到达即时渲染。

## 环境要求

- Node.js 20 或更高版本
- Anthropic 的 API Key，或兼容网关的 API Key

## 安装

```bash
npm install
npm run build
```

## 使用方法

```bash
# 启动交互式会话
node dist/cli.js

# 执行单条指令后退出
node dist/cli.js "读取 src/agent.ts 并总结其功能"

# 继续本项目最近的会话
node dist/cli.js --continue

# 按 ID 前缀恢复指定会话
node dist/cli.js --resume a3f8

# 强制新建会话，已保存的会话不受影响
node dist/cli.js --new

# 列出所有已保存的会话
node dist/cli.js --sessions
```

首次启动时，TriumCode 会依次询问 API Key、基础地址、模型和协议，并写入 `~/.triumcode/config.json`。无需配置环境变量或 `.env` 文件。

### 会话选择

每次调用最多只能指定 `--continue`、`--resume`、`--new` 中的一个。同时指定多个将被拒绝，而不会按优先级取其一。

## 配置

### 优先级

配置按字段解析，来源优先级由高到低如下：

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 1 | 命令行参数 | `--api-key sk-ant-xxx --model claude-sonnet-4` |
| 2 | `~/.triumcode/config.json` | 首次运行时写入 |
| 3 | 环境变量 | `ANTHROPIC_API_KEY=sk-ant-xxx` |
| 4 | 内置默认值 | `https://api.anthropic.com` |

由于解析按字段进行，配置文件中只设置了 API Key 时，`ANTHROPIC_BASE_URL` 仍可从环境变量读取。

保存的配置优先级高于环境变量，这是有意设计的：首次运行时填入的地址，不应被一个遗留的 export 悄然改掉。单次运行或 CI 场景请使用命令行参数覆盖。

若某个低优先级来源的值与最终生效值不同，启动时会输出一份 **Overridden** 报告将其列出。`/config` 命令会显示同一张表，并标注每个字段的来源。

### 命令行参数

```
--api-key KEY       API Key
--api-base URL      API 基础地址。默认 https://api.anthropic.com，该默认值仅对
                    anthropic 协议有效；OpenAI 协议必须指定网关自身的地址
--model, -m         模型名称（默认：claude-sonnet-4-20250514）
--protocol NAME     协议：anthropic | openai-chat | openai-responses
--auth SCHEME       Key 传递方式：api-key（x-api-key）| bearer（Authorization）
--thinking          启用扩展思维（默认已启用）
--no-thinking       本次会话关闭扩展思维
--effort LEVEL      思考深度：low | medium | high | xhigh | max
                    （默认 high；亦可在会话中用 /effort 调整）
--resume [id]       恢复最近的会话，或按 ID 前缀恢复指定会话
--continue          继续本项目最近的会话（等同于不带参数的 --resume）
--new               新建会话，已保存的会话不受影响。这是默认行为，
                    --continue 和 --resume 会覆盖它
--sessions          列出所有会话后退出
--yolo, -y          跳过常规确认（已配置的 deny 规则仍然生效）
--plan              计划模式：只读，不执行编辑
--accept-edits      自动放行文件写入与编辑；其余操作仍需确认
--dont-ask          本应询问的操作一律自动拒绝
--max-turns N       agent 循环执行 N 轮后停止
--max-tokens N      单次请求的最大输出 token 数（默认 32000）。
                    思考也计入该上限
--context-window N  上下文窗口大小（token）；支持 k/M 后缀（200k、1M）
--help, -h          显示帮助信息
```

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API Key | _（无 — 必填）_ |
| `ANTHROPIC_BASE_URL` | API 地址 | `https://api.anthropic.com` |
| `TRIUMCODE_MODEL` | 默认模型 | `claude-sonnet-4-20250514` |
| `TRIUMCODE_PROTOCOL` | 协议 | `anthropic` |
| `TRIUMCODE_AUTH` | Key 传递方式 | 由协议推导 |
| `TRIUMCODE_EFFORT` | 思考深度 | `high` |
| `TRIUMCODE_CONTEXT_WINDOW` | 上下文窗口大小（token） | `200000` |

`MINI_MODEL` 与 `MINI_CONTEXT_WINDOW` 是后两项的已废弃别名。它们仍然生效，但排在 `TRIUMCODE_*` 之后。变量失效是静默的：上下文窗口丢失只会表现为历史被压缩得早于模型实际需要。若某个已废弃变量最终生效，启动时会提示一次。

记忆召回所用的辅助模型同样读取 `TRIUMCODE_MODEL`，将其指向更小的模型可降低召回开销。

### 配置文件

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

`contextWindow` 可填纯 token 数，也可带容量后缀（`200k`、`1M`）。除 `models` 外，所有字段均可由命令行参数覆盖。

## 模型协议

TriumCode 支持三种协议，原因是模型网关对其旗下的每个模型，均按该模型上游实际提供的 API 转发。仅提供一个 base URL 并不足够，还须指定协议。

| 协议 | 拼接的路径 | 网关后常见的模型 |
|------|------------|------------------|
| `anthropic` | `/v1/messages` | Claude、MiniMax、Qwen |
| `openai-chat` | `/v1/chat/completions` | DeepSeek、GLM、Kimi、MiMo |
| `openai-responses` | `/v1/responses` | GPT、Grok |

会话历史在内部始终以 Anthropic 的消息格式保存，因此会话持久化、上下文压缩与记忆召回在三种协议下行为一致。若网关拒绝某个可选参数（`thinking`、`effort`、`stream_options`、`reasoning`），会在首次返回 HTTP 400 时被识别，并在本次会话的后续请求中不再发送。

```bash
# 通过网关运行
triumcode --api-base https://gateway.example/v1 \
          --protocol openai-chat --model deepseek-v4 "重构 src/tools.ts"
```

`~/.triumcode/config.json` 中的命名预设自带协议，因此 `/model` 可一步同时切换后端与协议。

`--api-base` 可照厂商文档原样填写，包含 `/v1` 亦可：版本段会被规范化去除，各协议再拼接自身路径。`https://api.anthropic.com` 这一默认值属于 anthropic 协议；OpenAI 协议没有合适的默认地址，必须指定网关地址。仅当网关要求的 Key 形式与协议默认值不同时才需配置 `auth` —— `bearer` 发送 `Authorization: Bearer`，`api-key` 发送 `x-api-key`。

按预设名切换时，该名称会保留为本次会话的路由标识，因此两个预设即便提供相同的模型字符串、经由不同网关，仍可区分。按裸模型 ID 切换则会清除该标识，此时模型 ID 是唯一准确的描述。

## 推理控制

扩展思维默认启用，深度由 `effort` 控制（`low` 至 `max`，默认 `high`）。两者均可在会话中调整：

```
/effort            # low..max 的上下键选择器
/effort xhigh
/thinking off
```

上游存在两种请求形式，选错会产生 HTTP 400：

- `{ thinking: { type: "adaptive" } }` —— 当前模型。没有 token 预算，深度由 `output_config.effort` 控制。
- `{ thinking: { type: "enabled", budget_tokens: N } }` —— 4.6 之前的模型（Haiku 4.5 及更早），必须提供 `budget_tokens`。

所需形式无法从模型名可靠推导，因此无法识别的模型不会被直接拒绝：内置模型清单仅决定思考是否自动启用。`--thinking` 始终强制启用。若地址拒绝这些参数，agent 会在本次会话的后续请求中不再发送它们，而不会让该轮失败。

思维块是模型的私有推理内容，不予保留。其耗时会单独统计以便界面展示，并在该轮写入历史前丢弃。

## 权限

每次工具调用都会依据模式和（可选的）规则集进行判定。

| 模式 | 参数 | 行为 |
|------|------|------|
| `default` | _（无）_ | 只读工具与记忆操作放行；危险命令会询问 |
| `plan` | `--plan` / `/plan` | 只读。仅允许写入计划文件 |
| `acceptEdits` | `--accept-edits` | `write_file` 与 `edit_file` 免确认放行 |
| `bypassPermissions` | `--yolo`、`-y` | 除匹配 `deny` 规则外，全部放行 |
| `dontAsk` | `--dont-ask` | 本应询问的操作一律自动拒绝 |

规则从 `~/.triumcode/settings.json`、`~/.claude/settings.json`、`<cwd>/.triumcode/settings.json` 和 `<cwd>/.claude/settings.json` 读取：

```json
{
  "permissions": {
    "allow": ["run_command(git status)", "read_file(src/*)"],
    "deny": ["run_command(rm -rf *)"]
  }
}
```

`tool(pattern)` 匹配单个工具；以 `*` 结尾表示前缀匹配；仅写 `tool` 则匹配该工具的所有调用。**deny 规则始终优先** —— 其判定在模式之前，因此 `--yolo` 无法覆盖。

匹配危险模式的命令（`rm -rf /`、`git push`、`git reset --hard`、`sudo`、`mkfs`、`dd if=`、写入 `/dev/`、`kill`、`shutdown`、`del`、`format`、`taskkill`）需要显式确认 `y` 或 `n`。拒绝选项排在首位，因此误按回车不会批准破坏性操作。

## 计划模式

`--plan`、`/plan`，或模型调用 `enter_plan_mode`，都会切换到只读阶段。agent 将计划写入 `~/.claude/plans/plan-<时间戳>.md`，随后调用 `exit_plan_mode`，展示计划并询问后续处理方式：

1. 清空上下文并执行
2. 使用当前上下文执行
3. 执行，但每次编辑均需手动确认
4. 继续规划

选项 3 会回到 `default` 模式，编辑将重新询问；其余选项进入 `acceptEdits` 模式。

## 技能

技能是存放在 `.claude/skills/` 下的可复用 Markdown 提示词。

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

用户技能从 `~/.claude/skills/` 加载；项目技能从 `.claude/skills/` 加载，同名时覆盖用户技能。使用 `/commit message` 调用可被用户调用的技能，或由模型通过 `skill` 工具加载。设置 `user-invocable: false` 会将技能从斜杠命令中移除，仅保留模型调用入口。

`allowed-tools` 支持逗号分隔列表或 JSON 数组。支持的模板变量为 `$ARGUMENTS`、`${ARGUMENTS}` 和 `${CLAUDE_SKILL_DIR}`。`mode: fork` 表示该提示词属于隔离子智能体执行；当前实现会将这份隔离约定交给 agent，工具执行仍位于同一进程内。

## 记忆

基于文件的持久记忆，分两层：

```
.triumcode/memory/            ← 项目记忆（同名文件时优先级更高）
~/.triumcode/memory/          ← 用户全局记忆
  feedback_keep-diffs-small.md
  user_prefers-concise-output.md
  MEMORY.md                   ← 供人阅读的索引，保存时重建
```

每条记忆是一个 Markdown 文件，带有 `name`、`description`、`type` 前置元信息。类型为固定的四种 —— `user`、`feedback`、`project`、`reference` —— 因为自定义标签积累过多会降低召回质量。agent 通过 `memory` 工具写入；也可用任意编辑器编辑或删除。

召回在每轮开始前执行。一次较小的辅助模型调用会从「文件名与描述」清单中选出与当前消息相关的少数记忆，并以 `<system-reminder>` 消息注入。预取与首次模型调用并发执行，因此召回通常不增加延迟。任何环节失败 —— 缺少 Key、地址不可达、回复无法解析 —— 都会回退到按词重合度打分，因此召回不会阻塞或中断主循环。

预算用于防止单轮耗尽上下文窗口：每个记忆文件 4 KB，每轮最多召回 5 条，单次会话的记忆内容总量 60 KB。超过一天的记忆会附带时效提示，要求模型在断言代码行为前先行核实。`/memory` 列出已保存的记忆。

## 上下文管理

提示词被刻意划分为两部分：

- **系统提示词** —— 人设、工具使用指引、技能、环境信息、`CLAUDE.md` 以及记忆索引。一个可缓存块，不含任何易变内容。
- **每轮提醒** —— git 分支与状态、当天日期、尚未加载的延迟工具。拼接在用户消息之前；该消息每轮都是新的，因此不会使后面的内容失效。

这一划分是功能性的，而非形式上的。提示词缓存按逐字节前缀匹配，而 git status 在 agent 每次写入文件后都会变化。若置于系统提示词中，几乎每次写入都会导致整段对话按全价重新处理。

工具输出由预算管理，而非单一大小上限：

- 每个工具声明各自的 `maxResultSizeChars`。读取 100 KB 的文件可以接受，100 KB 的 grep 输出则不行。超出上限的结果保留首尾，全文写入 `~/.mini-claude/tool-results/`，并返回文件路径作为替代。
- 利用率超过可用窗口的 60% 后，工具结果会一次性裁剪至约 45%，并优先保留最新的结果。触发线与目标线之间的落差正是关键：每次请求重新推导的边界，会随上一轮新增的内容而移动，而边界一旦移动，其后的整段对话缓存即告失效。
- 冗余的旧结果会被移除。一次 `read_file` 仅在被后续读取实际覆盖其行范围时才算被取代，因此分页读取会保留；搜索也只完整保留最近三次。
- 缓存失效后（空闲超过五分钟），除最近三条外的工具结果全部丢弃。
- 达到 `contextWindow - 20000` 的 85% 时，历史会自动压缩为本地摘要。`/compact` 可随时手动执行同一操作。

`/cost` 会在 token 用量与预估费用之外，同时报告提示词缓存命中率。

## 交互命令

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前对话（清空当前会话） |
| `/new` | 新建对话，之前的会话保留 |
| `/resume [id]` | 恢复已保存的会话；不带参数时打开选择器 |
| `/config` | 显示生效的地址、模型与 Key，以及各自的来源 |
| `/cost` | 显示 token 用量、缓存命中率与预估费用 |
| `/compact` | 将对话历史压缩为本地摘要 |
| `/plan` | 切换计划模式 |
| `/effort [level]` | 查看或修改推理深度；不带参数时打开选择器 |
| `/thinking [on\|off]` | 查看或切换扩展思维 |
| `/model [name]` | 切换模型；不带参数时从已配置的预设中选择 |
| `/memory` | 列出已保存的长期记忆 |
| `/sessions` | 列出所有已保存的会话 |
| `/delete <id>` | 删除指定会话 |
| `/help` | 显示所有命令 |
| `/‹技能名›` | 按名称运行任意可被用户调用的技能 |
| `exit`、`quit` | 退出 |

当 stdin 为 TTY 时，`/resume`、`/effort`、`/model` 以及带选项的 `ask_user` 会渲染上下键选择器；否则回退为编号输入。

**Ctrl+C** 在 agent 执行期间中断当前操作并返回提示符。空闲状态下连按两次 **Ctrl+C** 退出。

## 工具

| 工具 | 说明 |
|------|------|
| `read_file` | 带行号读取文本文件。默认 2000 行；可用 `offset`/`limit` 分页（上限 5000）。拒绝二进制文件及超过 20 MB 的文件 |
| `write_file` | 原子写入文件（先写临时文件，再重命名） |
| `edit_file` | 替换文件中精确且唯一的字符串（需先读取该文件）。成功后回显带行号的改动区域；传 `replace_all: true` 可替换全部匹配 |
| `multi_edit` | 一次调用对同一文件应用多处修改；统一校验、单次写入，任一项失败则整批丢弃 |
| `list_files` | 递归列出目录，跳过 `node_modules`/`.git`/`dist` 一类目录；上限 200 条 |
| `grep_search` | 跨文件正则搜索（优先使用系统 `grep`，否则使用进程内分块扫描器） |
| `run_command` | 直接运行程序（不使用 shell —— 不支持管道与重定向）；超时 30 秒 |
| `git_diff` | 显示工作区或暂存区 diff，可限定单个路径 |
| `ask_user` | 在任务执行过程中向用户提问，可附带上下键选项 |
| `todo` | 维护任务清单，agent 随进度更新 |
| `memory` | 保存或列出持久记忆 |
| `skill` | 按名称加载可复用技能 |
| `agent` | 将独立任务委派给拥有独立上下文的子 agent（见[子 agent](#子-agent)） |
| `enter_plan_mode`、`exit_plan_mode` | 延迟加载；进入与退出规划阶段 |
| `tool_search` | 按需激活延迟加载的工具 |

延迟加载的工具在模型按名称请求前不会下发 schema，从而使默认工具列表保持精简。激活状态在本次会话内持续有效。系统提示词仅公布工具名称 —— 名称占用极少 token，schema 则不然。

### 工具安全机制

- **先读后写**：`edit_file`、`multi_edit` 与 `write_file` 要求先读取文件。若文件自上次读取后被外部修改，写入会被拒绝。重复读取对话中已出现过的行范围，会返回简短提示而非再次返回内容；除非压缩已将其清除，此时该声明会被撤销。
- **改动后无需重读**：`edit_file` 成功后会回显它所改动的那段区域，行号格式与 `read_file` 一致，下一次编辑可直接据此取锚点。未命中时会把文件中最接近的真实行原文回传，而不是只报「not found」；仅尾部空白不同的匹配会被自动应用而非拒绝。缩进差异只做提示、绝不自动改写 —— 自动重排缩进等于改动模型并未要求改动的代码。
- **并发控制**：只读工具（`read_file`、`list_files`、`grep_search`、`git_diff`）并行执行，最多十个。写入工具需要独占访问；排在其后的安全工具仅在它实际占用时等待。
- **命令分类**：`run_command` 按参数将每次调用分类为只读（`git status`、`ls`、`tsc`）、变更（`npm install`）或破坏性（`rm`），并应用对应规则。
- **参数校验**：缺少已声明的必填参数时，调用会被拒绝并返回错误，而不会执行；JSON 被截断的 `tool_use` 块会被报告，而不会以空对象执行。

## 子 agent

大任务塞进单个 agent 循环会迅速撑满上下文窗口：中间的 `tool_use` / `tool_result` 挤占了对话真正需要的推理空间。`agent` 工具改为把工作拆开 —— 主 agent 委派一个自包含的任务，子 agent 在**独立的消息历史**中运行自己的工具循环，只有最终文本回传。它读过的文件、跑过的命令都不会进入主对话。

```
主 agent ──agent(explore, "认证在哪里处理？")──► 子 agent
                                                  │ read_file、grep_search ……
                                                  │ （独立历史，随后丢弃）
       ◄──────── "认证在 src/auth.ts:42，由 src/cli.ts:10 调用" ────┘
```

| 类型 | 工具集 | 用途 |
|------|--------|------|
| `explore` | `read_file`、`list_files`、`grep_search` | 侦察：某物在哪里、如何连接 |
| `plan` | 同上 | 在动手前设计实现方案 |
| `general` | 除 `agent`、`ask_user` 和计划模式控制外的任务工具 | 完整任务：读、改、验证 |

类型未知或省略时回退为 `general`。

- **只读约束由工具白名单执行**，而非依赖提示词。`explore` 与 `plan` 在请求 schema 和执行层都没有写入或 shell 工具。它们的契约中同时重申该限制，避免浪费回合去索要不存在的工具。
- **计划模式强制继承。** 会话处于计划模式时，派生出的子 agent 同样运行在计划模式下；其余情况下则沿用主 agent 已获得的授权。若丢弃该模式，委派就会成为绕过只读会话的通道。
- **禁止递归。** `general` 子 agent 的工具列表排除 `agent`，自定义 agent 亦然。嵌套会让 token 消耗逐层倍增，而单层已覆盖绝大多数场景。
- **并发数量有限。** 最多同时运行 3 个子 agent，其余委派会等待空位。
- **错误隔离。** 子 agent 抛异常时返回 `Sub-agent error: …` 作为工具结果。主 agent 继续运行，并自行决定重试、收窄提示词，还是亲自完成。
- **输出预算更低**（4096 output tokens，主 agent 为 32000），提示词要求给出带 `path:line` 引用的摘要，而非粘贴文件内容。
- **Ctrl+C 单向传播**：中断主 agent 会中断子 agent，反之不成立。
- 子 agent 的 token 会并入主 agent 计数，因此 `/cost` 报告的是会话真实总量。

### 自定义 agent

子 agent 类型可以用 Markdown 定义，位置与技能相同：

```markdown
---
name: reviewer
description: Review a diff and report findings
allowed-tools: read_file, grep_search, git_diff
---

Review the change for correctness and report findings as a list.
```

项目级 `.claude/agents/` 覆盖用户级 `~/.claude/agents/` 中的同名文件，两者都可覆盖内建类型 —— 名为 `explore.md` 的文件会替换内建 `explore` 的契约与工具集。省略 `allowed-tools` 即授予 general 工具集；声明后则按严格白名单处理，未知或被排除的名称不会扩大权限。工具列表会过滤：`agent`、`ask_user`、`enter_plan_mode`、`exit_plan_mode` 永远不会下发给子 agent。

## 会话存储

会话全局存储，按项目根目录的哈希分目录存放。项目根目录指最近一个包含 `.git` 或 `.triumcode` 的祖先目录；home 目录永远不会被接受为项目根目录。

```
~/.triumcode/
  config.json          ← 解析后的配置，由首次运行写入
  memory/              ← 用户全局记忆
  sessions/
    <项目哈希>/
      a3f8b2c1.json    ← 会话数据（消息与元数据）
      7e0d4f9a.json
      ...
      session-latest   ← 指向当前活动会话的指针
```

- 按项目根目录（而非工作目录）归档，因此从项目的任意子目录启动均可看到同一批会话。
- 不同项目之间不共享会话。
- 每个项目最多保留 50 个会话，最旧的会被自动清理。
- 旧版项目本地 `.triumcode/sessions/` 目录中的会话会在首次使用时迁移。
- 启动 CLI 会**新建**会话；`--continue` 与 `--resume` 才会恢复已有会话。
- `--resume` 不带参数时恢复最近的会话。
- `--resume <前缀>` 按 ID 前缀匹配，例如 `--resume a3f`。
- `/clear` 就地清空会话；`/new` 清除指针，将之前的对话留在磁盘上。

## 架构

```
src/
  cli.ts                  入口，参数解析，REPL 循环，选择器，SIGINT 处理
  config.ts               配置解析、首次运行设置、模型预设
  agent.ts                核心 agent：流式循环、工具、权限、计划模式、记忆召回
  tools.ts                工具注册表与所有工具实现
  tool-executor.ts        带并发控制的并行工具调度器
  prompt.ts               系统提示词组装（人设、工具、技能、CLAUDE.md、记忆）
  session.ts              会话持久化（原子 JSON 写入、按项目归档的存储）
  context-compression.ts  上下文预算、结果裁剪、提示词缓存断点
  memory.ts               基于文件的持久记忆（保存、列出、召回、注入）
  permissions.ts          权限模式、allow/deny 规则、危险命令识别
  skills.ts               技能发现与提示词展开
  subagent.ts             子 agent 类型、只读工具集、.claude/agents 发现
  thinking.ts             扩展思维与 effort 解析，以及降级处理
  markdown.ts             用于终端输出的流式 Markdown 渲染器
  ui.ts                   终端 UI 层（Chalk 配色、状态行、选择器、报告）
  retry.ts                API 错误指数退避重试
  providers/
    index.ts              按协议查找提供方
    types.ts              协议与鉴权的取值定义、SSE 读取器、共享转换函数
    anthropic.ts          Anthropic Messages
    openai-chat.ts        OpenAI Chat Completions
    openai-responses.ts   OpenAI Responses
```

### 执行流程

```
用户提交消息
       │
       ▼
  chat() 追加每轮提醒与消息文本
       │
       ├── 记忆预取启动（辅助模型，与首次调用并发）
       ▼
  ┌─ 每轮迭代 ─────────────────────────────────────────────┐
  │  消费预取结果 → 注入 <system-reminder> 记忆            │
  │  compressHistory()  → 预算 / 裁剪 / 轻量压缩           │
  │  withCacheBreakpoints() → 1 个系统块 + 尾部缓存块      │
  │                                                        │
  │  API 调用（withRetry + 流式传输）                      │
  │                                                        │
  │  文本增量 ──→ MarkdownStream ──→ 终端输出              │
  │                                                        │
  │  tool_use 块接收完整 ──→ ToolExecutor.enqueue()        │
  │        │                                               │
  │        ▼                                               │
  │  权限判定 → allow / deny / confirm                     │
  │  安全工具？ ──→ 立即执行（与流式传输并行）             │
  │  非安全工具？ ──→ 等待独占访问                         │
  └────────────────────────────────────────────────────────┘
       │
       ▼
  drain() 等待剩余工具；打印结果
       │
       ▼
  将助手消息与工具结果写入历史
       │
       ▼
  无工具调用 → 响应结束，自动保存会话
```

### 设计说明

**流式传输期间并行执行工具。** 工具在其 `tool_use` 块接收完整后即开始执行，而非等待响应结束。文件读取通常在 100 ms 内完成，往往在流结束前就已返回。

**通过 AbortController 中止。** `SIGINT` 会中止 HTTP 请求并停止工具循环。不会留下孤立请求，也不会将半截的助手回合写入历史。

**使用 `rl.once` 而非 `rl.on`。** 每行输入处理完成后才接受下一行，避免并发的 `chat()` 调用破坏消息历史。

**会话以原子 JSON 保存。** 先写入临时路径再重命名，因此写入过程中崩溃不会损坏会话文件。

**丢弃思维块。** 扩展思维的输出会先计时，再在存储前丢弃，使上下文窗口聚焦于有效内容。

**协议转换，而非第二套循环。** agent 循环按 Anthropic Messages 格式编写，OpenAI 提供方在 HTTP 调用两侧进行转换。因此历史、压缩与记忆在三种协议下行为完全一致。

**Markdown 渲染有意只做部分支持。** 处理加粗、行内代码、标题以及无序和有序列表；不处理斜体，因为本领域大量使用 `snake_case_names`。围栏代码块内的内容不作任何修改。

## 开发

```bash
npm run build        # 编译 TypeScript 到 dist/
npm run dev          # 构建并运行
npx tsc --noEmit     # 仅做类型检查，不输出文件
npm test             # 构建并运行测试套件（对 dist/ 使用 node:test）
```

## 贡献

欢迎提交 issue 与 pull request。提交前请先运行 `npm test`。

## 许可证

[MIT](LICENSE) © CTZN01
