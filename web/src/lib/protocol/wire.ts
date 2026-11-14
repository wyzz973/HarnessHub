import { parseContentRef } from "../../../../src/contracts/content.js";
import {
  APPROVAL_ROLES, APPROVAL_SUBJECTS, EFFORT_LEVELS, ERROR_CLASSES, FILE_OPS, ITEM_STATUSES, ITEM_TYPES, PERMISSION_LEVELS, PROTOCOL_VERSION, STOP_REASONS, TURN_STATUSES,
  type Executor, type ItemBase, type ItemStatus, type ModelRef, type ProtocolItem, type TurnUsage,
} from "../../../../src/contracts/protocol.js";
import type { ReadItem } from "../../../../src/contracts/protocol-read.js";
import type { DeferredWork, TextRange } from "../../../../src/contracts/conversation.js";
import type { HarnessSelection, NativeConfiguration, PublicSwitch, RunStatus, SelectionRequest } from "../../../../src/contracts/session.js";
import type {
  NativeStateView, RelayStreamFrame, SessionFacts, SessionHeadView, SessionSummary, SessionView, WireRun, WireTurnHeader, WireTextAppend,
  DeletedSessionListView, SearchView, SessionSearchView, PurgedView, PurgeSessionView, WorktreeMark, WorktreeView,
} from "../../../../src/contracts/web.js";
import { decodeRelayStreamEvent, decodeRunRelay } from "../../relay.js";

/*
 * What the Gateway sends of a conversation kept as rows (ADR-057 3.4: the shapes at the end of src/contracts/web.ts), read field by field from the fields the page
 * knows. It is lenient where a newer Gateway may say more, and strict where the page cannot draw without it:
 *
 *  - An item of a type the page does not know, or one it cannot read whole, is kept as the one line `UnrecognizedItem` is (never dropped, never a failure); a state it could
 *    not read is `unknown`, which is never shown as completed.
 *  - A Turn whose header cannot be read is kept as a Run with the reason (`protocolProblem`), which the page says where the Turn would be.
 *  - Anything else that is not what the contract says (a frame with no sequence number, a head with no identity) is a `WireError`: the page asks for the conversation again.
 *
 * NOTHING HERE IS A LIMIT. The page does not mirror a bound of the Gateway's: how many Turns, items, steps, attachments, options or permissions a conversation holds, and how long
 * any text is, are the Gateway's to say, and a list is read to its end. (What is bounded is in the Gateway's own pages: the size of one transfer.)
 */

/** The wire was not what the contract says. */
export class WireError extends Error {
  /** `told`: the message is a sentence for the reader as it is (a protocol version this page does not read), not a place in the data. */
  constructor(message: string, readonly told = false) { super(message); this.name = "WireError"; }
}
function fail(what: string): never { throw new WireError(what); }

// ---------------------------------------------------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function rec(value: unknown, what: string): Record<string, unknown> { return isRecord(value) ? value : fail(what + " is not an object"); }
function str(value: unknown, what: string): string { return typeof value === "string" ? value : fail(what + " is not text"); }
function int(value: unknown, what: string): number { return typeof value === "number" && Number.isSafeInteger(value) ? value : fail(what + " is not a whole number"); }
function nat(value: unknown, what: string): number { const number = int(value, what); return number >= 0 ? number : fail(what + " is negative"); }
/** A time or an amount: finite and never negative. */
function amount(value: unknown, what: string): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail(what + " is not an amount"); }
function bool(value: unknown, what: string): boolean { return typeof value === "boolean" ? value : fail(what + " is not true or false"); }
function flag(value: unknown, what: string): true { return value === true ? true : fail(what + " is not true"); }
function pick<const T extends readonly string[]>(value: unknown, choices: T, what: string): T[number] { return typeof value === "string" && (choices as readonly string[]).includes(value) ? value as T[number] : fail(what + " is not a word of the contract"); }
function many<T>(value: unknown, read: (row: unknown, index: number) => T, what: string): T[] { return Array.isArray(value) ? value.map((row, index) => read(row, index)) : fail(what + " is not a list"); }
/** A field that may be absent: absent (or null, as a Gateway may write "none") is `undefined`; one that is there is read whole. */
function maybe<T>(value: unknown, read: (value: unknown) => T): T | undefined { return value === undefined || value === null ? undefined : read(value); }
const nullable = <T>(value: unknown, read: (value: unknown) => T): T | null => value === null ? null : read(value);
const words = (value: unknown, what: string): string[] => many(value, row => str(row, what), what);
function content(value: unknown): ReturnType<typeof parseContentRef> { try { return parseContentRef(value); } catch { return fail("a content reference is not one"); } }
/** The options of a native session: words to words (the contract's own check has bounds of its own, which the page does not repeat). */
function options(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(rec(value, "native options")).map(([key, item]) => [key, str(item, "a native option")])); }
function configuration(value: unknown): NativeConfiguration { const row = rec(value, "a native configuration"); return { model: nullable(row.model, item => str(item, "a native model")), options: options(row.options) }; }

// ---------------------------------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------------------------------

function model(value: unknown): ModelRef { const row = rec(value, "a model"), vendor = maybe(row.vendor, item => str(item, "a vendor")); return { id: str(row.id, "a model id"), label: str(row.label, "a model label"), ...(vendor === undefined ? {} : { vendor }) }; }
function executor(value: unknown): Executor {
  const row = rec(value, "an executor"), picked = maybe(row.model, model), effort = maybe(row.effort, item => pick(item, EFFORT_LEVELS, "an effort")), permission = maybe(row.permission, item => pick(item, PERMISSION_LEVELS, "a permission level"));
  return { harnessId: str(row.harnessId, "a Harness id"), harness: str(row.harness, "a Harness name"), ...(picked === undefined ? {} : { model: picked }), ...(effort === undefined ? {} : { effort }), ...(permission === undefined ? {} : { permission }) };
}
function usage(value: unknown): TurnUsage {
  const row = rec(value, "usage"), completeness = pick(row.completeness, ["complete", "partial", "unavailable"] as const, "completeness");
  const input = maybe(row.input, item => amount(item, "input")), cachedInput = maybe(row.cachedInput, item => amount(item, "cached input")), output = maybe(row.output, item => amount(item, "output"));
  const context = maybe(row.context, item => { const used = rec(item, "context"), size = maybe(used.size, number => amount(number, "context size")); return { used: amount(used.used, "context used"), ...(size === undefined ? {} : { size }) }; });
  const cost = maybe(row.cost, item => { const paid = rec(item, "cost"); return { amount: amount(paid.amount, "cost"), currency: str(paid.currency, "currency"), scope: pick(paid.scope, ["turn", "session", "conversation"] as const, "cost scope") }; });
  return { completeness, ...(input === undefined ? {} : { input }), ...(cachedInput === undefined ? {} : { cachedInput }), ...(output === undefined ? {} : { output }), ...(context === undefined ? {} : { context }), ...(cost === undefined ? {} : { cost }) };
}

