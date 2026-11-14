import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SessionError } from "../../contracts/session.js";

/*
 * Where a path a page names lies in a conversation's workspace (2026-11-14): what the Finder, the editors, the file reader and Git are handed. Every path is taken to its
 * real path first and must then be the workspace or inside it, so that neither `..` nor a link leads out. Shared by finder.ts, editors.ts, workspace-file.ts and git.ts.
 */

/** Whether `path` is `root` or inside it; both are real paths. */
export function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest));
}
/** Whether a failure of the file system says the path is not there. */
export const missing = (error: unknown): boolean => { const code = (error as { readonly code?: unknown } | null)?.code; return code === "ENOENT" || code === "ENOTDIR"; };

/** The workspace's real path; WORKSPACE_NOT_FOUND when its folder is gone. */
export async function workspaceRoot(workspace: string): Promise<string> {
  try { return await realpath(workspace); }
  catch (error) { if (missing(error)) throw new SessionError("WORKSPACE_NOT_FOUND", "这个对话的工作区文件夹已不在"); throw error; }
}

/**
 * The real path of `path` (relative to the workspace, or absolute) and the real path of the workspace it must be in. INVALID_INPUT when it leads out of the workspace
 * (by `..`, by an absolute path elsewhere, or by a link); FILE_NOT_FOUND when it names a place in the workspace that is not there. `what` words the refusal.
 */
export async function placeInWorkspace(workspace: string, path: string, what = "只能用这个对话工作区里的文件"): Promise<{ readonly root: string; readonly target: string }> {
  const root = await workspaceRoot(workspace), named = resolve(workspace, path);
  let target: string;
  try { target = await realpath(named); }
  catch (error) {
    if (!missing(error)) throw error;
    // A path that is not there is told as such only when it names a place in the workspace; one that leads out is refused as one.
    if (!inside(resolve(workspace), named) && !inside(root, named)) throw new SessionError("INVALID_INPUT", what);
    throw new SessionError("FILE_NOT_FOUND", "这个文件已不在");
  }
  if (!inside(root, target)) throw new SessionError("INVALID_INPUT", what);
  return { root, target };
}

/**
 * Where `path` is in the workspace as a path relative to its real root, whether or not it is there now (a file deleted in the working tree is still named to Git): the
 * nearest part of it that is there is taken to its real path, and that and the rest must stay in the workspace. INVALID_INPUT otherwise.
 */
export async function workspacePath(root: string, workspace: string, path: string, what = "只能用这个对话工作区里的文件"): Promise<string> {
  const named = resolve(workspace, path);
  if (!inside(resolve(workspace), named) && !inside(root, named)) throw new SessionError("INVALID_INPUT", what);
  let probe = named, rest = "";
  for (;;) {
    try {
      const real = await realpath(probe), placed = rest === "" ? real : join(real, rest);
      if (!inside(root, real) || !inside(root, placed)) throw new SessionError("INVALID_INPUT", what);
      return relative(root, placed).split(sep).join("/");
    } catch (error) {
      if (error instanceof SessionError || !missing(error)) throw error;
      const up = dirname(probe);
      if (up === probe) throw new SessionError("INVALID_INPUT", what);
      rest = rest === "" ? relative(up, probe) : join(relative(up, probe), rest); probe = up;
    }
  }
}
