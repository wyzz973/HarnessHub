import type { ProviderView } from "./provider.js";
import type { DeferredWork, TextRange } from "./conversation.js";
import type { PlanStep, ProtocolItem, ProtocolTurn } from "./protocol.js";
import type { HarnessManagementView, InstallationJobView, InstallationLog } from "./management.js";
import type { HarnessSelection, PublicMessage, PublicRun, PublicSwitch, RunId, SelectionRequest, SessionEvent, SessionOrigin, SessionSnapshot } from "./session.js";
import type { DeliveryEvidence, DeliveryStatus, EvidenceClass, RelayAttention, RelayDecision, RelayInstallationNotice, RelayPacketId, RelayPacketKind, RelayPrefKey, RunRelay, Tier } from "./relay.js";

/**
 * A conversation's title as summaries and the sidebar give it, the same in the Gateway and the page: its first message,
 * else where it came from ("接续 · …" for a continued native session, "分支 · …" for a branch), else "新对话"; spaces
 * folded, at most 80 characters. The page names a conversation it opens itself this way, with no state read to correct it.
 */
export function conversationTitle(conversation: { readonly messages: readonly { readonly role: string; readonly text: string }[]; readonly origin?: SessionOrigin | undefined }): string {
  const first = titleWords(conversation.messages.find(message => message.role === "user")?.text);
  const origin = conversation.origin, quoted = origin?.history.find(message => message.role === "user")?.text.replace(/\s+/gu, " ").trim();
  const inherited = origin?.kind === "import" ? "接续 · " + (origin.title ?? quoted ?? origin.harnessId) : quoted ? "分支 · " + quoted : null;
  return first ? cutTitle(first) : inherited ? cutTitle(inherited) : "新对话";
}
/**
 * The words a title is made of (2026-11-14): the message's first line when it says enough to name the conversation — a sentence of its own above a list or pasted
 * material, without the colon that led to them — else the whole message, spaces folded. A title is a name, and the user may give another (`SessionChange`).
 */
function titleWords(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const folded = text.replace(/\s+/gu, " ").trim();
  const line = text.split(/\r?\n/u).map(part => part.replace(/\s+/gu, " ").trim()).find(part => part !== "")?.replace(/[：:，,、；;]+$/u, "").trim();
  return line !== undefined && line !== folded && [...line].length >= 6 ? line : folded;
}
/**
 * At most 80 UTF-16 units, never ending in half a character, and with no half character anywhere: a title is stored in a UTF-8 column that keeps U+FFFD in place of half a pair,
 * so a title that held one would not read back as it was written.
 */
export function cutTitle(text: string): string {
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
  /**
   * When the conversation last moved on (milliseconds since the epoch): what the list is ordered by, newest first. A commit that only names or marks it (a rename, the
   * archive mark, a pin, a reminder, a name its Harness gave, a deletion and its undoing) does not move it; `updatedSeq` still grows with that commit.
   */
  readonly updatedAt: number;
  readonly activeRunId: string | null;
  /** When the Turn in progress (`activeRunId`) was accepted, in milliseconds since the epoch; absent when none is in progress. */
  readonly activeSince?: number;
  /** The conversation that delegated this one its work (2026-11-13), and the Turn of it the work was handed after (null: before any finished Turn). */
  readonly parent?: DelegationParent;
  /**
   * One sentence of how it stands, for the list's second line: while a Turn goes on, the step in progress of that Turn's task list; once it has ended, the first
   * sentence of its wrap-up. Absent when the Turn gave neither.
   */
  readonly line?: string;
  /** The user archived it (2026-11-14). The list still carries it; it opens and takes messages as any other, and a new Turn accepted in it takes the mark off. */
  readonly archived?: true;
  /** The user pinned it to the top of the list (2026-11-14); a new Turn does not take the pin off. */
  readonly pinned?: true;
  /**
   * Its place among the pinned (2026-11-14): the pinned are listed lowest first; any finite number (the page sets it on a drag, e.g. between its neighbours'). Only
   * with `pinned`. One pinned before the order was kept has none: the page puts those after the ones that have one.
   */
  readonly pinnedOrder?: number;
  /**
   * The user asked to be reminded of it later (2026-11-14): until this moment (milliseconds since the epoch) the list puts it aside. Whether the moment came is the
   * page's to tell; the Gateway only keeps it. A new Turn accepted in it takes it off.
   */
  readonly snoozedUntil?: number;
  /**
   * The Git worktree the conversation works in (2026-11-14, started with `worktree: true`): `root` is the repository's main checkout, under which the page groups it;
   * `path` the worktree, `branch` its branch as last recorded (`GET …/worktree` reads it live), `baseSha` the commit it started from. Absent for a conversation that
   * works in its folder as it is.
   */
  readonly worktree?: WorktreeMark;
}
/** A conversation's own Git worktree as its head and its row of the list carry it (`ConversationWorktree`). */
export interface WorktreeMark { readonly root: string; readonly path: string; readonly branch: string; readonly baseSha: string }
/**
 * `GET /api/v1/sessions/:id/worktree` (2026-11-14): the conversation's worktree as it is now, also for a conversation the user deleted (the page asks before erasing
 * it). `branch` is the branch checked out there (null on a detached head), `dirty` how many files are not committed (untracked ones included, one by one), `shared`
 * whether another conversation that is not erased works in it (a delegated one, a branch of it); `missing` when its folder is no longer there. 404 when the
 * conversation has no worktree.
 */
