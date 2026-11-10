import assert from "node:assert/strict";
import { appendFile, realpath, stat, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import type { HarnessControl, NativeConversationId, VerifyRequest } from "../../src/contracts/control.js";
import { contentId } from "../../src/contracts/content.js";
import type { DeliveryPosition, RelayPacketId } from "../../src/contracts/relay.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, gatewayOf, ID_A, ID_B, ID_C, packet, peerRoot, prompts, relayTurn, run, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, delivery evidence (ADR-055 §7.1, §7.3, §7.4, §8.1): where each Driver records a position, how it checks a
// packet's title line after it (present, absent, outside_window, compacted, unavailable; historyEmpty only from a whole
// history; the compaction cursor and the user entries after the last marker), E1 from Codex's recorded user message (once,
// never from the reply), the confirmation that a Turn cleared the native history, and the native title. The native side is
// the relay peer, a real child process; Hermes's and Codex's histories persist in its state file across connections, as
// their gateway and rollout do. Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
const ask = (markers: readonly [RelayPacketId, DeliveryPosition][], historyEmpty = false): VerifyRequest => ({ markers: markers.map(([packetId, position]) => ({ packetId, position })), historyEmpty });
const results = (verified: Awaited<ReturnType<NonNullable<HarnessControl["verifyDelivered"]>>>) => verified.markers.map(marker => marker.result);
async function opened(t: Parameters<typeof driver>[0], harness: Parameters<typeof driver>[1], peer: Peer, checkpoint?: string, overrides: Parameters<typeof driver>[4] = {}) {
  const control = driver(t, harness, peer, gatewayOf(peer), overrides);
  await control.initialize();
  return { control, id: await control.open(peer.workspace, undefined, undefined, checkpoint) };
}
async function seed(peer: Peer, state: unknown): Promise<void> { await writeFile(peer.state, JSON.stringify(state)); }

test("G069-C02 Claude Code: the position is the transcript's length before the prompt; the check reads the client's prompts after it, a later packet there included", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const { control, id } = await opened(t, "claude", peer);
  const first = await control.deliveryPosition!(id);
  assert.equal(first.kind, "file_offset");
  if (first.kind !== "file_offset") return;
  assert.equal(basename(first.path), id + ".jsonl"); assert.equal(first.bytes, 0, "the CLI has not written the session yet");
  assert.equal(basename(dirname(first.path)), (await realpath(peer.workspace)).replace(/[^a-zA-Z0-9]/gu, "-"), "the project directory the CLI names (its realpath)");
  await run(control, id, relayTurn(ID_A, WORDS));
  const second = await control.deliveryPosition!(id);
  assert.ok(second.kind === "file_offset" && second.bytes === (await stat(first.path)).size && second.bytes > 0);
  await run(control, id, relayTurn(ID_B, "再看一下"));
  const both = await control.verifyDelivered!(id, ask([[ID_A, first], [ID_B, second]], true));
  assert.deepEqual(results(both), ["present", "present"]);
  assert.deepEqual([both.historyEmpty, both.compaction, both.foreignAfterLast], [null, null, 0], "only the part after the positions is read");
  // Each marker is looked for after its own position: A precedes B's.
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, second]]))), ["absent"]);
  // A later packet after an earlier position is found (a late write of the one before).
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_B, first]]))), ["present"]);
  await run(control, id, "随便聊聊");
  const after = await control.verifyDelivered!(id, ask([[ID_B, second]]));
  assert.deepEqual([results(after), after.foreignAfterLast], [["present"], 1], "one prompt of the client after the last marker");
  // Lines that are no JSON objects are skipped; nothing native comes back.
  await appendFile(first.path, "not json\n[1,2]\n");
  const skipped = await control.verifyDelivered!(id, ask([[ID_A, first]]));
  assert.deepEqual(results(skipped), ["present"]);
  assert.ok(!JSON.stringify(skipped).includes("修好"), "no native content in the result");
});

