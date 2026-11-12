/*
 * FROZEN COPY (ADR-057 3.6, step-2 plan T4): the content ids a v13 Session refers to, as `contentReferences()` of sqlite-store.ts worked them out at the
 * end of store v13 (commit 1a5f020): the details of its tool calls, the content of its outputs, the attachments of its inputs, and the attachments of the
 * history a branch quotes. The v14 migration works the set out with THIS function before it converts a conversation and holds the references it writes to it
 * (ADR-057 M2: the collector deletes what no reference keeps, and a backup cannot bring that back). Do not edit it.
 */
import type { SessionSnapshot } from "../../../contracts/session.js";

export function legacyContentReferences(state: SessionSnapshot): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const run of state.runs) {
    for (const tool of run.tools ?? []) if (tool.detail !== undefined) referenced.add(tool.detail.id);
    for (const output of run.outputs ?? []) if (output.kind === "content") referenced.add(output.content.id);
    for (const attachment of run.attachments ?? []) referenced.add(attachment.id);
  }
  // A branch quotes the attachments of the history it started from; they stay while the branch exists.
  for (const message of state.origin?.history ?? []) for (const attachment of message.attachments ?? []) referenced.add(attachment.id);
  return referenced;
}
