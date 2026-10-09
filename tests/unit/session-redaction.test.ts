import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl, type ProtocolObservation } from "../../src/contracts/control.js";
import { SessionError } from "../../src/contracts/session.js";
import { LocalProviderService } from "../../src/infrastructure/provider/service.js";
import { RedactedHarnessControl } from "../../src/infrastructure/session/redacted-control.js";

const keyA = "synthetic-private-key-version-A", keyB = "synthetic-private-key-version-B";
const native = nativeConversationId("native-owned-identity");
const observation: ProtocolObservation = { protocol: "codex-app-server", protocolVersion: null, agentName: "codex", agentVersion: "test",
  authenticationMethods: [], capabilities: {} };
const cleanup: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const providerInput = { name: "Local", protocol: "openai-responses", baseUrl: "http://127.0.0.1:1234/v1", models: ["test"], defaultModel: "test", enabled: true };
function control(overrides: Partial<HarnessControl> = {}): HarnessControl {
  return { initialize: async () => observation, open: async () => native,
    startText: async () => ({ result: Promise.resolve({ status: "completed", reason: "completed" }), requestStop: async () => ({ requested: true }) }),
    close: async () => cleanup, ...overrides };
}
function wrapped(inner: HarnessControl, service: LocalProviderService): RedactedHarnessControl {
  return new RedactedHarnessControl(inner, text => service.redact(text), () => service.createTextRedactor());
}
function privateError(): Error & { code: string } { return Object.assign(new Error("private diagnostic " + keyA + " " + keyB), { code: "backend-" + keyA }); }
function safeError(error: unknown): boolean {
  return error instanceof SessionError && error.code === "backend-[redacted]" &&
    !String(error).includes(keyA) && !String(error).includes(keyB) && !JSON.stringify(error).includes(keyA) && error.cause === undefined;
}
function noKeys(value: unknown): void { const encoded = JSON.stringify(value); assert.equal(encoded.includes(keyA), false); assert.equal(encoded.includes(keyB), false); }
async function fixture(fn: (service: LocalProviderService) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "harness-control-redaction-")), service = new LocalProviderService(root, () => {});
  try {
    const first = service.create({ ...providerInput, apiKey: keyA }, "create");
    service.update(first.id, { ...providerInput, apiKey: keyB }, first.revision, "update");
    // Neither secret has been materialized. Filtering must nevertheless cover both actual Vault revisions.
    await fn(service);
  } finally { await service.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test("Redacted control sanitizes initialize metadata, nested capabilities and object keys using the real Vault", async () => fixture(async service => {
  const input: ProtocolObservation = { ...observation, agentName: "agent-" + keyA, agentVersion: keyB,
    authenticationMethods: [keyA, "method-" + keyB], capabilities: {
      [keyA]: { nested: [keyB, { diagnostic: keyA, number: 7, enabled: true, absent: null }] }, plain: "kept",
    } };
  const result = await wrapped(control({ initialize: async () => input }), service).initialize();
  noKeys(result); assert.equal(result.protocol, input.protocol); assert.equal(result.agentName, "agent-[redacted]");
  assert.equal(result.agentVersion, "[redacted]"); assert.deepEqual(result.authenticationMethods, ["[redacted]", "method-[redacted]"]);
  assert.deepEqual(result.capabilities, { "[redacted]": { nested: ["[redacted]", { diagnostic: "[redacted]", number: 7, enabled: true, absent: null }] }, plain: "kept" });
}));

test("Redacted control preserves native identity and caller inputs while cleaning public tool, permission and diagnostic events", async () => fixture(async service => {
  const events: ControlEvent[] = []; let receivedCwd = "", receivedPrompt = "";
  const inner = control({ open: async cwd => { receivedCwd = cwd; return native; },
    startText: async (id, prompt, emit) => {
      assert.equal(id, native); receivedPrompt = prompt;
      emit({ type: "tool", id: keyA, title: "tool " + keyB, status: keyA });
      emit({ type: "permission", id: keyB, decision: "denied" });
      emit({ type: "permission", id: keyA, decision: "cancelled" });
      emit({ type: "diagnostic", message: "private " + keyA + " " + keyB });
      return { result: Promise.resolve({ status: "completed", reason: "result " + keyB }), requestStop: async () => ({ requested: true }) };
    } });
  const gateway = wrapped(inner, service); assert.equal(await gateway.open("/owned/workspace"), native);
  const run = await gateway.startText(native, "literal user input", value => events.push(value)); const backend = await run.result;
  assert.equal(receivedCwd, "/owned/workspace"); assert.equal(receivedPrompt, "literal user input"); noKeys(events); noKeys(backend);
  assert.deepEqual(events, [{ type: "tool", id: "[redacted]", title: "tool [redacted]", status: "[redacted]" },
    { type: "permission", id: "[redacted]", decision: "denied" }, { type: "permission", id: "[redacted]", decision: "cancelled" },
    { type: "diagnostic", message: "private [redacted] [redacted]" }]);
  assert.deepEqual(backend, { status: "completed", reason: "result [redacted]" });
}));

test("Redacted control filters actual credential deltas at every split point before public emission", async () => fixture(async service => {
  const output = "before " + keyA + " between " + keyB + " after";
  for (let at = 0; at <= output.length; at++) {
    const events: ControlEvent[] = [];
    const inner = control({ startText: async (_id, _prompt, emit) => {
      emit({ type: "text", text: output.slice(0, at) }); emit({ type: "text", text: output.slice(at) });
      return { result: Promise.resolve({ status: "completed", reason: "completed" }), requestStop: async () => ({ requested: true }) };
    } });
    const run = await wrapped(inner, service).startText(native, "prompt", value => { noKeys(value); events.push(value); }); await run.result;
    const text = events.map(value => value.type === "text" ? value.text : "").join("");
    assert.equal(text, "before [redacted] between [redacted] after", "split " + at); noKeys(events);
  }
}));

test("Redacted control emits ordinary text immediately and replaces an unfinished credential prefix at successful settlement", async () => fixture(async service => {
  let finish!: (value: BackendResult) => void;
  const ended = new Promise<BackendResult>(resolve => { finish = resolve; }), events: ControlEvent[] = [];
  const inner = control({ startText: async (_id, _prompt, emit) => {
    emit({ type: "text", text: "ready " }); emit({ type: "text", text: keyA.slice(0, 12) });
    emit({ type: "diagnostic", message: "diagnostic " + keyB });
    return { result: ended, requestStop: async () => ({ requested: true }) };
  } });
  const run = await wrapped(inner, service).startText(native, "prompt", value => events.push(value));
  assert.deepEqual(events, [{ type: "text", text: "ready " }, { type: "diagnostic", message: "diagnostic [redacted]" }]);
  finish({ status: "completed", reason: "completed" }); await run.result;
  assert.deepEqual(events.at(-1), { type: "text", text: "[redacted]" }); noKeys(events);
}));

test("Redacted control masks cleanup failure code/message while preserving process cleanup evidence", async () => fixture(async service => {
  const result = await wrapped(control({ close: async () => ({ closed: true, exitCode: null, signal: "SIGTERM",
    protocolFailure: { code: "protocol-" + keyA, message: "diagnostic " + keyB } }) }), service).close();
  noKeys(result); assert.deepEqual(result, { closed: true, exitCode: null, signal: "SIGTERM", protocolFailure: { code: "protocol-[redacted]", message: "diagnostic [redacted]" } });
  assert.deepEqual(await wrapped(control(), service).close(), cleanup);
}));

test("Redacted control masks initialize, open, startText and close errors including private error codes", async () => fixture(async service => {
  for (const method of ["initialize", "open", "startText", "close"] as const) {
    const failure = privateError();
    const inner = control({ [method]: async () => { throw failure; } });
    const gateway = wrapped(inner, service);
    if (method === "initialize") await assert.rejects(gateway.initialize(), safeError);
    else if (method === "open") await assert.rejects(gateway.open("/owned/workspace"), safeError);
    else if (method === "startText") await assert.rejects(gateway.startText(native, "prompt", () => {}), safeError);
    else await assert.rejects(gateway.close(), safeError);
  }
}));

test("Redacted control masks asynchronous backend result and requestStop failures", async () => fixture(async service => {
  let fail!: (error: Error) => void;
  const result = new Promise<BackendResult>((_resolve, reject) => { fail = reject; });
  const inner = control({ startText: async () => ({ result, requestStop: async () => { throw privateError(); } }) });
  const run = await wrapped(inner, service).startText(native, "prompt", () => {});
  await assert.rejects(run.requestStop(), safeError); fail(privateError()); await assert.rejects(run.result, safeError);
}));

test("Redacted control hides arbitrary non-Error thrown values and bounds sanitized error codes", async () => fixture(async service => {
  const arbitrary = wrapped(control({ initialize: async () => { throw keyA; } }), service);
  await assert.rejects(arbitrary.initialize(), error => error instanceof SessionError && error.code === "CONTROL_FAILED" && !String(error).includes(keyA));
  const bounded = wrapped(control({ initialize: async () => { throw Object.assign(new Error(keyA), { code: "x".repeat(140) + keyB }); } }), service);
  await assert.rejects(bounded.initialize(), error => error instanceof SessionError && error.code.length === 128 && !error.code.includes(keyB));
}));

test("Redacted control does not publish a withheld key prefix if the backend fails before settlement", async () => fixture(async service => {
  let fail!: (error: Error) => void;
  const result = new Promise<BackendResult>((_resolve, reject) => { fail = reject; }), events: ControlEvent[] = [];
  const inner = control({ startText: async (_id, _prompt, emit) => {
    emit({ type: "text", text: "safe " + keyA.slice(0, 10) });
    return { result, requestStop: async () => ({ requested: true }) };
  } });
  const run = await wrapped(inner, service).startText(native, "prompt", value => events.push(value));
  fail(privateError()); await assert.rejects(run.result, safeError);
  assert.deepEqual(events, [{ type: "text", text: "safe " }]); noKeys(events);
}));
