import type { ContextEffect } from "./control.js";
import type { ItemStatus, ItemType, ProtocolItem } from "./protocol.js";
import type { DeliveryRecord, ExecutedOn, RelayPacket, RelayRecoveredDelivery, RelayRows } from "./relay.js";
import type {
  CommandId, CommandRecord, EventDraft, ForkedMessage, HarnessSelection, PublicMessage, NativeSessionBinding, PublicRun, PublicSwitch, RetainedProcess, RunId,
  RunStatus, SessionConfiguration, SessionEvent, SessionId, SessionSnapshot, SwitchId,
} from "./session.js";

/*
 * A conversation kept as tables (ADR-057, store v14): the shapes between the lines of work. Types and constants only; nothing here is read by
 * a running path until the cut (docs/proposals/protocol/step2-plan.md). Two rules run through all of it.
 *
 *   NOTHING THE SOURCE SAID IS LOST. An item keeps what the Harness reported of it (`NativeFacts`: title, kind, name, status word, the
 *   whole of an activity, a notice, a plan step), and its normalized type, command and path are values worked out from that and can be
 *   worked out again. `toItems` and `fromItems` are inverses: the old shape of a Run is what the rows give back, to the byte.
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
  /** How many items at each end of such a stretch stay in the window (the placeholder stands for the rest). */
  deferredKeep: 25,
  /** The conversations of one list page. */
  sessions: 100,
  /** An item whose text or body is longer than this is sent with `bodyOmitted` and `textBytes`; its text is fetched by byte range. */
  itemInlineBytes: 64 * 1024,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------------------------------

/**
 * An item's id, unique within its Run (`items(run_id, item_id)`): a tool call by the id its Harness gave it, an activity or a permission
 * by its own, the segments of text and reasoning, the notices and the outputs by their count in the Run from 1. The same id reported
 * again is the same item (an upsert; nothing changed, nothing committed). `seq`, the item's place in the Turn, is fixed when the item is
 * first seen. The Turn's `switch`, `error`, `interrupt` and `clear` lines are not items: they are read from the Run's own facts and the
 * relay's rows when a Turn is drawn (their state changes after the Turn, and a copy would go stale).
 */
export type ItemId =
  | "user" | "plan"
  | `tool:${string}` | `activity:${string}` | `permission:${string}`
  | `text:${number}` | `think:${number}` | `notice:${number}` | `output:${number}`;

/**
 * What the Harness reported of a call, an activity or a notice, verbatim, kept beside the item the Hub made of it. The readers that put a
 * call in its own words (the relay's brief, the context table) read these through `fromItems`, which gives back the old flat shapes
 * (`PublicTool`, `PublicNotice`, `PublicActivity`, `PublicOutput`): an item loses nothing its source carried.
 */
