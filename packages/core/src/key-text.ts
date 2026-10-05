// SPDX-License-Identifier: MIT
/**
 * Gateway Key text in what HarnessHub logs, records or echoes: log lines,
 * access-log and ledger paths, error bodies. A key reaches such text when a
 * client puts it somewhere the gateway does not take it from, such as a
 * request path in another case or with a segment encoded. Not only the
 * issued form is taken out: text one character short of a key, in another
 * case, or with its underscore percent-encoded still gives most of the key
 * away.
 */

/**
 * `hhk_` in any case, its underscore possibly percent-encoded, and the key
 * characters (and percent escapes) after it.
 */
const KEY_TEXT = /hhk(?:_|%5f)[A-Za-z0-9_%-]*/gi;
/**
 * A key without its `hhk_`: the scope letter, the key id and the secret,
 * which is all a key holds.
 */
const BARE_KEY = /(?<![A-Za-z0-9])[asc]_[a-z2-7]{12}_[A-Za-z0-9_-]{8,}/gi;
/** The segment after a `/k/` (a key's place in a path, ADR 0033), `k` in any case or encoded. */
const KEY_SEGMENT = /(^|\/)(k|%6b)\/[^/?#]+/gi;

/** Replaces Gateway Key text. */
export const REDACTED_KEY = "[REDACTED]";

/**
 * `text` with every run of Gateway Key text, as described above, and every
 * key without its `hhk_` prefix, replaced by {@link REDACTED_KEY}. Pure;
 * safe on any string.
 */
export function redactKeyText(text: string): string {
  return text.replace(KEY_TEXT, REDACTED_KEY).replace(BARE_KEY, REDACTED_KEY);
}

/**
 * A request path as it may be logged, recorded or echoed: Gateway Key text
 * redacted ({@link redactKeyText}) and the segment after any `/k/` replaced
 * by {@link REDACTED_KEY}, whatever it holds. Pure.
 */
export function keylessPath(path: string): string {
  return redactKeyText(path).replace(KEY_SEGMENT, `$1$2/${REDACTED_KEY}`);
}
