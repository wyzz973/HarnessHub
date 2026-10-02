// SPDX-License-Identifier: MIT
/** Configuration file formats that global wiring can edit in place. */
export type ConfigFormat = "json" | "toml" | "yaml" | "dotenv";

/** A key path from the document root; every segment is an object key. */
export type KeyPath = readonly string[];

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
  /** Sets the value at `path`, creating missing parent objects. An object value replaces the entry entirely. */
  set(text: string, path: KeyPath, value: ConfigValue): string;
  /** Removes the entry at `path`; a missing entry leaves the text unchanged. */
  remove(text: string, path: KeyPath): string;
}
