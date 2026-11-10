// G068 (ADR-055 §7.2): the native-history reference model of a fake Harness. It keeps what each native session really
// holds — the user entries the Hub's inputs became (with their client id, the packet each carried and the public facts that
// packet covered, at a stable position), a compaction summary and its cursor, and the inputs a cancelled Turn may still
// write later — and answers a Driver's check of that history the way §7.1 describes it: marker by marker after a recorded
// position, inside a window, with or without compaction evidence. Tests drive the Hub's state machine against it and ask it
// for the ground truth; nothing here decides what the Hub believes.
//
// Run with `child_process.fork` (an IPC channel): each message `{ id, op, args }` gets `{ id, ok: true, result }` or
// `{ id, ok: false, error }`; `{ op: "batch", args: { ops: [...] } }` runs several in order. Synthetic data only; nothing is
// written to disk.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const sha = text => createHash("sha256").update(text, "utf8").digest("hex");

/** One native session: its entries in order, each with a serial that is never reused (a stable position). */
class NativeSession {
  constructor(id) {
    this.id = id;
    /** { serial, kind: "user", runId, packetId, facts: string[], origin } | { serial, kind: "reply", runId } */
    this.entries = [];
    this.serial = 0;
    this.cursor = { count: 0, digest: null };
    /** What compaction folded into its summary: the facts and packets it still knows of, or null before any compaction. */
    this.summary = null;
    /** Inputs a cancelled Turn will still write (lateDelivery). */
    this.late = [];
    /** How many clears ran on this session: the ground truth a confirmed clear (a new native epoch) must stand on. */
    this.clears = 0;
  }
  append(entry) { this.entries.push({ ...entry, serial: ++this.serial }); }
  users() { return this.entries.filter(entry => entry.kind === "user"); }
}

