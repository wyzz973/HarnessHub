# Maintainers

This file lists who maintains HarnessHub and the rules used to triage issues
and pull requests. Roles and how they are granted are defined in
[GOVERNANCE.md](GOVERNANCE.md).

## Current maintainers

| Role | Who | Notes |
|---|---|---|
| Owner | [@wyzz973](https://github.com/wyzz973) | Holds all accounts and credentials; final say on merges, releases, governance, licensing, and security advisories |
| AI maintainer | Claude (an AI coding assistant made by Anthropic) | Runs under the owner's authorization. Develops, reviews, triages, and maintains releases, dependencies, and security fixes. Its commits are signed off with the owner's git identity and carry a `Co-Authored-By: Claude … <noreply@anthropic.com>` trailer |

There are no human maintainers and no Adapter stewards yet. If you would like
to become one, see [Roles](GOVERNANCE.md#roles) for the criteria.

### Adapter stewards

None yet. Stewards are listed here with the Adapters they look after, and they
are also credited in the compatibility matrix.

### Emeritus maintainers

None yet.

## Triage rules

The AI maintainer triages issues and pull requests using these rules.

### New issues

1. New issues opened through the issue forms get the `status/needs-triage`
   label.
2. Within 2 business days, every new issue is triaged and gets a first reply.
   Triage means adding one `kind/` label, at least one `area/` label, and one
   `priority/` label, plus `adapter/`, `provider/`, or `platform/` labels when
   they apply. The issue then moves to `status/accepted`, `status/needs-info`,
   or is closed with a reason.
3. A `priority/p0` issue gets a response on the same business day.
4. An issue that stays in `status/needs-info` for 14 days without a reply from
   the reporter is closed. It can be reopened when the information is
   available.
5. Security vulnerabilities reported publicly by mistake are moved to a
   private advisory and the public text is hidden, as described in
   [SECURITY.md](SECURITY.md).

### Priorities

| Label | Meaning |
|---|---|
| `priority/p0` | Data loss, a leaked secret, a user configuration that is damaged and cannot be restored, failure to start on a supported platform, or a security issue of high severity or above |
| `priority/p1` | A main user journey is broken for some users, or a regression compared with the previous release |
| `priority/p2` | A functional defect with a workaround |
| `priority/p3` | Everything else |

Any report of a wiring change that cannot be restored is treated as
`priority/p0`.

### Pull requests

- First-time contributors receive a first response within a median of 3
  business days; all pull requests receive a first response within 5 business
  days at the 90th percentile.
- If the author does not respond for 14 days, the pull request gets one
  reminder; after another 30 days without a response it is closed. It can be
  reopened at any time.
- Large AI-generated pull requests without the evidence fields are closed.
- Merge conditions are listed in
  [GOVERNANCE.md](GOVERNANCE.md#review-and-merge-policy).

### Good first issues

An issue labeled `good first issue` must:

- be completable within one day;
- state acceptance criteria and point to the relevant files;
- name a mentor;
- not touch a security-sensitive path (secrets, gateway authentication,
  wiring writes, the plugin host, or release workflows).

Typical sources are new provider presets, new Adapters that follow the
template, better error messages, and documentation translations. From version
0.2 on, at least 10 good first issues are kept open.

The full label set is defined in [.github/labels.yml](.github/labels.yml).
