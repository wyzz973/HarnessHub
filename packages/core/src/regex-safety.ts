// SPDX-License-Identifier: MIT
/**
 * Whether a JavaScript regular expression can backtrack without bound on
 * ordinary text. User redaction rules run on every string of every request
 * on the daemon's event loop, so a rule like `(\w+\s?)+$` (40 s on 45
 * characters) would stop the daemon. The check is conservative: it refuses
 *
 * - backreferences;
 * - a group repeated more than once that holds a repetition, an optional
 *   part or an alternation (`(a+)+`, `(a|ab)*`, `(ab?)+`, `(\w+\s?){2,}`):
 *   nested or ambiguous quantifiers, the exponential cases;
 * - two unbounded repetitions with only optional parts between them whose
 *   characters overlap (`\w+\w+`, `.*\s*.*`, `[a-z]+-?[a-z0-9]+`, also
 *   across groups: `\w+(?:\s?\w+)?`): the polynomial cases.
 *
 * Everything else, such as `sk-[A-Za-z0-9]{20,}`, `TCK-[0-9]+`,
 * `(?:token|key)=([^&\s]+)` or `[a-z]+(?:-[0-9]+)?`, is accepted. Patterns
 * are read as the redactor compiles them: without the `u` flag. A rule that
 * passes can still be slow on very long runs of the characters it repeats;
 * the redactor's time budget bounds that.
 */

type Atom =
  | { kind: "chars"; source: string }
  | { kind: "group"; body: Alternation; look: boolean }
  | { kind: "assertion" }
  | { kind: "backreference" };

interface Item {
  atom: Atom;
  min: number;
  max: number;
}

type Sequence = Item[];
type Alternation = Sequence[];

/** Repetitions this long or longer count as unbounded. */
const LONG = 16;

class Reader {
  index = 0;
  constructor(readonly text: string) {}
  get done(): boolean {
    return this.index >= this.text.length;
  }
  peek(offset = 0): string {
    return this.text[this.index + offset] ?? "";
  }
}

function parseAlternation(reader: Reader): Alternation {
  const branches: Alternation = [parseSequence(reader)];
  while (reader.peek() === "|") {
    reader.index++;
    branches.push(parseSequence(reader));
  }
  return branches;
}

function parseSequence(reader: Reader): Sequence {
  const items: Sequence = [];
  while (!reader.done && reader.peek() !== "|" && reader.peek() !== ")") {
    const atom = parseAtom(reader);
    const [min, max] = parseQuantifier(reader);
    items.push({ atom, min, max });
  }
  return items;
}

function parseAtom(reader: Reader): Atom {
  const start = reader.index;
  const char = reader.peek();
  if (char === "(") {
    reader.index++;
    let look = false;
    if (reader.peek() === "?") {
      const next = reader.peek(1);
      if (next === ":") reader.index += 2;
      else if (next === "=" || next === "!") {
        reader.index += 2;
        look = true;
      } else if (
        next === "<" &&
        (reader.peek(2) === "=" || reader.peek(2) === "!")
      ) {
        reader.index += 3;
        look = true;
      } else if (next === "<") {
        const end = reader.text.indexOf(">", reader.index);
        reader.index = end < 0 ? reader.text.length : end + 1;
      } else reader.index++;
    }
    const body = parseAlternation(reader);
    if (reader.peek() === ")") reader.index++;
    return { kind: "group", body, look };
  }
  if (char === "^" || char === "$") {
    reader.index++;
    return { kind: "assertion" };
  }
  if (char === "[") {
    reader.index++;
    if (reader.peek() === "^") reader.index++;
    // `[]` is an empty class and `[^]` any character: the first `]` closes.
    while (!reader.done && reader.peek() !== "]") {
      if (reader.peek() === "\\") reader.index++;
      reader.index++;
    }
    reader.index++;
    return { kind: "chars", source: reader.text.slice(start, reader.index) };
  }
  if (char === "\\") {
    const next = reader.peek(1);
    reader.index += 2;
    if (next === "b" || next === "B") return { kind: "assertion" };
    if (/[1-9]/.test(next) || next === "k") return { kind: "backreference" };
    if (next === "x") reader.index += 2;
    else if (next === "u") reader.index += 4;
    else if (next === "c") reader.index += 1;
    return {
      kind: "chars",
      source: reader.text.slice(
        start,
        Math.min(reader.index, reader.text.length),
      ),
    };
  }
  reader.index++;
  return { kind: "chars", source: char };
}