test("G069-C02 Claude Code answers unavailable, never absent, when it cannot look: another session's file, a rewritten or shortened transcript, a line of another session, a position of another kind, no transcript at all", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const { control, id } = await opened(t, "claude", peer);
  const before = await control.deliveryPosition!(id);
  if (before.kind !== "file_offset") throw new Error("a file position");
  // No transcript yet: nothing to look at (after the flush wait).
  const started = Date.now();
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, before]]))), ["unavailable"]);
  assert.ok(Date.now() - started >= 250, "looked once more after the CLI's flush interval");
  await run(control, id, relayTurn(ID_A, WORDS));
  const size = (await stat(before.path)).size;
  const cases: readonly DeliveryPosition[] = [
    { kind: "file_offset", path: join(dirname(before.path), "another-session.jsonl"), bytes: 0 },
    { kind: "file_offset", path: before.path, bytes: size + 10 },
    { kind: "file_offset", path: before.path, bytes: size - 3 },
    { kind: "seq", before: 0 }, { kind: "client_id", id: "x" }, { kind: "none" }];
  for (const position of cases) assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, position]]))), ["unavailable"], JSON.stringify(position));
  // A plain prompt after the position: the marker is not there, and the whole rest was read: absent (the invalid sample above).
  const plain = await control.deliveryPosition!(id); await run(control, id, "随便聊聊");
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, plain]]))), ["absent"]);
  // A line of another session makes the file not this conversation's.
  await appendFile(before.path, JSON.stringify({ type: "user", sessionId: "someone-else", message: { role: "user", content: "x" } }) + "\n");
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, before]]))), ["unavailable"]);
  await truncate(before.path, 0);
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, plain]]))), ["unavailable"], "shorter than the position");
  await assert.rejects(control.verifyDelivered!("other" as NativeConversationId, ask([[ID_A, before]])), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH");
});

test("G069-C02 Claude Code: an entry still in the CLI's write queue is found by the second read; a compaction after the packet makes it compacted", { timeout: 60000 }, async t => {
  const lagging = await peerRoot(t); Object.assign(lagging.env, { RELAY_TRANSCRIPT: lagging.env.CLAUDE_CONFIG_DIR! });
  const { control, id } = await opened(t, "claude", lagging);
  await run(control, id, "先说一句");
  (lagging.env as Record<string, string>).RELAY_TRANSCRIPT_DELAY_MS = "150";
  const position = await control.deliveryPosition!(id);
  // The peer reads its environment at start, so a second connection carries the delay.
  const delayed = await opened(t, "claude", lagging, id);
  const late = await delayed.control.deliveryPosition!(delayed.id);
  assert.deepEqual(late, position);
  await run(delayed.control, delayed.id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await delayed.control.verifyDelivered!(delayed.id, ask([[ID_A, late]]))), ["present"]);
  const compacting = await peerRoot(t, { RELAY_COMPACT: "1" }); Object.assign(compacting.env, { RELAY_TRANSCRIPT: compacting.env.CLAUDE_CONFIG_DIR! });
  const other = await opened(t, "claude", compacting), at = await other.control.deliveryPosition!(other.id);
  await run(other.control, other.id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await other.control.verifyDelivered!(other.id, ask([[ID_A, at]]))), ["compacted"]);
});

test("G069-C05 Claude Code's /clear is the driver's: a new session in place of the old one, reported with its checkpoint; nothing reaches Claude; with an attachment it is sent; a session that cannot be opened is no clear", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "claude", peer);
  for (const words of ["/clear", "  /reset", "/new"]) {
    const current = (await control.checkpoint!())!;
    const { result } = await run(control, current as NativeConversationId, words);
    const replaced = (await control.checkpoint!())!;
    assert.notEqual(replaced, current, words);
    assert.deepEqual(result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true, replaced: { checkpoint: replaced } } }, words);
    await assert.rejects(control.startText(current as NativeConversationId, "旧会话", () => {}), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH", "the old session is no longer this connection's");
  }
  assert.equal(id, "relay-session");
  assert.deepEqual((await prompts(peer)), [], "no prompt was sent for a clear");
  assert.equal((await peer.sent()).filter(line => line.method === "session/new").length, 4);
  const now = (await control.checkpoint!()) as NativeConversationId;
  assert.equal((await run(control, now, "继续")).result.status, "completed", "the new session takes the next prompt");
  const attachment = join(peer.root, "a.txt"); await writeFile(attachment, "a");
  await run(control, now, "/clear", [{ id: contentId("content-g069a"), name: "a.txt", mediaType: "text/plain", kind: "file", bytes: 1, sha256: "0".repeat(64), path: attachment }]);
  assert.deepEqual((await prompts(peer)).at(-1), ["/clear"], "with an attachment the CLI reads no command, so it is sent as it is");
  // The invalid sample: the agent refuses the new session; the old one, and its history, stay; nothing is confirmed.
  const failing = await peerRoot(t, { RELAY_NEW_FAULT: "second" }), refused = await opened(t, "claude", failing);
  const { result } = await run(refused.control, refused.id, "/clear");
  assert.equal(result.status, "failed"); assert.equal(result.input, "not_recorded"); assert.equal(result.native, undefined);
});

