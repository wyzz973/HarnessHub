# Changelog

All notable changes to HarnessHub are recorded here. The project follows [Semantic Versioning](https://semver.org/) from 0.1; before 1.0, minor versions may contain breaking changes, which are always listed. Generated entries will come from changesets once the release pipeline exists (milestone M1).

## Unreleased

### Open-source reset (milestone M0)

- HarnessHub becomes an open-source control plane for coding agents under the MIT License. The design is in [docs/proposals/oss](docs/proposals/oss/README.md).
- Removed from the open-source edition: the competition API (Agent gateway interface v1.1), the Windows portable bundle and its distribution manifest, preinstalled tool packs and the office tool pack, third-party engine source archives, the offline development kit, and their release workflows and tests. They remain on the `archive/competition` branch with their published releases.
- `GET /v1/runtime/info` no longer reports `competition` or `competitionEngine`; the default Run deadline is 60 seconds in every mode. `--competition`, `--preinstalled-tool-packs` and `--require-harness-model` are no longer accepted by `src/main.ts`.
- Added the license, governance, security, contribution and community files, an English README, and issue and pull request templates.
