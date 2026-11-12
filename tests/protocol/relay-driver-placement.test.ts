import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { type ControlEvent, type NativeUsage } from "../../src/contracts/control.js";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { exceedsInput, placedSize, titledPacket } from "../../src/adapters/control/relay-turn.js";
import { driver, gatewayOf, ID_A, packet, peerRoot, prompts, relayTurn, run, type Harness } from "../fixtures/relay-drivers.js";

// G069 phase two, placement (ADR-055 §5.5, §7.4, §8.1): each Driver sends a relay Turn as its declaration places it, and the
// packet's title line arrives unchanged in the user entry the native side records; a command's words go alone; a packet over
// the input bound is not sent. Also per-request usage (VF2-09). The native side is the relay peer, a real child process
// speaking each protocol; nothing here runs a Harness.

const WORDS = "修好 summary.ts 的测试，然后跑一遍";
const file = (path: string): ControlAttachment => ({ id: contentId("content-g069notes"), name: "notes.txt", mediaType: "text/plain", kind: "file", bytes: 5, sha256: "0".repeat(64), path });

/** The user entry each native side stored for the first prompt, as its own record holds it. */
async function stored(harness: Harness, peer: Awaited<ReturnType<typeof peerRoot>>): Promise<string> {
  const native = await peer.native();
  if (harness === "codex") { const item = native.threads["thread-relay"]!.turns[0]!.items as { type: string; content?: { text: string }[] }[]; return item.find(row => row.type === "userMessage")!.content!.map(part => part.text).join("\n"); }
  if (harness === "claude") {
    const projects = join(peer.env.CLAUDE_CONFIG_DIR!, "projects"), [project] = await readdir(projects), [name] = await readdir(join(projects, project!));
    const line = JSON.parse((await readFile(join(projects, project!, name!), "utf8")).split("\n")[0]!) as { message: { content: { text: string }[] } };
    return line.message.content.map(part => part.text).join("");
  }
  return String(Object.values(native.sessions)[0]!.entries.find(entry => entry.role === "user")!.text);
}

test("G069-C01 the six Drivers place a relay Turn by their declaration and the title line reaches the recorded user entry unchanged; a plain input goes as before", { timeout: 60000 }, async t => {
  const body = relayTurn(ID_A, WORDS).relay.body;
  // [harness, peer settings, the text parts sent, how the native side joins them]
  const cases: readonly (readonly [Harness, Record<string, string>, readonly string[]])[] = [
    ["claude", { RELAY_TRANSCRIPT: "" }, [body + "\n\n", WORDS]],
    ["opencode", {}, [body + "\n\n", WORDS]],
    // dsh concatenates its text blocks without a separator (dsh-acp 0.2.1-rc.5 admitAcpPrompt): the packet keeps its blank line.
    ["dsh", { RELAY_JOIN: "" }, [body + "\n\n", WORDS]],
    ["hermes", {}, [body + "\n\n", WORDS]],
    ["openclaw", { RELAY_OPENCLAW: "1" }, [body + "\n\n" + WORDS]],
    ["codex", {}, [body + "\n\n" + WORDS]],
  ];
  for (const [harness, settings, parts] of cases) {
    const peer = await peerRoot(t, settings);
    if (harness === "claude") (peer.env as Record<string, string>).RELAY_TRANSCRIPT = peer.env.CLAUDE_CONFIG_DIR!;
    const control = driver(t, harness, peer);
    await control.initialize(); const id = await control.open(peer.workspace);
    const { result, events } = await run(control, id, relayTurn(ID_A, WORDS));
    assert.equal(result.status, "completed", harness);
    assert.ok(!events.some(event => event.type === "diagnostic" && event.message.includes("交接单")), harness + ": the packet went");
    if (harness === "codex") {
      const start = (await peer.sent()).find(line => line.method === "turn/start")!.params as { input: { type: string; text: string }[]; clientUserMessageId?: string };
      assert.deepEqual(start.input.map(item => item.text), parts, harness);
      assert.equal(typeof start.clientUserMessageId, "string", "a Turn with a packet is sent with an identity of its own");
    } else assert.deepEqual((await prompts(peer))[0], parts, harness);
    const entry = await stored(harness, peer);
    assert.equal(titledPacket(entry), ID_A, harness + ": the native side's user entry carries the title line");
    assert.ok(entry.includes(WORDS), harness + ": and the words");
    if (harness === "dsh") assert.equal(entry, body + "\n\n" + WORDS, "dsh's concatenation keeps the blank line");
    if (harness === "openclaw") assert.match(entry, /^\[Working directory: [^\n]+\]\n\n/u);
    // A plain input is sent as it was before phase two: one text, exactly as typed.
    await run(control, id, "plain words");
    if (harness === "codex") assert.deepEqual(((await peer.sent()).filter(line => line.method === "turn/start")[1]!.params as { input: { text: string }[]; clientUserMessageId?: string }).input.map(item => item.text), ["plain words"]);
    else assert.deepEqual((await prompts(peer))[1], ["plain words"], harness);
    if (harness === "codex") assert.equal(((await peer.sent()).filter(line => line.method === "turn/start")[1]!.params as { clientUserMessageId?: string }).clientUserMessageId, undefined, "a plain Turn is sent with none");
  }
});