export class NativeHistories {
  constructor() { this.sessions = new Map(); }
  session(id) {
    let session = this.sessions.get(id);
    if (session === undefined) { session = new NativeSession(id); this.sessions.set(id, session); }
    return session;
  }
  /** The position a Driver records before dispatch: the serial of the last entry (a check reads entries after it). */
  position({ session }) { return { kind: "seq", before: this.session(session).serial }; }
  /**
   * An input reaches the native side: `insert` "now" appends its user entry (and a reply unless `reply` is false), "late"
   * keeps it for flushLate (a cancelled Turn's input written afterwards), "never" drops it (refused before insertion, or
   * lost with the process).
   */
  send({ session, runId, packetId = null, facts = [], origin = false, insert, reply = true }) {
    const native = this.session(session), entry = { kind: "user", runId, packetId, facts: [...facts], origin };
    if (insert === "now") { native.append(entry); if (reply) native.append({ kind: "reply", runId }); }
    else if (insert === "late") native.late.push(entry);
    else if (insert !== "never") throw new Error("unknown insertion " + insert);
    return { inserted: insert === "now" };
  }
  /** The late inputs are written now, after whatever came since. */
  flushLate({ session }) {
    const native = this.session(session), written = native.late.length;
    for (const entry of native.late.splice(0)) native.append(entry);
    return { written };
  }
  /** All user entries but the last `keep` (and their replies) fold into the summary; the cursor moves when anything folded. */
  compact({ session, keep = 1 }) {
    const native = this.session(session), users = native.users();
    if (users.length <= keep) return { cursor: native.cursor, folded: 0 };
    const cut = users[users.length - keep]?.serial ?? Number.MAX_SAFE_INTEGER, folded = native.entries.filter(entry => entry.serial < cut);
    native.entries = native.entries.filter(entry => entry.serial >= cut);
    native.summary ??= { facts: new Set(), packets: new Set(), runs: new Set(), origin: false };
    for (const entry of folded) {
      if (entry.kind !== "user") continue;
      for (const fact of entry.facts) native.summary.facts.add(fact);
      if (entry.packetId !== null) native.summary.packets.add(entry.packetId);
      native.summary.runs.add(entry.runId);
      native.summary.origin ||= entry.origin;
    }
    native.cursor = { count: native.cursor.count + 1, digest: sha("compaction:" + native.id + ":" + (native.cursor.count + 1)) };
    return { cursor: native.cursor, folded: folded.length };
  }
  /** The history is emptied (a clear); the cursor stays, late inputs still come. */
  clear({ session }) {
    const native = this.session(session);
    native.entries = []; native.summary = null; native.clears += 1;
    return { historyEmpty: true, clears: native.clears };
  }
  /**
   * The user types in the original program itself: a user entry and a reply that are no Hub Turn (no run id, no packet, no
   * fact). After a clear this is what makes a replay non-empty although the clear happened.
   */
  nativeTurn({ session }) {
    const native = this.session(session);
    native.append({ kind: "user", runId: null, packetId: null, facts: [], origin: false }); native.append({ kind: "reply", runId: null });
    return { entries: native.entries.length };
  }
  /** The last `n` user entries and what followed them are removed (an undo). */
  rewind({ session, n = 1 }) {
    const native = this.session(session), users = native.users();
    if (users.length === 0) return { removed: 0 };
    const cut = users[Math.max(0, users.length - n)].serial, before = native.entries.length;
    native.entries = native.entries.filter(entry => entry.serial < cut);
    return { removed: before - native.entries.length };
  }
  /**
   * A Driver's check (§7.1 E2): for each marker, the user entries after its position are searched for its packet. Present when
   * one of them in the window has it; outside_window when the window does not reach the position; compacted when the
   * summary folded it and the Driver has compaction evidence (absent otherwise); absent else. `readable` false answers
   * unavailable everywhere. historyEmpty is reported by Drivers that read the whole history (`wholeHistory`).
   */
  verify({ session, markers, window = 200, compaction = true, readable = true, wholeHistory = true }) {
    const native = this.session(session);
    if (!readable) return { markers: markers.map(marker => ({ packetId: marker.packetId, result: "unavailable" })), historyEmpty: null, compaction: null, foreignAfterLast: null, verifyMs: 0 };
    const visible = native.entries.slice(-window), start = visible[0]?.serial ?? native.serial + 1;
    const results = markers.map(marker => {
      const found = visible.some(entry => entry.kind === "user" && entry.serial > marker.after && entry.packetId === marker.packetId);
      if (found) return { packetId: marker.packetId, result: "present" };
      if (native.entries.some(entry => entry.serial > marker.after && entry.serial < start)) return { packetId: marker.packetId, result: "outside_window" };
      if (native.summary?.packets.has(marker.packetId)) return { packetId: marker.packetId, result: compaction ? "compacted" : "absent" };
      return { packetId: marker.packetId, result: "absent" };
    });
    return { markers: results, historyEmpty: wholeHistory ? native.entries.length === 0 && native.summary === null : null,
      compaction: compaction ? native.cursor : null, foreignAfterLast: null, verifyMs: 0 };
  }
  /** Whether the user entry of Turn `runId` follows `after` (an unknown Turn without a packet, D6). */
  entry({ session, runId, after, readable = true }) {
    const native = this.session(session);
    if (!readable) return { result: "unavailable" };
    if (native.entries.some(entry => entry.kind === "user" && entry.runId === runId && entry.serial > after)) return { result: "present" };
    if (native.summary?.runs.has(runId)) return { result: "compacted" };
    return { result: "absent" };
  }
  /**
   * The ground truth: the facts, packets and Turns the native session holds, in its entries or its summary; `entryFacts` and
   * `entryRuns` are those its entries alone hold (what a Driver without compaction evidence can still see, G068 fix batch).
   */
  held({ session }) {
    const native = this.session(session), facts = new Set(native.summary?.facts ?? []), packets = new Set(native.summary?.packets ?? []), runs = new Set(native.summary?.runs ?? []);
    const entryFacts = new Set(), entryRuns = new Set();
    let origin = native.summary?.origin ?? false;
    for (const entry of native.users()) {
      for (const fact of entry.facts) { facts.add(fact); entryFacts.add(fact); }
      if (entry.packetId !== null) packets.add(entry.packetId);
      runs.add(entry.runId); entryRuns.add(entry.runId); origin ||= entry.origin;
    }
    runs.delete(null); entryRuns.delete(null);
    return { facts: [...facts].sort(), packets: [...packets].sort(), runs: [...runs].sort(), entryFacts: [...entryFacts].sort(), entryRuns: [...entryRuns].sort(), origin,
      entries: native.entries.length, cursor: native.cursor, late: native.late.length, clears: native.clears };
  }
  /** Forgets every session (between property cases). */
  reset() { this.sessions.clear(); return { sessions: 0 }; }
}

const OPS = ["position", "send", "flushLate", "compact", "clear", "nativeTurn", "rewind", "verify", "entry", "held", "reset"];
function run(model, op, args) {
  if (op === "batch") return args.ops.map(item => run(model, item.op, item.args ?? {}));
  if (!OPS.includes(op)) throw new Error("unknown operation " + op);
  return model[op](args ?? {});
}

if (process.argv[1] === fileURLToPath(import.meta.url) && typeof process.send === "function") {
  const model = new NativeHistories();
  process.on("message", message => {
    const { id, op, args } = message ?? {};
    try { process.send({ id, ok: true, result: run(model, op, args) }); }
    catch (error) { process.send({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
  process.on("disconnect", () => process.exit(0));
  process.send({ id: 0, ok: true, result: "ready" });
}
