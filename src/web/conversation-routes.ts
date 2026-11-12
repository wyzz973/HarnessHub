import {
  PAGE, type ConversationCommit, type ConversationReader, type HeadRow, type ItemRow, type RunRow, type SessionListCursor, type SessionListPage, type SessionListQuery, type TurnCursor,
} from "../contracts/conversation.js";
import type { HarnessSelection, NativeConfiguration, NativeSessionBinding, PublicSwitch, RunId, SessionId, SessionOrigin } from "../contracts/session.js";
import { SessionError, sessionId } from "../contracts/session.js";
import type { NativeOptions } from "../contracts/control.js";
import type { PlanStep } from "../contracts/protocol.js";
import type {
  ConversationChangesView, ConversationEdit, ItemTextView, ItemView, KeptProcessView, NativeStateView, RunItemsPageView, SessionFacts, SessionHeadView, SessionListView, SessionView, SessionViewV14, TurnPageView, TurnWindowView,
} from "../contracts/web.js";
import type { FrameViews } from "./commit-frame.js";
import { TurnView, isTaskListCall, turnFactsOf, type ConversationFactsPort, type RunRelayReading, type TurnEnv } from "./turn-view.js";
import { wireItem } from "./commit-frame.js";

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
/** What the Runs of a conversation say as a whole (`ConversationFacts.runSummary`). */
export interface RunSummaryPort {
  readonly open: number;
  readonly unknown: number;
  readonly unclosed: boolean;
  readonly branchable: { readonly runId: RunId; readonly ordinal: number } | null;
  readonly ran: readonly { readonly harnessId: string; readonly controlId: string; readonly turns: number }[];
}
/** An edit of a conversation (a file change with a stored detail) and where it is (`ConversationFacts.edits`). */
export interface EditPlace { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly seq: number }
/** The reads beside the pages that the head and a Turn are made of (`ConversationFacts` in infrastructure/session/facts.ts). */
export interface ViewFacts extends ConversationFactsPort {
  runById(runId: RunId): RunRow | null;
  lastSwitch(id: SessionId): PublicSwitch | null;
  origin(id: SessionId): SessionOrigin | null;
  runSummary(id: SessionId): RunSummaryPort;
  plainTools(runId: RunId): readonly ItemRow[];
  dispatchedBefore(id: SessionId, harnessId: string, controlId: string, ordinal: number): boolean;
  edits(id: SessionId): readonly EditPlace[];
  latestPlan(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: ItemRow } | null;
  /** The wrap-up of the latest finished Turn, when it gave one; optional. */
  latestRecap?(id: SessionId): { readonly ordinal: number; readonly runId: RunId; readonly harnessId: string; readonly row: ItemRow } | null;
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
/** How many conversations' totals (what their Runs say as a whole, where their edits are) are kept: a head is made for every commit, and these change far less often than commits come. */
const TOTALS_KEPT = 16;
/** The edits of a page of the conversation's changes when a read names no size; like every page size here, a size and not a bound. */
const EDITS_PAGE = 40;
/** What is kept of a conversation for its heads: valid for the version it names, moved along by the commits `observe` is told of. */
interface Kept<T> { version: number; value: T }
function remember<T>(map: Map<SessionId, Kept<T>>, id: SessionId, kept: Kept<T>): void {
  map.delete(id); map.set(id, kept);
  if (map.size > TOTALS_KEPT) map.delete(map.keys().next().value!);
}

export class ConversationRoutes {
  private readonly origins = new Map<SessionId, SessionOrigin | null>();
  private readonly summaries = new Map<SessionId, Kept<RunSummaryPort>>();
  private readonly editLists = new Map<SessionId, Kept<EditPlace[]>>();
  private readonly hubEditLists = new Map<SessionId, Kept<{ readonly places: readonly EditPlace[]; readonly files: number }>>();
  /** The Runs whose dispatch a commit was already asked about (see `needsSnapshot`). */
  private readonly dispatched = new Set<RunId>();
  constructor(private readonly options: ConversationRoutesOptions) {}

