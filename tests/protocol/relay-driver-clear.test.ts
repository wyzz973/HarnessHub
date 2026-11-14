import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import type { BackendResult, ControlEvent, HarnessControl } from "../../src/contracts/control.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";
import { driver, gatewayOf, ID_A, peerRoot, prompts, relayTurn, run, type Harness, type Peer } from "../fixtures/relay-drivers.js";

// The Hub's clear (the decision log of 2026-11-11: clearing a conversation is the Hub's, on every Harness). The words that clear
// are each Driver's own reading of a clear command; where the native side has none (Codex, OpenCode, DeepSeek Harness) they are
// `/clear`, `/new` and `/reset` alone. The Driver sends nothing of it: it gives the native session up, reports the history
// cleared with no checkpoint (`replaced.checkpoint: null`), and the next Turn opens a new native session. The native side is the
// relay peer, a real child process whose trace holds every line it received; OpenClaw's Gateway is a function that records its
// calls. Nothing here runs a Harness.

const CLEARED: BackendResult = { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const methods = async (peer: Peer): Promise<readonly string[]> => (await peer.sent()).flatMap(line => typeof line.method === "string" ? [line.method] : []);
const notices = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "diagnostic" ? [event.message] : []);
async function begin(t: Parameters<typeof driver>[0], harness: Harness, peer: Peer, gateway?: Parameters<typeof driver>[3]) {
  const control = driver(t, harness, peer, gateway);
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

test("Claude Code: /clear, /reset and /new are not sent; the old session is closed and given up, none is opened ahead, and the next Turn opens a new one", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_CLOSE: "1" }), { control, first } = await begin(t, "claude", peer);
  let current = first;
  const sessions = [first];
  await run(control, current, "先说一句");
  for (const words of ["/clear", "/reset", "/new"]) {
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, words);
    assert.ok(notices(events).some(message => message.includes(words) && message.includes("Claude Code")), words + ": the Turn says the Hub ran it");
    await givenUp(control, current, words);
    const old = current; current = await control.open(peer.workspace); sessions.push(current);
    assert.notEqual(current, old, words + ": a new session");
    assert.equal((await run(control, current, "继续")).result.status, "completed", words + ": the new session takes the next prompt");
  }
  const sent = await peer.sent();
  assert.deepEqual(await prompts(peer), [["先说一句"], ["继续"], ["继续"], ["继续"]], "no prompt was sent for a clear");
  assert.deepEqual(sent.filter(line => line.method === "session/close").map(line => line.params?.sessionId), sessions.slice(0, 3), "each old session closed");
  assert.equal(sent.filter(line => line.method === "session/new").length, 4, "one session per open, none for a clear");
});

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
  assert.deepEqual([...new Set(sent.flatMap(line => typeof line.method === "string" ? [line.method] : []))].sort(), ["config/read", "initialize", "initialized", "thread/start", "thread/unsubscribe", "turn/start"], "nothing else reached Codex: no archive, no delete, no clear");
  assert.deepEqual(sent.filter(line => line.method === "thread/start").map(line => (line.params as { sessionStartSource?: string }).sessionStartSource), [undefined, "clear", "clear", "clear"], "a thread after a clear says so to the user's hooks");
  assert.deepEqual(sent.filter(line => line.method === "thread/unsubscribe").map(line => (line.params as { threadId: string }).threadId), threads.slice(0, 3), "each given-up thread is unloaded");
  assert.equal((await peer.native()).threads["thread-relay"]!.turns.length, 1, "the given-up thread stays as it was in the user's Codex");
  assert.equal(control.healthy!(), true);
  assert.equal((await run(control, current, "再继续")).result.status, "completed", "and the current thread goes on");
});

test("OpenCode: /clear, /new and /reset alone, trimmed as its commands are, are not sent; the old session is closed and given up, and the next Turn opens a new one", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_CLOSE: "1" }), { control, first } = await begin(t, "opencode", peer);
  let current = first;
  const sessions = [first];
  await run(control, current, "先说一句");
  for (const words of ["/clear", "  /new  ", "\t　/reset\n"]) {
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, JSON.stringify(words));
    assert.ok(notices(events).some(message => message.includes("OpenCode")), JSON.stringify(words) + ": the Turn says the Hub ran it");
    await givenUp(control, current, JSON.stringify(words));
    current = await control.open(peer.workspace); sessions.push(current);
    assert.equal((await run(control, current, "继续")).result.status, "completed");
  }
  const sent = await peer.sent();
  assert.deepEqual(await prompts(peer), [["先说一句"], ["继续"], ["继续"], ["继续"]], "no prompt was sent for a clear");
  assert.deepEqual(sent.filter(line => line.method === "session/close").map(line => line.params?.sessionId), sessions.slice(0, 3));
  assert.equal(new Set(sessions).size, 4, "four sessions");
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

