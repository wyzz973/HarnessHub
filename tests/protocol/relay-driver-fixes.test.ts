import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, open as openFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlLaunch, HarnessControl, VerifyRequest } from "../../src/contracts/control.js";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import type { DeliveryPosition, RelayCapabilities, RelayPacketId } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { ClaudeControl, claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { titledPacket } from "../../src/adapters/control/relay-turn.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, gatewayOf, ID_A, ID_B, options, packet, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, the corrections after the independent review of db39cbd (ADR-055, the approval agent's decisions of
// 2026-11-10 on G068 / G069 phase two): one test per finding, each first written against the native behaviour the relay peer
// (tests/fixtures/relay-control-peer.mjs, a real child process) or the OpenClaw Gateway stand-in now plays. The rule that runs
// through them: a check never says more than it read — what it could not look for, did not read whole, or reads at a place
// that no longer holds is "unavailable" or "outside_window", never "absent", and historyEmpty is never true without proof.
// Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
const ask = (markers: readonly [RelayPacketId, DeliveryPosition][], historyEmpty = false): VerifyRequest => ({ markers: markers.map(([packetId, position]) => ({ packetId, position })), historyEmpty });
const results = (verified: Awaited<ReturnType<NonNullable<HarnessControl["verifyDelivered"]>>>) => verified.markers.map(marker => marker.result);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A packet's title line alone, as a user who pasted only it would send it. */
const titleOnly = (id: RelayPacketId) => "〔HarnessHub 交接单 " + id + "〕";
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string, overrides: Parameters<typeof driver>[4] = {}, gateway = gatewayOf(peer)) {
  const control = driver(t, harness, peer, gateway, overrides);
  await control.initialize();
  return { control, id: await control.open(peer.workspace, undefined, undefined, checkpoint) };
}
async function methods(peer: Peer): Promise<readonly string[]> { return (await peer.sent()).flatMap(line => typeof line.method === "string" ? [line.method] : []); }
/** The refusal of a relay Turn whose words the native side reads as a command (F1, approval B4b). */
function refused(result: BackendResult, label: string): void {
  assert.deepEqual({ ...result, error: result.error === undefined ? undefined : { code: result.error.code } },
    { status: "failed", reason: "classification_changed", input: "not_recorded", error: { code: "RELAY_PREPARE_FAILED" } }, label);
  assert.ok((result.error?.message.length ?? 0) > 0, label + ": says why");
}
/** The peer announces `/compact`, as claude-agent-acp lists it. */
const COMPACT_LISTED = { RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact the conversation" }]) };
const fileIn = async (peer: Peer, name = "notes.txt"): Promise<ControlAttachment> => {
  const path = join(peer.root, name); await writeFile(path, "notes");
  return { id: contentId("content-g069fix" + name.replace(/[^a-z]/gu, "")), name, mediaType: "text/plain", kind: "file", bytes: 5, sha256: "0".repeat(64), path };
};

// ---------------------------------------------------------------------------------------------------------------------
// F1 (approval B4b): a relay Turn read as a command is refused whole
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F1 a relay Turn whose words the native side reads as a command is refused whole: failed, not_recorded, RELAY_PREPARE_FAILED (classification_changed), nothing sent and nothing said; dsh has no commands and carries it", { timeout: 90000 }, async t => {
  const cases: readonly (readonly [Harness, string, Record<string, string>])[] = [
    // Claude Code's catalog lists /compact, as the real adapter's does: a word outside the catalog is words for it (G074-F3).
    ["claude", "/compact keep the tests", COMPACT_LISTED], ["claude", "/clear", {}], ["claude", "/remote-control", {}],
    ["hermes", "　/compress", {}], ["hermes", "/export", {}],
    ["opencode", "/compact", {}],
    ["openclaw", "/new", { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }]) }],
    ["codex", "/compact", {}], ["codex", "/export", {}],
  ];
  for (const [harness, words, settings] of cases) {
    const peer = await peerRoot(t, settings), { control, id } = await opened(t, harness, peer);
    if (harness === "openclaw") await control.models!();
    const before = await control.checkpoint!();
    const { result, events } = await run(control, id, relayTurn(ID_A, words, false));
    const label = harness + " " + JSON.stringify(words);
    refused(result, label);
    assert.deepEqual(events, [], label + ": no diagnostic, no event at all");
    assert.deepEqual(await prompts(peer), [], label + ": no prompt");
    const sent = await methods(peer);
    for (const method of ["turn/start", "thread/compact/start", "session/new", "sessions.patch"]) assert.equal(sent.filter(name => name === method).length, method === "session/new" && harness !== "codex" ? 1 : 0, label + ": " + method);
    assert.equal(await control.checkpoint!(), before, label + ": the conversation is the same one");
    assert.equal(control.healthy!(), true, label);
  }
  // dsh has no commands: its `/clear` is text, and the packet goes with it.
  const dsh = await peerRoot(t, { RELAY_JOIN: "" }), plain = await opened(t, "dsh", dsh);
  assert.equal((await run(plain.control, plain.id, relayTurn(ID_A, "/clear", false))).result.status, "completed");
  assert.equal((await prompts(dsh))[0]!.length, 2, "dsh: the packet and the words");
});