test("G069-C02 Codex: the position is a fresh client identity the next turn is sent with; the check finds the user message by it; E1 once, before the result, with the packet, never from the reply", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "codex", peer);
  const position = await control.deliveryPosition!(id), again = await control.deliveryPosition!(id);
  assert.ok(position.kind === "client_id" && again.kind === "client_id" && position.id !== again.id, "a new identity each time");
  const { result, events } = await run(control, id, relayTurn(ID_A, WORDS));
  assert.equal(((await peer.sent()).find(line => line.method === "turn/start")!.params as { clientUserMessageId: string }).clientUserMessageId, (again as { id: string }).id, "the last one recorded");
  const recorded = events.filter(event => event.type === "input_recorded");
  assert.deepEqual(recorded, [{ type: "input_recorded", packetId: ID_A }], "once, with the packet");
  assert.ok(events.findIndex(event => event.type === "input_recorded") < events.findIndex(event => event.type === "text"), "before the reply");
  assert.equal(result.input, "recorded");
  const verified = await control.verifyDelivered!(id, ask([[ID_A, again]], true));
  assert.deepEqual([results(verified), verified.historyEmpty, verified.compaction, verified.foreignAfterLast], [["present"], false, { count: 0, digest: null }, 0]);
  // A plain turn: E1 without a packet; its identity's message carries no title line: absent.
  const plain = await control.deliveryPosition!(id), second = await run(control, id, "随便聊聊");
  assert.deepEqual(second.events.filter(event => event.type === "input_recorded"), [{ type: "input_recorded" }]);
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, plain], [ID_A, again]]))), ["absent", "present"]);
  // An identity Codex never recorded, after the whole thread was read with echoes seen: absent; nothing of the kind: unavailable.
  const missing = await control.verifyDelivered!(id, ask([[ID_B, { kind: "client_id", id: "never-sent" }], [ID_B, { kind: "file_offset", path: "/x", bytes: 0 }]]));
  assert.deepEqual([results(missing), missing.foreignAfterLast], [["absent", "unavailable"], null]);
  // E1 is never inferred from the reply: a hook stopped the input, the reply came, no E1, nothing recorded.
  const hooked = await peerRoot(t, { RELAY_HOOK: "1" }), stopped = await opened(t, "codex", hooked);
  await stopped.control.deliveryPosition!(stopped.id);
  const silent = await run(stopped.control, stopped.id, relayTurn(ID_A, WORDS));
  assert.ok(silent.events.some(event => event.type === "text"));
  assert.deepEqual([silent.events.filter(event => event.type === "input_recorded"), silent.result.input], [[], undefined]);
  // Another client's identity in this turn's user message is not this turn's input.
  const foreign = await peerRoot(t, { RELAY_ECHO_VALUE: "someone-else" }), other = await opened(t, "codex", foreign);
  await other.control.deliveryPosition!(other.id);
  const theirs = await run(other.control, other.id, relayTurn(ID_A, WORDS));
  assert.deepEqual([theirs.events.filter(event => event.type === "input_recorded"), theirs.result.input], [[], undefined]);
  // The echo under the other name Codex may use (clientId) counts the same.
  const named = await peerRoot(t, { RELAY_ECHO_FIELD: "clientId" }), echo = await opened(t, "codex", named), mark = await echo.control.deliveryPosition!(echo.id);
  assert.deepEqual((await run(echo.control, echo.id, relayTurn(ID_A, WORDS))).events.filter(event => event.type === "input_recorded"), [{ type: "input_recorded", packetId: ID_A }]);
  assert.deepEqual(results(await echo.control.verifyDelivered!(echo.id, ask([[ID_A, mark]]))), ["present"]);
});

