/*
 * A stored tool detail read in one pass, however large it is (finding 1 of the cut review): the JSON the content store keeps for a call (`detail-json.ts`) is scanned as it comes in pieces,
 * and each of its text fields keeps what the reader asked of it — all of it when it is short enough, else its first and last characters with its length and its lines counted — so that
 * neither memory nor a bound on the whole file decides whether a reader gets the command of a call whose output is megabytes long. The scan does not depend on the order the keys were
 * written in, nor on where the pieces were cut (a character, an escape or a multibyte letter may be split between two of them), and gives for a file that is one JSON object
 * exactly what `JSON.parse` would for the fields it keeps. Pure.
 */

/** What a reader keeps of one text field: a text of at most `whole` characters whole, else its first `head` and last `tail` characters. */
export interface FieldPolicy { readonly whole: number; readonly head: number; readonly tail: number }
/** One text field as scanned. */
export interface ScannedText {
  /** The whole text when it was kept whole, else its first `head` characters. */
  readonly head: string;
  /** The last `tail` characters of a text that was cut; "" for one kept whole. */
  readonly tail: string;
  /** The text's length in characters (UTF-16 code units) and the number of line feeds in it. */
  readonly chars: number;
  readonly newlines: number;
  readonly cut: boolean;
}
/** The top-level fields of a detail: its texts, its lists of texts (`locations`), its numbers and its flags; anything else is passed over. */
export interface ScannedDetail {
  readonly texts: Readonly<Record<string, ScannedText>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly numbers: Readonly<Record<string, number>>;
  readonly flags: Readonly<Record<string, boolean>>;
  /** The input was one JSON object read to its end. */
  readonly valid: boolean;
}

/** The most entries a list keeps (`locations` is read for sixteen), so that a list of millions is not held. */
const LIST_KEPT = 4096;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const SPACE = /[ \t\r\n]/u;

/** A text field being read: kept whole until it passes `whole`, then reduced to its head and a rolling tail. */
class Text {
  private parts: string[] = [];
  private kept = 0;
  private head = "";
  private tail = "";
  chars = 0;
  newlines = 0;
  cut = false;
  constructor(private readonly policy: FieldPolicy) {}
  add(piece: string): void {
    if (piece === "") return;
    this.chars += piece.length;
    for (let at = piece.indexOf("\n"); at >= 0; at = piece.indexOf("\n", at + 1)) this.newlines++;
    if (!this.cut) {
      if (this.chars <= this.policy.whole) { this.parts.push(piece); this.kept += piece.length; return; }
      // Past the whole: keep the head, and start the tail from what has been read.
      const all = this.parts.join("") + piece;
      this.parts = [];
      this.cut = true;
      this.head = all.slice(0, this.policy.head);
      this.tail = this.policy.tail === 0 ? "" : all.slice(-this.policy.tail);
      return;
    }
    // The head goes on filling from the pieces that follow until it holds what the reader asked for.
    if (this.head.length < this.policy.head) this.head += piece.slice(0, this.policy.head - this.head.length);
    if (this.policy.tail === 0) return;
    this.tail += piece;
    if (this.tail.length > this.policy.tail * 2) this.tail = this.tail.slice(-this.policy.tail);
  }
  done(): ScannedText {
    if (!this.cut) return { head: this.parts.join(""), tail: "", chars: this.chars, newlines: this.newlines, cut: false };
    // A cut never leaves half of a surrogate pair at its edge: the head loses a high half it ends with, the tail a low half it starts with.
    const head = /[\ud800-\udbff]$/u.test(this.head) ? this.head.slice(0, -1) : this.head;
    const tail = this.policy.tail === 0 ? "" : this.tail.slice(-this.policy.tail);
    return { head, tail: /^[\udc00-\udfff]/u.test(tail) ? tail.slice(1) : tail, chars: this.chars, newlines: this.newlines, cut: true };
  }
}

