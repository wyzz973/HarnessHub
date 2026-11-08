import { createHash } from "node:crypto";

/**
 * The relay's escapes (ADR-055 §5.2 N1–N4, §5.5, §10.3), shared by every text a packet quotes: total functions, defined for
 * any string, whose output depends only on their input and this module's tables. Pure.
 *
 * Order for a quoted text: `normalize` (N1) → redaction (redaction.ts, which leaves its labels as protected marks) →
 * truncation (never inside a mark) → `visible` (N2) → `neutralize` (N4) → the labels restored → `fence` or an inline slot (N3).
 */

export type RelayLanguage = "zh" | "en";

/**
 * The control character the redactor writes around a label's key (`MARK` + one letter + `MARK`). `normalize` removes every
 * C0 character, so no quoted text can carry one of its own; the escapes below leave the marks alone until the labels are
 * restored.
 */
export const MARK = "\u0001";

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]|\u001b[ -/]+[0-~]|\u001b[@-_]/gu;
const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
/** N2: control, format, private-use, surrogate, unassigned, line and paragraph separators and default-ignorable code points. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * N1: line breaks become LF (CRLF, CR, U+2028, U+2029, U+0085); in command output only what follows a line's last CR is
 * kept (progress bars), elsewhere a lone CR is a line break; ANSI escape sequences go whole (CSI, OSC, C1 CSI and the
 * other escape sequences), then every C0 character but tab and LF, and DEL.
 */
export function normalize(text: string, kind: "text" | "output"): string {
  let value = text.replace(ANSI, "").replace(/\r\n/gu, "\n").replace(/[\u2028\u2029\u0085]/gu, "\n");
  if (value.includes("\r")) value = kind === "output" ? value.split("\n").map(line => line.slice(line.lastIndexOf("\r") + 1)).join("\n") : value.replace(/\r/gu, "\n");
  return value.replace(C0, "");
}

/** N2: every invisible code point (see INVISIBLE) but tab, LF and the redactor's marks is written as a visible `‹U+XXXX›`. */
export function visible(text: string): string {
  if (!/[^\x20-\x7e\n\t]/u.test(text)) return text;
  return text.replace(INVISIBLE, char => char === "\n" || char === "\t" || char === MARK ? char : "‹U+" + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0") + "›");
}

/** Look-alikes NFKC keeps apart from what they imitate in the reserved strings and marker words. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  "Η": "h", "Н": "h", "Ꮋ": "h", "һ": "h", "н": "h", "ｈ": "h", "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", "⁃": "-",
  "〈": "<", "⟨": "<", "ᐸ": "<", "˂": "<", "［": "[", "〔": "[", "【": "[", "〖": "[", "⟦": "[", "⦗": "[", "﹝": "[", "｛": "[", "{": "[", "（": "[", "(": "[",
};
/** A text's skeleton (NFKC, the look-alikes above, lower case) with, for each skeleton unit, where its code point starts. */
function skeleton(text: string): { readonly text: string; readonly origin: readonly number[] } {
  let out = ""; const origin: number[] = [];
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index)!, char = String.fromCodePoint(code);
    const mapped = code < 0x80 ? (CONFUSABLE[char] ?? char).toLowerCase() : [...char.normalize("NFKC")].map(item => CONFUSABLE[item] ?? item).join("").toLowerCase();
    for (let unit = 0; unit < mapped.length; unit++) { out += mapped[unit]; origin.push(index); }
    index += char.length;
  }
  return { text: out, origin };
}
const ANGLES = /[<＜﹤〈〈⟨ᐸ˂]/u;
/** `<<<HH-` in any width, case or look-alike spelling becomes `‹‹‹HH-`, so only the Hub writes a data region's delimiters. */
function reserved(text: string): string {
  if (!ANGLES.test(text)) return text;
  const shape = skeleton(text);
  let out = "", from = 0, search = 0;
  for (;;) {
    const at = shape.text.indexOf("<<<hh-", search);
    if (at < 0) break;
    const start = shape.origin[at]!, last = shape.origin[at + 5]!, end = last + String.fromCodePoint(text.codePointAt(last)!).length;
    if (start >= from) { out += text.slice(from, start) + "‹‹‹HH-"; from = end; }
    search = at + 6;
  }
  return out + text.slice(from);
}
/** The words a forged frame line, end line or label would start with, after an opening bracket of any shape. */
const MARKER_WORDS = ["harnesshub", "记录结束", "更新结束", "要点结束", "重发结束", "endofrecord", "endofupdate", "endofhandoff", "已脱敏", "redacted"];
const QUOTED: Readonly<Record<RelayLanguage, string>> = { zh: "（引用）", en: "(quoted) " };
function markerLine(line: string): boolean {
  const start = line.replace(/^(?:\s|‹U\+[0-9A-F]{4,6}›)+/u, "").slice(0, 48);
  if (start === "") return false;
  // Only an opening bracket can start a marker; among ASCII characters that is [ { or (.
  const first = start.charCodeAt(0);
  if (first < 0x80 && first !== 0x5b && first !== 0x7b && first !== 0x28) return false;
  const shape = skeleton(start).text.replace(/\s+/gu, "");
  return shape.startsWith("[") && MARKER_WORDS.some(word => shape.startsWith(word, 1));
}

