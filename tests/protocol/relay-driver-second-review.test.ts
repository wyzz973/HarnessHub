import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlEvent, ControlLaunch, HarnessControl, VerifyRequest } from "../../src/contracts/control.js";
import { contentId, type ContentKind, type ControlAttachment } from "../../src/contracts/content.js";
import type { DeliveryPosition, RelayCapabilities, RelayPacketId } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, gatewayOf, ID_A, ID_B, ID_C, options, packet, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, the corrections after the second independent review of d20bfc1 (its "fix now" list): one test per item,
// against the native behaviour the relay peer (tests/fixtures/relay-control-peer.mjs, a real child process) or the OpenClaw
// Gateway stand-in plays. Several of them pin behaviour the first fix batch already had but no test held (mutations that
// survived the review): a relay Turn refused before any side effect, a row without its number among others, a replay of
// agent entries alone, a gave-up session handed out again, the generic driver's own refusal. Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
const NONE: DeliveryPosition = { kind: "none" };
const ask = (markers: readonly [RelayPacketId, DeliveryPosition][], historyEmpty = false): VerifyRequest => ({ markers: markers.map(([packetId, position]) => ({ packetId, position })), historyEmpty });
const results = (verified: Awaited<ReturnType<NonNullable<HarnessControl["verifyDelivered"]>>>) => verified.markers.map(marker => marker.result);
/** A packet's title line alone, as a user who pasted only it would send it, or a packet cut after its title. */
const titleOnly = (id: RelayPacketId) => "〔HarnessHub 交接单 " + id + "〕";
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string, gateway = gatewayOf(peer)) {
  const control = driver(t, harness, peer, gateway);
  await control.initialize();
  return { control, id: await control.open(peer.workspace, undefined, undefined, checkpoint) };
}
async function seed(peer: Peer, state: unknown): Promise<void> { await writeFile(peer.state, JSON.stringify(state)); }
/** One native history row of the peer's state (Hermes's replay reads them back), and a session of such rows. */
const row = (role: string, text: string, extra: Record<string, unknown> = {}) => ({ role, text, ...extra });
const hermesSession = (entries: readonly Record<string, unknown>[]) => ({ threads: {}, sessions: { "relay-session": { entries, seq: 0, revision: "r", title: null, cwd: null } } });
/** The refusal of a relay Turn whose words the native side reads as a command (G069-F1, approval B4b), with no event at all. */
function refused(turn: { readonly result: BackendResult; readonly events: readonly ControlEvent[] }, label: string): void {
  assert.deepEqual({ ...turn.result, error: turn.result.error === undefined ? undefined : { code: turn.result.error.code } },
    { status: "failed", reason: "classification_changed", input: "not_recorded", error: { code: "RELAY_PREPARE_FAILED" } }, label);
  assert.deepEqual(turn.events, [], label + ": nothing said");
}
/** An attachment of `kind` written into the peer's root: a few bytes, never read by the native side here. */
async function attachment(peer: Peer, name: string, kind: ContentKind): Promise<ControlAttachment> {
  const path = join(peer.root, name), data = kind === "image" ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) : Buffer.from("RIFF0000WAVE");
  await writeFile(path, data);
  return { id: contentId("content-g069r2" + name.replace(/[^a-z]/gu, "")), name, mediaType: kind === "image" ? "image/png" : kind === "audio" ? "audio/wav" : "text/plain", kind, bytes: data.length, sha256: "0".repeat(64), path };
}
// OpenClaw transcript rows as sessions.get returns them (the bridge's working-directory prefix on user rows).
const user = (seq: number, text: string) => ({ role: "user", content: "[Working directory: ~/ws]\n\n" + text, __openclaw: { seq } });
const assistant = (seq: number) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], __openclaw: { seq } });
async function claw(t: Parameters<typeof driver>[0], messages: readonly Record<string, unknown>[] | ((params: Readonly<Record<string, unknown>>) => Promise<unknown>)) {
  const own = await peerRoot(t, { RELAY_OPENCLAW: "1" });
  const bridge = driver(t, "openclaw", own, gatewayOf(own, { "sessions.get": typeof messages === "function" ? messages : async () => ({ messages }) }));
  await bridge.initialize(); const session = await bridge.open(own.workspace);
  return { bridge, session };
}

