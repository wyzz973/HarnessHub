import { MAX_USAGE_REQUESTS, singleText, type BackendResult, type ControlEvent, type NativeUsage, type TurnText } from "../../contracts/control.js";
import type { ContentKind } from "../../contracts/content.js";
import { relayPacketId, type RelayCapabilities, type RelayPacketId } from "../../contracts/relay.js";

/**
 * What every Driver does with a relay Turn on its way to the native side and back (ADR-055 §3.2, §5.5, §7.1), in one place so
 * that each Driver only says where its own protocol differs:
 *
 * - placement: a Turn's text as the text parts a Driver sends, by its declaration's `placement` (two parts, or one), a
 *   relay Turn refused whole when the native side reads its words as a command (one whose arguments it submits as a prompt
 *   excepted), and the size a declaration's `maxInput` bounds;
 * - the packet's title line in a native user entry, which is how a live echo says which packet it carries;
 * - the Hub's own clear: what a Driver reports when it gives up the native session instead of sending the command;
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
export function titledPacket(text: string): RelayPacketId | null {
  for (const value of text.slice(0, TITLE_UNITS).split("\n", TITLE_LINES)) {
    if (!value.startsWith(RELAY_TITLE)) continue;
    const found = PACKET_ID.exec(value)?.[0];
    if (found !== undefined) return relayPacketId(found);
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
    const placed = typeof turn === "string" ? [turn] : placeTurn(turn, { parts, maxInput: null, measure: () => 0 });
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
  error: { code: "RELAY_INPUT_LIMIT", message: "这条消息和交接单合起来超过了这个 Harness 的输入上限，没有发出；可以只发这条消息。" } } as const;
/**
 * The result of a relay Turn whose words the native side reads as a command, or as a word only its catalog can settle (ADR-055
 * §7.4, the approval agent's B4b): a command never carries a packet, and sending the words without it would let a Driver whose
 * success proves the input recorded have the packet counted as delivered. So the whole Turn is refused before anything is sent
 * (the Runtime's classification at admission and the Driver's at dispatch disagreed). A command whose arguments the native
 * side submits as a prompt (acceptsRelay) is placed by its Driver instead.
 */
export const COMMAND_REFUSED = { status: "failed", reason: "classification_changed", input: "not_recorded",
  error: { code: "RELAY_PREPARE_FAILED", message: "原程序会把这条消息读作命令，命令回合不能附交接单，所以这条消息和交接单都没有发出。可以只发这条命令，或把交接单附在下一条普通消息上。" } } as const;
/** How long a native title request may take; past it the request is given up alone (ADR-055 C6). */
export const TITLE_DEADLINE_MS = 2000;

// ---------------------------------------------------------------------------------------------------------------------
// The Hub's clear
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The result of a clear the Hub runs itself (the decision log of 2026-11-11: clearing is the Hub's, on every Driver). Nothing
 * was sent to the native side. Its session was given up, and the next Turn opens a new one: a session never prompted cannot be
 * resumed by another process, so none is opened ahead.
 */
export function hubCleared(): BackendResult {
  return { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } };
}
/** What the Turn says of it: the command was not sent, and the old session is given up, not deleted. */
export function clearedNotice(command: string, product: string): ControlEvent {
  return { type: "diagnostic", message: `HarnessHub 代为执行了 /${command}：这条命令没有发给 ${product}，原来的会话已放下（没有删除，仍在 ${product} 里），下一条消息会在新会话里开始。` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------------------------------

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
