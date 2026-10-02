# Getting Help

HarnessHub is a community-supported open-source project. There is no paid
support and no service-level agreement. This page explains where to ask and
what we can help with.

## Where to ask

| You want to… | Go to |
|---|---|
| Ask a question, get help with setup, or share how you use HarnessHub | [GitHub Discussions](https://github.com/wyzz973/HarnessHub/discussions) |
| Propose an idea or start an RFC pre-discussion | GitHub Discussions, *Ideas* category |
| Report a reproducible bug | [GitHub Issues](https://github.com/wyzz973/HarnessHub/issues/new/choose), using the bug report form |
| Request a feature, a new agent Adapter, or a new provider preset | GitHub Issues, using the matching form |
| Report a security vulnerability | Privately, as described in [SECURITY.md](SECURITY.md). Never in a public issue |
| Report a Code of Conduct violation | Privately, as described in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#how-to-report) |

Questions can be asked in English or Chinese. Issues are for defects and
confirmed requests; usage questions opened as issues are moved to Discussions.

Decisions are recorded only on GitHub. If the project opens other channels
later (for example Discord or a Chinese-language chat group), they are for
conversation and announcements; anything that needs a decision comes back to
an issue or a Discussion.

## What we support

- Installing and running HarnessHub on the supported platforms.
- HarnessHub's own components: the daemon and its shared model gateway, the
  `harnesshub` command line interface (and its optional `hh` alias), the web
  console, the SDKs, official Adapters, and official provider presets.
- How HarnessHub wires an agent to a model: the configuration it writes,
  restoring the original configuration, and drift detection.
- Unexpected behavior where HarnessHub is the likely cause, including requests
  that do not reach the gateway or usage that is recorded incorrectly.

Support targets the latest release. Older versions get help on a best-effort
basis; security fixes follow the version policy in [SECURITY.md](SECURITY.md).

## What we do not support

- **Problems in a third-party agent itself.** If Claude Code, Codex, Gemini CLI,
  or another agent misbehaves in a way that also happens without HarnessHub,
  please report it to that agent's project. We will help you work out which
  side the problem is on.
- **Vendor accounts.** Sign-up, billing, quotas, rate limits, API key issuance,
  regional availability, and account bans are between you and the provider.
- **Reusing subscription logins.** HarnessHub's core uses only the
  authentication methods that providers officially allow. Reusing a
  subscription login, or using reverse-engineered interfaces, is not part of
  the core and is not supported here.
- **The quality of model output.** HarnessHub routes and records model calls;
  it does not control what a model answers.
- **Modified distributions and unofficial forks.** Please ask whoever
  publishes them.
- **The archived competition edition** (the `archive/competition` branch and
  its releases).

## Before you ask

- Search existing [issues](https://github.com/wyzz973/HarnessHub/issues) and
  [Discussions](https://github.com/wyzz973/HarnessHub/discussions).
- Include the HarnessHub version or commit, your operating system and
  architecture, how you installed HarnessHub, and the agent and provider
  involved, with their versions.
- Remove API keys, gateway keys, tokens, and private paths from anything you
  paste. If you are unsure whether something is sensitive, leave it out and say
  so.

---

## 中文摘要

HarnessHub 由社区支持，没有付费支持与服务等级承诺。提问与使用求助请到 [GitHub Discussions](https://github.com/wyzz973/HarnessHub/discussions)（可用中文或英文）；可复现的缺陷、功能需求、新 Adapter 与 provider 预设请求请用 [GitHub Issues](https://github.com/wyzz973/HarnessHub/issues/new/choose) 中对应的表单；安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。支持范围是 HarnessHub 自身的组件与它对 Agent 配置的接线、还原和漂移检测；第三方 Agent 自身的问题、厂商账号（注册、计费、额度、限流、Key 发放、封号）、订阅登录复用、模型输出质量、修改后的发行版与比赛版归档不在支持范围内。提问前请先搜索已有内容，写明版本、平台、安装方式以及涉及的 Agent 与 provider 版本，并删除所有 Key、令牌与私有路径。