/**
 * N4 for a quoted text: the Hub's own brackets 〔〕 become ［］ and `<<<HH-` becomes `‹‹‹HH-` (see `reserved`); in an inline
 * slot 「」 become ﹁﹂ as well, so the slot cannot be closed; in a block, a line that starts like a frame line, an end line
 * or a label (after leading blanks and visible invisibles) is prefixed with “（引用）” / “(quoted) ”.
 */
export function neutralize(text: string, language: RelayLanguage, slot: "block" | "inline"): string {
  let value = reserved(text).replace(/〔/gu, "［").replace(/〕/gu, "］");
  if (slot === "inline") return value.replace(/「/gu, "﹁").replace(/」/gu, "﹂");
  if (value.includes("\n")) value = value.split("\n").map(line => markerLine(line) ? QUOTED[language] + line : line).join("\n");
  else if (markerLine(value)) value = QUOTED[language] + value;
  return value;
}

/** The longest run of backticks or of tildes in a text: what a fence around it must outgrow. */
export function longestFenceRun(text: string): number {
  let longest = 0, run = 0, of = "";
  for (const char of text) {
    if (char === "`" || char === "~") { run = char === of ? run + 1 : 1; of = char; if (run > longest) longest = run; }
    else { run = 0; of = ""; }
  }
  return longest;
}
/**
 * N3: a verbatim block in a ```text fence as long as max(3, its longest backtick or tilde run + 1), so nothing inside can
 * close it; `indent` is prefixed to every line of a block inside a list item. A trailing LF of the body is dropped.
 */
export function fence(body: string, indent = ""): string {
  const marks = "`".repeat(Math.max(3, longestFenceRun(body) + 1));
  const content = body.endsWith("\n") ? body.slice(0, -1) : body;
  return indent + marks + "text\n" + content.split("\n").map(line => indent + line).join("\n") + "\n" + indent + marks;
}

export function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
/**
 * N3: a record region between `<<<HH-DATA b BEGIN>>>` and `<<<HH-DATA b END>>>`, where b is the first 8 hex digits of the
 * sha256 of the region's body: derived from the content, so it can be neither guessed nor forged before the body exists.
 */
export function dataRegion(body: string): string {
  const id = sha256(body).slice(0, 8);
  return "<<<HH-DATA " + id + " BEGIN>>>\n" + body + "\n<<<HH-DATA " + id + " END>>>";
}

/** Where a cut at `index` must move so it splits neither a surrogate pair nor a redaction mark: back (head) or on (tail). */
function safeCut(text: string, index: number, direction: "back" | "on"): number {
  let at = Math.max(0, Math.min(text.length, index));
  if (at > 0 && at < text.length) {
    if (text[at - 1] === MARK && text[at] !== MARK && text[at + 1] === MARK) at = direction === "back" ? at - 1 : at + 2;
    else if (text[at] === MARK && text[at - 1] !== MARK && text[at - 2] === MARK) at = direction === "back" ? at - 2 : at + 1;
  }
  if (at > 0 && at < text.length) {
    const before = text.charCodeAt(at - 1), after = text.charCodeAt(at);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) at += direction === "back" ? -1 : 1;
  }
  return at;
}
/** The first `count` UTF-16 units of a text, cut back to whole code points and whole redaction marks. */
export function headUnits(text: string, count: number): string { return text.slice(0, safeCut(text, count, "back")); }
/** The last `count` UTF-16 units of a text, cut on to whole code points and whole redaction marks. */
export function tailUnits(text: string, count: number): string { return count <= 0 ? "" : text.slice(safeCut(text, text.length - count, "on")); }
/** How many code points a text has (what the packet calls 字 / characters). */
export function characters(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index), before = index > 0 ? text.charCodeAt(index - 1) : 0;
    if (!(code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff)) count++;
  }
  return count;
}

/**
 * The packet's first line (ADR-055 §5.1, §5.5): the first ≤200 characters of the user's current words with line breaks
 * folded into spaces, normalized, visible and neutralized; a leading code fence is written `‹```›`, and with an odd number
 * of backticks the last one becomes ‘ and a blank line follows, so nothing the user typed opens a fence over the frame.
 * Null when nothing visible is left.
 */
export function firstLine(input: string, language: RelayLanguage): { readonly line: string; readonly blank: boolean } | null {
  const folded = normalize(input.replace(/\r\n|[\r\n\u2028\u2029\u0085]/gu, " "), "text");
  let line = neutralize(visible(headUnits(folded, codeUnitsOf(folded, 200))), language, "block");
  if (line.trim() === "") return null;
  line = line.replace(/^(\s*)(?:`{3,}|~{3,})/u, "$1‹```›");
  const ticks = [...line].filter(char => char === "`").length;
  if (ticks % 2 === 1) { const last = line.lastIndexOf("`"); line = line.slice(0, last) + "‘" + line.slice(last + 1); }
  return { line, blank: ticks % 2 === 1 };
}
/** How many UTF-16 units the first `count` code points of a text take. */
export function codeUnitsOf(text: string, count: number): number {
  let units = 0;
  for (let seen = 0; seen < count && units < text.length; seen++) units += String.fromCodePoint(text.codePointAt(units)!).length;
  return units;
}
