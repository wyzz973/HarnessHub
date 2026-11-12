import {
  PAGE, type ConversationReader, type HeadRow, type RunRow, type SessionListCursor, type SessionListPage, type SessionListQuery, type TurnCursor,
} from "../contracts/conversation.js";
import type { HarnessSelection, NativeConfiguration, NativeSessionBinding, PublicSwitch, RunId, SessionId, SessionOrigin } from "../contracts/session.js";
import { SessionError, sessionId } from "../contracts/session.js";
import type { NativeOptions } from "../contracts/control.js";
import type {
  ItemTextView, ItemView, KeptProcessView, NativeStateView, RunItemsPageView, SessionHeadView, SessionListView, SessionView, SessionViewV14, TurnPageView, TurnWindowView,
} from "../contracts/web.js";
import type { FrameViews } from "./commit-frame.js";
import { TurnView, turnFactsOf, type ConversationFactsPort, type RunRelayReading, type TurnEnv } from "./turn-view.js";

/*
 * The reads of a conversation kept as rows, as the web API answers them (ADR-057 3.4; the routes are in the comments of the types in contracts/web.ts):
 *
 *   GET /api/v1/sessions/:id                                      session(id)              the head and the newest Turns up to a size
 *   GET /api/v1/sessions/:id/turns?before=<cursor>&limit=         turns(id, query)         the page of Turns before a cursor
 *   GET /api/v1/sessions/:id/runs/:ordinal/items?after=&limit=    runItems(id, ordinal, query)   the items of a Turn from a place on
 *   GET /api/v1/sessions/:id/runs/:ordinal/items/:seq             item(id, ordinal, seq)   one item whole
 *   GET /api/v1/sessions/:id/runs/:ordinal/items/:seq/text?from=&to=   itemText(...)       a byte range of an item's text
 *   GET /api/v1/sessions?after=<cursor>&limit=                    sessions(query)          the conversations, newest first, a page at a time
 *
 * Plain functions of the strings a URL carries, over a reader of the rows: the server mounts them, a test calls them. A value that is not the shape it must
 * be (a cursor that is none, a number that is not one, a range that ends before it starts) is `INVALID_INPUT`, which the server answers with a 400; a conversation, a Turn or an
 * item that is not there is `…_NOT_FOUND`. `limit` is the size of a page: there is no largest, and no page after which the conversation stops (a Turn's words are read by
 * byte range, a conversation by cursor); what a page carries at most is its own byte budget (`PAGE.windowBytes`), so that one page never has to be the whole.
 */

/** The size of a page of items when a read names none; like every page size here, a size and not a bound. */
const ITEMS_PAGE = 100;

/** What only the running service knows of a conversation: the requests that wait for the user, a slot it waits for, the process it keeps. */
export interface HeadLive {
  readonly permissions?: SessionView["permissions"];
  readonly queue?: SessionView["queue"];
  readonly retention?: { readonly process?: KeptProcessView | null; readonly lost?: NonNullable<SessionView["retention"]>["lost"]; readonly outside?: NonNullable<SessionView["retention"]>["outside"];
    readonly upgraded?: NonNullable<SessionView["retention"]>["upgraded"] };
}
/** The reads beside the pages that the head and a Turn are made of (`ConversationFacts` in infrastructure/session/facts.ts). */
export interface ViewFacts extends ConversationFactsPort {
  runById(runId: RunId): RunRow | null;
  pendingSwitch(id: SessionId): PublicSwitch | null;
  origin(id: SessionId): SessionOrigin | null;
}
export interface ConversationSource extends ConversationReader { list(query?: SessionListQuery): SessionListPage }
export interface ConversationRoutesOptions {
  readonly reader: ConversationSource;
  readonly facts: ViewFacts;
  /** The relay's reading of the Runs of a conversation: asked once for each read, then for each Run of it. */
  readonly relay: (id: SessionId) => (row: RunRow) => RunRelayReading;
  readonly env: TurnEnv;
  readonly live?: ((id: SessionId) => HeadLive) | undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// The shape of what a URL carries
// ---------------------------------------------------------------------------------------------------------------------

function refuse(message: string): never { throw new SessionError("INVALID_INPUT", message); }
/** A whole number from `min` that a URL spells in digits (or a number that is one); undefined when it is not given. Never rounded, never clamped. */
function whole(value: string | number | undefined, label: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "number" ? value : /^(?:0|[1-9][0-9]*)$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < min) return refuse(label + " must be a whole number from " + min);
  return number;
}
function required(value: string | number, label: string, min: number): number { return whole(value, label, min) ?? refuse(label + " is needed"); }
/** A failure of a reader that is the shape of what was asked (a cursor it cannot open) is told as such. */
function asked<T>(read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof SessionError && error.code === "INVALID_CURSOR") throw new SessionError("INVALID_INPUT", error.message);
    throw error;
  }
}
const missing = (code: string, message: string): never => { throw new SessionError(code, message); };

