// SPDX-License-Identifier: MIT
/**
 * The terminal under `hh tui`, without dependencies: keys decoded from
 * raw-mode input, text measured in terminal columns, styles that
 * `NO_COLOR` turns off, and a screen that redraws only the lines that
 * changed. It writes only these escape sequences: cursor position, erase in
 * line and in display, SGR, the alternate screen and cursor visibility.
 */

/** Raw-mode keyboard input: `process.stdin` when it is a terminal. */
export interface TerminalInput {
  readonly isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  setEncoding?(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The display: `process.stdout` when it is a terminal, whose `resize` follows SIGWINCH. */
export interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(text: string): unknown;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

/** One key press, decoded from the bytes a terminal sends for it. */
export type Key =
  | {
      name:
        | "up"
        | "down"
        | "left"
        | "right"
        | "pageup"
        | "pagedown"
        | "enter"
        | "escape"
        | "backspace"
        | "tab"
        | "backtab"
        | "clear"
        | "interrupt";
    }
  | { name: "char"; text: string };

const SEQUENCES: Readonly<Record<string, Key["name"]>> = {
  "[A": "up",
  OA: "up",
  "[B": "down",
  OB: "down",
  "[C": "right",
  OC: "right",
  "[D": "left",
  OD: "left",
  "[5~": "pageup",
  "[6~": "pagedown",
  "[Z": "backtab",
};

const CONTROLS: Readonly<Record<string, Key["name"]>> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\x7f": "backspace",
  "\b": "backspace",
  "\x03": "interrupt",
  "\x15": "clear",
  "\x0e": "down",
  "\x10": "up",
};

/**
 * The keys in one chunk of raw-mode input: a chunk holds several keys when
 * text is pasted or typed quickly. Escape sequences the screen does not use
 * are dropped; a lone escape (or one before another key) is `escape`.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let at = 0;
  while (at < chunk.length) {
    const character = chunk[at]!;
    if (character === "\x1b") {
      const next = chunk[at + 1];
      if (next === "[" || next === "O") {
        // A CSI or SS3 sequence ends at its final byte (0x40 to 0x7e).
        let end = at + 2;
        while (end < chunk.length && next === "[" && !/[@-~]/.test(chunk[end]!))
          end += 1;
        const body = chunk.slice(at + 1, end + 1);
        const name = SEQUENCES[body];
        if (name) keys.push({ name } as Key);
        at = end + 1;
        continue;
      }
      keys.push({ name: "escape" });
      at += 1;
      continue;
    }
    if (character === "\r" && chunk[at + 1] === "\n") at += 1;
    const control = CONTROLS[character];
    if (control) {
      keys.push({ name: control } as Key);
      at += 1;
      continue;
    }
    const codePoint = chunk.codePointAt(at)!;
    const text = String.fromCodePoint(codePoint);
    if (codePoint >= 0x20) keys.push({ name: "char", text });
    at += text.length;
  }
  return keys;
}

const ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/y;

/** Columns a code point takes: 0 for combining marks, 2 for wide East Asian text and emoji. */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  )
    return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** The columns `text` takes on screen; escape sequences take none. */
export function width(text: string): number {
  let total = 0;
  let at = 0;
  while (at < text.length) {
    ESCAPE.lastIndex = at;
    if (ESCAPE.test(text)) {
      at = ESCAPE.lastIndex;
      continue;
    }
    const codePoint = text.codePointAt(at)!;
    total += charWidth(codePoint);
    at += codePoint > 0xffff ? 2 : 1;
  }
  return total;
}

/**
 * `text` cut to `columns`, ending with `…` when cut. Escape sequences are
 * kept, and a cut line that has any ends with a reset, so a style never
 * runs past the line.
 */
export function fit(text: string, columns: number): string {
  if (width(text) <= columns) return text;
  let result = "";
  let used = 0;
  let at = 0;
  while (at < text.length) {
    ESCAPE.lastIndex = at;
    if (ESCAPE.test(text)) {
      result += text.slice(at, ESCAPE.lastIndex);
      at = ESCAPE.lastIndex;
      continue;
    }
    const codePoint = text.codePointAt(at)!;
    const size = charWidth(codePoint);
    if (used + size > columns - 1) break;
    result += String.fromCodePoint(codePoint);
    used += size;
    at += codePoint > 0xffff ? 2 : 1;
  }
  return `${result}${columns > 0 ? "…" : ""}${result.includes("\x1b[") ? "\x1b[0m" : ""}`;
}

