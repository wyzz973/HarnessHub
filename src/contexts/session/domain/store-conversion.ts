import type { ContentRef } from "../../../contracts/content.js";
import type {
  ContentRefRow, ConvertedRun, HeldItem, ItemFields, NativeFacts, OriginHistoryRow, RunFacts, StorageConversion, StoredOrigin,
} from "../../../contracts/conversation.js";
import type { ItemStatus, ProtocolItem } from "../../../contracts/protocol.js";
import type {
  ForkedMessage, PublicActivity, PublicMessage, PublicNotice, PublicOutput, PublicPlan, PublicRun, PublicTool, RunStatus, SessionId, SessionOrigin,
} from "../../../contracts/session.js";
import { itemStatus, normalizeTool, plainTool, runEnded, runItemStatus, type ToolContext, type ToolDetailInput } from "./protocol/index.js";
import { dispatched } from "./relay/advance.js";

/*
 * The storage conversion of ADR-057 3.6: a Run (the old shape: one `PublicRun` and its one or two messages) as the rows of the new storage, and
 * back. It is NOT the display projection of step 1 (`protocol/project.ts`), which cuts a thinking at 64 KiB, drops the task-list calls, rewrites
 * titles, keeps no status word and reads stored details when it can; this pair loses nothing and reads nothing but its arguments.
 *
 *   TOTAL      it never throws, for any Run whose shape is a `PublicRun`'s (whatever the strings say: empty, NUL, half a surrogate pair, 4 KiB
 *              long or 4 MiB), and it neither limits nor refuses by size or by content.
 *   DETERMINISTIC AND PURE   the same arguments give the same result; no clock, no store, no random, no display name, no stored detail is
 *              read; the arguments are never changed and the result shares their values (nothing is copied, nothing may be changed).
 *   INVERSE    `fromItems(toItems(run, messages, at))` deep-equals `{ run, messages: [user, assistant?] }` for every Run of a conversation the
 *              old validation accepted (parseSession: a message of a Run has the Run's status, the user message is the Run's `input`, a
 *              message carries its Run's id, and the closed words of the types are the types' words). It also holds through the storage: the
 *              items' JSON and the chunks' UTF-8 (a lone surrogate, which a UTF-8 column cannot hold, is carried in `native.surrogates`).
 *
 * WHAT IS STORED
 *   Native facts (`NativeFacts`, in `fields.native`) are what the Harness reported, verbatim: a call's title, kind, name and status word and
 *   exit code, an activity's title/kind/status/detail, a notice's title and detail, a link's name/title/media type. The item's own type, its
 *   status (the protocol's eight words) and the rest of its type's fields (a command, a path, a search) are DERIVED from them by the shared
 *   normalization (`protocol/`) with no stored detail: they can be worked out again, and `fromItems` never reads them. A task-list call
 *   (`todo_write`…) stays a row; a thinking is never cut; a sub-agent told both as a call and as an activity is two items; an error notice
 *   is kept whether or not the Run has an error of its own.
 *   The Run's own facts (`RunFacts`, `run_json`): its message ids, selection, context watermark and sources, backend, cleanup, error, usage
 *   as reported, attachments, timing, retained/reused, relay, relay request, the switch it awaits; the columns hold the rest (status, epoch,
 *   cancel and stop, harness and control, `dispatched`, where it ran, the seq of the user message). `PublicRun.protocol` is the display's and is
 *   never stored. A list that was there and empty (`tools: []`) is told in `facts.emptyLists`; a thinking that was there and empty is a `think:1`
 *   item without text; a plan without steps is a `plan` item with none.
 *
 * THE READ SIDE'S DUTIES. The derived values are what the shared normalization gives with no stored detail, so a call whose command or path only
 *   its stored detail names (a DeepSeek Harness `bash` or `read`, whose title is the tool's name) has an empty command or path here. The reader that has
 *   the detail's head in hand works them out again from the native facts, as the step-1 projection does; the Turns converted from before v14 can also be
 *   brought up to date by one rebuildable backfill that does the same over the stored rows (it belongs to a later line and changes no native fact). Nor does a
 *   row hold the `text` of the protocol items that have one: a user message, a reply and a thinking carry it in their chunks, and so does a notice (the item
 *   fields leave `text` out, a notice's label included, so the label is the notice's chunk and `native.title` keeps it too); the reader puts `text` back in the
 *   wire item, which leaves `protocol.ts` as it is — from `native.title` where there is one (the title of a retry or a review told as an activity may change while it
 *   runs, and a chunk is never changed: it keeps the first title), else from the chunks. `fromItems` reads the label from `native.title`, so the round trip covers it.
 *
 * ORDER AND IDENTITY (ADR-057 3.2): a Run that kept no order is given the fixed one — `user`, `think:1`, the calls in the order of `tools`
 *   (`tool:<id>`), the activities (`activity:<id>`), `plan`, the notices (`notice:<n>`, n from 1), `text:1` (the reply), the outputs
 *   (`output:<n>`) — and `legacyOrder` is set on the row: the order is a fixed arrangement, not what happened first. `seq` runs from 1 over the
 *   items there are. A call that happened inside another (`parentId`) names the item of that call: `tool:` and the parent's id as the Harness gave it.
 *   A message's seq is the item's `createdSeq` (the user message's also the row's `userSeq`); no other item has one: nothing says when it happened. An id a Harness gave twice in one Run (the Runtime never made two; the old validation does not forbid them) takes the
 *   next free `#n` for the item and keeps the given one in `native.id`. An id with half of a surrogate pair in it (a call's, an activity's, or the parent a call names) is the id
 *   as a TEXT column holds it (U+FFFD for each half), and the one the Harness gave is kept in `native.id` (`native.parent` for a parent).
 *
 * WHAT THE CALLER SUPPLIES (`at`) — the facts of the Run that are not in its snapshot, read by the migration (T4) from the event log and the
 *   relay's rows, never worked out here:
 *     `endedSeq`   the seq of the event that ended the Run, in three levels: the first `run.ended` of the Run, else the first `session.recovered` that
 *                  names it in `unknownRunIds` or `cancelledRunIds`, else (a Run migrated from v12) the `seq` of its `relay_index` row; none of them:
 *                  leave it out, and the reader takes the Run as ABOVE the relay's mark (never 0, never skipped). It is not the conversation's `lastSeq`.
 *     `isCommand`  the Run was a native command: a `run.native_command` event names it (or, for a Run migrated from v12 with no event, its index row
 *                  has a `commandEffect`). Not the same as having an effect: a command whose effect cannot be read is `isCommand` with no effects.
 *     `commandEffect`  the effect the command was read with (`run.native_command.contextEffect`, else the index row's); `settledEffect` the one its end
 *                  settled (`run.ended.contextEffect`). Leave both out for a Run that is no command.
 *     `acknowledgedBy` for an `unknown` Run: the switch that acknowledged keeping it — an effective switch whose `acknowledgedUnknown` has it or, in
 *                  a conversation from before v13, whose `sourceRunIds` has it (not "an ordinal at or below its sources": a Run that queued while the
 *                  switch was asked for is skipped by `sourceRunIds`, and a Run that ended unknown after it is not acknowledged by it).
 *   Only `sessionId` and `ordinal` (the index of the Run in the conversation's `runs`) are required.
 *
 * Origins have a pair of their own (`originToRows`, `originFromRows`): the history a branch or an import quotes is stored as it is, row by row.
 */

