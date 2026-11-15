import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import type { BackendResult, ControlEvent, HarnessControl } from "../../src/contracts/control.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, ID_A, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// The Hub's clear (the decision log of 2026-11-11: clearing a conversation is the Hub's, on every Harness). The words that clear
// are each Driver's own reading of a clear command; where the native side has none (Codex, OpenCode, DeepSeek Harness) they are
// `/clear`, `/new` and `/reset` alone. The Driver sends nothing of it: it gives the native session up, reports the history
// cleared with no checkpoint (`replaced.checkpoint: null`), and the next Turn opens a new native session. The native side is the
// relay peer, a real child process whose trace holds every line it received (OpenClaw's clear is in openclaw-gateway.test.ts).
// Nothing here runs a Harness.

const CLEARED: BackendResult = { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const methods = async (peer: Peer): Promise<readonly string[]> => (await peer.sent()).flatMap(line => typeof line.method === "string" ? [line.method] : []);
const notices = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "diagnostic" ? [event.message] : []);
async function begin(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer) {
  const control = driver(t, harness, peer);
  await control.initialize();
  return { control, first: await control.open(peer.workspace) };
}
/** After a clear the old identity is no longer the connection's: nothing more goes to it, and no session is left to resume. */
async function givenUp(control: HarnessControl, old: Parameters<HarnessControl["startText"]>[0], label: string): Promise<void> {
  assert.equal(await control.checkpoint!(), null, label + ": no session to resume, the next Turn opens one");
  await assert.rejects(control.startText(old, "旧会话", () => {}), (error: unknown) => error instanceof ControlError && error.code === "IDENTITY_MISMATCH", label + ": the old session is not this connection's");
}
const file = async (peer: Peer, name = "notes.txt"): Promise<ControlAttachment> => {
  const path = join(peer.root, name); await writeFile(path, "notes");
  return { id: contentId("content-clear" + name.replace(/[^a-z]/gu, "")), name, mediaType: "text/plain", kind: "file", bytes: 5, sha256: "0".repeat(64), path };
};
/** An attachment of any kind: five bytes in the peer's root, as the content store would hand a Driver its private copy. */
const attachment = async (peer: Peer, kind: ControlAttachment["kind"]): Promise<ControlAttachment> => {
  const name = kind === "file" ? "notes.txt" : kind === "image" ? "photo.png" : "voice.wav", path = join(peer.root, name); await writeFile(path, "notes");
  return { id: contentId("content-clear" + kind), name, mediaType: kind === "file" ? "text/plain" : kind === "image" ? "image/png" : "audio/wav", kind, bytes: 5, sha256: "0".repeat(64), path };
};

test("Codex: /clear, /new and /reset alone are not sent; the thread is given up (not archived, not deleted), what it still says is dropped, and the next Turn starts a new thread", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_LATE_MS: "100" }), { control, first } = await begin(t, "codex", peer);
  assert.equal(String(first), "thread-relay");
  let current = first;
  const threads = [first];
  await run(control, current, "先说一句");
  for (const words of ["/clear", "/new", "/reset"]) {
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, words);
    assert.ok(notices(events).some(message => message.includes(words) && message.includes("Codex")), words + ": the Turn says the Hub ran it");
    await givenUp(control, current, words);
    // The first thread says more while the connection owns no thread at all (100 ms after its turn): its message and its approval
    // request are dropped, the request refused, and the connection is as healthy as before.
    if (threads.length === 1) { await sleep(300); assert.equal(control.healthy!(), true, "what the given-up thread still said did not fail the connection"); }
    const old = current; current = await control.open(peer.workspace); threads.push(current);
    assert.notEqual(current, old, words + ": a new thread");
    assert.equal((await run(control, current, "继续")).result.status, "completed", words + ": the new thread takes the next turn");
  }
  assert.deepEqual(threads, ["thread-relay", "thread-relay-2", "thread-relay-3", "thread-relay-4"]);
  const sent = await peer.sent(), starts = sent.filter(line => line.method === "turn/start");
  assert.deepEqual(starts.map(line => ((line.params as { input: { text: string }[] }).input[0]!.text)), ["先说一句", "继续", "继续", "继续"], "no turn was started for a clear");
  assert.deepEqual(starts.map(line => (line.params as { threadId: string }).threadId), threads, "each turn on its own thread");
  // The configuration is read (never written) for each thread; a given-up thread is unsubscribed once its successor is open.
  assert.deepEqual([...new Set(sent.flatMap(line => typeof line.method === "string" ? [line.method] : []))].sort(), ["account/rateLimits/read", "config/read", "initialize", "initialized", "thread/start", "thread/unsubscribe", "turn/start"], "nothing else reached Codex: no archive, no delete, no clear");
  assert.deepEqual(sent.filter(line => line.method === "thread/start").map(line => (line.params as { sessionStartSource?: string }).sessionStartSource), [undefined, "clear", "clear", "clear"], "a thread after a clear says so to the user's hooks");
  assert.deepEqual(sent.filter(line => line.method === "thread/unsubscribe").map(line => (line.params as { threadId: string }).threadId), threads.slice(0, 3), "each given-up thread is unloaded");
  assert.equal((await peer.native()).threads["thread-relay"]!.turns.length, 1, "the given-up thread stays as it was in the user's Codex");
  assert.equal(control.healthy!(), true);
  assert.equal((await run(control, current, "再继续")).result.status, "completed", "and the current thread goes on");
});

