import type { ProviderView } from "./provider.js";
import type { HarnessManagementView, InstallationJobView, InstallationLog } from "./management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, SelectionRequest, SessionEvent, SessionSnapshot } from "./session.js";

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
    readonly outside?: { readonly count: number; readonly at: number };
    /** The upgrade of this Harness that closed the kept process (ADR-043); until the next Turn, which starts the new version. */
    readonly upgraded?: { readonly harnessId: string; readonly at: number } };
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
  /** The last completed scan of this computer's Harnesses (ADR-050); reading the state never starts one. */
  readonly harnesses: readonly HarnessView[];
  /**
   * When that scan began reading this computer, as an ISO time: a change made after it, such as a task that ended later,
   * may be missing from `harnesses`.
   */
  readonly harnessesScannedAt: string;
  readonly sessions: readonly SessionSummary[];
  readonly jobs: readonly InstallationJobView[];
  readonly readiness: readonly HarnessReadinessView[];
  /** What this Gateway counts as an installation (ADR-044); `any` only for development and tests. */
  readonly installationPolicy: "official" | "any";
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
