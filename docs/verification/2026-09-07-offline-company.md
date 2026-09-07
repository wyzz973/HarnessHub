# 验收：公司 Windows ARM64 开源引擎

日期：2026-09-07。范围：[ADR 0011](../decisions/0011-chat-completions-bridge.md)、[ADR 0012](../decisions/0012-offline-company-edition.md)。环境：Windows 11 ARM64，固定 Node 24.20.0、pnpm 10.12.3；分支 `feat/offline-chat-completions`，公共基线 `1989d224b93f0344cae744444d656ad7519e8398`。公司源码不可上传，本次没有读取或上传公司网关代码。

## 源码与依赖准备

实际 clone 并固定 14 个 GitHub 仓库：10 个引擎、3 个 ACP Adapter、acpx。源码与许可证已提交于 `471dca7`；入库 ZIP/分片总计 502,969,816 字节。OpenClaw 完整归档分为两个小于 100 MiB 的文件，不删上游文件。

`node scripts/vendor-engine-sources.mjs --check` 与固定 clone 复用的 `--fetch` 均退出 0；9 项源码工具测试通过，14 个 ZIP 的每个成员 CRC 验证通过，OpenClaw 正式离线重组通过。`scripts/check-checkout.test.mjs` 以真实 Git autocrlf checkout 验证 LF 和 ZIP 字节保持，并以无属性目录证明会产生 CRLF。

`scripts/prepare-open-source.mjs` 从现有固定准备目录生成新的 10 引擎目录，复制 728 个 npm 组件，输出 `downloads:false`、`modelCalled:false`。首次裁剪发现 npm 包 `string_decoder` 与 Node 内置模块重名导致无法定位，已修 lookup 并加入实际跨目录 require 回归。

## 固定原生引擎

以下全经正式 Gateway、SQLite、Worker 和固定程序，模型请求只到本地合成 Chat Completions。真实 stdio MCP 记录 Unicode 字面参数，工具结果回到模型；Skill 固定内容与 base_directory 出现在模型输入，Session 关闭后 MCP 父/孙进程消失，backend 文件不含合成 MCP 密钥。

| 引擎 | 固定版本 | Chat、Skill、stdio MCP |
| --- | --- | --- |
| Codex | 0.153.4 / codex-acp 1.10.0 | 通过；Responses bridge，正式一次审批 |
| Gemini | 0.58.0 | 通过；Google bridge，工具结果第二轮 |
| Qwen | 0.23.0 | 通过 |
| Pi | 0.85.1 / pi-acp 0.0.33 | 通过；本地扩展注册 |
| MiMo | 0.1.14 | 通过；原生 ERROR 日志保护秘密 |
| DSH | 0.1.2-rc.1 | 通过 |
| OpenClaw | 2026.9.2 | 通过；原生 mcp.servers |
| Kimi | 1.50.0 | 通过；CLI 普通 env，原生非交互自动批准 |
| OpenCode | 1.18.29 | 通过 |
| Hermes | 0.19.0 | 通过；随包 Python x64 仿真 |

另有 Pi 初始化失败时零模型请求、秘密 stderr 不进入公开事件，以及工具执行中取消后领域状态/进程树清理，共 12 个固定程序分支。入口为显式 `HARNESSHUB_TEST_NATIVE_MCP=1` 的 [原生测试](../../tests/integration/native-mcp-engines.test.ts)，默认全仓检查按未启用跳过，不把默认跳过算作这些分支通过。4 个 native MCP 单元测试通过。

桥协议与配置 6 项单元测试，以及独立 MiMo 日志正反例通过。双协议正式 HTTP/SQLite/Worker 集成验证 Skill/MCP 下发、权限、精确文件产物、Session 复用、取消、上游连接与桥端口清理、数据库无密钥。直接 Worker 连续 100 次结果 ACK 紧接下一 Run 回归及原 7 项 WorkerHost 通过。

## 工具与 Skill

离线归档工具 13 项合成测试通过，无跳过，包含 Windows PowerShell 5.1 逐成员恢复与损坏/错序/漏件/越界/覆盖拒绝，以及真实超过 300 字符的 Windows 源、资产和临时路径。首次实际归档遇到 MAX_PATH 限制，已统一使用扩展绝对路径修复，没有更改系统策略。该工具测试本身不代表最终发行资产已压缩或上传。