/** What the native session changed of its configuration by its own commands since its last Turn under the same epoch: the next Turn applies it (`carriedNativeConfiguration`, domain/state.ts, over the rows). */
function carriedOf(selection: HarnessSelection, epoch: number, binding: NativeSessionBinding | undefined, last: RunRow | null): { readonly model?: string; readonly options?: NativeOptions } | null {
  if (selection.provider !== undefined) return null;
  const observed: NativeConfiguration | undefined = binding?.observed;
  if (observed === undefined || last === null || last.epoch !== epoch) return null;
  const model = selection.nativeModel !== undefined && observed.model !== null && observed.model !== selection.nativeModel ? observed.model : undefined;
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(selection.nativeOptions ?? {})) { const seen = observed.options[key]; if (seen !== undefined && seen !== value) options[key] = seen; }
  if (model === undefined && !Object.keys(options).length) return null;
  return { ...(model === undefined ? {} : { model }), ...(Object.keys(options).length ? { options } : {}) };
}

/** How many conversations' origins are kept; an origin never changes once the conversation has it (a trigger refuses a change), and a head is made for every commit. */
const ORIGINS_KEPT = 16;

export class ConversationRoutes {
  private readonly origins = new Map<SessionId, SessionOrigin | null>();
  constructor(private readonly options: ConversationRoutesOptions) {}

  /** The history a conversation started from, read once (it can be a branch's hundreds of quoted messages) and kept for the heads that follow. */
  private originOf(id: SessionId): SessionOrigin | null {
    const kept = this.origins.get(id);
    if (kept !== undefined) { this.origins.delete(id); this.origins.set(id, kept); return kept; }
    const read = this.options.facts.origin(id);
    this.origins.set(id, read);
    if (this.origins.size > ORIGINS_KEPT) this.origins.delete(this.origins.keys().next().value!);
    return read;
  }

  private headRow(id: string): HeadRow {
    const row = this.options.reader.head(sessionId(id));
    // A conversation that was deleted is hidden, and its rows kept while another quotes it.
    if (row.deletedAt !== null) return missing("SESSION_NOT_FOUND", "public Session was not found");
    return row;
  }
  private viewOf(id: SessionId): TurnView { return new TurnView(turnFactsOf(id, this.options.facts, this.options.relay(id)), this.options.env); }
  private runRow(id: SessionId, ordinal: string | number): RunRow {
    return this.options.facts.runAt(id, required(ordinal, "the Turn's ordinal", 0)) ?? missing("RUN_NOT_FOUND", "the Turn was not found");
  }

  // ---- the head -----------------------------------------------------------------------------------------------------

  /**
   * What `SessionView` says of a conversation without its history, made of a head row: the row of the read (`head(id)`), or the row a commit wrote (`Mutation.head.row`),
   * which is what a commit's frame is told with (`commitFrame` refuses a head that is not the one the commit wrote). What only the running service knows is brought in as it is now.
   */
  headView(row: HeadRow): SessionHeadView {
    const { facts, live: liveOf } = this.options, id = row.id, json = row.head, bindings = facts.bindings(id), live = liveOf?.(id) ?? {};
    const pending = row.pendingSwitchId === null ? null : facts.pendingSwitch(id), origin = json.origin === undefined ? null : this.originOf(id);
    const nativeStates: NativeStateView[] = bindings.flatMap(binding => {
      if (binding.status === "archived") return [];
      const same = binding.harnessId === json.selection.harnessId && binding.controlId === json.selection.controlId;
      const carried = same ? carriedOf(json.selection, row.epoch, bindings.find(item => item.harnessId === binding.harnessId && item.controlId === binding.controlId && item.status === "ready"),
        facts.lastDispatched(id, binding.harnessId, binding.controlId, { native: true })) : null;
      return [{ harnessId: binding.harnessId, controlId: binding.controlId, status: binding.status === "fork-pending" || binding.status === "forking" ? "forking" as const : binding.status,
        ...(binding.observed === undefined ? {} : { observed: binding.observed }), ...(carried === null ? {} : { carried }) }];
    });
    const kept = live.retention;
    return { id, version: row.version, lastSeq: row.lastSeq, epoch: row.epoch, status: row.status, workspace: json.configuration.workspace, selection: json.selection, activeRunId: row.activeRunId,
      pendingSwitchId: row.pendingSwitchId, permissions: live.permissions ?? [], nativeStates, ...(origin === null ? {} : { origin }), ...(live.queue === undefined ? {} : { queue: live.queue }),
      retention: { enabled: json.retainNative === true, process: kept?.process ?? null, ...(kept?.lost === undefined ? {} : { lost: kept.lost }), ...(kept?.outside === undefined ? {} : { outside: kept.outside }),
        ...(kept?.upgraded === undefined ? {} : { upgraded: kept.upgraded }) },
      title: row.title, runCount: row.runCount, ...(pending === null ? {} : { pendingSwitch: pending }) };
  }
  head(id: string): SessionHeadView { return this.headView(this.headRow(id)); }