  /**
   * Whether a commit is better told as the conversation than as a frame (ADR-057 3.4: what a stream builds equals what a read gives). A frame carries what a commit wrote; some of what a Turn shows is not
   * a function of the rows one commit wrote:
   *  - the Harness's task list: a call to it is not a row of the Turn when the Turn has a plan of its own, or the call's stored input reads exactly (then the plan stands for it, at the place of the
   *    last such call), so the commit that writes such a call, the one that gives the Turn its own plan, and the one that ends a Turn that has such calls change lines a frame does not carry;
   *  - the model a Turn shows: the one its selection named, else, for the latest Turn of its control, the one the control's binding reported. A commit that writes a binding, or dispatches a Turn on a
   *    control that ran another before, changes the lines of Turns it does not write.
   * The hub answers a connection that is told such a commit with the conversation (a snapshot), which is a read. Called for each commit that has a subscriber, once.
   */
  needsSnapshot(commit: ConversationCommit): boolean {
    const changes = commit.changes;
    // A branch changes which Turns the conversation has: it is told whole.
    if (commit.events.some(event => event.type === "conversation.branched")) return true;
    for (const write of changes.items ?? []) if ((write.row.itemId === "plan" && write.op === "insert") || isTaskListCall(write.row)) return true;
    if ((changes.bindings ?? []).length > 0) return true;
    for (const write of changes.runs ?? []) {
      const row = write.row;
      if (row.dispatched && !this.dispatched.has(row.runId)) {
        this.dispatched.add(row.runId);
        if (this.dispatched.size > TOTALS_KEPT * 32) this.dispatched.delete(this.dispatched.values().next().value!);
        if (this.options.facts.dispatchedBefore(row.sessionId, row.harnessId, row.controlId, row.ordinal)) return true;
      }
      if (row.status === "completed" || row.status === "failed" || row.status === "cancelled" || row.status === "unknown") {
        if (this.options.facts.plainTools(row.runId).some(isTaskListCall)) return true;
      }
    }
    return false;
  }