// G074-F1: a Turn whose words have whitespace before a slash word was refused whole as a command (and, as `/clear`, would have been
// run as the clear), although Claude Code takes it as words (probe record 2026-11-10): it carries the packet like any other words.
test("G074-F1 a relay Turn whose words have whitespace before a slash word is words for Claude Code and carries the packet, nothing cleared; with the slash first the same words are refused whole", { timeout: 60000 }, async t => {
  for (const words of [" /clear", "　/compact keep the tests", "\n/remote-control", "\t/reset"]) {
    const peer = await peerRoot(t), { control, id } = await opened(t, "claude", peer), label = JSON.stringify(words);
    const { result } = await run(control, id, relayTurn(ID_A, words, false));
    assert.deepEqual([result.status, result.input, result.native], ["completed", "recorded", undefined], label);
    const [parts] = await prompts(peer);
    assert.equal(parts!.length, 2, label + ": the packet and the words, two blocks");
    assert.equal(titledPacket(parts![0]!), ID_A, label + ": the packet goes first");
    assert.equal(parts![1], words, label + ": the words as typed, last");
    assert.equal(await control.checkpoint!(), id, label + ": nothing was cleared");
  }
  // The invalid samples: with the slash first the same words are the native side's command, and the Turn is refused whole.
  for (const words of ["/clear", "/compact keep the tests", "/remote-control", "/reset"]) {
    const peer = await peerRoot(t, COMPACT_LISTED), { control, id } = await opened(t, "claude", peer);
    refused((await run(control, id, relayTurn(ID_A, words, false))).result, "slash first " + JSON.stringify(words));
    assert.deepEqual(await prompts(peer), [], "nothing sent");
  }
});

// G074-F3 (probe record 2026-11-10, F3): "/zzprobe-unlisted hello" was sent to the model as text by Claude Code, so the declaration's
// unlistedSlash is "text" and a word outside the catalog is words: a Turn with it carries a packet, and its answer proves it recorded.
test("G074-F3 Claude Code: a slash word its catalog does not list is words — recorded by the answer, and a relay Turn carries the packet with it; a listed command, a hidden one and (no catalog yet) a possible command still stop it", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact" }, { name: "review", description: "review" }]) });
  const { control, id } = await opened(t, "claude", peer);
  await control.models!();
  const plain = await run(control, id, "/zzprobe-unlisted hello");
  assert.deepEqual([plain.result.status, plain.result.input], ["completed", "recorded"], "words: its answer proves the input recorded");
  for (const words of ["/zzprobe-unlisted hello", "/my-skill"]) {
    const { result } = await run(control, id, relayTurn(ID_A, words, false));
    assert.deepEqual([result.status, result.input, result.native], ["completed", "recorded", undefined], words);
    const [parts] = (await prompts(peer)).slice(-1);
    assert.deepEqual([parts!.length, titledPacket(parts![0]!), parts![1]], [2, ID_A, words], words + ": the packet first, the words as typed last");
  }
  // The invalid samples: what the catalog lists, and what the CLI runs although it lists none, is the native side's command.
  const before = (await prompts(peer)).length;
  for (const words of ["/review now", "/compact keep the tests", "/clear", "/remote-control"]) refused((await run(control, id, relayTurn(ID_A, words, false))).result, words);
  assert.equal((await prompts(peer)).length, before, "nothing was sent for them");
  // Before any catalog is announced a slash word may be one the catalog lists: it waits (B9), as for the other Drivers.
  const quiet = await peerRoot(t, { RELAY_NO_COMMANDS: "1" }), waiting = await opened(t, "claude", quiet);
  refused((await run(waiting.control, waiting.id, relayTurn(ID_A, "/zzprobe-unlisted hello", false))).result, "no catalog yet");
  assert.deepEqual(await prompts(quiet), []);
});

// Before the agent has announced a catalog a slash word may be one the catalog lists, and a command's answer proves nothing about the
// history: it is not taken for content yet, as the relay's reading (possible_command) has it. Once the catalog is known, a word outside
// it is words, and its answer proves it recorded.
test("G074-F3 Claude Code: before the agent announced any command a slash word's answer proves nothing (it may be a listed command); once the catalog is known, a word outside it is recorded by its answer", { timeout: 60000 }, async t => {
  const quiet = await peerRoot(t, { RELAY_NO_COMMANDS: "1" }), { control, id } = await opened(t, "claude", quiet);
  const unsettled = await run(control, id, "/zzprobe-unlisted hello");
  assert.deepEqual([unsettled.result.status, unsettled.result.input], ["completed", undefined], "no catalog yet: its answer proves nothing");
  assert.equal((await run(control, id, "没有斜杠的话")).result.input, "recorded", "words without a slash are recorded by the answer");
  await control.models!();
  const settled = await run(control, id, "/zzprobe-unlisted hello");
  assert.deepEqual([settled.result.status, settled.result.input], ["completed", "recorded"], "the catalog is known and lists no such word: words");
});

// The Hub offers its own /export when the agent lists none (models()); a relay Turn with those words must still be refused whole, not
// run as the export with the packet dropped — the Driver's own check reads the catalog it offers, not only the agent's.
test("G074-F3 a relay Turn whose words are the Hub's own /export (offered when Claude Code lists none) is refused whole, the export not run", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "claude", peer);
  const catalog = await control.models!();
  assert.ok(catalog.commands?.some(command => command.name === "export"), "the Hub offers its own /export");
  const { result, events } = await run(control, id, relayTurn(ID_A, "/export", false));
  refused(result, "claude /export");
  assert.deepEqual([events, await prompts(peer)], [[], []], "no export output, nothing sent");
  // The invalid sample: the same words alone are the Hub's export, which sends nothing to Claude either.
  const alone = await run(control, id, "/export");
  assert.equal(alone.result.input, "not_recorded"); assert.deepEqual(await prompts(peer), []);
});

