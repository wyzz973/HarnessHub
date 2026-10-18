/**
 * What each installed Harness reads besides its model, shown in one place (ADR-045): skills, MCP servers, user-level
 * instructions, subagents, custom commands, hooks and plugins. A view holds facts without values: no environment or
 * header value, no URL path or query, and paths with ~ for the home directory.
 */
export const CAPABILITY_KINDS = ["skill", "mcp", "instructions", "subagent", "command", "hook", "plugin"] as const;
export type CapabilityKind = typeof CAPABILITY_KINDS[number];

/**
 * How an entry reaches a Harness: read from the shared `~/.agents/skills` itself (`native-shared`), through a link in the
 * Harness's own directory (`linked`), as a copy there (`own-copy`), from another product's directory the Harness also
 * reads (`compat-root`), from a directory its configuration adds (`external-dir`), from a plugin or the program's own
 * bundle, synced from the product's account (`synced`, Claude Code's `skills/synced`), or from an entry in its
 * configuration (`config`).
 */
export const CAPABILITY_MECHANISMS = ["native-shared", "linked", "own-copy", "compat-root", "external-dir", "plugin", "bundled", "synced", "config"] as const;
export type CapabilityMechanism = typeof CAPABILITY_MECHANISMS[number];
/**
 * What the Harness does with it, by its documented or verified rules: uses it (`active`), has it turned off in its own
 * configuration (`disabled`), lets another copy win (`shadowed`), loads it more than once or keeps one of several
 * without a defined order (`duplicate`), refuses it (`rejected`, such as a link leaving its root), finds a link to
 * nothing (`broken-link`) or a definition it cannot use (`invalid`).
 */
export const CAPABILITY_STATUSES = ["active", "disabled", "shadowed", "duplicate", "rejected", "broken-link", "invalid"] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];
/**
 * Who manages an entry, as far as it can be told without asking anyone: the user unless a manager left its record or mark.
 * `bundled`: the program installed it with itself; `synced`: the product syncs it from the user's account.
 */
export const CAPABILITY_OWNERS = ["user", "harnesshub", "skills-cli", "cc-switch", "magpie", "clawhub", "hermes-hub", "plugin", "bundled", "synced"] as const;
export type CapabilityOwner = typeof CAPABILITY_OWNERS[number];

/** Facts of one entry as one Harness has it, without any value. */
export type CapabilityFacts =
  | { readonly kind: "skill"; readonly files: number; readonly bytes: number }
  | { readonly kind: "mcp"; readonly transport: "stdio" | "http" | "sse" | "unknown"; readonly program: string | null; readonly host: string | null;
    /** Environment variables and headers it names; `references` are given as variable references, `literal` as values written in the file. */
    readonly variables: readonly string[]; readonly headers: readonly string[]; readonly references: number; readonly literal: number; readonly enabled: boolean }
  | { readonly kind: "instructions"; readonly bytes: number; readonly managedBlocks: readonly string[] }
  | { readonly kind: "subagent" | "command"; readonly format: "markdown" | "toml" }
  | { readonly kind: "hook"; readonly event: string; readonly matcher: string | null; readonly program: string | null }
  | { readonly kind: "plugin"; readonly version: string | null; readonly enabled: boolean | null };

