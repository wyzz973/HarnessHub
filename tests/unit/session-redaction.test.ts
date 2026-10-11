import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl, type ProtocolObservation } from "../../src/contracts/control.js";
import { SessionError } from "../../src/contracts/session.js";
import { LocalProviderService } from "../../src/infrastructure/provider/service.js";
import { RedactedHarnessControl } from "../../src/infrastructure/session/redacted-control.js";
import { MAX_DIAGNOSTICS_BYTES, runDiagnostics, scrubDiagnostics } from "../../src/web/run-diagnostics.js";
import type { PublicRun, SessionSnapshot } from "../../src/contracts/session.js";

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
      emit({ type: "permission_requested", id: "ask", title: "Edit " + keyA, detail: "-old " + keyB + "\n+new", options: [{ id: "allow", name: "Allow " + keyA }] });
      emit({ type: "diagnostic", message: "private " + keyA + " " + keyB });
      return { result: Promise.resolve({ status: "completed", reason: "result " + keyB }), requestStop: async () => ({ requested: true }) };
    } });
  const gateway = wrapped(inner, service); assert.equal(await gateway.open("/owned/workspace"), native);
  const run = await gateway.startText(native, "literal user input", value => events.push(value)); const backend = await run.result;
  assert.equal(receivedCwd, "/owned/workspace"); assert.equal(receivedPrompt, "literal user input"); noKeys(events); noKeys(backend);
  assert.deepEqual(events, [{ type: "tool", id: "[redacted]", title: "tool [redacted]", status: "[redacted]" },
    { type: "permission", id: "[redacted]", decision: "denied" }, { type: "permission", id: "[redacted]", decision: "cancelled" },
    { type: "permission_requested", id: "ask", title: "Edit [redacted]", detail: "-old [redacted]\n+new", options: [{ id: "allow", name: "Allow [redacted]" }] },
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

test("diagnostics hide paths, environment values, credential-like strings and the account name, and keep everything else", () => {
  const scrub = (text: string) => scrubDiagnostics(text, { redact: value => value.split("hub-injected-key").join("[redacted]"), user: "someone" });
  const dirty = ["open /Users/someone/private/notes.txt failed", "cd ~/work/app && ls /private/var/folders/x/T/tmp-1", "C:\\Users\\Me\\secret.txt and file:///home/u/a.md",
    "OPENAI_API_KEY=sk-live1234567890abcdef HOME=/Users/someone", "Authorization: Bearer abc.def.ghi-123456", "token=xyz1234567 and password: hunter22",
    "ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz", "hub-injected-key in a line", "user someone logged in; max_tokens=2048 status ok"].join("\n");
  const clean = scrub(dirty);
  for (const secret of ["/Users/someone", "notes.txt", "~/work", "/private/var", "C:\\Users", "file:///", "sk-live", "abc.def.ghi", "xyz1234567", "hunter22", "ghp_", "AKIAABCD", "eyJhbGci", "hub-injected-key", "someone"])
    assert.equal(clean.includes(secret), false, secret);
  assert.equal(clean.split("\n").length, 9, "lines stay"); assert.match(clean, /OPENAI_API_KEY=\[已隐去\] HOME=\[已隐去\]/u);
  assert.match(clean, /user \[用户\] logged in; max_tokens=2048 status ok/u, "ordinary text and counters stay");
});

test("a Turn's diagnostics say what they hold, keep 4 KiB of stderr and stay within 64 KiB", () => {
  const run = { id: "run-diag", commandId: "send-diag", input: "secret question", userMessageId: "message-user", assistantMessageId: "message-assistant",
    selection: { harnessId: "claude", controlId: "claude-acp-npm" }, epoch: 1, status: "completed", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
    backend: { status: "completed", reason: "end_turn" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null }, error: null, stopRequested: false, awaitingSwitchId: null,
    timing: { acceptedAt: 1000, preparingAt: 1002, readyAt: 2600, dispatchedAt: 2602, firstOutputAt: 4000, endedAt: 9000 } } as unknown as PublicRun;
  const session = { id: "session-diag", runs: [run], messages: [{ id: "message-assistant", runId: "run-diag", role: "assistant", text: "x".repeat(200 * 1024), seq: 2, status: "completed" }] } as unknown as SessionSnapshot;
  const input = { session, run, events: [{ sessionId: "session-diag", seq: 1, ownerGeneration: 1, timestamp: "2026-10-12T00:00:00.000Z", type: "run.protocol",
      data: { runId: "run-diag", observation: { protocol: "acp-v1", protocolVersion: 1, agentName: "claude-agent-acp", agentVersion: "0.89.1", authenticationMethods: [], capabilities: {} } } }] as never,
    eventsComplete: true, stderr: { text: "early line\n" + "y".repeat(8000) + "\nlast line", truncated: false }, harness: { name: "Claude Code", programVersion: "2.1.296", installedVersion: "0.89.1" },
    build: "f".repeat(64), runtime: { node: "v25.9.0", platform: "darwin", release: "27.0.0", arch: "arm64" }, now: new Date("2026-10-12T00:00:00Z"), includeContent: false, scrub: (value: string) => value };
  const plain = runDiagnostics(input);
  assert.equal(plain.split("\n")[0], "HarnessHub 诊断 · 不含对话内容");
  assert.match(plain, /原程序在本回合报告：claude-agent-acp 0\.89\.1 · 协议版本 1/u); assert.match(plain, /当前安装：产品 2\.1\.296 · 控制入口 0\.89\.1/u);
  assert.match(plain, /阶段（距受理）：准备 2 ms · 就绪 1600 ms · 发送 1602 ms · 首个输出 3000 ms · 结束 8000 ms/u);
  assert.match(plain, /…（只保留最后 4 KiB）\n/u); assert.equal(plain.includes("early line"), false); assert.ok(plain.endsWith("last line\n"));
  assert.equal(plain.includes("secret question"), false);
  const full = runDiagnostics({ ...input, includeContent: true });
  assert.ok(Buffer.byteLength(full) <= MAX_DIAGNOSTICS_BYTES); assert.match(full, /\n提示词：\nsecret question\n/u); assert.match(full, /…（已截断）\n$/u);
  assert.match(runDiagnostics({ ...input, stderr: null }), /本次服务运行期间没有这一轮的记录/u);
  // A program's log of the prompt is conversation content: withheld unless the user chose content.
  const logged = { ...input, session: { ...session, messages: [{ id: "message-user", runId: "run-diag", role: "user", text: "secret question about the plan", seq: 1, status: "completed" }, ...session.messages] } as unknown as SessionSnapshot,
    stderr: { text: "INFO Prompt on session x: secret question about the plan\nok 收到", truncated: false } };
  assert.match(runDiagnostics(logged), /INFO Prompt on session x: \[对话内容已隐去\]\nok 收到/u);
  // Hermes's prompt log is withheld by its pattern even when it holds text no message starts with (the public context).
  assert.match(runDiagnostics({ ...input, stderr: { text: "[INFO] acp_adapter.server: Prompt on session cc03: HarnessGateway public conversation context. The JSON", truncated: false } }),
    /Prompt on session cc03: \[对话内容已隐去\]\n/u);
  assert.match(runDiagnostics({ ...logged, includeContent: true }), /INFO Prompt on session x: secret question about the plan/u);
});