test("G069-F1 a possible command (no catalog yet) is refused the same; a bare /queue submits nothing, so it takes no packet and is no relay command; /queue with words still carries it", { timeout: 60000 }, async t => {
  for (const [harness, words] of [["opencode", "/review now"], ["claude", "/review"], ["hermes", "/skill-from-gateway go"], ["openclaw", "/think high"]] as const) {
    const peer = await peerRoot(t, { RELAY_NO_COMMANDS: "1" }), { control, id } = await opened(t, harness, peer);
    const { result, events } = await run(control, id, relayTurn(ID_A, words, false));
    refused(result, harness);
    assert.deepEqual([events, await prompts(peer)], [[], []], harness);
  }
  assert.deepEqual(hermesRelayCapabilities.commands.classify("/queue", null, []), { kind: "command", name: "queue", args: "", effect: "keep" }, "a bare /queue only answers its usage");
  assert.deepEqual(hermesRelayCapabilities.commands.classify("/steer ", null, []), { kind: "command", name: "steer", args: "", effect: "keep" });
  const peer = await peerRoot(t), { control, id } = await opened(t, "hermes", peer);
  refused((await run(control, id, relayTurn(ID_A, "/queue", false))).result, "bare /queue");
  assert.equal((await run(control, id, relayTurn(ID_A, "/queue 修好测试", false))).result.status, "completed");
  assert.deepEqual((await prompts(peer)).at(-1)!.length, 3, "the command word, the packet, the words");
});

// ---------------------------------------------------------------------------------------------------------------------
// F2, F6 (review B1, I2): Claude's synthetic clear opens no session ahead
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F2 Claude Code's /clear opens no session ahead: replaced.checkpoint is null, the old session is abandoned and closed, its late updates are counted and dropped; the next connection starts a new session", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_CLOSE: "1", RELAY_LATE_MS: "250", RELAY_UNPROMPTED_LOAD: "1" });
  // Why no session is opened ahead: a session never prompted cannot be resumed by another process (claude-agent-acp 0.99.1).
  const ahead = await opened(t, "claude", peer), unprompted = ahead.id; await ahead.control.close();
  const other = driver(t, "claude", peer); await other.initialize();
  await assert.rejects(other.open(peer.workspace, undefined, undefined, unprompted), "a session never prompted cannot be loaded in a new process");
  const { control, id } = await opened(t, "claude", peer);
  await run(control, id, "先说一句");
  const cleared = await run(control, id, "/clear");
  assert.deepEqual(cleared.result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true, replaced: { checkpoint: null } } });
  assert.equal(await control.checkpoint!(), null, "no session to resume: the next Turn opens one");
  const sent = (await peer.sent()).filter(line => line.method === "session/new" || line.method === "session/close");
  assert.deepEqual(sent.map(line => [line.method, line.params?.sessionId ?? null]), [["session/new", null], ["session/new", null], ["session/close", id]], "no session/new for the clear; the old session closed");
  assert.deepEqual(await prompts(peer), [["先说一句"]], "nothing reached Claude for the clear");
  await assert.rejects(control.startText(id, "旧会话", () => {}), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH");
  await assert.rejects(control.deliveryPosition!(id), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH");
  const counted = control.unattributedUpdates ?? 0;
  await sleep(500);
  assert.equal(control.healthy!(), true, "the old session's late message and permission request did not fail the connection");
  assert.ok((control.unattributedUpdates ?? 0) >= counted + 2, "both were counted");
  const next = driver(t, "claude", peer); await next.initialize();
  const fresh = await next.open(peer.workspace);
  assert.notEqual(fresh, id);
  assert.equal((await run(next, fresh, "继续")).result.status, "completed");
});

test("G069-F6 a clear the adapter does not acknowledge still clears: session/close refused or never answered leaves the connection usable, its configuration as it was, and open() on it starts a new session", { timeout: 60000 }, async t => {
  for (const fault of ["refuse", "hang"]) {
    const peer = await peerRoot(t, { RELAY_CLOSE: fault }), { control, id } = await opened(t, "claude", peer);
    await run(control, id, "先说一句");
    const configuration = await control.nativeConfig!();
    const started = Date.now(), { result } = await run(control, id, "/clear");
    assert.deepEqual(result.native, { cleared: true, replaced: { checkpoint: null } }, fault);
    assert.equal(result.status, "completed", fault);
    assert.ok(Date.now() - started < 2600, fault + ": within about two seconds");
    assert.equal(control.healthy!(), true, fault);
    assert.deepEqual(await control.nativeConfig!(), configuration, fault + ": the catalog's values were not replaced");
    assert.equal((await methods(peer)).filter(method => method === "session/new").length, 1, fault + ": no session opened for the clear");
    const reopened = await control.open(peer.workspace);
    assert.notEqual(reopened, id, fault);
    assert.equal((await run(control, reopened, "继续")).result.status, "completed", fault);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// F3 (review B2): OpenClaw never reads "not read" as "read whole"
// ---------------------------------------------------------------------------------------------------------------------

const user = (seq: number, text: string) => ({ role: "user", content: "[Working directory: ~/ws]\n\n" + text, __openclaw: { seq } });
const assistant = (seq: number) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], __openclaw: { seq } });
const reset = (seq: number) => ({ role: "system", content: [{ type: "text", text: "Reset" }], __openclaw: { kind: "reset", seq } });
async function claw(t: Parameters<typeof driver>[0], messages: readonly Record<string, unknown>[] | ((params: Readonly<Record<string, unknown>>) => Promise<unknown>), extra: Parameters<typeof gatewayOf>[1] = {}) {
  const own = await peerRoot(t, { RELAY_OPENCLAW: "1" });
  const bridge = driver(t, "openclaw", own, gatewayOf(own, { "sessions.get": typeof messages === "function" ? messages : async () => ({ messages }), ...extra }));
  await bridge.initialize(); const session = await bridge.open(own.workspace);
  return { bridge, session, own };
}