test("DeepSeek Harness: /clear, /new and /reset alone are not sent; the old session is closed and given up, and the next Turn opens a new one", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_CLOSE: "1", RELAY_JOIN: "" }), { control, first } = await begin(t, "dsh", peer);
  let current = first;
  const sessions = [first];
  await run(control, current, "先说一句");
  for (const words of ["/clear", "/new", "/reset "]) {
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, JSON.stringify(words));
    assert.ok(notices(events).some(message => message.includes("DeepSeek Harness")), JSON.stringify(words) + ": the Turn says the Hub ran it");
    await givenUp(control, current, JSON.stringify(words));
    current = await control.open(peer.workspace); sessions.push(current);
    assert.equal((await run(control, current, "继续")).result.status, "completed");
  }
  const sent = await peer.sent();
  assert.deepEqual(await prompts(peer), [["先说一句"], ["继续"], ["继续"], ["继续"]], "no prompt was sent for a clear");
  assert.deepEqual(sent.filter(line => line.method === "session/close").map(line => line.params?.sessionId), sessions.slice(0, 3));
});

test("on Codex and DeepSeek Harness, which have no clear of their own, the Hub's clear is exactly its words: arguments, a leading space (Codex, dsh) or an attachment make the input words, sent as typed", { timeout: 120000 }, async t => {
  const wordsFor = async (harness: "codex" | "dsh", typed: string, attachments: readonly ControlAttachment[] = [], settings: Record<string, string> = {}) => {
    const peer = await peerRoot(t, settings), { control, first } = await begin(t, harness, peer);
    const { result } = await run(control, first, typed, attachments);
    const sentText = harness === "codex" ? (await peer.sent()).filter(line => line.method === "turn/start").map(line => (line.params as { input: { text: string }[] }).input[0]!.text) : (await prompts(peer)).map(blocks => blocks[0]!);
    return { result, sentText, kept: await control.checkpoint!() === first };
  };
  for (const [harness, typed] of [["codex", "/clear now"], ["codex", " /clear"], ["codex", "　/new"], ["codex", "/cleared"], ["codex", "clear"], ["codex", "/reset\nand then continue"],
    ["dsh", "/clear now"], ["dsh", " /clear"], ["dsh", "　/new"], ["dsh", "/newer"]] as const) {
    const sent = await wordsFor(harness, typed, [], harness === "dsh" ? { RELAY_JOIN: "" } : {});
    assert.deepEqual([sent.result.status, sent.result.native, sent.kept], ["completed", undefined, true], harness + " " + JSON.stringify(typed) + ": words, nothing cleared");
    assert.deepEqual(sent.sentText, [typed], harness + " " + JSON.stringify(typed) + ": sent as typed");
  }
  // With an attachment the same words are the user's message: the clear would drop the attachment, so it is not one.
  for (const harness of ["codex", "dsh"] as const) {
    const peer = await peerRoot(t, harness === "dsh" ? { RELAY_JOIN: "" } : {}), attachment = await file(peer), { control, first } = await begin(t, harness, peer);
    const { result } = await run(control, first, "/clear", [attachment]);
    assert.deepEqual([result.status, result.native, await control.checkpoint!() === first], ["completed", undefined, true], harness + ": not a clear with an attachment");
  }
});

test("a relay Turn whose words are the Hub's clear is refused whole on every Driver: failed, not recorded, nothing sent, nothing given up", { timeout: 120000 }, async t => {
  for (const harness of ["codex", "dsh"] as const) {
    const peer = await peerRoot(t, { RELAY_CLOSE: "1", ...(harness === "dsh" ? { RELAY_JOIN: "" } : {}) });
    const { control, first } = await begin(t, harness, peer), calls = (await peer.sent()).length;
    for (const words of ["/clear", "/new", "/reset"]) {
      const { result, events } = await run(control, first, relayTurn(ID_A, words, false));
      assert.deepEqual({ ...result, error: result.error === undefined ? undefined : { code: result.error.code } },
        { status: "failed", reason: "classification_changed", input: "not_recorded", error: { code: "RELAY_PREPARE_FAILED" } }, harness + " " + words);
      assert.deepEqual(events, [], harness + " " + words + ": nothing said");
    }
    assert.equal(await control.checkpoint!() !== null, true, harness + ": the session is still this connection's");
    assert.deepEqual((await peer.sent()).slice(calls).map(line => line.method), [], harness + ": nothing reached the native side");
  }
});