  // ---- the routes ---------------------------------------------------------------------------------------------------

  /** GET /api/v1/sessions/:id */
  session(id: string): SessionViewV14 {
    const row = this.headRow(id), window = this.options.reader.window(row.id);
    // One read, one moment: the head and the window are of the same commit (the reads are synchronous and the owner is the only writer).
    if (window.lastSeq !== row.lastSeq) throw new SessionError("INVALID_DATA", "the head and the window of the conversation were read at different commits");
    const view = this.viewOf(row.id);
    return { head: this.headView(row), window: { turns: window.turns.map(turn => view.turn(turn)), older: window.older } };
  }
  /** GET /api/v1/sessions/:id/turns?before=<cursor>&limit= */
  turns(id: string, query: { readonly before?: string | undefined; readonly limit?: string | number | undefined }): TurnPageView {
    const row = this.headRow(id), limit = whole(query.limit, "limit", 1);
    if (query.before === undefined) return refuse("before is needed: the cursor of the Turns the page lies before");
    const page = asked(() => this.options.reader.older(row.id, query.before as TurnCursor, limit === undefined ? {} : { turns: limit }));
    const view = this.viewOf(row.id);
    const out: TurnWindowView = { turns: page.turns.map(turn => view.turn(turn)), older: page.older };
    return out;
  }
  /** GET /api/v1/sessions/:id/runs/:ordinal/items?after=<seq>&limit= */
  runItems(id: string, ordinal: string | number, query: { readonly after?: string | undefined; readonly limit?: string | number | undefined }): RunItemsPageView {
    const row = this.headRow(id), run = this.runRow(row.id, ordinal);
    const page = this.options.reader.items(run.runId, whole(query.after, "after", 0) ?? 0, whole(query.limit, "limit", 1) ?? ITEMS_PAGE);
    const view = this.viewOf(row.id), answer = run.status === "completed" && page.items.some(held => held.type === "assistant_message") ? this.options.facts.finalSeq(run.runId) : null;
    return { items: page.items.map(held => view.item(run, held, { final: held.seq === answer })), next: page.next };
  }
  /** GET /api/v1/sessions/:id/runs/:ordinal/items/:seq */
  item(id: string, ordinal: string | number, seq: string | number): ItemView {
    const row = this.headRow(id), run = this.runRow(row.id, ordinal), place = required(seq, "the item's place", 0);
    const found = place === 0 ? undefined : this.options.reader.items(run.runId, place - 1, 1, { inlineBytes: Infinity }).items[0];
    if (found === undefined || found.seq !== place) return missing("ITEM_NOT_FOUND", "the item was not found");
    const answer = run.status === "completed" && found.type === "assistant_message" ? this.options.facts.finalSeq(run.runId) : null;
    return { item: this.viewOf(row.id).item(run, found, { final: found.seq === answer }) };
  }
  /** GET /api/v1/sessions/:id/runs/:ordinal/items/:seq/text?from=&to= */
  itemText(id: string, ordinal: string | number, seq: string | number, query: { readonly from?: string | number | undefined; readonly to?: string | number | undefined }): ItemTextView {
    const row = this.headRow(id), run = this.runRow(row.id, ordinal), place = required(seq, "the item's place", 0);
    const from = whole(query.from, "from", 0) ?? 0, to = whole(query.to, "to", 0);
    if (to !== undefined && to < from) return refuse("the range ends before it starts");
    return this.options.reader.text(run.runId, place, to === undefined ? { from } : { from, to });
  }
  /** GET /api/v1/sessions?after=<cursor>&limit= */
  sessions(query: { readonly after?: string | undefined; readonly limit?: string | number | undefined }): SessionListView {
    const limit = whole(query.limit, "limit", 1);
    const page = asked(() => this.options.reader.list({ ...(query.after === undefined ? {} : { after: query.after as SessionListCursor }), ...(limit === undefined ? {} : { limit }) }));
    return { sessions: page.rows.map(row => ({ id: row.id, title: row.title, status: row.status, workspace: row.workspace, selection: row.selection, updatedSeq: row.updatedSeq, activeRunId: row.activeRunId })), next: page.next };
  }

  // ---- the stream ---------------------------------------------------------------------------------------------------

  /** What `commitFrame` makes the Runs and the lines of a commit with, for one conversation: asked for once for each commit (what it remembers is of the moment it was made). */
  frameViews(id: SessionId): FrameViews {
    const view = this.viewOf(id);
    return { run: row => view.run(row), derived: row => view.derived(row), runById: runId => this.options.facts.runById(runId) };
  }
}