test("G069-F3 OpenClaw: an empty transcript after a position is unavailable, a short window that starts after the position is outside_window, a row without its sequence makes the whole check unavailable and the position none", { timeout: 60000 }, async t => {
  const empty = await claw(t, []);
  const nothing = await empty.bridge.verifyDelivered!(empty.session, ask([[ID_A, { kind: "seq", before: 5 }]], true));
  assert.deepEqual([results(nothing), nothing.historyEmpty], [["unavailable"], null], "nothing read is not a whole history");
  const short = await claw(t, [user(10, "第十条"), assistant(11)]);
  assert.deepEqual(results(await short.bridge.verifyDelivered!(short.session, ask([[ID_A, { kind: "seq", before: 5 }], [ID_A, { kind: "seq", before: 8 }], [ID_A, { kind: "seq", before: 9 }]]))),
    ["outside_window", "outside_window", "absent"], "rows 6–9 (row 9 after position 8) were not seen; after position 9 the window starts at the next row");
  const unnumbered = await claw(t, [user(1, packet(ID_A, WORDS) + "\n\n" + WORDS), { role: "assistant", content: [{ type: "text", text: "ok" }] }]);
  const partial = await unnumbered.bridge.verifyDelivered!(unnumbered.session, ask([[ID_A, { kind: "seq", before: 0 }], [ID_B, { kind: "seq", before: 0 }]], true));
  assert.deepEqual([results(partial), partial.historyEmpty], [["unavailable", "unavailable"], null]);
  const last = await claw(t, async () => ({ messages: [{ role: "user", content: "x" }] }));
  assert.deepEqual(await last.bridge.deliveryPosition!(last.session), { kind: "none" }, "a row without its number is no position");
});

test("G069-F3 OpenClaw gives historyEmpty true only with proof: sessions.describe names the session and a reset row was seen; a user or assistant row after a reset row is false; an unconfirmed clear's check without a reset row trusts no row (sessions.get may have read the archive of the history the clear emptied)", { timeout: 60000 }, async t => {
  const proven = await claw(t, [reset(1)], { "sessions.describe": async () => ({ session: { lifecycleRevision: "r2" } }) });
  const cleared = await proven.bridge.verifyDelivered!(proven.session, ask([[ID_A, { kind: "seq", before: 7 }]], true));
  assert.deepEqual([results(cleared), cleared.historyEmpty], [["absent"], true]);
  const unseen = await claw(t, [reset(1)], { "sessions.describe": async () => { throw new Error("no describe"); } });
  assert.equal((await unseen.bridge.verifyDelivered!(unseen.session, ask([[ID_A, { kind: "seq", before: 7 }]], true))).historyEmpty, null, "the session is not confirmed");
  const talkedSince = await claw(t, [reset(1), assistant(2)]);
  assert.equal((await talkedSince.bridge.verifyDelivered!(talkedSince.session, ask([[ID_A, { kind: "seq", before: 0 }]], true))).historyEmpty, false);
  // Rows without a reset row may be the archive sessions.get reads while the active transcript is empty: nothing is trusted.
  const archived = await claw(t, [user(40, packet(ID_A, WORDS) + "\n\n" + WORDS), assistant(41)]);
  const unsure = await archived.bridge.verifyDelivered!(archived.session, ask([[ID_A, { kind: "seq", before: 39 }]], true));
  assert.deepEqual([results(unsure), unsure.historyEmpty], [["unavailable"], null]);
  const plain = await archived.bridge.verifyDelivered!(archived.session, ask([[ID_A, { kind: "seq", before: 39 }]]));
  assert.deepEqual([results(plain), plain.historyEmpty], [["present"], null], "not asked whether the history is empty: read as usual");
});

