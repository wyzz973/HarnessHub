# 测试体系与检查门禁

| 项 | 内容 |
|---|---|
| 分类 | 安全与运维 |
| 状态 | 已实现 |
| 验证 | 最近一次本机完整 `pnpm check`（macOS arm64，Node 24.20.0，2026-10-05）通过：工具组 235、单元 993 通过 14 跳过、集成 407 通过 11 跳过、smoke 14、协议 508；每个检查脚本有拒绝样例；CI 在 Ubuntu、macOS 与 Windows 上运行同一 `pnpm check`，只作参考；`test:windows` 未在 Windows 上运行 |
| 对照 Magpie | 对照表没有测试与门禁一行 |
| 权威文档 | [测试与完成要求](../../testing.md)、[测试可靠性](../../testing.md#测试可靠性)、[检查入口与接入顺序](../../testing.md#检查入口与接入顺序)、[假 provider](../../../tools/fake-provider/README.md) |

## 用途

每次改动用同一条 `pnpm check` 在本机证明行为没有退化：从格式、依赖边界、文档链接到真实 SQLite、IPC、HTTP 与官方 SDK 客户端。测试在与开发者环境隔离的沙箱中运行，上游与 Agent 由本机替身代替，默认不消耗真实 API。

## 入口

| 入口 | 用法 |
|---|---|
| 命令行 | `pnpm check`；单组 `pnpm test:tooling\|unit\|integration\|smoke\|protocol`；不属于 `check` 的 `pnpm test:sea`、`pnpm test:conformance`、`pnpm test:real`、`pnpm bench`、`pnpm test:windows` |

## 已实现的能力

- `pnpm check` 依次运行：`check:conflicts`（合并冲突标记）、`check:runtime`（Node 必须是 `.node-version` 的 24.20.0）、`lint`（ESLint，零警告）、`format:check`（Prettier）、`check:boundaries`（包依赖图与导入方向、第三方类型不外泄）、`check:docs`（Markdown 编码、围栏、本地链接与标题锚点）、`check:spdx`（源码文件头的许可证标识）、`check:labels`（标签定义文件）、`pnpm test`、`check:api`（API 文档覆盖与新鲜度）、`check:console`（控制台 lint、类型检查与构建）。任何一步失败即停止并非零退出。
- `pnpm test` 先构建，再依次运行五组：工具组（检查脚本与假 provider 的测试）、单元、集成（真实 SQLite、IPC 与 HTTP 组合）、smoke（编译后的入口）、协议（`openai`、`@anthropic-ai/sdk`、`@google/genai` 固定版本经 `hh serve` 访问白名单模式的假上游，16 个方向、508 个用例）。
- 测试沙箱（[tools/run-tests.mjs](../../../tools/run-tests.mjs)）：测试进程只继承白名单中的系统变量与 `HARNESSHUB_TEST_*` 开关，开发者的 Key、`HARNESSHUB_MODEL*` 与 `AGENT_ENGINE` 不可见；HOME、APPDATA、XDG 与临时目录指向本次运行私有的目录；设置 `HH_OFFLINE=1`；每个用例有超时、整组有总期限，超期时结束整个进程树；结束后临时目录中仍有内容判为资源泄漏并失败。
- `--inventory FILE` 或 `HARNESSHUB_TEST_INVENTORY_DIR` 写出用例清单，[compare-inventory.mjs](../../../tools/compare-inventory.mjs) 比较两份清单的缺少与新增。
- 假 provider（[tools/fake-provider](../../../tools/fake-provider/README.md)）：只在回环监听，以四种协议回答，按字段清单检查每个请求并以协议自己的错误格式拒绝违规字段，记录鉴权结果与违规但不记录提示词、回答或 Key；可配置怪癖与脚本。
- 假代理（[tools/fake-proxy](../../../tools/fake-proxy/index.mjs)）：HTTP CONNECT（TCP 或 TLS）与 SOCKS5 代理、TLS 前端与运行时生成的自签名证书，用于出站代理测试与单可执行文件的命令序列，仓库中不保存私钥。
- 终端界面经注入的终端测试（[tests/support/terminal.ts](../../../tests/support/terminal.ts)），屏幕按写入的转义序列重建，未知序列使测试失败。
- 不属于 `pnpm check` 的组：`test:sea`（构建单可执行文件并经它运行命令序列）、`test:conformance`（本机已安装的真实 Agent 经全局接线在 macOS 沙箱中离线运行，到达假上游）、`test:real`（持有 Key 的人对真实 provider 运行测试、体检与官方 SDK 矩阵）、`bench`（网关附加延迟、单块开销、200 个并发流的 CPU 与内存、账本提交，只报告不设门槛）、`test:windows`（要求本机 Windows，从正式编译产物运行）。
- CI（[ci.yml](../../../.github/workflows/ci.yml)）在三个平台运行 `pnpm check` 并由 `ci-ok` 汇总，上传各平台用例清单；另有 DCO、CodeQL、依赖审查、OpenSSF Scorecard 与标签同步工作流；第三方 Action 按提交 SHA 固定。

## 实现位置

| 部分 | 位置 |
|---|---|
| 源码 | [package.json](../../../package.json)（脚本顺序）、[tools/run-tests.mjs](../../../tools/run-tests.mjs)、[tools/check-conflicts.mjs](../../../tools/check-conflicts.mjs)、[tools/check-runtime.mjs](../../../tools/check-runtime.mjs)、[tools/check-boundaries.mjs](../../../tools/check-boundaries.mjs)、[tools/check-docs.mjs](../../../tools/check-docs.mjs)、[tools/check-spdx.mjs](../../../tools/check-spdx.mjs)、[tools/check-labels.mjs](../../../tools/check-labels.mjs)、[tools/generate-api-docs.mjs](../../../tools/generate-api-docs.mjs) |
| 测试 | 各检查的拒绝样例在 `tools/check-*.test.mjs`，如 [check-run-tests.test.mjs](../../../tools/check-run-tests.test.mjs)、[check-docs.test.mjs](../../../tools/check-docs.test.mjs)、[check-boundaries.test.mjs](../../../tools/check-boundaries.test.mjs)；协议套件在 [conformance](../../../conformance/README.md)；基准在 [tests/perf](../../../tests/perf/README.md) |
| 决策 | [ADR 0001 开发治理](../../decisions/0001-development-governance.md)、[ADR 0029 协议套件](../../decisions/0029-protocol-suite.md)、[10 第 3 节 测试体系](../../proposals/oss/10-engineering.md#3-测试体系) |

## 已知限制与未验证

- 没有控制台的浏览器自动测试；`test:engine`（真实引擎的公共契约）尚未接入；`test:conformance` 只在有沙箱的 macOS 上运行，其他平台整组跳过。
- `bench` 不设门槛，也没有与 main 的历史结果比较；只在 macOS arm64 上测过。
- OSS-013 要求的“全新克隆在 Linux x64、macOS arm64、Windows x64 上通过 `pnpm check`”尚未完成验收；CI 结果不代替本机证据，Windows 的 `test:windows` 没有本机运行记录。
- 协议套件只用 Node 的三个官方 SDK，Vercel AI SDK 与 Python SDK 未覆盖；真实 provider 抽样与直通逐字节语料未做。
- `pnpm check` 不测量覆盖率（[package.json](../../../package.json) 中没有覆盖率脚本）。

## 优化候选

- **现状**：控制台只有构建与契约检查，没有浏览器测试。**方向**：接入 Playwright，从 `hh serve` 的构建产物运行首批旅程，并断言没有页面错误。**依据**：[10 第 3.6 节](../../proposals/oss/10-engineering.md#36-控制台浏览器测试)。
- **现状**：基准只报告。**方向**：保存每次结果并与 main 比较，超过约定幅度时提示或失败。**依据**：[测试与完成要求](../../testing.md#检查入口与接入顺序)中 `bench` 一行、[TODO](../../../TODO.md#m1m5) M1 网关验收的“未验证”。
- **现状**：三平台全新克隆的组合验收未完成。**方向**：在 Linux x64 本机或容器中从全新克隆跑一遍 `pnpm install --frozen-lockfile` 与 `pnpm check` 并记录。**依据**：[TODO](../../../TODO.md#m0-开源准备与重构) OSS-013。
- **现状**：协议套件不含 Vercel AI SDK 与 Python SDK。**方向**：增加这两类客户端的最小矩阵，沿用白名单模式的假上游。**依据**：[TODO](../../../TODO.md#m1m5) M1 网关验收的“未验证”。
