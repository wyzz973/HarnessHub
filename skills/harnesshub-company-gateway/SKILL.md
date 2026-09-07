---
name: harnesshub-company-gateway
description: 在公司内网修改 HarnessHub，保留公司现有网关并合并离线开源引擎、Chat Completions、MCP 和 Skill 适配；用于没有外网安装条件的 Windows 11 ARM64 交接与验证。
---

# HarnessHub 公司内网交接

公司已经修改过网关，且公司代码不能上传。先保留本地改动，再合并公共适配。公共开发基线为 `1989d224b93f0344cae744444d656ad7519e8398`，适配分支为 `feat/offline-chat-completions`。公司模型服务只接受 Chat Completions；DeepSeek 示例不能代替公司配置。

1. 定位公司 checkout、带历史的本地 Git bundle 和 Windows 11 ARM64 离线发行包。读取公司 checkout 的 AGENTS.md、DESIGN.md 及现有网关说明，核实 HEAD、工作区改动、实际构建入口和运行进程。
2. 按 [合并与离线开发](references/company-integration.md) 保留公司鉴权、路由、模型映射及未提交修改。任何备份、diff、运行轨迹都只留在公司批准的本地位置；不得推送公司源码或请求上传。
3. 按 [协议、工具与验收](references/adaptation-and-verification.md) 配置真实公司 URL、模型和秘密引用，先运行本地协议 fixture，再在公司授权预算内验证真实模型。

Gateway 负责公共 API 与公司鉴权，Driver 负责引擎协议和原生配置，Worker 拥有每次运行的资源与清理，Runtime/Store 保存真实状态。不要在 Gateway 按引擎分支，也不要把外部 SDK 类型带出 Driver。配置变更生成新 revision，并通过新 Session 验证。

源码归档用于查阅和修改；离线包中的程序用于执行。`Dev.cmd` 提供 HarnessHub 与控制台的依赖和构建入口，不包含 Rust、Bun 等所有引擎的完整编译工具链。若修改上游引擎源码，先确认相应离线工具链，再重建程序并更新版本、来源、hash 和验证；仅修改归档不能声称运行程序已经改变。

交付报告列出修改的文件、保留的公司行为、实际命令、证据和未验证项。安装成功、进程退出或 Agent 自称成功均不等于任务达标；本地 fixture 也不能证明公司网关已通过。不要自行扩大公司模型预算。
