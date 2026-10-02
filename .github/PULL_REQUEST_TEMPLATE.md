<!--
Thank you for contributing to HarnessHub.

Before you start, read CONTRIBUTING.md:
https://github.com/wyzz973/HarnessHub/blob/main/CONTRIBUTING.md

- Title: Conventional Commits in English, for example `fix(gateway): keep Retry-After on 429`.
  The title becomes the squash commit title, and the evidence sections below become its body.
- The evidence fields are defined in one place only, section 2 of the engineering design:
  https://github.com/wyzz973/HarnessHub/blob/main/docs/proposals/oss/10-engineering.md
- Keep every heading. Write "n/a" under a section that does not apply to this change.
  "Verified" and "Not-verified" are always required.
- Non-trivial changes (behavior changes, new features, more than about 200 lines) should be
  discussed in an issue or Discussion first. Changes in RFC scope need an accepted RFC.
- Large AI-generated pull requests without evidence are closed.
-->

## Summary

<!-- One or two sentences: what this pull request changes. -->

## Problem

<!-- Required unless the change is mechanical. The observable problem or need, and how to reproduce it. -->

## Behavior

<!-- Required when behavior changes. The observable behavior after this change, including failure paths. -->

## Verified

<!--
Required. Commands you actually ran and their results.
For each platform, say whether it ran in CI, on your machine, or not at all.
-->

- Linux:
- macOS:
- Windows:

## Fails-without

<!--
Required for bug fixes (`kind/bug`, `kind/regression`). Name the test(s) that fail when this change is reverted.
If the failure cannot be reproduced (platform-specific or real-agent-only), explain why and give substitute evidence.
-->

## Real-agent / Real-provider

<!--
Required when touching an Adapter, a driver, or a protocol. Agent or provider name with its pinned version,
or "not run".
-->

## Compatibility

<!--
Required when touching a public surface. Affected API, configuration, persisted format, or plugin protocol;
migration notes; changeset.
-->

## New dependencies

<!--
For each new runtime dependency: why it is needed, how much of our own code it replaces, its license,
its maintenance status, and its size and platform impact. Write "none" if there are none.
-->

## Security considerations

<!-- Check every box that applies. -->

- [ ] Touches secrets or credentials, or could put secrets into logs, errors, or exports
- [ ] Writes to users' or agents' configuration files (wiring)
- [ ] Changes network exposure: listen addresses, authentication, Host/Origin checks
- [ ] Touches a security-sensitive path (secrets, gateway authentication, wiring writes, plugin host, release workflows); this needs the `security-review` label
- [ ] None of the above

<!-- If you checked any box other than "None of the above", describe the risk and how you addressed it. -->

## AI assistance

- [ ] No AI assistance was used
- [ ] AI tools were used; I have reviewed all of the changes and take responsibility for them

<!-- If AI tools were used, name them and describe what they did. The evidence requirements are the same either way. -->

## Not-verified

<!-- Required. What you did not verify, and why. Write "none" if everything was verified. -->

## Refs

<!-- Related issues, RFCs, ADRs, and CI runs. Use "Fixes #123" to close an issue when this merges. -->

## Checklist

- [ ] Every commit has a `Signed-off-by` line (`git commit -s`) certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/). The sign-off is made by a person who takes responsibility for the content, even if AI tools helped.
- [ ] The title follows Conventional Commits and is in English.
- [ ] Documentation is updated in this pull request where behavior or interfaces changed.
- [ ] A changeset is included if this changes the behavior of a published package (an empty changeset for internal-only changes), once changesets are set up.
- [ ] I have read and follow the [Code of Conduct](https://github.com/wyzz973/HarnessHub/blob/main/CODE_OF_CONDUCT.md).
