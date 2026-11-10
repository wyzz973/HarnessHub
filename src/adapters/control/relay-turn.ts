import { createHash } from "node:crypto";
import { MAX_USAGE_REQUESTS, singleText, type NativeUsage, type TurnText, type VerifyRequest } from "../../contracts/control.js";
import { MAX_AUTH_KIND_BYTES, relayPacketId, type DataClass, type Fingerprint, type MarkerResult, type RelayCapabilities, type RelayPacketId, type VerifyResult } from "../../contracts/relay.js";

/**
 * What every Driver does with a relay Turn on its way to the native side and back (ADR-055 §3.2, §5.5, §7.1, §7.3, VF3-09),
 * in one place so that each Driver only says where its own protocol differs:
 *
 * - placement: a Turn's text as the text parts a Driver sends, by its declaration's `placement` (two parts, or one), with
 *   the packet left out for an input the native side reads as a command (one whose arguments it submits as a prompt
 *   excepted), and the size a declaration's `maxInput` bounds;
 * - markers: whether a native user entry carries a packet's title line, the one line each check matches;
 * - the user's words of a replayed native entry, with the packet, Hub's file pointers and native wrapping stripped;
 * - the bound on per-request usage.
 *
 * Everything here is pure and synchronous and reads nothing but its arguments.
 */

/** A Turn that carries a relay packet. */
export type RelayTurn = Exclude<TurnText, string>;

/**
 * How every packet title line starts (packet.ts FRAME.title, both languages and the delta): `〔` is reserved for the Hub,
 * and the renderer neutralizes it everywhere else in a packet (escape.ts), so the first line of an entry that starts so is
 * the packet's own title line.
 */
export const RELAY_TITLE = "〔HarnessHub ";
/** How far into an entry the title line is looked for: native prefixes and the packet's first line come before it. */
const TITLE_LINES = 64, TITLE_UNITS = 16_384;
const PACKET_ID = /relay-[0-9a-hjkmnp-tv-z]{20}/u;

/**
 * The packet a native entry's text names: the identity in its first line that starts with RELAY_TITLE, within its first
 * TITLE_LINES lines; null when there is none (a plain message, or a packet cut before its title line).
 */
export function titledPacket(text: string): RelayPacketId | null {
  const head = text.slice(0, TITLE_UNITS).split("\n", TITLE_LINES);
  for (const line of head) {
    if (!line.startsWith(RELAY_TITLE)) continue;
    const found = PACKET_ID.exec(line)?.[0];
    return found === undefined ? null : relayPacketId(found);
  }
  return null;
}
/** Whether a native entry's text carries this packet's title line (titledPacket). */
export function carriesPacket(text: string, packetId: RelayPacketId): boolean { return titledPacket(text) === packetId; }


/** The blank line between a packet and the user's words when they go as two parts (dsh joins parts without a separator). */
function separated(body: string): string { return body.endsWith("\n\n") ? body : body + (body.endsWith("\n") ? "\n" : "\n\n"); }
/**
 * A relay Turn's text parts by a declaration's placement (§5.5): two parts, the packet ending in a blank line and the user's
 * words exactly as typed, for `multiple`; one text, the packet, a blank line and the words (singleText), for `single` and for
 * a Driver without a declaration.
 */
export function placeTurn(turn: RelayTurn, placement: RelayCapabilities["placement"] | undefined): readonly string[] {
  return placement?.parts === "multiple" ? [separated(turn.relay.body), turn.user] : [singleText(turn)];
}
/**
 * The packet without its first line, for a placement that puts the packet after a command of its own (Codex's skill item):
 * the copy of the user's first line and the blank line after it (packet.ts renderPacket) go, the title line stays first.
 */
export function bodyWithoutFirstLine(turn: RelayTurn): string {
  if (!turn.relay.firstLine) return turn.relay.body;
  const lines = turn.relay.body.split("\n"), title = lines.findIndex(line => line.startsWith(RELAY_TITLE));
  return title <= 0 ? turn.relay.body : lines.slice(title).join("\n");
}
/** The size of placed text in a declaration's unit: Unicode code points ("chars") or UTF-8 bytes. */
export function placedSize(parts: readonly string[], unit: "chars" | "bytes"): number {
  const text = parts.join("");
  if (unit === "bytes") return Buffer.byteLength(text, "utf8");
  let count = 0;
  for (const _ of text) count++;
  return count;
}
/** Whether placed text, with what the native side adds to it (`extra`, in the same unit), exceeds a declaration's maxInput. */
export function exceedsInput(parts: readonly string[], placement: RelayCapabilities["placement"] | undefined, extra = 0): boolean {
  const limit = placement?.maxInput;
  return limit !== null && limit !== undefined && placedSize(parts, limit.unit) + extra > limit.limit;
}
/** The result of a relay Turn a Driver refuses before sending anything: its placement exceeds the input bound (§8.1). */
export const INPUT_LIMIT_REFUSED = { status: "failed", reason: "input_too_large", input: "not_recorded",
  error: { code: "RELAY_INPUT_LIMIT", message: "这条消息和交接单合起来超过了这个 Harness 的输入上限，没有发出；需要降低交接单的档位或只发这条消息。" } } as const;

// ---------------------------------------------------------------------------------------------------------------------
// Replayed user entries
// ---------------------------------------------------------------------------------------------------------------------