export interface WorktreeView { readonly path: string; readonly branch: string | null; readonly dirty: number; readonly shared: boolean; readonly missing?: true }
/**
 * `POST /api/v1/sessions/:id/purge` with `{ removeWorktree: true }` (2026-11-14): after the conversation is erased, its worktree is removed (`git worktree remove
 * --force`, then `git worktree prune`; the branch stays) unless another conversation that is not erased works in it. `worktreeRemoved`: the worktree is no longer
 * there; `worktreeKept`: it was left, `shared` (another conversation works in it) or `failed` (Git refused; `worktreeError` has its words). Without the flag the
 * answer is 204 and the worktree is left alone.
 */
export interface PurgeSessionView { readonly worktreeRemoved?: true; readonly worktreeKept?: "shared" | "failed"; readonly worktreeError?: string }
/**
 * `PATCH /api/v1/sessions/:id`: the user renames the conversation, archives it, pins it or puts it aside until a moment (at least one of these). A title is trimmed and
 * its line breaks made spaces; an empty one is refused. `snoozedUntil` is milliseconds since the epoch, null to take the reminder off. The answer is the conversation's
 * `SessionSummary` after the change, which also reaches every page that has it open as a commit (its head). None of these moves `updatedAt`.
 * `pinnedOrder` (finite) places a pinned conversation among the pinned, or the one this change pins; `pinned: true` without it puts it first (an order lower than
 * every other pinned one) and leaves one already pinned where it is; `pinned: false` drops the order and takes no `pinnedOrder` (400). An order for a conversation
 * that is not pinned and that this change does not pin is refused, 409 PIN_REQUIRED (the page's list was out of date: it reads the row again).
 */
export interface SessionChange { readonly title?: string; readonly archived?: boolean; readonly pinned?: boolean; readonly pinnedOrder?: number; readonly snoozedUntil?: number | null }
/**
 * `GET /api/v1/sessions/:id/workspace`: the conversation's workspace and, when it is a Git repository or inside one, where that stands: the current branch (null on a
 * detached head) and how many entries `git status --porcelain` lists (changed, staged and untracked files). Read-only; a Git that fails or is slow leaves `git` out.
 */
export interface WorkspaceView { readonly path: string; readonly git?: { readonly branch: string | null; readonly dirty: number } }
/** `GET /api/v1/editors` (2026-11-14): an editor installed on this Mac (its application bundle is in /Applications or ~/Applications), as `POST …/open` names it. */
export interface EditorView { readonly id: string; readonly name: string }
export interface EditorsView { readonly editors: readonly EditorView[] }
/**
 * `GET /api/v1/sessions/:id/file?path=&offset=` (2026-11-14): one page of a file of the workspace (at most 256 KiB, cut between UTF-8 characters), from byte `offset`;
 * `next` is where the next page starts, null at the end. `path` is the file's from the workspace. A file with a NUL in its first 8 KiB is told as binary and not read.
 */