// ---------------------------------------------------------------------------------------------------------------------
// I1: Codex's historyEmpty
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2-I1 Codex: historyEmpty is true only for a thread read whole without any turn; turns Codex lists without their items are not known to be empty (null); a thread read in part that showed an item is not empty (false)", { timeout: 60000 }, async t => {
  const itemless = await peerRoot(t);
  await seed(itemless, { sessions: {}, threads: { "thread-relay": { name: null, turns: Array.from({ length: 3 }, (_, index) => ({ id: "bare-" + index, status: "completed" })) } } });
  const three = await opened(t, "codex", itemless, "thread-relay");
  const unknown = await three.control.verifyDelivered!(three.id, ask([[ID_A, { kind: "client_id", id: "x" }]], true));
  assert.deepEqual([results(unknown), unknown.historyEmpty], [["unavailable"], null], "three turns whose items were not given: nothing says the thread is empty");
  // Twelve turns; the marker's own message is the newest, on the first page of five: the rest is not read, but items were seen.
  const said = (index: number) => ({ type: "userMessage", id: "u-" + index, content: [{ type: "text", text: "旧消息 " + index, text_elements: [] }], clientUserMessageId: "seed-" + index });
  const long = await peerRoot(t);
  await seed(long, { sessions: {}, threads: { "thread-relay": { name: null, turns: Array.from({ length: 12 }, (_, index) => ({ id: "seed-" + index, status: "completed", items: [said(index)] })) } } });
  const part = await opened(t, "codex", long, "thread-relay");
  const partial = await part.control.verifyDelivered!(part.id, ask([[ID_A, { kind: "client_id", id: "seed-11" }]], true));
  assert.deepEqual([results(partial), partial.historyEmpty, partial.compaction], [["absent"], false, null], "read in part: not empty, and no compaction cursor");
  assert.deepEqual((await long.sent()).filter(line => line.method === "thread/turns/list").map(line => line.params?.limit), [5], "one page read");
  assert.equal((await part.control.verifyDelivered!(part.id, ask([[ID_A, { kind: "client_id", id: "seed-11" }]]))).historyEmpty, null, "not asked: not answered");
});

// ---------------------------------------------------------------------------------------------------------------------
// Minor 2, 3: Claude Code's reading with audio, and its project directory name
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 Claude Code reads an input with audio alone as it reads one without attachments: claude-agent-acp drops audio blocks, so `/clear` with audio is the clear; an image or a file makes any input content", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "claude", peer);
  const catalog = await control.models!();
  const voice = await attachment(peer, "voice.wav", "audio");
  assert.deepEqual(control.classify!("/clear", catalog, ["audio"]), { kind: "command", name: "clear", args: "", effect: "clear" });
  assert.deepEqual(claudeRelayCapabilities.commands.classify("  /compact now", null, ["audio", "audio"]), { kind: "possible_command", name: "compact" });
  for (const kinds of [["audio", "image"], ["file", "audio"], ["image"], ["file"]] as const) assert.deepEqual(control.classify!("/clear", catalog, kinds), { kind: "content" }, kinds.join("+"));
  refused(await run(control, id, relayTurn(ID_A, "/clear", false), [voice]), "a relay Turn whose words are the clear, with audio");
  assert.deepEqual(await prompts(peer), [], "nothing sent for it");
  const cleared = await run(control, id, "/clear", [voice]);
  assert.deepEqual(cleared.result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true, replaced: { checkpoint: null } } }, "the driver runs the clear Claude Code would run");
  assert.deepEqual(await prompts(peer), [], "nothing reached Claude");
  // An image beside the audio: the CLI's last block is the image's, so the input is content and goes as it is.
  const other = await peerRoot(t), next = await opened(t, "claude", other), picture = await attachment(other, "shot.png", "image"), sound = await attachment(other, "voice.wav", "audio");
  const sent = await run(next.control, next.id, "/clear", [sound, picture]);
  assert.deepEqual([sent.result.status, sent.result.input, sent.result.native], ["completed", "recorded", undefined]);
  assert.deepEqual(await prompts(other), [["/clear"]]);
});