export interface NativeFacts {
  /** A tool's title; a notice's or activity's title (a notice of severity error keeps its title and detail apart here). */
  readonly title?: string;
  /** A tool's kind word, or an activity's kind. */
  readonly kind?: string;
  readonly name?: string;
  /** The status word as reported (a free string for a tool; the activity's own for an activity); the item's `status` is the protocol's. */
  readonly status?: string;
  readonly exitCode?: number;
  /** A longer text: an activity's or a notice's detail. */
  readonly more?: string;
  readonly mediaType?: string;
  /**
   * What the writer normalized, as `field:why`: `nul` (a NUL removed), `surrogate` (half a surrogate pair replaced by U+FFFD), `empty` (an empty label given
   * its placeholder), `range` (a number that is not a safe integer left out), `unknown_word` (a status word the protocol does not know, read as `unknown`).
   * Never because of a size or of what a text says. Added by the placement of items (ADR-057 1.5).
   */
  readonly clipped?: readonly string[];
  /**
   * The id the Harness gave a call or an activity, kept only when the item's id is not simply `tool:` or `activity:` followed by it: a second
   * call or activity of one Run with the id of an earlier one (the Runtime never made two, but what it validated does not forbid them), whose
   * item then takes the next free id (`tool:abc#2`); or an id with half of a surrogate pair in it, which a TEXT column stores as U+FFFD, so that
   * the item's id is the id as the column holds it. Added by the storage conversion (ADR-057 3.6).
   */
  readonly id?: string;
  /**
   * The id of the call this call happened inside (`parentId` of the call), as the Harness gave it, kept only when it has half of a surrogate pair in it:
   * the item's `parentId` column then holds it as a TEXT column does (U+FFFD for the half). Added by the storage conversion (ADR-057 3.6).
   */
  readonly parent?: string;
  /**
   * The lone surrogates of the item's text (a UTF-16 index of the joined text, and the code unit that stood there): a UTF-8 column cannot hold a
   * half of a pair and SQLite stores it as U+FFFD, so the chunks carry U+FFFD in its place and this says what to put back. Kept by the storage
   * conversion for text that was already there (a reply cut in the middle of a pair is such text); distinct from `clipped`, which is what a
   * writer changed for good. Added by the storage conversion (ADR-057 3.6).
   */
  readonly surrogates?: readonly (readonly [number, number])[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What an item row has as columns; the rest of the item is its `item_json`. */
export type ItemColumnKeys = "id" | "seq" | "status" | "startedAt" | "endedAt" | "parentId";
/**
 * An item's `item_json`: its own type's fields (`type` stays, so the JSON says what it is) and the native facts it came from. Not its
 * text (`item_text`), and not what only a transfer says (`text`, `textBytes`, `bodyOmitted`). `phase` is stored only when the Harness
 * said it; otherwise it is worked out when the Turn is read (only a completed Turn has a `final`, and it is the last assistant segment
 * with the notices, plan, artifacts and context events set aside).
 */
export type ItemFields = DistributiveOmit<ProtocolItem, ItemColumnKeys | "text" | "textBytes" | "bodyOmitted" | "phase"> & { readonly phase?: "commentary" | "final"; readonly native?: NativeFacts };

/** One row of `items`. */
export interface ItemRow {
  readonly runId: RunId;
  /** From 1, fixed when the item is first seen, never reused. (0 is the place of the Turn's `switch` line, which is not stored.) */
  readonly seq: number;
  readonly itemId: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The id of the subagent item this one happened inside. */
  readonly parentId: string | null;
  /**
   * The seq of the event of the commit that made the item (written by the store: see `ItemWrite.createdByEvent`). A converted message has
   * its message's seq; any other converted item has none, because nothing says when it happened.
   */
  readonly createdSeq: number | null;
  /** The bytes of its text so far, and how many chunks hold them (the next chunk's number). Kept by the store; a writer leaves them out. */
  readonly textBytes: number;
  readonly textChunks: number;
  readonly fields: ItemFields;
}
/**
 * One row of `item_text`: a chunk of an item's text, appended once and never changed (a user message, an assistant segment, a reasoning
 * segment). A chunk ends on a code point (a high surrogate left at the end of a window goes to the start of the next), and starts at
 * `byteOffset`, so that a byte range is read without adding up what comes before it.
 */
export interface TextChunkRow { readonly runId: RunId; readonly itemSeq: number; readonly chunk: number; readonly byteOffset: number; readonly text: string; readonly bytes: number }
/**
 * An item as a conversation holds it: its row and its text as the chunks that were committed (text = chunks joined; none for an item without text).
 * A page read (`ConversationReader`) leaves out a body longer than the page carries instead of loading it: `textOmitted` says the text is not in `text`
 * (its size is `textBytes`; `ConversationReader.text` reads it by byte range), and `bodyOmitted` says the item's own JSON was longer than that, so `fields`
 * holds only its `type` and the type's required fields emptied, and the item is read whole with `ConversationReader.items(…, { inlineBytes: Infinity })`.
 */
export interface HeldItem extends ItemRow { readonly text: readonly string[]; readonly textOmitted?: true; readonly bodyOmitted?: true }

// ---------------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------------

/** What a Run keeps in `run_json`: the facts of the old `PublicRun` that are neither a column nor an item. `usage` is the native value as it was reported. */
export type RunFacts = Pick<PublicRun, "userMessageId" | "assistantMessageId" | "selection" | "contextThroughSeq" | "sourceRunIds" | "backend" | "cleanup" | "error"
  | "usage" | "attachments" | "timing" | "retained" | "reused" | "relay" | "relayRequest" | "awaitingSwitchId"> & {
  /**
   * The lists the old Run held and that were empty (`tools: []` is not a Run without `tools`: the old validation allowed both): items cannot say it.
   * Absent for a Run none of whose lists were empty. Added by the storage conversion (ADR-057 3.6).
   */
  readonly emptyLists?: readonly ("tools" | "notices" | "activities" | "outputs")[];
};

/** One row of `runs`; one property per column of schema-v14.ts, and `facts` is `run_json`. */
export interface RunRow {
  readonly sessionId: SessionId;
  /** From 0 in the order the Runs were accepted: the index the Run had in the old `runs` array, the page key, never reused. The Turn's number is `ordinal + 1`. */
  readonly ordinal: number;
  readonly runId: RunId;
  readonly commandId: CommandId;
  readonly status: RunStatus;
  readonly epoch: number;
  readonly harnessId: string;
  readonly controlId: string;
  /** The Run ran on a managed Provider (`facts.selection.provider`), not on a native session of its Harness. */
  readonly managed: boolean;
  readonly acceptedAt: number | null;
  readonly preparingAt: number | null;
  readonly readyAt: number | null;
  readonly reused: boolean;
  /** The seq of the event that accepted the input (the user message's place among the events). */
  readonly userSeq: number;
  /**
   * The seq of the event that ended the Run (`run.ended`, or the `session.recovered` that ended it, the first time); null until it ended
   * and for a converted Run whose events do not place it. A reader takes null as ABOVE the relay's mark, never as 0 and never as absent:
   * the relay may send such a Run again, and never loses it.
   */
  readonly endedSeq: number | null;
  readonly dispatched: boolean;
  /** Where it ran: `facts.relay.executedOn` as columns, so that "the Runs a binding does not hold" is an index query. */
  readonly executedOn: ExecutedOn | null;
  /**
   * The Run was a native command (`isCommand`: not the same as having an effect), `commandEffect` the effect it was read with and
   * `settledEffect` the one its end settled. A command whose effect cannot be read is `isCommand` with null effects: it is no fact for
   * the relay, and no ordinary Run either.
   */
  readonly isCommand: boolean;
  readonly commandEffect: ContextEffect | null;
  readonly settledEffect: ContextEffect | null;
  /** For an `unknown` Run: the switch that acknowledged keeping it as it is (what let an open conversation have it); null until then. */
  readonly acknowledgedBy: SwitchId | null;
  readonly cancelRequested: boolean;
  readonly stopRequested: boolean;
  /** Its items are in the fixed order of a Turn that kept none (ProtocolTurn.legacyOrder). */
  readonly legacyOrder: boolean;
  readonly facts: RunFacts;
}

/**
 * A Run as the conversation holds it in memory (stage 1): the old `PublicRun` without its display fields (the items are them, and `input`
 * is the text of the `user` item), with the facts the old model read out of the events. `items` are held only while the Run is not
 * finished (the Turn in progress, a queued input); a finished Run's items and text stay in the tables and are read by Turn when a reader
 * needs them (`ConversationReader.turnAt`).
 */
export interface ConversationRun extends Omit<PublicRun, "thinking" | "tools" | "plan" | "notices" | "activities" | "outputs" | "protocol" | "input"> {
  readonly ordinal: number;
  readonly userSeq: number;
  readonly endedSeq?: number;
  readonly isCommand: boolean;
  readonly commandEffect?: ContextEffect;
  readonly settledEffect?: ContextEffect;
  readonly acknowledgedBy?: SwitchId;
  readonly legacyOrder?: true;
  /**
   * Where a Run made before v13 ran: its row's `executed_*` columns, which the migration filled from the relay's index because the Run has no `relay` of its
   * own. Present only for such a Run (a Run with a `relay` says where it ran in `relay.executedOn`); it is here so that the row a Run is written back as is the row
   * it was read from (a terminal Run whose acknowledgement is written must not lose a column), and so that the relay's facts need no index.
   */
  readonly executedOn?: ExecutedOn;
  /** The lists the old Run held and that were empty (`RunFacts.emptyLists`), kept so that the Run's `run_json` is written back as it was read. */
  readonly emptyLists?: RunFacts["emptyLists"];
  readonly items?: readonly HeldItem[];
}

/** What a Run and its messages become, and what they are made of again (the same pair for every Run, the old and the new alike). */
export interface ConvertedRun { readonly row: RunRow; readonly items: readonly HeldItem[]; readonly contentRefs: readonly ContentRefRow[] }
/**
 * The storage conversion of ADR-057 3.6: not the display projection (which cuts, drops and rewrites for the screen), but a lossless
 * pair. `toItems` is total, deterministic and pure (it reads no clock and no store); `fromItems(toItems(run, messages, at))` deep-equals
 * `{ run, messages }`; both go Run by Run. `fromItems` is also what gives the readers that have not moved to items their old shapes.
 */
export interface StorageConversion {
  toItems(run: PublicRun, messages: { readonly user: PublicMessage; readonly assistant?: PublicMessage }, at: { readonly sessionId: SessionId; readonly ordinal: number; readonly endedSeq?: number;
    readonly isCommand?: boolean; readonly commandEffect?: ContextEffect; readonly settledEffect?: ContextEffect; readonly acknowledgedBy?: SwitchId }): ConvertedRun;
  fromItems(converted: ConvertedRun): { readonly run: PublicRun; readonly messages: readonly PublicMessage[] };
}
/** One thing `verify` found wrong: the rule (a name from the invariant table of ADR-057 3.3), where, and what. */
export interface Violation { readonly rule: string; readonly where: string; readonly detail: string }
/**
 * The whole-conversation check: the relations the old `parseSession` checked, now over the rows with maps instead of searches. It runs
 * after every commit in the tests, after each converted conversation in the migration, and in a maintenance command; never in the
 * production commit path.
 */
export type VerifyConversation = (conversation: Conversation, reader: ConversationReader) => readonly Violation[];
/**
 * What `VerifyConversation` cannot see in one state: the conversation and the one a commit made of it, with the events the commit wrote
 * (`assertSessionTransition` over the rows: who may change a binding, that a relay state only goes forward, that what a dispatched Run was
 * given stays, that a finished Run is not rewritten). Added by T8; the tests run it after every commit.
 */
export type VerifyTransition = (before: Conversation, after: Conversation, events?: readonly EventDraft[]) => readonly Violation[];

// ---------------------------------------------------------------------------------------------------------------------
// The head, the bindings, the commands, the switches
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Where a conversation's quoted history comes from. A branch made from v14 on holds a reference (the Turns up to `throughOrdinal` are read
 * from the source); a branch converted from v13 holds the history it quoted (`quoted`, rows of `origin_history` marked `fork`), as it
 * always has; an import holds the native messages it read (rows marked `import`) and tells what it did not.
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
  /** The head records a kept native process (`head.retained`): the index that finds the processes an ended owner left. */
  readonly kept: boolean;
  readonly title: string;
  readonly runCount: number;
  readonly updatedAt: number;
  /** Set when the conversation is deleted: it is then hidden and its live native bindings archived, and its rows are kept while another conversation quotes it. */
  readonly deletedAt: number | null;
  /** Why a conversion of this conversation stopped the start; its v13 snapshot is then still in `head`. */
  readonly lastError: string | null;
  readonly head: HeadJson;
}
export interface OriginHistoryRow { readonly sessionId: SessionId; readonly idx: number; readonly kind: "fork" | "import"; readonly message: ForkedMessage }

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
 * One row of `switches`. `sourceThroughOrdinal` says "every Run up to this ordinal that is finished (or is the active one)" when that is
 * what the switch's sources are, and is for showing only: it is not a claim on anything. Any other set stays in `switch.sourceRunIds`
 * (a Run that queued while the switch was asked for is skipped), and whether an `unknown` Run was acknowledged is `RunRow.acknowledgedBy`.
 */
