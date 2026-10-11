import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { boundedWrite, MAX_CLI_INPUT_BYTES, MAX_CLI_OUTPUT_BYTES } from "../../src/cli/bounded-streams.js";
import { commandId, messageId, runId, sessionId, type SessionId, type SessionSnapshot } from "../../src/contracts/session.js";
import { SqliteSessionReader, SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

const chatCli = fileURLToPath(new URL("../../src/cli/chat.js", import.meta.url));
interface Fixture { readonly root: string; readonly data: string; readonly temporary: string; readonly home: string; readonly sentinel: string; readonly state: SessionSnapshot; readonly children: Set<ChildProcessWithoutNullStreams> }
async function fixture(t: test.TestContext, largeHistory: boolean): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-session-io-")));
  const data = join(root, "data"), workspace = join(root, "workspace"), temporary = join(root, "temporary"), home = join(root, "host-home"), sentinel = join(root, "native-started.txt");
  for (const path of [workspace, temporary, home]) await mkdir(path);
  const script = join(root, "native-sentinel.mjs"), manifestPath = join(root, "manifest.json");
  await writeFile(script, "import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],'native started');setInterval(()=>{},1000);\n", { mode: 0o600 });
  const manifest = JSON.stringify({ version: 2, definitions: [{ id: "io-fixture", name: "IO fixture", aliases: [], binaryNames: [], configHints: [], controls: [{
    id: "io-control", protocol: "acp-v1", executableNames: ["fixture-native"], args: [script, sentinel], env: {}, package: null, distribution: null, requiredExecutables: [],
    source: { repository: "fixture", revision: "test", upstreamId: "io-fixture", url: "https://example.invalid/io-fixture" },
  }] }], overrides: { "io-control": { executable: process.execPath } } });
  await writeFile(manifestPath, manifest, { mode: 0o600 });
  const store = new SqliteSessionStore(data), id = sessionId("session-io-fixture"), run = runId("run-io-history"), user = messageId("message-io-user"), assistant = messageId("message-io-assistant");
  const configuration = { workspace, manifestPath, manifestSha256: createHash("sha256").update(manifest).digest("hex"), configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const selection = { harnessId: "io-fixture", controlId: "io-control" };
  const created = store.create({ schemaVersion: 7, id, version: 0, lastSeq: 0, epoch: 1, status: "open", configuration, selection,
    activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [], commands: [{ id: commandId("io-create"), kind: "create", fingerprint: "a".repeat(64), resultId: id }] },
  [{ type: "session.created", data: {} }]);
  const state = store.transact(id, created.session.version, current => ({ next: { ...current,
    runs: [{ id: run, commandId: commandId("io-historical-input"), input: "synthetic historical input", userMessageId: user, assistantMessageId: assistant, selection, epoch: 1,
      status: "completed", cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: { status: "completed", reason: "fixed historical model fixture" },
      cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null }, error: null, stopRequested: false, awaitingSwitchId: null }],
    messages: [{ id: user, runId: run, role: "user", text: "synthetic historical input", seq: current.lastSeq + 1, status: "completed" },
      { id: assistant, runId: run, role: "assistant", text: largeHistory ? "x".repeat(1024 * 1024) : "fixed historical response", seq: current.lastSeq + 2, status: "completed" }],
    commands: [...current.commands, { id: commandId("io-historical-input"), kind: "send", fingerprint: "b".repeat(64), resultId: run }],
  }, events: [{ type: "message.accepted", data: { runId: run } }, { type: "run.ended", data: { runId: run, status: "completed", fixtureOnly: true } }] })).session;
  store.close();
  const children = new Set<ChildProcessWithoutNullStreams>();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.stdout.resume(); child.stdin.destroy(); child.kill("SIGKILL"); await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, data, temporary, home, sentinel, state, children };
}
interface ProcessResult { readonly code: number | null; readonly signal: string | null; readonly stderr: string }
function start(f: Fixture, json = true): { readonly child: ChildProcessWithoutNullStreams; readonly result: Promise<ProcessResult>; readonly stderr: (pattern: RegExp) => Promise<void> } {
  const child = spawn(process.execPath, [chatCli, "--session", f.state.id, "--data-dir", f.data, ...(json ? ["--json"] : [])],
    { cwd: f.root, env: { PATH: join(f.root, "empty-path"), HOME: f.home, TMPDIR: f.temporary, LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  f.children.add(child); child.stdin.on("error", () => {});
  let stderr = "";
  const waiters = new Set<{ readonly pattern: RegExp; readonly resolve: () => void; readonly reject: (error: Error) => void }>();
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    for (const waiter of waiters) if (waiter.pattern.test(stderr)) { waiters.delete(waiter); waiter.resolve(); }
  });
  const watchdog = setTimeout(() => { child.stdout.resume(); child.kill("SIGKILL"); }, 10000);
  const result = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(watchdog);
      for (const waiter of waiters) waiter.reject(new Error("CLI closed before diagnostic: " + code + "/" + signal + " " + stderr));
      waiters.clear(); resolve({ code, signal, stderr });
    });
  });
  void result.catch(() => {});
  return { child, result, stderr: pattern => pattern.test(stderr) ? Promise.resolve() : new Promise<void>((resolve, reject) => waiters.add({ pattern, resolve, reject })) };
}
function read(root: string, id: SessionId): SessionSnapshot {
  const reader = new SqliteSessionReader(root);
  try { return reader.get(id); } finally { reader.close(); }
}

