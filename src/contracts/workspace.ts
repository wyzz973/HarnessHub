import type { FileChange } from "./protocol.js";

/**
 * What a Turn changed in its workspace, as the Hub saw it itself (docs/decisions/LOG.md, 2026-11-12): the files are compared at the Turn's
 * start and at its end, whatever the Harness reported. `diff` is the unified diff of the text files (null when the workspace is not a git
 * repository, which is compared by modification time and size, or when nothing text-like changed). `shared`: another conversation's Turn
 * ran in the same workspace for part of that time, so the changes may include its own.
 */
export interface WorkspaceRecord {
  readonly mode: "git" | "files";
  readonly changes: readonly FileChange[];
  readonly diff: string | null;
  readonly shared: boolean;
}
/** One Turn's watch of its workspace, begun when the Turn starts. `finish` never rejects; null when nothing could be compared. */
export interface WorkspaceWatch { finish(): Promise<WorkspaceRecord | null> }
/** The Runtime's port: watches a workspace for one Turn. */
export interface WorkspaceChanges { begin(workspace: string): WorkspaceWatch }

/**
 * A Turn's checkpoints (2026-11-14): its workspace, when it is in a Git repository, as it was before the Turn started and as it was once it ended, each kept as a commit
 * that only the Hub's own refs name (`refs/harnesshub/checkpoints/<sessionId>/<ordinal>/before|after`); the user's index, HEAD and branches are never touched. `capture`
 * never rejects and settles within five seconds (a capture not done by then is given up for that Turn); a workspace in no repository is left alone. `forget` takes every
 * ref of a conversation away when the conversation is erased; it never rejects either.
 */
export interface WorkspaceCheckpoints {
  capture(workspace: string, sessionId: string, ordinal: number, side: "before" | "after"): Promise<void>;
  forget(workspace: string, sessionId: string): Promise<void>;
}
/**
 * Whether a conversation works in a Git worktree of its own that no other conversation works in (2026-11-14): only there are its files put back as they were before a
 * Turn, since that rewrites the whole working tree.
 */
export interface WorkspaceOwnership { ownWorktree(sessionId: string): Promise<boolean> }
