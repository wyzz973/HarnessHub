# 验收：引擎独立配置层

日期：2026-09-05。范围：HH-038；基线 `39aa24308cb77580fbe02c01757bf18d6513d91c` 加本任务未提交变更及前一任务的发现修复。结果：Mac 配置层、组合运行、Keychain 和浏览器保存已验证；各厂商全部版本、远端付费模型和 Windows 未全验收。

## 实现与边界

新增可选 Engine configuration 与能力表，支持独立模型、Provider/API URL/秘密引用、普通环境/秘密映射、便携 Skills、ACP MCP。控制台可编辑、保存、使用标准模板替换固定 Provider launcher，并执行配置/协议检查；“测试模型”使用当前引擎创建普通 Session/Run，打开正式任务记录，实际模型预算和取消由原 Gateway 管理。

Keychain 使用专属 service 与不可变 ID，Swift helper 通过 stdin/pipe 传值，HTTP 只返回引用。env/file 在所属 Worker 解析。Skills 在保存时固定主指令指纹，运行前核对；MCP 的 env/headers 秘密仅在 Worker 内解析后发给所选 ACP 引擎。没有把秘密放进 acpx sessionOptions.env、argv 或 Hub SQLite。

兼容旧 Profile hash 和 version 1 引擎目录；新版写 version 2，旧 Session 仍固定 revision。配置适配表、各引擎未支持组合及使用限制由 [配置说明](../engine-configuration.md)拥有；重要取舍见 [ADR 0006](../decisions/0006-engine-configuration.md)。

## 环境与检查

macOS 26.6.2 arm64；Node 24.20.0、pnpm 10.12.3；acpx 0.13.2，ACP SDK 1.4.0。Mac Keychain helper 由系统 swiftc 编译。命令在仓库根目录执行，`.tools/node/bin` 前置 PATH。

- `pnpm build`：TypeScript 与 Keychain helper 编译通过。
- `pnpm test:unit`：35/35 通过，0 跳过。
- `pnpm test:integration`：73/73 通过，0 跳过。
- `pnpm test:smoke`：3/3 通过，0 跳过。
- `pnpm build:console`、`pnpm typecheck:console`、`pnpm lint`、`pnpm lint:console`：通过。
- `pnpm format:check`：首次发现一个新路由文件格式未统一，格式化后通过；没有更改行为断言。
- `pnpm check:boundaries`：53 个源码文件通过。

[配置单元测试](../../tests/unit/engine-configuration.test.ts)验证 Provider 支持矩阵、普通字段秘密拒绝、URL/进程变量限制、原生配置里的环境引用、Keychain真实创建/读取/删除、Skill内容变更失败。[组合测试](../../tests/integration/engine-configuration.test.ts)从真 Gateway/SQLite/Worker验证两个引擎同名 OPENAI_API_KEY 映射到不同秘密，model与URL分别正确，Skill只在启用侧出现，MCP启停与秘密配置分别下发；SQLite不包含测试秘密值，重启后revision保留；另以真实旧格式数据库验证 version 1→2。原恢复、权限、队列、期限、清理、事件和Workflow测试同时通过。

## 真实 Hermes + 本地模型与 MCP

运行安装在本机的 Hermes Agent 0.12.0（源码 `a0556b861f2667a49ded048c9cfac88defff8c5f`），由正式 Gateway 注册和执行；仅模型服务替换为本地 OpenAI 协议模拟 HTTP 服务，不调用付费模型，不读取真实 API Key。