// ---------------------------------------------------------------------------------------------------------------------
// F4 (review B3): Codex says absent only of a message it found
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F4 Codex: an identity it does not find in a whole thread is unavailable, not absent; absent only when that identity's own message lacks the title line; the first page is the latest five turns", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "codex", peer);
  const position = await control.deliveryPosition!(id);
  await run(control, id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, position]]))), ["present"]);
  const pages = (await peer.sent()).filter(line => line.method === "thread/turns/list").map(line => line.params?.limit);
  assert.deepEqual(pages, [5], "the latest turns first, and no more once found");
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_B, { kind: "client_id", id: "never-sent" }]]))), ["unavailable"], "not found is not absent");
  const plain = await control.deliveryPosition!(id); await run(control, id, "随便聊聊");
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, plain]]))), ["absent"], "its own message, without the title line");
  // historyEmpty only of a thread that holds nothing at all: a thread with an agent message is not empty.
  const agentOnly = await peerRoot(t);
  await writeFile(agentOnly.state, JSON.stringify({ sessions: {}, threads: { "thread-relay": { name: null, turns: [{ id: "seed", status: "completed", items: [{ type: "agentMessage", id: "a", text: "hi" }] }] } } }));
  const blank = await opened(t, "codex", agentOnly, "thread-relay");
  assert.equal((await blank.control.verifyDelivered!(blank.id, ask([[ID_A, { kind: "client_id", id: "x" }]], true))).historyEmpty, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// F5 (approval C6, review I3): a check or a title never harms the connection
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F5 Codex: a listing that never answers, or answers too late, is unavailable within about two seconds and the next turn runs; a title that is never answered rejects NATIVE_TITLE_UNAVAILABLE and the connection stays usable", { timeout: 60000 }, async t => {
  for (const settings of [{ RELAY_TURNS_FAULT: "hang" }, { RELAY_TURNS_DELAY_MS: "2600" }]) {
    const peer = await peerRoot(t, settings), { control, id } = await opened(t, "codex", peer);
    const started = Date.now();
    assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, { kind: "client_id", id: "x" }]]))), ["unavailable"], JSON.stringify(settings));
    assert.ok(Date.now() - started < 2500, "about two seconds");
    await sleep(settings.RELAY_TURNS_DELAY_MS === undefined ? 0 : 1000);
    assert.equal(control.healthy!(), true, JSON.stringify(settings) + ": a late answer is dropped, not a protocol failure");
    assert.equal((await run(control, id, "继续")).result.status, "completed", JSON.stringify(settings));
  }
  const naming = await peerRoot(t, { RELAY_NAME_FAULT: "hang" }), titled = await opened(t, "codex", naming);
  const started = Date.now();
  await assert.rejects(titled.control.setTitle!(titled.id, "修好测试"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  assert.ok(Date.now() - started < 2500);
  assert.equal(titled.control.healthy!(), true);
  assert.equal((await run(titled.control, titled.id, "开始")).result.status, "completed");
});

test("G069-F5 Hermes: a /title that is never answered rejects NATIVE_TITLE_UNAVAILABLE within its bound and the next turn runs on the same connection", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_HERMES: "1", RELAY_TITLE_FAULT: "hang" }), { control, id } = await opened(t, "hermes", peer, undefined, { runTimeoutMs: 6000 });
  const started = Date.now();
  await assert.rejects(control.setTitle!(id, "修好测试"), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_TITLE_UNAVAILABLE");
  assert.ok(Date.now() - started < 3000, "its own bound, not the Turn's");
  assert.equal(control.healthy!(), true);
  assert.equal((await run(control, id, "继续")).result.status, "completed");
});