test("Hermes: /clear, /new and /reset (as the viewer reads them: Python's lstrip, any case) are not sent to the viewer, and nothing at all goes to the gateway, not even a close; the session stays in the gateway as it was and the next Turn opens a new one", { timeout: 60000 }, async t => {
  // The peer declares session/close, as an agent may: a Driver whose session lives in a gateway still does not send it.
  const peer = await peerRoot(t, { RELAY_HERMES: "1", RELAY_CLOSE: "1" }), { control, first } = await begin(t, "hermes", peer);
  let current = first;
  const sessions = [first];
  await run(control, current, "先说一句");
  const kept = (await peer.native()).sessions[first]!.entries.length;
  for (const words of ["/clear", "　/reset", "/NEW "]) {
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, JSON.stringify(words));
    assert.ok(notices(events).some(message => message.includes("Hermes")), JSON.stringify(words) + ": the Turn says the Hub ran it");
    await givenUp(control, current, JSON.stringify(words));
    current = await control.open(peer.workspace); sessions.push(current);
    assert.equal((await run(control, current, "继续")).result.status, "completed");
  }
  const sent = await methods(peer);
  assert.deepEqual(await prompts(peer), [["先说一句"], ["继续"], ["继续"], ["继续"]], "no prompt was sent for a clear");
  assert.equal(sent.filter(method => method === "session/close").length, 0, "the gateway was not asked to close anything");
  assert.equal(sent.filter(method => method === "session/new").length, 4);
  assert.equal(new Set(sessions).size, 4);
  assert.equal((await peer.native()).sessions[first]!.entries.length, kept, "the session the Hub let go of keeps its history");
});

test("OpenClaw: /new, /reset and /clear are not sent to the bridge and nothing is asked of the Gateway — no clear, no describe, no read, no model patch; the key and the model choice are let go, and the next Turn opens a new session under a new key", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1", RELAY_CLOSE: "1" }), calls: string[] = [];
  const answers = gatewayOf(peer, { "models.list": async () => ({ models: [{ provider: "vision", id: "large", name: "Vision" }] }), "sessions.patch": async () => ({ resolved: { modelProvider: "vision", model: "large" } }) });
  const control = driver(t, "openclaw", peer, async (method, params) => { calls.push(method); return answers(method, params); });
  await control.initialize();
  let current = await control.open(peer.workspace, "vision/large");
  const sessions = [current];
  await run(control, current, "先说一句");
  assert.equal(calls.filter(method => method === "sessions.patch").length, 1, "the chosen model was applied to the first session");
  for (const words of ["/new", "/reset", "/clear"]) {
    calls.length = 0;
    const { result, events } = await run(control, current, words);
    assert.deepEqual(result, CLEARED, words);
    assert.deepEqual(calls, [], words + ": the Gateway was not called at all");
    assert.ok(notices(events).some(message => message.includes("OpenClaw")), words + ": the Turn says the Hub ran it");
    await givenUp(control, current, words);
    current = await control.open(peer.workspace, "vision/large"); sessions.push(current);
    calls.length = 0;
    assert.equal((await run(control, current, "继续")).result.status, "completed");
    assert.equal(calls.filter(method => method === "sessions.patch").length, 1, words + ": the choice is applied to the new session again");
  }
  const sent = await peer.sent();
  assert.deepEqual(await prompts(peer), [["先说一句"], ["继续"], ["继续"], ["继续"]], "no prompt was sent for a clear");
  assert.equal(sent.filter(line => line.method === "session/close").length, 0, "the bridge was not asked to close anything");
  const keys = sent.filter(line => line.method === "session/new").map(line => (line.params as { _meta: { sessionKey: string } })._meta.sessionKey);
  assert.equal(keys.length, 4); assert.equal(new Set(keys).size, 4, "a new Gateway key for each session");
  for (const key of keys) assert.match(key, /^agent:main:harnesshub:[a-f0-9-]+$/u);
  assert.equal(new Set(sessions).size, 4);
});