export interface SwitchRow { readonly sessionId: SessionId; readonly ordinal: number; readonly sourceThroughOrdinal: number | null; readonly switch: PublicSwitch }
/**
 * One reference of a conversation to an object of the content store (`content_refs`): what the collector keeps and what a purge lets go.
 * A reference without a Run is the conversation's (the attachments of a quoted history). The collector's set is these and the references
 * of every conversation not yet converted, and it collects nothing while a conversation is not converted.
 */
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
 * The object the Runtime reduces in stage 1, in place of the `SessionSnapshot` with its display fields: the head, every Run as a light
 * row (the old `PublicRun` without its display fields), and the items of the Runs not finished. No `messages` (a message is an item) and
 * no finished Run's items or text, which are read by Turn. Memory grows by a small row per Turn, not by what the Turns held; a commit
 * writes the rows that changed (the store finds them by comparing object identity, and only an unfinished Run's items can have changed).
 */
export interface Conversation extends Omit<SessionSnapshot, "schemaVersion" | "runs" | "messages" | "origin"> {
  readonly format: typeof CONVERSATION_FORMAT;
  readonly runs: readonly ConversationRun[];
  readonly origin?: StoredOrigin;
}

/** The head after the commit; the store compares `version` and adds one. A new conversation's head is inserted first, by `create`, because the rows below it refer to it. */
export interface HeadWrite { readonly row: HeadRow }
/** `userSeqByEvent` and `endedByEvent` name an entry of the Mutation's `events`: the store writes the seq that event gets. */
export interface RunWrite { readonly op: "insert" | "update"; readonly row: RunRow; readonly userSeqByEvent?: number; readonly endedByEvent?: number }
/** `createdByEvent` names an entry of the Mutation's `events`. A writer leaves `textBytes` and `textChunks` at 0: the store counts the chunks it appends. */
export interface ItemWrite { readonly op: "insert" | "update"; readonly row: ItemRow; readonly createdByEvent?: number }
/**
 * One chunk of an item's text, appended at the end. `byteOffset` is where the chunk starts in the item's text: a writer that knows it (the Runtime does,
 * for the Turn in progress) gives it and the store checks it; the store always writes it, and the Mutation it returns has it, which is what a stream's
 * frame carries as `from`.
 */
export interface TextAppend { readonly runId: RunId; readonly itemSeq: number; readonly chunk: number; readonly text: string; readonly byteOffset?: number }
export interface BindingWrite { readonly op: "insert" | "update"; readonly row: BindingRow }
export interface SwitchWrite { readonly op: "insert" | "update"; readonly row: SwitchRow }
/**
 * What one commit writes: the rows that changed, and the events. FINAL in stage 1: in stage 1 the store makes it by comparing the
 * conversation before and after; in stage 2 the reducers build it. The Commit it comes back in is what the stream's frame is made from.
 *
 * Applied in this order, in one transaction: commands (a Run's and a switch's command comes before it), Run inserts, items, text, Run
 * updates (a Run's terminal change comes after its last item), bindings (updates, then inserts: a binding is archived before the one that
 * replaces it, and points at a Run already finished), switches (updates, then inserts), content references, origin history, notice
 * prints, events, relay rows, and the head last (so that its checks see the commit's rows and a failed one rolls the rest back).
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
  /** The fingerprints of the Harness notices shown in this conversation (a notice already shown is not shown again). */
  readonly noticePrints?: readonly string[];
  readonly events: readonly EventDraft[];
  readonly relay?: RelayRows;
}
/**
 * What a transaction of stage 1 returns for the Runtime's reducer: the next conversation, its events, the relay rows to write with them, and the three
 * things a commit writes that the conversation does not carry (the store passes them to the comparison that makes the Mutation): the quoted messages a new
 * conversation starts from, the fingerprints of the Harness notices shown for the first time, and which event made an item when the default is not right
 * (the default: the `user` item is its Run's `message.accepted`, any other item the one event of a commit that has exactly one).
 */