test("G069-C02 Codex: outside_window past the pages a check reads, compacted after a context compaction, unavailable without echoes or when Codex refuses or answers garbage, historyEmpty from a whole thread; a listing that never answers fails the connection", { timeout: 90000 }, async t => {
  const turn = (index: number, items: readonly Record<string, unknown>[]) => ({ id: "seed-" + index, status: "completed", items });
  const user = (index: number) => ({ type: "userMessage", id: "u-" + index, content: [{ type: "text", text: "旧消息 " + index, text_elements: [] }], clientUserMessageId: "seed-" + index });
  const long = await peerRoot(t); await seed(long, { sessions: {}, threads: { "thread-relay": { name: null, turns: Array.from({ length: 450 }, (_, index) => turn(index, [user(index)])) } } });
  const wide = await opened(t, "codex", long, "thread-relay");
  const window = await wide.control.verifyDelivered!(wide.id, ask([[ID_A, { kind: "client_id", id: "seed-0" }], [ID_B, { kind: "client_id", id: "seed-449" }]], true));
  assert.deepEqual([results(window), window.historyEmpty, window.compaction], [["outside_window", "absent"], null, null], "8 pages of 50 turns, newest first; nothing whole");
  const compacting = await peerRoot(t, { RELAY_COMPACT: "1" }), folded = await opened(t, "codex", compacting), at = await folded.control.deliveryPosition!(folded.id);
  await run(folded.control, folded.id, relayTurn(ID_A, WORDS));
  const compacted = await folded.control.verifyDelivered!(folded.id, ask([[ID_A, at]]));
  assert.deepEqual([results(compacted), compacted.compaction], [["compacted"], { count: 1, digest: null }]);
  const empty = await peerRoot(t); await seed(empty, { sessions: {}, threads: { "thread-relay": { name: null, turns: [turn(0, [{ type: "agentMessage", id: "a", text: "hi" }])] } } });
  const blank = await opened(t, "codex", empty, "thread-relay");
  const nothing = await blank.control.verifyDelivered!(blank.id, ask([[ID_A, { kind: "client_id", id: "x" }]], true));
  assert.deepEqual([results(nothing), nothing.historyEmpty], [["unavailable"], true], "no echo seen: cannot look for an identity; and no user message at all");
  const silent = await peerRoot(t, { RELAY_ECHO_FIELD: "none" }), quiet = await opened(t, "codex", silent), mark = await quiet.control.deliveryPosition!(quiet.id);
  await run(quiet.control, quiet.id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await quiet.control.verifyDelivered!(quiet.id, ask([[ID_A, mark]]))), ["unavailable"], "a Codex that echoes no identity: never absent");
  for (const fault of ["refuse", "garbage"]) {
    const peer = await peerRoot(t, { RELAY_TURNS_FAULT: fault }), { control, id } = await opened(t, "codex", peer);
    assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, { kind: "client_id", id: "x" }]]))), ["unavailable"], fault);
    assert.equal(control.healthy!(), true, fault + ": the connection is still usable");
  }
  const hanging = await peerRoot(t, { RELAY_TURNS_FAULT: "hang" }), stuck = await opened(t, "codex", hanging, undefined, { requestTimeoutMs: 400 });
  await assert.rejects(stuck.control.verifyDelivered!(stuck.id, ask([[ID_A, { kind: "client_id", id: "x" }]])), (error: unknown) => error instanceof ControlError && error.code === "REQUEST_TIMEOUT");
  assert.equal(stuck.control.healthy!(), false);
});

