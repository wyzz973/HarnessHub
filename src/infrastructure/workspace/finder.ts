import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { SessionError } from "../../contracts/session.js";

/*
 * Shows a conversation's workspace, or a file in it, in the Finder of the Mac the Gateway runs on (2026-11-14): the page's "在访达中显示". The Gateway runs beside
 * the browser on the user's own Mac, so the window that opens is theirs. Only a place inside the workspace is shown: a path is taken to its real path first, so that
 * neither `..` nor a link leads out of it.
 */

/** Whether `path` is `root` or inside it; both are real paths. */
function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest));
}
const missing = (error: unknown): boolean => { const code = (error as { readonly code?: unknown } | null)?.code; return code === "ENOENT" || code === "ENOTDIR"; };

/**
 * Opens `workspace` in the Finder (`open <workspace>`), or, given `path` (relative to the workspace, or absolute), selects that file in its folder (`open -R <file>`).
 * Refuses a path whose real path is not in the workspace (INVALID_INPUT), a file or workspace that is not there (…_NOT_FOUND), and anything but macOS (REVEAL_UNSUPPORTED).
 * Resolves once `open` has handed the request to the Finder.
 */
export async function revealInFinder(workspace: string, path?: string): Promise<void> {
  if (process.platform !== "darwin") throw new SessionError("REVEAL_UNSUPPORTED", "在访达中显示只在 macOS 上可用");
  let root: string;
  try { root = await realpath(workspace); }
  catch (error) { if (missing(error)) throw new SessionError("WORKSPACE_NOT_FOUND", "这个对话的工作区文件夹已不在"); throw error; }
  let target = root;
  if (path !== undefined) {
    const named = resolve(workspace, path);
    try { target = await realpath(named); }
    catch (error) {
      if (!missing(error)) throw error;
      // A path that is not there is told as such only when it names a place in the workspace; one that leads out is refused as one.
      if (!inside(resolve(workspace), named) && !inside(root, named)) throw new SessionError("INVALID_INPUT", "只能显示这个对话工作区里的文件");
      throw new SessionError("FILE_NOT_FOUND", "这个文件已不在");
    }
    if (!inside(root, target)) throw new SessionError("INVALID_INPUT", "只能显示这个对话工作区里的文件");
  }
  const args = path === undefined || target === root ? [root] : ["-R", target];
  await new Promise<void>((done, fail) => {
    execFile("/usr/bin/open", args, { timeout: 10_000, maxBuffer: 64 * 1024 }, error => {
      if (error === null) { done(); return; }
      fail(new SessionError("REVEAL_FAILED", "访达没能打开它：" + (error.message.split("\n", 1)[0] ?? "").slice(0, 200)));
    });
  });
}
