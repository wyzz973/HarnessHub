// SPDX-License-Identifier: MIT
import { parse as parseToml, TomlError } from "smol-toml";
import { WiringError } from "../errors.js";
import type { ConfigValue, FormatEditor, KeyPath } from "./types.js";
import { formatPath, getPath, isRecord, leaves, startsWith } from "./values.js";

/**
 * TOML edited by key path without re-serialising the document. `smol-toml`
 * validates the input and is the reference reader; a small line scanner
 * locates table headers and assignments so that an edit replaces one value,
 * inserts one line, or deletes the lines of one entry and leaves every other
 * byte alone. Keys are added to the table's existing header or dotted-key
 * group, after its last assignment; a missing table is appended at the end of
 * the file after one blank line, and removing such a trailing table removes
 * that blank line again. Removing a table stops after its last assignment
 * and the blank lines after it, so comments that follow stay. Paths into
 * inline tables or arrays of tables are
 * refused, as are arrays of tables in values.
 */
export const tomlEditor: FormatEditor = {
  format: "toml",
  parse,
  set(text, path, value) {
    const document = parse(text);
    if (!isRecord(value)) return setLeaf(text, document, path, value);
    const existing = getPath(document, path);
    let result = text;
    if (existing !== undefined && !isRecord(existing))
      result = removeEntry(result, path);
    if (isRecord(existing))
      for (const stale of staleEntries(existing, value, path))
        result = removeEntry(result, stale);
    const wanted = leaves(value, path);
    for (const [leaf, item] of wanted)
      result = setLeaf(result, parse(result), leaf, item);
    return result;
  },
  remove(text, path) {
    const document = parse(text);
    return getPath(document, path) === undefined
      ? text
      : removeEntry(text, path);
  },
};

function parse(text: string): Record<string, unknown> {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TomlError)
      throw new WiringError(
        "WIRING_CONFIG_UNPARSEABLE",
        `Invalid TOML at line ${error.line}, column ${error.column}`,
      );
    throw error;
  }
}

interface Header {
  kind: "header";
  path: string[];
  array: boolean;
  start: number;
  /** After the header line's break. */
  end: number;
}

interface Assignment {
  kind: "assignment";
  section: Header | undefined;
  /** Absolute key path; undefined inside an array of tables. */
  full: string[] | undefined;
  indent: string;
  start: number;
  /** After the line break that ends the value. */
  end: number;
  valueStart: number;
  valueEnd: number;
}

type Statement = Header | Assignment;

function setLeaf(
  text: string,
  document: Record<string, unknown>,
  path: KeyPath,
  value: ConfigValue,
): string {
  if (!path.length)
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A TOML value needs a key",
    );
  const current = getPath(document, path);
  if (isRecord(current) && !isRecord(value)) {
    const base = removeEntry(text, path);
    return setLeaf(base, parse(base), path, value);
  }
  const statements = scan(text);
  refuseArrayTables(statements, path);
  const assignments = statements.filter(
    (statement): statement is Assignment => statement.kind === "assignment",
  );
  refuseInlineTables(assignments, path);
  if (isRecord(value)) {
    // An empty object: make sure the table exists.
    if (isRecord(current)) return text;
    const base = current === undefined ? text : removeEntry(text, path);
    return appendTable(base, path, []);
  }
  const encoded = encode(value);
  const exact = assignments.find(
    (assignment) => assignment.full && sameKey(assignment.full, path),
  );
  if (exact)
    return (
      text.slice(0, exact.valueStart) + encoded + text.slice(exact.valueEnd)
    );
  const parent = path.slice(0, -1);
  const header = statements.find(
    (statement): statement is Header =>
      statement.kind === "header" &&
      !statement.array &&
      sameKey(statement.path, parent),
  );
  if (header) {
    const last = assignments.filter((a) => a.section === header).at(-1);
    return insertLine(
      text,
      last?.end ?? header.end,
      `${last?.indent ?? ""}${formatKey([path.at(-1)!])} = ${encoded}`,
    );
  }
  // Keys of the parent defined with dotted keys in an enclosing section.
  const dotted = assignments
    .filter(
      (a) =>
        a.full &&
        a.full.length > parent.length &&
        startsWith(a.full, parent) &&
        (a.section?.path.length ?? 0) <= parent.length,
    )
    .at(-1);
  if (dotted) {
    const relative = path.slice(dotted.section?.path.length ?? 0);
    return insertLine(
      text,
      dotted.end,
      `${dotted.indent}${formatKey(relative)} = ${encoded}`,
    );
  }
  if (parent.length)
    return appendTable(text, parent, [[path.at(-1)!, encoded]]);
  const first = statements.find((s) => s.kind === "header");
  return first
    ? insertLine(
        text,
        attachedStart(text, first.start),
        `${formatKey(path)} = ${encoded}`,
      )
    : insertLine(text, text.length, `${formatKey(path)} = ${encoded}`);
}

