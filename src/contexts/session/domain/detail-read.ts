import type { ContentPort, ContentRef } from "../../../contracts/content.js";
import { SessionError } from "../../../contracts/session.js";
import { scanDetail, type FieldPolicy, type ScannedDetail, type ScannedText } from "./detail-scan.js";

/*
 * A stored tool detail as the readers take it (finding 1 of the cut review). A detail is kept whole, however large; what a reader needs of it is its command, its paths and, of a large
 * output or diff, the part it can use. So a detail is read in one pass (`scanDetail`), and each text keeps what the reader's policy asks: all of it up to a length, else its first
 * and last characters with its length — never "too large, not read". The reader says what it kept: the packet's note on an output it does not carry, the table's note on a page
 * of a text that is only its ends.
 */

/** What a reader keeps of each of a detail's three texts. */
export interface DetailPolicy { readonly input: FieldPolicy; readonly output: FieldPolicy; readonly diff: FieldPolicy }
/** One text of a detail as read: all of it, or its ends and how long it is. */
export type DetailText =
  | { readonly cut: false; readonly text: string }
  | { readonly cut: true; readonly head: string; readonly tail: string; readonly chars: number; readonly newlines: number };
/** A detail as read: its three texts, up to 16 locations, whether its Driver cut it when it stored it, and the stored size (for a reader's budget). */
export interface DetailRead {
  readonly input?: DetailText;
  readonly output?: DetailText;
  readonly diff?: DetailText;
  readonly locations?: readonly string[];
  readonly truncated?: true;
  readonly bytes: number;
}

const NONE: FieldPolicy = { whole: 0, head: 0, tail: 0 };
const LOCATIONS = 16;
function textOf(scanned: ScannedText | undefined): DetailText | undefined {
  if (scanned === undefined) return undefined;
  return scanned.cut ? { cut: true, head: scanned.head, tail: scanned.tail, chars: scanned.chars, newlines: scanned.newlines } : { cut: false, text: scanned.head };
}
/** A scanned detail as a `DetailRead`; null when it is not one JSON object. */
export function detailOf(scan: ScannedDetail, bytes: number): DetailRead | null {
  if (!scan.valid) return null;
  const input = textOf(scan.texts.input), output = textOf(scan.texts.output), diff = textOf(scan.texts.diff), locations = (scan.lists.locations ?? []).slice(0, LOCATIONS);
  return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), ...(diff === undefined ? {} : { diff }), ...(locations.length ? { locations } : {}),
    ...(scan.flags.truncated === true ? { truncated: true as const } : {}), bytes };
}

/**
 * A stored detail, read by `policy`: null when it is gone, changed, unreadable or not a detail (the reader then lists the call by its title). An ownership failure of the store is not "not
 * read": it is thrown. A port that can give the item in pieces is read in one pass without holding it; one that can only give its text is read from that.
 */
export async function readDetail(port: Pick<ContentPort, "readText" | "readChunks">, ref: ContentRef, policy: DetailPolicy): Promise<DetailRead | null> {
  const field = (key: string): FieldPolicy => key === "input" ? policy.input : key === "output" ? policy.output : key === "diff" ? policy.diff : NONE;
  try {
    if (port.readChunks !== undefined) {
      const chunks = await port.readChunks(ref);
      return chunks === null ? null : detailOf(await scanDetail(chunks, field), ref.bytes);
    }
    if (port.readText !== undefined) {
      const text = await port.readText(ref, ref.bytes);
      return text === null ? null : detailOf(await scanDetail([new TextEncoder().encode(text)], field), ref.bytes);
    }
  } catch (error) {
    // A file that is not the item any more (the digest did not match as the last piece was read) is not read; anything else is not this reader's to hide.
    if (error instanceof SessionError && error.code === "INVALID_STORAGE" && error.message.includes("changed while it was read")) return null;
    throw error;
  }
  return null;
}