export interface ConversationMutation {
  readonly next: Conversation; readonly events: readonly EventDraft[]; readonly relay?: RelayRows;
  readonly originHistory?: readonly OriginHistoryRow[];
  readonly noticePrints?: readonly string[];
  readonly createdBy?: (run: ConversationRun, item: HeldItem) => number | undefined;
}
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
 * The domain's recovery of one conversation that has unfinished work, as the store calls it when it starts (for the conversations of `unfinished()`, in the
 * transaction that claims the owner generation); null when nothing changes. Given to the store, not imported by it: the store knows no rule of the domain.
 */
export type RecoverConversation = (current: Conversation) => ConversationMutation | null;
/** What the relay's part of recovery changes: the conversation with its bindings' relay states recovered, and the deliveries to decide. */
export interface ConversationRelayRecovery { readonly next: Conversation; readonly deliveries: readonly RelayRecoveredDelivery[] }
/** The relay's part of that recovery: given a conversation as `RecoverConversation` left it and its delivery rows, the conversation with its bindings' relay state recovered and the deliveries to decide; null when nothing changes. Pure and synchronous; called for each conversation the recovery changes, in a savepoint of its own (`packets` are the conversation's packet manifests: the range of a packet that was in flight comes from its manifest). */
export type RecoverConversationRelay = (current: Conversation, deliveries: readonly DeliveryRecord[], packets?: readonly RelayPacket[]) => ConversationRelayRecovery | null;
/**
 * What the store of stage 1 is opened with. Opening a data root converts what is not converted yet (ADR-057 3.6: backup first, conversation by conversation,
 * each checked; a conversation that does not pass stops the start and nothing runs on a store half trusted), then recovers. `verify` is the whole-conversation
 * checker the conversion is held to.
 */