export type WorkspaceFileView =
  | { readonly path: string; readonly size: number; readonly offset: number; readonly text: string; readonly next: number | null; readonly binary?: undefined }
  | { readonly path: string; readonly size: number; readonly binary: true };
/**
 * One changed, staged or untracked file of `GitView`, named from the workspace: its index and worktree state as `git status --porcelain=v2` gives them (a letter of
 * M A D R C T U, "." for unchanged; "?" and "?" for an untracked file), the path it was renamed or copied from, and its lines added and removed against HEAD (absent for an
 * untracked or a binary file).
 */
export interface GitFileView { readonly path: string; readonly from?: string; readonly index: string; readonly worktree: string; readonly added?: number; readonly removed?: number }
/**
 * `GET /api/v1/sessions/:id/git` (2026-11-14): the branch (null on a detached head), its upstream and how far ahead and behind it is, whether the repository has any
 * remote, and the changed files. 404 NOT_A_REPOSITORY when the workspace is in no Git repository.
 */
export interface GitView {
  readonly branch: string | null;
  readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number };
  readonly remote: boolean;
  readonly files: readonly GitFileView[];
}
/** `POST /api/v1/sessions/:id/git/commit`, body `{ message, paths? }` (2026-11-14): the commit made, by its short hash and subject. */
export interface GitCommitView { readonly commit: string; readonly subject: string }
/** `POST /api/v1/sessions/:id/git/push` (2026-11-14): where the current branch was pushed. */
export interface GitPushView { readonly remote: string; readonly branch: string }
/**
 * What the changes panel compares (2026-11-14), as T3 Code's does: `uncommitted` the working tree (staged and not, untracked files too) against HEAD; `commit` one commit
 * against its first parent; `branch` the working tree as it is against merge-base(`base`, HEAD), `base` being by default the branch origin/HEAD points to, else main, else
 * master. In the query: `scope=uncommitted`, `scope=commit&sha=<sha>`, `scope=branch[&base=<ref>]`. `turn` (`scope=turn&ordinal=<n>`) one Turn's checkpoints: GitTurnScope.
 */
export type GitScope = { readonly kind: "uncommitted" } | { readonly kind: "commit"; readonly sha: string } | { readonly kind: "branch"; readonly base?: string } | GitTurnScope;
export const GIT_CHANGE_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "typechange", "untracked"] as const;
export type GitChangeStatus = typeof GIT_CHANGE_STATUSES[number];
/**
 * One file changed in a scope, named from the workspace: how it changed, the path it was renamed or copied from, its lines added and removed (an untracked file's all
 * added; none for a binary file, which is marked `binary`).
 */
export interface GitChangedFileView { readonly path: string; readonly oldPath?: string; readonly status: GitChangeStatus; readonly added?: number; readonly removed?: number; readonly binary?: true }
/**
 * `GET /api/v1/sessions/:id/git/changes?scope=…[&whitespace=ignore]` (2026-11-14): the files changed in the scope, in the order of their paths, without their text.
 * `base` (branch) is the base as named and the merge base's hash; `commit` (commit) is the commit's full hash and its first parent's (null for a root commit).
 */
export interface GitChangesView {
  readonly scope: GitScope["kind"];
  readonly files: readonly GitChangedFileView[];
  readonly base?: { readonly ref: string; readonly sha: string };
  readonly commit?: { readonly sha: string; readonly parent: string | null };
  readonly turn?: GitTurnCompared;
}
/** `GET /api/v1/sessions/:id/git/diff?scope=…&path=…[&whitespace=ignore]` (2026-11-14): one file's unified diff in the scope ("" when it did not change there). */
export interface GitFileDiffView { readonly path: string; readonly diff: string; readonly binary?: true }
/** One commit of `GitLogView`: its full and short hash, subject, author's name and commit time (milliseconds since the epoch). */
export interface GitCommitEntryView { readonly sha: string; readonly shortSha: string; readonly subject: string; readonly author: string; readonly committedAt: number }
/** `GET /api/v1/sessions/:id/git/log?before=<sha>&limit=<n>` (2026-11-14): a page of the current branch's commits, newest first; `next` is the next page's `before`, null at the end. */
export interface GitLogView { readonly commits: readonly GitCommitEntryView[]; readonly next: string | null }
/**
 * `GET /api/v1/sessions/:id/git/branches` (2026-11-14): the local and the remote-tracking branches by name (`main`, `origin/main`), most recently committed first; the current
 * branch (null on a detached head); the default branch a `branch` scope compares with when none is named (null when there is none).
 */
