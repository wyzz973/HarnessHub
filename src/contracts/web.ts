import type { ProviderView } from "./provider.js";
import type { DeferredWork, TextRange } from "./conversation.js";
import type { ProtocolItem, ProtocolTurn } from "./protocol.js";
import type { HarnessManagementView, InstallationJobView, InstallationLog } from "./management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunId, SelectionRequest, SessionEvent, SessionOrigin, SessionSnapshot } from "./session.js";
import type { DeliveryEvidence, DeliveryStatus, EvidenceClass, RelayAttention, RelayDecision, RelayInstallationNotice, RelayPacketId, RelayPacketKind, RelayPrefKey, RunRelay, Tier } from "./relay.js";

/**
 * A conversation's title as summaries and the sidebar give it, the same in the Gateway and the page: its first message,
 * else where it came from ("接续 · …" for a continued native session, "分支 · …" for a branch), else "新对话"; spaces
 * folded, at most 80 characters. The page names a conversation it opens itself this way, with no state read to correct it.
 */
export function conversationTitle(conversation: { readonly messages: readonly { readonly role: string; readonly text: string }[]; readonly origin?: SessionOrigin | undefined }): string {
  const first = conversation.messages.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  const origin = conversation.origin, quoted = origin?.history.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  const inherited = origin?.kind === "import" ? "接续 · " + (origin.title ?? quoted ?? origin.harnessId) : quoted ? "分支 · " + quoted : null;
  return first ? cutTitle(first) : inherited ? cutTitle(inherited) : "新对话";
}
/**
 * At most 80 UTF-16 units, never ending in half a character, and with no half character anywhere: a title is stored in a UTF-8 column that keeps U+FFFD in place of half a pair,
 * so a title that held one would not read back as it was written.
 */
