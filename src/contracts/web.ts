import type { ProviderView } from "./provider.js";
import type { HarnessManagementView, InstallationJobView, InstallationLog } from "./management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, SelectionRequest, SessionEvent, SessionSnapshot } from "./session.js";

/**
 * Where a control entry was found: on PATH or in a standard directory like comparable products search, as an explicit
 * custom entry from the discovery manifest, in an explicit package root, or as a HarnessHub-managed installation.
 */
export type HarnessEntrySource = "path" | "standard-directory" | "custom-entry" | "package-root" | "managed";
/** Browser-safe observations. Available means resolved control, not task acceptance. */
export interface HarnessView {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
  readonly defaultControlId: string | null;
  readonly controls: readonly { readonly id: string; readonly protocol: string; readonly available: boolean; readonly reason: string | null;
    /** Where the entry was found; its path stays on the Gateway like every other command detail. */
    readonly entry: { readonly source: HarnessEntrySource } | null }[];
  readonly providerProtocols: readonly string[];
  readonly management: HarnessManagementView;
  /** The product's own documented way to install it, shown when it is missing; HarnessHub never runs it. */
  readonly install: { readonly command: string; readonly docs: string } | null;
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
/**
 * How to continue a conversation's native session in the Harness's own program (ADR-039). It is read on demand and is not
 * part of the conversation's view or its export; HarnessHub never runs these commands.
 */
export interface NativeResumeView {
  readonly harnessId: string;
  /** The native session's own identifier; absent for a program whose reference is private (Pi's session file). */
  readonly nativeId?: string;
  /** The interactive command as the installed version's help gives it, run in the conversation's workspace. */
  readonly interactive?: string;
  /** The one-question command a real Turn verified, with a question placeholder. */
  readonly once?: string;
  /** Why the one-question command carries a flag it does not always need. */
  readonly onceNote?: string;
  /** Where the program lists its own sessions, for one whose reference is private. */
  readonly list?: string;
  /** Why no command is given: the installed version is not one HarnessHub verified, or this program's resume never was. */
  readonly note?: "version-unverified" | "not-verified";
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
   * The Turn of this conversation that waits to start (ADR-036): for another conversation's work in their shared workspace
   * (which conversation holds it, whether that one waits for the user as of this view, since when and until when it may
   * wait), or for a slot while every slot is taken (how many conversations run, of how many; no deadline of its own).
   */
  readonly queue?: { readonly kind: "workspace"; readonly runId: string; readonly holderSessionId: string; readonly holderWaitsForUser: boolean; readonly since: number; readonly endsAt: number }
    | { readonly kind: "slot"; readonly runId: string; readonly running: number; readonly limit: number; readonly since: number };
  /** The conversation that held the workspace of each Turn this service ended with WORKSPACE_BUSY after waiting (ADR-036). */
  readonly busyHolders?: Readonly<Record<string, string>>;
  readonly retention?: { readonly enabled: boolean; readonly process: KeptProcessView | null;
    /** The process this conversation kept when the previous service ended without closing it, as this service found it. */
    readonly lost?: { readonly outcome: "terminated" | "gone" | "unconfirmed"; readonly leaseReleased: boolean; readonly at: number };
    /** Background processes that left the closed or taken-over program's group and still ran then; until the next Turn. */
    readonly outside?: { readonly count: number; readonly at: number } };
  readonly messages: readonly PublicMessage[];
  readonly runs: readonly PublicRun[];
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
  readonly harnesses: readonly HarnessView[];
  readonly sessions: readonly SessionSummary[];
  readonly jobs: readonly InstallationJobView[];
  readonly readiness: readonly HarnessReadinessView[];
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
  | { readonly type: "run"; readonly sessionId: string; readonly version: number; readonly lastSeq: number; readonly run: PublicRun };
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
export interface WebError { readonly code: string; readonly message: string }
export interface AuthSession { readonly csrfToken: string }