type Mode = "start" | "keyOrEnd" | "key" | "colon" | "value" | "string" | "literal" | "list" | "skip" | "after" | "done" | "invalid";

/** Reads a detail's JSON piece by piece; `end()` gives what it found. */
export class DetailScanner {
  private mode: Mode = "start";
  private key = "";
  private keyText = "";
  private text: Text | null = null;
  private literal = "";
  private escape = "";
  private readonly texts: Record<string, ScannedText> = {};
  private readonly lists: Record<string, string[]> = {};
  private readonly numbers: Record<string, number> = {};
  private readonly flags: Record<string, boolean> = {};
  // A list of texts: the entry being read, the list, and whether an entry is open.
  private listKey = "";
  private entry: string | null = null;
  // Skipping a value that is not read: the depth of arrays and objects, and whether a text is open inside it.
  private depth = 0;
  private inSkippedText = false;
  private skipEscape = false;
  // The skipped value is an entry of the list `locations`, after which the list goes on.
  private pendingList = false;
  constructor(private readonly policy: (key: string) => FieldPolicy) {}

  push(text: string): void {
    let at = 0;
    const length = text.length;
    while (at < length && this.mode !== "done" && this.mode !== "invalid") {
      switch (this.mode) {
        case "start": { const ch = text[at++]!; if (ch === "{") this.mode = "keyOrEnd"; else if (!SPACE.test(ch)) this.mode = "invalid"; break; }
        case "keyOrEnd": { const ch = text[at++]!; if (ch === '"') { this.mode = "key"; this.keyText = ""; } else if (ch === "}") this.mode = "done"; else if (!SPACE.test(ch)) this.mode = "invalid"; break; }
        case "key": {
          at = this.string(text, at, piece => { this.keyText += piece; }, () => { this.key = this.keyText; this.mode = "colon"; });
          break;
        }
        case "colon": { const ch = text[at++]!; if (ch === ":") this.mode = "value"; else if (!SPACE.test(ch)) this.mode = "invalid"; break; }
        case "value": {
          const ch = text[at]!;
          if (SPACE.test(ch)) { at++; break; }
          at++;
          if (ch === '"') { this.text = new Text(this.policy(this.key)); this.mode = "string"; }
          else if (ch === "[" && this.key === "locations") { this.mode = "list"; this.listKey = this.key; this.lists[this.key] = []; this.entry = null; }
          else if (ch === "[" || ch === "{") { this.mode = "skip"; this.depth = 1; this.inSkippedText = false; this.skipEscape = false; }
          else { this.mode = "literal"; this.literal = ch; }
          break;
        }
        case "string": {
          at = this.string(text, at, piece => this.text!.add(piece), () => { this.texts[this.key] = this.text!.done(); this.text = null; this.mode = "after"; });
          break;
        }
        case "literal": {
          const ch = text[at]!;
          if (ch === "," || ch === "}" || SPACE.test(ch)) { this.literalDone(); this.mode = "after"; break; }
          this.literal += ch; at++;
          break;
        }
        case "list": at = this.listing(text, at); break;
        case "skip": at = this.skipping(text, at); break;
        case "after": {
          const ch = text[at++]!;
          // After a comma a key follows (`keyOrEnd` also takes "}", which a trailing comma would allow: the scan does not judge the syntax, it reads what the writer wrote).
          if (ch === ",") this.mode = "keyOrEnd";
          else if (ch === "}") this.mode = "done";
          else if (!SPACE.test(ch)) this.mode = "invalid";
          break;
        }
      }
    }
    // A literal (a number) that runs to the end of the piece goes on in the next one.
  }