test("G069-C01 Hermes's file pointers follow the user's words (pointersAfterUser); a Driver without a declaration flattens as singleText", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t), attachment = join(peer.root, "notes.txt"); await writeFile(attachment, "notes");
  const hermes = driver(t, "hermes", peer); await hermes.initialize(); const id = await hermes.open(peer.workspace);
  await run(hermes, id, relayTurn(ID_A, WORDS), [file(attachment)]);
  const [parts] = await prompts(peer);
  assert.equal(parts!.length, 2);
  assert.ok(parts![0]!.startsWith(WORDS + "\n〔HarnessHub 交接单 "), "the packet first");
  assert.ok(parts![1]!.startsWith(WORDS + "\n\n[Attached file] notes.txt (text/plain, 5 bytes, read-only copy): "), "then the words, then the pointer");
  // The generic driver for a Harness that declares nothing (Gemini and the like): the contract's default placement.
  const other = await peerRoot(t), { AcpControl } = await import("../../src/adapters/control/acp.js"), { resolve } = await import("node:path");
  const generic = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/relay-control-peer.mjs")], env: other.env }, { cwd: other.workspace, env: other.env, requestTimeoutMs: 3000, runTimeoutMs: 6000, maxFrameBytes: 1 << 20, maxDiagnosticBytes: 1 << 14, closeGraceMs: 150 });
  t.after(() => generic.close().then(() => undefined));
  await generic.initialize(); const own = await generic.open(other.workspace);
  await run(generic, own, relayTurn(ID_A, "继续"));
  assert.deepEqual((await prompts(other))[0], [relayTurn(ID_A, "继续").relay.body + "\n\n继续"]);
});

test("G069-C01 a relay Turn read as a command is refused whole (G069-F1, relay-driver-fixes); what the native side reads as text carries the packet: dsh's slash input, Codex's indented `/compact`; Hermes /queue and /steer carry it in their arguments", { timeout: 60000 }, async t => {
  const relayed = async (harness: Harness, words: string, settings: Record<string, string> = {}) => {
    const peer = await peerRoot(t, settings), control = driver(t, harness, peer);
    await control.initialize(); const id = await control.open(peer.workspace);
    const { result, events } = await run(control, id, relayTurn(ID_A, words, false));
    return { peer, result, events };
  };
  // Claude Code's catalog lists /compact, as the real adapter's does: a word outside the catalog is words for it (G074-F3).
  const compactListed = { RELAY_COMMANDS: JSON.stringify([{ name: "compact", description: "compact the conversation" }]) };
  for (const [harness, words, settings] of [["claude", "/compact keep the tests", compactListed], ["hermes", "　/compress", {}], ["opencode", "/compact", {}]] as const) {
    const { peer, result, events } = await relayed(harness, words, settings);
    assert.deepEqual([result.error?.code, result.input, await prompts(peer), events], ["RELAY_PREPARE_FAILED", "not_recorded", [], []], harness + ": refused, nothing sent");
  }
  // The invalid sample: dsh has no commands but the Hub's clear, so any other slash input is text and carries the packet.
  const dsh = await relayed("dsh", "/review now");
  assert.equal((await prompts(dsh.peer))[0]!.length, 2);
  // Hermes /queue and /steer submit their arguments as a prompt (acceptsRelay): the command word, the packet, the arguments.
  for (const word of ["queue", "q", "steer"]) {
    const { peer } = await relayed("hermes", "/" + word + " 修好测试");
    const [parts] = await prompts(peer), body = relayTurn(ID_A, "x", false).relay.body;
    assert.deepEqual(parts, ["/" + word, body + "\n\n", "修好测试"], word);
    assert.equal(titledPacket(String(Object.values((await peer.native()).sessions)[0]!.entries[0]!.text).replace(/^\/\w+\n/u, "")), ID_A);
  }
  // Codex: a thread operation is refused; a leading space makes `/compact` text, which carries the packet.
  const codex = await peerRoot(t), control = driver(t, "codex", codex); await control.initialize(); const thread = await control.open(codex.workspace);
  const compact = await run(control, thread, relayTurn(ID_A, "/compact", false));
  assert.deepEqual([compact.result.error?.code, compact.events], ["RELAY_PREPARE_FAILED", []]);
  assert.equal((await codex.sent()).filter(line => line.method === "turn/start" || line.method === "thread/compact/start").length, 0, "nothing was sent");
  await run(control, thread, relayTurn(ID_A, " /compact", false));
  const [spaced] = (await codex.sent()).filter(line => line.method === "turn/start");
  assert.equal(titledPacket((spaced!.params as { input: { text: string }[] }).input[0]!.text), ID_A);
});

