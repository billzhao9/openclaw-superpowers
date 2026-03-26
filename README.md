# openclaw-superpowers

**Design-first workflow plugin for OpenClaw — forces your agent to think before it codes.**

> No more "let me just write that real quick." Every task goes through brainstorming first.

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

### What is this?

`openclaw-superpowers` is an OpenClaw lifecycle plugin that prevents your agent from jumping straight into code. When a task is detected, the agent is **forced** to:

1. **Ask** clarifying questions first (one at a time)
2. **Propose** 2-3 approaches with trade-offs
3. **Get approval** before writing any code

For bugs, it switches to systematic debugging (root cause first, no guessing).

Inspired by [obra/superpowers](https://github.com/obra/superpowers) and [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem), adapted for OpenClaw's plugin architecture.

### Why?

OpenClaw agents are powerful but impulsive:
- **Code before design** — jumps into implementation without understanding requirements
- **Config disasters** — edits `openclaw.json` without reading it, breaks plugin IDs
- **Repeating mistakes** — no structured approach to debugging
- **soul.md corruption** — overwrites personality files without understanding structure

This plugin fixes all of that.

### How it works

**Inverted detection logic** — instead of trying to detect "is this a task?" (fragile), we detect what is clearly NOT a task, and brainstorm everything else:

| Skipped (no brainstorming) | Everything else |
|---|---|
| Short confirmations (ok, yes, 好) | → **brainstorm by default** |
| Slash commands (/compact) | |
| Greetings (hi, 你好) | |
| Pure emoji | |

Errors/bugs → **systematic debugging mode** instead of brainstorming.

Config file mentions → **safety overlay** injected automatically.

### Features

| Feature | Description |
|---|---|
| **Brainstorming** | Hard gate: agent CANNOT write code until user approves design |
| **Systematic Debugging** | 5-step root cause process, stops guessing after 3 failed fixes |
| **Config Safety** | Auto-injected rules when modifying openclaw.json / soul.md / SKILL.md |
| **Verification** | "No completion claims without fresh evidence" |
| **Planning** | Structured implementation plans with no placeholders |
| **Phase Tracking** | Auto-detects phase transitions: brainstorm → design → spec → plan → execute → verify |
| **Compaction Hints** | Suggests `/compact` when conversation gets long (6+ turns in same phase) |

### Memory Integration

Smart memory handling based on your setup:

| Setup | Recall | Capture |
|---|---|---|
| **openviking plugin installed** | openviking handles it (no duplication) | superpowers captures decisions |
| **No plugin, but `memory.baseUrl` set** | superpowers handles recall | superpowers captures decisions |
| **Neither** | disabled | disabled |

### Installation

```bash
openclaw install openclaw-superpowers
```

Then in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-superpowers"],
    "entries": {
      "openclaw-superpowers": {
        "enabled": true
      }
    }
  }
}
```

That's it. No memory config needed — auto-detected from openviking plugin if installed.

### Configuration

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enable/disable |
| `autoDetect` | boolean | `true` | Auto-detect tasks and inject workflow |
| `memoryEnabled` | boolean | `true` | Capture decisions to OpenViking (auto-detected) |
| `language` | string | `"auto"` | Prompt language |
| `specDir` | string | `"superpowers/specs"` | Spec document directory |
| `planDir` | string | `"superpowers/plans"` | Plan document directory |
| `skipPatterns` | string[] | `[]` | Additional regex patterns to skip |

### Architecture

```
openclaw-superpowers/
├── index.ts              # Plugin entry: hooks + tools
├── detector.ts           # Inverted detection (skip non-tasks, brainstorm the rest)
├── state.ts              # Per-session phase tracking
├── memory.ts             # OpenViking integration (auto-detect config)
├── context-budget.ts     # Token budget + compaction hints
├── prompts/              # Compact injection prompts (~100 tokens each)
│   ├── brainstorming.ts
│   ├── writing-plans.ts
│   ├── verification.ts
│   ├── debugging.ts
│   ├── config-safety.ts
│   └── spec-reviewer.ts
├── openclaw.plugin.json
└── package.json
```

### Credits

- [obra/superpowers](https://github.com/obra/superpowers) — Original superpowers skills by Jesse Vincent
- [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) — Memory lifecycle inspiration
- [OpenViking](https://github.com/nicepkg/openviking) — Long-term memory backend

### Author

**Bill Zhao** — [LinkedIn](https://www.linkedin.com/in/billzhaodi/) | [GitHub](https://github.com/billzhao)

### License

MIT

---

<a name="中文"></a>

## 中文

### 这是什么？

`openclaw-superpowers` 是一个 OpenClaw 生命周期插件，**强制 agent 在写代码前先思考**。检测到任务时，agent 必须：

1. **先提问** — 逐个确认需求
2. **提方案** — 给出 2-3 个方案和推荐
3. **获得批准** — 用户同意后才能写代码

遇到 bug 时自动切换到系统化调试模式（先找根因，不猜测修复）。

### 为什么需要？

OpenClaw agent 很强但容易冲动：
- 不问就做 — 跳过需求确认直接写代码
- 配置灾难 — 不读就改 openclaw.json
- 重复犯错 — 没有结构化的调试方法
- 覆盖 soul.md — 不理解结构就改

### 工作原理

**反转检测逻辑** — 不检测"是不是任务"（很难），而是检测"明确不是任务的东西"，其余全部走 brainstorming：

| 跳过 | 其他所有 |
|---|---|
| 短回复（ok、好、嗯） | → **默认 brainstorm** |
| 命令（/compact） | |
| 打招呼（你好） | |

错误/bug → 自动切换**调试模式**
涉及配置文件 → 自动注入**安全守则**

### 功能

| 功能 | 说明 |
|---|---|
| **头脑风暴** | 强制：未批准设计前禁止写代码 |
| **系统化调试** | 5 步根因流程，3 次修复失败后停下质疑架构 |
| **配置安全** | 修改 openclaw.json/soul.md/SKILL.md 时自动注入规则 |
| **完成验证** | 没有证据不能声称完成 |
| **计划编写** | 结构化实施计划，无占位符 |
| **阶段追踪** | 自动检测阶段转换 |
| **压缩提示** | 同阶段 6+ 轮后建议 /compact |

### 记忆集成

智能记忆策略：

| 场景 | 召回 | 捕获 |
|---|---|---|
| **已装 openviking 插件** | openviking 负责（不重复） | superpowers 捕获决策 |
| **没装插件，但配了 `memory.baseUrl`** | superpowers 自己召回 | superpowers 捕获决策 |
| **都没有** | 禁用 | 禁用 |

### 安装

```bash
openclaw install openclaw-superpowers
```

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "allow": ["openclaw-superpowers"],
    "entries": {
      "openclaw-superpowers": {
        "enabled": true
      }
    }
  }
}
```

不需要配置记忆 — 自动从 openviking 插件检测。

### 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用/禁用 |
| `autoDetect` | boolean | `true` | 自动检测任务 |
| `memoryEnabled` | boolean | `true` | 捕获决策到 OpenViking |
| `language` | string | `"auto"` | 提示语言 |
| `specDir` | string | `"superpowers/specs"` | 设计文档目录 |
| `planDir` | string | `"superpowers/plans"` | 计划目录 |
| `skipPatterns` | string[] | `[]` | 额外跳过模式 |

### 致谢

- [obra/superpowers](https://github.com/obra/superpowers) — Jesse Vincent 的原版 superpowers
- [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) — 记忆生命周期灵感
- [OpenViking](https://github.com/nicepkg/openviking) — 长期记忆后端

### 协议

MIT
