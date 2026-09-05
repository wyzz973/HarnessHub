# HarnessHub 多 Agent 引擎可替换架构设计

> 本文为初始架构提案，保留参考项目和阅读顺序。2026-09-05 已确认独立 Worker、SQLite 权威存储及 OpenCode → Pi → DSH 接入顺序；后续实施以 [DESIGN.md](DESIGN.md) 为准。下文的纯内存 Session、仅事件流 SPI 和 Phase 4 才补取消/轨迹的安排已被新基线调整。

## 1. 项目目标

HarnessHub 基于 **Agent Gateway + Agent Harness** 架构，实现一个支持多 Agent 引擎快速接入、切换和评测的统一系统。

核心目标：

1. 实现赛题规定的 Agent Gateway API。
2. Windows 10/11 可直接运行。
3. 通过 `AGENT_ENGINE` 环境变量切换 Harness。
4. 至少接入两种不同 Agent Engine。
5. Gateway 不绑定具体 Harness。
6. 通过统一 Driver SPI 快速接入 Pi、OpenCode、Hermes、DSH、Claude Code、Codex 等 Harness。
7. 统一记录 Run / Event / Rollout，支持后续 Benchmark。
8. 利用“每题取多个引擎最高分”的规则，通过多个 Harness 的能力互补提高最终成绩。

---

# 2. 核心设计原则

## 2.1 Gateway 保持稳定

业务系统只调用：

```text
Agent Gateway
```

而不直接依赖：

```text
Pi
OpenCode
Hermes
DSH
Claude Code
Codex
```

即：

```text
业务系统
    │
    ▼
Agent Gateway
    │
    ▼
Engine Manager
    │
    ▼
Driver SPI
    │
    ▼
Agent Harness
```

Harness 可以快速变化，而业务接口保持稳定。

---

## 2.2 Harness 统一通过 Driver 接入

不同 Harness 对外接口可能不同：

```text
ACP
SDK / API
CLI
```

因此定义：

```ts
interface HarnessDriver {

  start(config): Promise<AgentSession>;

  run(
    session: AgentSession,
    request: AgentRequest
  ): AsyncIterable<AgentEvent>;

  cancel(sessionId: string): Promise<void>;

  close(sessionId: string): Promise<void>;
}
```

实现三类 Driver：

```text
HarnessDriver
   │
   ├── ACPDriver
   │
   ├── NativeDriver
   │
   └── CLIDriver
```

原则：

```text
支持 ACP
→ 优先 ACPDriver

存在更稳定的官方 SDK/API
→ NativeDriver

只有 CLI
→ CLIDriver
```

---

# 3. 总体架构

```text
                     评测系统 / 业务系统
                             │
                       Gateway API
                             │
                             ▼
                  ┌────────────────────┐
                  │   Agent Gateway    │
                  │                    │
                  │ 请求转换           │
                  │ Session / Run      │
                  │ Event / Result     │
                  └─────────┬──────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │   Engine Manager   │
                  │                    │
                  │ AGENT_ENGINE       │
                  │ Harness Registry   │
                  └─────────┬──────────┘
                            │
                            ▼
                       Driver SPI
                 ┌──────────┼─────────┐
                 ▼          ▼         ▼
             ACPDriver   Native     CLI
                 │       Driver     Driver
                 │
          ┌──────┼──────────────┐
          ▼      ▼      ▼       ▼
         Pi   OpenCode  DSH   Claude/Codex
          │      │      │
          └──────┼──────┘
                 │
                 ▼
            Model + Tools
                 │
                 ▼
           Windows Sandbox
                 │
                 ▼
             AgentEvent
                 │
                 ▼
          Rollout Recorder
```

整个项目分为两个逻辑部分：

```text
Runtime Plane
→ Harness 怎么运行

Benchmark Plane
→ Harness 到底运行得怎么样
```

---

# 4. Harness Registry

Registry 是 Harness 的“配置表”。

