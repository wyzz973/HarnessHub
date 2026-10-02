# Security Policy

HarnessHub handles provider API keys, issues gateway keys, writes to coding
agents' configuration files, and runs agents unattended. We take reports about
these areas seriously and respond on the schedule below.

## Supported versions

| Version | Security fixes |
|---|---|
| 0.x (before 1.0) | Only the latest released version. Fixes ship as a new release; older 0.x versions are not patched. |
| 1.0 and later | The latest minor version. The previous minor version keeps receiving security fixes for 90 days after the next minor version is released. |
| Archived competition edition (`archive/competition` branch and its `competition-*` / `offline-dev-*` releases) | Not supported. |

HarnessHub has not published a 0.x release yet. Until the first release,
security fixes land on the `main` branch.

## Reporting a vulnerability

**Do not report vulnerabilities in public issues, pull requests, or
Discussions.**

Report privately through GitHub Private Vulnerability Reporting:

<https://github.com/wyzz973/HarnessHub/security/advisories/new>

The project currently has no security email address or PGP key. If you cannot
use GitHub's private reporting, open an issue that only asks for a private
security contact, without any details of the vulnerability.

If a vulnerability is reported publicly by mistake, the maintainers move it to
a private advisory and hide the public text.

Please include as much of the following as you can:

- the HarnessHub version or commit, your operating system and architecture,
  and how you installed it;
- the affected component (see [Scope](#scope));
- steps to reproduce, or a proof of concept;
- the impact you expect, for example which secret can leak or which file can
  be overwritten;
- whether you know of active exploitation;
- whether, and how, you would like to be credited.

Never include real API keys or other live credentials in a report. Use
placeholder or revoked values.

## Scope

In scope, as they exist in this repository and in official release artifacts:

- the daemon, including the shared model gateway and the HTTP API;
- the `harnesshub` command line interface (also installable under the optional
  `hh` alias);
- the web console;
- the SDKs published by this project;
- official agent Adapters and provider presets;
- release artifacts and the `harnesshub self-update` update mechanism.

Out of scope:

- vulnerabilities in third-party coding agents themselves;
- community plugins;
- upstream model providers and their APIs.

For out-of-scope reports, the maintainers help forward the report to the
responsible author or vendor. A community plugin with a confirmed
vulnerability can be removed from the project's plugin registry once that
registry exists.

The threat model and security design are maintained in
[docs/proposals/oss/07-data-security.md](docs/proposals/oss/07-data-security.md#6-威胁模型).

## Response timeline

| Stage | Target |
|---|---|
| Acknowledge the report | 2 business days |
| Initial assessment: whether the issue is valid, and a CVSS v4.0 score | 7 days |
| Fixed release: critical | 7 days |
| Fixed release: high | 14 days |
| Fixed release: medium | 30 days |
| Fixed release: low | Next minor release, at most 90 days |

Apart from the acknowledgement, targets are calendar days counted from the day
the report is received. If we cannot meet a target, we tell the reporter why
and give a new date.

## Handling, CVEs, and disclosure

- The AI maintainer (see [MAINTAINERS.md](MAINTAINERS.md)) triages the report
  and develops the fix. The repository owner confirms the assessment and
  publishes the security advisory.
- Fixes are developed and reviewed in a temporary private fork created from
  the GitHub security advisory. The public review record for such a fix is
  added within 2 business days after disclosure.
- CVE identifiers are requested through GitHub Security Advisories (GitHub is
  a CVE Numbering Authority).
- The patched release and the advisory are published at the same time.
- The default coordinated disclosure period is at most 90 days from the
  report. It is shortened if the vulnerability is being actively exploited,
  and it can be extended by agreement with the reporter when the fix is
  complex.
- With the reporter's consent, we credit them in the advisory.
- Downstream packagers (for example Homebrew or Linux distribution
  maintainers) receive advance notice 3 days before public disclosure. This
  list is kept as small as possible.
- Before 1.0, the project completes a security review against its threat
  model and publishes the conclusions with the 1.0 release notes.

## Bug bounty

HarnessHub does not offer a bug bounty or any paid reward for vulnerability
reports.

---

## 中文摘要

- **支持的版本**：0.x 阶段只修复最新发布的版本；1.0 起修复最新次版本，上一个次版本在新次版本发布后 90 天内仍接收安全修复。比赛版归档（`archive/competition` 分支及其 Release）不再支持。首个 0.x 版本发布前，安全修复直接进入 `main`。
- **报告渠道**：请勿在公开的 issue、PR 或 Discussions 中报告漏洞。使用 GitHub 私有漏洞报告：<https://github.com/wyzz973/HarnessHub/security/advisories/new>。目前没有安全邮箱与 PGP 公钥；无法使用 GitHub 私有报告时，可以开一个只请求私下联系方式、不含任何漏洞细节的 issue。误发的公开报告会被转为私有并隐藏原文。报告中不要包含真实的 API Key。
- **范围**：守护进程（含共享网关与 HTTP API）、`harnesshub` 命令行（`hh` 为可选别名）、控制台、本项目发布的 SDK、官方 Adapter 与 provider 预设、发行产物与 `harnesshub self-update` 更新机制。第三方 Agent 自身、社区插件与上游 provider 的漏洞不在范围内，维护者协助转达给对应作者。
- **时限**（除确认收到外，均为自收到报告之日起的自然日）：确认收到 2 个工作日；初步评估（是否成立与 CVSS v4.0 评分）7 天；修复发布：严重 7 天，高危 14 天，中危 30 天，低危下一个次版本且不超过 90 天。无法按时完成时，会向报告人说明原因并给出新的日期。
- **CVE 与披露**：由 AI 维护者分诊与修复，所有者确认并发布安全公告；修复在 GitHub 临时私有 fork 中开发与评审；通过 GitHub 安全公告申请 CVE；补丁版本与公告同时公开；默认协调披露期最长 90 天，漏洞已被利用时缩短，修复复杂时可协商延长；经报告人同意后致谢；下游打包方在公开前 3 天收到预通知。
- **赏金**：本项目不设漏洞赏金。
