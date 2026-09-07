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

离线归档工具 24 项合成测试通过，无跳过，包含 Windows PowerShell 5.1 逐成员恢复与损坏/错序/漏件/越界/覆盖拒绝，以及真实超过 300 字符的 Windows 源、资产和临时路径。首次实际归档遇到 MAX_PATH 限制，已统一使用扩展绝对路径修复，没有更改系统策略。随后修正 SDK `credentials` 源码目录被误当凭证文件的判定，实际凭证文件与目录内秘密内容仍由反例验证拒绝。全部文件诊断的唯一 PEM 命中是固定 Git 内 GnuTLS DLL 的公开自检常量：11 块均逐字节匹配固定上游源码，仅精确路径与整文件 hash 允许，改字节/换路径/显式秘密仍拒绝。来源与校验规则见 [公开自检审查](../offline-artifacts.md#公开自检材料审查清单)。该工具测试本身不代表最终发行资产已压缩或上传。

公司 Skill 通过 skill-creator 的 quick_validate，并由独立 Agent 以“有未提交鉴权改动、不能上传、无网络安装、Chat-only”场景审阅。已修正 PowerShell 的包路径、源/发行模板位置、总帮助入口，以及公司工作区的 bind/registration 应用流程。离线开发工具 4 项测试通过：现有目录保护、lock/补丁/依赖不匹配拒绝、被篡改 payload 拒绝，以及 web junction 越出 checkout 的拒绝。

## 整体验收进展

`f98e684` 实现阶段的本机 `pnpm check` 退出 0（`.tmp/offline/check-final.log`）：tooling 62 通过/1 跳过，unit 81 通过，integration 107 通过/14 跳过，smoke 2 通过/1 跳过，合计 252 通过、16 跳过。跳过中 12 项为显式 opt-in 的固定引擎用例，已按上一节单独通过；其余 4 项为平台条件跳过。包含 lint、格式、模块边界、文档、40 项 API 同步及生产控制台构建。

使用固定 Node 24.20.0、Corepack 缓存 pnpm 10.12.3 和本次进程 PATH 中的 Corepack shims，`COREPACK_ENABLE_NETWORK=0`。系统全局 pnpm 11 shim 的提示不作为固定工具链证据。

首轮检查与大体积打包并行运行，集成组出现多个短 Run 期限/冷启动超时；该次失败不记为通过。权限过期测试增加正式就绪 barrier 后保留原 1 秒期限。打包结束后，失败组按原期限与默认并发 12/12 通过（`.tmp/offline/failed-integration-recheck.log`），再执行上述完整检查通过。未改变其他用例的断言、期限或默认并发。

最终发行目录有 160,557 个清单文件，共 3,908,040,024 字节；在生产文件冻结后同步 Gateway、MCP 扩展、离线开发工具和 Skill，以及经过正反例验证的 OpenClaw 路径别名、DPAPI 与并发校验修正。`BUILD-INPUTS.json` 标记运行代码提交 `700de35c5794d0039d76a4258f27c484773b089d`；`bundle.json` SHA256 为 `be369dd9515305dd0a23679fc65d48301cb4187202c3958f85cbec16d5797bf4`，逐文件 hash 与构建输入记录可核对。后续测试夹具与文档修改不改变运行包字节。

使用包内 Node、空 NODE_PATH、收窄 PATH 和拒绝代理，在独立 `.tmp/offline-company-checkout` 完成 `Dev.cmd` 对应的 prepare/typecheck/build：均退出 0，分别约 205 秒、6 秒、60 秒。实际生成 Gateway、Windows helper 和生产控制台；人为加入的公司模拟模块源码 SHA256 `ea66677457feb5e339da7c36e0c5612d4b5d2fd0033aae3f29351bf41f4506ca` 保持不变，并出现在编译产物中。没有运行 npm/pip 安装，未使用真实公司源码。日志在 `.tmp/offline/development-acceptance.log` 及 `dev-*.log`。

[首个远端 GitHub Actions](https://github.com/wyzz973/HarnessHub/actions/runs/34133112452)失败，未记为通过。Linux 测试密钥文件权限不符合生产秘密契约，已固定为 0600；Windows 测试使用显式私有目录 ACL。Windows 的 canonical/lexical 路径别名比较问题已由本机真实 junction 复现：修正 OpenClaw 私有配置父目录比较，并让打包校验保留输入路径和 canonical 路径。逃逸目录仍拒绝，没有修改生产秘密校验或放宽断言。相应 tooling 16/16、正式 Chat 集成 1/1，以及类型/格式/lint 通过；最终远端环境结果须由新 CI 单独确认。

`cab06dc` 的 [第二轮 CI](https://github.com/wyzz973/HarnessHub/actions/runs/34133923734)中 Ubuntu 完整检查通过；Windows tooling 66/66 通过，但秘密存储 unit 4 项失败，不记为整体通过。新增回归证明旧 DPAPI 文件依赖继承 ACL，现已在独占创建时原子指定当前用户 owner 和私有 DACL；原读取校验与 5 秒期限不变。相关 16/16 本机测试通过；保留主要错误并加入仅 operation/stage 的脱敏诊断，远端失败根因仍由后续运行确认。

`700de35` 的 [第三轮 CI](https://github.com/wyzz973/HarnessHub/actions/runs/34134984252)中 Ubuntu 完整通过，Windows tooling 66/66、unit 82/83；DPAPI 各项通过，唯一失败是合成 file 凭证的 `read-file/owner` 校验。测试夹具改为显式当前用户 owner、受保护且仅当前用户可访问的原子文件创建，POSIX 仍用 0600；没有修改生产安全判断。包括 Gateway/Worker 的相关 21/21 本机测试通过，并验证读取前后 ACL 不变、额外公开读取权限仍拒绝。该测试修正不改变发行包。

`5b6d089` 的 [完整 CI](https://github.com/wyzz973/HarnessHub/actions/runs/34135677465)两平台均成功，固定 Node 24.20.0、pnpm 10.12.3：Windows Server 2025 x64 为 tooling 66/0、unit 84/0、integration 108/13、smoke 2/1，共 260 通过、14 跳过；Ubuntu 24.04 x64 为 59/7、73/11、95/26、3/0，共 230 通过、44 跳过。斜线后为跳过数。Windows 跳过包含 12 项 opt-in ARM64 固定引擎 MCP、1 项 POSIX 信号集成和 1 项 POSIX recipe smoke；Ubuntu 另有 Windows/macOS 专属分支跳过。两平台 lint、格式、边界、文档、构建、API 与生产控制台检查均通过，不能把跳过当作该平台真实引擎验收。

第一次最终包验收在引擎启动前的全量 hash 阶段因串行小文件读取耗时过长而中止，记录为未通过；没有启动引擎或调用模型。发行校验改为固定最多 16 个并发 reader，并等待每批全部关闭后才成功或抛错。6 项发行 unit 通过；独立真实 fs.open/read/close 验证跨批覆盖、尾文件篡改、首个错误优先、读取异常、元数据失败与关闭延迟，所有场景在 promise 结束时 active reader 为 0。相同 3,072 个小文件、9,407,082 字节，旧实现两次约 2.47/1.20 秒，新实现约 0.35/0.38 秒；性能仅记录观测，不以放宽数据校验实现。

Windows 归档的串行源校验在 38,003/160,558 文件时按计划中止，ZIP 与完成 manifest 均未创建，该次不算通过。真实 256 个小文件共 1.59 MB 的采样显示，open 占 2.324/2.951 秒；据此对源校验和小文件预读加入固定 16 并发，ZIP 仍单线程按排序写入，所有 hash/秘密/变化检查保留。24 项回归验证跨批、1 MiB 边界、有界读取、单 writer、损坏/秘密拒绝及失败时句柄全部关闭；260 个真实临时文件的 1/16 线程观测为 1.4371/0.2252 秒，没有速度阈值断言。

## 最终运行包组合验收

`bundle.json` 保持上述同一 SHA256。`Sj86Co` 私有验收目录记录的正式 `verifyBundle(full=true)` 前后两遍均验证 160,557 文件、3,908,040,024 字节；10 个固定程序版本均通过，实际精确集合含 `bundle.json` 为 160,558 文件、13,389 目录，无链接、额外文件或 state。目录集合 hash 为 `1c9b7149c4da5a9366d7a6a84187e8f468a8c1022ecb6bc8e2d49967ae7aad1b`。

最终证据由相同清单下的正式入口记录组成：`JVp1m5` 中 8 个 ACP 和 Kimi CLI 配置解析通过；`OoBuTX` 补验 OpenClaw 和 Pi，分别约 14.03 秒、0.92 秒。合计 9 个 ACP initialize 与 Kimi CLI 解析成功，探测不调用模型。两种离线工具包实际 install/verify 的 digest 一致，workspace-tools 完成 bind，MCP 命令 canonical 完整路径等于包内 Node，Skill 与工具入口位于经过验证的独立安装目录。

`OoBuTX` 的 Pi Run `dfebe680-baf7-4eb2-ae99-69826935cfd5` 经正式 Gateway/SQLite/Worker 完成，恰好 2 次本地合成 Chat 请求；真实 `workspace_read` 返回仅存在于测试文件中的随机标记，固定 Skill 和 base_directory 出现在模型输入，最终回答标记严格匹配。Session 关闭后，实际 MCP PID 20728 与原生 Pi 父 PID 8484 均确认不存在；9 个所属 Job 命令退出码均为 0，残留进程与清理错误列表为空。结束时文件 metadata、精确文件/目录集合及清单字节未变；最终内容 hash 另由归档逐成员验证，不把复用证据写成重复执行。

失败记录保留且不算通过：验收脚本先后写错 MCP namespaced 名称、用继承 ACL 创建合成凭证、误写 PowerShell 环境变量语法；这些均经独立反例定位后修正，生产包没有因此改变。OpenClaw 首次在归档 I/O 竞争下 45 秒 readiness 到期，最早配置加载已耗约 38 秒；无归档竞争、全新私有 HOME 的独立复验在 11.39 秒 ready、15.97 秒 ACP initialize，正式入口补验亦通过。未延长期限、改用全局缓存或重新安装。

最终归档、恢复和 GitHub Release 结果在完成后补充。

## 限制与环境收尾

没有调用外部模型，未继续使用此前 Codex 登录或 DeepSeek 额度；公司 URL、模型、鉴权和网关源码没有提供，公司真实模型验收仍在内网进行。固定程序 HTTP/SSE 远程 MCP、OAuth/TLS、多模态、加密推理和厂商托管工具不计为已验证。Kimi secretEnv/secretHeaders 明确拒绝，不写入明文充数。

一次 MiMo 原生 `--help` 在个人配置/缓存位置创建了三个目录：`~/.local/share/mimocode`、`~/.config/mimocode`、`~/.cache/mimocode`。限定本次创建范围的回滚被自动审批策略拒绝，未绕过；这些目录没有进入源码、发行包或 GitHub。后续发行验收使用私有 HOME/XDG 及临时状态。