test("G069-F5 every Driver's check survives a fault and the next turn on the same connection runs: Claude (a transcript it cannot read or parse), Hermes (positions of another kind), OpenClaw (sessions.get that hangs or answers garbage); OpenCode and dsh have no check", { timeout: 30000 }, async t => {
  const claude = await peerRoot(t); (claude.env as Record<string, string>).RELAY_TRANSCRIPT = claude.env.CLAUDE_CONFIG_DIR!;
  const c = await opened(t, "claude", claude);
  await run(c.control, c.id, "先说一句");
  const at = await c.control.deliveryPosition!(c.id);
  assert.equal(at.kind, "file_offset");
  if (at.kind !== "file_offset") return;
  const file = join(claude.env.CLAUDE_CONFIG_DIR!, "projects", at.path);
  await appendFile(file, "garbage that is not json\n");
  assert.deepEqual(results(await c.control.verifyDelivered!(c.id, ask([[ID_A, at]]))), ["unavailable"], "nothing the client wrote after the position");
  await chmod(file, 0o000);
  try { assert.deepEqual(results(await c.control.verifyDelivered!(c.id, ask([[ID_A, at]]))), ["unavailable"], "unreadable"); }
  finally { await chmod(file, 0o600); }
  assert.equal((await run(c.control, c.id, "继续")).result.status, "completed", "claude");
  const hermes = await peerRoot(t), h = await opened(t, "hermes", hermes);
  // A position of another kind is unavailable; one without a position is looked for whole in this (new, empty) history (I5).
  assert.deepEqual(results(await h.control.verifyDelivered!(h.id, ask([[ID_A, { kind: "client_id", id: "x" }], [ID_A, { kind: "none" }]]))), ["unavailable", "absent"]);
  assert.equal((await run(h.control, h.id, "继续")).result.status, "completed", "hermes");
  let hung = false;
  const hanging = await claw(t, async params => { if (params.limit === 200 && !hung) { hung = true; return new Promise(() => {}); } return { messages: [] }; });
  const started = Date.now();
  assert.deepEqual(results(await hanging.bridge.verifyDelivered!(hanging.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["unavailable"]);
  assert.ok(Date.now() - started < 2500, "openclaw: about two seconds");
  assert.equal((await run(hanging.bridge, hanging.session, "继续")).result.status, "completed", "openclaw after a hang");
  const garbage = await claw(t, async params => params.limit === 200 ? { messages: [null, 7, "x"] } : { messages: [] });
  assert.deepEqual(results(await garbage.bridge.verifyDelivered!(garbage.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["unavailable"]);
  assert.equal((await run(garbage.bridge, garbage.session, "继续")).result.status, "completed", "openclaw after garbage");
  for (const harness of ["opencode", "dsh"] as const) {
    const peer = await peerRoot(t), control = driver(t, harness, peer);
    assert.equal(control.verifyDelivered, undefined, harness + ": no check (verify none)");
    assert.equal(control.deliveryPosition, undefined, harness);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// F7 (review I4): Hermes's replay at open does not hold what this connection wrote
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F7 Hermes: after a prompt on this connection the check is unavailable with historyEmpty null and the position none; a later open reads it again", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "hermes", peer);
  const position = await control.deliveryPosition!(id);
  assert.deepEqual(position, { kind: "seq", before: 0 });
  await run(control, id, relayTurn(ID_A, WORDS));
  const stale = await control.verifyDelivered!(id, ask([[ID_A, position]], true));
  assert.deepEqual([results(stale), stale.historyEmpty, stale.compaction], [["unavailable"], null, null]);
  assert.deepEqual(await control.deliveryPosition!(id), { kind: "none" });
  const checkpoint = (await control.checkpoint!())!; await control.close();
  const next = await opened(t, "hermes", peer, checkpoint);
  assert.deepEqual(results(await next.control.verifyDelivered!(next.id, ask([[ID_A, position]]))), ["present"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// F8 (review I5) and the 16 MiB tail: Claude
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F8 Claude Code: a dispatched Turn whose transcript holds no client entry after the position is unavailable, not absent; a tail longer than a check reads is unavailable too", { timeout: 90000 }, async t => {
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const first = await opened(t, "claude", peer);
  await run(first.control, first.id, "先说一句");
  const checkpoint = (await first.control.checkpoint!())!; await first.control.close();
  // The adapter wrote this Turn elsewhere (a private session it swapped in): nothing grows after the position.
  (peer.env as Record<string, string>).RELAY_DROP = "1";
  const dropped = await opened(t, "claude", peer, checkpoint);
  const position = await dropped.control.deliveryPosition!(dropped.id);
  assert.ok(position.kind === "file_offset" && position.bytes > 0);
  await run(dropped.control, dropped.id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await dropped.control.verifyDelivered!(dropped.id, ask([[ID_A, position]]))), ["unavailable"]);
  if (position.kind !== "file_offset") return;
  // More than 16 MiB after the position, with a client entry first that does not carry it: not read whole.
  const file = join(peer.env.CLAUDE_CONFIG_DIR!, "projects", position.path), line = (value: Record<string, unknown>) => JSON.stringify({ sessionId: dropped.id, ...value }) + "\n";
  const handle = await openFile(file, "a");
  try {
    await handle.write(line({ type: "user", message: { role: "user", content: "我自己说的一句话" } }));
    const filler = line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(64 * 1024) }] } });
    for (let written = 0; written < 17 * 1024 * 1024; written += filler.length) await handle.write(filler);
  } finally { await handle.close(); }
  assert.deepEqual(results(await dropped.control.verifyDelivered!(dropped.id, ask([[ID_A, position]]))), ["unavailable"], "more follows than a check reads");
});

// ---------------------------------------------------------------------------------------------------------------------
// F9 (review I6): Claude with attachments
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F9 Claude Code reads any input with attachments as content (the CLI looks for a command only in the last block): /clear with a file is sent, its answer proves it recorded, and a relay Turn carries the packet", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), attachment = await fileIn(peer), { control, id } = await opened(t, "claude", peer);
  const catalog = await control.models!();
  for (const words of ["/clear", "  /export", "/compact now", "/remote-control"]) {
    assert.deepEqual(control.classify!(words, catalog, ["file"]), { kind: "content" }, words);
    assert.deepEqual(claudeRelayCapabilities.commands.classify(words, null, ["image"]), { kind: "content" }, words);
  }
  assert.deepEqual(control.classify!("/clear", catalog, []), { kind: "command", name: "clear", args: "", effect: "clear" }, "without one it is the clear");
  const plain = await run(control, id, "/clear", [attachment]);
  assert.deepEqual([plain.result.status, plain.result.input, plain.result.native], ["completed", "recorded", undefined]);
  assert.equal(await control.checkpoint!(), id, "no clear ran");
  const relayed = await run(control, id, relayTurn(ID_A, "/clear", false), [attachment]);
  assert.equal(relayed.result.input, "recorded");
  assert.equal(titledPacket((await prompts(peer)).at(-1)![0]!), ID_A, "the packet went first");
  assert.equal((await run(control, id, "/remote-control", [attachment])).result.status, "completed", "sent as content, not refused");
});

// ---------------------------------------------------------------------------------------------------------------------
// F10 (approval B1): the first client entry after a position needs the title line; a later one the title and end lines
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F10 a title line that names no packet does not hide the packet's own title line below it", () => {
  assert.equal(titledPacket("〔HarnessHub 交接单 不是一个标识〕\n" + packet(ID_A)), ID_A);
  assert.equal(titledPacket("〔HarnessHub 交接单 不是一个标识〕\n继续"), null);
});