test("G069-C07 Codex names the thread before its first turn (thread/name/set), one line; an empty title is not sent; a refusal rejects and leaves the connection usable", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "codex", peer);
  await control.setTitle!(id, "修好\n测试  ");
  await control.setTitle!(id, " \n ");
  await run(control, id, "开始");
  const methods = (await peer.sent()).map(line => line.method).filter(method => method !== undefined && !["initialize", "initialized"].includes(method));
  assert.deepEqual(methods, ["thread/start", "thread/name/set", "turn/start"], "named before the first turn, the empty title not sent");
  assert.equal((await peer.native()).threads["thread-relay"]!.name, "修好 测试");
  const refusing = await peerRoot(t, { RELAY_NAME_FAULT: "refuse" }), refused = await opened(t, "codex", refusing);
  await assert.rejects(refused.control.setTitle!(refused.id, "x"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  assert.equal(refused.control.healthy!(), true);
});

test("G069-C02 Hermes: the position is the user entries the open replayed; the next open's replay is checked after it, compaction summaries left out; historyEmpty and the summary cursor from the whole replay", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), first = await opened(t, "hermes", peer);
  const empty = await first.control.deliveryPosition!(first.id);
  assert.deepEqual(empty, { kind: "seq", before: 0 });
  await run(first.control, first.id, relayTurn(ID_A, WORDS));
  const checkpoint = (await first.control.checkpoint!())!; await first.control.close();
  const next = await opened(t, "hermes", peer, checkpoint);
  const verified = await next.control.verifyDelivered!(next.id, ask([[ID_A, empty]], true));
  assert.deepEqual([results(verified), verified.historyEmpty, verified.compaction, verified.foreignAfterLast], [["present"], false, { count: 0, digest: null }, 0]);
  assert.deepEqual(await next.control.deliveryPosition!(next.id), { kind: "seq", before: 1 });
  assert.deepEqual(results(await next.control.verifyDelivered!(next.id, ask([[ID_A, { kind: "seq", before: 1 }], [ID_A, { kind: "client_id", id: "x" }]]))), ["absent", "unavailable"]);
  // A compaction summary: compacted rows are no longer replayed, so positions shifted and the whole replay is searched.
  const summary = "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.\n摘要";
  const row = (role: string, text: string, extra: Record<string, unknown> = {}) => ({ role, text, ...extra });
  const compacted = await peerRoot(t); await seed(compacted, { threads: {}, sessions: { "relay-session": { entries: [row("user", summary, { summary: true }), row("user", packet(ID_A, WORDS) + "\n\n\n" + WORDS), row("assistant", "ok"),
    row("user", "[System: heartbeat]"), row("user", "我自己在 Hermes 里说的话"), row("assistant", "ok")], seq: 0, revision: "r", title: null, cwd: null } } });
  const shifted = await opened(t, "hermes", compacted, "relay-session");
  const found = await shifted.control.verifyDelivered!(shifted.id, ask([[ID_C, { kind: "seq", before: 1 }], [ID_A, { kind: "seq", before: 9 }]], true));
  assert.deepEqual(results(found), ["absent", "present"], "a stale position after a compaction still finds the packet");
  // A packet folded into a summary (the merged form keeps the old text first) is not in the history as an entry of its own.
  const merged = await peerRoot(t); await seed(merged, { threads: {}, sessions: { "relay-session": { entries: [row("user", "[PRIOR CONTEXT — for reference only; not a new message]\n" + packet(ID_B, WORDS) + "\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n摘要", { summary: true }),
    row("assistant", "ok")], seq: 0, revision: "r", title: null, cwd: null } } });
  const folded = await opened(t, "hermes", merged, "relay-session");
  assert.deepEqual(results(await folded.control.verifyDelivered!(folded.id, ask([[ID_B, { kind: "seq", before: 0 }]]))), ["absent"], "the summary's copy is no delivery; the cursor says a compaction may explain it");
  assert.equal(found.compaction?.count, 1); assert.match(String(found.compaction?.digest), /^[0-9a-f]{64}$/u);
  assert.equal(found.foreignAfterLast, 1, "Hermes's own rows are not the user's");
  // The invalid sample: the same history without a summary keeps positions, so a packet before the position is absent.
  const plain = await peerRoot(t); await seed(plain, { threads: {}, sessions: { "relay-session": { entries: [row("user", packet(ID_A, WORDS)), row("assistant", "ok")], seq: 0, revision: "r", title: null, cwd: null } } });
  const kept = await opened(t, "hermes", plain, "relay-session");
  assert.deepEqual(results(await kept.control.verifyDelivered!(kept.id, ask([[ID_A, { kind: "seq", before: 1 }]]))), ["absent"]);
  // An empty session's replay: historyEmpty, and a packet that never arrived is absent.
  const none = await peerRoot(t); await seed(none, { threads: {}, sessions: { "relay-session": { entries: [], seq: 0, revision: "r", title: null, cwd: null } } });
  const blank = await opened(t, "hermes", none, "relay-session");
  const nothing = await blank.control.verifyDelivered!(blank.id, ask([[ID_A, { kind: "seq", before: 0 }]], true));
  assert.deepEqual([results(nothing), nothing.historyEmpty], [["absent"], true]);
  // Older entries than a check keeps: outside_window.
  const many = await peerRoot(t); await seed(many, { threads: {}, sessions: { "relay-session": { entries: [row("user", packet(ID_A)), ...Array.from({ length: 1100 }, (_, index) => row("user", "第 " + index + " 条"))], seq: 0, revision: "r", title: null, cwd: null } } });
  const wide = await opened(t, "hermes", many, "relay-session");
  assert.deepEqual(results(await wide.control.verifyDelivered!(wide.id, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["outside_window"]);
});