公司 Skill 通过 skill-creator 的 quick_validate，并由独立 Agent 以“有未提交鉴权改动、不能上传、无网络安装、Chat-only”场景审阅。已修正 PowerShell 的包路径、源/发行模板位置、总帮助入口，以及公司工作区的 bind/registration 应用流程。离线开发工具 4 项测试通过：现有目录保护、lock/补丁/依赖不匹配拒绝、被篡改 payload 拒绝，以及 web junction 越出 checkout 的拒绝。

## 整体验收进展

最终 `pnpm check` 退出 0（`.tmp/offline/check-final.log`）：tooling 62 通过/1 跳过，unit 81 通过，integration 107 通过/14 跳过，smoke 2 通过/1 跳过，合计 252 通过、16 跳过。跳过中 12 项为显式 opt-in 的固定引擎用例，已按上一节单独通过；其余 4 项为平台条件跳过。包含 lint、格式、模块边界、文档、40 项 API 同步及生产控制台构建。

使用固定 Node 24.20.0、Corepack 缓存 pnpm 10.12.3 和本次进程 PATH 中的 Corepack shims，`COREPACK_ENABLE_NETWORK=0`。系统全局 pnpm 11 shim 的提示不作为固定工具链证据。

首轮检查与大体积打包并行运行，集成组出现多个短 Run 期限/冷启动超时；该次失败不记为通过。权限过期测试增加正式就绪 barrier 后保留原 1 秒期限。打包结束后，失败组按原期限与默认并发 12/12 通过（`.tmp/offline/failed-integration-recheck.log`），再执行上述完整检查通过。未改变其他用例的断言、期限或默认并发。

最终发行目录有 160,557 个清单文件，共 3,908,036,314 字节；在生产文件冻结后同步 Gateway、MCP 扩展、离线开发工具和 Skill，并同步经过正反例验证的 OpenClaw 路径别名修正。逐文件 hash 与构建输入记录可核对。

使用包内 Node、空 NODE_PATH、收窄 PATH 和拒绝代理，在独立 `.tmp/offline-company-checkout` 完成 `Dev.cmd` 对应的 prepare/typecheck/build：均退出 0，分别约 205 秒、6 秒、60 秒。实际生成 Gateway、Windows helper 和生产控制台；人为加入的公司模拟模块源码 SHA256 `ea66677457feb5e339da7c36e0c5612d4b5d2fd0033aae3f29351bf41f4506ca` 保持不变，并出现在编译产物中。没有运行 npm/pip 安装，未使用真实公司源码。日志在 `.tmp/offline/development-acceptance.log` 及 `dev-*.log`。

[首个远端 GitHub Actions](https://github.com/wyzz973/HarnessHub/actions/runs/34133112452)失败，未记为通过。Linux 测试密钥文件权限不符合生产秘密契约，已固定为 0600；Windows 测试使用显式私有目录 ACL。Windows 的 canonical/lexical 路径别名比较问题已由本机真实 junction 复现：修正 OpenClaw 私有配置父目录比较，并让打包校验保留输入路径和 canonical 路径。逃逸目录仍拒绝，没有修改生产秘密校验或放宽断言。相应 tooling 16/16、正式 Chat 集成 1/1，以及类型/格式/lint 通过；最终远端环境结果须由新 CI 单独确认。

最终搬迁、归档和远端 CI 结果在完成后补充。

## 限制与环境收尾

没有调用外部模型，未继续使用此前 Codex 登录或 DeepSeek 额度；公司 URL、模型、鉴权和网关源码没有提供，公司真实模型验收仍在内网进行。固定程序 HTTP/SSE 远程 MCP、OAuth/TLS、多模态、加密推理和厂商托管工具不计为已验证。Kimi secretEnv/secretHeaders 明确拒绝，不写入明文充数。

一次 MiMo 原生 `--help` 在个人配置/缓存位置创建了三个目录：`~/.local/share/mimocode`、`~/.config/mimocode`、`~/.cache/mimocode`。限定本次创建范围的回滚被自动审批策略拒绝，未绕过；这些目录没有进入源码、发行包或 GitHub。后续发行验收使用私有 HOME/XDG 及临时状态。