test("G069-F10 RT2-09 / VF1-13 OpenClaw and Claude: the first client entry after the position is present with its title line alone; a later entry is present only with the title and end lines of the same packet; a pasted title line alone later is not", { timeout: 60000 }, async t => {
  const first = await claw(t, [user(1, titleOnly(ID_A) + "\n后面被截断了")]);
  assert.deepEqual(results(await first.bridge.verifyDelivered!(first.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["present"], "RT2-09: the first entry after the position");
  const late = await claw(t, [user(1, "别的消息"), assistant(2), user(3, packet(ID_A, WORDS) + "\n\n" + WORDS)]);
  assert.deepEqual(results(await late.bridge.verifyDelivered!(late.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["present"], "VF1-13: a late write, whole");
  const pasted = await claw(t, [user(1, "别的消息"), assistant(2), user(3, "我贴一下这一行：\n" + titleOnly(ID_A) + "\n你看看")]);
  assert.deepEqual(results(await pasted.bridge.verifyDelivered!(pasted.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["absent"], "a title line alone, not first");
  const endOfAnother = await claw(t, [user(1, "别的消息"), user(2, titleOnly(ID_A) + "\n〔记录结束 · " + ID_B + "〕")]);
  assert.deepEqual(results(await endOfAnother.bridge.verifyDelivered!(endOfAnother.session, ask([[ID_A, { kind: "seq", before: 0 }]]))), ["absent"], "the end line must name the same packet");
  // After a reset every row is searched, but only the first one numbered past the position reads by its title line alone.
  const renumbered = await claw(t, [reset(1), user(2, titleOnly(ID_A)), assistant(3), user(4, "之后的消息")]);
  assert.deepEqual(results(await renumbered.bridge.verifyDelivered!(renumbered.session, ask([[ID_A, { kind: "seq", before: 3 }], [ID_A, { kind: "seq", before: 1 }]]))), ["absent", "present"],
    "row 2 may lie before the position (same numbering): not by its title alone; past position 1 it is the first");
  // Claude: the same rule over the client entries after the byte position.
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const { control, id } = await opened(t, "claude", peer);
  await run(control, id, "先说一句");
  const position = await control.deliveryPosition!(id);
  if (position.kind !== "file_offset") throw new Error("a file position");
  const file = join(peer.env.CLAUDE_CONFIG_DIR!, "projects", position.path), entry = (text: string) => JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: text } }) + "\n";
  await appendFile(file, entry("别的消息") + entry("我贴一下：\n" + titleOnly(ID_A)));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, position]]))), ["absent"], "claude: a pasted title line, not first");
  await appendFile(file, entry(packet(ID_A, WORDS) + "\n\n" + WORDS));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, position]]))), ["present"], "claude: a later whole packet");
  const head = await control.deliveryPosition!(id);
  await appendFile(file, entry(titleOnly(ID_B) + "\n截断"));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_B, head]]))), ["present"], "claude: first after its position, title alone");
});

