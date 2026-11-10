import { createHash } from "node:crypto";
import { MAX_USAGE_REQUESTS, singleText, type NativeUsage, type TurnText, type VerifyRequest } from "../../contracts/control.js";
import type { ContentKind } from "../../contracts/content.js";
import { MAX_AUTH_KIND_BYTES, relayPacketId, type DataClass, type Fingerprint, type MarkerResult, type RelayCapabilities, type RelayPacketId, type VerifyResult } from "../../contracts/relay.js";

/**
 * What every Driver does with a relay Turn on its way to the native side and back (ADR-055 §3.2, §5.5, §7.1, §7.3, VF3-09),
 * in one place so that each Driver only says where its own protocol differs:
 *
 * - placement: a Turn's text as the text parts a Driver sends, by its declaration's `placement` (two parts, or one), a
 *   relay Turn refused whole when the native side reads its words as a command (one whose arguments it submits as a prompt
 *   excepted), and the size a declaration's `maxInput` bounds;
 * - markers: whether a native user entry carries a packet's title line, or the packet whole, and which entry after a
 *   position counts (the first with its title line, a later one only whole);
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
 * The packet a native entry's text names: the identity in its first line that starts with RELAY_TITLE and names one, within
 * its first TITLE_LINES lines (a line that starts so but names no packet, such as a user's own, does not stop the search);
 * null when there is none (a plain message, or a packet cut before its title line).
 */
export function titledPacket(text: string): RelayPacketId | null { return titleOf(text)?.id ?? null; }
/** titledPacket with the line its title is on. */
function titleOf(text: string): { readonly id: RelayPacketId; readonly line: number } | null {
  const head = text.slice(0, TITLE_UNITS).split("\n", TITLE_LINES);
  for (const [line, value] of head.entries()) {
    if (!value.startsWith(RELAY_TITLE)) continue;
    const found = PACKET_ID.exec(value)?.[0];
    if (found !== undefined) return { id: relayPacketId(found), line };
  }
  return null;
}
/** Whether a native entry's text carries this packet's title line (titledPacket). */
export function carriesPacket(text: string, packetId: RelayPacketId): boolean { return titledPacket(text) === packetId; }
/**
 * Whether a native entry's text carries this packet whole: its title line (titledPacket) and, on a later line, its end line,
 * the next line that starts with `〔` and names the same packet (packet.ts FRAME.end; stripPacket reads it the same way).
 */
export function carriesWholePacket(text: string, packetId: RelayPacketId): boolean {
  const title = titleOf(text);
  if (title === null || title.id !== packetId) return false;
  return text.split("\n").some((line, index) => index > title.line && line.startsWith("〔") && line.includes(packetId));
}
/**
 * Which of the client's user entries after a position carries a packet (ADR-055 §7.3, the approval agent's B1), entries in
 * order and `carries(entry, whole)` reading one: the first entry with the title line alone (a packet the native side cut
 * after its title is still the one this Turn sent, RT2-09), any later one only with the title and end lines of the same
 * packet (a late write is whole, VF1-13; a title line the user pasted is not). A false present loses facts, a false absent
 * only repeats them, so the later entries are held to the stricter reading. -1 when none does.
 */
export function packetEntry<T>(entries: readonly T[], carries: (entry: T, whole: boolean) => boolean): number {
  return entries.findIndex((entry, index) => carries(entry, index > 0));
}
/** One entry's text read as packetEntry asks: the title line, or the whole packet. */
export function entryCarries(text: string, packetId: RelayPacketId, whole: boolean): boolean { return whole ? carriesWholePacket(text, packetId) : carriesPacket(text, packetId); }


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
/**
 * Room one attachment's text pointer may take beside the words (attachments.ts fileMentions: a blank line, a name, a media
 * type, a size and a private copy's path of up to 4,096 bytes), in either unit: before dispatch the paths are not known yet.
 */
export const POINTER_ALLOWANCE = 4608;
/** Room OpenClaw's bridge's working-directory prefix may take (`[Working directory: <cwd>]` and a blank line), in either unit. */
export const CWD_PREFIX_ALLOWANCE = 4128;
/**
 * A declaration's `placement.measure` (ADR-055 C3): the size of the text parts `parts` places a Turn in (placeTurn), in
 * `unit`, with POINTER_ALLOWANCE for each attachment of `pointerKinds` (the kinds this Driver names by a text pointer) and
 * `fixed` for what the native side adds before it counts (a prefix). Never smaller than what the Driver measures at dispatch
 * (exceedsInput), so a Turn the coordinator lets through by it is never refused by the Driver's backstop for its size alone.
 */
export function measureBy(parts: RelayCapabilities["placement"]["parts"], unit: "chars" | "bytes", pointerKinds: readonly ContentKind[], fixed = 0): (turn: TurnText, attachments: readonly ContentKind[]) => number {
  return (turn, attachments) => {
    const placed = typeof turn === "string" ? [turn] : placeTurn(turn, { parts, maxInput: null, pointersAfterUser: true, measure: () => 0 });
    return placedSize(placed, unit) + attachments.filter(kind => pointerKinds.includes(kind)).length * POINTER_ALLOWANCE + fixed;
  };
}
/** Whether placed text, with what the native side adds to it (`extra`, in the same unit), exceeds a declaration's maxInput. */
export function exceedsInput(parts: readonly string[], placement: RelayCapabilities["placement"] | undefined, extra = 0): boolean {
  const limit = placement?.maxInput;
  return limit !== null && limit !== undefined && placedSize(parts, limit.unit) + extra > limit.limit;
}
/** The result of a relay Turn a Driver refuses before sending anything: its placement exceeds the input bound (§8.1). */
export const INPUT_LIMIT_REFUSED = { status: "failed", reason: "input_too_large", input: "not_recorded",
  error: { code: "RELAY_INPUT_LIMIT", message: "这条消息和交接单合起来超过了这个 Harness 的输入上限，没有发出；需要降低交接单的档位或只发这条消息。" } } as const;
/**
 * The result of a relay Turn whose words the native side reads as a command, or as a word only its catalog can settle (ADR-055
 * §7.4, the approval agent's B4b): a command never carries a packet, and sending the words without it would let a Driver whose
 * success proves the input recorded have the packet counted as delivered. So the whole Turn is refused before anything is sent
 * (the Runtime's classification at admission and the Driver's at dispatch disagreed). A command whose arguments the native
 * side submits as a prompt (acceptsRelay) is placed by its Driver instead.
 */
export const COMMAND_REFUSED = { status: "failed", reason: "classification_changed", input: "not_recorded",
  error: { code: "RELAY_PREPARE_FAILED", message: "原程序会把这条消息读作命令，命令回合不能附交接单，所以这条消息和交接单都没有发出。可以只发这条命令，或把交接单附在下一条普通消息上。" } } as const;
/**
 * How long a check may take (ADR-055 C6, VerifyRequest's contract: "within about two seconds"): what a Driver has not read by
 * then is unavailable. A native title request has the same bound.
 */
export const VERIFY_BUDGET_MS = 1800, TITLE_DEADLINE_MS = 2000;

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
  const found = titleOf(text);
  if (found === null) return null;
  const id = found.id, title = found.line, lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > title && line.startsWith("〔") && line.includes(id));
  if (end < 0) return null;
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