第一版不需要 Nacos / etcd，使用：

```text
YAML / JSON
+
内存 Registry
```

例如：

```yaml
id: opencode
name: OpenCode

driver: acp

command: opencode
args:
  - acp

enabled: true

capabilities:
  session: true
  stream: true
  cancel: true
  tools: true
```

启动：

```text
AGENT_ENGINE=opencode
        │
        ▼
Harness Registry
        │
        ▼
Engine Manager
        │
        ▼
ACPDriver
```

后续新增支持 ACP 的 Harness，理想状态只需增加配置，而不修改 Gateway。

ACP 官方 Registry 已经定义 Agent ID、版本、distribution、command、platform 等结构，HarnessHub 的 Registry Schema 可以在此基础上增加 `driver`、`capabilities`、`priority` 等自身字段。

---

# 5. ACP 接入

ACP 可以简单理解为：

> HarnessHub 与不同 Agent Harness 之间的一套标准通信协议。

类似：

```text
HarnessHub
    │
    │ ACP
    ▼
Claude / Codex / Pi / OpenCode / ...
```

比赛第一版建议使用稳定的 **ACP v1**。官方 TypeScript SDK 已提供标准协议实现；ACP v2 当前仍明确属于 experimental。

推荐：

```text
ACPDriver
    │
    ▼
acpx/runtime
    │
    ▼
ACP
    │
 ┌──┼──────────────┐
 ▼  ▼      ▼       ▼
Pi Codex Claude OpenCode ...
```

OpenClaw 当前的 acpx 集成已经支持 Claude、Codex、Copilot、Cursor、Gemini、Kimi、OpenCode、OpenClaw、Pi、Qwen 等多种 Harness，并提供 Session、模型能力、权限以及 Runtime 接入方式。

但 HarnessHub 不直接绑定 acpx：

```text
HarnessHub
   ↓
ACPDriver
   ↓
acpx/runtime
```

未来如果替换 ACP Runtime，只需要修改 `ACPDriver`。

---

# 6. Session / Run / Event / Rollout

定义：

```text
Session
= 一段连续会话

Run
= 一次 Agent 执行

AgentEvent
= Agent 执行过程中发生的一件事

Rollout
= 一次 Run 的完整执行轨迹
```

例如：

```text
Session S001

 ├── Run 001
 │    ├── RUN_STARTED
 │    ├── TOOL_CALL
 │    ├── TOOL_RESULT
 │    └── RUN_COMPLETED
 │
 └── Run 002
```

统一 Event：

```text
RUN_STARTED

MESSAGE

REASONING

TOOL_CALL
TOOL_RESULT

OBSERVATION

PERMISSION_REQUEST

RUN_COMPLETED
RUN_FAILED
```

Driver 的一个重要职责就是：

```text
Harness 原始事件
       ↓
Driver
       ↓
统一 AgentEvent
```

这样 Gateway、Rollout、Benchmark 都不需要理解某个 Harness 的内部协议。

---

# 7. Windows 支持

Windows 是比赛的一等能力。

需要统一处理：

```text
Process Spawn
PowerShell / cmd
cwd
Environment
Timeout
Cancel
Exit Code
stdout / stderr
进程树清理
```

不能默认：

```text
bash
kill -9
SIGTERM
```

等 Linux 行为。

DSH 已经实现 Windows PowerShell 默认执行能力，以及基于 restricted token + NTFS ACL 的 Windows workspace-write / read-only 沙箱，可以重点参考其 Windows 进程和 Sandbox 实现。

---

# 8. Benchmark Plane

比赛评分规则决定：

> 同一道题多个 Harness 都执行，最终取最高分。

因此最终目标不是找到一个“万能 Harness”，而是提高多个 Harness 的综合覆盖能力。

