import assert from "node:assert/strict";
import test from "node:test";
import type { ControlEvent } from "../../src/contracts/control.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, ID_A, ID_B, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// The evidence a Driver gives that a Turn's input reached the native history (ADR-055 §7.1), and the native title. The decision log
// of 2026-11-11 took the reading of the native history afterwards (a check, a position) out of the Drivers; what is left is the
// live evidence: Codex's user message echoing the identity a Turn with a packet was sent with (E1), and the title. The native
// side is the relay peer, a real child process; nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string, overrides: Parameters<typeof driver>[4] = {}) {
  const control = driver(t, harness, peer, undefined, overrides);
  await control.initialize();
  return { control, id: await control.open(peer.workspace, undefined, undefined, checkpoint) };
}
const recordedEvents = (events: readonly ControlEvent[]) => events.filter(event => event.type === "input_recorded");

test("Codex: a Turn that carries a packet is sent with an identity of its own, a new one each time; the user message echoing it is E1, once, before the reply, with the packet; a plain Turn is sent with none", async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "codex", peer);
  const first = await run(control, id, relayTurn(ID_A, WORDS)), second = await run(control, id, relayTurn(ID_B, "再看一下")), plain = await run(control, id, "随便聊聊");
  const identities = (await peer.sent()).filter(line => line.method === "turn/start").map(line => (line.params as { clientUserMessageId?: string }).clientUserMessageId);
  assert.ok(typeof identities[0] === "string" && typeof identities[1] === "string" && identities[0] !== identities[1], "an identity of its own for each Turn with a packet");
  assert.equal(identities[2], undefined, "a plain Turn carries none");
  assert.deepEqual(recordedEvents(first.events), [{ type: "input_recorded", packetId: ID_A }], "once, with the packet");
  assert.deepEqual(recordedEvents(second.events), [{ type: "input_recorded", packetId: ID_B }]);
  assert.ok(first.events.findIndex(event => event.type === "input_recorded") < first.events.findIndex(event => event.type === "text"), "before the reply");
  assert.equal(first.result.input, "recorded");
  // A plain Turn: E1 without a packet.
  assert.deepEqual(recordedEvents(plain.events), [{ type: "input_recorded" }]);
  assert.equal(plain.result.input, "recorded");
});

test("Codex: E1 is never inferred from the reply, and another client's identity is not this Turn's input", async t => {
  // A hook stopped the input and the reply came: no E1, nothing recorded.
  const hooked = await peerRoot(t, { RELAY_HOOK: "1" }), stopped = await opened(t, "codex", hooked);
  const silent = await run(stopped.control, stopped.id, relayTurn(ID_A, WORDS));
  assert.ok(silent.events.some(event => event.type === "text"));
  assert.deepEqual([recordedEvents(silent.events), silent.result.input], [[], undefined]);
  // Another client's identity in this Turn's user message is not this Turn's input.
  const foreign = await peerRoot(t, { RELAY_ECHO_VALUE: "someone-else" }), other = await opened(t, "codex", foreign);
  const theirs = await run(other.control, other.id, relayTurn(ID_A, WORDS));
  assert.deepEqual([recordedEvents(theirs.events), theirs.result.input], [[], undefined]);
  // A Codex that echoes no identity at all: its user message is still this Turn's input, by its turn.
  const mute = await peerRoot(t, { RELAY_ECHO_FIELD: "none" }), quiet = await opened(t, "codex", mute);
  assert.deepEqual(recordedEvents((await run(quiet.control, quiet.id, relayTurn(ID_A, WORDS))).events), [{ type: "input_recorded", packetId: ID_A }]);
});

