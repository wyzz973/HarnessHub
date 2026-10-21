import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, GatewayApi } from "../../web/src/api.js";
import { toolParents } from "../../web/src/tool-tree.js";
import { liveItems, mostUrgent, remaining } from "../../web/src/attention.js";
import { hiddenHarnesses } from "../../web/src/lib/prefs.js";
import { cancelledLabel, type AttentionItem } from "../../src/contracts/session.js";

function api(t: test.TestContext, fetcher: typeof fetch): GatewayApi {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"), original = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://127.0.0.1/"), history: { replaceState: () => {} } } });
  globalThis.fetch = fetcher;
  t.after(() => { globalThis.fetch = original; if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  return new GatewayApi();
}
const code = (expected: string) => (error: unknown): boolean => error instanceof ApiError && error.code === expected;

test("an ACK body transport failure is classified without accepting partial JSON", async t => {
  let sent = false;
  const client = api(t, async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('{"sessionId":"session-api",')); }
    else controller.error(new TypeError("terminated"));
  } }), { status: 202 }));
  await assert.rejects(client.send("session-api", "once", "same-command"), code("NETWORK_ERROR"));
});

test("a hung write is aborted at its owned deadline, so the Composer cannot stay locked forever", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null = null;
  const client = api(t, (_input, init) => new Promise<Response>((_resolve, reject) => {
    signal = init?.signal ?? null; assert.ok(signal);
    signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
  }));
  const pending = client.send("session-api", "once", "same-command");
  t.mock.timers.tick(15000);
  await assert.rejects(pending, code("REQUEST_TIMEOUT"));
  assert.ok(signal); assert.equal((signal as AbortSignal).aborted, true);
});

test("server business rejection remains a business rejection rather than a transport error", async t => {
  const client = api(t, async () => new Response(JSON.stringify({ code: "COMMAND_CONFLICT", message: "different input" }), { status: 409 }));
  await assert.rejects(client.send("session-api", "different", "same-command"), code("COMMAND_CONFLICT"));
});

test("wrong-session and incomplete command receipts are not accepted as successful writes", async t => {
  let value: unknown;
  const client = api(t, async () => new Response(JSON.stringify(value), { status: 202 }));
  for (const candidate of [{ sessionId: "session-other", runId: "run-one", replayed: false }, {}, { sessionId: "session-api", runId: "run-one" }, { sessionId: "session-api", replayed: false }]) {
    value = candidate;
    await assert.rejects(client.send("session-api", "once", "same-command"), code("INVALID_RESPONSE"));
  }
});

