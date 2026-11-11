import { parseContentRef } from "../../../../src/contracts/content.js";
import {
  APPROVAL_ROLES, APPROVAL_SUBJECTS, EFFORT_LEVELS, ERROR_CLASSES, FILE_OPS, ITEM_STATUSES, ITEM_TYPES, PERMISSION_LEVELS, PROTOCOL_VERSION, STOP_REASONS, TURN_STATUSES,
  type Executor, type ItemBase, type ItemStatus, type ModelRef, type ProtocolItem, type TurnUsage,
} from "../../../../src/contracts/protocol.js";
import type { ReadItem, ReadTurn } from "../../../../src/contracts/protocol-read.js";
import { messageId, runId } from "../../../../src/contracts/session.js";

/*
 * Reads a Turn of the protocol (hh/1) from what the Gateway sent, field by field from a list of the fields it knows (the page's
 * decoders all work so). It is lenient where a newer Gateway may say more: an item of a type this page does not know, or one it
 * cannot read whole, is kept as one line saying so and never dropped, and nothing here throws. A Turn it cannot read at all (not
 * this protocol's version, no items, no executor) is no Turn: the Run is then drawn from the facts it always had.
 */

class Unreadable extends Error {}
const fail = (): never => { throw new Unreadable("protocol"); };
function obj(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail(); }
const str = (value: unknown): string => typeof value === "string" ? value : fail();
const int = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) ? value : fail();
/** A time or an amount: finite and never negative. */
const amount = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail();
function pick<const T extends readonly string[]>(value: unknown, choices: T): T[number] { return typeof value === "string" && (choices as readonly string[]).includes(value) ? value as T[number] : fail(); }
function many<T>(value: unknown, read: (row: unknown) => T, limit: number): readonly T[] { return Array.isArray(value) && value.length <= limit ? value.map(read) : fail(); }
/** Reads a field that may be absent: absent (or null, as a Gateway may write "none") is `undefined`; a field that is there must be read whole. */
function maybe<T>(value: unknown, read: (value: unknown) => T): T | undefined { return value === undefined || value === null ? undefined : read(value); }
const flag = (value: unknown): true => value === true ? true : fail();

function model(value: unknown): ModelRef {
  const row = obj(value), vendor = maybe(row.vendor, str);
  return { id: str(row.id), label: str(row.label), ...(vendor === undefined ? {} : { vendor }) };
}
function executor(value: unknown): Executor {
  const row = obj(value), picked = maybe(row.model, model), effort = maybe(row.effort, value => pick(value, EFFORT_LEVELS)), permission = maybe(row.permission, value => pick(value, PERMISSION_LEVELS));
  return { harnessId: str(row.harnessId), harness: str(row.harness), ...(picked === undefined ? {} : { model: picked }), ...(effort === undefined ? {} : { effort }), ...(permission === undefined ? {} : { permission }) };
}
function usage(value: unknown): TurnUsage {
  const row = obj(value), completeness = pick(row.completeness, ["complete", "partial", "unavailable"] as const);
  const input = maybe(row.input, amount), cachedInput = maybe(row.cachedInput, amount), output = maybe(row.output, amount);
  const context = maybe(row.context, value => { const used = obj(value), size = maybe(used.size, amount); return { used: amount(used.used), ...(size === undefined ? {} : { size }) }; });
  const cost = maybe(row.cost, value => { const paid = obj(value); return { amount: amount(paid.amount), currency: str(paid.currency), scope: pick(paid.scope, ["turn", "session", "conversation"] as const) }; });
  return { completeness, ...(input === undefined ? {} : { input }), ...(cachedInput === undefined ? {} : { cachedInput }), ...(output === undefined ? {} : { output }),
    ...(context === undefined ? {} : { context }), ...(cost === undefined ? {} : { cost }) };
}

/** What every item carries; the status of an item whose own was unreadable is "unknown", which is never shown as completed. */
function base(row: Record<string, unknown>, id: string, seq: number): ItemBase {
  const startedAt = maybe(row.startedAt, amount), endedAt = maybe(row.endedAt, amount), parentId = maybe(row.parentId, str), nativeName = maybe(row.nativeName, str), detail = maybe(row.detail, value => parseContentRef(value));
  return { id, seq, status: pick(row.status, ITEM_STATUSES), ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }),
    ...(parentId === undefined ? {} : { parentId }), ...(nativeName === undefined ? {} : { nativeName }), ...(detail === undefined ? {} : { detail }) };
}
const words = (value: unknown): readonly string[] => many(value, str, 8);

