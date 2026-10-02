// SPDX-License-Identifier: MIT
import type { ConfigValue, KeyPath } from "./types.js";

/** A non-array object, including the null-prototype objects TOML parsers return. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** The value at `path`, or undefined when any segment is missing or not an object. */
export function getPath(root: unknown, path: KeyPath): unknown {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment))
      return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * The first proper prefix of `path` that holds something other than an object,
 * which would make setting `path` overwrite a user value; undefined otherwise.
 */
export function blockingPrefix(
  root: unknown,
  path: KeyPath,
): KeyPath | undefined {
  let current = root;
  for (let index = 0; index < path.length - 1; index++) {
    const segment = path[index]!;
    if (!isRecord(current) || !Object.hasOwn(current, segment))
      return undefined;
    current = current[segment];
    if (!isRecord(current)) return path.slice(0, index + 1);
  }
  return undefined;
}

/** Structural equality of parsed values; dates compare by their text. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left instanceof Date || right instanceof Date)
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.toISOString() === right.toISOString()
    );
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
    )
  );
}

/** A deep copy into plain objects, so callers can mutate it. */
export function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    );
  return value;
}

/** Deletes the entry at `path` from a plain-object tree; returns whether it existed. */
export function deletePath(root: unknown, path: KeyPath): boolean {
  if (!path.length) return false;
  const parent = getPath(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (!isRecord(parent) || !Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}

/** Stable text form of a key path, for sets and messages. */
export function pathKey(path: KeyPath): string {
  return JSON.stringify(path);
}

/** Human form of a key path, as `a.b."c.d"`. */
export function formatPath(path: KeyPath): string {
  return path
    .map((segment) =>
      /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment),
    )
    .join(".");
}

/** Whether `prefix` is a proper or equal prefix of `path`. */
export function startsWith(path: KeyPath, prefix: KeyPath): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every((segment, index) => path[index] === segment)
  );
}

/**
 * Leaves of an object value as `[relative path, value]`; scalars and arrays are
 * leaves, and an empty object is reported as a leaf so it is not lost.
 * Scalars of an object come before its nested objects.
 */
export function leaves(
  value: ConfigValue,
  prefix: KeyPath = [],
): Array<[KeyPath, ConfigValue]> {
  if (Array.isArray(value) || typeof value !== "object")
    return [[prefix, value]];
  const entries = Object.entries(value);
  if (!entries.length) return [[prefix, value]];
  const scalars = entries.filter(
    ([, item]) => Array.isArray(item) || typeof item !== "object",
  );
  const objects = entries.filter(
    ([, item]) => !Array.isArray(item) && typeof item === "object",
  );
  return [...scalars, ...objects].flatMap(([key, item]) =>
    leaves(item, [...prefix, key]),
  );
}
