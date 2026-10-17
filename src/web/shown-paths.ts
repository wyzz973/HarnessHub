/**
 * The strings in `value` that name a path in the user's home directory by its absolute form (ADR-044). Confirmations may
 * show the program paths an uninstall removes, written with ~; an absolute home path anywhere else is a leak. Bounded:
 * at most 4096 strings are inspected, and a deeper or larger value counts as leaking.
 */
export function homePathsIn(value: unknown, homes: readonly string[]): readonly string[] {
  const found: string[] = [], pending: unknown[] = [value]; let seen = 0;
  const leaks = (text: string) => homes.some(home => home.length > 1 && (text.includes(home + "/") || new RegExp("(^|[\\s\"'=(])" + home.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "(?=$|[\\s\"')])", "u").test(text)));
  while (pending.length) {
    const item = pending.pop();
    if (++seen > 4096) return ["(too large to inspect)"];
    if (typeof item === "string") { if (leaks(item)) found.push(item); }
    else if (Array.isArray(item)) pending.push(...item);
    else if (item !== null && typeof item === "object") pending.push(...Object.keys(item), ...Object.values(item));
  }
  return found;
}