/** Removes an assignment, or a table with every header and dotted key under it. */
function removeEntry(text: string, path: KeyPath): string {
  const statements = scan(text);
  refuseArrayTables(statements, path, true);
  const assignments = statements.filter(
    (statement): statement is Assignment => statement.kind === "assignment",
  );
  refuseInlineTables(assignments, path);
  const ranges: Array<{ start: number; end: number; table: boolean }> = [];
  for (const statement of statements) {
    if (statement.kind === "assignment") {
      if (statement.full && startsWith(statement.full, path))
        ranges.push({
          start: statement.start,
          end: statement.end,
          table: false,
        });
      continue;
    }
    if (!startsWith(statement.path, path)) continue;
    // The section ends after its last assignment and the blank lines that
    // follow; comments after it may be the user's and stay.
    const last = assignments.filter((a) => a.section === statement).at(-1);
    ranges.push({
      start: statement.start,
      end: blankLinesAfter(text, last?.end ?? statement.end),
      table: true,
    });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  // A trailing table takes the blank line that separated it.
  const tail = merged.at(-1);
  if (tail?.table && tail.end === text.length)
    tail.start = blankLineBefore(text, tail.start);
  let result = text;
  for (const range of merged.reverse())
    result = result.slice(0, range.start) + result.slice(range.end);
  return result;
}

function refuseInlineTables(assignments: Assignment[], path: KeyPath): void {
  if (
    assignments.some(
      (assignment) =>
        assignment.full &&
        assignment.full.length < path.length &&
        startsWith(path, assignment.full),
    )
  )
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      `The TOML key ${formatPath(path)} is inside an inline table`,
    );
}

function refuseArrayTables(
  statements: Statement[],
  path: KeyPath,
  allowWhole = false,
): void {
  for (const statement of statements)
    if (
      statement.kind === "header" &&
      statement.array &&
      startsWith(path, statement.path) &&
      !(allowWhole && startsWith(statement.path, path))
    )
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        `The TOML key ${formatPath(path)} is inside an array of tables`,
      );
}

function appendTable(
  text: string,
  table: KeyPath,
  entries: Array<[string, string]>,
): string {
  const eol = lineBreak(text);
  let separator = "";
  if (text.length) {
    if (!text.endsWith("\n")) separator += eol;
    separator += eol;
  }
  const lines = [
    `[${formatKey(table)}]`,
    ...entries.map(([key, value]) => `${formatKey([key])} = ${value}`),
  ];
  return text + separator + lines.join(eol) + eol;
}

function insertLine(text: string, offset: number, line: string): string {
  const eol = lineBreak(text);
  const before = text.slice(0, offset);
  const lead = before.length && !before.endsWith("\n") ? eol : "";
  return before + lead + line + eol + text.slice(offset);
}

/** The start of the comment lines directly above a header (no blank line between). */
function attachedStart(text: string, headerStart: number): number {
  let start = headerStart;
  while (start > 0) {
    const previous = text.lastIndexOf("\n", start - 2) + 1;
    if (!/^[ \t]*#/.test(text.slice(previous, start))) break;
    start = previous;
  }
  return start;
}

function blankLinesAfter(text: string, offset: number): number {
  let end = offset;
  for (;;) {
    const blank = /^[ \t]*\r?\n/.exec(text.slice(end));
    if (!blank) return end;
    end += blank[0].length;
  }
}

function blankLineBefore(text: string, start: number): number {
  if (start === 0) return start;
  const previous = text.lastIndexOf("\n", start - 2) + 1;
  return /^[ \t]*\r?\n$/.test(text.slice(previous, start)) ? previous : start;
}

function lineBreak(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function sameKey(left: readonly string[], right: KeyPath): boolean {
  return left.length === right.length && startsWith(left, right);
}

/** Entries of `existing` that `wanted` does not have, at any depth. */
function staleEntries(
  existing: Record<string, unknown>,
  wanted: { [key: string]: ConfigValue },
  prefix: KeyPath,
): KeyPath[] {
  return Object.entries(existing).flatMap(([key, item]) => {
    const next = wanted[key];
    if (!Object.hasOwn(wanted, key) || next === undefined)
      return [[...prefix, key]];
    return isRecord(item) && isRecord(next)
      ? staleEntries(item, next, [...prefix, key])
      : [];
  });
}

const escapes: Record<string, string> = {
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

function quote(text: string): string {
  if (!text.isWellFormed())
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A TOML string must be valid Unicode",
    );
  return `"${text.replace(
    /[\\"\u0000-\u001f\u007f]/g,
    (character) =>
      escapes[character] ??
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )}"`;
}

function formatKey(path: KeyPath): string {
  return path
    .map((segment) =>
      /^[A-Za-z0-9_-]+$/.test(segment) ? segment : quote(segment),
    )
    .join(".");
}

function encode(value: ConfigValue): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isInteger(value) && Number.isSafeInteger(value))
      return String(value);
    if (Number.isFinite(value) && !Number.isInteger(value)) {
      const text = String(value);
      return /[.eE]/.test(text) ? text : `${text}.0`;
    }
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A TOML number must be finite and, if whole, a safe integer",
    );
  }
  if (Array.isArray(value))
    return `[${value
      .map((item) => {
        if (isRecord(item))
          throw new WiringError(
            "WIRING_UNSUPPORTED_STRUCTURE",
            "Arrays of tables are not written by wiring",
          );
        return encode(item);
      })
      .join(", ")}]`;
  throw new WiringError(
    "WIRING_UNSUPPORTED_STRUCTURE",
    "A TOML object value is written as a table",
  );
}

