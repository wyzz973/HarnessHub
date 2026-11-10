import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_USAGE_REQUESTS, type ControlEvent, type HarnessControl, type NativeUsage } from "../../src/contracts/control.js";
import { contentId, type ControlAttachment } from "../../src/contracts/content.js";
import { parseVendorObservation } from "../../src/contracts/relay.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { exceedsInput, placedSize, titledPacket } from "../../src/adapters/control/relay-turn.js";
import { driver, gatewayOf, ID_A, packet, peerRoot, prompts, relayTurn, run, type Harness } from "../fixtures/relay-drivers.js";

// G069 phase two, placement (ADR-055 §5.5, §7.4, §8.1): each Driver sends a relay Turn as its declaration places it, and the
// packet's title line arrives unchanged in the user entry the native side records; a command's words go alone; a packet over
// the input bound is not sent. Also the user's words of a replayed entry (VF3-09) and per-request usage (VF2-09). The native
// side is the relay peer, a real child process speaking each protocol; nothing here runs a Harness.

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
    if (harness === "codex") await control.deliveryPosition!(id);
    const { result, events } = await run(control, id, relayTurn(ID_A, WORDS));
    assert.equal(result.status, "completed", harness);
    assert.ok(!events.some(event => event.type === "diagnostic" && event.message.includes("交接单")), harness + ": the packet went");
    if (harness === "codex") {
      const start = (await peer.sent()).find(line => line.method === "turn/start")!.params as { input: { type: string; text: string }[]; clientUserMessageId?: string };
      assert.deepEqual(start.input.map(item => item.text), parts, harness);
      assert.equal(typeof start.clientUserMessageId, "string", "the identity deliveryPosition recorded");
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
    if (harness === "codex") assert.equal(((await peer.sent()).filter(line => line.method === "turn/start")[1]!.params as { clientUserMessageId?: string }).clientUserMessageId, undefined, "an identity is used once");
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
  for (const [harness, words] of [["claude", "/compact keep the tests"], ["hermes", "　/compress"], ["opencode", "/compact"]] as const) {
    const { peer, result, events } = await relayed(harness, words);
    assert.deepEqual([result.error?.code, result.input, await prompts(peer), events], ["RELAY_PREPARE_FAILED", "not_recorded", [], []], harness + ": refused, nothing sent");
  }
  // The invalid sample: dsh has no commands, so its `/clear` is text and carries the packet.
  const dsh = await relayed("dsh", "/clear");
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

test("G069-C06 userTextOf strips the four kinds of wrapping a replayed user entry can have and recognizes a packet with a prefix and a suffix; plain words and a broken packet stay as they are", { timeout: 60000 }, async t => {
  const peer = await peerRoot(t), controls = Object.fromEntries((["claude", "codex", "hermes", "openclaw", "opencode", "dsh"] as const).map(harness => [harness, driver(t, harness, peer)])) as Record<Harness, HarnessControl>;
  const body = packet(ID_A, "继续"), bytes = (text: string) => Buffer.byteLength(text);
  // OpenClaw: the bridge's working-directory prefix (workspace_meta), then the packet (hub_text).
  const cwd = "[Working directory: ~/ws]\n\n";
  assert.deepEqual(controls.openclaw.userTextOf!(cwd + body + "\n\n继续"), { user: "继续", stripped: [{ kind: "workspace_meta", bytes: bytes(cwd) }, { kind: "hub_text", bytes: bytes(body + "\n\n") }] });
  // Claude Code: tags it injects into the prompt row (harness_text).
  const reminder = "<system-reminder>todo list is empty</system-reminder>\n";
  assert.deepEqual(controls.claude.userTextOf!(reminder + body + "\n\n继续"), { user: "继续", stripped: [{ kind: "harness_text", bytes: bytes(reminder) }, { kind: "hub_text", bytes: bytes(body + "\n\n") }] });
  // Hermes: the steer wrapper (harness_text), Hub's file pointers after the words (workspace_meta); its "\n" join adds a line break.
  const pointer = "\n\n[Attached file] notes.txt (text/plain, 5 bytes, read-only copy): /tmp/x/notes.txt";
  assert.deepEqual(controls.hermes.userTextOf!(body + "\n\n\n继续" + pointer), { user: "继续", stripped: [{ kind: "hub_text", bytes: bytes(body + "\n\n\n") }, { kind: "workspace_meta", bytes: bytes(pointer) }] });
  const steer = "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position]\n先停一下\n[/OUT-OF-BAND USER MESSAGE]";
  assert.deepEqual(controls.hermes.userTextOf!(steer), { user: "先停一下", stripped: [{ kind: "harness_text", bytes: bytes(steer) - bytes("先停一下") }] });
  // Codex, OpenCode, dsh: the packet and pointers only; text before the packet's head stays the user's (a prefix allowed).
  for (const harness of ["codex", "opencode", "dsh"] as const) {
    assert.deepEqual(controls[harness].userTextOf!(body + "\n\n继续" + pointer), { user: "继续", stripped: [{ kind: "hub_text", bytes: bytes(body + "\n\n") }, { kind: "workspace_meta", bytes: bytes(pointer) }] }, harness);
    assert.deepEqual(controls[harness].userTextOf!("前面的话\n\n" + body + "\n\n继续"), { user: "前面的话\n\n继续", stripped: [{ kind: "hub_text", bytes: bytes(body + "\n\n") }] }, harness);
    assert.deepEqual(controls[harness].userTextOf!("就是普通的一句话"), { user: "就是普通的一句话", stripped: [] }, harness);
  }
  // The invalid samples: a packet without its end line, and a title line that is no packet's, are not stripped.
  const broken = body.slice(0, body.indexOf("〔记录结束"));
  assert.deepEqual(controls.codex.userTextOf!(broken + "继续"), { user: broken + "继续", stripped: [] });
  assert.deepEqual(controls.codex.userTextOf!("〔HarnessHub 交接单 不是一个标识〕\n继续"), { user: "〔HarnessHub 交接单 不是一个标识〕\n继续", stripped: [] });
  // What each native side stored for a relay Turn reads back as the user's words exactly.
  for (const harness of ["hermes", "openclaw", "dsh"] as const) {
    const own = await peerRoot(t, harness === "openclaw" ? { RELAY_OPENCLAW: "1" } : harness === "dsh" ? { RELAY_JOIN: "" } : {}), control = driver(t, harness, own);
    await control.initialize(); const id = await control.open(own.workspace);
    await run(control, id, relayTurn(ID_A, WORDS));
    assert.equal(control.userTextOf!(await stored(harness, own)).user, WORDS, harness);
  }
});

test("G069-C09 Codex reports each model request's own counts, the latest 64 kept; a Turn without reports has none; OpenClaw's transcript rows give them unless a CLI harness wrote the turn", { timeout: 60000 }, async t => {
  const usage = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "usage" ? [event.usage] : []) as NativeUsage[];
  const many = await peerRoot(t, { RELAY_REQUESTS: "70" }), control = driver(t, "codex", many); await control.initialize(); const id = await control.open(many.workspace);
  const reported = usage((await run(control, id, "继续")).events);
  assert.equal(reported.length, 70, "one report per request");
  assert.deepEqual(reported[0]!.requests, [{ input: 100, cachedInput: 50, cacheWrite: 1 }]);
  const last = reported.at(-1)!.requests!;
  assert.equal(last.length, MAX_USAGE_REQUESTS);
  assert.deepEqual([last[0], last.at(-1)], [{ input: 700, cachedInput: 350, cacheWrite: 7 }, { input: 7000, cachedInput: 3500, cacheWrite: 70 }], "the latest, oldest first");
  const none = await peerRoot(t, { RELAY_REQUESTS: "0" }), quiet = driver(t, "codex", none); await quiet.initialize(); const thread = await quiet.open(none.workspace);
  assert.deepEqual(usage((await run(quiet, thread, "继续")).events), [], "not reported: no requests field anywhere");
  // OpenClaw: one assistant row per model request in the embedded runtime.
  const rows = (harness: boolean, count: number) => async () => ({ messages: [{ role: "user", content: "[Working directory: ~]\n\n继续", __openclaw: { seq: 1 } },
    ...Array.from({ length: count }, (_, index) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 10 + index, output: 1, cacheRead: 5, cacheWrite: 2, totalTokens: 13 }, ...(harness ? { contextUsage: {} } : {}), __openclaw: { seq: 2 + index } }))] });
  for (const [harness, count, expected] of [[false, 2, [{ input: 10, cachedInput: 5, cacheWrite: 2 }, { input: 11, cachedInput: 5, cacheWrite: 2 }]], [true, 2, undefined], [false, 70, MAX_USAGE_REQUESTS]] as const) {
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

test("G069 relayVendor: each Driver's observation from its own endpoint layers after open, the sign-in kind only; null before open, for Hermes, and when a layer cannot be read", { timeout: 60000 }, async t => {
  const observe = async (harness: Harness, settings: Record<string, string>, prepare: (root: string, workspace: string) => Promise<void> = async () => {}) => {
    const peer = await peerRoot(t, settings); await prepare(peer.root, peer.workspace);
    const control = driver(t, harness, peer); await control.initialize();
    assert.equal(await control.relayVendor!(), null, harness + ": nothing before open");
    await control.open(peer.workspace);
    const observed = await control.relayVendor!();
    if (observed !== null) parseVendorObservation(observed);
    return { observed, declaration: control.relayCapabilities! };
  };
  const settings = (value: string) => async (root: string) => { await mkdir(join(root, "claude"), { recursive: true }); await writeFile(join(root, "claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } })); };
  const claude = await observe("claude", { RELAY_AUTH_KIND: "api_key" }, settings("https://g069-gateway.example/anthropic?k=" + "sk-" + "ant-" + "fixture"));
  assert.deepEqual(claude.observed, { model: null, modelKey: "", authKind: "api_key", endpoint: { host: "g069-gateway.example", layer: "user_config" }, loopback: false });
  assert.equal(claude.declaration.resolveVendor(claude.observed!), "gateway:g069-gateway.example");
  assert.ok(!JSON.stringify(claude.observed).includes("label") && !JSON.stringify(claude.observed).includes("fixture"), "no label, no value but the host");
  const signedIn = await observe("claude", { RELAY_AUTH_KIND: "account" });
  assert.equal(signedIn.declaration.resolveVendor(signedIn.observed!), "anthropic");
  // A layer that cannot be read: the endpoint is not known, so there is no observation (never "none").
  const unreadable = await observe("claude", { RELAY_AUTH_KIND: "account" }, async root => { await mkdir(join(root, "claude", "settings.json"), { recursive: true }); });
  assert.equal(unreadable.observed, null);
  const codex = await observe("codex", { OPENAI_BASE_URL: "https://g069-proxy.example/v1", RELAY_PROVIDER: "openai", RELAY_MODEL: "gpt-5.5" });
  assert.deepEqual(codex.observed, { model: "openai/gpt-5.5", modelKey: "gpt-5.5", authKind: null, endpoint: { host: "g069-proxy.example", layer: "environment" }, loopback: false });
  assert.equal(codex.declaration.resolveVendor(codex.observed!), "gateway:g069-proxy.example");
  const azure = await observe("codex", { RELAY_PROVIDER: "azure", RELAY_MODEL: "gpt-5.5" });
  assert.equal(azure.declaration.resolveVendor(azure.observed!), "gateway:azure");
  const dsh = await observe("dsh", {}, async (_root, workspace) => { await writeFile(join(workspace, ".env"), "OTHER=1\nDEEPSEEK_BASE_URL=https://g069-relay.example\n"); });
  assert.deepEqual(dsh.observed?.endpoint, { host: "g069-relay.example", layer: "workspace_file" });
  assert.equal(dshRelayCapabilities.resolveVendor(dsh.observed!), "gateway:g069-relay.example");
  // OpenCode keys its endpoint by the model's provider, which this agent does not name: no endpoint, an unknown vendor.
  const opencode = await observe("opencode", {});
  assert.equal(opencode.declaration.resolveVendor(opencode.observed!), "unknown:opencode");
  // Hermes's provider endpoint key is not one §8.1 names: it cannot tell.
  assert.equal((await observe("hermes", {})).observed, null);
});