/** `[min, max]` of the quantifier at the reader, `[1, 1]` without one. */
function parseQuantifier(reader: Reader): [number, number] {
  let range: [number, number] | undefined;
  const char = reader.peek();
  if (char === "*") range = [0, Infinity];
  else if (char === "+") range = [1, Infinity];
  else if (char === "?") range = [0, 1];
  if (range) reader.index++;
  else if (char === "{") {
    // Without the u flag a `{` that is no quantifier is a literal brace.
    const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(
      reader.text.slice(reader.index),
    );
    if (!match) return [1, 1];
    reader.index += match[0].length;
    const min = Number(match[1]);
    range = [min, match[2] ? (match[3] ? Number(match[3]) : Infinity) : min];
  } else return [1, 1];
  if (reader.peek() === "?") reader.index++;
  return range;
}

/** Whether `item` can match the empty string. */
function nullable(item: Item): boolean {
  if (item.min === 0) return true;
  const { atom } = item;
  if (atom.kind === "assertion") return true;
  if (atom.kind === "group")
    return atom.look || atom.body.some((sequence) => sequence.every(nullable));
  return false;
}

/**
 * Whether an alternation can match text in more than one way: it has a
 * choice, or a part of it repeats or is optional (`(ab?)+` splits "abab"
 * two ways, as `(a|ab)+` does).
 */
function variable(body: Alternation): boolean {
  if (body.length > 1) return true;
  return body.some((sequence) =>
    sequence.some(
      (item) =>
        (item.min !== item.max && item.atom.kind !== "assertion") ||
        (item.atom.kind === "group" && variable(item.atom.body)),
    ),
  );
}

const SAMPLE = (() => {
  const chars: string[] = [];
  for (let code = 0; code < 128; code++) chars.push(String.fromCharCode(code));
  chars.push("é", "ß", "中", " ", " ", "😀");
  return chars;
})();

/** The sample characters an atom can start with, as a set; undefined for any. */
function firstChars(atom: Atom, flags: string): Set<string> | undefined {
  if (atom.kind === "chars") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${atom.source})`, flags);
    } catch {
      return undefined;
    }
    return new Set(SAMPLE.filter((char) => pattern.test(char)));
  }
  if (atom.kind === "group") {
    const all = new Set<string>();
    for (const sequence of atom.body)
      for (const item of sequence) {
        const chars = firstChars(item.atom, flags);
        if (!chars) return undefined;
        for (const char of chars) all.add(char);
        if (!nullable(item)) break;
      }
    return all;
  }
  return new Set();
}

function overlap(a: Set<string> | undefined, b: Set<string> | undefined) {
  if (!a || !b) return true;
  for (const char of a) if (b.has(char)) return true;
  return false;
}

/** The pattern, shortened, for a message. */
function shown(pattern: string): string {
  return pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
}

/** Whether `item` repeats without a useful bound. */
const long = (item: Item) => item.max >= LONG && item.atom.kind !== "assertion";

/**
 * The unbounded repetitions `item` can begin with (or, with `end`, end
 * with), through optional parts; a lookaround consumes nothing.
 */
function edges(item: Item, end: boolean): Item[] {
  if (long(item)) return [item];
  const { atom } = item;
  if (atom.kind !== "group" || atom.look) return [];
  const found: Item[] = [];
  for (const sequence of atom.body) {
    const ordered = end ? [...sequence].reverse() : sequence;
    for (const inner of ordered) {
      found.push(...edges(inner, end));
      if (!nullable(inner)) break;
    }
  }
  return found;
}

/**
 * Why `pattern` (compiled with `flags`) can backtrack without bound, or
 * undefined. Assumes it compiles; checks nothing else.
 */
export function regexHazard(pattern: string, flags = ""): string | undefined {
  const reader = new Reader(pattern);
  const body = parseAlternation(reader);
  const problems: string[] = [];
  const chars = new Map<Item, Set<string> | undefined>();
  const charsOf = (item: Item) => {
    if (!chars.has(item)) chars.set(item, firstChars(item.atom, flags));
    return chars.get(item);
  };
  const visit = (alternation: Alternation) => {
    for (const sequence of alternation) {
      // The unbounded repetitions that can end the text matched so far,
      // with only optional parts after them.
      let open: Item[] = [];
      for (const item of sequence) {
        const { atom } = item;
        if (atom.kind === "backreference") {
          problems.push("backreferences are not allowed");
          continue;
        }
        if (atom.kind === "group") {
          if (item.max > 1 && variable(atom.body))
            problems.push(
              "a repeated group holds a repetition or a choice (nested or ambiguous quantifiers); use a character class instead",
            );
          visit(atom.body);
        }
        const leads = edges(item, false);
        if (
          leads.some((lead) =>
            open.some((other) => overlap(charsOf(other), charsOf(lead))),
          )
        )
          problems.push(
            "two repetitions with only optional parts between them can match the same characters",
          );
        if (!nullable(item)) open = [];
        open.push(...edges(item, true));
      }
    }
  };
  visit(body);
  return problems[0] ? `${problems[0]} (${shown(pattern)})` : undefined;
}
