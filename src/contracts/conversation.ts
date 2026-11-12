import type { ContextEffect } from "./control.js";
import type { ItemStatus, ItemType, ProtocolItem } from "./protocol.js";
import type { ExecutedOn, RelayRows } from "./relay.js";
import type {
  CommandId, CommandRecord, EventDraft, ForkedMessage, HarnessSelection, NativeSessionBinding, PublicRun, PublicSwitch, RetainedProcess, RunId, RunStatus,
  SessionConfiguration, SessionEvent, SessionId, SessionSnapshot, SwitchId,
} from "./session.js";

/*
 * A conversation kept as tables (ADR-057, store v14): the shapes between the lines of work. Types and constants only; nothing here is read by
 * a running path until the cut (docs/proposals/protocol/step2-plan.md). One rule runs through all of it:
 *
 *   FOREIGN DATA IS NEVER FATAL. What a Harness tells the Hub (a title, an id, a number, an exit code, a text) is normalized by the writer
 *   before a Mutation is built: NUL removed, a lone surrogate replaced, an empty label given its placeholder, an out-of-range number left
 *   out, an unknown word read as the protocol's fallback. Each change is told in `NativeFacts.clipped` and none is a reason to refuse: no
 *   check anywhere looks at the size or the content of foreign text. The store's row checks look at structure only (identities, enums,
 *   foreign keys, the monotonic facts), so a check that fails means the writer broke an invariant of ours. That ends the one Turn or the one
 *   request it belonged to, as a failure told in the conversation, and never stops the Runtime: `fail()` is for a store that cannot be
 *   trusted (storage, ownership, version), not for a limit or a validation (docs/research/limits-audit-2026-11-12.md, D21).
 */

/** The format of a conversation kept as tables. The business database's `user_version` is this once the first conversation is converted. */
export const CONVERSATION_FORMAT = 14 as const;
/** The format of a conversation kept as one snapshot JSON; a `sessions` row says it until the conversation is converted. */
export const LEGACY_FORMAT = 13 as const;

/**
 * How much one transfer carries. These are PAGE SIZES, not limits on what is stored: whatever a conversation holds can be read, a page at
 * a time, by cursor or byte range. (T3 Code's numbers: threadHistoryPaging.ts:16-23.)
 */