test("G069-F10 Hermes works out whole packets while it reads the replay: a later entry whose end line lies past the kept head is present, a later pasted title line is absent", { timeout: 60000 }, async t => {
  const long = packet(ID_A, WORDS).replace("修好测试", "修好测试" + "很长的记录。".repeat(1200));
  assert.ok(long.length > 4096, "the end line lies past the 4096 characters a replay entry keeps");
  const row = (role: string, text: string) => ({ role, text });
  const peer = await peerRoot(t);
  await writeFile(peer.state, JSON.stringify({ threads: {}, sessions: { "relay-session": { entries: [row("user", "别的话"), row("assistant", "ok"), row("user", long + "\n\n\n" + WORDS), row("assistant", "ok"),
    row("user", "我贴一下：\n" + titleOnly(ID_B)), row("assistant", "ok")], seq: 0, revision: "r", title: null, cwd: null } } }));
  const { control, id } = await opened(t, "hermes", peer, "relay-session");
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, { kind: "seq", before: 0 }], [ID_B, { kind: "seq", before: 0 }]]))), ["present", "absent"]);
  // A packet folded into a merged compaction summary is compacted, not absent.
  const merged = await peerRoot(t);
  await writeFile(merged.state, JSON.stringify({ threads: {}, sessions: { "relay-session": { entries: [{ role: "user", text: "[PRIOR CONTEXT — for reference only; not a new message]\n" + packet(ID_B, WORDS) + "\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n摘要", summary: true },
    row("assistant", "ok")], seq: 0, revision: "r", title: null, cwd: null } } }));
  const folded = await opened(t, "hermes", merged, "relay-session");
  assert.deepEqual(results(await folded.control.verifyDelivered!(folded.id, ask([[ID_B, { kind: "seq", before: 0 }]]))), ["compacted"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// F11 (approval B8): attachments follow the user's words in every Driver's placement
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F11 every Driver places attachments after the user's words, as its declaration now says (pointersAfterUser true for all six, still to be probed)", { timeout: 60000 }, async t => {
  const declared: Readonly<Record<Harness, RelayCapabilities>> = { claude: claudeRelayCapabilities, codex: codexRelayCapabilities, opencode: openCodeRelayCapabilities, dsh: dshRelayCapabilities, hermes: hermesRelayCapabilities, openclaw: openClawRelayCapabilities };
  for (const harness of Object.keys(declared) as Harness[]) {
    assert.equal(declared[harness].placement.pointersAfterUser, true, harness);
    const peer = await peerRoot(t, harness === "openclaw" ? { RELAY_OPENCLAW: "1" } : {}), attachment = await fileIn(peer), { control, id } = await opened(t, harness, peer);
    assert.equal((await run(control, id, relayTurn(ID_A, WORDS), [attachment])).result.status, "completed", harness);
    const sent = await peer.sent();
    if (harness === "codex") {
      const input = (sent.find(line => line.method === "turn/start")!.params as { input: { type: string; text?: string }[] }).input;
      assert.deepEqual(input.map(item => item.type), ["text"], harness);
      const text = input[0]!.text!;
      // The packet starts with a copy of the words' first line; the words themselves come after its end line.
      assert.ok(text.lastIndexOf(WORDS) > text.lastIndexOf(ID_A) && text.indexOf("[Attached file] notes.txt") > text.lastIndexOf(WORDS), harness + ": the packet, the words, then the file's pointer");
      continue;
    }
    const blocks = (sent.find(line => line.method === "session/prompt")!.params as { prompt: { type: string; text?: string }[] }).prompt;
    if (harness === "hermes") {
      assert.deepEqual(blocks.map(block => block.type), ["text", "text"], harness);
      assert.ok(blocks[1]!.text!.startsWith(WORDS + "\n\n[Attached file] notes.txt"), harness + ": the pointer after the words");
    } else if (harness === "openclaw") {
      assert.deepEqual(blocks.map(block => block.type), ["text", "resource_link"], harness + ": the attachment's block after the one text");
      assert.ok(blocks[0]!.text!.endsWith("\n\n" + WORDS), harness);
    } else {
      assert.deepEqual(blocks.map(block => block.type), ["text", "text", "resource_link"], harness + ": the attachment's block after the words");
      assert.equal(blocks[1]!.text, WORDS, harness);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Minor items: input bound with pointers; Claude's position relative to its configuration directory
// ---------------------------------------------------------------------------------------------------------------------

test("G069 a declared input bound counts Hub's file pointers too: words and pointers over the bound are not sent", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t), attachment = await fileIn(peer);
  class Pointing extends AcpControl { protected override get fileBlocks(): boolean { return false; } }
  const turn = relayTurn(ID_A, WORDS, false), size = [...turn.relay.body + "\n\n" + WORDS].length;
  const declaration: RelayCapabilities = { ...dshRelayCapabilities, placement: { ...dshRelayCapabilities.placement, maxInput: { unit: "chars", limit: size + 10 } } };
  const launch: ControlLaunch = { protocol: "acp-v1", executable: process.execPath, args: [join(process.cwd(), "tests/fixtures/relay-control-peer.mjs")], env: peer.env };
  const control = new Pointing(launch, options(peer), declaration); t.after(() => control.close().then(() => undefined));
  await control.initialize(); const id = await control.open(peer.workspace);
  assert.equal((await run(control, id, turn)).result.status, "completed", "within the bound without the pointer");
  assert.equal((await run(control, id, turn, [attachment])).result.error?.code, "RELAY_INPUT_LIMIT", "the pointer takes it over the bound");
  assert.equal((await prompts(peer)).length, 1);
});

test("G069 Claude Code's position names its transcript relative to projects/ and a check reads only under the configuration directory; a file system error is no position", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const { control, id } = await opened(t, "claude", peer);
  await run(control, id, relayTurn(ID_A, WORDS));
  const position = await control.deliveryPosition!(id);
  if (position.kind !== "file_offset") throw new Error("a file position");
  assert.ok(!isAbsolute(position.path) && position.path.split("/").length === 2 && position.path.endsWith("/" + id + ".jsonl"), position.path);
  const absolute = join(peer.env.CLAUDE_CONFIG_DIR!, "projects", position.path);
  assert.equal((await stat(absolute)).size, position.bytes);
  // A transcript of this session outside projects/ (the configuration directory itself) is never read, whatever it holds.
  await writeFile(join(peer.env.CLAUDE_CONFIG_DIR!, id + ".jsonl"), JSON.stringify({ type: "user", sessionId: id, message: { role: "user", content: packet(ID_A, WORDS) } }) + "\n");
  for (const path of [absolute, "../" + position.path, position.path.replace(/^[^/]+/u, ".."), "x/y/" + id + ".jsonl", position.path + "/more", id + ".jsonl"])
    assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, { kind: "file_offset", path, bytes: 0 }]]))), ["unavailable"], path);
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, { kind: "file_offset", path: position.path, bytes: 0 }]]))), ["present"]);
  // A transcript path the file system cannot resolve (a symbolic link to itself): no position, no rejection.
  const looping = await peerRoot(t), loop = await opened(t, "claude", looping);
  const project = (await realpath(looping.workspace)).replace(/[^a-zA-Z0-9]/g, "-"), directory = join(looping.env.CLAUDE_CONFIG_DIR!, "projects", project);
  await mkdir(directory, { recursive: true }); await symlink(join(directory, loop.id + ".jsonl"), join(directory, loop.id + ".jsonl"));
  assert.deepEqual(await loop.control.deliveryPosition!(loop.id), { kind: "none" });
});