  /**
   * A commit was kept: what is held of its conversation moves along with it. The totals of the Runs change only when a Run's row was written; the edits, when an item that is a
   * file change with a stored detail was. A conversation whose held totals are not of the version before the commit (a commit this was not told of) is read again, not guessed.
   * Told of every commit before its frame is made; a read that finds the held totals are not of its version reads them again, so a commit this is not told of costs a read and no wrong answer.
   */
  observe(commit: ConversationCommit): void {
    const written = commit.changes.head?.row;
    if (written === undefined) return;
    const id = written.id as SessionId;
    if (commit.events.some(event => event.type === "conversation.branched")) { this.summaries.delete(id); this.editLists.delete(id); return; }
    const summary = this.summaries.get(id);
    if (summary !== undefined) {
      if (summary.version === written.version - 1 && (commit.changes.runs ?? []).length === 0) summary.version = written.version; else this.summaries.delete(id);
    }
    const list = this.editLists.get(id);
    if (list === undefined) return;
    if (list.version !== written.version - 1) { this.editLists.delete(id); return; }
    for (const write of commit.changes.items ?? []) {
      const row = write.row;
      if (row.type !== "file_change" || ((row.fields as { readonly detail?: unknown }).detail === undefined && (row.fields as { readonly by?: unknown }).by !== "hub")) continue;
      if (list.value.some(held => held.runId === row.runId && held.seq === row.seq)) continue;
      const run = this.options.facts.runById(row.runId);
      if (run === null) { this.editLists.delete(id); return; }
      const place: EditPlace = { ordinal: run.ordinal, runId: row.runId, harnessId: run.facts.selection.harnessId, seq: row.seq };
      let at = list.value.length;
      while (at > 0 && (list.value[at - 1]!.ordinal > place.ordinal || (list.value[at - 1]!.ordinal === place.ordinal && list.value[at - 1]!.seq > place.seq))) at--;
      list.value.splice(at, 0, place);
    }
    list.version = written.version;
  }
  private summaryOf(id: SessionId, version: number): RunSummaryPort {
    const kept = this.summaries.get(id);
    if (kept !== undefined && kept.version === version) return kept.value;
    const value = this.options.facts.runSummary(id);
    remember(this.summaries, id, { version, value });
    return value;
  }
  private rawEditsOf(id: SessionId, version: number): readonly EditPlace[] {
    const kept = this.editLists.get(id);
    if (kept !== undefined && kept.version === version) return kept.value;
    const value = [...this.options.facts.edits(id)];
    remember(this.editLists, id, { version, value });
    return value;
  }
  /**
   * The conversation's changes as the page lists and counts them (docs/decisions/LOG.md, 2026-11-12): a Turn the Hub recorded itself is its one
   * record (the `workspace` item, what the workspace really changed), and the Harness's own edits of that Turn stay in its items only; a Turn
   * without a record is its Harness's edits. `files`: the files changed, as the page's "本对话改动 N 处" says them (one for an edit of the Harness).
   */
  private editsOf(id: SessionId, version: number): readonly EditPlace[] { return this.hubEdits(id, version).places; }
  private hubEdits(id: SessionId, version: number): { readonly places: readonly EditPlace[]; readonly files: number } {
    const kept = this.hubEditLists.get(id);
    if (kept !== undefined && kept.version === version) return kept.value;
    const raw = this.rawEditsOf(id, version), records = new Map<RunId, { place: EditPlace; files: number }>();
    for (const place of raw) {
      const row = this.options.facts.item(place.runId, place.seq);
      if (row?.itemId === "workspace") records.set(place.runId, { place, files: (row.fields as { readonly changes?: readonly unknown[] }).changes?.length ?? 1 });
    }
    const places = raw.filter(place => { const record = records.get(place.runId); return record === undefined || record.place === place; });
    const value = { places, files: places.reduce((sum, place) => sum + (records.get(place.runId)?.place === place ? records.get(place.runId)!.files : 1), 0) };
    remember(this.hubEditLists, id, { version, value });
    return value;
  }
  /** What the page used to learn from every Turn, for the head of version `version` (see `SessionFacts`). */
  private factsOf(id: SessionId, version: number): SessionFacts {
    const summary = this.summaryOf(id, version);
    return { unknown: { count: summary.unknown, unclosed: summary.unclosed }, settled: summary.open === 0, branchable: summary.branchable === null ? null : { runId: summary.branchable.runId, ordinal: summary.branchable.ordinal },
      ran: summary.ran.map(entry => ({ harnessId: entry.harnessId, controlId: entry.controlId, turns: entry.turns })), changes: this.hubEdits(id, version).files };
  }

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
    const last = facts.lastSwitch(id), origin = json.origin === undefined ? null : this.originOf(id);
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
      title: row.title, runCount: row.runCount, ...(last === null ? {} : { lastSwitch: last }), facts: this.factsOf(id, row.version), ...this.progressOf(id) };
  }
  /** The latest task list and the latest Turn's wrap-up, from what each Turn's end recorded (only the Turns that hold them are read). */
  private progressOf(id: SessionId): Pick<SessionHeadView, "plan" | "recap"> {
    const { facts } = this.options, plan = facts.latestPlan(id), recap = facts.latestRecap?.(id) ?? null;
    const planFields = plan === null ? null : plan.row.fields as { readonly type: string; readonly steps?: readonly PlanStep[]; readonly explanation?: string };
    const recapFields = recap === null ? null : recap.row.fields as { readonly type: string; readonly summary?: string; readonly ask?: string; readonly actions?: readonly string[] };
    return { ...(plan === null || planFields?.type !== "plan" || !Array.isArray(planFields.steps) ? {} : { plan: { runId: plan.runId, ordinal: plan.ordinal, harnessId: plan.harnessId,
        steps: planFields.steps.map(step => ({ text: step.text, status: step.status })), ...(planFields.explanation === undefined ? {} : { explanation: planFields.explanation }) } }),
      ...(recap === null || recapFields?.type !== "recap" || typeof recapFields.summary !== "string" ? {} : { recap: { runId: recap.runId, ordinal: recap.ordinal, harnessId: recap.harnessId,
        summary: recapFields.summary, ...(recapFields.ask === undefined ? {} : { ask: recapFields.ask }), ...(recapFields.actions === undefined ? {} : { actions: recapFields.actions }) } }) };
  }
  head(id: string): SessionHeadView { return this.headView(this.headRow(id)); }
  /** The Turns of a conversation as the wire tells them, for a reader that goes through them one at a time (the export). A conversation that is not there, or was deleted, is not found. */
  turnView(id: string): TurnView { return this.viewOf(this.headRow(id).id); }

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
  /** GET /api/v1/sessions/:id/changes?before=<cursor>&limit= */
  changes(id: string, query: { readonly before?: string | undefined; readonly limit?: string | number | undefined }): ConversationChangesView {
    const row = this.headRow(id), limit = whole(query.limit, "limit", 1) ?? EDITS_PAGE, edits = this.editsOf(row.id, row.version);
    let end = edits.length;
    if (query.before !== undefined) {
      const match = /^(0|[1-9][0-9]*):([1-9][0-9]*)$/u.exec(query.before);
      if (match === null) return refuse("before is the cursor of the changes the page lies before");
      const ordinal = Number(match[1]), seq = Number(match[2]);
      end = edits.findIndex(place => place.ordinal > ordinal || (place.ordinal === ordinal && place.seq >= seq));
      if (end < 0) end = edits.length;
    }
    const start = Math.max(0, end - limit), view = this.viewOf(row.id), runs = new Map<string, RunRow>();
    const page: ConversationEdit[] = [];
    for (const place of edits.slice(start, end).reverse()) {
      const run = runs.get(place.runId) ?? this.options.facts.runAt(row.id, place.ordinal), stored = this.options.facts.item(place.runId, place.seq);
      if (run === null || stored === null) continue;
      runs.set(place.runId, run);
      page.push({ runId: place.runId, ordinal: place.ordinal, harnessId: place.harnessId, item: view.item(run, { ...stored, text: [] }) });
    }
    const next = start > 0 ? edits[start]!.ordinal + ":" + edits[start]!.seq : null;
    if (query.before !== undefined) return { edits: page, next };
    const plan = this.options.facts.latestPlan(row.id);
    return { edits: page, next, plan: plan === null ? null : { runId: plan.runId, ordinal: plan.ordinal, harnessId: plan.harnessId, item: wireItem(plan.row) } };
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
