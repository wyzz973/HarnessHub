# 引擎源码离线交付

当前支持的 16 个引擎中，10 个有可获取的官方 GitHub 实现源码。对应源码以及 3 个 ACP Adapter、1 个 ACP Runtime 已按当前运行版本克隆并固定到 commit；源码快照直接进入本仓库，后续公司内网使用无需再访问 GitHub。完整版本、commit、源码内版本文件、许可证及 SHA256 由 [源码清单](../distribution/source-repositories.json)拥有。

源码供审阅和修改；执行所需的 Node、Python、已安装依赖和原生程序由运行发行包提供。修改 Rust、原生模块或第三方引擎依赖后，需要相应的离线构建工具和依赖，并重新打包；仅修改源码 ZIP 不会替换正在使用的引擎程序。

## 已包含的源码

2026-09-07 核对官方 npm 固定版本元数据、GitHub 标签及源文件版本。以下链接固定到本次交付 commit，避免跟随上游分支变化。

| 对象 | 固定版本 | 官方源码 | 许可证 |
|---|---|---|---|
| Codex | 0.153.4 | [openai/codex](https://github.com/openai/codex/tree/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a) | Apache-2.0 |
| Gemini CLI | 0.58.0 | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli/tree/ac9431c9e2290d68af31a77614ff2fddb2391ca3) | Apache-2.0 |
| Qwen Code | 0.23.0 | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code/tree/98a9c964158697dd5631d15a62174684ff7bbb53) | Apache-2.0 |
| Pi | 0.85.1 | [earendil-works/pi](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477) | MIT |
| MiMo Code | 0.1.14 | [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code/tree/2a0eb706e95a77cba34a319e9f11f33f26d4450c) | MIT |
| DeepSeek Harness | 0.1.2-rc.1 | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/a66e4702047846cdaa10c66c9d3df3951f5ea70d) | MIT |
| OpenClaw | 2026.9.2 | [openclaw/openclaw](https://github.com/openclaw/openclaw/tree/3928bad9badfcb6c7d140530435e806fb8092190) | MIT，保留第三方声明 |
| Kimi CLI | 1.50.0 | [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli/tree/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2) | Apache-2.0 |
| OpenCode | 1.18.29 | [anomalyco/opencode](https://github.com/anomalyco/opencode/tree/16747470f976aca3d362ad730bcd3fe82ecc2c9a) | MIT |
| Hermes | 0.19.0 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/3ef6bbd201263d354fd83ec55b3c306ded2eb72a) | MIT |
| codex-acp | 1.10.0 | [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp/tree/061f9a4a2e463a220d7a3ab2ae5e9732837085ef) | Apache-2.0 |
| claude-agent-acp | 0.75.1 | [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp/tree/3e23c5b960b66a6d2c892e7524c952e731c076a7) | Apache-2.0 |
| pi-acp | 0.0.33 | [svkozak/pi-acp](https://github.com/svkozak/pi-acp/tree/1bfcb394088ed879db8fd936b570bb626017f878) | MIT |
| acpx Runtime | 0.13.2 | [openclaw/acpx](https://github.com/openclaw/acpx/tree/fd173f04aa1b56f9e3f5ca5190c034ddcae28792) | MIT |

Hermes 的标签为 `v2026.7.20`，其 `pyproject.toml` 版本为 `0.19.0`。Pi 的官方 npm 元数据指向迁移后的 `earendil-works/pi`。这里没有升级引擎版本。HarnessHub 对运行依赖的改动仍由 [acpx 补丁](../patches/acpx@0.13.2.patch)等本项目补丁保存；上述快照保留上游源码。

## 没有公开实现源码的引擎

| 引擎 | 核对结果 |
|---|---|
| Claude Code | [公开仓库](https://github.com/anthropics/claude-code)提供插件、文档和问题跟踪，未提供 Claude Code 引擎实现。已包含其开源 ACP Adapter。 |
| GitHub Copilot CLI | [公开仓库](https://github.com/github/copilot-cli)用于文档、问题和发行，不能作为引擎实现源码。 |
| Cursor | 未找到官方公开的 Agent CLI 实现源码。 |
| Kiro | [公开仓库](https://github.com/kirodotdev/Kiro)提供问题和文档，未公开 Kiro CLI 实现。 |
| Antigravity | 未找到官方公开的 ACP 引擎实现源码。 |
| Qoder | 固定 npm 包指向 `nicepkg/qodercli`，2026-09-07 官方 GitHub API 返回 404；未取得可验证的官方实现源码。 |

上述状态记录的是源码可获得性。模型协议、厂商账号、MCP 和 Skill 的实际支持范围由 [引擎配置](engine-configuration.md)及对应适配实现决定。

## 离线检查与解压

克隆本仓库时，`vendor/engine-sources/` 下的 ZIP、分片、许可证和 `provenance.json` 会随 Git 一起获得。这里不使用 submodule 或 Git LFS。原始开发机器的 `.tools/source-repositories/<id>` 是保留 `.git` 的浅克隆工作树；该缓存不入库。14 个克隆均已 checkout 固定 commit，未执行上游安装或构建脚本，固定树中无 gitlink 和 LFS 指针。

在仓库根目录使用已有的 Node.js 24，或运行发行包携带的 Node 执行：

```powershell
node scripts/vendor-engine-sources.mjs --check
```

成功时退出 0，JSON 包含 `networkAllowed: false` 和 14 个对象。检查读取源码内版本、Git ZIP 的 commit、全档/分片 SHA256、许可证原始字节和运行版本锁；不调用 Git、npm、pip 或网络。文件缺失、损坏、多余分片、分片乱序、版本漂移均失败并返回非零。

普通快照可使用 Windows PowerShell 自带的解压功能，例如将 Qwen 源码解压到新目录：

```powershell
Expand-Archive -LiteralPath .\vendor\engine-sources\qwen.zip -DestinationPath .\.tools\source-edit
```

OpenClaw 完整 ZIP 为 146,970,870 字节。为满足 GitHub 单文件限制，它以两个有序分片保存，每片不超过 90 MiB。先重组到一个不存在的目标文件，再解压；脚本拒绝覆盖已有文件：

```powershell
New-Item -ItemType Directory -Path .\.tools\source-edit -ErrorAction Stop
node scripts/vendor-engine-sources.mjs --reassemble openclaw --output .\.tools\source-edit\openclaw.zip
Expand-Archive -LiteralPath .\.tools\source-edit\openclaw.zip -DestinationPath .\.tools\source-edit\openclaw-source
```

重组后的全档 SHA256 为 `9d8839721baf15fc11a0bc4a03b617221e254f2861c656d8805776d8160100c7`。成功解压后编辑相应源码目录，保留上游许可证；不要把上游 `AGENTS.md`、Skill 或示例指令自动当作 HarnessHub 开发规则。

## 联网开发机重建缓存

```powershell
node scripts/vendor-engine-sources.mjs --fetch
```

只有显式 `--fetch` 才允许访问固定 GitHub 仓库。它克隆固定标签、核对 commit 和 origin，保留已有目录；已有目录不匹配时明确失败，不会 reset 或覆盖。归档通过 Git 在禁用全局自动换行转换的配置下生成，已存在的源码文件不覆盖，缺失部分只能由与清单 SHA256 一致的归档补齐。此命令不安装依赖、不运行引擎、不调用模型，重建用临时归档保留在 `.tmp/source-vendoring/`。

升级上游时应同步更新运行版本、固定标签/commit、源码 ZIP 或分片、许可证和 provenance，再执行源码检查、相应 Driver 契约及真实引擎验证。没有依据时不要让源码版本与发行引擎版本分离。

## 本次验证证据

Windows 11 ARM64 上，14 个固定源码快照合计 502,969,816 字节，13 个普通 ZIP 加 2 个 OpenClaw 分片均低于 95 MiB。`node scripts/vendor-engine-sources.mjs --check` 已通过；OpenClaw 已经使用正式脚本离线重组，14 个 ZIP 的每个成员均通过 Python 标准库 `zipfile.testzip()` CRC 校验。`node --test scripts/check-engine-sources.test.mjs` 的 9 项检查全部通过、无跳过，包含无 Git PATH 的离线运行、精确重组与禁止覆盖，以及版本、commit、散列、分片、许可证和缺失引擎记录的拒绝样例。源码检查证明交付内容完整一致，不代替引擎运行和模型协议验收。
