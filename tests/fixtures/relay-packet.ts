// Reads a relay packet the way a test or a test peer needs to (ADR-055 §5.5, relay/1-mvp.5): whether a prompt carries one,
// the user's current words after its end line, the earlier user words it quotes by turn, and the history a branch or an
// import started from (its user words and replies). Independent of the Gateway's renderer: it knows only the layout.
// The .mjs peers import the compiled copy (dist/tests/fixtures/relay-packet.js).

export interface RelayPrompt {
  readonly packet: boolean;
  readonly kind: "packet" | "delta" | null;
  readonly packetId: string | null;
  readonly currentInput: { readonly text: string };
  /** The earlier user words quoted verbatim, by the turn of their Run. */
  readonly history: readonly { readonly turn: number; readonly user: { readonly text: string } }[];
  /** The history the Session started from: each origin turn's user words, then its reply. */
  readonly branchedHistory: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  /** The packet's text before the user's current words (empty without a packet). */
  readonly body: string;
}

export const TITLE = /^〔HarnessHub (交接单|交接更新|handoff|handoff update) (relay-[0-9a-z]{20})〕$/mu;
export function endLines(id: string): readonly string[] {
  return [`〔记录结束 · ${id}。以下是用户现在的指令（原话）〕`, `〔更新结束 · ${id}。以下是用户现在的指令（原话）〕`,
    `〔End of record ${id}. The user's current instruction follows, verbatim.〕`, `〔End of update ${id}. The user's current instruction follows, verbatim.〕`];
}
/** The line that opens a turn's user words (a fenced block follows), a turn's heading, and the line that opens a reply. */
const WORDS = /^(?:用户原话：|The user's words:)$/u;
const HEADING = /^### (来源)?第 (\d+) 轮 · |^### (Source t|T)urn (\d+) · /u;
const REPLY = /(?: 的回复：|'s reply:)$/u;

/** The fenced block that opens at `lines[at]`: its content and the index after its closing fence; null when none opens there. */
export function fenced(lines: readonly string[], at: number): { readonly text: string; readonly next: number } | null {
  const open = /^(`{3,})text$/u.exec(lines[at] ?? "");
  if (!open) return null;
  const body: string[] = [];
  for (let index = at + 1; index < lines.length; index++) {
    if (lines[index] === open[1]) return { text: body.join("\n"), next: index + 1 };
    body.push(lines[index]!);
  }
  return null;
}

/**
 * See RelayPrompt; a prompt without a packet is its own current input with no history. A frame line without its end line
 * (an input typed to look like one) is no packet.
 */
export function readRelayPrompt(prompt: string): RelayPrompt {
  const title = TITLE.exec(prompt), none: RelayPrompt = { packet: false, kind: null, packetId: null, currentInput: { text: prompt }, history: [], branchedHistory: [], body: "" };
  if (!title) return none;
  const id = title[2]!, start = title.index + title[0].length;
  let end = -1, endLine = "";
  for (const line of endLines(id)) { const at = prompt.indexOf("\n" + line + "\n", start); if (at >= 0 && (end < 0 || at < end)) { end = at; endLine = line; } }
  if (end < 0) return none;
  const lines = prompt.slice(start + 1, end).split("\n"), words = new Map<string, string>(), origin = new Map<number, string>();
  let unit: { readonly origin: boolean; readonly turn: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!, heading = HEADING.exec(line);
    if (heading) { unit = { origin: heading[1] === "来源" || heading[3] === "Source t", turn: Number(heading[2] ?? heading[4]) }; continue; }
    if (unit !== null && WORDS.test(line)) {
      const block = fenced(lines, index + 1);
      if (block) { words.set((unit.origin ? "origin:" : "run:") + unit.turn, block.text); index = block.next - 1; }
      continue;
    }
    if (unit?.origin && REPLY.test(line)) { const block = fenced(lines, index + 1); if (block) { origin.set(unit.turn, block.text); index = block.next - 1; } }
  }
  const history = [...words.entries()].filter(([key]) => key.startsWith("run:")).map(([key, text]) => ({ turn: Number(key.slice(4)), user: { text } })).sort((a, b) => a.turn - b.turn);
  const turns = new Set([...[...words.keys()].filter(key => key.startsWith("origin:")).map(key => Number(key.slice(7))), ...origin.keys()]);
  const branchedHistory = [...turns].sort((a, b) => a - b).flatMap(turn => [...(words.has("origin:" + turn) ? [{ role: "user" as const, text: words.get("origin:" + turn)! }] : []),
    ...(origin.has(turn) ? [{ role: "assistant" as const, text: origin.get(turn)! }] : [])]);
  // The user's words follow the end line: after one LF in the renderer's text, after a blank line where a Driver flattened a
  // TurnText with singleText (G068 phase two hands Drivers the packet and the words apart).
  const after = end + endLine.length + 2, words0 = prompt.startsWith("\n", after) ? after + 1 : after;
  return { packet: true, kind: title[1] === "交接更新" || title[1] === "handoff update" ? "delta" : "packet", packetId: id, currentInput: { text: prompt.slice(words0) },
    history, branchedHistory, body: prompt.slice(0, end + endLine.length + 1) };
}