  /** Reads the characters of a JSON text from `at` to its closing quote (decoding escapes, even ones split between pieces); gives the position after what was read. */
  private string(text: string, from: number, emit: (piece: string) => void, closed: () => void): number {
    let at = from;
    const length = text.length;
    while (at < length) {
      if (this.escape !== "") {
        const need = this.escape === "\\" ? 1 : this.escape.length < 6 ? 6 - this.escape.length : 0;
        if (this.escape === "\\") {
          const ch = text[at++]!;
          if (ch === "u") { this.escape = "\\u"; continue; }
          const decoded = ESCAPES[ch];
          this.escape = "";
          if (decoded === undefined) { this.mode = "invalid"; return length; }
          emit(decoded);
          continue;
        }
        const take = Math.min(need, length - at);
        this.escape += text.slice(at, at + take); at += take;
        if (this.escape.length === 6) {
          const code = Number.parseInt(this.escape.slice(2), 16);
          this.escape = "";
          if (!Number.isFinite(code)) { this.mode = "invalid"; return length; }
          emit(String.fromCharCode(code));
        }
        continue;
      }
      let stop = at;
      while (stop < length) { const ch = text.charCodeAt(stop); if (ch === 0x22 || ch === 0x5c) break; stop++; }
      if (stop > at) { emit(text.slice(at, stop)); at = stop; }
      if (at >= length) break;
      if (text.charCodeAt(at) === 0x22) { at++; closed(); return at; }
      at++; this.escape = "\\";
    }
    return at;
  }

  /** A list of texts (`locations`): each entry a text, anything else passed over. */
  private listing(text: string, from: number): number {
    let at = from;
    const length = text.length;
    while (at < length) {
      if (this.entry !== null) {
        at = this.string(text, at, piece => { this.entry += piece; }, () => { if (this.lists[this.listKey]!.length < LIST_KEPT) this.lists[this.listKey]!.push(this.entry!); this.entry = null; });
        if (this.mode === "invalid") return length;
        continue;
      }
      const ch = text[at++]!;
      if (ch === '"') { this.entry = ""; }
      else if (ch === "]") { this.mode = "after"; return at; }
      else if (ch === "," || SPACE.test(ch)) { /* between entries */ }
      else if (ch === "[" || ch === "{") { this.mode = "skip"; this.depth = 1; this.inSkippedText = false; this.skipEscape = false; this.pendingList = true; return at; }
      // A number, a flag or null inside the list: no entry of text, passed over to the next comma.
    }
    return at;
  }

  /** A value that is not read, passed over to its end. */
  private skipping(text: string, from: number): number {
    let at = from;
    const length = text.length;
    while (at < length) {
      const ch = text[at++]!;
      if (this.inSkippedText) {
        if (this.skipEscape) this.skipEscape = false;
        else if (ch === "\\") this.skipEscape = true;
        else if (ch === '"') this.inSkippedText = false;
        continue;
      }
      if (ch === '"') this.inSkippedText = true;
      else if (ch === "[" || ch === "{") this.depth++;
      else if (ch === "]" || ch === "}") {
        this.depth--;
        if (this.depth === 0) { this.mode = this.pendingList ? "list" : "after"; this.pendingList = false; return at; }
      }
    }
    return at;
  }

  private literalDone(): void {
    const word = this.literal; this.literal = "";
    if (word === "true") this.flags[this.key] = true;
    else if (word === "false") this.flags[this.key] = false;
    else if (word !== "null") { const value = Number(word); if (Number.isFinite(value)) this.numbers[this.key] = value; }
  }

  /** What the scan found. A literal that ended the input with no delimiter after it is not a complete object, so it is not counted. */
  end(): ScannedDetail {
    return { texts: this.texts, lists: this.lists, numbers: this.numbers, flags: this.flags, valid: this.mode === "done" };
  }
}

/** Scans a detail given as pieces of bytes (UTF-8, cut anywhere): the pieces are decoded as they come, and a letter split between two of them is whole again. */
export async function scanDetail(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, policy: (key: string) => FieldPolicy): Promise<ScannedDetail> {
  const scanner = new DetailScanner(policy), decoder = new TextDecoder("utf-8", { fatal: false });
  for await (const chunk of chunks) scanner.push(decoder.decode(chunk, { stream: true }));
  scanner.push(decoder.decode());
  return scanner.end();
}