test("G069-C02 Hermes: a malformed replay fails the open and the check rejects; a replay of a session it does not have is not read", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_LOAD_FAULT: "garbage" }), control = driver(t, "hermes", peer);
  await control.initialize();
  await assert.rejects(control.open(peer.workspace, undefined, undefined, "relay-session"));
  await assert.rejects(control.verifyDelivered!("relay-session" as NativeConversationId, ask([[ID_A, { kind: "seq", before: 0 }]])));
  await assert.rejects(control.deliveryPosition!("relay-session" as NativeConversationId));
});

test("G069-C05 Hermes confirms a clear only by its fixed receipt; G069-C07 its title by /title, answered by the viewer without a turn or a history row", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_HERMES: "1" }), { control, id } = await opened(t, "hermes", peer);
  await run(control, id, "先说一句");
  for (const words of ["/clear", "　/reset", "/new"]) assert.deepEqual((await run(control, id, words)).result.native, { cleared: true, replaced: null }, words);
  // The invalid samples: another answer to /clear, and a command that is no clear, confirm nothing.
  const other = await peerRoot(t), plain = await opened(t, "hermes", other);
  assert.equal((await run(plain.control, plain.id, "/clear")).result.native, undefined);
  assert.equal((await run(control, id, "/compress")).result.native, undefined);
  const entries = (await peer.native()).sessions["relay-session"]!.entries.length;
  await control.setTitle!(id, "修好\n测试");
  await control.setTitle!(id, "   ");
  assert.deepEqual((await prompts(peer)).at(-1), ["/title 修好 测试"], "one line; an empty title is not sent");
  assert.equal((await peer.native()).sessions["relay-session"]!.title, "修好 测试");
  assert.equal((await peer.native()).sessions["relay-session"]!.entries.length, entries, "no history row");
  await assert.rejects(plain.control.setTitle!(plain.id, "x"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE", "an answer that is not the receipt");
});

