// SPDX-License-Identifier: MIT
/**
 * A terminal for driving `hh tui` in tests: raw-mode input that records its
 * mode, an output whose size can change (emitting `resize` as a terminal
 * does on SIGWINCH), and a screen that applies the escape sequences the TUI
 * writes, so a test reads what a person would see. An escape sequence the
 * screen does not know fails the test instead of being skipped.
 */
import { EventEmitter } from "node:events";

/** The bytes a terminal in raw mode sends for these keys. */
export const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  enter: "\r",
  escape: "\x1b",
  backspace: "\x7f",
  interrupt: "\x03",
} as const;

export class FakeInput extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  paused = true;

  setRawMode(raw: boolean): this {
    this.raw = raw;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  /** Send keys as a terminal sends their bytes. */
  type(text: string): void {
    this.emit("data", text);
  }
}

/** The cells of a terminal, changed by the text and escape sequences written to it. */
export class VirtualScreen {
  alternate = false;
  cursorVisible = true;
  /** SGR sequences written so far. */
  styles = 0;
  /** A character was written past the right edge. */
  overflowed = false;
  #cells: string[][] = [];
  #row = 0;
  #column = 0;

  constructor(
    public columns: number,
    public rows: number,
  ) {
    this.#clear();
  }

  resize(columns: number, rows: number): void {
    const before = this.#cells;
    this.columns = columns;
    this.rows = rows;
    this.#cells = [];
    this.#clear();
    before.slice(0, rows).forEach((row, index) => {
      this.#cells[index] = [
        ...row.slice(0, columns),
        ...Array.from({ length: Math.max(0, columns - row.length) }, () => " "),
      ];
    });
  }

  #clear(from = 0): void {
    for (let row = from; row < this.rows; row += 1)
      this.#cells[row] = Array.from({ length: this.columns }, () => " ");
  }

  apply(text: string): void {
    let at = 0;
    while (at < text.length) {
      if (text[at] === "\x1b") {
        const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(
          text.slice(at, at + 24),
        );
        if (!match)
          throw new Error(
            `Unknown escape sequence ${JSON.stringify(text.slice(at, at + 12))}`,
          );
        this.#control(match[1]!, match[2]!);
        at += match[0].length;
        continue;
      }
      const codePoint = text.codePointAt(at)!;
      const character = String.fromCodePoint(codePoint);
      at += character.length;
      if (character === "\r") this.#column = 0;
      else if (character === "\n") this.#row += 1;
      else if (this.#column >= this.columns || this.#row >= this.rows)
        this.overflowed = true;
      else {
        this.#cells[this.#row]![this.#column] = character;
        this.#column += 1;
      }
    }
  }

  #control(parameters: string, final: string): void {
    switch (`${parameters.startsWith("?") ? parameters : ""}${final}`) {
      case "H": {
        const [row, column] = parameters.split(";");
        this.#row = Number(row || 1) - 1;
        this.#column = Number(column || 1) - 1;
        return;
      }
      case "K":
        if (this.#row < this.rows)
          for (let column = this.#column; column < this.columns; column += 1)
            this.#cells[this.#row]![column] = " ";
        return;
      case "J":
        if (parameters === "2") this.#clear();
        else {
          this.apply("\x1b[K");
          this.#clear(this.#row + 1);
        }
        return;
      case "m":
        this.styles += 1;
        return;
      case "?1049h":
        this.alternate = true;
        this.#clear();
        return;
      case "?1049l":
        this.alternate = false;
        return;
      case "?25h":
        this.cursorVisible = true;
        return;
      case "?25l":
        this.cursorVisible = false;
        return;
      default:
        throw new Error(`Unknown escape sequence ESC[${parameters}${final}`);
    }
  }

  /** The screen as text, one line per row, without trailing spaces. */
  text(): string {
    return this.#cells
      .map((row) => row.join("").trimEnd())
      .join("\n")
      .trimEnd();
  }

  /** Each row as written, trailing spaces included. */
  lines(): string[] {
    return this.#cells.map((row) => row.join("").trimEnd());
  }
}

export class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  written = "";
  readonly screen: VirtualScreen;

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
    this.screen = new VirtualScreen(columns, rows);
  }

  write(text: string): boolean {
    this.written += text;
    this.screen.apply(text);
    this.emit("written");
    return true;
  }

  /** Change the size as a terminal window does, then emit `resize`. */
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.emit("resize");
  }

  /** Resolve with the screen text once `test` accepts it; fail with the screen after `timeoutMs`. */
  waitFor(
    test: (text: string) => boolean,
    what: string,
    timeoutMs = 15_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const text = this.screen.text();
        if (!test(text)) return;
        cleanup();
        resolve(text);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`The screen never showed ${what}:\n${this.screen.text()}`),
        );
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("written", check);
      };
      this.on("written", check);
      check();
    });
  }
}
