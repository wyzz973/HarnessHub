import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlEvent, ControlLaunch } from "../../src/contracts/control.js";
import { contentId, type ContentKind, type ControlAttachment } from "../../src/contracts/content.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, gatewayOf, ID_A, options, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, the corrections after the second independent review of d20bfc1 (its "fix now" list): one test per item,
// against the native behaviour the relay peer (tests/fixtures/relay-control-peer.mjs, a real child process) or the OpenClaw
// Gateway stand-in plays. What stays of them after the decision log of 2026-11-11 took the reading of the native history out of
// the Drivers: Claude Code's reading with audio, a relay Turn refused before any side effect, a gave-up session handed out
// again, the generic driver's own refusal. Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string, gateway = gatewayOf(peer)) {
  const control = driver(t, harness, peer, gateway);
  await control.initialize();
  return { control, id: await control.open(peer.workspace, undefined, undefined, checkpoint) };
}
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

// ---------------------------------------------------------------------------------------------------------------------
// Minor 2: Claude Code's reading with audio
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 Claude Code reads an input with audio alone as it reads one without attachments: claude-agent-acp drops audio blocks, so `/clear` with audio is the clear; an image or a file makes any input content", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "claude", peer);
  const catalog = await control.models!();
  const voice = await attachment(peer, "voice.wav", "audio");
  assert.deepEqual(control.classify!("/clear", catalog, ["audio"]), { kind: "command", name: "clear", args: "", effect: "clear" });
  assert.deepEqual(claudeRelayCapabilities.commands.classify("/compact now", null, ["audio", "audio"]), { kind: "possible_command", name: "compact" });
  // Behind a space it is words with or without audio: the CLI strips nothing (G074-F1).
  assert.deepEqual(claudeRelayCapabilities.commands.classify("  /compact now", null, ["audio", "audio"]), { kind: "content" });
  for (const kinds of [["audio", "image"], ["file", "audio"], ["image"], ["file"]] as const) assert.deepEqual(control.classify!("/clear", catalog, kinds), { kind: "content" }, kinds.join("+"));
  refused(await run(control, id, relayTurn(ID_A, "/clear", false), [voice]), "a relay Turn whose words are the clear, with audio");
  assert.deepEqual(await prompts(peer), [], "nothing sent for it");
  const cleared = await run(control, id, "/clear", [voice]);
  assert.deepEqual(cleared.result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } }, "the driver runs the clear Claude Code would run");
  assert.deepEqual(await prompts(peer), [], "nothing reached Claude");
  // An image beside the audio: the CLI's last block is the image's, so the input is content and goes as it is.
  const other = await peerRoot(t), next = await opened(t, "claude", other), picture = await attachment(other, "shot.png", "image"), sound = await attachment(other, "voice.wav", "audio");
  const sent = await run(next.control, next.id, "/clear", [sound, picture]);
  assert.deepEqual([sent.result.status, sent.result.input, sent.result.native], ["completed", "recorded", undefined]);
  assert.deepEqual(await prompts(other), [["/clear"]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Minor 4: a refused relay Turn has no side effect before its refusal (review mutations M27, M29, M1b)
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 Hermes refuses a relay Turn read as a command before anything of it runs: no export (the Hub's /export is offered, models() read), no clear, no prompt", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), { control, id } = await opened(t, "hermes", peer);
  const catalog = await control.models!();
  assert.ok(catalog.commands?.some(command => command.name === "export"), "the Hub offers its own /export");
  for (const words of ["/export", "/clear", "/model openai:gpt-5.5", "/compress"]) {
    refused(await run(control, id, relayTurn(ID_A, words, false)), "hermes " + words);
    assert.equal(await control.checkpoint!(), id, words + ": nothing was sent or given up, the session is the same one");
  }
  assert.deepEqual(await prompts(peer), [], "no prompt");
  // The invalid sample: the same /export without a packet is the Hub's export (which fails here: the fixture's command line has no `acp`).
  const exported = await run(control, id, "/export");
  assert.deepEqual([exported.result.reason, exported.result.error?.code], ["export_failed", "NATIVE_EXPORT_UNAVAILABLE"]);
});

test("G069-R2 OpenClaw refuses a relay Turn read as a command before anything of it runs: no model patch (a model was selected, so one is due) and no transcript read", { timeout: 60000 }, async t => {
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
  const declaration: RelayCapabilities = { ...dshRelayCapabilities, commands: { classify: sharedClassify } };
  const launch: ControlLaunch = { protocol: "acp-v1", executable: process.execPath, args: [join(process.cwd(), "tests/fixtures/relay-control-peer.mjs")], env: peer.env };
  const control = new AcpControl(launch, options(peer), declaration); t.after(() => control.close().then(() => undefined));
  await control.initialize(); const id = await control.open(peer.workspace); await control.models();
  refused(await run(control, id, relayTurn(ID_A, "/compact", false)), "a listed command");
  assert.deepEqual(await prompts(peer), [], "nothing sent, not even the words");
  assert.equal((await run(control, id, relayTurn(ID_A, WORDS))).result.status, "completed");
  assert.deepEqual((await prompts(peer)).map(blocks => blocks.length), [2], "the packet and the words");
});

// ---------------------------------------------------------------------------------------------------------------------
// The Hub's clear gives a session up for good
// ---------------------------------------------------------------------------------------------------------------------

test("G069-R2 an agent that answers a new session with one this connection gave up is refused (IDENTITY_MISMATCH): Claude Code after its clear", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_SAME_SESSION: "1" }), { control, id } = await opened(t, "claude", peer);
  await run(control, id, "先说一句");
  assert.equal((await run(control, id, "/clear")).result.native?.cleared, true);
  await assert.rejects(control.open(peer.workspace), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH");
});
