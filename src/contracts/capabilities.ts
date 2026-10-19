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
 * Harness no longer needs because it reads the shared directory itself; undoing a change of links; restoring a backup;
 * adding skills to the shared directory from a GitHub repository, updating one from its source, deleting one, and
 * undoing one of those three; writing an MCP server of HarnessHub's list into one Harness's file (`mcp-sync`), removing
 * it (`mcp-remove`), and recording that an identical entry already there is HarnessHub's (`mcp-claim`, no file changes).
 */
export const CAPABILITY_CHANGE_KINDS = ["skill-switch", "shared-dir", "skill-link", "link-cleanup", "link-undo", "restore", "skill-add", "skill-update", "skill-delete", "skill-undo", "mcp-sync", "mcp-remove", "mcp-claim",
  "instructions-sync", "instructions-remove", "instructions-claim", "subagent-sync", "subagent-remove", "subagent-claim", "skill-create", "skill-edit"] as const;
export type CapabilityChangeKind = typeof CAPABILITY_CHANGE_KINDS[number];
/**
 * A link a change creates or removes: where (with ~) and what it points to, as written in the link. `owner` (for links a
 * deletion removes): placed by HarnessHub by its ledger, or made by another tool such as `npx skills`.
 */
export interface CapabilityLinkChange { readonly path: string; readonly target: string; readonly action: "create" | "remove"; readonly owner?: "harnesshub" | "other" }
/**
 * One skill folder a change adds, replaces, removes or puts back in the shared directory, as shown before confirming:
 * what the folder holds (after the files `npx skills` leaves out too), how many of its files are executable, whether it
 * carries a plugin manifest, and for an update the files it adds, changes and removes (at most 200) and how many of the
 * user's own changes it overwrites.
 */
export interface CapabilitySkillPlan {
  readonly name: string;
  readonly folder: string;
  readonly action: "add" | "update" | "delete" | "restore";
  readonly files: number;
  readonly bytes: number;
  readonly executables: number;
  readonly plugin: boolean;
  readonly changes: readonly { readonly path: string; readonly action: "add" | "change" | "remove" }[];
  readonly overwrites: number;
}
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
  /** For a change of skill folders: each folder, the repository version it comes from, and the lock entry it changes (masked diff). */
  readonly skills?: readonly CapabilitySkillPlan[];
  readonly source?: { readonly repository: string; readonly ref: string | null; readonly commit: string } | null;
  readonly lock?: { readonly file: string; readonly diff: string } | null;
  /** The switch settings HarnessHub wrote for a skill being deleted: left in place, listed so they are not forgotten. */
  readonly orphans?: readonly { readonly harnessId: string; readonly file: string }[];
  /**
   * For a check blocked only until the user says so: the option that asks for the same check again with that said (another
   * tool may rewrite the file, a fallback would stop, an edit made inside the block would be lost), and its button's words.
   */
  readonly proceed?: { readonly option: InstructionCheckOption; readonly label: string } | null;
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
  /** The skill folders it added, replaced, removed or put back: their tree ids before and after (null: no folder). */
  readonly skills?: readonly { readonly name: string; readonly folder: string; readonly before: string | null; readonly after: string | null }[];
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
  readonly kind: "skill-switch" | "shared-dir" | "skill-link" | "mcp" | "instructions" | "subagent";
  readonly harnessId: string;
  /** A skill's name, the shared directory, an MCP server's name, the instructions block, or a subagent's name. */
  readonly subject: string;
  /** The file or link, with ~. */
  readonly file: string;
  readonly state: CapabilityDriftState;
  /** HarnessHub's change that wrote it, and when. */
  readonly changeId: string;
  readonly at: string;
}
/**
 * A switch setting HarnessHub wrote for a skill the Harness no longer has (deleted, usually): it does nothing now and
 * takes effect again if a skill of that name comes back. Cleared through the usual switch check.
 */
export interface CapabilityOrphan { readonly id: string; readonly harnessId: string; readonly subject: string; readonly file: string }
/**
 * HarnessHub's changes and backups, newest first, what it wrote that is no longer in place, its orphaned switch settings,
 * and the snapshots of skill folders it keeps to undo with: those the newest `keep` changes name.
 */