test("a successful SSE response without the required initial facts is a failed connection", async t => {
  const client = api(t, async () => new Response(": heartbeat\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  await assert.rejects(client.streamSession("session-api", 0, new AbortController().signal, () => assert.fail("no facts exist")), code("STREAM_PROTOCOL"));
});

test("sub-agent tools are shown under their listed parent call; loops stay flat and deep chains are capped at three levels", () => {
  const tool = (id: string, parentId?: string) => ({ id, ...(parentId === undefined ? {} : { parentId }) });
  assert.deepEqual([...toolParents([tool("agent"), tool("bash", "agent"), tool("self", "self"), tool("orphan", "missing")])], [["bash", "agent"]]);
  assert.deepEqual([...toolParents([tool("a", "b"), tool("b", "a"), tool("c", "a")])], [], "a parent loop is shown flat");
  assert.deepEqual([...toolParents([tool("r"), tool("d1", "r"), tool("d2", "d1"), tool("d3", "d2"), tool("d4", "d3"), tool("d5", "d4")])],
    [["d1", "r"], ["d2", "d1"], ["d3", "d2"], ["d4", "d2"], ["d5", "d2"]]);
});

test("a waiting request says whose deadline it is: the program's in seconds, the wait budget's in minutes until its last one", () => {
  const now = 1_000_000;
  assert.deepEqual(remaining({ expiresAt: now + 45_200, expiresBy: "native" }, now), { text: "46 秒后自动拒绝", source: "原程序期限", hint: "原程序的等待期限，到时它会按自己的规则拒绝。" });
  assert.equal(remaining({ expiresAt: now + 125_000, expiresBy: "native" }, now).text, "3 分后自动拒绝");
  assert.equal(remaining({ expiresAt: now + 240_000, expiresBy: "turn" }, now).text, "剩余 4 分");
  assert.equal(remaining({ expiresAt: now + 59_100, expiresBy: "turn" }, now).text, "剩余 60 秒");
  assert.deepEqual(remaining({ expiresAt: now + 59_000, expiresBy: "turn" }, now), { text: "剩余 59 秒", source: "等待期限", hint: "HarnessHub 为等待你的决定设的期限，到时本回合取消，原程序不会收到决定。" });
  assert.equal(remaining({ expiresAt: now - 5, expiresBy: "turn" }, now).text, "剩余 0 秒");
  assert.deepEqual(remaining({}, now), { text: "等待你的决定", source: null, hint: "原程序会一直等待你的决定。" });
  const item = (permissionId: string, extra: Partial<AttentionItem>): AttentionItem => ({ sessionId: "session-a" as AttentionItem["sessionId"], permissionId, runId: "run-a", harnessId: "hermes", kind: "approval", requestedAt: 1, ...extra });
  const items = [item("open", {}), item("late", { expiresAt: now + 90_000, expiresBy: "turn" }), item("soon", { expiresAt: now + 5_000, expiresBy: "native" }), item("gone", { expiresAt: now, expiresBy: "native" })];
  assert.deepEqual(liveItems(items, now).map(value => value.permissionId), ["open", "late", "soon"], "an expired request is gone at its deadline");
  assert.equal(mostUrgent(liveItems(items, now))?.permissionId, "soon"); assert.equal(mostUrgent([items[0]!])?.permissionId, "open"); assert.equal(mostUrgent([]), null);
});

test("the attention stream hands over whole frames and rejects one whose identity disagrees with its revision", async t => {
  const frame = (revision: number, items: unknown[]) => "id: " + revision + "\nevent: attention\ndata: " + JSON.stringify({ revision, items }) + "\n\n";
  const waiting = { sessionId: "session-a", permissionId: "permission-1", runId: "run-1", harnessId: "hermes", kind: "approval", requestedAt: 5, expiresAt: 60_005, expiresBy: "native" };
  const body = (text: string) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    // Split mid-frame, with a heartbeat between frames and CRLF line ends, as a real connection may deliver it.
    const bytes = new TextEncoder().encode(text), half = Math.floor(bytes.length / 2);
    controller.enqueue(bytes.subarray(0, half)); controller.enqueue(bytes.subarray(half)); controller.close();
  } }), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  const frames: unknown[] = [];
  let client = api(t, async () => body(frame(1, [waiting]) + ": heartbeat\r\n\r\n" + frame(2, []).replace(/\n/gu, "\r\n")));
  await client.streamAttention(new AbortController().signal, value => frames.push(value));
  assert.deepEqual(frames, [{ revision: 1, items: [waiting] }, { revision: 2, items: [] }]);
  client = api(t, async () => body(frame(3, [waiting]).replace("id: 3", "id: 4")));
  await assert.rejects(client.streamAttention(new AbortController().signal, () => {}), code("INVALID_RESPONSE"));
  client = api(t, async () => body(frame(5, [{ ...waiting, kind: "other" }])));
  await assert.rejects(client.streamAttention(new AbortController().signal, () => {}), code("INVALID_RESPONSE"));
});

