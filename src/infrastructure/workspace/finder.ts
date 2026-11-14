import { execFile } from "node:child_process";
import { SessionError } from "../../contracts/session.js";
import { placeInWorkspace, workspaceRoot } from "./place.js";

/*
 * Shows a conversation's workspace, or a file in it, in the Finder of the Mac the Gateway runs on (2026-11-14): the page's "在访达中显示". The Gateway runs beside
 * the browser on the user's own Mac, so the window that opens is theirs. Only a place inside the workspace is shown: a path is taken to its real path first, so that
 * neither `..` nor a link leads out of it (place.ts).
 */

/**
 * Opens `workspace` in the Finder (`open <workspace>`), or, given `path` (relative to the workspace, or absolute), selects that file in its folder (`open -R <file>`).
 * Refuses a path whose real path is not in the workspace (INVALID_INPUT), a file or workspace that is not there (…_NOT_FOUND), and anything but macOS (REVEAL_UNSUPPORTED).
 * Resolves once `open` has handed the request to the Finder.
 */
export async function revealInFinder(workspace: string, path?: string): Promise<void> {
  if (process.platform !== "darwin") throw new SessionError("REVEAL_UNSUPPORTED", "在访达中显示只在 macOS 上可用");
  const { root, target } = path === undefined ? { root: await workspaceRoot(workspace), target: undefined } : await placeInWorkspace(workspace, path, "只能显示这个对话工作区里的文件");
  const args = target === undefined || target === root ? [root] : ["-R", target];
  await new Promise<void>((done, fail) => {
    execFile("/usr/bin/open", args, { timeout: 10_000, maxBuffer: 64 * 1024 }, error => {
      if (error === null) { done(); return; }
      fail(new SessionError("REVEAL_FAILED", "访达没能打开它：" + (error.message.split("\n", 1)[0] ?? "").slice(0, 200)));
    });
  });
}
