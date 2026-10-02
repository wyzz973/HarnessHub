# Contributing to HarnessHub

Thank you for considering a contribution. HarnessHub is in its open-source reset (milestone M0); interfaces still change, so please open an issue before large changes.

中文贡献者：下面的规则同样适用，issue 与 PR 可以用中文书写。

## Before you start

- Read the [README](README.md), the [design](docs/proposals/oss/README.md) and [AGENTS.md](AGENTS.md) (short rules for people and AI coding assistants).
- Non-trivial changes (behavior changes, new features, more than about 200 lines) start with an issue or a GitHub Discussion. Changes to public APIs, persistent formats, the plugin protocol, the security model or governance go through an [RFC](rfcs/README.md).
- New agent adapters and provider presets have their own issue templates.

## Development setup

Requirements: Node.js 24.20.0 and pnpm 10.12.3 (`.node-version` pins Node). On macOS the Keychain helper needs the Xcode Command Line Tools; on Windows the native helpers are built with the system .NET Framework.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check          # everything CI runs
```

Choose checks by change with the [verification matrix](docs/testing.md#按变更选择验证). After changing an HTTP route, run `pnpm docs:api` and commit the generated files; `pnpm check:api` rejects stale API documentation.

## Rules that reviews enforce

- Strict TypeScript and ESM; module boundaries are checked by `pnpm check:boundaries` ([development rules](docs/development.md)).
- Every source file starts with `// SPDX-License-Identifier: MIT` (third-party files keep their own identifier); `pnpm check:spdx` enforces it.
- Every behavior change comes with a test that fails without the change, or an explanation of why such a test cannot be written.
- Do not hide failures: no deleting failing tests, loosening assertions, swallowing errors, unexplained retries or skipped required checks.
- Never commit secrets, real run data, machine-local configuration or traces with sensitive content. Secrets are referenced, never stored as values.
- Code and its documentation change together; significant trade-offs get an ADR in [docs/decisions](docs/decisions/README.md).

## Commits and pull requests

- Use Conventional Commits for the subject (`feat(gateway): …`, `fix(runtime): …`) and sign off every commit for the [Developer Certificate of Origin](https://developercertificate.org/): `git commit -s`. The sign-off must be made by a person, who is responsible for the content.
- AI-assisted contributions are welcome; say so in the pull request. The evidence requirements are the same.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): problem, behavior, what you verified and on which platforms, the test that fails without the change, compatibility, and what you did not verify.
- Review and merge rules are defined in [GOVERNANCE.md](GOVERNANCE.md).

## Community

- Questions: GitHub Discussions. Bugs and accepted feature requests: GitHub Issues. See [SUPPORT.md](SUPPORT.md).
- Security issues: report privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
- Everyone participating follows the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
