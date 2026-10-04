// SPDX-License-Identifier: MIT
import { isAlias, isMap, isSeq, parseDocument, type Document } from "yaml";
import { WiringError } from "../errors.js";
import type { FormatEditor, KeyPath } from "./types.js";
import { formatPath, isRecord, isSelector, selects } from "./values.js";

/**
 * YAML through the `yaml` Document API, which keeps comments, blank lines,
 * key order and scalar styles. Re-serialisation can still normalise
 * whitespace inside flow collections, so callers verify by value rather than
 * by bytes. Multi-document streams, a non-map root and anchors or aliases on
 * the edited path are refused. An element selector, as the last segment,
 * replaces the selected sequence item in place, appends a new item, or
 * removes the item; the other items keep their nodes and order. Before the
 * last segment it leads into the item, which must be there.
 */
export const yamlEditor: FormatEditor = {
  format: "yaml",
  parse(text) {
    const value: unknown = load(text).toJS();
    if (value === null || value === undefined) return {};
    if (!isRecord(value))
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        "The YAML document is not a mapping",
      );
    return value;
  },
  set(text, path, value) {
    const document = load(text);
    const keys = resolve(document, path);
    checkPath(document, keys);
    const last = path.at(-1);
    if (last !== undefined && isSelector(last)) {
      const parent = keys.slice(0, -1);
      const index = keys.at(-1);
      if (typeof index === "number") document.setIn([...parent, index], value);
      else if (document.hasIn(parent)) document.addIn(parent, value);
      else document.setIn(parent, [value]);
    } else document.setIn(keys, value);
    return render(document, text);
  },
  remove(text, path) {
    const document = load(text);
    const keys = resolve(document, path, false);
    checkPath(document, keys);
    if (keys.includes(undefined) || !document.hasIn(keys)) return text;
    document.deleteIn(keys);
    return render(document, text);
  },
};

/**
 * The document path of `path`: keys as they are, the last segment's selector
 * as the index of the item it picks, or undefined when it picks none. A
 * selector before the last segment that picks none fails when `strict` (a
 * field cannot be set in a missing item) and leaves the path absent
 * otherwise; several matching items and a non-sequence before a selector
 * are refused.
 */
function resolve(
  document: Document,
  path: KeyPath,
  strict = true,
): Array<string | number | undefined> {
  const keys: Array<string | number | undefined> = [];
  for (const [depth, segment] of path.entries()) {
    if (!isSelector(segment)) {
      keys.push(segment);
      continue;
    }
    const node: unknown = keys.includes(undefined)
      ? undefined
      : document.getIn(keys as Array<string | number>, true);
    if (node === undefined) {
      if (strict && depth !== path.length - 1)
        throw new WiringError(
          "WIRING_PATH_CONFLICT",
          `${formatPath(path.slice(0, depth + 1))} selects no item to set ${formatPath(path)} in`,
        );
      keys.push(undefined);
      continue;
    }
    if (!isSeq(node))
      throw new WiringError(
        "WIRING_PATH_CONFLICT",
        `${formatPath(path.slice(0, depth))} holds a value that is not a sequence`,
      );
    const found = node.items.flatMap((item, index) =>
      selects(segment, (item as { toJSON?: () => unknown }).toJSON?.() ?? item)
        ? [index]
        : [],
    );
    if (found.length > 1)
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        `${formatPath(path)} matches more than one item`,
      );
    if (strict && found[0] === undefined && depth !== path.length - 1)
      throw new WiringError(
        "WIRING_PATH_CONFLICT",
        `${formatPath(path.slice(0, depth + 1))} selects no item to set ${formatPath(path)} in`,
      );
    keys.push(found[0]);
  }
  return keys;
}

function load(text: string): Document {
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error?.code === "MULTIPLE_DOCS")
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "The YAML file holds more than one document",
    );
  if (error) {
    const at = error.linePos?.[0];
    throw new WiringError(
      "WIRING_CONFIG_UNPARSEABLE",
      `Invalid YAML${at ? ` at line ${at.line}, column ${at.col}` : ""} (${error.code})`,
    );
  }
  if (document.contents !== null && !isMap(document.contents))
    throw new WiringError(
      "WIRING_UNSUPPORTED_STRUCTURE",
      "The YAML document is not a mapping",
    );
  return document;
}

function checkPath(
  document: Document,
  path: ReadonlyArray<string | number | undefined>,
): void {
  for (let depth = 1; depth <= path.length; depth++) {
    const prefix = path.slice(0, depth);
    if (prefix.includes(undefined)) return;
    const node: unknown = document.getIn(
      prefix as Array<string | number>,
      true,
    );
    if (node === undefined) return;
    if (isAlias(node) || hasAnchor(node))
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        `The YAML path ${formatPath(prefix.map(String))} uses an anchor or alias`,
      );
  }
}

function hasAnchor(node: unknown): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    "anchor" in node &&
    typeof node.anchor === "string" &&
    node.anchor !== ""
  );
}

function render(document: Document, original: string): string {
  const indent = /^( +)\S/m.exec(original)?.[1]?.length ?? 2;
  const text = document.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    indent,
    indentSeq: !/^(\S[^\n]*:)[ \t]*\r?\n- /m.test(original),
  });
  return original.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text;
}
