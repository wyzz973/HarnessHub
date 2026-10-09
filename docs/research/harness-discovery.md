# 本机 Harness 检测与适配入口调研

日期：2026-10-09。用户已将优先级调整为先做本机核心链路，平台适配、发布和 Harness 多发行版矩阵延后。

## 1. 别人怎样检测

| 项目 | 所读实现 | 检测与适配方式 | 本项目取舍 |
|---|---|---|---|
| Magpie | internal/agent/agent.go 的 Detected、agents.go、gemini.go | 自定义 detect；配置文件/目录；exec.LookPath。部分同名程序另做身份判断 | 借鉴已知位置与可扩展条目；配置残留只能作为线索，不能代替可执行入口 |
| sandbox-agent | agent-management/agents.rs 的 is_installed、resolve_binary、resolve_agent_process | 托管安装目录优先，再找 PATH；原生程序和 agent_process 分开检查 | 借鉴安装与适配器依赖分离；第一版不管理下载器 |
| acpx | src/agent-registry.ts 的 definitions、inspectAgent、inspectLaunch | 注册表定义 binary/argv、installedArgv、requiredCommands 和本地包；支持外部包装器与 npx fallback | 采用数据化启动配方；不在检测时联网执行包安装 |
| OpenHands | docs/ACP_AGENTS.md 与 SDK registry 说明 | UI 选择条目，后端管理进程；ACP 包装器可在容器预装，再映射实际命令 | 检测和运行发生在网关宿主，前端不自己猜本机安装情况 |

固定来源：

- [Magpie Detected](https://github.com/yetone/magpie/blob/ed31293c0ee1bc57f2ff26b50ebd3876fddd8df9/internal/agent/agent.go)、[条目](https://github.com/yetone/magpie/blob/ed31293c0ee1bc57f2ff26b50ebd3876fddd8df9/internal/agent/agents.go)。
- [sandbox-agent 安装与解析](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/server/packages/agent-management/src/agents.rs)、[ACP registry](https://github.com/rivet-dev/sandbox-agent/blob/d00849b2a3914a9d771f5f4c2b6a6e876e0edf16/sandbox-agent/server/packages/acp-http-adapter/src/registry.rs)。
- [acpx registry](https://github.com/openclaw/acpx/blob/b3cd84337952e0d2cadd094f564612e89d71daa5/src/agent-registry.ts)。
- [OpenHands ACP 接入](https://github.com/OpenHands/OpenHands/blob/7af57f8a54115a84d7215192f822850707369122/docs/ACP_AGENTS.md)。

新增选读文件及 SHA-256 已加入 source-lock.json，仍是所读 commit 的观察，不代表全部源码审计或运行验收。

## 2. 检测不等于已经可执行任务

区分三件事：找到可执行文件候选；找到该 Harness 的控制入口/适配器依赖；协议探测成功并能执行任务。一个叫 codex 的可执行文件仍可能是其他程序，需要后续协议探测确认。

第一版只做前两件，输出 probe=not_run。它不执行被找到的文件、不调用模型、不读取登录或改用户配置，也不自动下载 Adapter。

## 3. 最小检测契约

优先级：显式 executable override → 网关进程 PATH → 有限的已知用户 bin 目录。显式 override 错误时返回该错误，不偷偷回到 PATH。

检查普通可执行文件，支持符号链接并保留入口与解析目标。目录、无执行权限、坏链接和访问失败都可解释。空/相对 PATH 项不隐式搜索当前工作目录。搜索目录去重，配方/参数/描述文件大小有上限。

配方包含 id、名称、原生 binary、protocol、args 以及可选 adapter binary；argv 是数组而非 shell 字符串。内置覆盖 Codex、OpenCode、Claude Code、Gemini CLI、Qwen Code、Pi、OpenClaw、Cursor CLI。自定义 JSON 可追加新条目，无需增加按产品名称判断的业务分支。

Codex 优先描述原生 app-server；OpenCode 等使用内置 ACP；Claude Code 需要本地 claude-agent-acp，其配方不强制要求全局 claude CLI；Pi 描述 RPC 入口。包装器可提供自己的运行时，但存在文件仍不代表依赖完整或协议就绪。这里只报告配方和依赖，具体 Driver 执行是下一切片。

## 4. 范围和验证

本切片在当前宿主验证；不做三平台、多发行版、签名或自动更新。保留实际观察与来源便于未来扩展。

必须覆盖 PATH 优先级、已知目录、显式错误不 fallback、符号链接、目录/不可执行文件、缺 Adapter、重复/自定义条目、未知字段/协议、过大描述文件，以及编译后的 CLI。真实本机扫描与合成 fixture 分开记录，不能把候选统计称为协议接入通过。
