import type { ItemFields } from "../../contracts/conversation.js";
import type { ItemType } from "../../contracts/protocol.js";
import type { MessageId } from "../../contracts/session.js";

/*
 * The fields an item stands in with when a page leaves its own JSON out (`bodyOmitted`): its type and the type's required fields empty, which a reader takes as "not here"
 * because the item is marked. Shared by the store's pages and the web's commit frames.
 */

const EMPTY_FIELDS: Readonly<Record<ItemType, ItemFields>> = {
  user_message: { type: "user_message", messageId: "" as MessageId },
  assistant_message: { type: "assistant_message", messageId: "" as MessageId },
  reasoning: { type: "reasoning" },
  command: { type: "command", command: "" },
  file_read: { type: "file_read", path: null },
  file_change: { type: "file_change", changes: [] },
  search: { type: "search", scope: "unknown", query: null },
  web: { type: "web", action: "fetch" },
  mcp_tool: { type: "mcp_tool", server: "", tool: "" },
  tool: { type: "tool", name: "" },
  subagent: { type: "subagent", title: "" },
  plan: { type: "plan", steps: [] },
  plan_proposal: { type: "plan_proposal", markdown: "" },
  recap: { type: "recap", summary: "" },
  approval: { type: "approval", subject: "other", title: "", options: [] },
  question: { type: "question", title: "" },
  notice: { type: "notice", severity: "info" },
  error: { type: "error", class: "unknown", message: "" },
  context_event: { type: "context_event", kind: "compaction" },
  switch: { type: "switch", from: { harnessId: "", harness: "" }, to: { harnessId: "", harness: "" }, context: "unknown", session: "unknown" },
  interrupt: { type: "interrupt", by: "hub" },
  delegation: { type: "delegation", to: { harnessId: "", harness: "" }, task: "" },
  artifact: { type: "artifact", kind: "file", name: "" },
};
/** The fields of an item whose JSON was left out. */
export function emptyFields(type: ItemType): ItemFields {
  const fields = EMPTY_FIELDS[type] as ItemFields | undefined;
  return fields ?? { type: "tool", name: "" };
}