export interface CapabilityHistory {
  readonly changes: readonly CapabilityChangeView[];
  readonly backups: readonly CapabilityBackupView[];
  readonly drift: readonly CapabilityDrift[];
  readonly orphans: readonly CapabilityOrphan[];
  readonly snapshots: { readonly count: number; readonly bytes: number; readonly keep: number };
}
export const MAX_BACKUPS_PER_FILE = 10;
export const CAPABILITY_CHECK_MS = 15 * 60 * 1000;
/** Skill snapshots are kept for the newest this many changes; an older change of skill folders cannot be undone. */
export const SKILL_SNAPSHOT_CHANGES = 50;

/**
 * The skills of one GitHub repository version, read to add some of them (ADR-045 §4): `id` names the downloaded archive
 * for a check, until `expiresAt`. Each skill is new, already installed from this source (update it instead), in conflict
 * with a different folder of the same name, or refused (with the reason).
 */
export interface SkillSourceListing {
  readonly id: string;
  readonly repository: string;
  readonly ref: string | null;
  readonly commit: string;
  readonly skills: readonly { readonly name: string; readonly installName: string | null; readonly description: string | null; readonly folder: string; readonly files: number; readonly bytes: number;
    readonly executables: number; readonly plugin: boolean; readonly state: "new" | "installed" | "conflict" | "refused"; readonly reason: string | null }[];
  readonly expiresAt: string;
}
/**
 * Whether the skills with a known source have a newer version upstream, and whether their folder still holds what was
 * installed. `manager`: HarnessHub installed it, or `npx skills` (its lock). `state`: up to date, a newer version
 * exists, its folder is no longer in the repository, it could not be checked (`reason`), or its source is not one
 * HarnessHub updates. `modified`: the folder differs from what was installed; null when that is not known.
 */
export interface SkillUpdateView {
  readonly checkedAt: string;
  readonly skills: readonly { readonly name: string; readonly manager: "harnesshub" | "skills-cli"; readonly repository: string | null;
    readonly state: "current" | "available" | "gone" | "unknown" | "unsupported"; readonly modified: boolean | null; readonly reason: string | null }[];
}

/**
 * One MCP server as HarnessHub's list keeps it (ADR-045 §5, approval of step 3): no value that looks like a credential,
 * only the names of the user's variables; plain settings may be literal. Paths are shown with ~.
 */
export interface McpDefinitionView {
  readonly transport: "stdio" | "http" | "sse";
  readonly command: string | null;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly url: string | null;
  readonly env: readonly ({ readonly key: string; readonly variable: string } | { readonly key: string; readonly value: string })[];
  readonly headers: readonly ({ readonly name: string; readonly variable: string; readonly prefix: string } | { readonly name: string; readonly value: string })[];
}
/**
 * Where a listed server stands in one Harness, comparing the list, HarnessHub's ledger and the file: written by HarnessHub
 * and the same (`synced`); the same but not recorded as HarnessHub's (`claimable`); HarnessHub's but older than the list
 * (`outdated`); someone else's with another definition (`different`, never overwritten); HarnessHub's but changed
 * (`changed`) or removed (`removed`) by someone else since; not there (`absent`); or not writable there (`unsupported`).
 */
export const MCP_TARGET_STATES = ["synced", "claimable", "outdated", "different", "changed", "removed", "absent", "unsupported"] as const;
export interface McpTargetView { readonly harnessId: string; readonly state: typeof MCP_TARGET_STATES[number]; readonly reason: string | null; readonly file: string | null }
export interface McpServerView {
  readonly name: string;
  readonly definition: McpDefinitionView;
  /** The command line it runs (credentials masked), or null for a remote server. */
  readonly command: string | null;
  /** The user's variables it needs, and whether each is set in the environment HarnessHub runs the Harnesses with. */
  readonly variables: readonly { readonly name: string; readonly set: boolean }[];
  readonly targets: readonly McpTargetView[];
  readonly updatedAt: string;
}
/**
 * A server found in a Harness's file, offered for the list: its definition, or why it cannot be listed (a credential
 * written literally, say); where it was found; and how it compares with a listed server of the same name.
 */
