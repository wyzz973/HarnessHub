// SPDX-License-Identifier: MIT
import { isAlias, isMap, parseDocument, type Document } from "yaml";
import { WiringError } from "../errors.js";
import type { FormatEditor, KeyPath } from "./types.js";
import { formatPath, isRecord } from "./values.js";

/**
 * YAML through the `yaml` Document API, which keeps comments, blank lines,
 * key order and scalar styles. Re-serialisation can still normalise
 * whitespace inside flow collections, so callers verify by value rather than
 * by bytes. Multi-document streams, a non-map root and anchors or aliases on
 * the edited path are refused.
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
    checkPath(document, path);
    document.setIn([...path], value);
    return render(document, text);
  },
  remove(text, path) {
    const document = load(text);
    checkPath(document, path);
    if (!document.hasIn([...path])) return text;
    document.deleteIn([...path]);
    return render(document, text);
  },
};

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

function checkPath(document: Document, path: KeyPath): void {
  for (let depth = 1; depth <= path.length; depth++) {
    const node: unknown = document.getIn(path.slice(0, depth), true);
    if (node === undefined) return;
    if (isAlias(node) || hasAnchor(node))
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        `The YAML path ${formatPath(path.slice(0, depth))} uses an anchor or alias`,
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
