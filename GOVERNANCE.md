# HarnessHub Governance

This document describes who maintains HarnessHub, how decisions are made, and
how contributions are reviewed. The design it is based on is
[docs/proposals/oss/11-governance.md](docs/proposals/oss/11-governance.md); the
engineering gates it refers to are defined in
[docs/proposals/oss/10-engineering.md](docs/proposals/oss/10-engineering.md).

## Maintenance model: owner plus AI maintainer

HarnessHub is owned by [@wyzz973](https://github.com/wyzz973). Day-to-day
development, code review, issue triage, releases, and dependency and security
maintenance are carried out by an **AI maintainer**: an AI coding assistant
(currently Claude, made by Anthropic) that works under the owner's
authorization. We state this openly so that users and contributors can judge
the project with full information.

The owner keeps the following powers and does not delegate them:

- veto any merge or release;
- decide governance and licensing;
- hold all accounts and credentials (GitHub, package registries, domains,
  container namespaces, signing);
- grant and revoke write access.

Commits written by the AI maintainer are signed off under the Developer
Certificate of Origin with the owner's git identity, and they carry a
`Co-Authored-By: Claude … <noreply@anthropic.com>` trailer, so they can be told
apart in the history. The AI maintainer holds no long-lived publishing
credentials: releases are meant to be published only by the release pipeline,
using short-lived OIDC credentials and keyless signing.

## Roles

| Role | Permissions | Responsibilities | How the role is granted |
|---|---|---|---|
| Owner | All permissions, accounts, and credentials | Direction, governance, vetoes, final publication of security advisories | [@wyzz973](https://github.com/wyzz973) |
| AI maintainer | Write access granted through the owner's account | Development, review, triage, releases, dependency and security maintenance | Authorized by the owner |
| Adapter steward | Review rights for one agent Adapter's directory | Tracks that agent's version drift and handles its issues | At least 3 merged pull requests to that Adapter, and owner approval |
| Maintainer (human) | Write access for the areas they look after | Review and triage | At least 3 months of sustained contribution and at least 10 merged non-trivial pull requests, and owner approval |
| Contributor | Open issues and pull requests, leave reviews | Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and the evidence requirements | Anyone |

Current holders of each role are listed in [MAINTAINERS.md](MAINTAINERS.md).
Once there are human maintainers or Adapter stewards with write access,
`.github/CODEOWNERS` is split by area; until then every path is owned by the
owner's account, which is used for notifications and vetoes.

## How decisions are made

- Day-to-day decisions are made in public, in issues and pull requests. The AI
  maintainer makes them according to the design documents, the architecture
  decision records (ADRs), and the evidence rules.
- When there is a disagreement, the owner decides. Anyone can ask for an owner
  decision in the issue or pull request concerned.
- Every decision leaves a public record on GitHub. A conversation in a chat
  channel is not a decision until it is written down on GitHub.
- Changes in the scope listed under [RFCs](#rfcs) go through the RFC process.

## Review and merge policy

Review is done by automated gates, an independent AI review, and the owner's
veto, rather than by counting human approvals. An *independent AI review* is a
review session that is separate from the session that wrote the change, runs
read-only, and posts its conclusion in the pull request.

| Change | Merge condition |
|---|---|
| Ordinary change | All required checks pass; the evidence fields in the pull request are complete |
| Public API, configuration, persisted format, plugin protocol, Adapter manifest schema | Additionally: an API report or OpenAPI diff, and one independent AI review. Breaking changes go through an RFC |
| Security-sensitive paths: secrets, gateway authentication, configuration wiring writes, the plugin host, release workflows | Additionally: one independent AI review focused on security; the pull request gets the `security-review` label, and the owner may veto it within 72 hours |
| New runtime dependency | The pull request explains why it is needed, its license, and its maintenance status, and passes dependency review |
| Governance documents, license, Code of Conduct, granting write access | Owner approval |
| Renovate patch and minor updates of development dependencies | Merged automatically once CI passes |

Further rules:

- Pull requests from external contributors are reviewed and merged by the AI
  maintainer under the same rules. Nobody approves their own pull request.
- Pull requests are merged by squash, through the merge queue, after the
  required checks pass.
- Security fixes that must stay confidential are developed and reviewed in a
  private fork (see [SECURITY.md](SECURITY.md)). The public review record is
  added within 2 business days after disclosure.
- Response targets: the median time to first response on pull requests from
  first-time contributors is at most 3 business days, and the 90th percentile
  of the first response on all pull requests is at most 5 business days. If an
  author does not respond for 14 days, we send one reminder; after another 30
  days the pull request is closed. It can be reopened at any time.

### Status of the automation

Several gates described in this document are being set up during milestone
M0 (see [ROADMAP.md](ROADMAP.md)): the DCO check, the pull request evidence
check, the merge queue, CodeQL, dependency review, and label synchronization.
Until a gate actually runs in CI, it is enforced by review only, and we do not
describe it as automated.

## Rules for AI maintenance

To make "maintained by AI" something that can be checked rather than trusted,
the AI maintainer follows these rules, which are backed by CI and the pull
request template:

- Every behavior change comes with a test that fails without the change, or
  with an explanation of why such a test cannot be written and what evidence
  replaces it.
- Every pull request fills in the evidence fields completely.
- Writing a change and reviewing it happen in different sessions.
- Required checks are never skipped or loosened.
- Releases are published only by the pipeline, after all gates pass.
- Matters involving security advisories, licensing, or governance are reported
  to the owner.

## RFCs

An RFC is required for:

- new or breaking changes to public interfaces (REST, SSE, SDKs, and the
  `--json` output of the command line interface);
- changes to configuration, persisted, or wire formats;
- the plugin protocol and the Adapter manifest schema;
- the security model: authentication, secret handling, network exposure, and
  the default behavior of wiring writes to user files;
- adding or removing a top-level package;
- changes to governance.

An RFC is not required for bug fixes, new Adapters or provider presets that
follow the existing schema, documentation, or refactoring that does not change
behavior.

In short: pre-discussion in the Discussions *Ideas* category, a pull request
that adds `rfcs/NNNN-title.md`, initial feedback from the AI maintainer within 5
business days, at least 10 days of public discussion, a proposed disposition
followed by a 7-day final comment period, and an owner veto. Accepted RFCs get
a tracking issue and, during implementation, an ADR. The full process and the
template are in [rfcs/README.md](rfcs/README.md).

## Changing this document

Changes to this document, to [MAINTAINERS.md](MAINTAINERS.md), to the
[Code of Conduct](CODE_OF_CONDUCT.md), to [SECURITY.md](SECURITY.md), or to the
[LICENSE](LICENSE) require owner approval. Changes to the governance model
itself (roles, decision making, the review and merge policy) also go through
the RFC process; routine updates, such as listing a newly approved maintainer
in [MAINTAINERS.md](MAINTAINERS.md), do not.

## Continuity

A single maintainer is a real risk for a project like this. Our response is to
write every process down and automate it, so that a new maintainer, or a new
AI session, can take over from the documents alone: the release runbook, the
triage rules, and the architecture documents are maintained together with the
code. At the end of each milestone, the release notes state the project's
maintenance status honestly.

HarnessHub is released under the [MIT License](LICENSE), so anyone can fork
and continue it.

---

## 中文摘要

- **维护模式**：项目由所有者 [@wyzz973](https://github.com/wyzz973) 拥有；日常开发、评审、分诊、发布与依赖和安全维护由 AI 维护者（在所有者授权下运行的 AI 编码助手，目前为 Anthropic 的 Claude）完成，本文件如实公开这一点。所有者保留否决任何合并与发布、决定治理与许可证、持有全部账户与凭据、授予或收回写权限的权力。AI 维护者的提交以所有者的 git 身份签署 DCO，并带 `Co-Authored-By: Claude … <noreply@anthropic.com>` 标注；AI 维护者不持有长期发布凭据。
- **角色**：所有者、AI 维护者、Adapter 维护人（该 Adapter 有 3 个以上合并 PR 且经所有者同意）、维护者（持续贡献 3 个月以上、合并 10 个以上非琐碎 PR 且经所有者同意）、贡献者。现任人员见 [MAINTAINERS.md](MAINTAINERS.md)。
- **决策方式**：日常决定在 issue 与 PR 中公开作出，由 AI 维护者依据设计文档、ADR 与证据规则决定；有争议时由所有者裁决；即时通讯中的讨论在写回 GitHub 之前不构成决定。
- **评审与合并**：由自动门禁、独立的 AI 审查（与编写会话不同、只读运行、结论写入 PR）与所有者否决权共同完成，按上文表格执行；安全敏感路径另需安全审查并加 `security-review` 标签，所有者可在 72 小时内否决；作者不能批准自己的 PR。文中的部分自动门禁在 M0 期间建立，落地之前只由评审执行，不称为自动化。
- **AI 维护的约束**：每个行为变更都有“无此改动必失败”的测试或无法构造的说明；PR 证据字段完整；编写与审查使用不同会话；不跳过、不放宽必需检查；只由流水线在门禁全部通过后发布；安全公告、许可证与治理事项通知所有者。
- **RFC**：公开接口、配置与持久格式、插件协议与 Adapter 清单 schema、安全模型、顶层包增删与治理变更需要 RFC，流程见 [rfcs/README.md](rfcs/README.md)。
- **持续性**：单人维护是真实风险；应对方式是把流程全部写成文档并自动化，使新的维护者或新的 AI 会话可以按文档接手，并在每个里程碑的发布说明中如实写出维护状况。