test("OpenClaw: a clear on a restored session lets go of its key too: the next open starts a new session, not the restored one", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t, { RELAY_OPENCLAW: "1" });
  const one = await begin(t, "openclaw", peer);
  await run(one.control, one.first, "先说一句");
  const checkpoint = (await one.control.checkpoint!())!; await one.control.close();
  const two = driver(t, "openclaw", peer); await two.initialize();
  const restored = await two.open(peer.workspace, undefined, undefined, checkpoint);
  assert.deepEqual((await run(two, restored, "/new")).result, CLEARED);
  const fresh = await two.open(peer.workspace);
  const sent = (await peer.sent()).filter(line => line.method === "session/new" || line.method === "session/load");
  const keyOf = (line: (typeof sent)[number]) => (line.params as { _meta?: { sessionKey?: string; requireExistingSession?: boolean } })._meta;
  assert.deepEqual(sent.map(line => line.method), ["session/new", "session/load", "session/new"]);
  assert.equal(keyOf(sent[1]!)?.requireExistingSession, true, "the restore asked for the existing session");
  assert.notEqual(keyOf(sent[2]!)?.sessionKey, keyOf(sent[1]!)?.sessionKey, "the new session has a key of its own");
  assert.equal(keyOf(sent[2]!)?.requireExistingSession, undefined);
  assert.notEqual(fresh, restored);
});

test("on Codex, OpenCode and DeepSeek Harness, which have no clear of their own, the Hub's clear is exactly its words: arguments, a leading space (Codex, dsh) or an attachment make the input words, sent as typed", { timeout: 120000 }, async t => {
  const wordsFor = async (harness: "codex" | "opencode" | "dsh", typed: string, attachments: readonly ControlAttachment[] = [], settings: Record<string, string> = {}) => {
    const peer = await peerRoot(t, settings), { control, first } = await begin(t, harness, peer);
    const { result } = await run(control, first, typed, attachments);
    const sentText = harness === "codex" ? (await peer.sent()).filter(line => line.method === "turn/start").map(line => (line.params as { input: { text: string }[] }).input[0]!.text) : (await prompts(peer)).map(blocks => blocks[0]!);
    return { result, sentText, kept: await control.checkpoint!() === first };
  };
  for (const [harness, typed] of [["codex", "/clear now"], ["codex", " /clear"], ["codex", "　/new"], ["codex", "/cleared"], ["codex", "clear"], ["codex", "/reset\nand then continue"],
    ["opencode", "/clear now"], ["opencode", "/reset the plan"], ["opencode", "/ clear"], ["dsh", "/clear now"], ["dsh", " /clear"], ["dsh", "　/new"], ["dsh", "/newer"]] as const) {
    const sent = await wordsFor(harness, typed, [], harness === "dsh" ? { RELAY_JOIN: "" } : {});
    assert.deepEqual([sent.result.status, sent.result.native, sent.kept], ["completed", undefined, true], harness + " " + JSON.stringify(typed) + ": words, nothing cleared");
    assert.deepEqual(sent.sentText, [typed], harness + " " + JSON.stringify(typed) + ": sent as typed");
  }
  // With an attachment the same words are the user's message: the clear would drop the attachment, so it is not one.
  for (const harness of ["codex", "opencode", "dsh"] as const) {
    const peer = await peerRoot(t, harness === "dsh" ? { RELAY_JOIN: "" } : {}), attachment = await file(peer), { control, first } = await begin(t, harness, peer);
    const { result } = await run(control, first, "/clear", [attachment]);
    assert.deepEqual([result.status, result.native, await control.checkpoint!() === first], ["completed", undefined, true], harness + ": not a clear with an attachment");
  }
});