test("G069-R2 Claude Code names a workspace's project directory as claude-agent-acp does, a character outside the BMP as two `-` (session-index/project-dirs.js sanitize: /g, not /gu); the check finds the prompt the CLI wrote there", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t); (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
  const workspace = join(peer.root, "工作区-𝒳-😀"); await mkdir(workspace);
  const real = (await realpath(workspace)).normalize("NFC"), named = real.replace(/[^a-zA-Z0-9]/g, "-");
  assert.notEqual(named, real.replace(/[^a-zA-Z0-9]/gu, "-"), "the sample tells the two rules apart");
  const control = driver(t, "claude", peer); await control.initialize();
  const id = await control.open(workspace);
  const before = await control.deliveryPosition!(id);
  assert.deepEqual(before, { kind: "file_offset", path: named + "/" + id + ".jsonl", bytes: 0 }, "before the CLI wrote the session: the directory it will write");
  await run(control, id, relayTurn(ID_A, WORDS));
  const after = await control.deliveryPosition!(id);
  assert.ok(after.kind === "file_offset" && after.path === before.path && after.bytes > 0, "the CLI wrote it there: " + JSON.stringify(after));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, before]]))), ["present"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Minor 4: a refused relay Turn has no side effect before its refusal (review mutations M27, M29, M1b)
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 Hermes refuses a relay Turn read as a command before anything of it runs: no export (the Hub's /export is offered, models() read), and the replay read at open still counts as the history (the position stays)", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "hermes", peer);
  const catalog = await control.models!();
  assert.ok(catalog.commands?.some(command => command.name === "export"), "the Hub offers its own /export");
  const position = await control.deliveryPosition!(id);
  assert.deepEqual(position, { kind: "seq", before: 0 });
  for (const words of ["/export", "/clear", "/model openai:gpt-5.5", "/compress"]) {
    refused(await run(control, id, relayTurn(ID_A, words, false)), "hermes " + words);
    assert.deepEqual(await control.deliveryPosition!(id), position, words + ": nothing was sent, so the replay still holds the history");
  }
  assert.deepEqual(await prompts(peer), [], "no prompt");
  // The invalid sample: the same /export without a packet is the Hub's export (which fails here: the fixture's command line has no `acp`).
  const exported = await run(control, id, "/export");
  assert.deepEqual([exported.result.reason, exported.result.error?.code], ["export_failed", "NATIVE_EXPORT_UNAVAILABLE"]);
});

test("G069-R2 OpenClaw refuses a relay Turn read as a command before anything of it runs: no model patch (a model was selected, so one is due), no transcript read and no incarnation read", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }, { name: "reset", description: "reset" }]) });
  const calls: string[] = [];
  const answers = gatewayOf(peer, { "models.list": async () => ({ models: [{ provider: "vision", id: "large", name: "Vision" }] }),
    "sessions.patch": async () => ({ resolved: { modelProvider: "vision", model: "large" } }) });
  const control = driver(t, "openclaw", peer, async (method, params) => { calls.push(method); return answers(method, params); });
  await control.initialize();
  const id = await control.open(peer.workspace, "vision/large"); await control.models!();
  calls.length = 0;
  for (const words of ["/new", "/reset", "/new 重新开始"]) refused(await run(control, id, relayTurn(ID_A, words, false)), "openclaw " + words);
  assert.deepEqual(calls, [], "no Gateway call at all");
  assert.deepEqual(await prompts(peer), []);
  // The invalid sample: an ordinary Turn applies the selected model first.
  assert.equal((await run(control, id, relayTurn(ID_A, WORDS))).result.status, "completed");
  assert.deepEqual(calls.filter(method => method === "sessions.patch").length, 1, "the patch was due");
});