/** One kind of native or Hub wrapping a replayed user entry had, and how many UTF-8 bytes of it were stripped. */
export type Stripped = { readonly kind: DataClass; readonly bytes: number };
export interface UserText { readonly user: string; readonly stripped: readonly Stripped[] }
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
/** Adds a stripped part; parts of one kind are counted together, and nothing is recorded for an empty part. */
export function strip(stripped: readonly Stripped[], kind: DataClass, part: string): readonly Stripped[] {
  if (part === "") return stripped;
  const found = stripped.find(item => item.kind === kind);
  return found === undefined ? [...stripped, { kind, bytes: bytes(part) }] : stripped.map(item => item === found ? { kind, bytes: item.bytes + bytes(part) } : item);
}
/**
 * A relay packet in a replayed entry (§5.5): its head (the copy of the user's first line and the blank line after it, when
 * the packet has them), its title line and everything up to its end line, the next line that starts with `〔` and names the
 * same packet; with the separator after it (at most three line breaks: the placement's blank line and a native join).
 * Text before the head stays the user's (a prefix the Driver did not strip); a packet without its end line is not one.
 */
export function stripPacket(text: string): { readonly before: string; readonly packet: string; readonly after: string } | null {
  const id = titledPacket(text);
  if (id === null) return null;
  const lines = text.split("\n"), title = lines.findIndex(line => line.startsWith(RELAY_TITLE));
  const end = lines.findIndex((line, index) => index > title && line.startsWith("〔") && line.includes(id));
  if (title < 0 || end < 0) return null;
  // The renderer's head: first line, an optional blank line, then the title (packet.ts renderPacket).
  const start = title >= 2 && lines[title - 1] === "" && lines[title - 2] !== "" ? title - 2 : title >= 1 && lines[title - 1] !== "" ? title - 1 : title;
  const before = lines.slice(0, start).join("\n") + (start > 0 ? "\n" : "");
  let after = lines.slice(end + 1).join("\n"), packet = lines.slice(start, end + 1).join("\n") + (end + 1 < lines.length ? "\n" : "");
  const separator = /^\n{0,3}/u.exec(after)![0];
  packet += separator; after = after.slice(separator.length);
  return { before, packet, after };
}
/** Hub's own text pointers to read-only attachment copies (attachments.ts fileMentions), at the end of an entry. */
const POINTERS = /(?:\n\n|^)\[Attached file\] [^\n]*(?:\n\[Attached file\] [^\n]*)*$/u;
/**
 * The user's words of a replayed entry once a Driver stripped its own native wrapping: the relay packet (hub_text) and Hub's
 * file pointers after the words (workspace_meta) go; everything else is the user's.
 */
export function userWords(text: string, stripped: readonly Stripped[] = []): UserText {
  let user = text, removed = stripped;
  const packet = stripPacket(user);
  if (packet !== null) { removed = strip(removed, "hub_text", packet.packet); user = packet.before + packet.after; }
  const pointers = POINTERS.exec(user);
  if (pointers !== null && pointers.index > 0) { removed = strip(removed, "workspace_meta", pointers[0]); user = user.slice(0, pointers.index); }
  return { user, stripped: removed };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks and usage
// ---------------------------------------------------------------------------------------------------------------------

/** A check's answer, marker by marker in the request's order, with the time it took. */
export function verifyResult(request: VerifyRequest, results: readonly MarkerResult[], started: number, extra: Partial<Pick<VerifyResult, "historyEmpty" | "compaction" | "foreignAfterLast">> = {}): VerifyResult {
  return { markers: request.markers.map((marker, index) => ({ packetId: marker.packetId, result: results[index] ?? "unavailable" })), historyEmpty: extra.historyEmpty ?? null,
    compaction: extra.compaction ?? null, foreignAfterLast: extra.foreignAfterLast ?? null, verifyMs: Math.max(0, Math.round(Date.now() - started)) };
}
/** Every marker unavailable: what a Driver answers when it cannot look at all (never "absent"). */
export function unavailable(request: VerifyRequest, started: number): VerifyResult { return verifyResult(request, request.markers.map(() => "unavailable"), started); }
/** A compaction cursor's digest: sha256 of what identifies the compactions seen, or null for none. */
export function cursorDigest(parts: readonly string[]): Fingerprint | null {
  if (!parts.length) return null;
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part, "utf8").update("\0");
  return hash.digest("hex") as Fingerprint;
}
/** A per-request usage entry from native counts; null when the request's input is not a count. */
export function usageRequest(input: unknown, cachedInput?: unknown, cacheWrite?: unknown): NonNullable<NativeUsage["requests"]>[number] | null {
  const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const read = count(input);
  if (read === undefined) return null;
  const cached = count(cachedInput), written = count(cacheWrite);
  return { input: read, ...(cached === undefined ? {} : { cachedInput: cached }), ...(written === undefined ? {} : { cacheWrite: written }) };
}
/** A Turn's requests, oldest first, bounded to the latest MAX_USAGE_REQUESTS. */
export function boundedRequests(requests: readonly NonNullable<NativeUsage["requests"]>[number][]): NonNullable<NativeUsage["requests"]> {
  return requests.length > MAX_USAGE_REQUESTS ? requests.slice(-MAX_USAGE_REQUESTS) : [...requests];
}
/** An authentication kind a Driver may report: a short plain word (account, api_key…), never a label or an account name. */
export function authKind(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_-]*$/u.test(value) && Buffer.byteLength(value) <= MAX_AUTH_KIND_BYTES ? value : null;
}