/** What every item carries (the status of one whose own cannot be read is `unknown`, set by the caller). */
function base(row: Record<string, unknown>, id: string, seq: number): ItemBase {
  const startedAt = maybe(row.startedAt, item => amount(item, "startedAt")), endedAt = maybe(row.endedAt, item => amount(item, "endedAt")), parentId = maybe(row.parentId, item => str(item, "parentId"));
  const nativeName = maybe(row.nativeName, item => str(item, "nativeName")), detail = maybe(row.detail, content), bodyOmitted = maybe(row.bodyOmitted, item => flag(item, "bodyOmitted")), textBytes = maybe(row.textBytes, item => nat(item, "textBytes"));
  return { id, seq, status: pick(row.status, ITEM_STATUSES, "an item's state"), ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }),
    ...(parentId === undefined ? {} : { parentId }), ...(nativeName === undefined ? {} : { nativeName }), ...(detail === undefined ? {} : { detail }),
    ...(bodyOmitted === undefined ? {} : { bodyOmitted }), ...(textBytes === undefined ? {} : { textBytes }) };
}
/** One known type's own fields, read from the fields that type has and no others. */
function typed(row: Record<string, unknown>, b: ItemBase): ProtocolItem {
  const text = (what: string) => maybe(row.text, item => str(item, what));
  switch (row.type) {
    case "user_message": {
      // `steered`: words the user gave the Turn while it ran (POST /sessions/:id/steer), not its input.
      const said = text("a message"), steered = maybe(row.steered, item => flag(item, "steered"));
      return { ...b, type: "user_message", messageId: str(row.messageId, "a message id") as never, ...(said === undefined ? {} : { text: said }), ...(steered === undefined ? {} : { steered }) };
    }
    case "assistant_message": {
      const said = text("a reply"), phase = maybe(row.phase, item => pick(item, ["commentary", "final"] as const, "a phase")) ?? "commentary";
      return { ...b, type: "assistant_message", messageId: str(row.messageId, "a message id") as never, phase, ...(said === undefined ? {} : { text: said }) };
    }
    case "reasoning": { const durationMs = maybe(row.durationMs, item => amount(item, "durationMs")), truncated = maybe(row.truncated, item => flag(item, "truncated")); return { ...b, type: "reasoning", text: str(row.text, "a thought"), ...(durationMs === undefined ? {} : { durationMs }), ...(truncated === undefined ? {} : { truncated }) }; }
    case "command": {
      const raw = maybe(row.raw, item => str(item, "raw")), cwd = maybe(row.cwd, item => str(item, "cwd")), exitCode = maybe(row.exitCode, item => int(item, "exitCode")), background = maybe(row.background, item => flag(item, "background"));
      return { ...b, type: "command", command: str(row.command, "a command"), ...(raw === undefined ? {} : { raw }), ...(cwd === undefined ? {} : { cwd }), ...(exitCode === undefined ? {} : { exitCode }), ...(background === undefined ? {} : { background }) };
    }
    case "file_read": {
      const range = maybe(row.range, item => { const lines = rec(item, "a range"), end = maybe(lines.end, number => int(number, "range end")); return { start: int(lines.start, "range start"), ...(end === undefined ? {} : { end }) }; });
      return { ...b, type: "file_read", path: nullable(row.path, item => str(item, "a path")), ...(range === undefined ? {} : { range }) };
    }
    case "file_change": return { ...b, type: "file_change", changes: many(row.changes, item => {
      const change = rec(item, "a change"), oldPath = maybe(change.oldPath, number => str(number, "oldPath")), added = maybe(change.added, number => int(number, "added")), removed = maybe(change.removed, number => int(number, "removed"));
      return { path: str(change.path, "a path"), op: pick(change.op, FILE_OPS, "an operation"), ...(oldPath === undefined ? {} : { oldPath }), ...(added === undefined ? {} : { added }), ...(removed === undefined ? {} : { removed }) };
    }, "changes"), ...(row.by === "hub" ? { by: "hub" as const } : {}), ...(row.shared === true ? { shared: true as const } : {}) };
    case "search": {
      const path = maybe(row.path, item => str(item, "a path")), matches = maybe(row.matches, item => int(item, "matches"));
      return { ...b, type: "search", scope: pick(row.scope, ["files", "content", "unknown"] as const, "a scope"), query: nullable(row.query, item => str(item, "a query")), ...(path === undefined ? {} : { path }), ...(matches === undefined ? {} : { matches }) };
    }
    case "web": {
      const query = maybe(row.query, item => str(item, "a query")), url = maybe(row.url, item => str(item, "a url")), title = maybe(row.title, item => str(item, "a title"));
      return { ...b, type: "web", action: pick(row.action, ["search", "fetch"] as const, "an action"), ...(query === undefined ? {} : { query }), ...(url === undefined ? {} : { url }), ...(title === undefined ? {} : { title }) };
    }
    case "mcp_tool": { const hub = maybe(row.hub, item => flag(item, "hub")); return { ...b, type: "mcp_tool", server: str(row.server, "a server"), tool: str(row.tool, "a tool"), ...(hub === undefined ? {} : { hub }) }; }
    case "tool": return { ...b, type: "tool", name: str(row.name, "a tool name") };
    case "subagent": return { ...b, type: "subagent", title: str(row.title, "a title") };
    case "plan": {
      const explanation = maybe(row.explanation, item => str(item, "an explanation"));
      return { ...b, type: "plan", steps: many(row.steps, item => {
        const step = rec(item, "a step"), priority = maybe(step.priority, number => pick(number, ["high", "medium", "low"] as const, "a priority"));
        return { text: str(step.text, "a step"), status: pick(step.status, ["pending", "in_progress", "completed"] as const, "a step's state"), ...(priority === undefined ? {} : { priority }) };
      }, "steps"), ...(explanation === undefined ? {} : { explanation }) };
    }
    case "plan_proposal": return { ...b, type: "plan_proposal", markdown: str(row.markdown, "a proposal") };
    case "recap": { const ask = maybe(row.ask, item => str(item, "an ask")), actions = maybe(row.actions, item => words(item, "an action")); return { ...b, type: "recap", summary: str(row.summary, "a summary"), ...(ask === undefined ? {} : { ask }), ...(actions === undefined ? {} : { actions }) }; }
    case "approval": {
      const decision = maybe(row.decision, item => { const made = rec(item, "a decision"); const level = maybe(made.level, value => pick(value, PERMISSION_LEVELS, "a permission level")); return { role: pick(made.role, APPROVAL_ROLES, "a role"), by: pick(made.by, ["user", "policy", "timeout", "harness"] as const, "a decider"), at: amount(made.at, "a time"), ...(level === undefined ? {} : { level }) }; });
      const forItem = maybe(row.forItem, item => str(item, "forItem"));
      return { ...b, type: "approval", subject: pick(row.subject, APPROVAL_SUBJECTS, "a subject"), title: str(row.title, "a title"),
        options: many(row.options, item => { const option = rec(item, "an option"); return { id: str(option.id, "an option id"), role: pick(option.role, APPROVAL_ROLES, "a role"), label: str(option.label, "a label") }; }, "options"),
        ...(decision === undefined ? {} : { decision }), ...(forItem === undefined ? {} : { forItem }) };
    }
    case "question": { const answer = maybe(row.answer, item => str(item, "an answer")), secret = maybe(row.secret, item => flag(item, "secret")); return { ...b, type: "question", title: str(row.title, "a title"), ...(answer === undefined ? {} : { answer }), ...(secret === undefined ? {} : { secret }) }; }
    case "notice": { const code = maybe(row.code, item => str(item, "a code")), more = maybe(row.more, item => str(item, "more")); return { ...b, type: "notice", severity: pick(row.severity, ["info", "warning"] as const, "a severity"), text: str(row.text, "a notice"), ...(code === undefined ? {} : { code }), ...(more === undefined ? {} : { more }) }; }
    case "error": { const code = maybe(row.code, item => str(item, "a code")); return { ...b, type: "error", class: pick(row.class, ERROR_CLASSES, "an error class"), message: str(row.message, "a message"), ...(code === undefined ? {} : { code }) }; }
    case "context_event": return { ...b, type: "context_event", kind: pick(row.kind, ["compaction", "clear", "rewind"] as const, "a kind") };
    case "switch": {
      const turns = maybe(row.turns, item => int(item, "turns")), delivery = maybe(row.delivery, item => pick(item, ["sending", "confirmed", "unconfirmed", "not_sent"] as const, "a delivery")), packetId = maybe(row.packetId, item => str(item, "a packet"));
      return { ...b, type: "switch", from: executor(row.from), to: executor(row.to), context: pick(row.context, ["full", "delta", "resend", "none", "native", "unknown"] as const, "a context"),
        session: pick(row.session, ["new", "resumed", "unknown"] as const, "a session"), ...(turns === undefined ? {} : { turns }), ...(delivery === undefined ? {} : { delivery }), ...(packetId === undefined ? {} : { packetId }) };
    }
    case "interrupt": return { ...b, type: "interrupt", by: pick(row.by, ["user", "hub"] as const, "who stopped it") };
    case "delegation": return { ...b, type: "delegation", to: executor(row.to), task: str(row.task, "a task") };
    case "artifact": {
      const contentRef = maybe(row.content, content), uri = maybe(row.uri, item => str(item, "a uri"));
      return { ...b, type: "artifact", kind: pick(row.kind, ["file", "image", "link"] as const, "a kind"), name: str(row.name, "a name"), ...(contentRef === undefined ? {} : { content: contentRef }), ...(uri === undefined ? {} : { uri }) };
    }
    default: return fail("a type this page does not know");
  }
}
/**
 * One item: of its own type when the type is known and its fields read whole; otherwise the line kept for it (its id, its place, its state, and the type it said), so that
 * the page tells it is there. `index` is the id and the place of one that names none of its own.
 */