export interface GitBranchesView { readonly current: string | null; readonly local: readonly string[]; readonly remote: readonly string[]; readonly defaultBranch: string | null }

/*
 * A Turn's checkpoints, putting files back, and a pull request (2026-11-14; docs/contracts/public-api.md "检查点、还原文件与拉取请求"). Before a Turn starts and after it
 * ends the Hub keeps its workspace (when it is in a Git repository) as a commit only its own refs name, `refs/harnesshub/checkpoints/<sessionId>/<ordinal>/before|after`.
 */
/** The changes panel's scope of one Turn: `scope=turn&ordinal=<n>` (the Turn's ordinal, from 0). */
export interface GitTurnScope { readonly kind: "turn"; readonly ordinal: number }
/** What a Turn's scope compared: its checkpoint from before it, and the one after it (null: the working tree as it is now, the Turn running or no after kept). */
export interface GitTurnCompared { readonly ordinal: number; readonly before: string; readonly after: string | null }
/** One Turn's checkpoints, by their commits' hashes; a side not kept is absent. */
export interface CheckpointView { readonly ordinal: number; readonly before?: string; readonly after?: string }
/**
 * `GET /api/v1/sessions/:id/checkpoints?before=<ordinal>&limit=<n>`: the Turns with a checkpoint, the latest first; `next` is the next page's `before`, null at the end.
 * `restorable`: files can be put back here (the conversation works in a worktree of its own); none and false in a workspace that is in no repository.
 */
export interface CheckpointListView { readonly checkpoints: readonly CheckpointView[]; readonly next: number | null; readonly restorable: boolean }
/** `POST /api/v1/sessions/:id/checkpoints/:ordinal/restore` `{}`: the commit the files were put back to, and the ref the files as they were just before are kept under. */
export interface CheckpointRestoreView { readonly restoredTo: string; readonly savedAs: string }
/** Whether the user's GitHub CLI is there and signed in. */
export const GH_STATES = ["missing", "signed-out", "ready"] as const;
export type GhState = typeof GH_STATES[number];
/** A pull request as `gh pr view --json url,number,title,state` gives it (`state` OPEN, CLOSED or MERGED). */
export interface GitPullRequestView { readonly url: string; readonly number: number; readonly title: string; readonly state: string }
/**
 * `GET /api/v1/sessions/:id/git/pr`: what a pull request of the current branch would take. `branch` null on a detached head; `defaultBranch` the branch the remote's HEAD
 * names (else main, else master; null when none); `remote` the branch's upstream remote, else origin (its URL without any user or password in it; `github` when its
 * host is GitHub's); `ahead` the commits of the branch not on the default branch; `unpushed` those not on its upstream (without one, those on no remote at all);
 * `existing` the branch's pull request when gh finds one.
 */
