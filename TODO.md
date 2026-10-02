# HarnessHub 开发任务

更新：2026-10-02。本文件拥有开源版的任务、依赖、进度与证据；里程碑定义见 [路线图与迁移](docs/proposals/oss/12-roadmap-migration.md)，架构约束见 [DESIGN.md](DESIGN.md) 与 [开源版设计](docs/proposals/oss/README.md)。

## 使用方式

- `[ ]` 未完成或未验收；只有验收满足、并附提交与证据位置后才改为 `[x]`。受阻时写明实际缺少的条件，独立任务继续推进。
- 每次会话开始先读本文件，确认当前里程碑与未完成项；结束时更新状态与证据（维护方式见 [12 第 5 节](docs/proposals/oss/12-roadmap-migration.md#5-维护模式与工作方式)）。
- 先行修复编号 F01–F28 的问题描述见 [12 第 3 节](docs/proposals/oss/12-roadmap-migration.md#3-先行修复)。

## 需要所有者处理的事项

这些事项需要账户权限或所有者的决定，AI 维护者无法代为完成：

- [x] 开启 Private Vulnerability Reporting（2026-10-02 由 AI 维护者通过仓库 API 开启，`GET /private-vulnerability-reporting` 返回 `enabled: true`）。
- [ ] GitHub Discussions 已于 2026-10-02 开启，现有默认分类 Announcements、General、Ideas、Polls、Q&A、Show and tell；“中文交流”分类只能在网页设置中新建（API 不支持），需所有者添加。
- [ ] 确定行为准则的私密举报渠道（建议一个专用邮箱，写入 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)）。
- [ ] 可选：提供两个历史提交署名的邮箱，用于 `.mailmap` 合并作者身份。
- [ ] M1 首次发布前：注册 npm 包名与 `@harnesshub` 组织；macOS Developer ID 与 Windows 代码签名的取得方式（SignPath Foundation 或 Azure Trusted Signing）。

## M0 开源准备与重构

- [x] **OSS-001 干净快照**：在孤立分支 `oss-main` 移除比赛接口、便携包与发行配置、预装工具包、第三方源码归档、办公包、比赛与离线脚本、比赛工作流及对应测试；代码与测试中的比赛与公司表述改为中性的“上游”。证据：本分支初始提交；`pnpm build`、单元（158 通过、10 跳过）、集成（106 通过、23 跳过、0 失败）、smoke（3/3）、工具（35/35）、lint、格式与边界检查，均在 macOS arm64、Node 24.20.0 上执行。
- [x] **OSS-002 许可证与治理文件**：MIT `LICENSE`、`CODE_OF_CONDUCT.md`（Contributor Covenant 2.1）、`SECURITY.md`、`GOVERNANCE.md`、`MAINTAINERS.md`、`SUPPORT.md`、`TRADEMARKS.md`、`ROADMAP.md`、PR 与 issue 模板、`CODEOWNERS`、标签定义、RFC 流程；英文 README 与中文 README；`CONTRIBUTING.md` 与 `THIRD_PARTY_NOTICES.md` 重写。证据：本分支初始提交；`node scripts/check-docs.mjs` 通过。未验证：issue 表单与 PR 模板在 GitHub 上的渲染。
- [x] **OSS-003 SPDX 文件头**：274 个源文件带 SPDX 标识（自有代码 MIT；Codex 提示词与 AI Elements 组件保留 Apache-2.0；示例工具包载荷的字节由包清单固定，不加头）；`scripts/check-spdx.mjs` 接入 `pnpm check`，拒绝样例见 `scripts/check-spdx.test.mjs`。证据：`pnpm check` 在 macOS arm64 通过。
- [ ] **OSS-004 多包结构**：按 [02 第 8 节](docs/proposals/oss/02-architecture.md#8-模块与依赖规则) 迁入 12 个 pnpm workspace 包，行为不变；迁移前后的用例数逐项对账。
- [ ] **OSS-005 包级边界检查**：依赖方向由检查脚本强制，每条规则附拒绝样例。
- [ ] **OSS-006 测试启动器与环境沙箱**（F01、F02）：清洗 `HARNESSHUB_*` 等产品变量，私有 HOME/USERPROFILE/APPDATA，启动失败时也清理临时目录，默认用例超时。进展：`scripts/run-tests.mjs` 以白名单环境（`scripts/lib/environment.mjs`）与私有目录运行全部测试组，设默认用例超时与整组期限，运行后沙箱临时目录非空即失败；`tests/support/temporary.ts` 在创建时登记删除，23 个测试文件改用它（启动器首次运行即发现 `hh-gateway-hermes-*` 泄漏）。拒绝样例：`scripts/check-run-tests.test.mjs`、`tests/unit/temporary-directory.test.ts`。证据（macOS arm64，2026-10-02）：设置 `AGENT_ENGINE=codex`、`HARNESSHUB_MODEL*`、`HARNESSHUB_RUN_TIMEOUT_MS=1` 后，直接 `node --test` 运行集成与 smoke 组 28 个失败；经启动器运行完整 `pnpm check` 全部通过（工具 48/48，单元 160 通过 10 跳过，集成 106 通过 23 跳过，smoke 3/3），无泄漏。待验收：Linux 与 Windows CI（Windows 专用的 4 个改写文件只在 Windows 上运行）。
- [ ] **OSS-007 CI**（进行中）：Linux x64、macOS arm64、Windows x64 上运行 `pnpm check`；DCO、CodeQL、依赖审查、OpenSSF Scorecard、标签同步工作流；PR 上取消旧运行。证据：`991a8f3`、`b243fb8`；运行 36961535246 三个平台与 `ci-ok` 全部通过（36961337697 中 Windows 失败时 `ci-ok` 同样判失败，修复见 `b243fb8`）；actionlint 1.7.12 无问题；`scripts/check-dco.mjs` 与 `scripts/check-labels.mjs` 带拒绝样例。未验证：DCO 与依赖审查只在 PR 上运行，CodeQL、Scorecard 与标签同步只在 `main` 上运行，均待 OSS-012 后首次触发；启用 merge queue 前需给 CodeQL 与依赖审查加 `merge_group` 触发。按阶段拆分推迟到 PR 墙钟接近 25 min 目标时（当前约 5 min）。
- [ ] **OSS-008 单可执行文件验证**（ADR-P01）：五个平台构建 SEA，记录体积与冷启动 p50/p95，跑通 `serve` 加一次假上游网关调用，按 ADR-P01 的条件给出结论。
- [ ] **OSS-009 假 Agent 与假 provider**：`tools/fake-agent`（可脚本化 ACP 对端）与 `tools/fake-provider`（四协议、黑名单与白名单模式），由现有 fake driver 与 `scripts/mock-chat-provider.mjs` 演进。
- [ ] **OSS-010 M0 先行修复**：F04 构建身份、F05 单实例锁、F06 Windows Worker 环境变量、F07 POSIX setsid 后代、F08 子进程创建收口、F09 SSE 响应头 flush 与协议内保活。每项附 Fails-without 用例，F06 需要 Windows 证据。
- [x] **OSS-011 秘密扫描**：对现有仓库全部 ref 与新 `main` 运行 gitleaks 与 trufflehog；扫描到的真实凭据一律吊销。证据（2026-10-02，gitleaks 8.30.1；trufflehog 3.97.9，`--no-verification`，不向外部服务发送候选值）：`oss-main` 全部历史只有 1 处命中，即 `tests/unit/engine-configuration.test.ts` 中故意构造的 `https://user:password@example.com` 拒绝样例；旧历史 248 处命中，几乎全部位于第三方上游源码归档 `vendor/engine-sources/*.zip`（上游公开仓库自带的测试样例）与锁文件完整性哈希，其余为合成测试 URL，没有 HarnessHub 自有凭据，无需吊销。另在本机构建缓存中发现过开发者令牌，见 OSS-014。
- [x] **OSS-012 切换 main**（ADR-P12）：推送 `archive/competition` 分支与 `competition-final` 标签并核对，再以 `oss-main` 替换远端 `main`；确认旧 Release 仍可下载；开启秘密扫描与推送保护。证据（2026-10-02）：`archive/competition` 与 `competition-final^{}` 在远端指向 `324c9e8` 后，以 `--force-with-lease=main:162f39d` 推送 `247bb0f`（运行 36962276016 三平台通过）；五个旧 Release 的小资产完整下载、大资产范围请求返回 206；秘密扫描与推送保护此前已开启；临时分支 `oss-main` 已从远端删除。之后 `main` 由规则集 24346658 保护：禁止删除与强推、线性历史、只经 PR 以 squash 合并，必需检查 `ci-ok`、`dco`、`codeql`、`dependency-review`。
- [ ] **OSS-014 控制台构建的环境卫生**：Next.js 16 的 Turbopack 持久缓存会记录构建进程的完整环境变量；2026-10-02 在本机 `web/.next/cache` 中发现开发者 shell 中的 GitHub 令牌（缓存已删除，令牌未进入任何提交或发布），并复现：直接执行 `next build` 时，金丝雀变量的名称与值都出现在 `.sst` 缓存文件中。进展：控制台的 `build`/`dev` 经 `scripts/console.mjs` 以白名单环境运行并关闭 Next.js 遥测；构建后在 `web/.next` 中搜索随机金丝雀与凭据形态变量的值，命中即失败且只报告变量名。拒绝样例：`scripts/check-console-environment.test.mjs`。控制台改为 Vite（ADR-P10）后沿用同一包装。
- [ ] **OSS-013 M0 组合验收**：从全新克隆执行 `pnpm install --frozen-lockfile` 与 `pnpm check`，在 Linux x64、macOS arm64、Windows x64 上通过；记录 Scorecard 基线分数。

## M1–M5

各里程碑的交付与验收标准见 [12 第 2 节](docs/proposals/oss/12-roadmap-migration.md#2-里程碑)。进入对应里程碑时，在本文件中展开为带编号的任务。