export function decodeItem(value: unknown, index = 0): ReadItem {
  const row = isRecord(value) ? value : {};
  const id = typeof row.id === "string" && row.id !== "" ? row.id : "item-" + index, seq = typeof row.seq === "number" && Number.isSafeInteger(row.seq) ? row.seq : index;
  const kind = typeof row.type === "string" ? row.type : "";
  try {
    if (!(ITEM_TYPES as readonly string[]).includes(kind)) return fail("an item of a type this page does not know");
    return typed(row, base(row, id, seq));
  } catch {
    const status: ItemStatus = typeof row.status === "string" && (ITEM_STATUSES as readonly string[]).includes(row.status) ? row.status as ItemStatus : "unknown";
    const parentId = typeof row.parentId === "string" ? row.parentId : undefined, nativeName = typeof row.nativeName === "string" ? row.nativeName : undefined;
    return { id, seq, status, type: "unrecognized", nativeType: kind, ...(parentId === undefined ? {} : { parentId }), ...(nativeName === undefined ? {} : { nativeName }) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs and Turns
// ---------------------------------------------------------------------------------------------------------------------

const RUN_STATES = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"] as const satisfies readonly RunStatus[];
function target(value: unknown): NonNullable<HarnessSelection["provider"]> { const row = rec(value, "a Provider target"); return { providerId: str(row.providerId, "a Provider"), revision: nat(row.revision, "a revision"), model: str(row.model, "a model") }; }
function selection(value: unknown): HarnessSelection {
  const row = rec(value, "a selection"), provider = maybe(row.provider, target), nativeModel = maybe(row.nativeModel, item => str(item, "a native model")), nativeOptions = maybe(row.nativeOptions, options);
  return { harnessId: str(row.harnessId, "a Harness"), controlId: str(row.controlId, "a control"), ...(provider === undefined ? {} : { provider }), ...(nativeModel === undefined ? {} : { nativeModel }), ...(nativeOptions === undefined ? {} : { nativeOptions }) };
}
function requested(value: unknown): SelectionRequest {
  const row = rec(value, "a requested selection"), provider = row.provider === undefined ? undefined : row.provider === null ? null : target(row.provider);
  const nativeModel = maybe(row.nativeModel, item => str(item, "a native model")), nativeOptions = maybe(row.nativeOptions, options), controlId = maybe(row.controlId, item => str(item, "a control"));
  return { harnessId: str(row.harnessId, "a Harness"), ...(controlId === undefined ? {} : { controlId }), ...(provider === undefined ? {} : { provider }), ...(nativeModel === undefined ? {} : { nativeModel }), ...(nativeOptions === undefined ? {} : { nativeOptions }) };
}
const fault = (value: unknown): { code: string; message: string } | null => nullable(value, item => { const row = rec(item, "an error"); return { code: str(row.code, "an error code"), message: str(row.message, "an error message") }; });
function timing(value: unknown): NonNullable<WireRun["timing"]> {
  const row = rec(value, "timing"), phase = (name: string): number | undefined => maybe(row[name], item => amount(item, name));
  const out: Record<string, number> = { acceptedAt: amount(row.acceptedAt, "acceptedAt") };
  for (const name of ["preparingAt", "contextReadyAt", "readyAt", "dispatchedAt", "firstOutputAt", "endedAt", "recordedAt"]) { const at = phase(name); if (at !== undefined) out[name] = at; }
  return out as unknown as NonNullable<WireRun["timing"]>;
}

/** A Run as the page reads it: the Run's facts, and its Turn's header; a header that cannot be read is told as the reason (`protocolProblem`) and the Run stays. */
export type ClientRun = Omit<WireRun, "turn"> & { readonly turn?: WireTurnHeader; readonly protocolProblem?: string };
function header(value: unknown): WireTurnHeader {
  const row = rec(value, "a Turn");
  if (row.version !== PROTOCOL_VERSION) throw new WireError("协议版本 " + (typeof row.version === "string" ? row.version : "未知") + "，这个页面只认 " + PROTOCOL_VERSION, true);
  const stopReason = maybe(row.stopReason, item => typeof item === "string" && (STOP_REASONS as readonly string[]).includes(item) ? item as typeof STOP_REASONS[number] : "unknown" as const);
  const startedAt = maybe(row.startedAt, item => amount(item, "startedAt")), durationMs = maybe(row.durationMs, item => amount(item, "durationMs")), legacyOrder = maybe(row.legacyOrder, item => flag(item, "legacyOrder"));
  let reading: TurnUsage;
  try { reading = usage(row.usage); } catch { reading = { completeness: "unavailable" }; }
  return { version: PROTOCOL_VERSION, runId: str(row.runId, "a Run") as never, n: nat(row.n, "n"), status: pick(row.status, TURN_STATUSES, "a Turn's state"), ...(stopReason === undefined ? {} : { stopReason }),
    executor: executor(row.executor), usage: reading, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }), ...(legacyOrder === undefined ? {} : { legacyOrder }) };
}
export function decodeWireRun(value: unknown): ClientRun {
  const row = rec(value, "a Run");
  const backend = nullable(row.backend, item => { const made = rec(item, "a backend result"); const error = maybe(made.error, fault); return { status: pick(made.status, ["completed", "cancelled", "failed"] as const, "a backend state"), reason: str(made.reason, "a reason"), ...(error === undefined || error === null ? {} : { error }) }; });
  const cleanup = nullable(row.cleanup, item => { const made = rec(item, "a cleanup"); if (made.closed !== true) return fail("a cleanup is not closed"); return { closed: true as const, exitCode: nullable(made.exitCode, number => int(number, "an exit code")), signal: nullable(made.signal, word => str(word, "a signal")), protocolFailure: fault(made.protocolFailure) }; });
  const attachments = maybe(row.attachments, item => many(item, content, "attachments")), timed = maybe(row.timing, timing), retained = maybe(row.retained, item => flag(item, "retained")), reused = maybe(row.reused, item => flag(item, "reused"));
  const relay = row.relay === undefined || row.relay === null ? undefined : decodeRunRelay(row.relay) ?? undefined;
  // Where the Turn stands among the alternatives of its place; a reading that is not one is left out (the Turn stays).
  let branch: WireRun["branch"];
  try {
    branch = maybe(row.branch, item => { const made = rec(item, "a branch"); return { n: nat(made.n, "n"), of: nat(made.of, "of"), prev: nullable(made.prev, word => str(word, "a Run")), next: nullable(made.next, word => str(word, "a Run")) }; });
  } catch { branch = undefined; }
  let turn: WireTurnHeader | undefined, problem: string | undefined;
  if (row.turn === undefined || row.turn === null) problem = "服务没有给出这一轮的协议数据";
  else { try { turn = header(row.turn); } catch (error) { problem = error instanceof WireError ? error.told ? error.message : "这一轮的协议数据读不出来：" + error.message : "这一轮的协议数据读不出来"; } }
  return { id: str(row.id, "a Run id") as never, commandId: str(row.commandId, "a command id") as never, userMessageId: str(row.userMessageId, "a message id") as never, assistantMessageId: str(row.assistantMessageId, "a message id") as never,
    selection: selection(row.selection), epoch: nat(row.epoch, "an epoch"), status: pick(row.status, RUN_STATES, "a Run's state"), cancelRequested: bool(row.cancelRequested, "cancelRequested"),
    contextThroughSeq: nat(row.contextThroughSeq, "contextThroughSeq"), sourceRunIds: words(row.sourceRunIds, "a source Run") as never[], backend, cleanup, error: fault(row.error),
    ...(attachments === undefined ? {} : { attachments }), ...(timed === undefined ? {} : { timing: timed }), ...(retained === undefined ? {} : { retained }), ...(reused === undefined ? {} : { reused }),
    ...(relay === undefined ? {} : { relay: relay as never }), stopRequested: bool(row.stopRequested, "stopRequested"), awaitingSwitchId: nullable(row.awaitingSwitchId, item => str(item, "a switch id")) as never,
    ordinal: nat(row.ordinal, "an ordinal"), userSeq: nat(row.userSeq, "userSeq"), ...(turn === undefined ? {} : { turn }), ...(problem === undefined ? {} : { protocolProblem: problem }), ...(branch === undefined ? {} : { branch }) };
}

/** One Turn of a window or a page: its Run, its items in place order, and the middle of a long stretch of work when it was left out. */
export interface ClientTurn { readonly run: ClientRun; readonly items: readonly ReadItem[]; readonly deferred?: DeferredWork }
function deferred(value: unknown): DeferredWork { const row = rec(value, "a deferred stretch"); return { fromSeq: nat(row.fromSeq, "fromSeq"), toSeq: nat(row.toSeq, "toSeq"), count: nat(row.count, "count") }; }
export function decodeTurn(value: unknown): ClientTurn {
  const row = rec(value, "a Turn"), later = maybe(row.deferred, deferred);
  return { run: decodeWireRun(row.run), items: many(row.items, (item, index) => decodeItem(item, index), "items"), ...(later === undefined ? {} : { deferred: later }) };
}
export interface ClientWindow { readonly turns: readonly ClientTurn[]; readonly older: string | null }
function decodeWindow(value: unknown): ClientWindow {
  const row = rec(value, "a window");
  return { turns: many(row.turns, item => decodeTurn(item), "turns"), older: nullable(row.older, item => str(item, "a cursor")) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------------------------------------------------

function lastSwitch(value: unknown): PublicSwitch {
  const row = rec(value, "a switch");
  const mode = maybe(row.mode, item => pick(item, ["wait_current", "cancel_current"] as const, "a switch's mode"));
  const timing = maybe(row.timing, item => {
    const made = rec(item, "a switch's times"), validatedAt = maybe(made.validatedAt, time => amount(time, "validatedAt")), effectiveAt = maybe(made.effectiveAt, time => amount(time, "effectiveAt"));
    return { requestedAt: amount(made.requestedAt, "requestedAt"), ...(validatedAt === undefined ? {} : { validatedAt }), ...(effectiveAt === undefined ? {} : { effectiveAt }) };
  });
  const acknowledged = maybe(row.acknowledgedUnknown, list => words(list, "an acknowledged Run") as never[]);
  return { id: str(row.id, "a switch id") as never, commandId: str(row.commandId, "a command id") as never, requested: requested(row.requested), requestedSeq: nat(row.requestedSeq, "requestedSeq"),
    target: nullable(row.target, selection), status: pick(row.status, ["requested", "validated", "effective", "failed"] as const, "a switch's state"), throughSeq: nat(row.throughSeq, "throughSeq"),
    sourceRunIds: words(row.sourceRunIds, "a source Run") as never[], error: fault(row.error), ...(mode === undefined ? {} : { mode }), ...(timing === undefined ? {} : { timing }),
    ...(acknowledged === undefined ? {} : { acknowledgedUnknown: acknowledged }) };
}
function origin(value: unknown): NonNullable<SessionView["origin"]> {
  const row = rec(value, "an origin");
  const history = many(row.history, item => {
    const message = rec(item, "a quoted message"), harnessId = maybe(message.harnessId, word => str(word, "a Harness")), attachments = maybe(message.attachments, list => many(list, content, "attachments"));
    return { role: pick(message.role, ["user", "assistant"] as const, "a role"), text: str(message.text, "a message"), status: pick(message.status, RUN_STATES, "a state"), ...(harnessId === undefined ? {} : { harnessId }), ...(attachments === undefined ? {} : { attachments }) };
  }, "history");
  if (row.kind === "import") return { kind: "import", harnessId: str(row.harnessId, "a Harness"), title: nullable(row.title, item => str(item, "a title")), omitted: nat(row.omitted, "omitted"), complete: bool(row.complete, "complete"), historyRead: bool(row.historyRead, "historyRead"), history };
  if (row.kind !== "fork") return fail("an origin that is neither a branch nor a continued session");
  return { kind: "fork", sessionId: str(row.sessionId, "a conversation") as never, throughRunId: str(row.throughRunId, "a Run") as never, history };
}
function permission(value: unknown): NonNullable<SessionView["permissions"]>[number] {
  const request = rec(value, "a request"), expiresAt = maybe(request.expiresAt, item => amount(item, "expiresAt")), kind = maybe(request.kind, item => pick(item, ["question"] as const, "a kind")), detail = maybe(request.detail, item => str(item, "a detail"));
  const input = maybe(request.input, item => { const made = rec(item, "an input"); return { kind: pick(made.kind, ["text", "editor", "secret"] as const, "an input kind"), value: str(made.value, "an input value") }; });
  return { id: str(request.id, "a request id"), runId: str(request.runId, "a Run"), title: str(request.title, "a title"), decided: bool(request.decided, "decided"), requestedAt: amount(request.requestedAt, "requestedAt"),
    ...(expiresAt === undefined ? {} : { expiresAt, expiresBy: pick(request.expiresBy, ["native", "turn"] as const, "expiresBy") }), ...(kind === undefined ? {} : { kind }), ...(detail === undefined ? {} : { detail }), ...(input === undefined ? {} : { input }),
    options: many(request.options, item => { const option = rec(item, "an option"); return { id: str(option.id, "an option id"), name: str(option.name, "an option name") }; }, "options") };
}
function nativeState(value: unknown): NativeStateView {
  const state = rec(value, "a native state"), observed = maybe(state.observed, configuration);
  const carried = maybe(state.carried, item => { const made = rec(item, "a carried configuration"), model = maybe(made.model, word => str(word, "a model")), kept = maybe(made.options, options); return { ...(model === undefined ? {} : { model }), ...(kept === undefined ? {} : { options: kept }) }; });
  return { harnessId: str(state.harnessId, "a Harness"), controlId: str(state.controlId, "a control"), status: pick(state.status, ["ready", "unconfirmed", "forking"] as const, "a native state"), ...(observed === undefined ? {} : { observed }), ...(carried === undefined ? {} : { carried }) };
}
function sessionFacts(value: unknown): SessionFacts {
  const row = rec(value, "the facts of a conversation"), unknown = rec(row.unknown, "the unknown Turns");
  const branchable = nullable(row.branchable, item => { const made = rec(item, "a Turn a branch starts from"); return { runId: str(made.runId, "a Run"), ordinal: nat(made.ordinal, "ordinal") }; });
  return { unknown: { count: nat(unknown.count, "count"), unclosed: bool(unknown.unclosed, "unclosed") }, settled: bool(row.settled, "settled"), branchable,
    ran: many(row.ran, item => { const made = rec(item, "a control's Turns"); return { harnessId: str(made.harnessId, "a Harness"), controlId: str(made.controlId, "a control"), turns: nat(made.turns, "turns") }; }, "ran"), changes: nat(row.changes, "changes") };
}
export function decodeHead(value: unknown): SessionHeadView {
  const row = rec(value, "a head");
  const permissions = maybe(row.permissions, list => many(list, permission, "permissions")), states = maybe(row.nativeStates, list => many(list, nativeState, "native states")), quoted = maybe(row.origin, origin);
  const queue = maybe(row.queue, item => { const made = rec(item, "a queue"); return { kind: pick(made.kind, ["slot"] as const, "a queue kind"), runId: str(made.runId, "a Run"), running: nat(made.running, "running"), limit: nat(made.limit, "limit"), since: amount(made.since, "since") }; });
  const retention = maybe(row.retention, item => {
    const kept = rec(item, "retention"), process = nullable(kept.process, entry => { const made = rec(entry, "a kept process"); return { harnessId: str(made.harnessId, "a Harness"), controlId: str(made.controlId, "a control"), since: amount(made.since, "since"), lastUsedAt: amount(made.lastUsedAt, "lastUsedAt"), idleEndsAt: amount(made.idleEndsAt, "idleEndsAt"), backgroundUpdates: nat(made.backgroundUpdates, "backgroundUpdates") }; });
    const lost = maybe(kept.lost, entry => { const made = rec(entry, "a lost process"); return { outcome: pick(made.outcome, ["terminated", "gone", "unconfirmed"] as const, "an outcome"), leaseReleased: bool(made.leaseReleased, "leaseReleased"), at: amount(made.at, "at") }; });
    const outside = maybe(kept.outside, entry => { const made = rec(entry, "background processes"); return { count: nat(made.count, "count"), at: amount(made.at, "at") }; });
    const upgraded = maybe(kept.upgraded, entry => { const made = rec(entry, "an upgrade"); return { harnessId: str(made.harnessId, "a Harness"), at: amount(made.at, "at") }; });
    return { enabled: bool(kept.enabled, "enabled"), process, ...(lost === undefined ? {} : { lost }), ...(outside === undefined ? {} : { outside }), ...(upgraded === undefined ? {} : { upgraded }) };
  });
  const last = maybe(row.lastSwitch, lastSwitch);
  const parent = maybe(row.parent, item => { const made = rec(item, "a delegating conversation"); return { sessionId: str(made.sessionId, "a conversation id"), afterRunId: nullable(made.afterRunId, value => str(value, "a Run")), ...(made.by === "harness" ? { by: "harness" as const } : {}) }; });
  let told: SessionHeadView["delegationsTold"];
  try { told = maybe(row.delegationsTold, item => Object.fromEntries(Object.entries(rec(item, "what was told")).map(([id, value]) => { const made = rec(value, "a told outcome"); return [id, { runId: str(made.runId, "a Run"), by: str(made.by, "a Run") }]; })) as SessionHeadView["delegationsTold"]); } catch { told = undefined; }
  // The latest task list and the latest Turn's wrap-up: a reading that is not one is left out (the head stays).
  let plan: SessionHeadView["plan"], recap: SessionHeadView["recap"];
  try {
    plan = maybe(row.plan, item => { const made = rec(item, "a task list"), explanation = maybe(made.explanation, word => str(word, "an explanation"));
      return { runId: str(made.runId, "a Run"), ordinal: nat(made.ordinal, "ordinal"), harnessId: str(made.harnessId, "a Harness"),
        steps: many(made.steps, step => { const entry = rec(step, "a step"); return { text: str(entry.text, "a step"), status: pick(entry.status, ["pending", "in_progress", "completed"] as const, "a step's state") }; }, "steps"),
        ...(explanation === undefined ? {} : { explanation }) }; });
  } catch { plan = undefined; }
  try {
    recap = maybe(row.recap, item => { const made = rec(item, "a wrap-up"), ask = maybe(made.ask, word => str(word, "a question")), actions = maybe(made.actions, list => words(list, "an answer"));
      return { runId: str(made.runId, "a Run"), ordinal: nat(made.ordinal, "ordinal"), harnessId: str(made.harnessId, "a Harness"), summary: str(made.summary, "a recap"),
        ...(ask === undefined ? {} : { ask }), ...(actions === undefined ? {} : { actions }) }; });
  } catch { recap = undefined; }
  return { id: str(row.id, "a conversation id"), version: nat(row.version, "version"), lastSeq: nat(row.lastSeq, "lastSeq"), epoch: nat(row.epoch, "epoch"), status: pick(row.status, ["open", "closed", "blocked"] as const, "a conversation's state"),
    workspace: str(row.workspace, "a workspace"), selection: selection(row.selection), activeRunId: nullable(row.activeRunId, item => str(item, "a Run")), pendingSwitchId: nullable(row.pendingSwitchId, item => str(item, "a switch")),
    ...(permissions === undefined ? {} : { permissions }), ...(states === undefined ? {} : { nativeStates: states }), ...(quoted === undefined ? {} : { origin: quoted }), ...(parent === undefined ? {} : { parent }), ...(told === undefined ? {} : { delegationsTold: told }), ...(queue === undefined ? {} : { queue }), ...(retention === undefined ? {} : { retention }),
    title: str(row.title, "a title"), runCount: nat(row.runCount, "runCount"), ...(row.archived === true ? { archived: true as const } : {}), ...(row.pinned === true ? { pinned: true as const } : {}),
    ...(row.pinned === true && typeof row.pinnedOrder === "number" && Number.isFinite(row.pinnedOrder) ? { pinnedOrder: row.pinnedOrder } : {}),
    ...((until => until === undefined ? {} : { snoozedUntil: until })(maybe(row.snoozedUntil, entry => amount(entry, "snoozedUntil")))),
    ...((worktree => worktree === undefined ? {} : { worktree })(decodeWorktreeMark(row.worktree))),
    ...(row.updatedAt === undefined ? {} : { updatedAt: amount(row.updatedAt, "updatedAt") }), ...(row.activeSince === undefined || row.activeRunId === null ? {} : { activeSince: amount(row.activeSince, "activeSince") }),
    ...(last === undefined ? {} : { lastSwitch: last }), facts: sessionFacts(row.facts),
    ...(plan === undefined ? {} : { plan }), ...(recap === undefined ? {} : { recap }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The answers of the routes
// ---------------------------------------------------------------------------------------------------------------------

/** `GET /api/v1/sessions/:id`: the head and the newest Turns. */
export interface ClientSessionView { readonly head: SessionHeadView; readonly window: ClientWindow }
export function decodeSessionViewV14(value: unknown): ClientSessionView { const row = rec(value, "a conversation"); return { head: decodeHead(row.head), window: decodeWindow(row.window) }; }
/** `GET …/turns?before=`: the page of Turns before a cursor. */
export function decodeTurnPageView(value: unknown): ClientWindow { return decodeWindow(value); }
/** `GET …/runs/:ordinal/items`: the items of a Turn from a place on. */
export interface ClientRunItemsPage { readonly items: readonly ReadItem[]; readonly next: number | null }
export function decodeRunItemsPageView(value: unknown): ClientRunItemsPage { const row = rec(value, "a page of items"); return { items: many(row.items, (item, index) => decodeItem(item, index), "items"), next: nullable(row.next, item => nat(item, "next")) }; }
/** `GET …/items/:seq`: one item whole. */
export function decodeItemView(value: unknown): { readonly item: ReadItem } { const row = rec(value, "an item"); return { item: decodeItem(row.item) }; }
/** `GET …/items/:seq/text?from=&to=`: a byte range of an item's text. */
export function decodeItemTextView(value: unknown): TextRange {
  const row = rec(value, "a range of text"), from = nat(row.from, "from"), to = nat(row.to, "to"), total = nat(row.total, "total");
  if (to < from || to > total) return fail("a range of text that ends before it starts or after the text ends");
  return { text: str(row.text, "text"), from, to, total };
}
/** `GET /api/v1/sessions?after=&limit=`: the conversations, newest first. */
export interface ClientSessionList { readonly sessions: readonly SessionSummary[]; readonly next: string | null }
export function decodeSessionListView(value: unknown): ClientSessionList {
  const row = rec(value, "a list of conversations");
  return { sessions: many(row.sessions, decodeSessionSummary, "conversations"), next: nullable(row.next, item => str(item, "a cursor")) };
}
/** One row of a list of conversations (`SessionSummary`). */
export function decodeSessionSummary(item: unknown): SessionSummary {
  const made = rec(item, "a conversation"), activeRunId = nullable(made.activeRunId, entry => str(entry, "a Run")), activeSince = maybe(made.activeSince, entry => amount(entry, "activeSince"));
  // A row without a time (a Gateway from before 2026-11-14) is the oldest, not a failure.
  return { id: str(made.id, "an id"), title: str(made.title, "a title"), status: pick(made.status, ["open", "closed", "blocked"] as const, "a state"), workspace: str(made.workspace, "a workspace"),
    selection: selection(made.selection), updatedSeq: nat(made.updatedSeq, "updatedSeq"), updatedAt: maybe(made.updatedAt, entry => amount(entry, "updatedAt")) ?? 0, activeRunId,
    ...(activeRunId === null || activeSince === undefined ? {} : { activeSince }), ...(typeof made.line === "string" && made.line !== "" ? { line: made.line } : {}),
    ...(made.parent === undefined ? {} : { parent: (parent => ({ sessionId: str(parent.sessionId, "a conversation id"), afterRunId: nullable(parent.afterRunId, entry => str(entry, "a Run")), ...(parent.by === "harness" ? { by: "harness" as const } : {}) }))(rec(made.parent, "a delegating conversation")) }),
    ...(made.archived === true ? { archived: true as const } : {}), ...(made.pinned === true ? { pinned: true as const } : {}),
    ...(made.pinned === true && typeof made.pinnedOrder === "number" && Number.isFinite(made.pinnedOrder) ? { pinnedOrder: made.pinnedOrder } : {}),
    ...((until => until === undefined ? {} : { snoozedUntil: until })(maybe(made.snoozedUntil, entry => amount(entry, "snoozedUntil")))),
    ...((worktree => worktree === undefined ? {} : { worktree })(decodeWorktreeMark(made.worktree))) };
}
/**
 * The Git worktree a head or a row of the list carries (2026-11-14, `SessionSummary.worktree`): its repository's main checkout (`root`, what the list groups by), its
 * folder, its branch and the commit it started from; undefined when there is none. One that is not that shape is left out: the row stays.
 */
export function decodeWorktreeMark(value: unknown): WorktreeMark | undefined {
  if (value === undefined || value === null || !isRecord(value)) return undefined;
  return typeof value.root === "string" && typeof value.path === "string" && typeof value.branch === "string" && typeof value.baseSha === "string"
    ? { root: value.root, path: value.path, branch: value.branch, baseSha: value.baseSha } : undefined;
}
/** `GET /api/v1/sessions/:id/worktree` (2026-11-14): where the conversation's worktree stands now. */
export function decodeWorktreeView(value: unknown): WorktreeView {
  const row = rec(value, "a worktree");
  return { path: str(row.path, "a worktree's folder"), branch: nullable(row.branch, item => str(item, "a branch")), dirty: nat(row.dirty, "dirty"), shared: bool(row.shared, "shared"),
    ...(row.missing === true ? { missing: true as const } : {}) };
}
/** `POST /api/v1/sessions/:id/purge {removeWorktree: true}` (2026-11-14): what became of the erased conversation's worktree. */
export function decodePurgeSessionView(value: unknown): PurgeSessionView {
  const row = rec(value, "an erasure");
  const kept = row.worktreeKept === "shared" || row.worktreeKept === "failed" ? row.worktreeKept : undefined;
  return { ...(row.worktreeRemoved === true ? { worktreeRemoved: true as const } : {}), ...(kept === undefined ? {} : { worktreeKept: kept }),
    ...(typeof row.worktreeError === "string" ? { worktreeError: row.worktreeError } : {}) };
}
/** `POST /api/v1/sessions/purge-deleted`: how many were erased and, when their worktrees were asked to go, how many went and which Git refused. */
export function decodePurgedView(value: unknown): PurgedView {
  const row = rec(value, "an erasure"), removed = maybe(row.worktreesRemoved, item => nat(item, "worktreesRemoved"));
  const failures = maybe(row.worktreeFailures, list => many(list, entry => { const made = rec(entry, "a worktree left"); return { path: str(made.path, "a worktree's folder"), message: str(made.message, "Git's words") }; }, "worktreeFailures"));
  return { purged: nat(row.purged, "purged"), ...(removed === undefined ? {} : { worktreesRemoved: removed }), ...(failures === undefined ? {} : { worktreeFailures: failures }) };
}
/** `GET /api/v1/sessions/deleted?before=&limit=` (2026-11-14): the conversations the user deleted, the latest deleted first, each with when. */
export function decodeDeletedSessionListView(value: unknown): DeletedSessionListView {
  const row = rec(value, "a list of deleted conversations");
  return { sessions: many(row.sessions, item => ({ ...decodeSessionSummary(item), deletedAt: amount(rec(item, "a conversation").deletedAt, "deletedAt") }), "conversations"), next: nullable(row.next, item => str(item, "a cursor")) };
}
/** A snippet and the place of the words in it: `[start, end)` inside it. */
function snippetOf(row: Record<string, unknown>): { readonly snippet: string; readonly match: readonly [number, number] } {
  const snippet = str(row.snippet, "a snippet"), match = many(row.match, (entry, index) => nat(entry, "match " + index), "a match");
  if (match.length !== 2 || match[0]! > match[1]! || match[1]! > snippet.length) fail("a match is not a place in its snippet");
  return { snippet, match: [match[0]!, match[1]!] };
}
/** `GET /api/v1/search?q=&cursor=` (2026-11-14): the places the words were found, by conversation. */
export function decodeSearchView(value: unknown): SearchView {
  const row = rec(value, "a search");
  return { hits: many(row.hits, item => {
    const hit = rec(item, "a hit"), role = pick(hit.role, ["user", "assistant", "title"] as const, "a hit's role");
    return { sessionId: str(hit.sessionId, "a conversation id"), title: str(hit.title, "a title"), runId: nullable(hit.runId, entry => str(entry, "a Run")), ordinal: nullable(hit.ordinal, entry => nat(entry, "a Turn")),
      messageId: nullable(hit.messageId, entry => str(entry, "a message")), role, ...snippetOf(hit) };
  }, "hits"), next: nullable(row.next, item => str(item, "a cursor")) };
}
/** `GET /api/v1/sessions/:id/search?q=&cursor=` (2026-11-14): every place in one conversation, in its order, with where to go. */
export function decodeSessionSearchView(value: unknown): SessionSearchView {
  const row = rec(value, "a search");
  return { hits: many(row.hits, item => {
    const hit = rec(item, "a hit");
    return { sessionId: str(hit.sessionId, "a conversation id"), title: str(hit.title, "a title"), runId: str(hit.runId, "a Run"), ordinal: nat(hit.ordinal, "a Turn"), messageId: str(hit.messageId, "a message"),
      role: pick(hit.role, ["user", "assistant"] as const, "a hit's role"), itemSeq: nat(hit.itemSeq, "an item"), offset: nat(hit.offset, "an offset"), ...snippetOf(hit) };
  }, "hits"), next: nullable(row.next, item => str(item, "a cursor")) };
}

/** `GET …/changes?before=&limit=`: the changes of the whole conversation that have a stored detail, newest first; the first page also names the newest plan. */
export interface ClientConversationEdit { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly item: ReadItem }
export interface ClientConversationChanges {
  readonly edits: readonly ClientConversationEdit[];
  readonly next: string | null;
  readonly plan?: { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly item: ReadItem } | null;
}
export function decodeConversationChanges(value: unknown): ClientConversationChanges {
  const row = rec(value, "the changes of a conversation");
  const plan = maybe(row.plan, item => nullable(item, made => { const entry = rec(made, "a plan"); return { runId: str(entry.runId, "a Run"), ordinal: nat(entry.ordinal, "ordinal"), harnessId: str(entry.harnessId, "a Harness"), item: decodeItem(entry.item) }; }));
  return { edits: many(row.edits, entry => { const made = rec(entry, "a change"); return { runId: str(made.runId, "a Run"), ordinal: nat(made.ordinal, "ordinal"), harnessId: str(made.harnessId, "a Harness"), item: decodeItem(made.item) }; }, "changes"),
    next: nullable(row.next, item => str(item, "a cursor")), ...(plan === undefined ? {} : { plan }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------------------------------------------------

/** One commit's frame as the page reads it: items that may be of a type it does not know. */
export interface ClientCommitFrame {
  readonly type: "commit"; readonly sessionId: string; readonly version: number; readonly lastSeq: number;
  readonly head?: SessionHeadView; readonly runs?: readonly ClientRun[]; readonly items?: readonly { readonly runId: string; readonly item: ReadItem }[]; readonly texts?: readonly WireTextAppend[];
}
export type ClientStreamFrame = { readonly type: "snapshot"; readonly session: ClientSessionView } | ClientCommitFrame | RelayStreamFrame;
export function decodeSessionStreamFrameV14(value: unknown): ClientStreamFrame {
  const row = rec(value, "a frame");
  switch (row.type) {
    case "snapshot": return { type: "snapshot", session: decodeSessionViewV14(row.session) };
    case "relay": {
      const event = decodeRelayStreamEvent(row.event);
      if (event === null) return fail("a relay notice with no event");
      return { type: "relay", sessionId: str(row.sessionId, "a conversation"), version: nat(row.version, "version"), lastSeq: nat(row.lastSeq, "lastSeq"), event };
    }
    case "commit": {
      const head = maybe(row.head, decodeHead), runs = maybe(row.runs, list => many(list, decodeWireRun, "runs"));
      const items = maybe(row.items, list => many(list, entry => { const made = rec(entry, "an item of a frame"); return { runId: str(made.runId, "a Run"), item: decodeItem(made.item) }; }, "items"));
      const texts = maybe(row.texts, list => many(list, entry => {
        const made = rec(entry, "a text of a frame"), omittedBytes = maybe(made.omittedBytes, number => nat(number, "omittedBytes"));
        return { runId: str(made.runId, "a Run"), itemSeq: nat(made.itemSeq, "itemSeq"), from: nat(made.from, "from"), text: str(made.text, "text"), ...(omittedBytes === undefined ? {} : { omittedBytes }) };
      }, "texts"));
      return { type: "commit", sessionId: str(row.sessionId, "a conversation"), version: nat(row.version, "version"), lastSeq: nat(row.lastSeq, "lastSeq"),
        ...(head === undefined ? {} : { head }), ...(runs === undefined ? {} : { runs }), ...(items === undefined ? {} : { items }), ...(texts === undefined ? {} : { texts }) };
    }
    default: return fail("a frame of a type this page does not know");
  }
}