export interface McpCandidateView {
  readonly id: string;
  readonly name: string;
  readonly definition: McpDefinitionView | null;
  readonly problem: string | null;
  readonly foundIn: readonly { readonly harnessId: string; readonly file: string }[];
  readonly state: "new" | "listed" | "different";
}
/** HarnessHub's MCP list, the servers the Harnesses already have, and which Harnesses it can write and why not. */
export interface McpInventoryView {
  readonly servers: readonly McpServerView[];
  readonly candidates: readonly McpCandidateView[];
  readonly harnesses: readonly { readonly harnessId: string; readonly name: string; readonly writable: boolean; readonly reason: string | null }[];
}

/** The source shown for a skill HarnessHub wrote from the user's text (ADR-045 step 5), where a repository's address is shown otherwise. */
export const LOCAL_SKILL_SOURCE = "HarnessHub 新建";
/** A skill's texts as HarnessHub writes them into its SKILL.md: the one-paragraph description and the body. */
export interface SkillTextView { readonly description: string; readonly body: string }
/** What the user may say to a blocked instructions check: write although cc-switch may rewrite the file, create OpenCode's own file, overwrite an edited block. */
export const INSTRUCTION_CHECK_OPTIONS = ["acknowledge-cc-switch", "create-own", "overwrite"] as const;
export type InstructionCheckOption = typeof INSTRUCTION_CHECK_OPTIONS[number];
/**
 * Where HarnessHub's instructions stand in one Harness, comparing the texts, the ledger and the block in the file the
 * Harness reads: written and the same (`synced`); HarnessHub's but older than the texts (`outdated`); edited inside the
 * block or written by another record (`changed`, the user's from then on); recorded but gone from the file (`removed`);
 * not there (`absent`); the same block without a record (`claimable`); HarnessHub's block in a file the Harness no longer
 * reads (`shadowed`); read through another Harness's file (`elsewhere`, OpenCode's fallback to Claude Code's); a file or
 * markers HarnessHub cannot use (`unreadable`); or no file HarnessHub can write (`unsupported`).
 */
export const INSTRUCTION_TARGET_STATES = ["synced", "outdated", "changed", "removed", "absent", "claimable", "shadowed", "elsewhere", "unreadable", "unsupported"] as const;
export type InstructionTargetState = typeof INSTRUCTION_TARGET_STATES[number];
export interface InstructionTargetView {
  readonly harnessId: string;
  readonly name: string;
  /** The file HarnessHub writes for this Harness (or holds its block), with ~; null when it has none. */
  readonly file: string | null;
  readonly state: InstructionTargetState;
  /** Why it is in this state, or why it cannot be written. */
  readonly reason: string | null;
  /** When the Harness reads a change, by its installed version's checked behavior. */
  readonly effect: string | null;
  /** What a write will ask about first: another tool that may rewrite the file, a fallback the new file would stop. */
  readonly cautions: readonly string[];
}
/**
 * HarnessHub's instructions (ADR-045 §6, step 4): one shared text and each Harness's addition, written as a marked block
 * into the user-level instructions file each Harness reads; the rest of those files is never changed. `limitBytes` is the
 * most each text may hold.
 */
export interface InstructionsView {
  readonly shared: { readonly text: string; readonly updatedAt: string | null };
  readonly additions: readonly { readonly harnessId: string; readonly text: string; readonly updatedAt: string }[];
  readonly targets: readonly InstructionTargetView[];
  readonly limitBytes: number;
}

/**
 * A subagent as HarnessHub's list keeps it (ADR-045 §7, step 5): its description and its prompt (the system prompt), the
 * only things every Harness keeps alike. It works with its parent session's model, tools and permissions.
 */
export interface SubagentDefinitionView { readonly description: string; readonly prompt: string }
/**
 * Where a listed subagent stands in one Harness, comparing the list, the ledger and the files of that Harness's directory:
 * the states of the MCP list (`different`: another definition of this name is there, by that Harness's naming, and is never
 * overwritten).
 */
export interface SubagentTargetView { readonly harnessId: string; readonly state: typeof MCP_TARGET_STATES[number]; readonly reason: string | null; readonly file: string | null }
export interface SubagentView { readonly name: string; readonly definition: SubagentDefinitionView; readonly targets: readonly SubagentTargetView[]; readonly updatedAt: string }
/** HarnessHub's subagent list, and which Harnesses it can write and why not. */
export interface SubagentInventoryView {
  readonly subagents: readonly SubagentView[];
  readonly harnesses: readonly { readonly harnessId: string; readonly name: string; readonly writable: boolean; readonly reason: string | null }[];
}