export const PAGE = {
  /** The newest Turns a conversation's first read carries, at most; and at least one Turn whatever its size. */
  windowTurns: 10,
  /** Where a window stops taking older Turns (the Turn that crosses it is included). */
  windowBytes: 1024 * 1024,
  /** Turns of a page of older Turns. */
  olderTurns: 20,
  /** A Turn with more completed actions than this in one stretch tells the middle of it as a `DeferredWork` placeholder. */
  deferredAfter: 150,
  /** The conversations of one list page. */
  sessions: 100,
  /** An item whose body is longer than this is sent with `bodyOmitted`, the body fetched whole or by byte range. */
  itemInlineBytes: 64 * 1024,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------------------------------

/**
 * An item's id, unique within its Run (`items(run_id, item_id)`): a tool call by the id its Harness gave it, an activity or permission by
 * the Hub's, the segments of text and reasoning and the notices and outputs by their count in the Run from 1. The same id reported again
 * is the same item (an upsert; nothing changes, nothing is committed). `seq`, the item's place in the Turn, is fixed when it is first seen.
 */
export type ItemId =
  | "user" | "switch" | "plan" | "error" | "clear"
  | `tool:${string}` | `activity:${string}` | `permission:${string}` | `context:${string}`
  | `text:${number}` | `think:${number}` | `notice:${number}` | `output:${number}`;

/**
 * What the Harness reported of a call, an activity or a notice, verbatim, kept beside the item the Hub made of it. The readers that put a
 * call in its own words (the relay's brief, the context table) read these, and so do the accessors that give the old flat shapes back
 * (`PublicTool`, `PublicNotice`, `PublicActivity`, `PublicOutput`): an item loses nothing its source carried.
 */
export interface NativeFacts {
  readonly title?: string;
  readonly kind?: string;
  readonly name?: string;
  /** The status word as reported (a free string for a tool); the item's own `status` is the protocol's. */
  readonly status?: string;
  readonly exitCode?: number;
  /** A longer text: an activity's or a notice's detail. */
  readonly more?: string;
  readonly mediaType?: string;
  /** The fields the writer normalized (NUL removed, a number left out); never because of a size. */
  readonly clipped?: readonly string[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What an item row has as columns; the rest of the item is its `item_json`. */
export type ItemColumnKeys = "id" | "seq" | "status" | "startedAt" | "endedAt" | "parentId";
/**
 * An item's `item_json`: its own type's fields (`type` stays, so the JSON says what it is) and the native facts it came from. Not its
 * text (`item_text`), and not what only a transfer says (`text`, `textBytes`, `bodyOmitted`).
 */
export type ItemFields = DistributiveOmit<ProtocolItem, ItemColumnKeys | "text" | "textBytes" | "bodyOmitted"> & { readonly native?: NativeFacts };

/** One row of `items`. */
export interface ItemRow {
  readonly runId: RunId;
  /** From 1, fixed when the item is first seen, never reused. */
  readonly seq: number;
  readonly itemId: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The id of the subagent item this one happened inside. */
  readonly parentId: string | null;
  /** The seq of the event of the commit that made the item; null for an item converted from a Run that kept no order. */
  readonly createdSeq: number | null;
  /** The bytes of its text so far, and how many chunks hold them (the next chunk's number). */
  readonly textBytes: number;
  readonly textChunks: number;
  readonly fields: ItemFields;
}
/** One row of `item_text`: a chunk of an item's text, appended once and never changed (a user message, an assistant segment, a reasoning segment). */
export interface TextChunkRow { readonly runId: RunId; readonly itemSeq: number; readonly chunk: number; readonly text: string; readonly bytes: number }
/** An item as a conversation holds it: its row and its text as the chunks that were committed (text = chunks joined; none for an item without text). */
export interface HeldItem extends ItemRow { readonly text: readonly string[] }

// ---------------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------------

/** What a Run keeps in `run_json`: the facts of the old `PublicRun` that are neither a column nor an item. */
export type RunFacts = Pick<PublicRun, "userMessageId" | "assistantMessageId" | "selection" | "contextThroughSeq" | "sourceRunIds" | "backend" | "cleanup" | "error"
  | "usage" | "attachments" | "timing" | "retained" | "reused" | "relay" | "relayRequest" | "awaitingSwitchId">;

/** One row of `runs`; one property per column of schema-v14.ts, and `facts` is `run_json`. */
export interface RunRow {
  readonly sessionId: SessionId;
  /** From 1 in the order the Runs were accepted; the Turn's number, the page key, never reused. */
  readonly ordinal: number;
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly status: RunStatus;
  readonly epoch: number;
  readonly harnessId: string;
  readonly controlId: string;
  readonly acceptedAt: number | null;
  readonly preparingAt: number | null;
  readonly readyAt: number | null;
  readonly reused: boolean;
  /** The seq of the event that accepted the input (the user message's place among the events). */
  readonly userSeq: number;
  /** The seq of the event that ended the Run (`run.ended`, or the `session.recovered` that ended it); null until it ended, and for a converted Run whose events do not place it. */
  readonly endedSeq: number | null;
  readonly dispatched: boolean;
  /** Where it ran: `facts.relay.executedOn` as columns, so that "the Runs a binding does not hold" is an index query. */
  readonly executedOn: ExecutedOn | null;
  /** The Run was a native command; `commandEffect` the effect it was read with, `settledEffect` the one its end settled (what the relay ledger read from `run.native_command` and `run.ended`). */
  readonly isCommand: boolean;
  readonly commandEffect: ContextEffect | null;
  readonly settledEffect: ContextEffect | null;
  readonly cancelRequested: boolean;
  readonly stopRequested: boolean;
  /** Its items are in the fixed order of a Turn that kept none (ProtocolTurn.legacyOrder). */
  readonly legacyOrder: boolean;
  readonly facts: RunFacts;
}

/**
 * A Run as the conversation holds it (stage 1, in memory): the old `PublicRun` without its display fields (the items are them, and `input`
 * is the text of the `user` item), with the facts the old model read out of the events, and its items.
 */
export interface ConversationRun extends Omit<PublicRun, "thinking" | "tools" | "plan" | "notices" | "activities" | "outputs" | "protocol" | "input"> {
  readonly ordinal: number;
  readonly userSeq: number;
  readonly endedSeq?: number;
  readonly isCommand: boolean;
  readonly commandEffect?: ContextEffect;
  readonly settledEffect?: ContextEffect;
  readonly legacyOrder?: true;
  readonly items: readonly HeldItem[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The head, the bindings, the commands, the switches
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where a conversation's quoted history comes from. A branch made from v14 on holds a reference (the Turns up to `throughOrdinal` are read
 * from the source); a branch converted from v13 holds the history it quoted (`quoted`, rows of `origin_history`), as it always has; an
 * import holds the native messages it read (rows of `origin_history`) and tells what it did not.
 */
export type StoredOrigin =
  | { readonly kind: "fork"; readonly sessionId: SessionId; readonly throughRunId: RunId; readonly throughOrdinal: number; readonly quoted: boolean }
  | { readonly kind: "import"; readonly harnessId: string; readonly title: string | null; readonly omitted: number; readonly complete: boolean; readonly historyRead: boolean };
/** The small objects of a conversation's head: `sessions.head`. */
export interface HeadJson {
  readonly configuration: SessionConfiguration;
  readonly selection: HarnessSelection;
  readonly retainNative?: true;
  readonly retained?: RetainedProcess;
  readonly relayRecoveryFailed?: number;
  readonly origin?: StoredOrigin;
}
/** One row of `sessions` of a converted conversation. */
export interface HeadRow {
  readonly id: SessionId;
  /** The optimistic-concurrency version; the store compares it and adds one with every commit. */
  readonly version: number;
  /** The seq of the last event; with `events` it is the conversation's cursor. */
  readonly lastSeq: number;
  readonly format: typeof CONVERSATION_FORMAT;
  readonly status: SessionSnapshot["status"];
  readonly epoch: number;
  readonly activeRunId: RunId | null;
  readonly pendingSwitchId: SwitchId | null;
  readonly title: string;
  readonly runCount: number;
  readonly updatedAt: number;
  /** Set when the conversation is deleted: it is then hidden and its rows kept while another conversation quotes it. */
  readonly deletedAt: number | null;
  /** Why a conversion of this conversation failed; its v13 snapshot is then still in `head`. */
  readonly lastError: string | null;
  readonly head: HeadJson;
}
export interface OriginHistoryRow { readonly sessionId: SessionId; readonly idx: number; readonly message: ForkedMessage }

/** One row of `bindings`; the columns are copies of what `binding` says, for the indexes and the monotonic checks. */
export interface BindingRow {
  readonly sessionId: SessionId;
  readonly ordinal: number;
  readonly harnessId: string;
  readonly controlId: string;
  readonly checkpoint: string;
  readonly status: NativeSessionBinding["status"];
  readonly opensNew: boolean;
  readonly throughRunId: RunId | null;
  readonly relayEpoch: number;
  readonly relayMark: number;
  readonly relayFloor: number;
  readonly binding: NativeSessionBinding;
}
export interface CommandRow { readonly sessionId: SessionId; readonly ordinal: number; readonly command: CommandRecord }
/**
 * One row of `switches`. `sourceThroughOrdinal` says "every Run up to this ordinal that is finished (or is the active one)" for the
 * switches whose sources are that; any other set stays in `switch.sourceRunIds`, so nothing is lost and nothing grows with the history.
 */
export interface SwitchRow { readonly sessionId: SessionId; readonly ordinal: number; readonly sourceThroughOrdinal: number | null; readonly switch: PublicSwitch }
/** One reference of a conversation to an object of the content store (`content_refs`): what the collector keeps and what a purge lets go. */
export interface ContentRefRow {
  readonly contentId: string;
  readonly sessionId: SessionId;
  readonly runId: RunId | null;
  readonly itemSeq: number | null;
  readonly role: "tool_detail" | "output" | "attachment" | "origin_attachment" | "superseded_detail";
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage 1: the conversation in memory, and what a commit writes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The object the Runtime reduces in stage 1, in place of the `SessionSnapshot` with its display fields: the same shape with the Runs'
 * items for their `thinking`, `tools`, `plan`, `notices`, `activities` and `outputs`, and without `messages` (a message is an item).
 * The whole conversation is held in memory (that ends in stage 2) but written as rows: a commit writes the rows that changed.
 */
export interface Conversation extends Omit<SessionSnapshot, "schemaVersion" | "runs" | "messages" | "origin"> {
  readonly format: typeof CONVERSATION_FORMAT;
  readonly runs: readonly ConversationRun[];
  readonly origin?: StoredOrigin;
}

export interface HeadWrite { readonly row: HeadRow }
export interface RunWrite { readonly op: "insert" | "update"; readonly row: RunRow }
export interface ItemWrite { readonly op: "insert" | "update"; readonly row: ItemRow }
export interface TextAppend { readonly runId: RunId; readonly itemSeq: number; readonly chunk: number; readonly text: string }
export interface BindingWrite { readonly op: "insert" | "update"; readonly row: BindingRow }
export interface SwitchWrite { readonly op: "insert" | "update"; readonly row: SwitchRow }
/**
 * What one commit writes: the rows that changed, and the events. FINAL in stage 1: in stage 1 the store makes it by comparing the
 * conversation before and after (by object identity, and by the chunks an item's text has gained); in stage 2 the reducers build it.
 * The Commit it comes back in is what the frames of the stream are made from.
 *
 * Applied in this order, in one transaction: head (the version's compare-and-swap), Run inserts, bindings (updates, then inserts: a
 * binding is archived before the one that replaces it), items, text, Run updates (a Run's terminal change comes after its last item),
 * commands, switches, content references, origin history, events, relay rows.
 */
export interface Mutation {
  readonly head?: HeadWrite;
  readonly runs?: readonly RunWrite[];
  readonly items?: readonly ItemWrite[];
  readonly text?: readonly TextAppend[];
  readonly bindings?: readonly BindingWrite[];
  readonly commands?: readonly CommandRow[];
  readonly switches?: readonly SwitchWrite[];
  readonly contentRefs?: readonly ContentRefRow[];
  readonly originHistory?: readonly OriginHistoryRow[];
  readonly events: readonly EventDraft[];
  readonly relay?: RelayRows;
}
/** What a transaction of stage 1 returns for the Runtime's reducer: the next conversation, its events, the relay rows to write with them. */
export interface ConversationMutation { readonly next: Conversation; readonly events: readonly EventDraft[]; readonly relay?: RelayRows }
/** A committed transaction: the conversation as it is now, its events, and the rows that were written. */
export interface ConversationCommit { readonly conversation: Conversation; readonly events: readonly SessionEvent[]; readonly changes: Mutation }

/** One conversation of a list: the columns of `sessions`, never the conversation. */
export interface SessionListRow {
  readonly id: SessionId;
  readonly title: string;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly updatedSeq: number;
  readonly updatedAt: number;
  readonly activeRunId: RunId | null;
  readonly runCount: number;
}
/** Opaque. A list reads on from it; there is no ceiling on how many conversations a list reaches. */
export type SessionListCursor = string & { readonly __sessionListCursor: true };
export interface SessionListQuery { readonly after?: SessionListCursor; readonly limit?: number }
export interface SessionListPage { readonly rows: readonly SessionListRow[]; readonly next: SessionListCursor | null }
/** One Turn's start of a Harness entry, for the usual startup time: a column read of the latest few, not a scan of every Run. */
export interface StartupSample { readonly harnessId: string; readonly controlId: string; readonly preparingAt: number; readonly readyAt: number }

/**
 * The store of stage 1: `SessionStore` over the new shapes. The same transaction contract (synchronous, compare-and-swap on `version`,
 * events in the same commit, published after), with the list and the readers the old store answered by reading every snapshot now
 * answering from columns and indexes. Implemented by line A (the tables) and wired at the cut (docs/proposals/protocol/step2-plan.md).
 */
export interface ConversationStore extends ConversationReader {
  readonly ownerGeneration: number;
  assertOwner(): void;
  create(conversation: Conversation, events: readonly EventDraft[]): ConversationCommit;
  /** The whole conversation (stage 1 only; stage 2 reads through `ConversationTx`). */
  get(id: SessionId): Conversation;
  findByCreateKey(key: CommandId): Conversation | null;
  list(query?: SessionListQuery): SessionListPage;
  /** The conversations whose head records a kept native process, whatever their age. */
  listKept(): readonly SessionId[];
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId>;
  /** Every content id any conversation references (`content_refs`), for the collector. */
  contentReferences(): ReadonlySet<string>;
  /** The latest `perEntry` startups of every Harness entry. */
  startupSamples(perEntry: number): readonly StartupSample[];
  transact(id: SessionId, expectedVersion: number, mutate: (current: Conversation) => ConversationMutation): ConversationCommit;
  events(id: SessionId, afterSeq: number, limit?: number): readonly SessionEvent[];
  close(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading in pages
// ---------------------------------------------------------------------------------------------------------------------

/** Opaque (base64url of `CursorPayload`). Page keys are Run ordinals, which never change, so a Turn arriving does not move a page. */
export type TurnCursor = string & { readonly __turnCursor: true };
export interface CursorPayload { readonly ordinal: number; readonly lastSeq: number }
/** The stretch of a Turn's completed actions a window leaves out; `GET …/runs/:ordinal/items?after=` reads it. */
export interface DeferredWork { readonly fromSeq: number; readonly toSeq: number; readonly count: number }
/** One Turn of a window: its Run row and its items, with their text. */
export interface TurnItems { readonly run: RunRow; readonly items: readonly HeldItem[]; readonly deferred?: DeferredWork }
/** The newest Turns up to a size, or the page of Turns before a cursor. `older` is null when the first Turn is in it. */
export interface TurnWindow { readonly turns: readonly TurnItems[]; readonly older: TurnCursor | null; readonly bytes: number; readonly lastSeq: number }
export interface ItemPage { readonly items: readonly HeldItem[]; /** The `after` of the next page; null when this is the last. */ readonly next: number | null }
/** A byte range of an item's text: `from` and `to` are byte offsets (UTF-8 boundaries), `total` its size. */
export interface TextRange { readonly text: string; readonly from: number; readonly to: number; readonly total: number }
export interface SearchHit { readonly sessionId: SessionId; readonly runId: RunId; readonly ordinal: number; readonly itemSeq: number; readonly type: ItemType }

/**
 * Every read the wire, the readers and the tools make of a conversation, by index and by page (line A implements it on the tables; lines
 * C and D call it). None of it reads a whole conversation.
 */
export interface ConversationReader {
  head(id: SessionId): HeadRow;
  /** The newest Turns up to `PAGE.windowTurns` and `PAGE.windowBytes` (at least one). */
  window(id: SessionId, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow;
  /** The page of Turns before `before`. */
  older(id: SessionId, before: TurnCursor, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow;
  turnAt(id: SessionId, ordinal: number): TurnItems | null;
  items(runId: RunId, afterSeq: number, limit: number): ItemPage;
  text(runId: RunId, itemSeq: number, range?: { readonly from: number; readonly to?: number }): TextRange;
  /** Full-text search over finished messages and segments (terms of three characters or more; a shorter one is scanned). */
  search(query: string, scope: { readonly sessionId?: SessionId; readonly after?: number; readonly limit: number }): readonly SearchHit[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage 2: the port that holds only the head and the Turn in progress (line E)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Declared now so that stage 1's `Mutation` is final; implemented in stage 2. Indexed queries only: there is no way to ask for the whole
 * history, so a reducer cannot depend on it.
 */
export interface ConversationTx {
  head(): HeadRow;
  run(id: RunId): RunRow | null;
  runAt(ordinal: number): RunRow | null;
  active(): RunRow | null;
  queued(limit: number): readonly RunRow[];
  /** The Runs that are not finished (the partial index). */
  openRuns(): readonly RunRow[];
  before(ordinal: number, limit: number): readonly RunRow[];
  /** The finished, dispatched Runs that did not run on this binding's native session in its current epoch, oldest first from `afterEndedSeq`. */
  owed(binding: ExecutedOn, afterEndedSeq: number, limit: number): readonly RunRow[];
  /** The last Run dispatched to a Harness control: what `carriedNativeConfiguration` and the relay's mark read. */
  lastDispatched(harnessId: string, controlId: string): RunRow | null;
  items(runId: RunId, afterSeq: number, limit: number): readonly ItemRow[];
  item(runId: RunId, itemId: string): ItemRow | null;
  text(runId: RunId, itemSeq: number, range?: { readonly from: number; readonly to?: number }): TextRange;
  command(id: CommandId): CommandRow | null;
  switchOf(id: SwitchId): SwitchRow | null;
  bindings(): readonly BindingRow[];
}
export interface ConversationTxStore {
  transact(id: SessionId, expectedVersion: number, mutate: (tx: ConversationTx) => Mutation): ConversationCommit;
}