test("G069-C02 OpenClaw: the position is the transcript's highest sequence; the check reads user rows after it with the working-directory prefix, a late write after another row included; compacted, outside_window, unavailable", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1" }), { control, id } = await opened(t, "openclaw", peer);
  const start = await control.deliveryPosition!(id);
  assert.deepEqual(start, { kind: "seq", before: 0 });
  await run(control, id, "先说一句");
  await run(control, id, relayTurn(ID_A, WORDS));
  const verified = await control.verifyDelivered!(id, ask([[ID_A, start]], true));
  assert.deepEqual([results(verified), verified.historyEmpty, verified.compaction, verified.foreignAfterLast], [["present"], false, null, 0], "found although the first row after the position is another one");
  const later = await control.deliveryPosition!(id);
  assert.deepEqual(later, { kind: "seq", before: 4 });
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, later], [ID_A, { kind: "client_id", id: "x" }]]))), ["absent", "unavailable"]);
  // A compaction marker after the packet's row, and a full window that starts after the position.
  const rows = (messages: readonly Record<string, unknown>[]) => async () => ({ messages });
  const user = (seq: number, text: string) => ({ role: "user", content: "[Working directory: ~/ws]\n\n" + text, __openclaw: { seq } });
  const crafted = async (messages: readonly Record<string, unknown>[], request: VerifyRequest) => {
    const own = await peerRoot(t, { RELAY_OPENCLAW: "1" }), bridge = driver(t, "openclaw", own, gatewayOf(own, { "sessions.get": rows(messages) }));
    await bridge.initialize(); const session = await bridge.open(own.workspace);
    return bridge.verifyDelivered!(session, request);
  };
  const compaction = { role: "system", content: [{ type: "text", text: "Compaction" }], __openclaw: { kind: "compaction", seq: 3 } };
  assert.deepEqual(results(await crafted([user(1, packet(ID_A, WORDS) + "\n\n" + WORDS), { role: "assistant", content: [], __openclaw: { seq: 2 } }, compaction], ask([[ID_A, start]]))), ["compacted"]);
  const full = Array.from({ length: 200 }, (_, index) => user(50 + index, "第 " + index + " 条"));
  assert.deepEqual(results(await crafted(full, ask([[ID_A, { kind: "seq", before: 0 }], [ID_A, { kind: "seq", before: 100 }]]))), ["outside_window", "absent"]);
  for (const answer of [async () => { throw new Error("gateway down"); }, async () => ({ messages: "nope" })]) {
    const own = await peerRoot(t, { RELAY_OPENCLAW: "1" }), bridge = driver(t, "openclaw", own, gatewayOf(own, { "sessions.get": answer }));
    await bridge.initialize(); const session = await bridge.open(own.workspace);
    assert.deepEqual(results(await bridge.verifyDelivered!(session, ask([[ID_A, start]]))), ["unavailable"]);
  }
});

test("G069-C05 OpenClaw confirms /new by the session's renewed incarnation; after it the earlier packet is absent and the history empty; a reset it cannot read back is not confirmed", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }, { name: "reset", description: "reset" }]) });
  const { control, id } = await opened(t, "openclaw", peer); await control.models!();
  const start = await control.deliveryPosition!(id);
  await run(control, id, relayTurn(ID_A, WORDS));
  const before = Object.values((await peer.native()).sessions)[0]!.revision;
  assert.deepEqual((await run(control, id, "/new")).result.native, { cleared: true, replaced: null });
  assert.notEqual(Object.values((await peer.native()).sessions)[0]!.revision, before);
  const after = await control.verifyDelivered!(id, ask([[ID_A, start]], true));
  assert.deepEqual([results(after), after.historyEmpty], [["absent"], true]);
  // Rows are numbered anew after a reset, so a position from before it says nothing: every row after the reset is read.
  const old = { kind: "seq", before: 2 } as const;
  await run(control, id, relayTurn(ID_B, "重新开始"));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_B, old]]))), ["present"], "found at a number below the old position");
  // The invalid samples: a command that is no clear, a /new the Gateway did not act on (its incarnation stayed), and an
  // incarnation the Gateway does not report.
  assert.equal((await run(control, id, "/reset soft")).result.native, undefined);
  const idle = await peerRoot(t, { RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }]) }), ignored = driver(t, "openclaw", idle);
  await ignored.initialize(); const kept = await ignored.open(idle.workspace); await ignored.models!();
  await run(ignored, kept, "先说一句");
  assert.equal((await run(ignored, kept, "/new")).result.native, undefined, "the same incarnation after the Turn");
  const blind = await peerRoot(t, { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }]) });
  const unseen = driver(t, "openclaw", blind, gatewayOf(blind, { "sessions.describe": async () => { throw new Error("no describe"); } }));
  await unseen.initialize(); const session = await unseen.open(blind.workspace); await unseen.models!();
  await run(unseen, session, "先说一句");
  assert.equal((await run(unseen, session, "/new")).result.native, undefined);
});