// The independent review of 2026-11-11 (persistent format and lost content): on OpenClaw `/clear cache 目录怎么清` and `/new 帮我写个函数` were
// read as the clear, so what the user typed went to no one and the native session was given up; the same for `/new` with an image, a
// file or audio. The Hub's clear is one of its words alone, without an attachment, on every Driver.
test("OpenClaw: /new, /reset and /clear are the Hub's clear only alone and without an attachment; with an argument or an attachment the words are sent as typed — /new and /reset are OpenClaw's own commands, /clear is text — and nothing is given up", { timeout: 180000 }, async t => {
  const cases: readonly (readonly [string, readonly ControlAttachment["kind"][]])[] = [
    ["/clear cache 目录怎么清", []], ["/clear\n目录怎么清", []], ["/new 帮我写个函数", []], ["/new gpt-5", []], ["/reset 重新来", []], ["/reset soft", []],
    ["/new", ["image"]], ["/new", ["file"]], ["/new", ["audio"]], ["/reset", ["image"]], ["/reset", ["file"]], ["/reset", ["audio"]], ["/clear", ["image"]], ["/clear", ["file"]], ["/clear", ["audio"]],
  ];
  for (const [typed, kinds] of cases) {
    const label = JSON.stringify(typed) + (kinds.length ? " + " + kinds.join(",") : ""), peer = await peerRoot(t, { RELAY_OPENCLAW: "1" }), attachments = await Promise.all(kinds.map(kind => attachment(peer, kind)));
    const calls: string[] = [], answers = gatewayOf(peer), control = driver(t, "openclaw", peer, async (method, params) => { calls.push(method); return answers(method, params); });
    await control.initialize();
    const first = await control.open(peer.workspace), reference = await control.checkpoint!(), opened = (await peer.sent()).filter(line => line.method === "session/new").length;
    const { result, events } = await run(control, first, typed, attachments);
    assert.deepEqual([result.status, result.native], ["completed", undefined], label + ": a Turn like any other, nothing cleared");
    assert.equal(await control.checkpoint!(), reference, label + ": the native session is still this connection's");
    assert.deepEqual((await prompts(peer)).map(blocks => blocks[0]), [typed], label + ": the words went to the bridge as typed");
    if (kinds.length) assert.equal((await peer.sent()).filter(line => line.method === "session/prompt").flatMap(line => (line.params?.prompt as { type: string }[]).map(block => block.type)).length, 1 + kinds.length, label + ": and the attachments with them");
    assert.equal(notices(events).some(message => message.includes("代为执行")), false, label + ": the Turn does not say the Hub ran a clear");
    assert.equal((await peer.sent()).filter(line => line.method === "session/new").length, opened, label + ": no new session was opened");
    assert.equal(calls.some(method => method === "sessions.patch"), false, label);
  }
  // The invalid samples: the same words alone, without an attachment, are the Hub's clear and go to no one.
  for (const typed of ["/clear", "/new", "/reset", "/new \n"]) {
    const peer = await peerRoot(t, { RELAY_OPENCLAW: "1" }), { control, first } = await begin(t, "openclaw", peer);
    const { result } = await run(control, first, typed);
    assert.deepEqual(result, CLEARED, JSON.stringify(typed));
    assert.deepEqual(await prompts(peer), [], JSON.stringify(typed) + ": nothing was sent");
  }
});

test("Hermes: a clear word with a file or an audio attachment is not the Hub's clear — the viewer is sent the words as typed, with the attachment, and nothing is given up; with an image it is text as before, and alone it is the clear", { timeout: 120000 }, async t => {
  const attached: readonly (readonly ControlAttachment["kind"][])[] = [["file"], ["audio"], ["file", "audio"], ["image"], ["file", "image"]];
  for (const kinds of attached) for (const typed of ["/clear", "　/reset", "/NEW "]) {
    const label = JSON.stringify(typed) + " + " + kinds.join(","), peer = await peerRoot(t, { RELAY_HERMES: "1" }), { control, first } = await begin(t, "hermes", peer);
    const attachments = await Promise.all(kinds.map(kind => attachment(peer, kind)));
    const { result } = await run(control, first, typed, attachments);
    assert.deepEqual([result.status, result.native], ["completed", undefined], label + ": a Turn like any other, nothing cleared");
    assert.equal(await control.checkpoint!(), first, label + ": the session is still this connection's");
    const [sent] = await prompts(peer);
    assert.equal(sent?.[0]?.startsWith(typed), true, label + ": the words went to the viewer as typed: " + JSON.stringify(sent));
    if (kinds.includes("file")) assert.match(sent![0]!, /\[Attached file\] notes\.txt/u, label + ": the file went with them, as the pointer Hermes reads");
    assert.equal((await peer.sent()).filter(line => line.method === "session/prompt").flatMap(line => (line.params?.prompt as { type: string }[]).map(block => block.type)).filter(type => type === "audio" || type === "image").length,
      kinds.filter(kind => kind !== "file").length, label + ": and the audio and the image as blocks");
  }
  // The invalid sample: alone, the same words are the Hub's clear.
  const peer = await peerRoot(t, { RELAY_HERMES: "1" }), { control, first } = await begin(t, "hermes", peer);
  assert.deepEqual((await run(control, first, "/clear")).result, CLEARED);
  assert.deepEqual(await prompts(peer), [], "nothing was sent");
});

test("a relay Turn whose words are the Hub's clear is refused whole on every Driver: failed, not recorded, nothing sent, nothing given up", { timeout: 120000 }, async t => {
  for (const harness of ["claude", "codex", "opencode", "dsh", "hermes", "openclaw"] as const) {
    const peer = await peerRoot(t, { RELAY_CLOSE: "1", ...(harness === "dsh" ? { RELAY_JOIN: "" } : {}), ...(harness === "openclaw" ? { RELAY_OPENCLAW: "1" } : {}) });
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
