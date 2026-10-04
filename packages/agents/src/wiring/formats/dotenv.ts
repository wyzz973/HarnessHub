// SPDX-License-Identifier: MIT
import { WiringError } from "../errors.js";
import type { ConfigValue, FormatEditor, KeyPath } from "./types.js";

interface Entry {
  key: string;
  value: string;
  /** Offsets of the line(s) holding the entry, the end including its line break. */
  start: number;
  end: number;
  /** Offsets of the raw value text, quotes included. */
  valueStart: number;
  valueEnd: number;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN = /^[A-Za-z0-9_./:@+,=%~-]*$/;

/**
 * dotenv files as the `dotenv` package reads them (Gemini CLI, Qwen Code):
 * `KEY=value` lines with optional `export`, quoted values that may span
 * lines, and `#` comments. Lines that are not assignments are kept as they
 * are, like the reader ignores them. An unterminated quote is a parse error.
 * Paths have exactly one segment; values are written unquoted when they are
 * plain, else single-quoted (literal for every reader), and a value that
 * needs anything else is refused.
 */
export const dotenvEditor: FormatEditor = {
  format: "dotenv",
  parse(text) {
    const values: Record<string, string> = {};
    for (const entry of scan(text)) values[entry.key] = entry.value;
    return values;
  },
  set(text, path, value) {
    const key = single(path);
    const encoded = encode(key, value);
    const entry = unique(text, key);
    if (entry)
      return (
        text.slice(0, entry.valueStart) + encoded + text.slice(entry.valueEnd)
      );
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const separator = text === "" || text.endsWith("\n") ? "" : eol;
    return `${text}${separator}${key}=${encoded}${eol}`;
  },
  remove(text, path) {
    const entry = unique(text, single(path));
    return entry ? text.slice(0, entry.start) + text.slice(entry.end) : text;
  },
};

function single(path: KeyPath): string {
  const key = path[0];
  if (path.length !== 1 || typeof key !== "string" || !KEY.test(key))
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "A dotenv key path is one variable name",
    );
  return key;
}

function unique(text: string, key: string): Entry | undefined {
  const matches = scan(text).filter((entry) => entry.key === key);
  if (matches.length > 1)
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      `The variable ${key} is assigned more than once`,
    );
  return matches[0];
}

function encode(key: string, value: ConfigValue): string {
  if (typeof value === "object")
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      `The value of ${key} must be a string, number or boolean in a dotenv file`,
    );
  const text = String(value);
  if (PLAIN.test(text)) return text;
  if (!/['\r\n]/.test(text)) return `'${text}'`;
  throw new WiringError(
    "WIRING_UNSUPPORTED_STRUCTURE",
    `The value of ${key} cannot be written literally in a dotenv file`,
  );
}

function scan(text: string): Entry[] {
  const entries: Entry[] = [];
  let position = 0;
  while (position < text.length) {
    const start = position;
    const lineEnd = endOfLine(text, position);
    const line = text.slice(position, lineEnd);
    const match =
      /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/.exec(
        line,
      );
    if (!match) {
      position = afterBreak(text, lineEnd);
      continue;
    }
    const valueStart = start + match[0].length;
    const quote = text[valueStart];
    let valueEnd: number;
    let value: string;
    if (quote === "'" || quote === '"' || quote === "`") {
      let index = valueStart + 1;
      while (index < text.length && text[index] !== quote)
        index += text[index] === "\\" && text[index + 1] === quote ? 2 : 1;
      if (index >= text.length) {
        const line = text.slice(0, start).split("\n").length;
        throw new WiringError(
          "WIRING_CONFIG_UNPARSEABLE",
          `Unterminated quoted value at line ${line}`,
        );
      }
      valueEnd = index + 1;
      value = text.slice(valueStart + 1, index);
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      position = afterBreak(text, endOfLine(text, valueEnd));
    } else {
      const hash = line.indexOf("#", match[0].length);
      const raw = line.slice(match[0].length, hash < 0 ? undefined : hash);
      value = raw.trim();
      valueEnd = valueStart + raw.trimEnd().length;
      position = afterBreak(text, lineEnd);
    }
    entries.push({
      key: match[1]!,
      value,
      start,
      end: position,
      valueStart,
      valueEnd,
    });
  }
  return entries;
}

function endOfLine(text: string, from: number): number {
  const index = text.indexOf("\n", from);
  if (index < 0) return text.length;
  return index > from && text[index - 1] === "\r" ? index - 1 : index;
}

function afterBreak(text: string, lineEnd: number): number {
  if (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n") return lineEnd + 2;
  return text[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;
}