```text
Dataset
   │
   ▼
Benchmark Runner
   │
 ┌─┼───────────────┐
 ▼ ▼       ▼       ▼
Pi OpenCode Hermes DSH
 │ │       │       │
 └─┼───────┼───────┘
   ▼
Rollout
   │
   ▼
Evaluation
   │
   ▼
Score Matrix
```

最终形成：

| Harness | GUI | Shell | Files | Browser | Coding |
|---|---:|---:|---:|---:|---:|
| Pi | - | - | - | - | - |
| OpenCode | - | - | - | - | - |
| Hermes | - | - | - | - | - |
| DSH | - | - | - | - | - |

重点不是简单判断：

```text
Pi > OpenCode
```

而是：

```text
Pi 能补哪些 OpenCode 的失败任务？

Hermes 又能补哪些 Pi 的失败任务？
```

---

# 9. Codex 必须参考的开源项目

这一部分作为开发阶段的主要参考输入。

## 9.1 `openclaw/acpx`

**优先级：★★★★★**

用途：

> ACP Driver / Runtime 的最重要参考和直接复用对象。

重点研究：

```text
ACP Agent Registry
Session 创建与恢复
Agent Process 启动
Prompt
Cancel
Permission
Runtime Event
Session Store
Agent Capability
```

HarnessHub 第一版优先直接使用：

```text
acpx/runtime
```

不要重新实现完整 ACP Runtime。

OpenClaw 自己也是通过包装 `acpx/runtime` 来增加 Session metadata、lease、cleanup、model scope 等 Gateway 能力的。

Codex 重点参考：

```text
openclaw/acpx

以及：

openclaw/openclaw
└─ extensions/acpx/src/runtime.ts
```

---

## 9.2 `agentclientprotocol/typescript-sdk`

**优先级：★★★★★**

用途：

> ACP 官方协议 SDK。

直接依赖：

```text
@agentclientprotocol/sdk
```

不要：

```text
自己实现 JSON-RPC ACP Protocol
```

重点理解：

```text
initialize
session/new
session/load
session/prompt
session/update
session/cancel

Client / Agent Connection
ACP Event Types
```

第一版锁定 ACP v1。

---

## 9.3 `agentclientprotocol/registry`

**优先级：★★★★☆**

用途：

> Harness Registry Schema 参考。

重点参考：

```text
README.md
agent.schema.json
FORMAT.md
```

主要学习：

```text
Agent ID
Name
Version
Repository

Distribution
command
args

不同平台的安装方式
```

然后 HarnessHub 增加：

```text
driver
capabilities
enabled
priority
runtimeConfig
```

不要完整复制 Registry 服务，只复用其数据模型思想。

---

## 9.4 `openclaw/openclaw`

**优先级：★★★★☆**

用途：

> 重点参考一个成熟 Gateway 如何真正集成 acpx。

不要 Fork 整个 OpenClaw。

重点阅读：

```text
extensions/acpx/src/runtime.ts

docs/tools/acp-agents-setup.md

src/plugin-sdk/acp-runtime.ts
```

特别关注：

```text
ACP Runtime 注册

Session Store

Process Lease

Process Cleanup

Runtime Health / Doctor

Agent Registry

Model Capability

Permission

Timeout
```

OpenClaw 已经把 ACP Runtime 抽象为可注册 backend，并在上层统一暴露 runtime capabilities，这个模式很适合 HarnessHub 的 Driver SPI。

---

## 9.5 `agent-guide/agent-gateway`

**优先级：★★★★☆**

用途：

> Driver SPI、Runtime、Session Pool 的代码结构参考。

不要作为核心依赖，主要“抄架构”。

重点阅读：

```text
docs/architecture/

pkg/acp/runtime

pkg/acp/agentspi

pkg/acp/agent/

pkg/acp/transport
```

它已经拆出了：

```text
Agent Gateway
      ↓
ACP Runtime
      ↓
Agent SPI
      ↓
Codex / OpenCode
```

并实现：

```text
session/new
session/load
session/prompt
session/update
permission
transcript
runtime event
```

