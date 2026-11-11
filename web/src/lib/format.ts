/** Whole seconds under a minute, then minutes and seconds; one decimal below ten seconds. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return seconds.toFixed(1) + " 秒";
  if (seconds < 60) return Math.round(seconds) + " 秒";
  return Math.floor(seconds / 60) + " 分 " + Math.round(seconds % 60) + " 秒";
}
/**
 * Time spent on running work, updated every second (Motion board #03): "42 秒", then "1 分 05 秒", then "1 小时 02 分".
 * Whole seconds only, so the text changes once a second; show it with tabular figures (the page default) so it never jitters.
 */
export function elapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (hours > 0) return hours + " 小时 " + String(minutes).padStart(2, "0") + " 分";
  return minutes > 0 ? minutes + " 分 " + String(seconds).padStart(2, "0") + " 秒" : seconds + " 秒";
}
/** Elapsed time as a clock (m:ss or h:mm:ss), for a running Turn in a list. */
export function clock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  return (hours ? hours + ":" + String(minutes).padStart(2, "0") : String(minutes)) + ":" + String(seconds).padStart(2, "0");
}
/**
 * The time a finished Turn took, in the words of the timer that counted it while it ran (Motion board #03): one decimal
 * under ten seconds ("3.6 秒"), then whole seconds as the timer last showed them ("42 秒", "1 分 05 秒"). Both are cut,
 * never rounded up, so the total never reads more than the timer could have shown.
 */
export function spentText(milliseconds: number): string {
  return milliseconds < 10_000 ? (Math.floor(Math.max(0, milliseconds) / 100) / 10).toFixed(1) + " 秒" : elapsed(milliseconds);
}
export function bytes(value: number): string { return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(1) + " MB" : value >= 1024 ? Math.ceil(value / 1024) + " KB" : value + " B"; }
export function compact(value: number): string { return value >= 1_000_000 ? (value / 1_000_000).toFixed(1) + "M" : value >= 1000 ? (value / 1000).toFixed(1) + "k" : String(value); }
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