/**
 * Plain `text` cut in the middle to `columns`, keeping a quarter from its
 * start and the rest from its end, so a long path keeps its file name.
 */
export function shorten(text: string, columns: number): string {
  if (width(text) <= columns) return text;
  const characters = [...text];
  const head = Math.ceil((columns - 1) / 4);
  const tail = Math.max(0, columns - 1 - head);
  return `${characters.slice(0, head).join("")}…${tail ? characters.slice(-tail).join("") : ""}`;
}

/** `text` followed by spaces up to `columns`. */
export function pad(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - width(text)));
}

/** The styles of the screen; with `color` false every one returns its text unchanged. */
export interface Styles {
  readonly color: boolean;
  bold(text: string): string;
  muted(text: string): string;
  faint(text: string): string;
  accent(text: string): string;
  ok(text: string): string;
  bad(text: string): string;
  added(text: string): string;
  removed(text: string): string;
  /** The field or item the cursor is on; without color it is bracketed. */
  pill(text: string): string;
  /** The text cursor of a line being typed. */
  caret(): string;
}

function sgr(open: string, close: string) {
  return (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
}

/**
 * Styles for a terminal: color unless `NO_COLOR` is set to a non-empty
 * value (https://no-color.org). Without color the screen writes no SGR
 * sequences at all, bold and inverse included.
 */
export function styles(
  env: Readonly<Record<string, string | undefined>>,
): Styles {
  const color = !env.NO_COLOR;
  if (!color) {
    const plain = (text: string) => text;
    return {
      color,
      bold: plain,
      muted: plain,
      faint: plain,
      accent: plain,
      ok: plain,
      bad: plain,
      added: plain,
      removed: plain,
      pill: (text) => `[${text}]`,
      caret: () => "_",
    };
  }
  return {
    color,
    bold: sgr("1", "22"),
    muted: sgr("2", "22"),
    faint: sgr("90", "39"),
    accent: sgr("1;36", "22;39"),
    ok: sgr("32", "39"),
    bad: sgr("31", "39"),
    added: sgr("32", "39"),
    removed: sgr("31", "39"),
    pill: (text) => `\x1b[1;7m ${text} \x1b[22;27m`,
    caret: () => "\x1b[7m \x1b[27m",
  };
}

/** Columns and rows when the terminal does not say. */
const FALLBACK = { columns: 80, rows: 24 } as const;

/** Shows the cursor and leaves the alternate screen; every style is closed where it ends. */
export const RESTORE = "\x1b[?25h\x1b[?1049l";

/**
 * Owns the terminal while `hh tui` runs: raw mode, the alternate screen
 * with the cursor hidden, and redrawing only the lines that changed.
 * `restore` puts the terminal back as it was; it is synchronous and
 * idempotent, so the `exit` handler of a crashing process can call it.
 */
export class Screen {
  #previous: string[] = [];
  #open = false;

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
  ) {}

  get columns(): number {
    return this.output.columns || FALLBACK.columns;
  }

  get rows(): number {
    return this.output.rows || FALLBACK.rows;
  }

  /** Enter raw mode and the alternate screen; keys arrive as `data` from now on. */
  open(): void {
    this.input.setRawMode?.(true);
    this.input.setEncoding?.("utf8");
    this.input.resume();
    this.#open = true;
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    this.#previous = [];
  }

  /** Forget what is on screen: the next `draw` clears it and writes every line (after a resize). */
  invalidate(): void {
    if (!this.#open) return;
    this.output.write("\x1b[2J");
    this.#previous = [];
  }

  /** Show `lines`, each cut to the width, from the top; rows below them are cleared. */
  draw(lines: readonly string[]): void {
    if (!this.#open) return;
    const shown = lines
      .slice(0, this.rows)
      .map((line) => fit(line, this.columns));
    let text = "";
    shown.forEach((line, row) => {
      if (this.#previous[row] !== line)
        text += `\x1b[${row + 1};1H${line}\x1b[K`;
    });
    if (this.#previous.length > shown.length)
      text += `\x1b[${shown.length + 1};1H\x1b[J`;
    this.#previous = shown;
    if (text) this.output.write(text);
  }

  /** Leave raw mode and the alternate screen and show the cursor again. */
  restore(): void {
    if (!this.#open) return;
    this.#open = false;
    this.output.write(RESTORE);
    this.input.setRawMode?.(false);
    this.input.pause();
  }
}
