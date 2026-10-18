/** Path as written after `a/` and `b/` in a diff header: absolute paths lose their leading separators, as git prints them. */
export function diffPath(path: string): string { return path.replace(/^[\\/]+/u, "") || path; }

/** Marks a last line without a newline, as git prints it; part of that line, so it also tells it apart from a terminated one. */
const NO_NEWLINE = "\n\\ No newline at end of file";
/** A text's lines: a final newline ends the last line rather than starting an empty one. */
function textLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop(); else lines[lines.length - 1] += NO_NEWLINE;
  return lines;
}

/**
 * One-hunk unified diff from full old/new texts: common leading and trailing lines are trimmed and kept as
 * three lines of context. Linear in input size; exact for display, not a minimal edit script. A last line without a
 * newline is followed by git's "\ No newline at end of file", so a change of the final newline alone is shown too.
 */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const oldLines = textLines(before), newLines = textLines(after);
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