两套原生配置使用同一个本地模拟 URL、不同 Key；不同 URL 的并行隔离由组合测试验证。首次发现两套 Key 和所配置的 URL 都已到达本地模型服务，但裸模型 ID 被 ACP 拒绝。核对 [Hermes 模型选择源码](https://github.com/NousResearch/hermes-agent/blob/a0556b861f2667a49ded048c9cfac88defff8c5f/acp_adapter/server.py)后，显式转换为 custom:model，重新验证：

| 用例 | 证据 |
|---|---|
| 配置 A | Run `9f7af34d-82b8-410e-863e-45ed5b9cc045` completed，输出 NATIVE_CONFIG_OK；模型请求使用 A 的测试 Key、fixture-model，并包含启用的 Skill 标记。 |
| 配置 B | Run `28a70c2d-329e-4c30-a210-af8528c4478d` completed，输出 NATIVE_CONFIG_OK；使用 B 的测试 Key，同名源/目标不会串用；禁用的 Skill 标记没有出现。 |
| MCP | Run `2ae5ca75-8288-45fb-86e3-9a08e74e7e2a` completed；Hermes经ACP接收stdio MCP，实际执行 configuration_proof 工具，产生 MCP_SECRET_ISOLATED 文件，证明秘密映射被工具进程读到。 |
| 清理 | 上述 Session 显式关闭，Worker leases均为空；专用Gateway关闭。 |

MCP fixture 的第一次生成有换行转义语法错误。该次 Run虽 completed，却没有工具产物，因此不计MCP通过；修复fixture后按实际工具文件确认成功，没有以Agent文本代替证据。

原始本机记录位于忽略目录 `.tmp/configuration-verification/native-uc5iKS`（两个配置）和 `native-jm8BRm`（MCP），包括Gateway SQLite、模型请求摘要和工具结果。摘要只记录测试Key匹配布尔值，不记录真实凭证。

其他Provider映射核对了本地安装源码/文档与 [OpenAI Codex 自定义 Provider](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)、[OpenCode Provider](https://opencode.ai/docs/providers)。Pi使用本机0.85.0的models.json环境插值语法，Gemini0.38.2确认GOOGLE_GEMINI_BASE_URL。其余引擎的任意URL支持不做推断，未适配组合在UI和保存时明确拒绝。

## 浏览器

使用独立Gateway数据目录 `.tmp/configuration-verification/ui-RFLGDw` 与前端3331验证，用户控制台原有引擎配置不被测试替换。真实浏览器完成：选择Hermes适配器/Provider、模型beta、API URL、测试专用新Key、Skill路径和MCP配置→保存；API和SQLite返回新的revision `0d76b9462b30009c0e5f032b914afe9135a374db241cbb283937da2688c3a420`、Keychain引用、Skill SHA-256和MCP字段。

检查连接返回配置解析与ACP initialize通过，并明确modelCalled:false。页面刷新后重新打开，模型beta、Keychain引用和其余字段保持；不返回原Key，浏览器中已没有原值密码输入框。快照在 `.tmp/configuration-verification/browser-persisted.md`。浏览器“测试模型”另创建普通 Session `8bd66965-d9fb-4d0d-9f16-16bb41b7fefe` 与 Run `ca6e3b26-0323-4b77-8f13-bad478af0375`，选中 model-ui-test、以 alpha 执行完成，并导航至对应任务；外部引擎为协议 fixture，不计远端模型通过。浏览器无 console error。测试 Session、临时 Gateway/3331 前端和本次创建的 Keychain 测试项已清理，证据目录保留。

## 未验证项

没有将本地模拟模型结果算作远端API权限、模型质量或额度验证；真实付费模型由用户点击“测试模型”或创建正常任务验证。没有覆盖每个已列适配器的全部安装版本；受账号约束或未实现任意Provider的引擎保留原生配置。Skills附件不是完整版本包，原生技能安装/插件管理未实现；MCP第三方服务和工具正确性需按实例验证。Windows原生行为与非macOS钥匙串保存不属于通过项。协议检查的异常进程崩溃恢复没有独立平台验收，正常和超时清理由其所有者处理。

## 正式控制台交付

核实3184服务无活动Run、两个Workflow均completed后正常重启；升级前数据库备份保存在仅当前用户可读的 `.tmp/configuration-verification/console-before-v2.sqlite`。新版目录为version 2，13个历史revision与12个当前引擎的hash均保留，默认DSH不变。3330正式前端已更新；12行引擎各自显示配置、检查连接、测试模型入口。现场快照在 `.tmp/configuration-verification/production-browser.md`。

收尾增加了协议检查回收忽略SIGTERM孙进程的用例，通过；秘密引用每次准备按来源去重，最多同时解析4项，失败也等待已启动的解析收敛。对配置单元/组合测试重新运行7项，全部通过。最终lint、格式、模块边界、文档与diff检查通过。工作区保留本轮及前一轮发现修复，未提交或推送。