/** A state the Gateway could send: one Harness, with whatever `harness` and `state` change. */
function stateBody(harness: Record<string, unknown> = {}, state: Record<string, unknown> = {}): Record<string, unknown> {
  const management = { harnessId: "gemini", recipe: null, source: "missing", installedVersion: null, programVersion: null, latestVersion: null, updateStatus: "unsupported", checkedAt: null,
    activeJobId: null, installationId: null, defaultRevision: 0, error: null };
  return { workspace: "/work", providers: [], harnesses: [{ id: "gemini", name: "Gemini CLI", tier: "frozen", installed: false, defaultControlId: null, controls: [], providerProtocols: [], management,
    install: null, installations: [], unofficial: null, ...harness }], harnessesScannedAt: "2026-10-22T08:00:00.000Z", sessions: [], jobs: [], readiness: [], installationPolicy: "official", ...state };
}

test("the state carries each Harness's tier and when the last scan began, and a state without either, or with an unknown or malformed one, is refused (ADR-050)", async t => {
  let body: Record<string, unknown> = stateBody();
  const client = api(t, async () => new Response(JSON.stringify(body), { status: 200 }));
  const state = await client.state();
  assert.equal(state.harnesses[0]?.tier, "frozen"); assert.equal(state.harnessesScannedAt, "2026-10-22T08:00:00.000Z");
  // JSON leaves an undefined field out: those candidates lack the field altogether.
  for (const candidate of [stateBody({ tier: undefined }), stateBody({ tier: "hidden" }), stateBody({ tier: null }), stateBody({}, { harnessesScannedAt: undefined }), stateBody({}, { harnessesScannedAt: null }),
    stateBody({}, { harnessesScannedAt: "yesterday" }), stateBody({}, { harnessesScannedAt: "2026-10-22T08:00:00Z" }), stateBody({}, { harnessesScannedAt: "2026-13-40T99:00:00.000Z" }),
    stateBody({}, { harnessesScannedAt: 1761120000000 })]) {
    body = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
    await assert.rejects(client.state(), code("INVALID_RESPONSE"), JSON.stringify(candidate).slice(-160));
  }
});

test("a rescan asks for a scan after a time only when given one, and sends nothing else (ADR-050)", async t => {
  const bodies: unknown[] = [];
  const client = api(t, async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response("[]", { status: 200 }); });
  assert.deepEqual(await client.rescan(), []);
  assert.deepEqual(await client.rescan(undefined, "2026-10-22T08:00:00.000Z"), []);
  assert.deepEqual(bodies, [{}, { after: "2026-10-22T08:00:00.000Z" }]);
});

test("the frozen Harnesses are hidden from new work unless shown, and the open conversation's and the draft's choice never are (ADR-050)", () => {
  const harnesses = [{ id: "codex", tier: "focus" as const }, { id: "gemini", tier: "frozen" as const }, { id: "cursor", tier: "frozen" as const }, { id: "pi", tier: "frozen" as const }, { id: "autohand", tier: "catalog" as const }];
  assert.deepEqual([...hiddenHarnesses(harnesses, false, ["", ""])].sort(), ["cursor", "gemini", "pi"]);
  assert.deepEqual([...hiddenHarnesses(harnesses, true, ["", ""])], [], "shown: nothing is hidden");
  assert.deepEqual([...hiddenHarnesses(harnesses, false, ["gemini", "pi"])], ["cursor"], "the draft's and the conversation's choice stay listed");
  assert.deepEqual([...hiddenHarnesses(harnesses, false, ["codex", "autohand"])].sort(), ["cursor", "gemini", "pi"], "keeping a listed Harness changes nothing");
});

test("a cancelled Turn says why: its execution budget, its wait for the user, a restart before it was sent, or the user's stop", () => {
  assert.equal(cancelledLabel({ error: { code: "RUN_TIMEOUT" }, cancelRequested: false }), "已取消（执行预算用尽）");
  assert.equal(cancelledLabel({ error: { code: "WAIT_EXPIRED" }, cancelRequested: true }), "已取消（等待你的决定超时）");
  assert.equal(cancelledLabel({ error: { code: "OWNER_ENDED" } }), "已取消（服务重启，这条消息没有发出）");
  assert.equal(cancelledLabel({ error: null, cancelRequested: true }), "已取消（用户停止）");
  assert.equal(cancelledLabel({ error: null, cancelRequested: false }), "已取消");
});
