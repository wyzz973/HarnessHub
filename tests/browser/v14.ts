/*
 * What the browser tests' fake Gateways say of a conversation (ADR-057 3.4). The fakes are written in terms of a conversation's Runs (their messages, their protocol Turns, a list of switches):
 * the facts a test sets. The Gateway answers in the v14 shape: the head and the newest Turns, each Turn its Run, its header and its items with their words, the older Turns by cursor. This
 * is that translation, so that a test keeps setting the facts it means to and the page is given what a real Gateway gives it. Nothing here is the page's own logic; the page's reducer and
 * decoders are the production ones.
 */

type Json = Record<string, unknown>;
const finished = (status: unknown): boolean => status === "completed" || status === "failed" || status === "cancelled" || status === "unknown";
const list = (value: unknown): Json[] => Array.isArray(value) ? value as Json[] : [];
const ids = (run: Json): string => String(run.id);

/** The newest Turns a window holds, as the real Gateway's: ten. */
export const WINDOW_TURNS = 10;

function itemsOf(run: Json, messages: readonly Json[]): Json[] {
  const protocol = run.protocol as Json | undefined;
  const items = list(protocol?.items).map((item): Json => {
    if (item.type !== "user_message" && item.type !== "assistant_message") return item;
    const found = messages.find(message => message.id === item.messageId);
    return found === undefined ? item : { ...item, text: String(found.text) };
  });
  // The words you wrote are an item of the Turn, as the Gateway keeps them: a fake that did not list one gets it here.
  if (!items.some(item => item.type === "user_message")) items.unshift({ id: "hh:user", seq: 0, status: "completed", type: "user_message", messageId: run.userMessageId, text: String(run.input ?? "") });
  return items;
}

function turn(old: Json, run: Json, ordinal: number): Json {
  const messages = list(old.messages), { input: _input, protocol, ...facts } = run;
  const sent = messages.find(message => message.id === run.userMessageId);
  const header = protocol === undefined ? undefined : (({ items: _items, ...rest }) => rest)(protocol as Json);
  return { run: { ...facts, ordinal, userSeq: typeof sent?.seq === "number" ? sent.seq : 2 + ordinal, ...(header === undefined ? {} : { turn: header }) }, items: itemsOf(run, messages) };
}

/** What the page used to learn from every Turn, as the Gateway works it out (`SessionFacts`). */
function facts(old: Json): Json {
  const runs = list(old.runs), unknown = runs.filter(run => run.status === "unknown");
  const branchable = [...runs].reverse().findIndex(run => ["completed", "failed", "cancelled"].includes(String(run.status)));
  const reached = runs.filter(run => finished(run.status) && ((run.timing as Json | undefined) === undefined ? run.status === "completed" : (run.timing as Json).dispatchedAt !== undefined));
  const ran = new Map<string, { harnessId: string; controlId: string; turns: number }>();
  for (const run of reached) {
    const on = ((run.relay as Json | undefined)?.executedOn ?? run.selection) as Json, key = on.harnessId + "\0" + on.controlId, held = ran.get(key);
    ran.set(key, { harnessId: String(on.harnessId), controlId: String(on.controlId), turns: (held?.turns ?? 0) + 1 });
  }
  const changes = runs.reduce((sum, run) => sum + list((run.protocol as Json | undefined)?.items).filter(item => item.type === "file_change" && item.detail !== undefined).length, 0);
  return { unknown: { count: unknown.length, unclosed: unknown.some(run => (run.cleanup as Json | null)?.closed !== true) }, settled: runs.every(run => finished(run.status)),
    branchable: branchable < 0 ? null : (() => { const at = runs.length - 1 - branchable; return { runId: ids(runs[at]!), ordinal: at }; })(), ran: [...ran.values()], changes };
}

/** `GET /api/v1/sessions/:id`: the head and the newest Turns. */
export function v14(old: Json, windowTurns = WINDOW_TURNS): Json {
  const runs = list(old.runs), messages = list(old.messages), switches = list(old.switches), from = Math.max(0, runs.length - windowTurns);
  const first = messages.find(message => message.role === "user")?.text;
  const { messages: _messages, runs: _runs, switches: _switches, ...rest } = old;
  const head: Json = { ...rest, title: typeof first === "string" && first.trim() ? first.replace(/\s+/gu, " ").trim().slice(0, 80) : "新对话", runCount: runs.length, facts: facts(old),
    ...(switches.length ? { lastSwitch: switches.at(-1) } : {}) };
  return { head, window: { turns: runs.slice(from).map((run, at) => turn(old, run, from + at)), older: from > 0 ? "c" + from : null } };
}

/** `GET /api/v1/sessions/:id/turns?before=<cursor>&limit=`: the page of Turns before a cursor (twenty, as the real Gateway's). */
export function turnsBefore(old: Json, before: string, limit = 20): Json {
  const runs = list(old.runs), end = Number(before.slice(1)), start = Math.max(0, end - limit);
  return { turns: runs.slice(start, end).map((run, at) => turn(old, run, start + at)), older: start > 0 ? "c" + start : null };
}

/** `GET …/runs/:ordinal/items/:seq/text`: a byte range of an item's text (the fake keeps texts in the messages). */
export function textRange(old: Json, ordinal: number, seq: number, from: number, to: number): Json | null {
  const run = list(old.runs)[ordinal];
  if (run === undefined) return null;
  const item = itemsOf(run, list(old.messages)).find(row => row.seq === seq);
  if (item === undefined || typeof item.text !== "string") return null;
  const bytes = Buffer.from(item.text, "utf8"), slice = bytes.subarray(from, Math.min(to, bytes.length));
  return { text: slice.toString("utf8"), from, to: from + slice.length, total: bytes.length };
}
