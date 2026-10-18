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
