/**
 * The command a Harness ran, without the shell it wrapped it in (docs/proposals/protocol/hub-protocol.html §7): Codex reports
 * `/bin/zsh -lc 'npm test'` for the command `npm test`. The text is read the way a POSIX shell reads quoting and nothing else:
 * single quotes, double quotes with their few escapes, a backslash outside quotes, and words that touch joining into one. Whatever
 * this does not read with certainty — an unbalanced quote, an expansion in double quotes, an operator or a glob outside quotes,
 * more words than a shell and its script — leaves the text exactly as it was: a command is never cut wrong. Pure.
 */

/** A character of an unquoted word that the reader takes literally; anything else outside quotes (an operator, a glob, `$`, `~`, `#`) makes the line not plain words. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./\-\u0080-￿]$/u;
/** In double quotes a backslash only escapes these; any other backslash stays as itself. */
const ESCAPABLE = new Set(['"', "\\", "$", "`", "\n"]);

/** The words of a line as a shell reads its quoting; null when the line is not plain quoted words (see above). */
export function shellWords(text: string): string[] | null {
  const words: string[] = [];
  let word = "", inWord = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === " " || char === "\t" || char === "\n") { if (inWord) { words.push(word); word = ""; inWord = false; } continue; }
    inWord = true;
    if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) return null;
      word += text.slice(at + 1, end); at = end; continue;
    }
    if (char === '"') {
      let closed = false;
      for (at++; at < text.length; at++) {
        const inside = text[at]!;
        if (inside === '"') { closed = true; break; }
        if (inside === "\\") {
          const next = text[at + 1];
          if (next !== undefined && ESCAPABLE.has(next)) { if (next !== "\n") word += next; at++; continue; }
          word += inside; continue;
        }
        // An expansion would make the real command something the text does not say.
        if (inside === "$" || inside === "`") return null;
        word += inside;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\") {
      const next = text[at + 1];
      if (next === undefined) return null;
      if (next !== "\n") word += next;
      at++; continue;
    }
    if (!PLAIN.test(char)) return null;
    word += char;
  }
  if (inWord) words.push(word);
  return words;
}

/** A shell by its program name, with or without the directory it lives in. */
const SHELL = /^(?:\/[A-Za-z0-9_.-]+)*\/?(?:sh|bash|zsh|dash|ksh|fish)$/u;
/** A shell's option cluster, such as `-c`, `-lc` or `-lic`. */
const FLAGS = /^-[A-Za-z]+$/u;

/**
 * `command` is the script when `text` is a shell, its option cluster that ends in the command option (`-c`, `-lc`, `-l -c`) and
 * exactly one word, the script; `raw` is then the text as the Harness wrote it. Any other text is its own command, with no `raw`.
 */
export function unwrapShell(text: string): { readonly command: string; readonly raw?: string } {
  const words = shellWords(text);
  if (words === null || words.length < 3) return { command: text };
  const [program, ...rest] = words, script = rest.pop()!, flags = rest;
  if (program === undefined || !SHELL.test(program) || flags.length === 0 || !flags.every(flag => FLAGS.test(flag)) || !flags.at(-1)!.includes("c")) return { command: text };
  return script.trim() === "" ? { command: text } : { command: script, raw: text };
}