/** One way one Harness sees one entry. */
export interface CapabilityEdge {
  readonly harnessId: string;
  readonly mechanism: CapabilityMechanism;
  readonly status: CapabilityStatus;
  /** Where the Harness finds it, with ~ for the home directory. */
  readonly via: string;
  /** Why it has this status, in the user's terms; null when it is simply used. */
  readonly reason: string | null;
  readonly facts?: CapabilityFacts;
}
export const CAPABILITY_WARNINGS = ["duplicate", "shadow", "cross", "invisible", "literal", "redundant"] as const;
export interface CapabilityWarning {
  /**
   * `duplicate`: seen more than once by one Harness; `shadow`: another copy or file wins; `cross`: one product's entry also
   * reaches another; `invisible`: the Harness keeps it where it cannot be read; `literal`: a value written in a file
   * where a variable reference would do; `redundant`: a link the Harness skips because it already reads the target.
   */
  readonly kind: typeof CAPABILITY_WARNINGS[number];
  readonly harnessId: string | null;
  readonly text: string;
}
export interface CapabilityEntry {
  readonly kind: CapabilityKind;
  /** Unique within a view. */
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly owner: CapabilityOwner;
  /** Where its manager says it came from, such as a repository URL; never a credential. */
  readonly source: string | null;
  /** Its primary location, with ~. */
  readonly location: string | null;
  readonly edges: readonly CapabilityEdge[];
  readonly warnings: readonly CapabilityWarning[];
  readonly facts?: CapabilityFacts;
  /** For a skill in the shared directory: the folder there, with ~, and its links HarnessHub placed (by its ledger), with ~. */
  readonly shared?: { readonly folder: string; readonly placed: readonly string[] };
}
/** What the view knows about one installed Harness. */
export interface HarnessCapabilityReads {
  readonly harnessId: string;
  readonly name: string;
  readonly version: string | null;
  /** Whether the read table covers this version with evidence; `unverified` reads by the nearest table and says so. */
  readonly table: "verified" | "unverified";
  /** Per kind: read from disk, not a thing this Harness has, or kept where it cannot be read (Cursor's user rules); `notes` say why. */
  readonly kinds: Readonly<Record<CapabilityKind, "read" | "unsupported" | "invisible">>;
  /**
   * How HarnessHub turns one of its skills off and on (ADR-045 §4): by editing the Harness's own file, by the Harness's
   * own command (OpenClaw), or not at all (Cursor, Pi, DeepSeek Harness: always visible). Codex switches one copy by its
   * path; the others switch a skill by its name.
   */
  readonly skillSwitch: "file" | "command" | null;
  /**
   * How it reads the shared `~/.agents/skills`: itself (`native`), through a directory its configuration adds
   * (`external-dir`, Hermes), through links in its own directory (`links`), or not at all; `links` counts its own links
   * into the shared directory and `redundant` those it does not need, since it reads their target anyway.
   * `placeable`: whether HarnessHub can change this — make Hermes read it, or place single skills in Claude Code.
   */
  readonly shared: { readonly reads: "native" | "external-dir" | "links" | "no"; readonly links: number; readonly redundant: number; readonly placeable: "shared-dir" | "skill-link" | null };
  readonly notes: readonly string[];
}
export interface CapabilitiesView {
  readonly checkedAt: string;
  readonly harnesses: readonly HarnessCapabilityReads[];
  readonly entries: readonly CapabilityEntry[];
  /** Files a Harness reads that could not be parsed or read; nothing is guessed from them. `harnessId` is null for a manager's file, such as a skills lock. */
  readonly unreadable: readonly { readonly harnessId: string | null; readonly file: string; readonly reason: string }[];
  /** Entries left out at the bound; the machine has more than shown. */
  readonly truncated: boolean;
}
export const MAX_CAPABILITY_ENTRIES = 4096;

/** Why a capability change was refused before anything was written, or why a stored change is unusable. */
export type CapabilityErrorCode = "INVALID_INPUT" | "CAPABILITY_UNSUPPORTED" | "CAPABILITY_NOT_FOUND" | "CAPABILITY_CHECK_EXPIRED" | "CAPABILITY_TARGET_CHANGED"
  | "CAPABILITY_TARGET_REFUSED" | "CAPABILITY_COMMAND_FAILED" | "CAPABILITY_PROTECTION_UNAVAILABLE" | "INVALID_STORAGE" | "OWNERSHIP_LOST";
export class CapabilityError extends Error {
  constructor(readonly code: CapabilityErrorCode, message: string) { super(message); this.name = "CapabilityError"; }
}
/**
 * A change to one Harness's own configuration, prepared and shown before anything is written (ADR-045 §3). A check is
 * good once, for 15 minutes, and only while the file is as it was read; `blocked` checks cannot be applied.
 */
/**
 * The kinds of change (ADR-045 §4): turning a skill off or on in a Harness's own switch; making Hermes read the shared
 * directory (`skills.external_dirs`); placing a shared skill in Claude Code by a link of its own; removing the links a
 * Harness no longer needs because it reads the shared directory itself; undoing a change of links; restoring a backup.
 */