// Codex 0.166.0 echoes the identity turn/start was given as `clientUserMessageId` under `clientId` (the user message's keys:
// clientId, completedAtMs, content, id, startedAtMs, type; probe record 2026-11-10, E1). `clientId` is read first;
// `clientUserMessageId`, the name the request used, is the second reading.
test("Codex: the user message's `clientId` is the echo the driver reads first; `clientUserMessageId` only when there is no `clientId`", async t => {
  const live = async (settings: Record<string, string>) => {
    const peer = await peerRoot(t, settings), { control, id } = await opened(t, "codex", peer);
    return recordedEvents((await run(control, id, relayTurn(ID_A, WORDS))).events).length;
  };
  // As the installed Codex sends it: `clientId` alone (and, as before, `clientUserMessageId` alone).
  assert.equal(await live({ RELAY_ECHO_FIELD: "clientId" }), 1);
  assert.equal(await live({}), 1);
  // Both names on one message: `clientId` decides. This Turn's identity under `clientId` is this Turn's whatever the other says...
  assert.equal(await live({ RELAY_ECHO_FIELD: "clientId", RELAY_ECHO_EXTRA: JSON.stringify({ clientUserMessageId: "someone-else" }) }), 1);
  // ...and another client's identity under `clientId` is not this Turn's, whatever the other says.
  assert.equal(await live({ RELAY_ECHO_FIELD: "clientId", RELAY_ECHO_VALUE: "someone-else", RELAY_ECHO_EXTRA: JSON.stringify({ clientUserMessageId: "$clientUserMessageId" }) }), 0);
});

test("Codex names the thread before its first turn (thread/name/set), one line; an empty title is not sent; a refusal or no answer rejects and leaves the connection usable", { timeout: 60000 }, async t => {
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
  // A title that is never answered is given up alone, within about two seconds, and the next turn runs.
  const naming = await peerRoot(t, { RELAY_NAME_FAULT: "hang" }), titled = await opened(t, "codex", naming);
  const started = Date.now();
  await assert.rejects(titled.control.setTitle!(titled.id, "修好测试"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  assert.ok(Date.now() - started < 2500);
  assert.equal(titled.control.healthy!(), true);
  assert.equal((await run(titled.control, titled.id, "开始")).result.status, "completed");
});

test("Hermes names the session by /title, answered by the viewer without a turn or a history row; a /title that is never answered rejects within its bound and the next turn runs", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_HERMES: "1" }), { control, id } = await opened(t, "hermes", peer);
  await run(control, id, "先说一句");
  const entries = (await peer.native()).sessions["relay-session"]!.entries.length;
  await control.setTitle!(id, "修好\n测试");
  await control.setTitle!(id, "   ");
  assert.deepEqual((await prompts(peer)).at(-1), ["/title 修好 测试"], "one line; an empty title is not sent");
  assert.equal((await peer.native()).sessions["relay-session"]!.title, "修好 测试");
  assert.equal((await peer.native()).sessions["relay-session"]!.entries.length, entries, "no history row");
  // An answer that is not Hermes's receipt is no title.
  const other = await peerRoot(t), plain = await opened(t, "hermes", other);
  await assert.rejects(plain.control.setTitle!(plain.id, "x"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  const hanging = await peerRoot(t, { RELAY_HERMES: "1", RELAY_TITLE_FAULT: "hang" }), stuck = await opened(t, "hermes", hanging, undefined, { runTimeoutMs: 6000 });
  const started = Date.now();
  await assert.rejects(stuck.control.setTitle!(stuck.id, "修好测试"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  assert.ok(Date.now() - started < 3000, "its own bound, not the Turn's");
  assert.equal(stuck.control.healthy!(), true);
  assert.equal((await run(stuck.control, stuck.id, "继续")).result.status, "completed");
});

test("Hermes: a replay with a frame that is no update fails the open", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_LOAD_FAULT: "garbage" }), control = driver(t, "hermes", peer);
  await control.initialize();
  await assert.rejects(control.open(peer.workspace, undefined, undefined, "relay-session"));
});

test("no Driver reads its native history back: none has a check, a position, a vendor reading or a reader of replayed user entries, and no declaration has a cell for one", async t => {
  const peer = await peerRoot(t);
  for (const harness of ["claude", "codex", "opencode", "dsh", "hermes", "openclaw"] as const) {
    const control = driver(t, harness, peer) as unknown as Record<string, unknown>;
    for (const member of ["verifyDelivered", "deliveryPosition", "relayVendor", "userTextOf"]) assert.equal(control[member], undefined, harness + " " + member);
    assert.deepEqual(Object.keys((control.relayCapabilities as { delivery: object }).delivery).sort(), ["live", "successProvesRecorded"], harness);
  }
});
