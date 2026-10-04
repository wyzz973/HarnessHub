// SPDX-License-Identifier: MIT
import type {
  ConfigValue,
  ElementSelector,
  KeyPath,
  PathSegment,
} from "./types.js";

/** A non-array object, including the null-prototype objects TOML parsers return. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

/** Whether a path segment selects an array element rather than naming a key. */
export function isSelector(segment: PathSegment): segment is ElementSelector {
  return typeof segment !== "string";
}

/** Whether `item` is an element `selector` selects. */
export function selects(selector: ElementSelector, item: unknown): boolean {
  if ("equals" in selector) return item === selector.equals;
  return (
    isRecord(item) &&
    Object.entries(selector.match).every(
      ([key, value]) => Object.hasOwn(item, key) && item[key] === value,
    )
  );
}

/** The indexes of the elements of `array` that `selector` selects. */
export function selected(
  array: readonly unknown[],
  selector: ElementSelector,
): number[] {
  return array.flatMap((item, index) =>
    selects(selector, item) ? [index] : [],
  );
}

/** One step down: a key of an object or the single element a selector picks. */
function child(current: unknown, segment: PathSegment): unknown {
  if (isSelector(segment)) {
    if (!Array.isArray(current)) return undefined;
    const found = selected(current, segment);
    return found.length === 1 ? current[found[0]!] : undefined;
  }
  return isRecord(current) && Object.hasOwn(current, segment)
    ? current[segment]
    : undefined;
}

/**
 * The value at `path`, or undefined when any segment is missing, crosses a
 * value of another kind, or selects no element or several.
 */
export function getPath(root: unknown, path: KeyPath): unknown {
  let current = root;
  for (const segment of path) {
    current = child(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * The first proper prefix of `path` that holds a value of the wrong kind for
 * the next segment (not an object before a key, not an array before an
 * element selector), which would make setting `path` overwrite a user value;
 * undefined otherwise.
 */
export function blockingPrefix(
  root: unknown,
  path: KeyPath,
): KeyPath | undefined {
  let current = root;
  for (let index = 0; index < path.length - 1; index++) {
    current = child(current, path[index]!);
    if (current === undefined) return undefined;
    const next = path[index + 1]!;
    if (isSelector(next) ? !Array.isArray(current) : !isRecord(current))
      return path.slice(0, index + 1);
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

/** Deletes the entry or selected element at `path` from a plain tree; returns whether it existed. */
export function deletePath(root: unknown, path: KeyPath): boolean {
  if (!path.length) return false;
  const parent = getPath(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (isSelector(last)) {
    if (!Array.isArray(parent)) return false;
    const found = selected(parent, last);
    if (found.length !== 1) return false;
    parent.splice(found[0]!, 1);
    return true;
  }
  if (!isRecord(parent) || !Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}

/** A segment in a canonical form: a selector's fields sorted by name. */
function canonical(segment: PathSegment): unknown {
  if (!isSelector(segment)) return segment;
  if ("equals" in segment) return { equals: segment.equals };
  return {
    match: Object.fromEntries(
      Object.entries(segment.match).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  };
}

/** Stable text form of a key path, for sets and comparisons. */
export function pathKey(path: KeyPath): string {
  return JSON.stringify(path.map(canonical));
}

/** Human form of a key path, as `a.b."c.d"[id="x"]`. */
export function formatPath(path: KeyPath): string {
  return path
    .map((segment, index) => {
      if (isSelector(segment))
        return "equals" in segment
          ? `[${JSON.stringify(segment.equals)}]`
          : `[${Object.entries(segment.match)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(",")}]`;
      const text = /^[A-Za-z0-9_-]+$/.test(segment)
        ? segment
        : JSON.stringify(segment);
      return index ? `.${text}` : text;
    })
    .join("");
}

/** Whether `prefix` is a proper or equal prefix of `path`. */
export function startsWith(path: KeyPath, prefix: KeyPath): boolean {
  return (
    prefix.length <= path.length &&
    prefix.every(
      (segment, index) => pathKey([segment]) === pathKey([path[index]!]),
    )
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