export interface GitPullRequestStatusView {
  readonly gh: GhState;
  readonly branch: string | null;
  readonly defaultBranch: string | null;
  readonly remote?: { readonly name: string; readonly url: string; readonly github: boolean };
  readonly upstream?: string;
  readonly ahead: number;
  readonly unpushed: number;
  readonly existing?: GitPullRequestView;
}
/** `POST /api/v1/sessions/:id/git/pr` `{ title, body, base? }`: the pull request gh made (the branch pushed first when it had to be). */
export interface GitPullRequestCreatedView { readonly url: string; readonly number: number }
/** The first sentence of a wrap-up, or the step in progress of a task list, cut to what one line of a list holds. */
export function summaryLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim(), end = /[。！？!?]|\.(?=\s|$)/u.exec(flat);
  const first = end === null || end.index === 0 ? flat : flat.slice(0, end.index), units = [...first];
  return units.length > 80 ? units.slice(0, 80).join("") + "…" : first;
}
export interface DelegationParent { readonly sessionId: string; readonly afterRunId: string | null;
  /** The delegating conversation's Harness asked for it (with the Hub's tool); absent: the user did. */
  readonly by?: "harness" }
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
  /** The conversation that delegated this one its work. */
  readonly parent?: DelegationParent;
  /** What this conversation's Harness was told of the work it delegated: by conversation, the Turn of it whose outcome was told and the Turn of this one it went with. */
  readonly delegationsTold?: import("./session.js").DelegationsTold;
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
  /** Where conversations started without a folder get theirs: a conversation whose workspace is inside it was started that way. */
  readonly scratchRoot?: string;
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
  /** Start without a folder: the Gateway gives the conversation one of its own. Not together with `workspace`. */
  readonly scratch?: true;
  /**
   * Work in a Git worktree of its own (2026-11-14), made from the repository `workspace` is in (required with it; 400 when it is in none): a new branch `hh/<8 hex>`
   * from that checkout's HEAD, at `<worktree root>/<repository folder>/hh-<8 hex>` (the 8 hex are the first of sha256(commandId)); the conversation's workspace is
   * `workspace`'s place in it. A repeat of the request answers the same conversation and makes no second worktree.
   */
  readonly worktree?: true;
  readonly selection: SelectionRequest;
  readonly commandId: string;
}
export interface SwitchWebSession { readonly selection: SelectionRequest; readonly commandId: string }
/** The task a conversation belongs to as the page shows it (2026-11-13): its board, what every Harness working on it goes by. */
/** One conversation of a task as the page lists it (src/web/task-family.ts): who has it, what it was asked, how its latest Turn stands, the files it changed. */
export interface TaskMemberView {
  readonly sessionId: string; readonly label: string;
  /** The label of the conversation that delegated this one its work; null for the one the task began in. */
  readonly parent: string | null; readonly depth: number;
  readonly harnessId: string; readonly harness: string; readonly task: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "unknown" | "empty";
  readonly turns: number; readonly files: readonly string[];
}
/** The task a conversation belongs to: its board, and — when it is read — the conversations working on it, the one it began in first. */
export interface TaskView { readonly board: import("./session.js").TaskBoard; readonly members?: readonly TaskMemberView[] }
/**
 * `POST /api/v1/sessions/:id/steer {text, key}` (2026-11-14): words given to the Turn in progress. `runId` is the Turn they went into and `messageId` their
 * `user_message` item there (`steered`); `outcome` is `taken` (the Harness took them into the turn) or `unknown` (it could not be told: they may have reached
 * it, so the page must not send them again). When they did not go in the answer is 409 with STEER_UNSUPPORTED, STEER_NO_ACTIVE_TURN or STEER_REFUSED, and the
 * page keeps them for after the Turn. Whether the page may offer it: the Harness's catalog `flavor.capabilities.steer === "native"` while a Turn runs.
 */
export interface SteerView { readonly sessionId: string; readonly runId: string; readonly messageId: string; readonly outcome: "taken" | "unknown"; readonly replayed: boolean }
/** `POST /api/v1/sessions/:id/delegate`: a conversation of its own for `selection` to do `text`, starting from this one's history. `messageCommandId` is the task message's own identity. */
export interface DelegateWebSession { readonly selection: SelectionRequest; readonly text: string; readonly commandId: string; readonly messageCommandId: string }
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
  /** Where the Turn stands among the alternatives of its place (its message edited and sent again, its reply tried again): absent when it has none. */
  readonly branch?: { readonly n: number; readonly of: number; readonly prev: string | null; readonly next: string | null };
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
  /** The user archived the conversation (`SessionSummary.archived`). */
  readonly archived?: true;
  /** The user pinned it (`SessionSummary.pinned`). */
  readonly pinned?: true;
  /** Its place among the pinned (`SessionSummary.pinnedOrder`). */
  readonly pinnedOrder?: number;
  /** The user put it aside until then (`SessionSummary.snoozedUntil`). */
  readonly snoozedUntil?: number;
  /** The Git worktree it works in (`SessionSummary.worktree`). */
  readonly worktree?: WorktreeMark;
  /** When the conversation last moved on (`SessionSummary.updatedAt`: a commit that only names or marks it leaves it); this Gateway always sends it. */
  readonly updatedAt?: number;
  /** When the Turn in progress was accepted (`SessionSummary.activeSince`); absent when none is. */
  readonly activeSince?: number;
  /**
   * The conversation's latest switch, whatever its state: the one asked for and not yet effective (`pendingSwitchId` names it), or the one that failed last, which the page
   * says. The page needs these two, not the list of switches (a Turn's `switch` line is read from its Run).
   */
  readonly lastSwitch?: PublicSwitch;
  readonly facts: SessionFacts;
  /** The conversation's latest task list (a Harness's own, or the one it gave with `hub_update_plan`), and the Turn it belongs to; absent when no Turn has one. */
  readonly plan?: SessionPlanView;
  /** The wrap-up of the latest finished Turn (`hub_wrap_up`): what the box above the message box shows; absent when that Turn gave none. */
  readonly recap?: SessionRecapView;
}
export interface SessionPlanView { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly steps: readonly PlanStep[]; readonly explanation?: string }
export interface SessionRecapView { readonly runId: string; readonly ordinal: number; readonly harnessId: string; readonly summary: string; readonly ask?: string; readonly actions?: readonly string[] }
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

