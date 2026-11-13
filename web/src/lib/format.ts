export { compact, elapsed, spentText } from "../../../src/contracts/protocol-lines.js";
/** Whole seconds under a minute, then minutes and seconds; one decimal below ten seconds. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return seconds.toFixed(1) + " 秒";
  if (seconds < 60) return Math.round(seconds) + " 秒";
  return Math.floor(seconds / 60) + " 分 " + Math.round(seconds % 60) + " 秒";
}
/** Elapsed time as a clock (m:ss or h:mm:ss), for a running Turn in a list. */
export function clock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  return (hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes)) + ":" + String(seconds).padStart(2, "0");
}
export function bytes(value: number): string { return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B"; }
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60000);
  return minutes < 1 ? "刚刚" : minutes < 60 ? minutes + " 分钟前" : minutes < 1440 ? Math.round(minutes / 60) + " 小时前" : Math.round(minutes / 1440) + " 天前";
}
/** Another conversation's title, short enough to name it within a sentence. */
export function shortTitle(title: string | null | undefined): string {
  if (!title) return "另一个对话";
  const characters = [...title];
  return characters.length > 30 ? characters.slice(0, 30).join("") + "…" : title;
}
/** The last path segment of a workspace, for compact display; the full path stays in the title attribute. */
export function folderName(path: string): string { return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path; }
/** Whether a conversation's workspace is one the Gateway made for it (it was started without a folder). */
export function inScratch(workspace: string, scratchRoot: string | undefined): boolean {
  return scratchRoot !== undefined && scratchRoot !== "" && workspace.startsWith(scratchRoot.replace(/\/+$/u, "") + "/");
}
/** The path with the home directory shortened when it is recognizably a user's home. */
export function homePath(path: string): string { return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/u, "~"); }
/**
 * A file path as the conversation's workspace sees it: relative inside the workspace, otherwise absolute with the home
 * shortened. Diff headers often drop an absolute path's leading slash ("b/private/tmp/…"); such a path is restored first.
 */
export function workspacePath(path: string, workspace: string): string {
  const absolute = path.startsWith("/") ? path : /^(?:private|Users|home|tmp|var|opt|Volumes)\//u.test(path) ? "/" + path : path;
  const root = workspace.replace(/\/+$/u, ""), alias = root.startsWith("/private/") ? root.slice("/private".length) : "/private" + root;
  for (const base of [root, alias]) if (base && absolute.startsWith(base + "/")) return absolute.slice(base.length + 1);
  return absolute.startsWith("/") ? homePath(absolute) : absolute;
}