/** One known type's own fields, read from the fields that type has and no others. */
function typed(row: Record<string, unknown>, b: ItemBase): ProtocolItem {
  switch (row.type) {
    case "user_message": return { ...b, type: "user_message", messageId: messageId(row.messageId) };
    case "assistant_message": return { ...b, type: "assistant_message", messageId: messageId(row.messageId), phase: pick(row.phase, ["commentary", "final"] as const) };
    case "reasoning": { const durationMs = maybe(row.durationMs, amount); return { ...b, type: "reasoning", text: str(row.text), ...(durationMs === undefined ? {} : { durationMs }) }; }
    case "command": {
      const raw = maybe(row.raw, str), cwd = maybe(row.cwd, str), exitCode = maybe(row.exitCode, int), background = maybe(row.background, flag);
      return { ...b, type: "command", command: str(row.command), ...(raw === undefined ? {} : { raw }), ...(cwd === undefined ? {} : { cwd }), ...(exitCode === undefined ? {} : { exitCode }), ...(background === undefined ? {} : { background }) };
    }
    case "file_read": {
      const range = maybe(row.range, value => { const lines = obj(value), end = maybe(lines.end, int); return { start: int(lines.start), ...(end === undefined ? {} : { end }) }; });
      return { ...b, type: "file_read", path: row.path === null ? null : str(row.path), ...(range === undefined ? {} : { range }) };
    }
    case "file_change": return { ...b, type: "file_change", changes: many(row.changes, value => {
      const change = obj(value), oldPath = maybe(change.oldPath, str), added = maybe(change.added, int), removed = maybe(change.removed, int);
      return { path: str(change.path), op: pick(change.op, FILE_OPS), ...(oldPath === undefined ? {} : { oldPath }), ...(added === undefined ? {} : { added }), ...(removed === undefined ? {} : { removed }) };
    }, 1024) };
    case "search": {
      const path = maybe(row.path, str), matches = maybe(row.matches, int);
      return { ...b, type: "search", scope: pick(row.scope, ["files", "content", "unknown"] as const), query: row.query === null ? null : str(row.query), ...(path === undefined ? {} : { path }), ...(matches === undefined ? {} : { matches }) };
    }
    case "web": {
      const query = maybe(row.query, str), url = maybe(row.url, str), title = maybe(row.title, str);
      return { ...b, type: "web", action: pick(row.action, ["search", "fetch"] as const), ...(query === undefined ? {} : { query }), ...(url === undefined ? {} : { url }), ...(title === undefined ? {} : { title }) };
    }
    case "mcp_tool": { const hub = maybe(row.hub, flag); return { ...b, type: "mcp_tool", server: str(row.server), tool: str(row.tool), ...(hub === undefined ? {} : { hub }) }; }
    case "tool": return { ...b, type: "tool", name: str(row.name) };
    case "subagent": return { ...b, type: "subagent", title: str(row.title) };
    case "plan": {
      const explanation = maybe(row.explanation, str);
      return { ...b, type: "plan", steps: many(row.steps, value => { const step = obj(value); return { text: str(step.text), status: pick(step.status, ["pending", "in_progress", "completed"] as const) }; }, 128), ...(explanation === undefined ? {} : { explanation }) };
    }
    case "plan_proposal": return { ...b, type: "plan_proposal", markdown: str(row.markdown) };
    case "recap": { const ask = maybe(row.ask, str), actions = maybe(row.actions, words); return { ...b, type: "recap", summary: str(row.summary), ...(ask === undefined ? {} : { ask }), ...(actions === undefined ? {} : { actions }) }; }
    case "approval": {
      const decision = maybe(row.decision, value => { const made = obj(value); return { role: pick(made.role, APPROVAL_ROLES), by: pick(made.by, ["user", "policy", "timeout", "harness"] as const), at: amount(made.at) }; });
      return { ...b, type: "approval", subject: pick(row.subject, APPROVAL_SUBJECTS), title: str(row.title), options: many(row.options, value => { const option = obj(value); return { id: str(option.id), role: pick(option.role, APPROVAL_ROLES), label: str(option.label) }; }, 16), ...(decision === undefined ? {} : { decision }) };
    }
    case "question": { const answer = maybe(row.answer, str); return { ...b, type: "question", title: str(row.title), ...(answer === undefined ? {} : { answer }) }; }
    case "notice": { const code = maybe(row.code, str), more = maybe(row.more, str); return { ...b, type: "notice", severity: pick(row.severity, ["info", "warning"] as const), text: str(row.text), ...(code === undefined ? {} : { code }), ...(more === undefined ? {} : { more }) }; }
    case "error": { const code = maybe(row.code, str); return { ...b, type: "error", class: pick(row.class, ERROR_CLASSES), message: str(row.message), ...(code === undefined ? {} : { code }) }; }
    case "context_event": return { ...b, type: "context_event", kind: pick(row.kind, ["compaction", "clear", "rewind"] as const) };
    case "switch": {
      const turns = maybe(row.turns, int), delivery = maybe(row.delivery, value => pick(value, ["sending", "confirmed", "unconfirmed", "not_sent"] as const)), packetId = maybe(row.packetId, str);
      return { ...b, type: "switch", from: executor(row.from), to: executor(row.to), context: pick(row.context, ["full", "delta", "resend", "none", "native", "unknown"] as const), session: pick(row.session, ["new", "resumed", "unknown"] as const),
        ...(turns === undefined ? {} : { turns }), ...(delivery === undefined ? {} : { delivery }), ...(packetId === undefined ? {} : { packetId }) };
    }
    case "interrupt": return { ...b, type: "interrupt", by: pick(row.by, ["user", "hub"] as const) };
    case "delegation": return { ...b, type: "delegation", to: executor(row.to), task: str(row.task) };
    case "artifact": {
      const content = maybe(row.content, value => parseContentRef(value)), uri = maybe(row.uri, str);
      return { ...b, type: "artifact", kind: pick(row.kind, ["file", "image", "link"] as const), name: str(row.name), ...(content === undefined ? {} : { content }), ...(uri === undefined ? {} : { uri }) };
    }
    default: return fail();
  }
}

