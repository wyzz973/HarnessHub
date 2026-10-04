// SPDX-License-Identifier: MIT
import {
  getNodeValue,
  parse,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { WiringError } from "../errors.js";
import type { ConfigValue, FormatEditor, KeyPath } from "./types.js";
import { formatPath, isRecord, isSelector, selects } from "./values.js";

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
 * strict: comments and trailing commas are never introduced. An array element
 * is addressed by a selector: as the last path segment it is replaced where
 * it is, appended after the last element in the same way as a property, or
 * removed with its own lines, so the other elements keep their bytes and
 * order; before the last segment it leads into the element, which must be
 * there. A document whose root is a list is addressed with a selector as
 * the first segment (`parseRoot` reads it; `parse` refuses it).
 */
export const jsonEditor: FormatEditor = {
  format: "json",
  parse(text) {
    return parseObject(text);
  },
  parseRoot(text) {
    return parseRoot(text);
  },
  set(text, path, value) {
    parseRoot(text);
    const style = styleOf(text);
    const root = parseTree(text, [], parseOptions);
    if (!root) {
      if (isSelector(path[0]!)) throw conflict(path, 0, "an object");
      const lead = text === "" || text.endsWith("\n") ? "" : style.eol;
      return `${text}${lead}${render(nest(path, value), "", style)}${style.eol}`;
    }
    let node = root;
    for (let depth = 0; depth < path.length; depth++) {
      const segment = path[depth]!;
      if (isSelector(segment)) {
        if (node.type !== "array") throw conflict(path, depth, "an array");
        const element = only(node, path, depth);
        if (depth < path.length - 1) {
          if (!element) throw missingElement(path, depth);
          node = element;
          continue;
        }
        return element
          ? replace(text, element, element, value, style)
          : insertChild(
              text,
              node,
              (indent, inline) =>
                inline ? renderInline(value) : render(value, indent, style),
              style,
            );
      }
      if (node.type !== "object") throw conflict(path, depth, "an object");
      const property = find(node, path, depth);
      if (!property)
        return insertChild(
          text,
          node,
          (indent, inline) =>
            member(
              segment,
              nest(path.slice(depth + 1), value),
              indent,
              style,
              inline,
            ),
          style,
        );
      const valueNode = property.children![1]!;
      if (depth === path.length - 1)
        return replace(text, property, valueNode, value, style);
      node = valueNode;
    }
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A JSON value needs a key",
    );
  },
  remove(text, path) {
    parseRoot(text);
    let node = parseTree(text, [], parseOptions);
    for (let depth = 0; node && depth < path.length; depth++) {
      const segment = path[depth]!;
      if (isSelector(segment)) {
        if (node.type !== "array") return text;
        const element = only(node, path, depth);
        if (!element) return text;
        if (depth === path.length - 1)
          return removeProperty(text, node, element);
        node = element;
        continue;
      }
      if (node.type !== "object") return text;
      const property = find(node, path, depth);
      if (!property) return text;
      if (depth === path.length - 1)
        return removeProperty(text, node, property);
      node = property.children![1];
    }
    return text;
  },
};

/** An entry inside an element can be set only while the element is there; elements are added whole. */
function missingElement(path: KeyPath, depth: number): WiringError {
  return new WiringError(
    "WIRING_PATH_CONFLICT",
    `${formatPath(path.slice(0, depth + 1))} selects no element to set ${formatPath(path)} in`,
  );
}

function conflict(path: KeyPath, depth: number, kind: string): WiringError {
  return new WiringError(
    "WIRING_PATH_CONFLICT",
    `${formatPath(path.slice(0, depth))} holds a value that is not ${kind}`,
  );
}

/** The element the selector `path[depth]` picks in `array`; several are refused. */
function only(array: Node, path: KeyPath, depth: number): Node | undefined {
  const selector = path[depth]!;
  if (!isSelector(selector)) return undefined;
  const matches = (array.children ?? []).filter((item) =>
    selects(selector, getNodeValue(item)),
  );
  if (matches.length > 1)
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      `${formatPath(path.slice(0, depth + 1))} matches more than one element`,
    );
  return matches[0];
}

interface Style {
  unit: string;
  eol: string;
}

function parseObject(text: string): Record<string, unknown> {
  const value = parseRoot(text);
  if (Array.isArray(value))
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "The JSON document is not an object",
    );
  return value;
}

/** An object or a list; anything else is refused. */
function parseRoot(text: string): Record<string, unknown> | unknown[] {
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
  if (!isRecord(value) && !Array.isArray(value))
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "The JSON document is not an object",
    );
  return value as Record<string, unknown> | unknown[];
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

/**
 * Adds an entry (a property or an array element, as `entry` renders it at an
 * indentation, inline or not) after the last one of `container`.
 */
function insertChild(
  text: string,
  container: Node,
  entry: (indent: string, inline: boolean) => string,
  style: Style,
): string {
  const children = container.children ?? [];
  const close = container.offset + container.length - 1;
  const last = children.at(-1);
  if (!last) {
    // An empty container: open it onto its own lines, keeping comments inside.
    const indent = indentAt(text, container.offset);
    const inner = text.slice(container.offset + 1, close);
    const keep = inner.trimEnd();
    const child = indent + style.unit;
    return (
      text.slice(0, container.offset + 1) +
      keep +
      style.eol +
      child +
      entry(child, false) +
      style.eol +
      indent +
      text.slice(close)
    );
  }
  const lastEnd = last.offset + last.length;
  const comma = commaAfter(text, lastEnd);
  if (!startsLine(text, last.offset)) {
    // An inline container stays on one line.
    const line = entry("", true);
    return comma === undefined
      ? `${text.slice(0, lastEnd)}, ${line}${text.slice(lastEnd)}`
      : `${text.slice(0, comma + 1)} ${line},${text.slice(comma + 1)}`;
  }
  const indent = indentAt(text, last.offset);
  const rendered = entry(indent, false);
  const anchor = comma ?? lastEnd;
  const lineEnd = endOfLine(text, anchor + (comma === undefined ? 0 : 1));
  // Insert at the end of the line unless the container closes on it.
  const at =
    lineEnd <= close ? lineEnd : anchor + (comma === undefined ? 0 : 1);
  const line = `${style.eol}${indent}${rendered}${comma === undefined ? "" : ","}`;
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
  const removed = removeChild(text, object, property);
  if ((object.children ?? []).length !== 1) return removed;
  // The last entry gone: an object or array left with only blanks inside
  // closes up again, as one opened for an entry was before.
  const open = object.offset;
  const close = removed.indexOf(object.type === "array" ? "]" : "}", open + 1);
  return close > open && removed.slice(open + 1, close).trim() === ""
    ? removed.slice(0, open + 1) + removed.slice(close)
    : removed;
}

function removeChild(text: string, object: Node, property: Node): string {
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

/** `value` wrapped in the objects (and, for a selector, the array) `path` names. */
function nest(path: KeyPath, value: ConfigValue): ConfigValue {
  return path.reduceRight<ConfigValue>(
    (inner, segment) => (isSelector(segment) ? [inner] : { [segment]: inner }),
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
