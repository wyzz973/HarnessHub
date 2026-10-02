# 11 开源治理与社区

状态：提案（草案），2026-10-02。许可证与仓库决定见 [ADR 草案](adr-drafts.md)，工程门禁与证据字段见 [10 工程体系](10-engineering.md)，社区指标见 [01 产品定义](01-product.md#7-成功指标)。本文中的邮箱与域名都是占位。

## 1. 许可证

**决定**：项目自有代码采用 MIT 许可证，贡献采用 DCO，不要求 CLA（[ADR-P02](adr-drafts.md#adr-p02-许可证)，所有者于 2026-10-02 决定）。

| 维度 | MIT | Apache-2.0（未采用） |
|---|---|---|
| 专利 | 没有明确的专利条款 | 明确授予专利许可，并有专利报复条款 |
| 贡献的授权 | 由 DCO 补足 | 第 5 条规定入站等于出站 |
| 修改与声明 | 只需保留版权与许可文本 | 修改过的文件须有修改说明，NOTICE 必须随分发保留 |
| 兼容性 | 与 GPL 各版本兼容 | 不能并入 GPLv2-only 项目 |
| 同类项目 | Magpie、acpx、claude-code-router、CC Switch | OpenAI Codex、Gemini CLI |
| 维护成本 | 几乎为零 | 需要维护 NOTICE 与修改说明 |

选择 MIT 的理由：与 Magpie 及同类开源项目一致，使用、分发与二次开发的门槛最低，维护成本几乎为零。代价是没有明确的专利授权与专利报复条款；如果将来企业用户因此提出要求，再评估是否改为 Apache-2.0（需要全部贡献者同意或重新授权，DCO 记录可以支撑这一过程）。从 Apache-2.0 项目（如 Codex 的提示词、Vercel AI Elements）并入的代码继续按其原许可证保留 LICENSE 与 NOTICE，并在 THIRD_PARTY_NOTICES 中登记。

**文件头**：每个源文件以 `SPDX-License-Identifier: MIT` 开头，版权行统一为根目录 `LICENSE` 中的 `Copyright (c) 2026 wyzz973 and HarnessHub contributors`，源文件不写个人版权行，作者信息以 git 历史为准。SPDX 头用于许可证扫描，由 CI 检查（见 [10 第 7 节](10-engineering.md#7-依赖与供应链治理)）。二进制发行包另附按 [07 第 9 节](07-data-security.md#9-许可证合规与第三方声明) 自动生成的 THIRD_PARTY_NOTICES，许可证白名单也由该节规定。

**权属**：所有者 wyzz973 于 2026-10-02 确认现有全部自有代码的权利归其所有，可以按 MIT 发布。现有仓库共 221 个提交，217 个来自所有者的两个署名，4 个来自 github-actions；大量提交由 AI 编码助手在所有者指导下完成。该确认记入许可证 ADR，公开前不再有权属阻断事项。

**第三方组件与 vendor 源码核查**：

| 内容 | 许可证 | 开源版处置 |
|---|---|---|
| `packages/console/components/ui`（shadcn/ui） | MIT | 控制台重写时按需复用，复用则保留许可文本 |
| `packages/console/components/ai-elements`（Vercel AI Elements） | Apache-2.0 | 同上，保留原始声明 |
| `packages/agents/src/configuration/codex-default-instructions.ts`（Codex `rust-v0.153.4` 的提示词原文） | Apache-2.0，附上游 NOTICE | 只在 Codex Adapter 仍需要时保留，并保持原文字节、LICENSE 与 NOTICE；否则删除 |
| `patches/acpx@0.13.2.patch` | acpx 为 MIT | 保留，同时向上游提交，合入后删除补丁 |
| `vendor/engine-sources/`：14 个上游源码归档（acpx、claude-agent-acp、codex-acp、codex、dsh、gemini、hermes、kimi、mimo、openclaw、opencode、pi-acp、pi、qwen），约 480 MB | 各自附 LICENSE 与 provenance | 不迁入公开仓库；它服务于离线比赛交付，开源版不分发任何 Agent |
| `distribution/vendor-notices/`（antigravity、cursor、kiro 为厂商专有条款；kimi、opencode） | 混合 | 删除，理由同上 |
| `packs/office-suite`、`scripts/office-suite`（捆绑多项第三方库，见其 THIRD_PARTY_LICENSES.txt） | 混合 | 移出到独立仓库，许可证在该仓库单独核查 |
| `scripts/prepare-hermes.mjs`、`scripts/prepare-kimi.mjs`（修改第三方二进制） | 不适用 | 删除，开源版不修改、不分发第三方二进制 |
| npm 依赖（Fastify、Ajv、yaml、ACP SDK、acpx 等） | 各自许可证 | 按 07 第 9 节的白名单在 CI 中检查 |
| models.dev 目录快照 | 待核查 | 内置进发行包之前核查许可证与数据条款，并记录来源版本 |
| provider 预设 | 本项目 | 只含端点、模型名、价格等事实数据，注明价格来源，不含厂商 logo |

Adapter 只记录与 Agent 互操作所需的配置位置与格式，配置样例由本项目自行编写，不复制厂商文档原文。

## 2. 贡献流程

**DCO**：每个提交都带 `Signed-off-by`（`git commit -s`），表示贡献者按 [Developer Certificate of Origin 1.1](https://developercertificate.org/) 有权提交这些代码。DCO 检查是必需的合并条件。选择 DCO 而不是 CLA，是因为贡献门槛更低；MIT 本身不规定入站授权，DCO 记录每个贡献者对提交内容的授权声明。代价是项目将来更换许可证需要全部贡献者同意，这一点可以接受。允许使用 AI 辅助，但 DCO 必须由人签署，签署人对内容负责（项目自身由 AI 维护者开发的提交，以所有者身份签署，见第 3 节）；PR 中须勾选是否使用了 AI 辅助，证据要求不因此降低。大批量、没有证据字段的 AI 生成 PR 直接关闭。

**流程**：

1. 非琐碎的改动（行为变化、新功能、超过约 200 行）先开 issue 或 Discussion，确认方向；属于第 3 节 RFC 范围的，先走 RFC。
2. 新 Adapter 与 provider 预设使用专用 issue 模板，按已有 schema 实现，不需要 RFC。
3. 提交 PR（可以是草稿），填写模板，附 changeset。
4. CI 通过后，按下表取得评审批准，进入 merge queue，以 squash 方式合并。

**PR 模板**的各节对应 [10 第 2 节](10-engineering.md#2-代码规范) 定义的证据字段：摘要与关联（Problem、Refs）、行为变化（Behavior）、验证（Verified，分平台）、回归测试（Fails-without）、真实 Agent 与 provider（Real-agent / Real-provider）、兼容性与 changeset（Compatibility）、新增依赖的理由、安全考量（秘密、配置写入、网络暴露）、AI 辅助说明、未验证项（Not-verified）。字段定义只在 10 中维护，模板不另行定义。

**评审规则**：项目采用“所有者 + AI 维护者”的维护模式（第 3 节），评审由自动门禁、独立的 AI 审查与所有者否决权共同完成，不以人数计：

| 改动 | 合并条件 |
|---|---|
| 普通改动 | [10 第 4 节](10-engineering.md#4-ci-与质量门禁) 的全部必需检查通过；证据字段齐全 |
| 公开 API、配置、持久格式、插件协议、Adapter 清单 schema | 另需 API 报告或 OpenAPI 差异，以及一次独立的 AI 审查（与编写者不同的审查会话，只读运行，结论写入 PR）；破坏性变更走 RFC |
| 安全敏感路径：`secrets`、网关鉴权、接线写入、`plugin-host`、发布工作流 | 另需一次以安全为重点的独立 AI 审查；PR 加 `security-review` 标签，所有者在 72 小时内可以否决 |
| 新增运行时依赖 | 在 PR 中说明理由、许可证与维护状况，并通过依赖审查 |
| 治理文档、许可证、行为准则、增加有写权限的人 | 所有者批准 |
| Renovate 开发依赖的补丁与次版本 | CI 通过后自动合并 |

外部贡献者的 PR 由 AI 维护者按同样规则评审与合并，作者不能批准自己的 PR。保密修复的安全补丁在私有 fork 中开发与审查，公开后 2 个工作日内补公开评审记录。评审时间目标：首次贡献者 PR 的首次响应中位数不超过 3 个工作日（01 第 7 节），全部 PR 首次响应的 p90 不超过 5 个工作日。作者 14 天无回应时提醒一次，再过 30 天关闭，可随时重开。

**CODEOWNERS**：初期全部路径归所有者账号，用于通知与否决；出现有写权限的外部维护者后，按领域拆分（设计示意）：

```text
*                              @wyzz973
/packages/agents/adapters/<id>/   @wyzz973 @<adapter-steward>
```

## 3. 治理模型

**维护模式**：项目由所有者 wyzz973 拥有；日常开发、评审、发布与维护由 AI 维护者（在所有者授权下运行的 AI 编码助手，目前为 Claude）完成。`GOVERNANCE.md` 与 README 如实公开这一模式，便于使用者评估。所有者保留以下权力：否决任何合并与发布、决定治理与许可证、持有全部账户与凭据、授予或收回写权限。AI 维护者的提交以所有者的 git 身份签署 DCO，并在提交信息中带 `Co-Authored-By` 标注，可以从历史中区分。

**角色**：

| 角色 | 权限 | 职责 | 产生方式 |
|---|---|---|---|
| 所有者 | 全部权限、账户与凭据 | 方向、治理、否决、安全公告的最终发布 | wyzz973 |
| AI 维护者 | 经所有者账号授权的写权限 | 开发、评审、分诊、发布、依赖与安全维护 | 所有者授权 |
| Adapter 维护人 | 对指定 Adapter 目录的评审权 | 跟进该 Agent 的版本漂移，处理对应 issue | 该 Adapter 有 3 个以上合并 PR，经所有者同意 |
| 维护者（人） | 所负责领域的写权限 | 评审、分诊 | 持续贡献 3 个月以上、合并 10 个以上非琐碎 PR，经所有者同意 |
| 贡献者 | 提交 issue、PR、评审意见 | 遵守行为准则与证据要求 | 任何人 |

**决策方式**：日常决定在 issue 与 PR 中公开进行，由 AI 维护者按设计文档、ADR 与证据规则作出；有争议时由所有者裁决。所有决定都在 GitHub 上留下公开记录，即时通讯中的讨论不构成决定。

**AI 维护的约束**：为了让“由 AI 维护”在质量上可以核查，AI 维护者必须遵守以下规则，由 CI 与模板强制：每个行为变更都有“无此改动必失败”的测试或说明为何无法构造；PR 填写完整的证据字段；编写与审查使用不同的会话；不跳过、不放宽必需检查；发布只能由流水线在全部门禁通过后执行；涉及安全公告、许可证与治理的事项通知所有者。

**RFC 流程**：以下改动需要 RFC：新增或破坏性修改公开接口（REST、SSE、SDK、CLI 的 `--json` 输出）；配置、持久化或线上格式变化；插件协议与 Adapter 清单 schema；安全模型（认证、秘密处理、网络暴露、接线写入用户文件的默认行为）；新增或删除顶层包；治理变更。以下不需要 RFC：缺陷修复、按现有 schema 新增 Adapter 或预设、文档、不改变行为的重构。流程如下：

1. 在 Discussions 的 Ideas 分类做预讨论。
2. 以 `rfcs/NNNN-title.md` 提交 PR，编号取 PR 号；5 个工作日内由 AI 维护者给出初步意见。
3. 公开讨论不少于 10 天。
4. AI 维护者提出处置意见（接受、拒绝、推迟），进入 7 天最终评论期；所有者可以否决。
5. 接受后开跟踪 issue；实现时在 `docs/decisions/` 写 ADR，RFC 记录提案，ADR 记录最终决定与验证要求。沿用现有 [ADR 体系](../../decisions/README.md) 与 [模板](../../templates/adr.md)。

RFC 模板的各节为：摘要、动机、详细设计、公开面变化与兼容性、安全与隐私、考虑过的替代方案、缺点、迁移、测试与验收证据、未决问题、已有做法（如 Magpie 等同类项目）。RFC 可以用中文或英文撰写，但必须有英文摘要。

**持续性**：单人维护是 Magpie 与 HarnessHub 的共同风险（Magpie 的 1066 个提交中有 956 个来自同一作者）。本项目的应对是把流程全部写成文档并自动化，使任何新维护者或新的 AI 会话都能按文档接手：发布手册、分诊手册与架构文档随代码维护；每个里程碑结束时在发布说明中如实写出维护状况。

## 4. 行为准则

采用 Contributor Covenant 2.1 原文作为 `CODE_OF_CONDUCT.md`，中文译文链接官方翻译。适用范围包括 GitHub、Discussions、Discord、中文群组和项目组织的线上线下活动。执行流程：

1. 举报通过 GitHub 私有渠道或行为准则邮箱（`conduct@<项目域名>`，占位）提交，由所有者接收；AI 维护者可以协助整理事实，但处理决定由所有者作出。
2. 2 个工作日内确认收到，14 天内完成调查与决定。
3. 处理措施按 Contributor Covenant 的执行指南分为四级：纠正、警告、临时禁止、永久禁止；书面通知举报人与当事人。
4. 当事人可在 14 天内申诉，由所有者复核。
5. 记录私密保存；每年公开一次只含数量与类别的透明度报告。

## 5. 安全响应

`SECURITY.md` 写明以下内容。

**支持的版本**：0.x 阶段只修复最新版本；1.0 起修复最新次版本，上一个次版本在新次版本发布后 90 天内仍接收安全修复（与 [10 第 5 节](10-engineering.md#5-发布工程) 一致）。

**报告渠道**：首选 GitHub 私有漏洞报告（Private Vulnerability Reporting）；备用邮箱 `security@<项目域名>`（占位），并公布 PGP 公钥。不要在公开 issue 中报告漏洞；误发的公开报告由维护者转为私有并隐藏原文。

**范围**：守护进程、网关、CLI、控制台、SDK、官方 Adapter 与预设、发行产物与 `hh self-update` 更新机制。第三方 Agent 自身的漏洞、社区插件和上游 provider 不在范围内，维护者协助转达给对应作者，必要时从插件注册表下架。

**时限**：

| 阶段 | 时限 |
|---|---|
| 确认收到 | 2 个工作日 |
| 初步评估（是否成立，CVSS v4.0 评分） | 7 天 |
| 修复发布：严重 | 7 天 |
| 修复发布：高危 | 14 天（01 第 7 节） |
| 修复发布：中危 | 30 天 |
| 修复发布：低危 | 下一个次版本，不超过 90 天 |

**CVE 与披露**：通过 GitHub 安全公告申请 CVE（GitHub 是 CNA）。修复在 GitHub 临时私有 fork 中开发与评审，补丁版本发布与公告公开同时进行。默认协调披露期最长 90 天；漏洞已被利用时缩短，修复复杂时可以与报告人协商延长。获得报告人同意后在公告中致谢。下游打包方（Homebrew、发行版维护者）在公开前 3 天收到预通知，名单保持最小。项目暂不设漏洞赏金，`SECURITY.md` 中写明这一点。

**安全响应**：由 AI 维护者负责分诊与修复，所有者负责确认并发布安全公告。威胁模型与安全设计由 [07 数据与安全](07-data-security.md#6-威胁模型) 拥有；1.0 前完成一次针对威胁模型的安全审查，审查结论随 1.0 发布说明公开。

## 6. 社区运营

**渠道**：GitHub Issues 用于缺陷与已确认的需求；GitHub Discussions 分为 Q&A、Ideas（RFC 预讨论）、Show and tell、Announcements 与中文交流五类；Discord 用于实时交流，设英文与中文频道。中文即时群（如微信群）只做通知与答疑转引。所有决定都回到 GitHub 公开记录。1.0 后每月举办一次公开的社区会议，并在 Discussions 发布纪要。

**分诊时限**：新 issue 自动加 `status/needs-triage`；2 个工作日内完成分诊（加上 kind、area、priority 标签）并首次回复；p0 当个工作日响应。`status/needs-info` 超过 14 天无回复即关闭，可以重开。分诊由 AI 维护者执行，分诊规则写在 `MAINTAINERS.md`。

**标签体系**：标签以 `.github/labels.yml` 为唯一来源，由工作流同步。

| 前缀 | 取值 |
|---|---|
| `kind/` | bug、regression、feature、docs、question、chore |
| `area/` | gateway、agents、runtime、console、cli、sdk、plugins、docs、release、ci |
| `adapter/` | 每个 Agent 一个，如 `adapter/codex` |
| `provider/` | 每个预设一个 |
| `platform/` | windows、macos、linux |
| `priority/` | p0：数据丢失、秘密泄露、用户配置损坏且无法还原、受支持平台无法启动、高危及以上安全问题；p1：主要用户旅程对部分用户失效、相对上一版本的回归；p2：有绕过办法的功能缺陷；p3：其他 |
| `status/` | needs-triage、needs-info、accepted、blocked、in-progress |
| 无前缀 | `good first issue`、`help wanted`、`breaking-change`、`security`、`flaky`、`rfc` |

**good first issue**：标为 good first issue 的问题须满足：1 天内可完成、给出验收标准与相关文件位置、指定一名导师、不涉及安全敏感路径。0.2 起始终保持至少 10 个打开的 good first issue，典型来源是新的 provider 预设、按模板新增 Adapter、错误信息改进与文档翻译。

**公开路线图**：GitHub Projects 中的 Roadmap 看板按 M0–M5 分栏，与 [12 路线图与迁移](12-roadmap-migration.md) 一致，每月更新一次；每项链接 RFC 或 issue。看板另列“不做”栏，与 01 的非目标一致。根目录的 `ROADMAP.md` 只放看板链接与更新日期。

**发布说明**：格式与内容由 [10 第 5 节](10-engineering.md#5-发布工程) 规定，每个版本列出首次贡献者。

**贡献者认可**：`MAINTAINERS.md` 列出现任与荣誉维护者；兼容矩阵页署名各 Adapter 维护人；文档站的贡献者页由 git 历史生成；每年发布一篇年度回顾，感谢贡献者。

**社区指标**：每月按 CHAOSS 口径统计首次响应时间、合并时长、活跃贡献者数、贡献者所属组织数与 good first issue 的认领率，发布在 Discussions。

## 7. 商标与品牌

**名称**：产品名 HarnessHub（所有者于 2026-10-02 决定保留）。正式命令名为 `harnesshub`；`hh` 只作为可选短别名，由 `harnesshub alias install` 显式安装，系统包与包管理器默认只安装长名，因为 `hh` 与 HSTR 等已有工具冲突。本提案其余章节为简洁起见写作 `hh`，指的都是同一个命令。

**已知的同名情况**（2026-10-02 核查）：

- GitHub 上存在一个与本项目无关的组织 `HarnessHub`（2026-03 创建），其仓库 `HarnessHub/HarnessHub` 是 Agent 运行环境的打包标准，MIT，命令名为 `harness`，最后推送于 2026-03-20。两者领域相邻，README 与文档站必须写明“与 github.com/HarnessHub 无关”，并在 npm、PyPI、容器命名空间使用带区分度的名称。
- Harness Inc. 是知名的软件交付平台公司，名称中的 “Harness” 存在混淆风险；本项目不申请商标，只做如实描述，不暗示任何关联。
- 开源版沿用所有者账号下的公开仓库 `wyzz973/HarnessHub`，`main` 从干净快照重新开始，比赛版历史保留在 `archive/competition` 分支（[ADR-P12](adr-drafts.md#adr-p12-仓库与历史)）。

**使用政策**（`TRADEMARKS.md`）：以下用法无需许可：如实描述兼容性，如“works with HarnessHub”“HarnessHub 的插件”；未修改的官方产物的再分发。以下用法需要所有者许可：以 HarnessHub 命名修改后的发行版，暗示官方背书，在商业服务名中使用。社区插件可以命名为 `harnesshub-plugin-<名称>`，但不得自称官方。

**第三方商标**：Agent 与厂商名称（Claude Code、Codex、Gemini CLI 等）只做指称性使用，不使用厂商 logo；README 与文档站写明本项目与这些厂商没有隶属或背书关系。与 Magpie 等同类产品的比较必须写明日期与所依据的版本，并附上可核对的出处。

**账户**：GitHub、npm、PyPI、域名与容器命名空间由所有者持有并开启硬件 2FA；发布使用无长期密钥的 OIDC 可信发布与 Sigstore 无密钥签名（[10 第 5 节](10-engineering.md#5-发布工程)），AI 维护者不持有任何长期发布凭据。

## 8. 需要创建的仓库文件清单

阶段：M0 指公开之前；M1–M4 见 [12 路线图与迁移](12-roadmap-migration.md#2-里程碑)。

| 文件 | 负责内容 | 阶段 |
|---|---|---|
| `LICENSE` | MIT 全文 | M0 |
| `THIRD_PARTY_NOTICES.md` | 重写：源码中并入的第三方代码及来源 | M0 |
| `README.md`、`README.zh-CN.md` | 英文为主的项目介绍、状态、快速开始、非隶属声明；中文翻译 | M0 |
| `CONTRIBUTING.md` | 重写：开发环境、DCO、流程、证据字段链接、评审规则 | M0 |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 与执行联系方式 | M0 |
| `SECURITY.md` | 第 5 节全部内容 | M0 |
| `GOVERNANCE.md` | 第 3 节的维护模式、角色、决策与 RFC | M0 |
| `MAINTAINERS.md` | 所有者、AI 维护者与其他维护者、分诊规则 | M0 |
| `TRADEMARKS.md` | 第 7 节的商标政策与所有权承诺 | M0 |
| `SUPPORT.md` | 求助渠道与支持范围 | M0 |
| `ROADMAP.md` | 路线图看板链接 | M0 |
| `AGENTS.md` | 重写：面向人与 AI 编码助手的短规则，链接 CONTRIBUTING 与 10 | M0 |
| `.github/CODEOWNERS` | 第 2 节 | M0 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 第 2 节的模板，各节对应 10 的证据字段 | M0 |
| `.github/ISSUE_TEMPLATE/`（bug、feature、adapter-request、provider-preset、config.yml） | 结构化 issue 表单；config.yml 把安全问题引向私有报告 | M0 |
| `.github/DISCUSSION_TEMPLATE/ideas.yml` | RFC 预讨论模板 | M0 |
| `.github/labels.yml` | 第 6 节的标签体系 | M0 |
| `.github/workflows/`（ci、nightly、release、scorecard、codeql、dependency-review、dco、labels、docs） | 10 第 4、7 节 | M0 起，release 在 M1 |
| `renovate.json` | 10 第 7 节 | M0 |
| `.devcontainer/devcontainer.json`、`.vscode/` | 10 第 8 节 | M0 |
| `.editorconfig`、`.gitattributes`（强制 LF）、`.mailmap`（合并同一人的多个署名） | 基础约定 | M0 |
| `rfcs/README.md`、`rfcs/0000-template.md` | 第 3 节的 RFC 流程与模板 | M0 |
| `docs/decisions/` 新 ADR | 开源转型与 [ADR 草案](adr-drafts.md) 中已采纳的决定 | M0 |
| `.changeset/config.json` | 10 第 5 节的 fixed 组 | M1 |
| `CHANGELOG.md` | changesets 生成；比赛版记录移入归档 | M1 |
| `conformance/README.md` | 一致性套件的用法与兼容级别定义 | M2 |
| `CITATION.cff` | 供评测与研究用户引用 | M3 |
| `docs-site/` | 10 第 6 节；M1 建骨架，M4 补齐 | M1–M4 |
| `.github/FUNDING.yml` | 赞助渠道，确有接收主体后再创建 | M5 |
