# HarnessHub RFCs

An RFC (request for comments) is a design proposal for a change that affects
HarnessHub's users, integrators, or contributors in a lasting way. RFCs make
these decisions in public, with time for feedback, before code is written. The
governance context is in [GOVERNANCE.md](../GOVERNANCE.md#rfcs).

## When an RFC is required

- New public interfaces, or breaking changes to them: the REST API, SSE
  events, SDKs, and the `--json` output of the command line interface.
- Changes to configuration formats, persisted data formats, or wire formats.
- The plugin protocol and the Adapter manifest schema.
- The security model: authentication, secret handling, network exposure, and
  the default behavior of wiring writes to user files.
- Adding or removing a top-level package.
- Changes to governance.

## When an RFC is not required

- Bug fixes.
- New Adapters or provider presets that follow the existing schema (use the
  dedicated issue forms instead).
- Documentation.
- Refactoring that does not change behavior.

If you are not sure, ask in an issue or a Discussion before writing an RFC.

## Process

1. **Pre-discussion.** Start a Discussion in the *Ideas* category of
   [GitHub Discussions](https://github.com/wyzz973/HarnessHub/discussions).
   Describe the problem and the direction you have in mind. This is the
   cheapest moment to find out that a proposal overlaps with existing work or
   with the project's non-goals.
2. **Open the RFC pull request.** Copy [0000-template.md](0000-template.md) to
   `rfcs/0000-short-title.md`, fill it in, and open a pull request (a draft is
   fine). Once the pull request exists, rename the file so that its number is
   the pull request number padded to four digits; pull request #123 becomes
   `rfcs/0123-short-title.md`. The pull request gets the `rfc` label. The AI
   maintainer gives initial feedback within 5 business days.
3. **Public discussion.** The RFC stays open for discussion for at least 10
   days. Revise the RFC in the same pull request, and summarize substantive
   changes in a comment so that reviewers can follow them.
4. **Disposition and final comment period.** The AI maintainer proposes a
   disposition (accept, reject, or postpone) with its reasons in the pull
   request. A 7-day final comment period follows. The repository owner can
   veto the disposition.
5. **After the decision.** An accepted RFC is merged with its status set to
   *Accepted*, and a tracking issue is opened and linked from the RFC. A
   rejected or postponed RFC is closed with the reasons recorded in the pull
   request; a postponed RFC can be reopened when circumstances change.
6. **Implementation.** When the accepted RFC is implemented, an architecture
   decision record (ADR) is written in [docs/decisions/](../docs/decisions/README.md)
   using the [ADR template](../docs/templates/adr.md). The RFC records the
   proposal; the ADR records the final decision and its verification
   requirements. When the implementation is complete, the RFC's status becomes
   *Implemented*.

Changing an accepted RFC in substance requires a new RFC that supersedes it.

## Status values

| Status | Meaning |
|---|---|
| Draft | The pull request is open and the RFC is still being written |
| Discussion | The RFC is complete enough for public discussion |
| Final comment period | A disposition has been proposed; 7 days for final comments |
| Accepted | Merged; a tracking issue exists |
| Implemented | Shipped; the ADR is linked from the RFC |
| Postponed | Closed for now; may be reopened |
| Rejected | Closed with reasons recorded in the pull request |
| Superseded | Replaced by a later RFC, which is linked |

## Language

RFCs may be written in English or Chinese. Every RFC must have an English
summary.

## Index

No RFCs have been accepted yet. Accepted RFCs are listed here.

| RFC | Title | Status | Tracking issue | ADR |
|---|---|---|---|---|
