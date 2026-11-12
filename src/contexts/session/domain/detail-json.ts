import type { NativeToolDetail } from "../../../contracts/control.js";

/*
 * A tool call's detail as the JSON the content store keeps it in, made in pieces. A detail is what the Harness reported of the call — its input, its output, its diff — and it is
 * kept whole, so one can be tens of MiB: the pieces are produced one after another and written as they are made, and neither one string nor one buffer of the whole is ever built.
 * Joined, the pieces are exactly what `JSON.stringify({ toolId, ...detail })` gives (the same keys in the same order, the same escapes), so a small detail is the same bytes it always was.
 */

/** The characters of a long string put into one piece. */
export const DETAIL_PIECE = 256 * 1024;
const encoder = new TextEncoder();
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

function* longString(text: string): Generator<Uint8Array> {
  yield encoder.encode('"');
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + DETAIL_PIECE);
    // A piece never ends between the two halves of a pair: each piece is escaped by itself, and half a pair would be written as a lone surrogate.
    if (to < text.length && isHigh(text.charCodeAt(to - 1))) to--;
    yield encoder.encode(JSON.stringify(text.slice(from, to)).slice(1, -1));
    from = to;
  }
  yield encoder.encode('"');
}
/** The detail of one call as JSON, in pieces. */
export function* detailJson(toolId: string, detail: NativeToolDetail): Generator<Uint8Array> {
  yield encoder.encode("{");
  let first = true;
  for (const [key, value] of Object.entries({ toolId, ...detail })) {
    if (value === undefined) continue;
    yield encoder.encode((first ? "" : ",") + JSON.stringify(key) + ":");
    first = false;
    if (typeof value === "string" && value.length > DETAIL_PIECE) yield* longString(value);
    else yield encoder.encode(JSON.stringify(value));
  }
  yield encoder.encode("}");
}
