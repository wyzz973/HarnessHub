import { isDeepStrictEqual } from "node:util";
import { applyEdits, findNodeAtLocation, modify, parseTree, type FormattingOptions } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { parseConfig, record, type ConfigFormat } from "./formats.js";

/**
 * Edits of a Harness's own configuration that change only the bytes the change needs (ADR-045 §3): comments, key order,
 * indentation, line endings and every other value stay as they are. Each edit is checked afterwards by `onlyChanged`;
 * a text these editors cannot change safely throws `UnsafeEdit` and nothing is written.
 */
export class UnsafeEdit extends Error { constructor(message: string) { super(message); this.name = "UnsafeEdit"; } }
export type KeyPath = readonly string[];

/** The indentation unit and line ending a file already uses, so new lines are written like the rest of it. */
export function jsonFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let unit: string | null = null;
  for (const line of text.split(/\r?\n/u)) { const match = /^([ \t]+)\S/u.exec(line); if (match && (unit === null || match[1]!.length < unit.length)) unit = match[1]!; }
  return unit?.startsWith("\t") ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: unit === null ? 2 : Math.min(unit.length, 8), eol };
}
function splitBom(text: string): { bom: string; body: string } { return text.startsWith("﻿") ? { bom: "﻿", body: text.slice(1) } : { bom: "", body: text }; }

/** JSON or JSONC: sets `path` to `value`, or removes it when `value` is undefined; an object left empty by a removal goes too. */
export function setJson(text: string, path: KeyPath, value: unknown): string {
  const { bom, body } = splitBom(text), formattingOptions = jsonFormatting(body);
  let next = applyEdits(body, modify(body, [...path], value, { formattingOptions }));
  if (value === undefined && path.length > 1) {
    const parent = findNodeAtLocation(parseTree(next) ?? { type: "null", offset: 0, length: 0 }, [...path.slice(0, -1)]);
    if (parent?.type === "object" && (parent.children?.length ?? 0) === 0) next = applyEdits(next, modify(next, [...path.slice(0, -1)], undefined, { formattingOptions }));
  }
  if (body.trim() === "") next += formattingOptions.eol;
  return bom + next;
}
/** JSON or JSONC: appends a string to the array at `path`, creating it when absent; a one-line array stays on one line. */
export function appendJsonItem(text: string, path: KeyPath, item: string): string {
  const { bom, body } = splitBom(text), tree = parseTree(body), node = tree === undefined ? undefined : findNodeAtLocation(tree, [...path]);
  if (node === undefined) return setJson(text, path, [item]);
  if (node.type !== "array") throw new UnsafeEdit("这个设置不是列表");
  const source = body.slice(node.offset, node.offset + node.length);
  if (!source.includes("\n")) {
    const close = node.offset + node.length - 1;
    return bom + body.slice(0, close) + ((node.children?.length ?? 0) ? ", " : "") + JSON.stringify(item) + body.slice(close);
  }
  return bom + applyEdits(body, modify(body, [...path, node.children?.length ?? 0], item, { formattingOptions: jsonFormatting(body), isArrayInsertion: true }));
}
/** JSON or JSONC: removes every element equal to `item` from the array at `path`; a one-line array is written back on one line. */
export function removeJsonItem(text: string, path: KeyPath, item: string): string {
  const { bom, body } = splitBom(text), tree = parseTree(body), node = tree === undefined ? undefined : findNodeAtLocation(tree, [...path]);
  if (node === undefined || node.type !== "array") return text;
  const children = node.children ?? [], keep = children.filter(child => !(child.type === "string" && child.value === item));
  if (keep.length === children.length) return text;
  const source = body.slice(node.offset, node.offset + node.length);
  if (!source.includes("\n")) return bom + body.slice(0, node.offset) + "[" + keep.map(child => body.slice(child.offset, child.offset + child.length)).join(", ") + "]" + body.slice(node.offset + node.length);
  let next = body;
  for (let index = children.length - 1; index >= 0; index--) if (children[index]!.type === "string" && children[index]!.value === item) next = applyEdits(next, modify(next, [...path, index], undefined, { formattingOptions: jsonFormatting(body) }));
  return bom + next;
}

interface TomlLine { readonly start: number; readonly end: number; readonly text: string }
/**
 * One table of a TOML text: a `[[name]]` element or a `[name]` table, from its header to its last key line; comments and
 * blank lines after it belong to what follows, and so do its sub-tables.
 */
