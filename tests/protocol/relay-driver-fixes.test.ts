import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlLaunch } from "../../src/contracts/control.js";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { titledPacket } from "../../src/adapters/control/relay-turn.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, ID_A, options, packet, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, the corrections after the independent review of db39cbd (ADR-055, the approval agent's decisions of
// 2026-11-10 on G068 / G069 phase two): one test per finding, each first written against the native behaviour the relay peer
// (tests/fixtures/relay-control-peer.mjs, a real child process) plays. What stays of them after the decision log of 2026-11-11
// took the reading of the native history out of the Drivers: a relay Turn read as a command is refused whole, Claude Code's
// reading of an input, the Hub's clear leaving no session open ahead, attachments after the user's words, and the input bound.
// Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string, overrides: Parameters<typeof driver>[4] = {}) {
  const control = driver(t, harness, peer, undefined, overrides);
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
    ["openclaw", "/new", { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }]) }], ["openclaw", "/clear", { RELAY_OPENCLAW: "1" }],
    ["codex", "/compact", {}], ["codex", "/export", {}],
    // The Hub's clear is a command on the Drivers whose native side has none too: a Turn with a packet is refused whole.
    ["codex", "/clear", {}], ["opencode", "/new", {}], ["dsh", "/reset", {}],
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
  // dsh has no commands but the Hub's clear: any other slash input is text, and the packet goes with it.
  const dsh = await peerRoot(t, { RELAY_JOIN: "" }), plain = await opened(t, "dsh", dsh);
  assert.equal((await run(plain.control, plain.id, relayTurn(ID_A, "/review now", false))).result.status, "completed");
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
// F2, F6 (review B1, I2): the Hub's clear opens no session ahead (the other Drivers: relay-driver-clear.test.ts)
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
// F10 (approval B1): the packet's title line
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F10 a title line that names no packet does not hide the packet's own title line below it", () => {
  assert.equal(titledPacket("〔HarnessHub 交接单 不是一个标识〕\n" + packet(ID_A)), ID_A);
  assert.equal(titledPacket("〔HarnessHub 交接单 不是一个标识〕\n继续"), null);
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
// Minor item: the input bound counts Hub's file pointers
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