function cutTitle(text: string): string {
  let head = text.slice(0, 80);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/**
 * Where a control entry was found: on PATH or in a standard directory like comparable products search, as an explicit
 * custom entry from the discovery manifest, in an explicit package root, or as a HarnessHub-managed installation.
 */
export type HarnessEntrySource = "path" | "standard-directory" | "custom-entry" | "package-root" | "managed";
/**
 * How far HarnessHub carries a Harness (ADR-048, ADR-050): `focus` for the seven it supports in full, `frozen` for the three
 * whose adapters, tests and history stay but which get no new work (the page hides them unless the user shows them), and
 * `catalog` for every other catalog entry. `harnessTier` in the catalog assigns it.
 */
export const HARNESS_TIERS = ["focus", "frozen", "catalog"] as const;
export type HarnessTier = typeof HARNESS_TIERS[number];
/** Browser-safe observations. Available means resolved control, not task acceptance. */
/** What upgrading a Harness would touch, for the user's confirmation (ADR-043); conversations carry their titles. */
export type MaintenanceView = Omit<import("./management.js").MaintenanceCheck, "conversations"> & {
  readonly conversations: readonly { readonly sessionId: string; readonly title: string; readonly busy: boolean }[];
};
/** What installing a missing product the official way would run and change, for the user's confirmation (ADR-044). */
export type InstallCheckView = import("./management.js").InstallCheck;
/** What upgrading one installation through its channel would run and change, for the user's confirmation (ADR-044); conversations carry their titles. */
export type InstallationUpgradeCheckView = Omit<import("./management.js").InstallationUpgradeCheck, "conversations"> & {
  readonly conversations: readonly { readonly sessionId: string; readonly title: string; readonly busy: boolean }[];
};
/** What uninstalling one installation would remove, stop and leave, for the user's confirmation (ADR-044); conversations carry their titles. */
export type UninstallCheckView = Omit<import("./management.js").UninstallCheck, "conversations"> & {
  readonly conversations: readonly { readonly sessionId: string; readonly title: string; readonly busy: boolean }[];
};
export interface HarnessView {
  readonly id: string;
  readonly name: string;
  /** How far HarnessHub carries it (ADR-050); a fact of the catalog, the same in every scan. */
  readonly tier: HarnessTier;
  readonly installed: boolean;
  readonly defaultControlId: string | null;
  readonly controls: readonly { readonly id: string; readonly protocol: string; readonly available: boolean; readonly reason: string | null;
    /** Where the entry was found; its path stays on the Gateway like every other command detail. */
    readonly entry: { readonly source: HarnessEntrySource } | null }[];
  readonly providerProtocols: readonly string[];
  readonly management: HarnessManagementView;
  /**
   * The product's own documented way to install it on macOS, shown when it is missing; HarnessHub does not run it yet.
   * `checkedAt` is when the command was read from `docs`; `note` says what the official page adds, such as a successor.
   */
  readonly install: { readonly command: string; readonly docs: string; readonly checkedAt: string; readonly note: string | null;
    /** How HarnessHub installs it: by its official script or npm package once the user confirms, or only shown for the terminal. */
    readonly method: "script" | "npm" | "terminal"; readonly available: boolean } | null;
  /**
   * Every installation found in an official channel (ADR-044), in search order with PATH first; a Gateway that allows
   * unofficial entries (development) also lists those, with a null channel. Paths stay on the Gateway.
   */
  readonly installations: readonly InstallationView[];
  /**
   * A program found under the product's command outside every official channel; HarnessHub neither uses nor maintains it.
   * `pathDefault`: it is what the command resolves to in this Gateway's PATH, so a terminal with that PATH runs it.
   */
  readonly unofficial: { readonly command: string; readonly onPath: boolean; readonly pathDefault: boolean } | null;
}
/** One installation of a product or of the adapter HarnessHub runs in front of it, described without its path. */
export interface InstallationView {
  /** Names this installation for an uninstall check or submission without its path (ADR-044). */
  readonly ref: string;
  readonly channel: "npm" | "brew-formula" | "brew-cask" | "script" | "uv" | "pnpm" | "bun" | null;
  /** Where it is in the user's terms, such as "npm 全局（nvm v26.11.1）" or "官方安装脚本". */
  readonly label: string;
  /** The command it was found as. */
  readonly command: string;
  /** The version its channel records; null when the channel records none. */
  readonly version: string | null;
  readonly role: "product" | "adapter";
  /** The one this Gateway runs: the first of its role in this Gateway's PATH order. A terminal's PATH may differ. */
  readonly active: boolean;
  /** Whether HarnessHub maintains this channel; pnpm and bun installations are listed only. */
  readonly maintained: boolean;
  /** Whether HarnessHub can uninstall it: a maintained channel, and for a script its whitelisted layout. */
  readonly canUninstall: boolean;
  /**
   * How HarnessHub upgrades it (ADR-044): `version` to an exact newer version through its channel, `self-update` by the
   * product's own updater, `rerun` by its official install script run again, `terminal` only by a command shown for the
   * terminal, `maintenance` through the Harness's own upgrade (ADR-043); null when HarnessHub does not upgrade it.
   */
  readonly upgrade: "version" | "self-update" | "rerun" | "terminal" | "maintenance" | null;
  /** The latest version its channel knew at the last update check (`homebrew-local`: Homebrew's local records); null before one. */
  readonly latest: { readonly version: string | null; readonly source: "npm" | "homebrew-local"; readonly checkedAt: string; readonly error: string | null } | null;
}
export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly updatedSeq: number;
  readonly activeRunId: string | null;
}
/** Public history excludes admission fingerprints and private configuration references. */
/** The installed Harness's own sessions of a workspace; `conversationId` names the conversation already continuing one. */
export interface NativeSessionListView {
  /** null when this Harness's interface cannot list or continue its sessions. */
  readonly sessions: readonly (import("./control.js").NativeSessionSummary & { readonly conversationId?: string })[] | null;
  readonly nextCursor: string | null;
  /** How many sessions of this page were left out because a Hub catalog read opened them; absent when none were. */
  readonly hiddenProbes?: number;
}
/**
 * What the Hub last saw of one Harness entry before a message is sent. `state` comes from the entry's latest native
 * catalog read (ready: it answered; signed_out: it needs its own sign-in or setup; failed: the read failed), or is
 * `unchecked` when only recent Runs are known. Entries the Hub has neither read nor run are absent.
 */
