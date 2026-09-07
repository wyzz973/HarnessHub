# ADR 0012：开源引擎与公司离线开发包

- 状态：accepted
- 日期：2026-09-07
- 场景：公司 Windows 11 ARM64 无法联网安装，已有私有网关只接受 Chat Completions，且公司源码不能上传。

## 决定

在既有 16 个引擎登记能力之上提供明确的开源发行版：Codex、Gemini、Qwen、Pi、MiMo、DSH、OpenClaw、Kimi、OpenCode、Hermes。实际 clone 并固定这 10 个引擎、3 个 ACP Adapter 和 acpx 的源码 commit；Git 内保存带许可证的 ZIP 和 hash 清单，完整 OpenClaw ZIP 分片以适应 GitHub 单文件限制，不删减上游文件。没有公开实现源码的引擎继续如实登记其边界，不以文档仓库代替实现。

运行包由已准备的固定程序和精确依赖图生成，不在内网运行安装器或从 registry 解析依赖。运行程序、Node/Python/Git、工具、源码归档与 HarnessHub/控制台开发依赖随 Windows ARM64 Release 分发；大体积运行文件不放普通 Git 对象。归档及分片逐字节校验。

`Dev.cmd` 将已校验依赖复制到公司 checkout 后运行其源码构建，不覆盖源码或已有 node_modules；公司额外依赖需在外网重新制备。源码归档不等于所有上游引擎的可重建工具链，Rust/Bun 等编译环境仍需按实际修改另行准备。

公司 Agent 按版本化 Skill 在内网保留公司改动后合并公共历史；公共提交、发行包和验证证据不包含公司代码、模型密钥、数据库或真实运行轨迹。

## 替代方案和后果

仅 clone 或使用 submodule 会让内网仍缺二进制和依赖，不满足免安装。把全部 node_modules 放 Git 会扩大每次变更历史且触及大文件限制。以固定源码归档配独立 Release 运行包承担更多构建/校验工作，换取完整离线文件与可追溯来源。

## 验证要求

源码版本、commit、归档及每片 hash 必须匹配；错误分片、缺件和覆盖必须失败。固定程序通过正式 Gateway/Worker 对本地 Chat/MCP fixture 执行，运行包从隔离目录启动并核对依赖/清理。开发包需在新的公司模拟 checkout 完成离线 typecheck/build。真实公司模型只能由公司内网独立验收，不能用本地 fixture 或外部 DeepSeek 结果代替。
