// SPDX-License-Identifier: MIT
import {
  parse,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { WiringError } from "../errors.js";
import type { ConfigValue, FormatEditor, KeyPath } from "./types.js";
import { formatPath, isRecord } from "./values.js";

const parseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
  allowEmptyContent: true,
};

/**
 * JSON with comments and trailing commas (JSONC). `jsonc-parser` parses and
 * gives node offsets; edits splice text at those offsets and never reformat
 * existing lines. A new property goes after the last one of its object, on
 * its own line with that line's indentation (inline objects stay inline), and
 * follows the object's trailing-comma style; a comment at the end of the
 * previous line stays on that line. Removal deletes the property's own lines,
 * or its span in an inline object, plus the separating comma, so that
 * removing what was added restores the original bytes. Strict JSON files stay
 * strict: comments and trailing commas are never introduced.
 */
export const jsonEditor: FormatEditor = {
  format: "json",
  parse(text) {
    return parseObject(text);
  },
  set(text, path, value) {
    parseObject(text);
    const style = styleOf(text);
    const root = parseTree(text, [], parseOptions);
    if (!root) {
      const lead = text === "" || text.endsWith("\n") ? "" : style.eol;
      return `${text}${lead}${render(nest(path, value), "", style)}${style.eol}`;
    }
    let object = root;
    for (let depth = 0; depth < path.length; depth++) {
      if (object.type !== "object")
        throw new WiringError(
          "WIRING_PATH_CONFLICT",
          `${formatPath(path.slice(0, depth))} holds a value that is not an object`,
        );
      const property = find(object, path, depth);
      if (!property)
        return insert(
          text,
          object,
          path[depth]!,
          nest(path.slice(depth + 1), value),
          style,
        );
      const valueNode = property.children![1]!;
      if (depth === path.length - 1)
        return replace(text, property, valueNode, value, style);
      object = valueNode;
    }
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A JSON value needs a key",
    );
  },
  remove(text, path) {
    parseObject(text);
    let object = parseTree(text, [], parseOptions);
    for (let depth = 0; object && depth < path.length; depth++) {
      if (object.type !== "object") return text;
      const property = find(object, path, depth);
      if (!property) return text;
      if (depth === path.length - 1)
        return removeProperty(text, object, property);
      object = property.children![1];
    }
    return text;
  },
};

interface Style {
  unit: string;
  eol: string;
}

function parseObject(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, parseOptions);
  const first = errors[0];
  if (first) {
    const { line, column } = position(text, first.offset);
    throw new WiringError(
      "WIRING_CONFIG_UNPARSEABLE",
      `Invalid JSON at line ${line}, column ${column} (${printParseErrorCode(first.error)})`,
    );
  }
  if (value === undefined) return {};
  if (!isRecord(value))
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "The JSON document is not an object",
    );
  return value;
}

/** The property named `path[depth]`; a duplicated name makes the effective value reader-dependent and is refused. */
function find(object: Node, path: KeyPath, depth: number): Node | undefined {
  const matches = (object.children ?? []).filter(
    (property) => property.children?.[0]?.value === path[depth],
  );
  if (matches.length > 1)
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      `The JSON key ${formatPath(path.slice(0, depth + 1))} appears more than once`,
    );
  return matches[0];
}

function insert(
  text: string,
  object: Node,
  key: string,
  value: ConfigValue,
  style: Style,
): string {
  const properties = object.children ?? [];
  const close = object.offset + object.length - 1;
  const last = properties.at(-1);
  if (!last) {
    // An empty object: open it onto its own lines, keeping comments inside.
    const indent = indentAt(text, object.offset);
    const inner = text.slice(object.offset + 1, close);
    const keep = inner.trimEnd();
    const child = indent + style.unit;
    return (
      text.slice(0, object.offset + 1) +
      keep +
      style.eol +
      child +
      member(key, value, child, style, false) +
      style.eol +
      indent +
      text.slice(close)
    );
  }
  const lastEnd = last.offset + last.length;
  const comma = commaAfter(text, lastEnd);
  if (!startsLine(text, last.offset)) {
    // An inline object stays on one line.
    const entry = member(key, value, "", style, true);
    return comma === undefined
      ? `${text.slice(0, lastEnd)}, ${entry}${text.slice(lastEnd)}`
      : `${text.slice(0, comma + 1)} ${entry},${text.slice(comma + 1)}`;
  }
  const indent = indentAt(text, last.offset);
  const entry = member(key, value, indent, style, false);
  const anchor = comma ?? lastEnd;
  const lineEnd = endOfLine(text, anchor + (comma === undefined ? 0 : 1));
  // Insert at the end of the line unless the object closes on it.
  const at =
    lineEnd <= close ? lineEnd : anchor + (comma === undefined ? 0 : 1);
  const line = `${style.eol}${indent}${entry}${comma === undefined ? "" : ","}`;
  if (comma !== undefined) return text.slice(0, at) + line + text.slice(at);
  return (
    text.slice(0, lastEnd) +
    "," +
    text.slice(lastEnd, at) +
    line +
    text.slice(at)
  );
}

