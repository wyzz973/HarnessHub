import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlLaunch } from "../../src/contracts/control.js";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
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
const fileIn = async (peer: Peer, name = "notes.txt"): Promise<ControlAttachment> => {
  const path = join(peer.root, name); await writeFile(path, "notes");
  return { id: contentId("content-g069fix" + name.replace(/[^a-z]/gu, "")), name, mediaType: "text/plain", kind: "file", bytes: 5, sha256: "0".repeat(64), path };
};

// ---------------------------------------------------------------------------------------------------------------------
// F1 (approval B4b): a relay Turn read as a command is refused whole
// ---------------------------------------------------------------------------------------------------------------------

test("G069-F1 a relay Turn whose words the native side reads as a command is refused whole: failed, not_recorded, RELAY_PREPARE_FAILED (classification_changed), nothing sent and nothing said; dsh has no commands and carries it", { timeout: 90000 }, async t => {
  const cases: readonly (readonly [Harness, string, Record<string, string>])[] = [
    ["openclaw", "/new", { RELAY_OPENCLAW: "1", RELAY_COMMANDS: JSON.stringify([{ name: "new", description: "new" }]) }], ["openclaw", "/clear", { RELAY_OPENCLAW: "1" }],
    ["codex", "/compact", {}], ["codex", "/export", {}],
    // The Hub's clear is a command on the Drivers whose native side has none too: a Turn with a packet is refused whole.
    ["codex", "/clear", {}], ["dsh", "/reset", {}],
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

test("G069-F1 a possible command (no catalog yet) is refused the same", { timeout: 60000 }, async t => {
  for (const [harness, words] of [["openclaw", "/think high"]] as const) {
    const peer = await peerRoot(t, { RELAY_NO_COMMANDS: "1" }), { control, id } = await opened(t, harness, peer);
    const { result, events } = await run(control, id, relayTurn(ID_A, words, false));
    refused(result, harness);
    assert.deepEqual([events, await prompts(peer)], [[], []], harness);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// F2, F6 (review B1, I2): the Hub's clear opens no session ahead (the other Drivers: relay-driver-clear.test.ts)
// ---------------------------------------------------------------------------------------------------------------------

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
  const declared: Readonly<Record<Harness, RelayCapabilities>> = { codex: codexRelayCapabilities, dsh: dshRelayCapabilities, openclaw: openClawRelayCapabilities };
  for (const harness of Object.keys(declared) as Harness[]) {
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
    if (harness === "openclaw") {
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