export interface ConversationStoreOptions {
  readonly now?: () => Date;
  readonly recover?: RecoverConversation;
  readonly recoverRelay?: RecoverConversationRelay;
  readonly verify?: VerifyConversation;
}

/**
 * The store of stage 1: `SessionStore` over the new shapes. The same transaction contract (synchronous, compare-and-swap on `version`,
 * events in the same commit, published after, one frame per commit), with the list and the readers the old store answered by reading
 * every snapshot now answering from columns and indexes. Implemented by the tables' line and wired at the cut.
 */
export interface ConversationStore extends ConversationReader {
  readonly ownerGeneration: number;
  assertOwner(): void;
  /**
   * A new conversation (version 0, cursor 0) and its first events. `originHistory` is the history a branch or an import starts from, which the conversation holds only a summary of
   * (`origin`): written with it, its attachments kept for it. A create command seen before returns the conversation it made, with no events.
   */
  create(conversation: Conversation, events: readonly EventDraft[], originHistory?: readonly OriginHistoryRow[]): ConversationCommit;
  /** The conversation as the Runtime reduces it (stage 1 only; stage 2 reads through `ConversationTx`). */
  get(id: SessionId): Conversation;
  findByCreateKey(key: CommandId): Conversation | null;
  list(query?: SessionListQuery): SessionListPage;
  /** The conversations whose head records a kept native process, whatever their age (`sessions.kept`). */
  listKept(): readonly SessionId[];
  /** The conversations with a Run not finished or a switch pending: what recovery visits (the partial indexes). */
  unfinished(): readonly SessionId[];
  /**
   * Whether a Harness notice with this fingerprint was already shown in the conversation (`notice_prints`): what the placement of items asks (`PlaceEnv.noticeShown`)
   * so that a notice a restarted Harness repeats is not shown again, without the Turns that are not held in memory. Optional so that a store without it still fits.
   */
  noticeShown?(id: SessionId, print: string): boolean;
  nativeOwners(harnessId: string, controlId: string): ReadonlyMap<string, SessionId>;
  /** Every content id any conversation references (`content_refs`, and the references of the conversations not yet converted), for the collector. */
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
/** What a read does with a body longer than a page carries: `inlineBytes` is the length above which a text or an item's JSON is left out (see `HeldItem`). */
export interface ReadOptions { readonly inlineBytes?: number }
/** The newest Turns up to a size, or the page of Turns before a cursor. `older` is null when the first Turn is in it. */
export interface TurnWindow { readonly turns: readonly TurnItems[]; readonly older: TurnCursor | null; readonly bytes: number; readonly lastSeq: number }
export interface ItemPage { readonly items: readonly HeldItem[]; /** The `after` of the next page; null when this is the last. */ readonly next: number | null }
/** A byte range of an item's text: `from` and `to` are byte offsets (on code point boundaries), `total` its size. */
export interface TextRange { readonly text: string; readonly from: number; readonly to: number; readonly total: number }
/**
 * A message or segment that holds the words. `id` is the item's stable number and the cursor of a search: the next page is `search(query, { after: id })`
 * with the `id` of the last hit, newest first. `via` says how it was found: `trigram` and `chars` are the indexes; `scan` is the fallback (a query of
 * one or two Latin characters, or an index not complete yet), which reads the joined text of every finished segment and folds only ASCII case.
 */
export interface SearchHit {
  readonly id: number; readonly sessionId: SessionId; readonly runId: RunId; readonly ordinal: number; readonly itemSeq: number; readonly type: ItemType;
  readonly via: "trigram" | "chars" | "scan";
}

/**
 * Every read the wire, the readers and the tools make of a conversation, by index and by page (the tables' line implements it; the
 * stream's and the readers' lines call it). None of it reads a whole conversation.
 */
export interface ConversationReader {
  head(id: SessionId): HeadRow;
  /** The newest Turns up to `PAGE.windowTurns` and `PAGE.windowBytes` (at least one). */
  window(id: SessionId, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow;
  /** The page of Turns before `before`. */
  older(id: SessionId, before: TurnCursor, options?: { readonly turns?: number; readonly bytes?: number }): TurnWindow;
  /** One Turn, all its items. A body longer than `options.inlineBytes` (default `PAGE.itemInlineBytes`) is left out, as in a window; `Infinity` reads everything. */
  turnAt(id: SessionId, ordinal: number, options?: ReadOptions): TurnItems | null;
  /** The items of a Turn after `afterSeq` in place order, `limit` at most, bodies left out as in `turnAt`. */
  items(runId: RunId, afterSeq: number, limit: number, options?: ReadOptions): ItemPage;
  /**
   * A byte range of an item's text (all of it when no range is given). A code point belongs to the range its first byte is in, so a `from` or a `to`
   * that falls inside one moves on to the next code point and a range never cuts a character: ranges that follow one another (the `to` of one as the
   * `from` of the next) give the text with no gap and no repeat. `from` and `to` of the answer are the offsets used.
   */
  text(runId: RunId, itemSeq: number, range?: { readonly from: number; readonly to?: number }): TextRange;
  /**
   * Full-text search over finished messages and segments, newest first, `limit` at most (no ceiling on `limit` or on how far a search can be continued):
   * a term of three characters or more is the trigram index's; one or two Chinese characters are the per-character index's; one or two Latin characters
   * (and any term while the index it needs is not complete) scan the joined text of the segments, which each hit's `via` tells. `after` is the `id` of the
   * last hit of the page before: the next page starts below it, and what is written meanwhile moves no page.
   */
  search(query: string, scope: { readonly sessionId?: SessionId; readonly after?: number; readonly limit: number }): readonly SearchHit[];
  /**
   * The content ids the conversation is registered to reference (`content_refs`, every role): what the content collector keeps its content by. `verify` holds what the rows
   * themselves mention (an item's detail and content, a Run's attachments, the history a branch quoted) to this set. Optional: a reader that cannot say is not asked.
   */
  references?(id: SessionId): ReadonlySet<string>;
  /** The history a branch or an import quoted, as its rows (`origin_history`), in order; none for a conversation that quotes nothing, or quotes its source by reference. Optional. */
  originHistory?(id: SessionId): readonly OriginHistoryRow[];
  /** The ordinal of a Run of the conversation by its identity (`runs.run_id`, unique); null when the conversation has none. Optional: a reader that cannot say is not asked. */
  runOrdinal?(id: SessionId, runId: RunId): number | null;
  /** The Harnesses the conversation has run on (the distinct `runs.harness_id`), sorted: whose secrets a reader of its history must hide. Optional. */
  harnessIds?(id: SessionId): readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Stage 2: the port that holds only the head and the Turn in progress
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
  /** The finished, dispatched Runs that did not run on this binding's native session in its current epoch, oldest first from `afterEndedSeq` (a null `endedSeq` counts as above it). */
  owed(binding: ExecutedOn, afterEndedSeq: number, limit: number): readonly RunRow[];
  /** The last Run dispatched to a Harness control: what `carriedNativeConfiguration` and the relay's mark read. */
  lastDispatched(harnessId: string, controlId: string): RunRow | null;
  items(runId: RunId, afterSeq: number, limit: number): readonly ItemRow[];
  item(runId: RunId, itemId: string): ItemRow | null;
  text(runId: RunId, itemSeq: number, range?: { readonly from: number; readonly to?: number }): TextRange;
  /** Whether a Harness notice with this fingerprint was already shown in this conversation. */
  noticeShown(print: string): boolean;
  command(id: CommandId): CommandRow | null;
  switchOf(id: SwitchId): SwitchRow | null;
  bindings(): readonly BindingRow[];
}
export interface ConversationTxStore {
  transact(id: SessionId, expectedVersion: number, mutate: (tx: ConversationTx) => Mutation): ConversationCommit;
}