test("G069-R2 the generic driver refuses on its own (sendPrompt's reading): a declaration that reads commands refuses a relay Turn read as one with no Driver of its own before it, and carries the packet with content", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact" }]) });
  const declaration: RelayCapabilities = { ...dshRelayCapabilities, commands: { unlistedSlash: "text", hidden: [], classify: sharedClassify } };
  const launch: ControlLaunch = { protocol: "acp-v1", executable: process.execPath, args: [join(process.cwd(), "tests/fixtures/relay-control-peer.mjs")], env: peer.env };
  const control = new AcpControl(launch, options(peer), declaration); t.after(() => control.close().then(() => undefined));
  await control.initialize(); const id = await control.open(peer.workspace); await control.models();
  refused(await run(control, id, relayTurn(ID_A, "/compact", false)), "a listed command");
  assert.deepEqual(await prompts(peer), [], "nothing sent, not even the words");
  assert.equal((await run(control, id, relayTurn(ID_A, WORDS))).result.status, "completed");
  assert.deepEqual((await prompts(peer)).map(blocks => blocks.length), [2], "the packet and the words");
});

// ---------------------------------------------------------------------------------------------------------------------
// Minor 4: review mutations M15, M31, M33
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 OpenClaw: one row without its sequence number among several makes every marker unavailable, a numbered row with the packet before it included, and makes the position none", { timeout: 60000 }, async t => {
  const gap = await claw(t, [user(1, packet(ID_A, WORDS) + "\n\n" + WORDS), { role: "assistant", content: [{ type: "text", text: "ok" }] }, assistant(3), user(4, "之后的消息")]);
  assert.deepEqual(results(await gap.bridge.verifyDelivered!(gap.session, ask([[ID_A, { kind: "seq", before: 0 }], [ID_A, NONE]]))), ["unavailable", "unavailable"]);
  const position = await claw(t, async () => ({ messages: [user(5, "x"), { role: "user", content: "y" }, user(7, "z")] }));
  assert.deepEqual(await position.bridge.deliveryPosition!(position.session), { kind: "none" });
});

test("G069-R2 Hermes: a replay of agent entries alone is no empty history (historyEmpty false)", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t); await seed(peer, hermesSession([row("assistant", "Hermes 自己先说了一句")]));
  const { control, id } = await opened(t, "hermes", peer, "relay-session");
  const checked = await control.verifyDelivered!(id, ask([[ID_A, { kind: "seq", before: 0 }]], true));
  assert.deepEqual([results(checked), checked.historyEmpty], [["absent"], false]);
});

test("G069-R2 an agent that answers a new session with one this connection gave up is refused (IDENTITY_MISMATCH): Claude Code after its clear", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_SAME_SESSION: "1" }), { control, id } = await opened(t, "claude", peer);
  await run(control, id, "先说一句");
  assert.equal((await run(control, id, "/clear")).result.native?.cleared, true);
  await assert.rejects(control.open(peer.workspace), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH");
});

