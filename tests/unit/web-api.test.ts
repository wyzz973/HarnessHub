import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, GatewayApi } from "../../web/src/api.js";
import { toolParents } from "../../web/src/tool-tree.js";

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