和我们要实现的结构非常接近。

建议 Codex：

> 重点参考模块边界和接口设计，不复制整个项目。

---

## 9.6 `deepseek-ai/deepseek-harness`

**优先级：★★★★☆**

用途：

> Windows、Sandbox、Capability、Session、Plugin Architecture 参考。

重点阅读：

```text
docs/capability-seams.md

docs/subsystems/sandbox.md

packages/sandbox/

packages/core/session/

packages/subagent/

examples/acp-agent/
```

重点借鉴：

```text
Windows PowerShell

Windows Sandbox

Session 生命周期

Capability Seam

Permission / Approval

Tool 与 Runtime 解耦
```

DSH 的 capability seam 思想尤其值得参考：

> 调用方只依赖能力接口，而不依赖能力的具体实现。

这和 HarnessHub 的 Driver SPI 思路非常一致。

---

## 9.7 `agentgateway/agentgateway`

**优先级：★★★☆☆**

用途：

> Gateway 本身的架构参考。

不要直接拿来作为 Harness Runtime。

主要学习：

```text
Route
Backend
Policy

Auth
Rate Limit
Timeout
Observability
```

HarnessHub 第一版只需要其中很薄的一部分：

```text
Request
→ Route
→ Engine Backend
```

不要一开始引入它完整的 Kubernetes / Control Plane 能力。

---

## 9.8 `agentclientprotocol/codex-acp`

**优先级：★★★☆☆**

用途：

> 学习“一个非 ACP Harness 怎么被包装成 ACP Harness”。

结构非常典型：

```text
ACP Client
    │
    ▼
codex-acp
    │
    ▼
Codex App Server
```

它负责把 Codex 的：

```text
Shell
File Change
Reasoning
Plan
Permission
MCP
Web Search
Terminal
Usage
```

映射成 ACP Event。官方 ACP 组织目前维护该 Codex adapter。

这个仓库对未来开发自定义：

```text
XxxAgentACPAdapter
```

很有参考价值。

---

## 9.9 `agentclientprotocol/claude-agent-acp`

**优先级：★★★☆☆**

用途和 Codex ACP Adapter 类似：

```text
Claude Agent SDK
       ↓
Claude ACP Adapter
       ↓
ACP
```

用于理解：

> 如何把一个拥有自己 SDK / Runtime 的 Harness 转换成统一 ACP Agent。

官方 ACP 组织目前同时维护 Claude Agent 和 Codex 的 ACP adapter。

---

# 10. 候选 Harness 项目

这些项目主要不是拿来“抄 Gateway”，而是后续接入 Benchmark。

第一批建议：

```text
Pi

OpenCode

Hermes

DSH
```

其中 Hermes 官方仓库：

```text
NousResearch/hermes-agent
```

目前已经具备 CLI、Session、多模型、工具体系以及 Windows Native 支持，可以作为通用 Agent 候选。

DSH：

```text
deepseek-ai/deepseek-harness
```

既是 Harness 候选，同时也是架构参考对象。

Claude Code / Codex 可通过 ACP Adapter 作为第二阶段候选。

---

# 11. Codex 阅读顺序

不要让 Codex 一次阅读所有项目。

建议按照下面顺序：

### 第一步：理解最终目标

阅读：

```text
本 DESIGN.md
+
赛题任务书
+
Gateway 接口规范
```

---

### 第二步：先看最接近最终结构的项目

阅读：

```text
agent-guide/agent-gateway
```

重点理解：

```text
Gateway
Runtime
Agent SPI
Session
Transport
Event
```

---

### 第三步：理解 ACP

阅读：

```text
agentclientprotocol/typescript-sdk
```

然后：

```text
agentclientprotocol/registry
```

---

### 第四步：理解如何同时接很多 Harness

阅读：

```text
openclaw/acpx
```

重点理解：

```text
Agent Registry
Runtime
Session
Process
Event
```

---

### 第五步：看工业级整合方式