// ---------------------------------------------------------------------------------------------------------------------
// I5: a marker without a position, in a history read whole
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2-I5 Hermes: a marker without a position is looked for whole in a replay read whole (the kept process's relay Turn, on the next open): present, absent, compacted; a title line alone is not it; a replay cut to its latest entries, or a connection that prompted since its open (F7), is unavailable", { timeout: 60000 }, async t => {
  // A kept process: a prompt on this connection leaves the relay Turn after it without a position.
  const peer = await peerRoot(t), first = await opened(t, "hermes", peer);
  await run(first.control, first.id, "先说一句");
  assert.deepEqual(await first.control.deliveryPosition!(first.id), NONE);
  await run(first.control, first.id, relayTurn(ID_A, WORDS));
  const stale = await first.control.verifyDelivered!(first.id, ask([[ID_A, NONE]], true));
  assert.deepEqual([results(stale), stale.historyEmpty], [["unavailable"], null], "F7: what this connection sent is not in its replay");
  const checkpoint = (await first.control.checkpoint!())!; await first.control.close();
  const next = await opened(t, "hermes", peer, checkpoint);
  const found = await next.control.verifyDelivered!(next.id, ask([[ID_B, NONE], [ID_A, NONE]], true));
  assert.deepEqual([results(found), found.historyEmpty, found.foreignAfterLast], [["absent", "present"], false, 0]);
  // A title line alone is no whole packet; a packet folded into a compaction summary is compacted.
  const seeded = await peerRoot(t);
  await seed(seeded, hermesSession([row("user", "[PRIOR CONTEXT — for reference only; not a new message]\n" + packet(ID_C, WORDS) + "\n\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n\n摘要", { summary: true }),
    row("assistant", "ok"), row("user", titleOnly(ID_B) + "\n后面被截断了"), row("assistant", "ok")]));
  const folded = await opened(t, "hermes", seeded, "relay-session");
  assert.deepEqual(results(await folded.control.verifyDelivered!(folded.id, ask([[ID_B, NONE], [ID_C, NONE]]))), ["absent", "compacted"]);
  // More user entries than a check keeps: a whole packet among the kept ones is present, one not found is not absent.
  const many = await peerRoot(t);
  await seed(many, hermesSession([row("user", packet(ID_A, WORDS)), ...Array.from({ length: 1100 }, (_, index) => row("user", "第 " + index + " 条")), row("user", packet(ID_B, WORDS) + "\n\n\n" + WORDS)]));
  const wide = await opened(t, "hermes", many, "relay-session");
  assert.deepEqual(results(await wide.control.verifyDelivered!(wide.id, ask([[ID_A, NONE], [ID_B, NONE], [ID_C, NONE]]))), ["unavailable", "present", "unavailable"]);
});

test("G069-R2-I5 OpenClaw: a marker without a position is looked for whole in a window that holds the whole transcript (fewer rows than it reads, each numbered): present or compacted, absent when not found; a title line alone is not it; a full or an empty window is unavailable", { timeout: 60000 }, async t => {
  const whole = await claw(t, [user(1, "别的消息"), assistant(2), user(3, packet(ID_A, WORDS) + "\n\n" + WORDS), assistant(4), user(5, titleOnly(ID_B) + "\n后面被截断了")]);
  const verified = await whole.bridge.verifyDelivered!(whole.session, ask([[ID_B, NONE], [ID_C, NONE], [ID_A, NONE]]));
  assert.deepEqual([results(verified), verified.foreignAfterLast], [["absent", "absent", "present"], 1]);
  const compaction = { role: "system", content: [{ type: "text", text: "Compaction" }], __openclaw: { kind: "compaction", seq: 3 } };
  const folded = await claw(t, [user(1, packet(ID_A, WORDS)), assistant(2), compaction]);
  assert.deepEqual(results(await folded.bridge.verifyDelivered!(folded.session, ask([[ID_A, NONE]]))), ["compacted"]);
  const full = await claw(t, Array.from({ length: 200 }, (_, index) => user(50 + index, index === 120 ? packet(ID_A, WORDS) : "第 " + index + " 条")));
  assert.deepEqual(results(await full.bridge.verifyDelivered!(full.session, ask([[ID_A, NONE], [ID_B, NONE]]))), ["present", "unavailable"], "a full window may not hold the whole transcript");
  const empty = await claw(t, []);
  assert.deepEqual(results(await empty.bridge.verifyDelivered!(empty.session, ask([[ID_A, NONE]]))), ["unavailable"], "nothing read is no whole transcript");
  // The Turn's own flow: the transcript could not be read before dispatch, so the position is none; a later check finds it.
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1" }), answers = gatewayOf(peer);
  let down = true;
  const { control, id } = await opened(t, "openclaw", peer, undefined, async (method, params) => { if (method === "sessions.get" && down) { down = false; throw new Error("gateway busy"); } return answers(method, params); });
  assert.deepEqual(await control.deliveryPosition!(id), NONE);
  await run(control, id, relayTurn(ID_A, WORDS));
  assert.deepEqual(results(await control.verifyDelivered!(id, ask([[ID_A, NONE], [ID_B, NONE]]))), ["present", "absent"]);
});