test("G069-C01 Codex's skill input carries the skill item, then the packet without the copy of the first line, then the rest of the words (RT5-18)", { timeout: 30000 }, async t => {
  const peer = await peerRoot(t, { RELAY_SKILL: "review" }), control = driver(t, "codex", peer);
  await control.initialize(); const id = await control.open(peer.workspace); await control.models!();
  const turn = relayTurn(ID_A, "/skill:review 先看 summary.ts");
  assert.ok(turn.relay.body.startsWith("/skill:review 先看 summary.ts\n"), "the packet begins with the copy of the first line");
  await run(control, id, turn);
  const start = (await peer.sent()).find(line => line.method === "turn/start")!.params as { input: { type: string; text?: string; name?: string }[] };
  assert.deepEqual(start.input.map(item => item.type), ["text", "skill"]);
  assert.equal(start.input[1]!.name, "review");
  assert.ok(start.input[0]!.text!.startsWith("〔HarnessHub 交接单 " + ID_A + "〕\n"), "the title line first: the first line is left out");
  assert.ok(start.input[0]!.text!.endsWith("〕\n\n先看 summary.ts"));
  // Without the copy (firstLine false) the packet is placed as it is.
  await run(control, id, relayTurn(ID_A, "/skill:review 再看", false));
  const second = (await peer.sent()).filter(line => line.method === "turn/start")[1]!.params as { input: { text?: string }[] };
  assert.equal(second.input[0]!.text, relayTurn(ID_A, "x", false).relay.body + "\n\n再看");
});

