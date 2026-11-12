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