export interface TomlBlock { readonly start: number; readonly end: number; readonly keys: ReadonlyMap<string, { readonly line: TomlLine; readonly value: unknown }> }
function tomlLines(text: string): TomlLine[] {
  const lines: TomlLine[] = []; let start = 0;
  while (start < text.length) { const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline; lines.push({ start, end, text: text.slice(start, end).replace(/\r$/u, "") }); start = end + 1; }
  return lines;
}
/** A basic string's escapes as TOML reads them; null for one it does not allow. */
function basicString(raw: string): string | null {
  let bad = false;
  const value = raw.replace(/\\(?:(["\\bfnrt])|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([\s\S]))/gu, (_, simple: string | undefined, short: string | undefined, long: string | undefined) => {
    if (simple !== undefined) return ({ "\"": "\"", "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[simple]!;
    const point = parseInt(short ?? long ?? "", 16);
    if (Number.isNaN(point) || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) { bad = true; return ""; }
    return String.fromCodePoint(point);
  });
  return bad ? null : value;
}
/**
 * A table header's key path as TOML reads it — bare keys, `"…"` and `'…'` keys, whitespace around the dots — and whether
 * it names an array of tables; null for a line that is not a header this reader understands.
 */
export function tomlHeader(line: string): { readonly array: boolean; readonly path: readonly string[] } | null {
  const opening = /^[ \t]*(\[\[?)/u.exec(line);
  if (!opening) return null;
  const array = opening[1] === "[[", path: string[] = [];
  let rest = line.slice(opening[0].length);
  for (;;) {
    rest = rest.replace(/^[ \t]+/u, "");
    const bare = /^[A-Za-z0-9_-]+/u.exec(rest), quoted = bare ? null : /^"((?:[^"\\\n]|\\.)*)"/u.exec(rest), literal = bare || quoted ? null : /^'([^'\n]*)'/u.exec(rest);
    const key = bare ? bare[0] : quoted ? basicString(quoted[1]!) : literal ? literal[1]! : null;
    if (key === null) return null;
    path.push(key);
    rest = rest.slice((bare ?? quoted ?? literal)![0].length).replace(/^[ \t]+/u, "");
    if (!rest.startsWith(".")) break;
    rest = rest.slice(1);
  }
  const close = array ? "]]" : "]";
  if (!rest.startsWith(close)) return null;
  rest = rest.slice(close.length).replace(/^[ \t]+/u, "");
  return rest === "" || rest.startsWith("#") ? { array, path } : null;
}
/** The tables of a TOML text whose header `matches`, found by lines outside multi-line strings. */
function tomlTables(text: string, matches: (header: { readonly array: boolean; readonly path: readonly string[] }) => boolean): TomlBlock[] {
  const blocks: TomlBlock[] = []; let current: { start: number; end: number; keys: Map<string, { line: TomlLine; value: unknown }> } | null = null, quote: string | null = null;
  for (const line of tomlLines(text)) {
    const opening: string | null = quote === null ? /"""|'''/u.exec(line.text)?.[0] ?? null : null;
    if (quote !== null) { if (line.text.split(quote).length % 2 === 0) quote = null; continue; }
    const header = tomlHeader(line.text);
    if (header) { if (current) blocks.push(current); current = matches(header) ? { start: line.start, end: line.end, keys: new Map() } : null; continue; }
    if (current && /^\s*[A-Za-z0-9_"'-]/u.test(line.text)) {
      const pair = /^\s*([A-Za-z0-9_-]+|"[^"]+")\s*=/u.exec(line.text);
      if (pair) {
        let value: unknown;
        try { value = record(parseToml("v = " + line.text.slice(line.text.indexOf("=") + 1))).v; } catch { throw new UnsafeEdit("config.toml 里有无法逐行读取的写法"); }
        current.keys.set(pair[1]!.replace(/^"|"$/gu, ""), { line, value }); current.end = line.end;
      }
    }
    if (opening !== null && line.text.split(opening).length % 2 === 0) quote = opening;
  }
  if (current) blocks.push(current);
  return blocks;
}
/** The elements of the array of tables `name` (a dotted path of bare keys, such as `skills.config`) in a TOML text. */
export function tomlBlocks(text: string, name: string): TomlBlock[] {
  const path = name.split(".");
  return tomlTables(text, header => header.array && isDeepStrictEqual(header.path, path));
}
/**
 * The standard table `[path]` of a TOML text (`[plugins."name@market"]`, however its keys are quoted), or null when no
 * header names it — the table may still be defined by dotted keys or inline, which these edits do not change. More than
 * one such header is not valid TOML and refused.
 */
export function tomlTable(text: string, path: readonly string[]): TomlBlock | null {
  const found = tomlTables(text, header => !header.array && isDeepStrictEqual(header.path, path));
  if (found.length > 1) throw new UnsafeEdit("config.toml 里同一张表出现了不止一次");
  return found[0] ?? null;
}
/** Whether `after` differs from `before` in exactly one line: one line changed, or one line inserted. */
export function oneLineChange(before: string, after: string): boolean {
  const left = before.split("\n"), right = after.split("\n");
  if (left.length === right.length) return left.filter((line, index) => line !== right[index]).length === 1;
  if (right.length !== left.length + 1) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  return left.slice(index).every((line, offset) => line === right[index + 1 + offset]);
}
function tomlString(value: string): string { return "\"" + value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"") + "\""; }
/** Appends one `[[name]]` element with these keys at the end of a TOML text, after one blank line. */
export function appendTomlBlock(text: string, name: string, keys: readonly (readonly [string, string | boolean])[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n", body = text === "" ? "" : text.endsWith("\n") ? text + eol : text + eol + eol;
  return body + "[[" + name + "]]" + eol + keys.map(([key, value]) => key + " = " + (typeof value === "string" ? tomlString(value) : String(value))).join(eol) + eol;
}
/**
 * Sets one key of a TOML table to a boolean: a boolean already there is replaced in place (the rest of its line, such as
 * a comment, stays), another value's line is rewritten, and a missing key is added after the table's last key with its
 * indentation.
 */
export function setTomlKey(text: string, block: TomlBlock, key: string, value: boolean): string {
  const existing = block.keys.get(key), eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (existing) {
    const token = /^(\s*(?:[A-Za-z0-9_-]+|"[^"]+")\s*=\s*)(?:true|false)(?=\s*(?:#|$))/u.exec(existing.line.text);
    if (token) return text.slice(0, existing.line.start + token[1]!.length) + String(value) + text.slice(existing.line.start + token[0].length);
    const indent = /^\s*/u.exec(existing.line.text)![0];
    return text.slice(0, existing.line.start) + indent + key + " = " + String(value) + text.slice(existing.line.start + existing.line.text.length);
  }
  const last = [...block.keys.values()].sort((left, right) => left.line.start - right.line.start).at(-1), indent = last ? /^[ \t]*/u.exec(last.line.text)![0] : "";
  // After the last line's text, before its line ending: with CRLF that is before the \r.
  const at = block.end > 0 && text[block.end - 1] === "\r" ? block.end - 1 : block.end;
  return text.slice(0, at) + eol + indent + key + " = " + String(value) + text.slice(at);
}
/** Removes one TOML element and the blank line before it. */
export function removeTomlBlock(text: string, block: TomlBlock): string {
  let start = block.start, end = block.end < text.length && text[block.end] === "\n" ? block.end + 1 : block.end;
  if (start >= 2 && text.slice(start - 2, start) === "\n\n") start -= 1; else if (start >= 4 && text.slice(start - 4, start) === "\r\n\r\n") start -= 2;
  if (end === text.length && start > 0 && text[start - 1] === "\n" && block.start === start) end = text.length;
  return text.slice(0, start) + text.slice(end);
}

function yamlScalar(value: string): string { return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ? value : JSON.stringify(value); }
function lineStart(text: string, offset: number): number { return text.lastIndexOf("\n", offset - 1) + 1; }
function lineEnd(text: string, offset: number): number { const newline = text.indexOf("\n", offset); return newline < 0 ? text.length : newline; }
/** Where a node's last value ends: a block collection's own range runs on over the blank space after it, its last scalar's does not. */
function valueEnd(node: unknown): number | null {
  if (isScalar(node)) return node.range ? node.range[1] : null;
  if (isSeq(node)) return node.items.length ? valueEnd(node.items.at(-1)) : node.range ? node.range[1] : null;
  if (isMap(node)) { const pair = node.items.at(-1); return pair === undefined ? node.range ? node.range[1] : null : pair.value === null ? valueEnd(pair.key) : valueEnd(pair.value); }
  return null;
}
/** YAML: appends a string to the sequence at a two-level `path` (`skills.disabled`), creating what is missing, by splicing text. */
export function appendYamlItem(text: string, path: readonly [string, string], item: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new UnsafeEdit("YAML 无法解析");
  const eol = text.includes("\r\n") ? "\r\n" : "\n", value = yamlScalar(item);
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) return text + (text === "" || text.endsWith("\n") ? "" : eol) + path[0] + ":" + eol + "  " + path[1] + ":" + eol + "    - " + value + eol;
  if (!isMap(doc.contents) || doc.contents.flow) throw new UnsafeEdit("YAML 顶层不是普通的映射");
  const parent = doc.contents.get(path[0], true);
  if (parent === undefined) return text + (text.endsWith("\n") ? "" : eol) + path[0] + ":" + eol + "  " + path[1] + ":" + eol + "    - " + value + eol;
  if (!isMap(parent) || parent.flow || !parent.range) throw new UnsafeEdit("YAML 的 " + path[0] + " 不是普通的映射");
  const pair = parent.items.find(entry => isScalar(entry.key) && entry.key.value === path[1]);
  if (pair === undefined) {
    const first = parent.items[0]?.key, end = valueEnd(parent);
    if (!isScalar(first) || !first.range || end === null) throw new UnsafeEdit("YAML 的 " + path[0] + " 无法定位");
    const indent = " ".repeat(first.range[0] - lineStart(text, first.range[0])), at = lineEnd(text, end);
    return text.slice(0, at) + eol + indent + path[1] + ":" + eol + indent + "  - " + value + text.slice(at);
  }
  const node = pair.value;
  if (isScalar(node) && node.value === null && node.range) {
    if (node.range[0] === node.range[1]) { const colon = text.lastIndexOf(":", node.range[0]); return text.slice(0, colon + 1) + " [" + value + "]" + text.slice(colon + 1); }
    return text.slice(0, node.range[0]) + "[" + value + "]" + text.slice(node.range[1]);
  }
  if (!isSeq(node) || !node.range) throw new UnsafeEdit("YAML 的 " + path.join(".") + " 不是列表");
  if (node.flow) { const close = text.lastIndexOf("]", node.range[1]); return text.slice(0, close) + (node.items.length ? ", " : "") + value + text.slice(close); }
  const first = node.items[0], last = node.items.at(-1);
  if (!isScalar(first) || !first.range || !isScalar(last) || !last.range) throw new UnsafeEdit("YAML 的 " + path.join(".") + " 含有无法定位的条目");
  const dash = text.lastIndexOf("-", first.range[0]), indent = " ".repeat(dash - lineStart(text, dash)), at = lineEnd(text, last.range[1]);
  return text.slice(0, at) + eol + indent + "- " + value + text.slice(at);
}
/** YAML: removes every entry equal to `item` from the sequence at `path`; a sequence left empty is written as `[]`. */
export function removeYamlItem(text: string, path: readonly [string, string], item: string): string {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new UnsafeEdit("YAML 无法解析");
  const node = doc.getIn([...path], true);
  if (!isSeq(node) || !node.range) return text;
  const keep = node.items.filter(entry => !(isScalar(entry) && entry.value === item));
  if (keep.length === node.items.length) return text;
  if (node.flow) return text.slice(0, node.range[0]) + "[" + keep.map(entry => isScalar(entry) && entry.range ? text.slice(entry.range[0], entry.range[1]) : "").join(", ") + "]" + text.slice(node.range[1]);
  if (!keep.length) { const colon = text.lastIndexOf(":", node.range[0]), end = valueEnd(node) ?? node.range[1]; return text.slice(0, colon + 1) + " []" + text.slice(end); }
  let next = text;
  for (const entry of [...node.items].reverse()) {
    if (!isScalar(entry) || entry.value !== item || !entry.range) continue;
    const start = lineStart(next, entry.range[0]), end = Math.min(next.length, lineEnd(next, entry.range[1]) + 1);
    next = next.slice(0, start) + next.slice(end);
  }
  return next;
}

/** A parsed value as plain JSON, so values parsed by different readers compare by content only. */
function plain(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown; }
function without(value: unknown, path: KeyPath): unknown {
  const copy = plain(value);
  if (path.length === 0) return undefined;
  const chain: Record<string, unknown>[] = [];
  let current: unknown = copy;
  for (const key of path.slice(0, -1)) { if (current === null || typeof current !== "object" || Array.isArray(current)) return copy; chain.push(current as Record<string, unknown>); current = (current as Record<string, unknown>)[key]; }
  if (current === null || typeof current !== "object" || Array.isArray(current)) return copy;
  delete (current as Record<string, unknown>)[path.at(-1)!];
  // Containers left empty go too, so a setting created with its parents compares equal to never having been there.
  let child = current as Record<string, unknown>;
  for (let index = chain.length - 1; index >= 0 && Object.keys(child).length === 0; index--) { delete chain[index]![path[index]!]; child = chain[index]!; }
  return copy;
}
/** Whether two parses of a file are equal everywhere except at `path`: the guard every edit passes before it is written. */
export function onlyChanged(before: unknown, after: unknown, path: KeyPath): boolean { return isDeepStrictEqual(without(before ?? {}, path), without(after ?? {}, path)); }
/** The parsed value of a text by format, or `UnsafeEdit` when it does not parse. */
export function parsed(text: string, format: ConfigFormat): unknown {
  if (format === "markdown") return text;
  if (text.trim() === "") return {};
  const result = parseConfig(text, format);
  if (!result.ok) throw new UnsafeEdit("文件无法解析：" + result.reason);
  return result.value;
}