function replace(
  text: string,
  property: Node,
  valueNode: Node,
  value: ConfigValue,
  style: Style,
): string {
  const inline = !startsLine(text, property.offset);
  return (
    text.slice(0, valueNode.offset) +
    (inline
      ? renderInline(value)
      : render(value, indentAt(text, property.offset), style)) +
    text.slice(valueNode.offset + valueNode.length)
  );
}

function removeProperty(text: string, object: Node, property: Node): string {
  const properties = object.children ?? [];
  const index = properties.indexOf(property);
  const end = property.offset + property.length;
  const comma = commaAfter(text, end);
  const previous = properties[index - 1];
  const after = comma === undefined ? end : comma + 1;
  if (startsLine(text, property.offset) && restOfLineIsTrivia(text, after)) {
    const start = lineStart(text, property.offset);
    const stop = afterLineBreak(text, endOfLine(text, after));
    let result = text.slice(0, start) + text.slice(stop);
    // The last property leaves no trailing comma behind on the previous one.
    if (comma === undefined && previous) {
      const separator = commaAfter(text, previous.offset + previous.length);
      if (separator !== undefined)
        result = result.slice(0, separator) + result.slice(separator + 1);
    }
    return result;
  }
  if (comma !== undefined) {
    let stop = comma + 1;
    while (text[stop] === " " || text[stop] === "\t") stop++;
    return text.slice(0, property.offset) + text.slice(stop);
  }
  if (previous)
    return text.slice(0, previous.offset + previous.length) + text.slice(end);
  return text.slice(0, property.offset) + text.slice(end);
}

function member(
  key: string,
  value: ConfigValue,
  indent: string,
  style: Style,
  inline: boolean,
): string {
  return `${JSON.stringify(key)}: ${inline ? renderInline(value) : render(value, indent, style)}`;
}

function render(value: ConfigValue, indent: string, style: Style): string {
  return JSON.stringify(value, null, style.unit)
    .split("\n")
    .join(style.eol + indent);
}

function renderInline(value: ConfigValue): string {
  if (Array.isArray(value)) return `[${value.map(renderInline).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length
      ? `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${renderInline(item)}`).join(", ")} }`
      : "{}";
  }
  return JSON.stringify(value);
}

function nest(path: KeyPath, value: ConfigValue): ConfigValue {
  return path.reduceRight<ConfigValue>(
    (inner, key) => ({ [key]: inner }),
    value,
  );
}

/** The offset of the comma that follows a value, skipping blanks and comments. */
function commaAfter(text: string, offset: number): number | undefined {
  const next = skipTrivia(text, offset);
  return text[next] === "," ? next : undefined;
}

function skipTrivia(text: string, offset: number): number {
  let position = offset;
  for (;;) {
    while (/\s/.test(text[position] ?? "")) position++;
    if (text.startsWith("//", position)) {
      const end = text.indexOf("\n", position);
      position = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", position)) {
      const end = text.indexOf("*/", position + 2);
      position = end < 0 ? text.length : end + 2;
    } else return position;
  }
}

function restOfLineIsTrivia(text: string, offset: number): boolean {
  const rest = text.slice(offset, endOfLine(text, offset)).trim();
  return (
    rest === "" ||
    rest.startsWith("//") ||
    (rest.startsWith("/*") && rest.endsWith("*/"))
  );
}

function startsLine(text: string, offset: number): boolean {
  return text.slice(lineStart(text, offset), offset).trim() === "";
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

/** The offset of the line break (or end of text) at or after `offset`. */
function endOfLine(text: string, offset: number): number {
  const index = text.indexOf("\n", offset);
  if (index < 0) return text.length;
  return text[index - 1] === "\r" ? index - 1 : index;
}

function afterLineBreak(text: string, offset: number): number {
  if (text.startsWith("\r\n", offset)) return offset + 2;
  return text[offset] === "\n" ? offset + 1 : offset;
}

function indentAt(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))![0];
}

/** The file's indentation unit and line ending; two spaces and LF for a new file. */
function styleOf(text: string): Style {
  const indent = /^([ \t]+)["/}\]]/m.exec(text)?.[1];
  return {
    unit: indent?.startsWith("\t") ? "\t" : (indent ?? "  "),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function position(text: string, offset: number) {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1]!.length + 1 };
}