/** Statements of a document that `smol-toml` has already accepted. */
function scan(text: string): Statement[] {
  const statements: Statement[] = [];
  let section: Header | undefined;
  let position = 0;
  while (position < text.length) {
    const start = position;
    position = spaces(text, position);
    const character = text[position];
    if (character === undefined) break;
    if (character === "\n" || character === "\r" || character === "#") {
      position = nextLine(text, position);
      continue;
    }
    if (character === "[") {
      const array = text[position + 1] === "[";
      const key = readKey(text, position + (array ? 2 : 1));
      const end = nextLine(text, spaces(text, key.end) + (array ? 2 : 1));
      section = { kind: "header", path: key.segments, array, start, end };
      statements.push(section);
      position = end;
      continue;
    }
    const key = readKey(text, position);
    const valueStart = spaces(text, spaces(text, key.end) + 1);
    const valueEnd = valueExtent(text, valueStart);
    const end = nextLine(text, valueEnd);
    statements.push({
      kind: "assignment",
      section,
      full: section?.array
        ? undefined
        : [...(section?.path ?? []), ...key.segments],
      indent: text.slice(start, position),
      start,
      end,
      valueStart,
      valueEnd,
    });
    position = end;
  }
  return statements;
}

function spaces(text: string, position: number): number {
  while (text[position] === " " || text[position] === "\t") position++;
  return position;
}

function nextLine(text: string, position: number): number {
  const index = text.indexOf("\n", position);
  return index < 0 ? text.length : index + 1;
}

function readKey(
  text: string,
  position: number,
): { segments: string[]; end: number } {
  const segments: string[] = [];
  for (;;) {
    position = spaces(text, position);
    const character = text[position];
    if (character === '"' || character === "'") {
      const end = stringEnd(text, position, character);
      const body = text.slice(position + 1, end - 1);
      segments.push(character === '"' ? unescape(body) : body);
      position = end;
    } else {
      const bare = /[A-Za-z0-9_-]+/y;
      bare.lastIndex = position;
      const match = bare.exec(text);
      if (!match)
        throw new WiringError(
          "WIRING_CONFIG_UNPARSEABLE",
          "The TOML scanner could not read a key the parser accepted",
        );
      segments.push(match[0]);
      position = bare.lastIndex;
    }
    const after = spaces(text, position);
    if (text[after] !== ".") return { segments, end: position };
    position = after + 1;
  }
}

/** The end of a value, before trailing blanks and any comment. */
function valueExtent(text: string, position: number): number {
  let depth = 0;
  let last = position;
  while (position < text.length) {
    const character = text[position]!;
    if (character === '"' || character === "'") {
      position = stringEnd(text, position, character);
      last = position;
      continue;
    }
    if (character === "#") {
      const index = text.indexOf("\n", position);
      position = index < 0 ? text.length : index;
      if (depth === 0) return last;
      continue;
    }
    if (
      character === "\n" ||
      (character === "\r" && text[position + 1] === "\n")
    ) {
      if (depth === 0) return last;
      position += character === "\r" ? 2 : 1;
      continue;
    }
    if (character === "[" || character === "{") depth++;
    else if (character === "]" || character === "}") depth--;
    position++;
    if (character !== " " && character !== "\t") last = position;
  }
  return last;
}

/** The offset after the closing quote of the string starting at `position`. */
function stringEnd(text: string, position: number, quoteChar: string): number {
  const triple = text.startsWith(quoteChar.repeat(3), position);
  let index = position + (triple ? 3 : 1);
  while (index < text.length) {
    if (quoteChar === '"' && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (triple && text.startsWith(quoteChar.repeat(3), index)) {
      let end = index + 3;
      // Up to two quotes before the closing delimiter belong to the content.
      while (end < index + 5 && text[end] === quoteChar) end++;
      return end;
    }
    if (!triple && text[index] === quoteChar) return index + 1;
    index++;
  }
  return text.length;
}

function unescape(body: string): string {
  return body.replace(
    /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|(.))/g,
    (_, four?: string, eight?: string, two?: string, other?: string) => {
      const hex = four ?? eight ?? two;
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      const simple: Record<string, string> = {
        b: "\b",
        t: "\t",
        n: "\n",
        f: "\f",
        r: "\r",
        e: "\u001b",
        '"': '"',
        "\\": "\\",
      };
      return simple[other!] ?? other!;
    },
  );
}