export const CAPABILITY_CHANGE_KINDS = ["skill-switch", "shared-dir", "skill-link", "link-cleanup", "link-undo", "restore"] as const;
export type CapabilityChangeKind = typeof CAPABILITY_CHANGE_KINDS[number];
/** A link a change creates or removes: where (with ~) and what it points to, as written in the link. */
export interface CapabilityLinkChange { readonly path: string; readonly target: string; readonly action: "create" | "remove" }
export interface CapabilityChangeCheck {
  readonly kind: Exclude<CapabilityChangeKind, "restore">;
  readonly harnessId: string;
  /** What it changes: a skill's name, the shared directory, or the links of a directory. */
  readonly name: string;
  /** The state after the change: the skill on, the shared directory read, the link present; false for a cleanup or an undo. */
  readonly enabled: boolean;
  /** The file it changes, with ~; for a change made by the Harness's own command, the file that command writes. */
  readonly file: string;
  /** The Harness's own command that makes the change instead of an edit (OpenClaw), as shown to the user. */
  readonly command: string | null;
  /**
   * The exact change of the file as a unified diff with at most two lines of context, ~ standing for the home directory
   * and credentials masked. For a whole-file rewrite (`rewrite`), the full masked diff, shown only on request.
   */
  readonly diff: string | null;
  /**
   * A change made by the Harness's own command that rewrites the whole file (OpenClaw), summarized: the target setting
   * before and after (JSON; null when absent), the other keys the command adds, removes or changes (up to two levels),
   * and how many comment lines the rewrite drops.
   */
  readonly rewrite: { readonly target: string; readonly before: string | null; readonly after: string | null; readonly added: readonly string[]; readonly removed: readonly string[];
    readonly changed: readonly string[]; readonly commentLines: number } | null;
  /** The links it creates or removes; empty for an edit of a file. */
  readonly links: readonly CapabilityLinkChange[];
  /** Who wrote the setting it changes: HarnessHub (by its ledger and unchanged since), someone else, or nobody yet. */
  readonly current: "harnesshub" | "other" | "none";
  readonly notes: readonly string[];
  readonly blocked: string | null;
  readonly fingerprint: string;
  readonly expiresAt: string;
}
/** What one applied change did. A change that wrote and then did not read back as planned is `failed`, with its backup. */
export interface CapabilityChangeView {
  readonly id: string;
  readonly kind: CapabilityChangeKind;
  readonly harnessId: string | null;
  /** A skill's name, or for a restore the file's backup it restored. */
  readonly subject: string;
  readonly file: string;
  readonly status: "applied" | "failed";
  /** The change actually made, as a unified diff with ~; null when nothing was written or the Harness's command rewrote the file. */
  readonly diff: string | null;
  /** The copy of the file taken before this change wrote it; null when the file did not exist or nothing was written. */
  readonly backupId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly notes: readonly string[];
  /** The links it created or removed, which an undo reverses; absent for an edit of a file. */
  readonly links?: readonly CapabilityLinkChange[];
  readonly at: string;
}
/** A file's bytes as they were before one HarnessHub change; the newest ten per file are kept. */
export interface CapabilityBackupView { readonly id: string; readonly file: string; readonly createdAt: string; readonly bytes: number; readonly changeId: string; readonly subject: string }
/** Restoring a backup, shown first: what it changes now, and whether the file changed after HarnessHub's change. */
export interface CapabilityRestoreCheck {
  readonly backupId: string;
  readonly file: string;
  readonly diff: string;
  readonly changedSince: boolean;
  readonly notes: readonly string[];
  readonly fingerprint: string;
  readonly expiresAt: string;
}
export const CAPABILITY_DRIFT_STATES = ["removed", "changed", "unreadable"] as const;
export type CapabilityDriftState = typeof CAPABILITY_DRIFT_STATES[number];
/**
 * A setting or link HarnessHub's ledger says it wrote that is no longer as it wrote it: removed or changed by someone
 * else (often the Harness rewriting its own file), or in a file that cannot be read or parsed now. Nothing puts it back
 * by itself; the user re-applies it through its usual check, or tells HarnessHub to stop tracking it.
 */
export interface CapabilityDrift {
  /** Names this ledger entry for re-applying or forgetting it; opaque. */
  readonly id: string;
  readonly kind: "skill-switch" | "shared-dir" | "skill-link";
  readonly harnessId: string;
  /** A skill's name, or the shared directory. */
  readonly subject: string;
  /** The file or link, with ~. */
  readonly file: string;
  readonly state: CapabilityDriftState;
  /** HarnessHub's change that wrote it, and when. */
  readonly changeId: string;
  readonly at: string;
}
/** HarnessHub's changes and backups, newest first, and what it wrote that is no longer in place. */
export interface CapabilityHistory { readonly changes: readonly CapabilityChangeView[]; readonly backups: readonly CapabilityBackupView[]; readonly drift: readonly CapabilityDrift[] }
export const MAX_BACKUPS_PER_FILE = 10;
export const CAPABILITY_CHECK_MS = 15 * 60 * 1000;
