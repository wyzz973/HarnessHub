/** Path as written after `a/` and `b/` in a diff header: absolute paths lose their leading separators, as git prints them. */
export function diffPath(path: string): string { return path.replace(/^[\\/]+/u, "") || path; }

/**
 * One-hunk unified diff from full old/new texts: common leading and trailing lines are trimmed and kept as
 * three lines of context. Linear in input size; exact for display, not a minimal edit script.
 */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const oldLines = before === null || before === "" ? [] : before.split("\n"), newLines = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const header = "--- " + (before === null ? "/dev/null" : "a/" + diffPath(path)) + "\n+++ b/" + diffPath(path) + "\n";
  if (start === oldEnd && start === newEnd) return header;
  const from = Math.max(0, start - context), oldTo = Math.min(oldLines.length, oldEnd + context), newTo = Math.min(newLines.length, newEnd + context);
  const lines = [
    ...oldLines.slice(from, start).map(line => " " + line),
    ...oldLines.slice(start, oldEnd).map(line => "-" + line),
    ...newLines.slice(start, newEnd).map(line => "+" + line),
    ...oldLines.slice(oldEnd, oldTo).map(line => " " + line),
  ];
  const oldCount = oldTo - from, newCount = newTo - from;
  return header + "@@ -" + (oldCount ? from + 1 : from) + "," + oldCount + " +" + (newCount ? from + 1 : from) + "," + newCount + " @@\n" + lines.join("\n") + "\n";
}