/** Everything `toItems` takes beyond the Run and its messages (see above). */
export type ConversionAt = Parameters<StorageConversion["toItems"]>[2];
export type Turn = ToolContext["turn"];

// ---------------------------------------------------------------------------------------------------------------------------------
// Text a UTF-8 column holds
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * A text as the chunks of `item_text` can hold it. UTF-8 cannot spell half of a surrogate pair, and SQLite stores one as U+FFFD (checked on the
 * engine: tests/property/store-conversion.test.ts), so each lone surrogate becomes U+FFFD — one unit for one, so the indexes stay — and `marks`
 * says which unit stood where. A text of well-formed UTF-16 (nearly every text) is returned as it is, with no marks.
 */
export function sound(value: string): { readonly text: string; readonly marks: readonly (readonly [number, number])[] } {
  // With the `u` flag a pair is one code point, so the class matches a lone surrogate only: a well-formed text has none.
  if (!/[\ud800-\udfff]/u.test(value)) return { text: value, marks: [] };
  const marks: [number, number][] = [];
  let text = "", from = 0;
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit <= 0xdbff) { const next = at + 1 < value.length ? value.charCodeAt(at + 1) : 0; if (next >= 0xdc00 && next <= 0xdfff) { at++; continue; } }
    text += value.slice(from, at) + "\ufffd"; from = at + 1; marks.push([at, unit]);
  }
  return { text: text + value.slice(from), marks };
}
/** The text of an item as it was: its chunks joined, the lone surrogates it carries put back. A mark that does not fit the text is left alone, never thrown at. */
export function restored(item: HeldItem): string {
  const joined = item.text.length === 1 ? item.text[0]! : item.text.join(""), marks = item.fields.native?.surrogates;
  if (marks === undefined || marks.length === 0) return joined;
  let text = "", from = 0;
  for (const [index, unit] of marks) {
    if (!Number.isInteger(index) || !Number.isInteger(unit) || index < from || index >= joined.length) continue;
    text += joined.slice(from, index) + String.fromCharCode(unit); from = index + 1;
  }
  return text + joined.slice(from);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------------------------------------------------------------

function turnOf(status: RunStatus): Turn { return !runEnded(status) ? "going" : status === "cancelled" ? "cancelled" : "ended"; }
/** An item still open in a Turn that is over did not finish (closing, ADR-057 3.2): `cancelled` when the Turn was stopped, `unknown` otherwise. */
function closing(status: ItemStatus, turn: Turn): ItemStatus {
  return (status === "pending" || status === "running" || status === "waiting") && turn !== "going" ? turn === "cancelled" ? "cancelled" : "unknown" : status;
}
/**
 * How much of a call's title the derived reading looks at. The Runtime held titles to 4,096 bytes; the reading's patterns can take time that
 * grows with the square of a long run of spaces, so a title of more than this many UTF-16 units is read from its start (never in the middle of
 * a pair). Only the DERIVED values see the cut: the native title is kept whole.
 */
const DERIVED_TITLE_UNITS = 16 * 1024;
/** A call as the normalization reads it: the protocol's state for it and the fields of its type (everything but the item's columns). */
export interface Derived { readonly status: ItemStatus; readonly fields: Record<string, unknown> }
/**
 * The protocol's item for a call and its state. The storage conversion reads no stored detail (`detail` null): the same call always gives the same
 * item. The placement of items, which has the head of the call's detail in hand, passes it, and so works out the command and the path in full.
 */
export function derive(called: PublicTool, turn: Turn, detail: ToolDetailInput | null = null): Derived {
  const cut = DERIVED_TITLE_UNITS - ((called.title.charCodeAt(DERIVED_TITLE_UNITS - 1) & 0xfc00) === 0xd800 ? 1 : 0);
  const tool = called.title.length <= DERIVED_TITLE_UNITS ? called : { ...called, title: called.title.slice(0, cut) };
  const context: ToolContext = { seq: 0, detail, turn };
  const split = (item: ProtocolItem): { readonly status: ItemStatus; readonly fields: Record<string, unknown> } => {
    const { id: _id, seq: _seq, status, startedAt: _started, endedAt: _ended, parentId: _parent, ...fields } = item;
    return { status, fields };
  };
  try { const found = normalizeTool(tool, context); return split(found.row ? found.item : plainTool(tool, context)); }
  catch { /* a derived value is worked out again from the native facts; a call no rule can read is a plain tool */ }
  try { return split(plainTool(tool, context)); }
  catch { return { status: closing(itemStatus(tool.status), turn), fields: { type: "tool", name: tool.title } }; }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// toItems
// ---------------------------------------------------------------------------------------------------------------------------------

/** The rows of one Run: see the comment at the top of the file. */
export function toItems(run: PublicRun, messages: { readonly user: PublicMessage; readonly assistant?: PublicMessage }, at: ConversionAt): ConvertedRun {
  const turn = turnOf(run.status), over = runEnded(run.status), standing = runItemStatus(run.status);
  const items: HeldItem[] = [], taken = new Set<string>(), refs = new Map<string, ContentRefRow>();
  const reference = (content: ContentRef, role: ContentRefRow["role"], itemSeq: number): void => {
    const key = role + "\n" + itemSeq + "\n" + content.id;
    if (!refs.has(key)) refs.set(key, { contentId: content.id, sessionId: at.sessionId, runId: run.id, itemSeq, role });
  };
  /**
   * The id of an item whose id the Harness gave: `<prefix><given>`, or the next free `#n` when an earlier item of the Run took it (then `given` is set). A given id with half
   * of a surrogate pair in it is held by a TEXT column as U+FFFD, so the item's id is the id as the column gives it back (and that may take a `#n`, several ids looking alike
   * once their halves are replaced), and `given` is set to say what the Harness gave.
   */
  const free = (prefix: "tool:" | "activity:", given: string): { readonly itemId: string; readonly given?: string } => {
    const shown = sound(given).text;
    if (!taken.has(prefix + shown)) return shown === given ? { itemId: prefix + shown } : { itemId: prefix + shown, given };
    let n = 2; while (taken.has(prefix + shown + "#" + n)) n++;
    return { itemId: prefix + shown + "#" + n, given };
  };
  const add = (itemId: string, status: ItemStatus, fields: ItemFields, extra: { readonly text?: string; readonly parentId?: string; readonly createdSeq?: number } = {}): number => {
    const seq = items.length + 1;
    taken.add(itemId);
    items.push({ runId: run.id, seq, itemId, type: fields.type, status, startedAt: null, endedAt: null, parentId: extra.parentId ?? null, createdSeq: extra.createdSeq ?? null,
      textBytes: 0, textChunks: 0, fields, text: extra.text === undefined || extra.text === "" ? [] : [extra.text] });
    return seq;
  };
  /** An item whose body is a text: the text in one chunk (what a UTF-8 column holds), and what it cannot hold told in the native facts. */
  const spoken = (itemId: string, status: ItemStatus, base: ItemFields, value: string, createdSeq?: number): number => {
    const { text, marks } = sound(value);
    return add(itemId, status, marks.length === 0 ? base : { ...base, native: { ...base.native, surrogates: marks } } as ItemFields, { text, ...(createdSeq === undefined ? {} : { createdSeq }) });
  };

  const userItem = spoken("user", "completed", { type: "user_message", messageId: run.userMessageId }, messages.user.text, messages.user.seq);
  if (run.thinking !== undefined) spoken("think:1", standing, { type: "reasoning" }, run.thinking);
  for (const tool of run.tools ?? []) {
    const { itemId, given } = free("tool:", tool.id), derived = derive(tool, turn);
    // The call this one happened inside is named by its item id as a column holds it; what the Harness gave is kept where the column cannot hold it.
    const parent = tool.parentId === undefined ? undefined : sound(tool.parentId).text;
    const native: NativeFacts = { title: tool.title, status: tool.status, ...(tool.kind === undefined ? {} : { kind: tool.kind }), ...(tool.name === undefined ? {} : { name: tool.name }),
      ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }), ...(given === undefined ? {} : { id: given }), ...(parent === undefined || parent === tool.parentId ? {} : { parent: tool.parentId! }) };
    const seq = add(itemId, derived.status, { ...derived.fields, ...(tool.detail === undefined ? {} : { detail: tool.detail }), native } as ItemFields, parent === undefined ? {} : { parentId: "tool:" + parent });
    if (tool.detail !== undefined) reference(tool.detail, "tool_detail", seq);
  }
  for (const activity of run.activities ?? []) {
    const { itemId, given } = free("activity:", activity.id), status = closing(itemStatus(activity.status), turn);
    const native: NativeFacts = { title: activity.title, kind: activity.kind, status: activity.status, ...(activity.detail === undefined ? {} : { more: activity.detail }), ...(given === undefined ? {} : { id: given }) };
    switch (activity.kind) {
      case "subagent": case "task": add(itemId, status, { type: "subagent", title: activity.title, native }); break;
      case "compaction": add(itemId, status, { type: "context_event", kind: "compaction", native }); break;
      default: add(itemId, status, { type: "notice", severity: activity.kind === "retry" ? "warning" : "info", code: activity.kind, ...(activity.detail === undefined ? {} : { more: activity.detail }), native }, { text: sound(activity.title).text });
    }
  }
  if (run.plan !== undefined) {
    add("plan", over ? "completed" : "running", { type: "plan", steps: run.plan.entries.map(entry => ({ text: entry.content, status: entry.status, ...(entry.priority === undefined ? {} : { priority: entry.priority }) })),
      ...(run.plan.explanation === undefined ? {} : { explanation: run.plan.explanation }) });
  }
  (run.notices ?? []).forEach((notice, index) => {
    const native: NativeFacts = { title: notice.title, ...(notice.detail === undefined ? {} : { more: notice.detail }) }, itemId = "notice:" + (index + 1);
    if (notice.severity === "error") add(itemId, "failed", { type: "error", class: "unknown", message: notice.detail === undefined ? notice.title : notice.title + "\n" + notice.detail, native });
    else add(itemId, "completed", { type: "notice", severity: notice.severity, ...(notice.detail === undefined ? {} : { more: notice.detail }), native }, { text: sound(notice.title).text });
  });
  if (messages.assistant !== undefined) spoken("text:1", standing, { type: "assistant_message", messageId: run.assistantMessageId }, messages.assistant.text, messages.assistant.seq);
  (run.outputs ?? []).forEach((output, index) => {
    const itemId = "output:" + (index + 1);
    if (output.kind === "content") reference(output.content, "output", add(itemId, "completed", { type: "artifact", kind: output.content.kind === "image" ? "image" : "file", name: output.content.name, content: output.content }));
    else add(itemId, "completed", { type: "artifact", kind: "link", name: output.title ?? output.name, uri: output.uri,
      native: { name: output.name, ...(output.title === undefined ? {} : { title: output.title }), ...(output.mediaType === undefined ? {} : { mediaType: output.mediaType }) } });
  });
  for (const attachment of run.attachments ?? []) reference(attachment, "attachment", userItem);

  const emptyLists = (["tools", "notices", "activities", "outputs"] as const).filter(name => run[name] !== undefined && run[name]!.length === 0);
  const facts: RunFacts = { userMessageId: run.userMessageId, assistantMessageId: run.assistantMessageId, selection: run.selection, contextThroughSeq: run.contextThroughSeq, sourceRunIds: run.sourceRunIds,
    backend: run.backend, cleanup: run.cleanup, error: run.error,
    ...(run.usage === undefined ? {} : { usage: run.usage }), ...(run.attachments === undefined ? {} : { attachments: run.attachments }), ...(run.timing === undefined ? {} : { timing: run.timing }),
    ...(run.retained === undefined ? {} : { retained: run.retained }), ...(run.reused === undefined ? {} : { reused: run.reused }), ...(run.relay === undefined ? {} : { relay: run.relay }),
    ...(run.relayRequest === undefined ? {} : { relayRequest: run.relayRequest }), awaitingSwitchId: run.awaitingSwitchId, ...(emptyLists.length === 0 ? {} : { emptyLists }) };
  return {
    row: { sessionId: at.sessionId, ordinal: at.ordinal, runId: run.id, commandId: run.commandId, status: run.status, epoch: run.epoch, harnessId: run.selection.harnessId, controlId: run.selection.controlId,
      managed: run.selection.provider !== undefined, acceptedAt: run.timing?.acceptedAt ?? null, preparingAt: run.timing?.preparingAt ?? null, readyAt: run.timing?.readyAt ?? null, reused: run.reused === true,
      userSeq: messages.user.seq, endedSeq: at.endedSeq ?? null, dispatched: dispatched(run), executedOn: run.relay?.executedOn ?? null,
      isCommand: at.isCommand ?? false, commandEffect: at.commandEffect ?? null, settledEffect: at.settledEffect ?? null, acknowledgedBy: at.acknowledgedBy ?? null,
      cancelRequested: run.cancelRequested, stopRequested: run.stopRequested, legacyOrder: true, facts },
    items, contentRefs: [...refs.values()],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// fromItems
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The old shape of a Run from its rows: the inverse of `toItems`, and the adapter the readers that have not moved to items read through. It
 * reads only the native facts, the ids, the columns of the row and the fields no normalization makes (a plan's steps, an artifact's content and
 * link, a call's detail), in the order of `seq`. Several segments of a reply or of a thinking (a Turn that kept its order) are joined, and
 * the items of the new protocol with no place in the old shape (approvals, questions, the Turn's own switch and error lines…) are left out.
 */
export function fromItems(converted: ConvertedRun): { readonly run: PublicRun; readonly messages: readonly PublicMessage[] } {
  const { row } = converted, facts = row.facts, items = [...converted.items].sort((left, right) => left.seq - right.seq);
  const tools: PublicTool[] = [], activities: PublicActivity[] = [], notices: PublicNotice[] = [], outputs: PublicOutput[] = [];
  let input = "", thinking: string | undefined, plan: PublicPlan | undefined, reply: { text: string; seq: number } | undefined, workspace: PublicRun["workspace"];
  for (const item of items) {
    const id = item.itemId, fields = item.fields, native = fields.native;
    if (id === "user") input += restored(item);
    else if (id.startsWith("think:")) thinking = (thinking ?? "") + restored(item);
    else if (id.startsWith("text:")) { const text = restored(item); if (reply === undefined) reply = { text, seq: item.createdSeq ?? row.userSeq }; else reply.text += text; }
    else if (id === "workspace" && fields.type === "file_change") workspace = { changes: fields.changes, shared: fields.shared === true };
    else if (id.startsWith("tool:")) {
      tools.push({ id: native?.id ?? id.slice(5), title: native?.title ?? "", status: native?.status ?? item.status, ...(native?.kind === undefined ? {} : { kind: native.kind }),
        ...(native?.name === undefined ? {} : { name: native.name }), ...(item.parentId === null ? {} : { parentId: native?.parent ?? (item.parentId.startsWith("tool:") ? item.parentId.slice(5) : item.parentId) }),
        ...(native?.exitCode === undefined ? {} : { exitCode: native.exitCode }),
        ...(fields.detail === undefined ? {} : { detail: fields.detail }) });
    } else if (id.startsWith("activity:")) {
      activities.push({ id: native?.id ?? id.slice(9), kind: (native?.kind ?? "task") as PublicActivity["kind"], title: native?.title ?? "", status: (native?.status ?? item.status) as PublicActivity["status"],
        ...(native?.more === undefined ? {} : { detail: native.more }) });
    } else if (id === "plan" && fields.type === "plan") {
      plan = { entries: fields.steps.map(step => ({ content: step.text, status: step.status, ...(step.priority === undefined ? {} : { priority: step.priority }) })), ...(fields.explanation === undefined ? {} : { explanation: fields.explanation }) };
    } else if (id.startsWith("notice:")) {
      notices.push({ severity: fields.type === "error" ? "error" : fields.type === "notice" ? fields.severity : "info", title: native?.title ?? restored(item), ...(native?.more === undefined ? {} : { detail: native.more }) });
    } else if (id.startsWith("output:") && fields.type === "artifact") {
      if (fields.kind === "link") outputs.push({ kind: "link", uri: fields.uri ?? "", name: native?.name ?? fields.name, ...(native?.title === undefined ? {} : { title: native.title }), ...(native?.mediaType === undefined ? {} : { mediaType: native.mediaType }) });
      else if (fields.content !== undefined) outputs.push({ kind: "content", content: fields.content });
    }
  }
  const empty = new Set(facts.emptyLists ?? []), listed = <T>(name: "tools" | "notices" | "activities" | "outputs", found: T[]): T[] | undefined => found.length > 0 || empty.has(name) ? found : undefined;
  const calls = listed("tools", tools), noted = listed("notices", notices), active = listed("activities", activities), made = listed("outputs", outputs);
  const run: PublicRun = {
    id: row.runId, commandId: row.commandId, input, userMessageId: facts.userMessageId, assistantMessageId: facts.assistantMessageId, selection: facts.selection, epoch: row.epoch, status: row.status,
    cancelRequested: row.cancelRequested, contextThroughSeq: facts.contextThroughSeq, sourceRunIds: facts.sourceRunIds, backend: facts.backend, cleanup: facts.cleanup, error: facts.error,
    ...(thinking === undefined ? {} : { thinking }), ...(calls === undefined ? {} : { tools: calls }), ...(workspace === undefined ? {} : { workspace }), ...(plan === undefined ? {} : { plan }), ...(facts.usage === undefined ? {} : { usage: facts.usage }),
    ...(noted === undefined ? {} : { notices: noted }), ...(active === undefined ? {} : { activities: active }), ...(made === undefined ? {} : { outputs: made }),
    ...(facts.attachments === undefined ? {} : { attachments: facts.attachments }), ...(facts.timing === undefined ? {} : { timing: facts.timing }), ...(facts.retained === undefined ? {} : { retained: facts.retained }),
    ...(facts.reused === true || row.reused ? { reused: true as const } : {}), ...(facts.relay === undefined ? {} : { relay: facts.relay }), ...(facts.relayRequest === undefined ? {} : { relayRequest: facts.relayRequest }),
    stopRequested: row.stopRequested, awaitingSwitchId: facts.awaitingSwitchId,
  };
  const messages: PublicMessage[] = [{ id: facts.userMessageId, runId: row.runId, role: "user", text: input, seq: row.userSeq, status: row.status }];
  if (reply !== undefined) messages.push({ id: facts.assistantMessageId, runId: row.runId, role: "assistant", text: reply.text, seq: reply.seq, status: row.status });
  return { run, messages };
}

export const storageConversion: StorageConversion = { toItems, fromItems };

// ---------------------------------------------------------------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------------------------------------------------------------

/** A conversation's origin as it is stored: the small object of its head, the history it quotes one row to a message, and the content that history refers to. */
export interface OriginParts { readonly stored: StoredOrigin; readonly rows: readonly OriginHistoryRow[]; readonly contentRefs: readonly ContentRefRow[] }
/**
 * The origin of a conversation made before v14 (a branch quotes the text of the source up to a Run, an import the recent messages of the native
 * session) as rows. The history stays as it was quoted (M3: the source may be gone, and it did not hold what was quoted, as its Turns have tools
 * the quote left out) — `quoted` says so; a branch made after v14 refers to its source instead and holds no rows. `throughOrdinal` is the index of
 * `throughRunId` among the source's Runs (the migration reads it from the source's snapshot, and gives -1 when the source is gone): it is for
 * showing only, since the history is quoted. The attachments of the quoted messages are `origin_attachment` references of the conversation itself.
 */
export function originToRows(sessionId: SessionId, origin: SessionOrigin, throughOrdinal: number): OriginParts {
  const kind = origin.kind, seen = new Set<string>(), contentRefs: ContentRefRow[] = [];
  const rows = origin.history.map((message: ForkedMessage, idx): OriginHistoryRow => ({ sessionId, idx, kind, message }));
  for (const message of origin.history) {
    for (const attachment of message.attachments ?? []) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id); contentRefs.push({ contentId: attachment.id, sessionId, runId: null, itemSeq: null, role: "origin_attachment" });
    }
  }
  const stored: StoredOrigin = origin.kind === "fork" ? { kind: "fork", sessionId: origin.sessionId, throughRunId: origin.throughRunId, throughOrdinal, quoted: true }
    : { kind: "import", harnessId: origin.harnessId, title: origin.title, omitted: origin.omitted, complete: origin.complete, historyRead: origin.historyRead };
  return { stored, rows, contentRefs };
}
/**
 * The old origin from its parts; null for a branch that refers to its source (its history is the source's Turns, which this does not read).
 */
export function originFromRows(stored: StoredOrigin, rows: readonly OriginHistoryRow[]): SessionOrigin | null {
  if (stored.kind === "fork" && !stored.quoted) return null;
  const history = [...rows].sort((left, right) => left.idx - right.idx).map((row): ForkedMessage => row.message);
  return stored.kind === "fork" ? { kind: "fork", sessionId: stored.sessionId, throughRunId: stored.throughRunId, history }
    : { kind: "import", harnessId: stored.harnessId, title: stored.title, omitted: stored.omitted, complete: stored.complete, historyRead: stored.historyRead, history };
}