test("formal chat rejects repeated 1MiB history before a slow stdout creates an unlimited queue", async t => {
  const f = await fixture(t, true), invoked = start(f);
  // Deliberately do not attach a stdout data listener until the budget rejection is visible on stderr.
  invoked.child.stdin.end(":history\n".repeat(150));
  await invoked.stderr(/OUTPUT_LIMIT/u);
  assert.equal(invoked.child.stdout.readableFlowing, null);
  let bytes = 0; invoked.child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; }); invoked.child.stdout.resume();
  const ended = await invoked.result;
  assert.notEqual(ended.code, 0); assert.equal(ended.signal, null); assert.match(ended.stderr, /OUTPUT_LIMIT/u);
  assert.ok(bytes <= MAX_CLI_OUTPUT_BYTES + 1024 * 1024, "slow output exceeded its bounded queue by more than an already transmitted record");
  assert.deepEqual(read(f.data, f.state.id), f.state, "history display failure changed durable execution facts");
  assert.equal(existsSync(f.sentinel), false, "a history command launched a native Harness");
  const nextOwner = new SqliteSessionStore(f.data); nextOwner.assertOwner(); nextOwner.close();
});

test("formal human chat also rejects repeated history when stdout is not consumed", async t => {
  const f = await fixture(t, true), invoked = start(f, false);
  invoked.child.stdin.end(":history\n".repeat(150));
  await invoked.stderr(/OUTPUT_LIMIT/u); invoked.child.stdout.resume();
  const ended = await invoked.result;
  assert.notEqual(ended.code, 0); assert.equal(ended.signal, null);
  assert.deepEqual(read(f.data, f.state.id), f.state); assert.equal(existsSync(f.sentinel), false);
});

test("formal chat rejects raw input above 2MiB before newline or EOF without admitting a Run", async t => {
  const f = await fixture(t, false), invoked = start(f);
  let output = ""; invoked.child.stdout.setEncoding("utf8"); invoked.child.stdout.on("data", (chunk: string) => { output += chunk; assert.ok(Buffer.byteLength(output) < 64 * 1024); });
  // stdin remains open: newline/EOF must not be needed to enforce the raw byte budget.
  invoked.child.stdin.write(Buffer.alloc(MAX_CLI_INPUT_BYTES + 65536, "x"));
  const ended = await invoked.result;
  assert.notEqual(ended.code, 0); assert.equal(ended.signal, null, "raw input rejection did not exit: " + output + " " + ended.stderr); assert.match(output, /"code":"INPUT_LIMIT"/u);
  assert.deepEqual(read(f.data, f.state.id), f.state); assert.equal(existsSync(f.sentinel), false);
  const nextOwner = new SqliteSessionStore(f.data); nextOwner.assertOwner(); nextOwner.close();
});

test("bounded writer counts real Writable pending bytes and rejects an oversized individual record", () => {
  const callbacks: (() => void)[] = [];
  const stream = new Writable({ write(_chunk, _encoding, callback) { callbacks.push(callback); } });
  boundedWrite(stream, "x".repeat(MAX_CLI_OUTPUT_BYTES)); assert.equal(stream.writableLength, MAX_CLI_OUTPUT_BYTES);
  assert.throws(() => boundedWrite(stream, "one more byte"), error => error instanceof Error && "code" in error && error.code === "OUTPUT_LIMIT");
  assert.equal(stream.writableLength, MAX_CLI_OUTPUT_BYTES);
  while (callbacks.length) callbacks.shift()!(); assert.equal(stream.writableLength, 0);
  assert.throws(() => boundedWrite(stream, "x".repeat(MAX_CLI_OUTPUT_BYTES + 1)), error => error instanceof Error && "code" in error && error.code === "OUTPUT_LIMIT");
  assert.equal(stream.writableLength, 0); stream.destroy();
});