阅读：

```text
openclaw/openclaw

extensions/acpx/src/runtime.ts
```

重点看：

```text
OpenClaw Gateway
       ↓
AcpRuntime Interface
       ↓
acpx/runtime
```

---

### 第六步：补 Windows 能力

阅读：

```text
deepseek-ai/deepseek-harness
```

重点：

```text
pwsh
sandbox
session
capability seams
```

---

# 12. 开源复用边界

Codex 开发时必须遵循：

| 项目 | 策略 |
|---|---|
| ACP TypeScript SDK | **直接依赖** |
| acpx/runtime | **优先直接复用，但通过 ACPDriver 隔离** |
| ACP Registry | **借 Schema** |
| OpenClaw | **借 Runtime/Gateway 整合方式** |
| agent-guide/agent-gateway | **借 SPI / Runtime 架构** |
| DSH | **借 Windows / Sandbox / Capability** |
| agentgateway | **借 Gateway 分层** |
| codex-acp / claude-agent-acp | **优先直接使用现成 Adapter** |

禁止为了复用而形成：

```text
HarnessHub
直接强依赖
OpenClaw 内部所有模块
```

正确方式：

```text
HarnessHub
     │
 Driver SPI
     │
 ACPDriver
     │
 acpx/runtime
```

即：

> **借开源实现，但保留自己的核心抽象。**

---

# 13. MVP 技术方案

推荐：

```text
TypeScript + Node.js

Gateway：
Fastify

ACP：
@agentclientprotocol/sdk

ACP Runtime：
acpx/runtime

Registry：
YAML / JSON + Memory

Session：
Memory

Rollout：
JSONL

Benchmark：
Node CLI
```

目录：

```text
harnesshub/
│
├── src/
│   ├── gateway/
│   │
│   ├── engine/
│   │   ├── manager.ts
│   │   └── registry.ts
│   │
│   ├── drivers/
│   │   ├── driver.ts
│   │   ├── acp/
│   │   ├── native/
│   │   └── cli/
│   │
│   ├── runtime/
│   │   ├── session.ts
│   │   ├── run.ts
│   │   └── event.ts
│   │
│   └── rollout/
│
├── engines/
│   ├── opencode.yaml
│   ├── pi.yaml
│   └── dsh.yaml
│
├── benchmark/
│
├── DESIGN.md
│
└── INSTRUCTION.md
```

---

# 14. 开发阶段

## Phase 1：Gateway 骨架

完成：

```text
Gateway API
Harness Registry
AGENT_ENGINE
Driver SPI
Session / Run
```

---

## Phase 2：第一个 ACP Harness

```text
ACPDriver
    ↓
acpx/runtime
    ↓
OpenCode 或 Pi
```

跑通完整任务。

---

## Phase 3：第二个 Harness

要求：

```text
只修改 engines/*.yaml
或增加一个很薄的 Driver

Gateway 业务代码不修改
```

验证“可替换”。

---

## Phase 4：Rollout

完成：

```text
AgentEvent
JSONL Rollout
Cancel
Timeout
Error
Process Cleanup
```

---

## Phase 5：Benchmark

批量运行：

```text
Harness × Model × Task
```

生成：

```text
Score Matrix
Failure Cases
Harness Coverage
```

最后根据实际成绩选择提交的 Harness 组合。

---

# 15. 项目最终定位

HarnessHub 不重新实现一个 Agent Framework。

它解决的是：

```text
业务系统
    │
    ▼
稳定 Gateway
    │
    ▼
Driver SPI
    │
 ┌──┼───────────┐
 ▼  ▼           ▼
ACP Native      CLI
 │
 ▼
快速变化的 Agent Harness
```

核心原则：

> **让 Gateway 保持稳定，让 Harness 自由竞争。**

比赛阶段优先做到：

```text
可运行
可替换
可观测
可评测
Windows 稳定
```

而不是提前建设复杂的分布式 Agent 平台。
