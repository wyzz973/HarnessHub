// SPDX-License-Identifier: MIT
/** Configuration file formats that global wiring can edit in place. */
export type ConfigFormat = "json" | "toml" | "yaml" | "dotenv";

/**
 * One element of an array: the object whose fields have exactly these
 * string values, or the scalar equal to `equals`. Wiring owns such elements
 * one by one, so the user's other elements and their order are kept.
 */
export type ElementSelector =
  | { readonly match: Readonly<Record<string, string>> }
  | { readonly equals: string };

/** An object key, or an element of an array (only as the last segment of an edit). */
export type PathSegment = string | ElementSelector;

/** A key path from the document root. */
export type KeyPath = readonly PathSegment[];

/** A value wiring writes. There is no null: TOML and dotenv cannot express it. */
export type ConfigValue =
  string | number | boolean | ConfigValue[] | { [key: string]: ConfigValue };

/**
 * A format-preserving editor. `set` and `remove` change only the bytes of the
 * addressed entry (plus the containers `set` creates); comments, ordering,
 * indentation, line endings and every other entry stay as they were. Both
 * take and return text without a byte order mark and throw `WiringError`:
 * WIRING_CONFIG_UNPARSEABLE for invalid input and WIRING_UNSUPPORTED_STRUCTURE
 * when the entry sits in a structure that cannot be edited in place (a TOML
 * inline table, a YAML alias, a duplicated JSON key, ...). Callers check that
 * no ancestor of the path holds a non-object value before calling `set`.
 */
export interface FormatEditor {
  readonly format: ConfigFormat;
  /** Parses the whole document; an empty text is an empty document. */
  parse(text: string): Record<string, unknown>;
  /**
   * Sets the value at `path`, creating missing parent objects. An object value
   * replaces the entry entirely. A last segment that selects an array element
   * replaces that element in place or, when there is none, appends the value
   * to the array (created when missing). Editors that cannot address elements
   * (TOML, dotenv) fail with WIRING_UNSUPPORTED_STRUCTURE, as does a selector
   * before the last segment or one that matches several elements.
   */
  set(text: string, path: KeyPath, value: ConfigValue): string;
  /** Removes the entry or element at `path`; a missing one leaves the text unchanged. */
  remove(text: string, path: KeyPath): string;
}
