# Roadmap

Last updated: 2026-10-02.

HarnessHub is being rebuilt as an open-source control plane for coding agents.
The authoritative plan, including the acceptance criteria of each milestone,
is in [docs/proposals/oss/12-roadmap-migration.md](docs/proposals/oss/12-roadmap-migration.md#2-里程碑).
The scope of each version is defined in
[docs/proposals/oss/01-product.md](docs/proposals/oss/01-product.md#5-版本范围),
and the things the project deliberately does not do are listed in its
[non-goals](docs/proposals/oss/01-product.md#6-非目标).

## Milestones

Milestones are delivered in order. A milestone is complete when its acceptance
criteria pass from the official entry points; finished subtasks alone do not
count.

| Milestone | Version | Theme |
|---|---|---|
| M0 | No public release | Open-source preparation and restructuring: MIT license, workspace and package boundaries, cross-platform CI, governance files, early fixes |
| M1 | 0.1 | Model plane: shared multi-protocol gateway, scoped gateway keys, provider presets, routing groups, usage and cost ledger, system keychain secrets, first signed release |
| M2 | 0.2 | Agent plane on par with Magpie: 12 core Adapters with previewed wiring and byte-exact restore, drift detection, Profiles, Library sync, the new web console |
| M3 | 0.3 | Execution plane: API v1 Sessions and Runs, evidence-based run results, git worktrees, parallel multi-agent runs, TypeScript and Python SDKs, MCP server |
| M4 | 1.0 | Hardening: frozen API, configuration, and plugin protocol, public compatibility matrix, signed releases on all channels, documentation site, security review |
| M5 | 1.x (rolling) | Team and ecosystem: team server, tray app, plugin registry, evaluations, session management, more Adapters. Each item goes through an RFC first |

## No time estimates

The roadmap gives no effort or date estimates. Development and maintenance are
carried out by the AI maintainer under the owner's direction (see
[GOVERNANCE.md](GOVERNANCE.md)), and progress is judged by the acceptance
criteria, not by a calendar.

A public GitHub Projects board that mirrors this roadmap is planned. Until it
exists, this file and the linked plan are the reference.

---

## 中文摘要

路线图以 [12 路线图与迁移](docs/proposals/oss/12-roadmap-migration.md#2-里程碑) 为准，版本范围见 [01 产品定义](docs/proposals/oss/01-product.md#5-版本范围)。里程碑按顺序推进：M0 开源准备与重构（无公开版本）、M1 模型平面（0.1）、M2 对标 Magpie 的 Agent 平面（0.2）、M3 执行平面开源化（0.3）、M4 1.0 加固、M5 1.x 团队与生态（滚动交付，每项先过 RFC）。每个里程碑以验收标准判定完成，不做工时与日期估算。