/**
 * One item: of its own type when the type is known and its fields read whole; otherwise the line kept for it. `fallback` is the id
 * and place an item gets when it names none of its own.
 */
function item(value: unknown, index: number): ReadItem {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const id = typeof row.id === "string" && row.id ? row.id : "item-" + index, seq = typeof row.seq === "number" && Number.isSafeInteger(row.seq) ? row.seq : index;
  const kind = typeof row.type === "string" ? row.type : "";
  try {
    if (!(ITEM_TYPES as readonly string[]).includes(kind)) return fail();
    return typed(row, base(row, id, seq));
  } catch {
    // Kept, not dropped: what is known of it, and "unknown" for a state it could not read (never "completed").
    const status: ItemStatus = typeof row.status === "string" && (ITEM_STATUSES as readonly string[]).includes(row.status) ? row.status as ItemStatus : "unknown";
    const parentId = typeof row.parentId === "string" ? row.parentId : undefined, nativeName = typeof row.nativeName === "string" ? row.nativeName : undefined;
    return { id, seq, status, type: "unrecognized", nativeType: kind, ...(parentId === undefined ? {} : { parentId }), ...(nativeName === undefined ? {} : { nativeName }) };
  }
}

/** A Turn as the Gateway sent it, or undefined when it is not a Turn of this protocol (the Run is then drawn without it). */
export function decodeProtocolTurn(value: unknown): ReadTurn | undefined {
  try {
    const row = obj(value);
    if (row.version !== PROTOCOL_VERSION || !Array.isArray(row.items) || row.items.length > 4096) return undefined;
    const stopReason = maybe(row.stopReason, value => typeof value === "string" && (STOP_REASONS as readonly string[]).includes(value) ? value as typeof STOP_REASONS[number] : "unknown" as const);
    const startedAt = maybe(row.startedAt, amount), durationMs = maybe(row.durationMs, amount);
    let reading: ReturnType<typeof usage>;
    try { reading = usage(row.usage); } catch { reading = { completeness: "unavailable" }; }
    // Ids are the keys of what is drawn: an id that repeats is told apart rather than drawn over its first.
    const seen = new Map<string, number>();
    const items = row.items.map((entry, index) => {
      const read = item(entry, index), again = (seen.get(read.id) ?? 0) + 1;
      seen.set(read.id, again);
      return again === 1 ? read : { ...read, id: read.id + "~" + again };
    });
    return { version: PROTOCOL_VERSION, runId: runId(row.runId), n: int(row.n), status: pick(row.status, TURN_STATUSES), ...(stopReason === undefined ? {} : { stopReason }),
      executor: executor(row.executor), usage: reading, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }), items };
  } catch { return undefined; }
}
