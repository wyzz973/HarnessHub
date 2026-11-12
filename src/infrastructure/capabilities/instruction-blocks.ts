import { createHash } from "node:crypto";

/**
 * The block HarnessHub writes into a Harness's user-level instructions file (ADR-045 step 4): two marker lines of its
 * own around the text, the begin line carrying the first 12 hex digits of the text's sha256 so that an edit inside the
 * block shows even without the ledger. A file holds at most one; the bytes outside it are never changed.
 */
const BEGIN = /^<!-- harnesshub:begin id=instructions sha=([0-9a-f]{12}) -->$/u, END = "<!-- harnesshub:end id=instructions -->", MARKER = "<!-- harnesshub:";
/** The most each text (the shared one, or one Harness's addition) may hold, in UTF-8 bytes. */
export const INSTRUCTION_TEXT_BYTES = 8 * 1024 * 1024;

/** A file's text as HarnessHub reads it for its block: none, one (`intact` when its text still matches the begin line's sha), or markers it cannot use. */
export type InstructionBlock =
  | { readonly kind: "none" }
  /** `start` is the begin line's first character, `end` just past the end line and its line break (if any); `body` has LF line breaks. */
  | { readonly kind: "block"; readonly start: number; readonly end: number; readonly body: string; readonly sha: string; readonly intact: boolean; readonly terminated: boolean }
  | { readonly kind: "broken"; readonly reason: string };

/** The first 12 hex digits of the sha256 of a block's text, line breaks as LF. */
export function bodySha(body: string): string { return createHash("sha256").update(body.replace(/\r\n/gu, "\n")).digest("hex").slice(0, 12); }

/** One Harness's block text: the shared text, then after an empty line its own addition; leading empty lines and trailing space dropped. Empty when both are. */
export function instructionBody(shared: string, addition: string): string {
  return [shared, addition].map(part => part.replace(/\r\n/gu, "\n").replace(/^(?:[ \t]*\n)+/u, "").replace(/\s+$/u, "")).filter(Boolean).join("\n\n");
}

/**
 * Why a text the user wrote cannot go into a Harness's file, or null: a NUL or another control character than a line
 * break or tab (line breaks are LF by then), half of a surrogate pair (it would be written as U+FFFD and read back
 * differently), or the home directory written out (it is shown as ~ everywhere, so it is asked for as ~ rather than
 * replaced silently).
 */
export function userTextProblem(text: string, homes: readonly string[]): string | null {
  if (text.includes("\0")) return "不能含 NUL 字符";
  if (/(?![\t\n])\p{Cc}/u.test(text)) return "不能含换行和制表符以外的控制字符";
  if (/\p{Cs}/u.test(text)) return "含有不完整的字符（孤立的代理项）";
  const home = homes.find(item => item.length > 1 && (text.includes(item + "/") || new RegExp("(^|[\\s\"'=(（])" + item.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "(?=$|[\\s\"')）。，])", "u").test(text)));
  return home === undefined ? null : "家目录请写成 ~（例如 ~/projects），不要写完整路径";
}
/** Why a text cannot be saved as the shared text or an addition, or null: too long, HarnessHub's own marker, or what `userTextProblem` refuses. */
export function instructionTextProblem(text: string, homes: readonly string[]): string | null {
  if (Buffer.byteLength(text, "utf8") > INSTRUCTION_TEXT_BYTES) return "最多 8 MiB";
  if (text.includes(MARKER)) return "不能含 HarnessHub 的区块标记 " + MARKER;
  return userTextProblem(text, homes);
}

/** HarnessHub's block in a file's text, by its marker lines: any other line starting with HarnessHub's marker, or markers out of order, make it unusable. */
export function findBlock(text: string): InstructionBlock {
  // A byte order mark belongs to the file, not to its first line.
  const bom = text.startsWith("﻿") ? 1 : 0;
  let begin: { start: number; after: number; sha: string } | null = null, end: { start: number; end: number; terminated: boolean } | null = null, offset = bom;
  for (const line of text.slice(bom).split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, ""), start = offset; offset += line.length;
    if (!content.trimStart().startsWith(MARKER)) continue;
    const opening = BEGIN.exec(content);
    if (opening) { if (begin !== null || end !== null) return { kind: "broken", reason: "文件里有不止一个 HarnessHub 区块的开始标记" }; begin = { start, after: offset, sha: opening[1]! }; continue; }
    if (content === END) { if (begin === null) return { kind: "broken", reason: "HarnessHub 区块的结束标记在开始标记之前" }; if (end !== null) return { kind: "broken", reason: "文件里有不止一个 HarnessHub 区块的结束标记" }; end = { start, end: offset, terminated: line.endsWith("\n") }; continue; }
    return { kind: "broken", reason: "文件里有无法识别的 HarnessHub 标记：" + content.trim().slice(0, 80) };
  }
  if (begin === null && end === null) return { kind: "none" };
  if (begin === null || end === null) return { kind: "broken", reason: begin === null ? "HarnessHub 区块只有结束标记" : "HarnessHub 区块只有开始标记，没有结束标记" };
  const body = text.slice(begin.after, end.start).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
  return { kind: "block", start: begin.start, end: end.end, body, sha: begin.sha, intact: bodySha(body) === begin.sha, terminated: end.terminated };
}

function lineBreak(text: string): string { return text.includes("\r\n") ? "\r\n" : "\n"; }
function blockText(body: string, eol: string, terminated: boolean): string {
  return "<!-- harnesshub:begin id=instructions sha=" + bodySha(body) + " -->" + eol + body.split("\n").join(eol) + eol + END + (terminated ? eol : "");
}

/**
 * The file's text with HarnessHub's block holding `body`: the block replaced in place, or added at the end after an
 * empty line (`separator` is what was added before it, recorded so that removing it gives the old bytes back). The
 * file's line breaks are kept. Throws on markers it cannot use.
 */
export function withBlock(text: string, body: string): { readonly after: string; readonly separator: string } {
  const found = findBlock(text), eol = lineBreak(text);
  if (found.kind === "broken") throw new Error(found.reason);
  if (found.kind === "block") return { after: text.slice(0, found.start) + blockText(body, eol, found.terminated) + text.slice(found.end), separator: "" };
  const separator = text.replace(/^﻿/u, "") === "" || text.endsWith(eol + eol) ? "" : text.endsWith(eol) ? eol : eol + eol;
  return { after: text + separator + blockText(body, eol, true), separator };
}

/**
 * The file's text without HarnessHub's block: the separator added with it goes too when the block is still the last
 * thing in the file, so a file nobody touched since reads as before. Throws when there is no usable block.
 */
export function withoutBlock(text: string, separator: string): string {
  const found = findBlock(text);
  if (found.kind !== "block") throw new Error(found.kind === "broken" ? found.reason : "文件里没有 HarnessHub 区块");
  const before = text.slice(0, found.start), rest = text.slice(found.end);
  return (rest === "" && separator !== "" && before.endsWith(separator) ? before.slice(0, before.length - separator.length) : before) + rest;
}
