import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { BackendResult, ControlEvent, ControlLaunch } from "../../src/contracts/control.js";
import { contentId, type ContentKind, type ControlAttachment } from "../../src/contracts/content.js";
import type { RelayCapabilities } from "../../src/contracts/relay.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, ID_A, options, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// G069 phase two, the corrections after the second independent review of d20bfc1 (its "fix now" list): one test per item,
// against the native behaviour the relay peer (tests/fixtures/relay-control-peer.mjs, a real child process) or the OpenClaw
// Gateway stand-in plays. What stays of them after the decision log of 2026-11-11 took the reading of the native history out of
// the Drivers: a relay Turn refused before any side effect, a gave-up session handed out
// again, the generic driver's own refusal. Nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试";
async function opened(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, checkpoint?: string) {
  const control = driver(t, harness, peer);
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
// Minor 4: a refused relay Turn has no side effect before its refusal (review mutations M27, M29, M1b)
// ---------------------------------------------------------------------------------------------------------------------

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