export interface HarnessReadinessView {
  readonly harnessId: string;
  readonly controlId: string;
  readonly state: "ready" | "signed_out" | "failed" | "unchecked";
  /** Milliseconds since the epoch of that catalog read; null when unchecked. */
  readonly checkedAt: number | null;
  /** Whether the native side said it is signed in; null when its interface does not say. Only for `ready`. */
  readonly signedIn?: boolean | null;
  /** Stable failure class of a failed read. */
  readonly failureCode?: string;
  /** Median time from starting the program to its open native session over this entry's latest Runs (up to five). */
  readonly startupMs?: number;
}
/** The login shell's PATH directories the user added to discovery (G(ii)), and whether reading them is offered here. */
export interface LoginShellView {
  readonly available: boolean;
  /** The shell's name, without its path. */
  readonly shell?: string;
  readonly dirs: readonly string[];
  /** Milliseconds since the epoch of the last read; null before any. */
  readonly readAt: number | null;
}
/**
 * How to continue a conversation's native session in the Harness's own program (ADR-039), given for whatever version of
 * the program is installed (ADR-053). It is read on demand and is not part of the conversation's view or its export;
 * HarnessHub never runs these commands.
 */
export interface NativeResumeView {
  readonly harnessId: string;
  /** The native session's own identifier; absent for a program whose reference is private (Pi's session file). */
  readonly nativeId?: string;
  /** The interactive command as the program's help gives it, run in the conversation's workspace. */
  readonly interactive?: string;
  /** The program's own one-question continue command, with a question placeholder. */
  readonly once?: string;
  /** What the one-question command depends on: a flag it does not always need (Codex), or the credentials it reads (DeepSeek Harness). */
  readonly onceNote?: string;
  /** Where the program lists its own sessions, for one whose reference is private. */
  readonly list?: string;
  /** Why no command is given: this program has no continue command HarnessHub can give. */
  readonly note?: "no-command";
}
/** A native session reference as the chat shows it; never the private checkpoint. */
export interface NativeStateView {
  readonly harnessId: string;
  readonly controlId: string;
  readonly status: "ready" | "unconfirmed" | "forking";
  /** The model and option values the native session reported after its last Turn. */
  readonly observed?: import("./session.js").NativeConfiguration;
  /** Selected values the next Turn applies as the native session changed them itself, instead of the selection (ADR-028). */
  readonly carried?: { readonly model?: string; readonly options?: import("./control.js").NativeOptions };
}
/** Every waiting approval or question across conversations, as one bounded frame (ADR-035); revisions only increase. */
export interface AttentionFrame { readonly revision: number; readonly items: readonly import("./session.js").AttentionItem[] }
export interface SessionView {
  readonly id: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly epoch: number;
  readonly status: SessionSnapshot["status"];
  readonly workspace: string;
  readonly selection: HarnessSelection;
  readonly activeRunId: string | null;
  readonly pendingSwitchId: string | null;
  readonly permissions?: readonly import("./session.js").PermissionRequest[];
  readonly nativeStates?: readonly NativeStateView[];
  /** The public history a branched conversation started from. */
  readonly origin?: import("./session.js").SessionOrigin;
  /**
   * Whether the conversation keeps its native process between Turns (ADR-030), and the process it keeps now: when it was
   * first kept, its last Turn, when it ends unless used, and how many updates it sent outside Turns (counted, not shown).
   */
  /**
   * The Turn of this conversation that waits to start: only when an operator limited how many conversations run at once and the limit
   * is reached, for a slot (how many run, of how many; no deadline of its own). Conversations that share a workspace do not wait for
   * each other (2026-11-12): the later Turn says so in a notice.
   */
  readonly queue?: { readonly kind: "slot"; readonly runId: string; readonly running: number; readonly limit: number; readonly since: number };
  readonly retention?: { readonly enabled: boolean; readonly process: KeptProcessView | null;
    /** The process this conversation kept when the previous service ended without closing it, as this service found it. */
    readonly lost?: { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number };
    /** Background processes that left the closed or taken-over program's group and still ran then; until the next Turn. */
    readonly outside?: { readonly count: number; readonly at: number };
    /** The upgrade of this Harness that closed the kept process (ADR-043); until the next Turn, which starts the new version. */
    readonly upgraded?: { readonly harnessId: string; readonly at: number } };
  readonly messages: readonly PublicMessage[];
  readonly runs: readonly WebRun[];
  readonly switches: readonly PublicSwitch[];
}
/** A conversation's kept native process as the chat shows it; times are milliseconds since the epoch. */
export interface KeptProcessView {
  readonly harnessId: string;
  readonly controlId: string;
  readonly since: number;
  readonly lastUsedAt: number;
  readonly idleEndsAt: number;
  readonly backgroundUpdates: number;
}
export interface WebState {
  readonly providerManagement?: boolean;
  readonly workspace: string;
  readonly providers: readonly ProviderView[];
  /** The last completed scan of this computer's Harnesses (ADR-050); reading the state never starts one. */
  readonly harnesses: readonly HarnessView[];
  /**
   * When that scan began reading this computer, as an ISO time: a change made after it, such as a task that ended later,
   * may be missing from `harnesses`.
   */
  readonly harnessesScannedAt: string;
  readonly sessions: readonly SessionSummary[];
  /** The cursor of the list's next page (`GET /api/v1/sessions?after=`); null when `sessions` ends it. */
  readonly sessionsNext?: string | null;
  readonly jobs: readonly InstallationJobView[];
  readonly readiness: readonly HarnessReadinessView[];
  /** What this Gateway counts as an installation (ADR-044); `any` only for development and tests. */
  readonly installationPolicy: "official" | "any";
  /** Present (true) on a Gateway that has the relay API (ADR-055 §12.4); the page asks for the relay only of a Gateway that says so. */
  readonly relay?: true;
}
export interface EventPage {
  readonly events: readonly SessionEvent[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
/** Canonical committed UI facts. Message frames replace the full message; they are not append-only deltas. */
export type SessionStreamFrame =
  | { readonly type: "snapshot"; readonly session: SessionView }
  | { readonly type: "message"; readonly sessionId: string; readonly version: number; readonly lastSeq: number; readonly message: PublicMessage }
  /** One active Run's canonical facts (tools, plan, usage, notices, activities, outputs) after a single committed event. */
  | { readonly type: "run"; readonly sessionId: string; readonly version: number; readonly lastSeq: number; readonly run: WebRun }
  /** A notice that a relay event happened (no facts of its own): it carries the watermark of the facts it follows. */
  | RelayStreamFrame;
export interface InstallationLogPage {
  readonly entries: readonly InstallationLog[];
  readonly nextSeq: number;
  readonly hasMore: boolean;
}
export interface CreateWebSession {
  readonly workspace?: string;
  readonly selection: SelectionRequest;
  readonly commandId: string;
}
export interface SwitchWebSession { readonly selection: SelectionRequest; readonly commandId: string }
export interface WebError {
  readonly code: string;
  readonly message: string;
}
export interface AuthSession { readonly csrfToken: string }

// ---------------------------------------------------------------------------------------------------------------------
// The relay's API (ADR-055 §12.4; G073's server side). Everything here is derived from committed relay rows and the
// Session's own facts; none of it carries a packet's text, a position, a native transcript path or any keyed digest.
// ---------------------------------------------------------------------------------------------------------------------

/** What is known of a Run's packet reaching its binding's native history; it can still change after the Run ended. */
export interface RelayDeliveryView {
  readonly state: DeliveryStatus;
  /** Only when `recorded`: E1 (the native side said so: live evidence) or E3 (inferred when the Turn ended normally). */
  readonly evidence: DeliveryEvidence | null;
}
/**
 * PublicRun.relay with the delivery state and the relay's decision read in. `delivery` is present for every Run that carried a
 * packet (`packetId` is not null), and unknown for a packet no row tracks (the Gateway keeps no binding of a Driver without a
 * resumable session); absent for a Run that carried none, and when the Session's delivery rows could not be read. `decision`
 * (`run.context_prepared.data.relay.decision`) is what the relay did with the Turn's history and why, present only for a Turn
 * that has one: an automatic resend, a send alone, a complete packet again, or the user's own choice. It is how the page tells
 * "this one went alone" from "taken over".
 */
export interface RunRelayView extends RunRelay { readonly delivery?: RelayDeliveryView; readonly decision?: RelayDecision }
/**
 * The Run as the API shows it: a PublicRun whose `relay` also carries the delivery state and the decision, and without its
 * `relayRequest` (that member holds an HMAC of the user's choices, which stays in the Gateway; what the user chose shows in
 * `relay.decision.by === "user"`). Assignable to PublicRun, whose `relayRequest` is optional. Its `protocol` (PublicRun's own
 * member, never stored) is the Run as the HarnessHub protocol tells it, read from the facts when the view is made.
 */
export type WebRun = Omit<PublicRun, "relay" | "relayRequest"> & {
  readonly relay?: RunRelayView;
};

/**
 * What a binding is, in the words the page knows: `fresh`, its native session holds nothing of the conversation (no mark, nothing run on it);
 * `synced`, it holds a part (a recorded packet, or Turns of its own); `pending`, a packet was sent to it and nothing confirmed it.
 */
export const SYNC_KINDS = ["fresh", "synced", "pending"] as const;
/** One native binding of a Session as the details panel's "接续" row shows it (GET …/relay). */
export interface RelayBindingView {
  readonly harnessId: string;
  readonly controlId: string;
  readonly nativeEpoch: number;
  readonly sync: typeof SYNC_KINDS[number];
  /** The 0-based index (in the Session's Runs) of the latest finished Run the binding's mark covers; null when it covers none. */
  readonly throughRun: number | null;
  /** The evidence the binding's latest recorded packet was decided by (E1 or E3); null when none was. */
  readonly evidence: EvidenceClass | null;
  /** 1 when the conversation was cleared on this Harness at some point (the native session in use started from a clear), else 0: the Gateway keeps no count. */
  readonly cleared: number;
  /**
   * Whether anything this Harness does can tell the Gateway that a handoff arrived (a live signal, or a prompt that ended and so
   * proves its entry recorded). False for a Driver that declares none: a packet sent to it stays unconfirmed whatever happens, which
   * is a fact about the Harness and not a fault. Absent when the Gateway cannot tell.
   */
  readonly canConfirm?: boolean;
  /**
   * What a handoff to this binding would carry now: the finished Runs of other Harnesses (or its earlier native epochs) it does not
   * hold, and an estimate of their tokens. The estimate errs high and is not the packet's size (the packet folds to its budget).
   * Absent when nothing is owed.
   */
  readonly owed?: { readonly runs: number; readonly estTokens: number };
  /**
   * What this binding asks the user to look at, read from the Runtime: never a block, the next input goes anyway. Absent when it
   * needs nothing.
   */
  readonly attention?: RelayAttentionView;
}
/**
 * `Runtime.relayAttention` for one binding. `options` are the ways the user may settle it, each one field of the next send's
 * `relay` member (`attach_full` is `{ attach: "full" }`). `key` names one episode: the same cause within one wait is one key, so a
 * banner that was closed does not come back. `packet` is the "交接单 #n" a `delivery_unconfirmed` is about.
 */
export interface RelayAttentionView {
  readonly cause: RelayAttention["cause"];
  readonly options: RelayAttention["options"];
  readonly counts: RelayAttention["counts"];
  readonly key: string;
  readonly packet?: number;
}
/** One packet-carrying Run (GET …/relay), in Run order; the same packet sent again by another Run is another entry. */
export interface RelayPacketView {
  readonly packetId: RelayPacketId;
  readonly runId: RunId;
  /** The 0-based index of that Run among the Session's Runs. */
  readonly runIndex: number;
  /** The 1-based ordinal among the Session's packet-carrying Runs, in Run order ("交接单 #1"): the n-th Run whose `relay.packetId` is not null. */
  readonly number: number;
  readonly kind: RelayPacketKind;
  readonly tier: Tier;
  readonly target: { readonly harnessId: string; readonly model: string | null };
  readonly estTokens: number;
  /** How many items the packet left out whole (the sum of its ledger's omitted counts); 0 for a complete one. */
  readonly omissions: number;
  readonly redactions: number;
  readonly delivery: DeliveryStatus;
  readonly evidence: DeliveryEvidence | null;
}
export interface RelayView {
  readonly bindings: readonly RelayBindingView[];
  readonly packets: readonly RelayPacketView[];
  /**
   * The Harnesses this installation has handed a conversation to before: its handoff log's rows that a delivery rests on, by Harness
   * id. The first handoff to a Harness is told in one line above the message box, once; a Harness listed here needs no telling.
   */
  readonly handedOver: readonly string[];
  /**
   * What the installation as a whole cannot do for the relay while it stays so (the relay key file is unusable): a standing notice with its
   * reason, for every conversation, until it is mended. Absent when nothing is wrong (`Runtime.relayInstallation`).
   */
  readonly installation?: readonly RelayInstallationNotice[];
}
/** The installation's relay preferences, all of them: a key never set has its default (RELAY_PREF_DEFAULTS) (GET and PUT /api/v1/relay/prefs). */
export interface RelayPrefsView { readonly prefs: Readonly<Record<RelayPrefKey, string>> }

/** The session events the stream announces as `relay` frames (a notice, not the facts: the facts are in the snapshot before it). */
export const RELAY_STREAM_EVENTS = ["relay.input_recorded"] as const;
export type RelayStreamEventType = typeof RELAY_STREAM_EVENTS[number];
/** Names an event and where it happened; never the packet's text, a native value or a digest of one. `at` is epoch milliseconds. */
export interface RelayStreamEvent {
  readonly type: RelayStreamEventType;
  readonly sessionId: string;
  readonly runId?: string;
  readonly packetId?: string;
  readonly at: number;
}
/**
 * The stream's notice of a relay event. It follows, with the same `version` and `lastSeq`, the frame that carries the facts
 * (a snapshot, for these events), so a reader that applies facts by watermark takes it as a no-op and reads `event`. A
 * subscription that is behind (its connection is backed up) gets the snapshot later and no notice. It is a member of
 * SessionStreamFrame: the page's decoder and reducer (web/src/session-stream.ts) read the event first and then take the frame
 * as the no-op its watermark makes it. An older page, which knows three frame types, ends a stream that carries one.
 */
export interface RelayStreamFrame {
  readonly type: "relay";
  readonly sessionId: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly event: RelayStreamEvent;
}

// ---------------------------------------------------------------------------------------------------------------------
// The conversation on the wire once it is kept as rows (ADR-057 3.4, store v14). Added beside SessionView and its frames, which stay
// until the page reads these. A conversation is read as its head and a window of its newest Turns; older Turns, long text and long
// stretches of work come by cursor and byte range, so no reply, no Turn and no conversation is too large to open.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * An item on the v14 wire: the protocol's own fields, and where it has a text (a user message, an assistant segment, reasoning) the text
 * in `text`. There is no `messages` list: a message is an item, and the page builds the lookup its renderer asks for
 * (`message(messageId)`, web/src/components/ProtocolTurn.tsx) from the items it holds. A text longer than `PAGE.itemInlineBytes`, or a
 * body that is long in another way (a file change of thousands of files), is left out of the transfer: the item says `bodyOmitted`, a
 * text says `textBytes`, and the page fetches the text by byte range (`ItemTextView`) or the item whole (`ItemView`). The stored item
 * never has these marks.
 */
export type WireItem = ProtocolItem;
/** The Turn's header: everything of a `ProtocolTurn` but its items (state, stop reason, executor, usage, times, `legacyOrder`). */
export type WireTurnHeader = Omit<ProtocolTurn, "items">;
/**
 * A Run on the v14 wire: the facts it always had (a `WebRun` with the relay's delivery read in) without the display fields the items
 * replaced, without `input` (the text of its `user` item) and without `protocol`, whose header is `turn`. The page assembles the Run its
 * renderer draws from it: `{ ...run, input: <the user item's text>, protocol: { ...turn, items } }`.
 */
export interface WireRun extends Omit<WebRun, "protocol" | "input"> {
  /** From 0; the Turn's number is `ordinal + 1`. */
  readonly ordinal: number;
  /** The seq of the event that accepted the input: where the message stands among the events. */
  readonly userSeq: number;
  readonly turn: WireTurnHeader;
}
/** One Turn of a window: its Run, its items in place order, and the middle of a long stretch of work when the window left it out. */
export interface WireTurn { readonly run: WireRun; readonly items: readonly WireItem[]; readonly deferred?: DeferredWork }
/** The newest Turns up to a size (at least one), oldest first; or the page of Turns before a cursor. */
export interface TurnWindowView {
  readonly turns: readonly WireTurn[];
  /** The cursor of the page before `turns[0]`; null when `turns[0]` is the conversation's first Turn. */
  readonly older: string | null;
}
/**
 * What the page used to learn by looking at every Turn of the conversation, and now is told: the Gateway works it out from the Runs' light rows (the facts of each Run, never a
 * Turn's items or words), so that it holds for the whole conversation whichever Turns the page has. Part of every head, and so of every frame that changes it.
 */
export interface SessionFacts {
  /** The Turns whose result is not known (they ended without a result the Gateway can vouch for); `unclosed`: one of them did not close its program. */
  readonly unknown: { readonly count: number; readonly unclosed: boolean };
  /** Every Turn is over: none runs, waits for a slot or is being closed. */
  readonly settled: boolean;
  /** The latest Turn that completed, failed or was stopped: where a branch can start; null when there is none. */
  readonly branchable: { readonly runId: string; readonly ordinal: number } | null;
  /** The Turns that reached a Harness and ended, by the control they ran on: what a hand-over to a control that ran none of them would carry. */
  readonly ran: readonly { readonly harnessId: string; readonly controlId: string; readonly turns: number }[];
  /** The file changes of the whole conversation that have a stored detail (where their diff is): the number the details button shows. */
  readonly changes: number;
}
/** What `SessionView` says of a conversation without its history: the head. */
export interface SessionHeadView extends Omit<SessionView, "messages" | "runs" | "switches"> {
  readonly title: string;
  readonly runCount: number;
  /**
   * The conversation's latest switch, whatever its state: the one asked for and not yet effective (`pendingSwitchId` names it), or the one that failed last, which the page
   * says. The page needs these two, not the list of switches (a Turn's `switch` line is read from its Run).
   */
  readonly lastSwitch?: PublicSwitch;
  readonly facts: SessionFacts;
}
/** One change of the conversation that has a stored detail, with the Turn it was made in. */
export interface ConversationEdit { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly item: WireItem }
/**
 * `GET /api/v1/sessions/:id/changes?before=<cursor>&limit=`: the changes of the whole conversation that have a stored detail, newest first, a page at a time; and, on the first page,
 * the plan of the newest Turn that has one with steps. The page reads the diffs of the changes it shows from their stored details.
 */
export interface ConversationChangesView {
  readonly edits: readonly ConversationEdit[];
  /** The cursor of the page after this one (older changes); null at the end. */
  readonly next: string | null;
  /** The newest Turn's plan with at least one step, as the Harness reported it (a row); only on the first page, and null when no Turn has one. */
  readonly plan?: { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly item: WireItem } | null;
}
/** `GET /api/v1/sessions/:id`. */
export interface SessionViewV14 { readonly head: SessionHeadView; readonly window: TurnWindowView }
/** `GET /api/v1/sessions/:id/turns?before=<cursor>&limit=`: the page of Turns before the cursor; `limit` is a page size and has no ceiling on what the conversation holds. */
export type TurnPageView = TurnWindowView;
/** `GET /api/v1/sessions/:id/runs/:ordinal/items?after=<seq>&limit=`: the items of a Turn from a place on (a deferred stretch, a Turn read to its end). */
export interface RunItemsPageView { readonly items: readonly WireItem[]; /** The `after` of the next page; null at the end. */ readonly next: number | null }
/** `GET /api/v1/sessions/:id/runs/:ordinal/items/:seq`: one item whole, with its text. */
export interface ItemView { readonly item: WireItem }
/** `GET /api/v1/sessions/:id/runs/:ordinal/items/:seq/text?from=&to=`: a byte range of an item's text, on code point boundaries; no range is the whole text. */
export type ItemTextView = TextRange;
/** `GET /api/v1/sessions?after=<cursor>&limit=`: the conversations newest first, a page at a time; every conversation is reached by the cursor. */
export interface SessionListView { readonly sessions: readonly SessionSummary[]; readonly next: string | null }

/** An item that is new or changed in a commit: placed by `(runId, item.seq)`, the item replacing the page's copy (its text is `texts`'s to extend). */
export interface WireItemUpsert { readonly runId: string; readonly item: WireItem }
/**
 * Text appended in a commit, at byte offset `from` of the item's text. The page applies it only if `from` is the length of the text it
 * holds; otherwise it missed a commit and fetches the conversation again (a snapshot), never guessing.
 */
export interface WireTextAppend {
  readonly runId: string; readonly itemSeq: number; readonly from: number; readonly text: string;
  /**
   * Set when the chunk is longer than a frame carries (`PAGE.itemInlineBytes`): `text` is then empty and this many bytes were appended at `from` that the
   * frame does not hold. The page marks the item's body as left out (`textBytes` = `from` + this) and reads the range when it shows it.
   */
  readonly omittedBytes?: number;
}
/**
 * Everything one commit changed, in ONE frame: the head when it changed, the Runs that began or changed (with their Turn headers), the
 * items that are new or changed, the text appended. One frame per commit because a frame is applied if its `lastSeq` is above the page's
 * (web/src/session-stream.ts): several frames at one watermark would lose all but the first. Made from the commit's changes
 * (`ConversationCommit.changes`) after it, never before; it carries no large body (an item over the page size is `bodyOmitted`).
 */
export interface SessionCommitFrame {
  readonly type: "commit";
  readonly sessionId: string;
  readonly version: number;
  readonly lastSeq: number;
  readonly head?: SessionHeadView;
  readonly runs?: readonly WireRun[];
  readonly items?: readonly WireItemUpsert[];
  readonly texts?: readonly WireTextAppend[];
}
/**
 * The frames of the v14 stream: the snapshot a connection starts with (always, after a reconnect: events are not replayed), one commit
 * frame for each commit after it, and the relay's notice as before. The page behind a slow connection gets a snapshot, not the frames it missed.
 */
export type SessionStreamFrameV14 =
  | { readonly type: "snapshot"; readonly session: SessionViewV14 }
  | SessionCommitFrame
  | RelayStreamFrame;