test("G069-C01 a placement over the declared input bound is never sent: Codex in code points, OpenClaw in UTF-8 bytes with the bridge's working-directory prefix", { timeout: 60000 }, async t => {
  // The size is the declaration's unit: code points, not UTF-16 units; bytes in UTF-8.
  assert.equal(placedSize(["a😀", "中"], "chars"), 3);
  assert.equal(placedSize(["a😀", "中"], "bytes"), 8);
  const limited = { parts: "single" as const, maxInput: { unit: "chars" as const, limit: 10 }, pointersAfterUser: false, measure: () => 0 };
  assert.equal(exceedsInput(["0123456789"], limited), false, "at the bound");
  assert.equal(exceedsInput(["0123456789", "x"], limited), true, "one over");
  assert.equal(exceedsInput(["012345678"], limited, 1), false);
  assert.equal(exceedsInput(["x".repeat(1 << 20)], claudeRelayCapabilities.placement), false, "no bound declared");
  const limit = codexRelayCapabilities.placement.maxInput!.limit, words = "继续";
  const fitting = (extra: number) => { const head = packet(ID_A); return { user: words, relay: { packetId: ID_A, body: head + "x".repeat(limit - [...head].length - 2 - [...words].length + extra), firstLine: false } }; };
  const peer = await peerRoot(t), control = driver(t, "codex", peer); await control.initialize(); const id = await control.open(peer.workspace);
  const over = await run(control, id, fitting(1));
  assert.deepEqual(over.result, { status: "failed", reason: "input_too_large", input: "not_recorded", error: { code: "RELAY_INPUT_LIMIT", message: over.result.error!.message } });
  assert.equal((await peer.sent()).filter(line => line.method === "turn/start").length, 0, "nothing was sent");
  assert.equal((await run(control, id, fitting(0))).result.status, "completed", "exactly at the bound it goes");
  const claw = await peerRoot(t, { RELAY_OPENCLAW: "1" }), bridge = driver(t, "openclaw", claw); await bridge.initialize(); const session = await bridge.open(claw.workspace);
  const prefix = Buffer.byteLength("[Working directory: " + claw.workspace + "]\n\n"), head = packet(ID_A), room = 2_097_152 - Buffer.byteLength(head) - 2 - Buffer.byteLength(words);
  const sized = (filler: number) => ({ user: words, relay: { packetId: ID_A, body: head + "x".repeat(filler), firstLine: false } });
  assert.equal((await run(bridge, session, sized(room - prefix + 1))).result.error?.code, "RELAY_INPUT_LIMIT", "the prefix counts");
  assert.equal((await prompts(claw)).length, 0);
  assert.equal((await run(bridge, session, sized(room - prefix))).result.status, "completed");
});

test("G069-C09 Codex reports each model request's own counts, all of them (64 were kept until 2026-11-12); a Turn without reports has none; OpenClaw's transcript rows give them unless a CLI harness wrote the turn", { timeout: 60000 }, async t => {
  const usage = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "usage" ? [event.usage] : []) as NativeUsage[];
  const many = await peerRoot(t, { RELAY_REQUESTS: "70" }), control = driver(t, "codex", many); await control.initialize(); const id = await control.open(many.workspace);
  const reported = usage((await run(control, id, "继续")).events);
  assert.equal(reported.length, 70, "one report per request");
  assert.deepEqual(reported[0]!.requests, [{ input: 100, cachedInput: 50, cacheWrite: 1 }]);
  const last = reported.at(-1)!.requests!;
  assert.equal(last.length, 70, "every request, not the latest 64");
  assert.deepEqual([last[0], last.at(-1)], [{ input: 100, cachedInput: 50, cacheWrite: 1 }, { input: 7000, cachedInput: 3500, cacheWrite: 70 }], "oldest first");
  const none = await peerRoot(t, { RELAY_REQUESTS: "0" }), quiet = driver(t, "codex", none); await quiet.initialize(); const thread = await quiet.open(none.workspace);
  assert.deepEqual(usage((await run(quiet, thread, "继续")).events), [], "not reported: no requests field anywhere");
  // OpenClaw: one assistant row per model request in the embedded runtime.
  const rows = (harness: boolean, count: number) => async () => ({ messages: [{ role: "user", content: "[Working directory: ~]\n\n继续", __openclaw: { seq: 1 } },
    ...Array.from({ length: count }, (_, index) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10 + index, output: 1, cacheRead: 5, cacheWrite: 2, totalTokens: 13 }, ...(harness ? { contextUsage: {} } : {}), __openclaw: { seq: 2 + index } }))] });
  for (const [harness, count, expected] of [[false, 2, [{ input: 10, cachedInput: 5, cacheWrite: 2 }, { input: 11, cachedInput: 5, cacheWrite: 2 }]], [true, 2, undefined], [false, 70, 70]] as const) {
    const claw = await peerRoot(t, { RELAY_OPENCLAW: "1" });
    let reads = 0;
    const bridge = driver(t, "openclaw", claw, gatewayOf(claw, { "sessions.get": async params => (reads++, params.limit === 1 ? { messages: [] } : rows(harness, count)()) }));
    await bridge.initialize(); const session = await bridge.open(claw.workspace);
    const requests = usage((await run(bridge, session, "继续")).events).at(-1)?.requests;
    if (typeof expected === "number") { assert.equal(requests?.length, expected); assert.equal(requests?.at(-1)?.input, 10 + count - 1); }
    else assert.deepEqual(requests, expected, String(harness));
    assert.ok(reads >= 2);
  }
});