// ---- Recently deleted, erasing, and the page's search (2026-11-14) --------------------------------------------------------

/** A row of the recently deleted: the conversation's row of the list, and when the user deleted it (milliseconds since the epoch). */
export interface DeletedSessionSummary extends SessionSummary { readonly deletedAt: number }
/**
 * `GET /api/v1/sessions/deleted?before=<cursor>&limit=`: the conversations the user deleted, the latest deleted first, a page at a time (the page size of the list, and like
 * it no ceiling). `POST /api/v1/sessions/:id/purge` erases one of them (204; 409 DELETION_REQUIRED for one that is not deleted); `POST /api/v1/sessions/purge-deleted` erases
 * them all (`PurgedView`). Nothing is erased by itself after a time.
 */
export interface DeletedSessionListView { readonly sessions: readonly DeletedSessionSummary[]; readonly next: string | null }
/**
 * `POST /api/v1/sessions/purge-deleted`: how many conversations were erased. With `{ removeWorktree: true }` (2026-11-14) also how many of their worktrees were
 * removed (`worktreesRemoved`, those no conversation left works in) and the ones Git refused to remove (`worktreeFailures`, with its words); absent without the flag.
 */
export interface PurgedView { readonly purged: number; readonly worktreesRemoved?: number; readonly worktreeFailures?: readonly { readonly path: string; readonly message: string }[] }
/**
 * One place the words were found by `GET /api/v1/search?q=&cursor=` (across the conversations not deleted): a message of the user, a reply of a Harness, or the title.
 * Matching ignores case and takes the words as they are, a substring (Chinese included). `snippet` is the text around the place, line breaks made spaces, with "…" where it
 * was cut; `match` is where the words are in `snippet`, `[start, end)` in UTF-16 units. A message is one hit, at its first place.
 */
export interface SearchHitView {
  readonly sessionId: string;
  readonly title: string;
  /** The Turn and the message (the `id` of its item in the Turn, `WireItem.id`); null for a hit in the title. */
  readonly runId: string | null;
  readonly ordinal: number | null;
  readonly messageId: string | null;
  readonly role: "user" | "assistant" | "title";
  readonly snippet: string;
  readonly match: readonly [number, number];
}
/** The hits grouped by conversation (the title first, then its messages newest first), the conversations by their latest activity; `next` reads on (null at the end). */
export interface SearchView { readonly hits: readonly SearchHitView[]; readonly next: string | null }
/**
 * One place the words were found by `GET /api/v1/sessions/:id/search?q=&cursor=` (in one conversation's messages): every place, from the first Turn to the newest. `itemSeq`
 * is the item's seq in its Turn and `offset` where the words start in the message's whole text (UTF-16 units): what the page loads the Turn by and goes to.
 */
export interface SessionSearchHitView extends Omit<SearchHitView, "runId" | "ordinal" | "messageId" | "role"> {
  readonly runId: string;
  readonly ordinal: number;
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly itemSeq: number;
  readonly offset: number;
}
export interface SessionSearchView { readonly hits: readonly SessionSearchHitView[]; readonly next: string | null }

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
