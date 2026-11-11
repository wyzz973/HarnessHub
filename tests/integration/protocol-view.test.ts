import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { startWebServer } from "../../src/web/server.js";
import type { ProtocolItem, ProtocolTurn } from "../../src/contracts/protocol.js";
import type { SessionStreamFrame, SessionView } from "../../src/contracts/web.js";

// The protocol (hh/1) view through the real service: a real web server, a real SQLite store and content store, a real process
// speaking ACP in place of the Harness (tests/fixtures/control-peer.mjs). The Hub reads what it stored of each Run as a Turn.

async function fixture(t: test.TestContext, scenario: string) {
  const root = await mkdtemp(join(tmpdir(), "protocol-view-")), home = join(root, "home"), workspace = join(root, "workspace"), peer = join(root, "peer.mjs"), manifest = join(root, "catalog.json");
  // Registered before anything can fail, so that a setup that throws leaves no directory behind.
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
  t.after(async () => { try { await server?.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await mkdir(home); await mkdir(workspace); await copyFile(resolve("tests/fixtures/control-peer.mjs"), peer);
  const source = { repository: "fixture", revision: "protocol", upstreamId: "fixture", url: "https://example.invalid/protocol" };
  const definitions = [{ id: "native-alpha", name: "alpha", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "native-alpha", protocol: "acp-v1", executableNames: ["fixture"], args: [peer, "acp-v1", scenario], env: {}, package: null, distribution: null, requiredExecutables: [], source }] }];
  await writeFile(manifest, JSON.stringify({ version: 2, definitions, overrides: { "native-alpha": { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), native = captureNativeEnvironment({ HOME: home, PATH: process.env.PATH });
  server = await startWebServer({ root: join(root, "data"), configuration, application: (data, publish) => application(data, publish, { installations: "any", nativeEnvironment: native, management: { installationMode: "private-fixture" }, workspaceLockRoot: join(root, "locks") }), workspaceLockRoot: join(root, "locks"), installations: "any" });
  const url = new URL(server.url), origin = url.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(url.hash.slice(1)).get("token") }) });
  const csrf = ((await boot.json()) as { csrfToken: string }).csrfToken, cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!;
  const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf };
  const call = async (path: string, body?: unknown) => { const response = await fetch(origin + "/api/v1" + path, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() as Record<string, unknown> }; };
  const until = async (id: string, predicate: (view: SessionView) => boolean): Promise<SessionView> => {
    const deadline = Date.now() + 15000;
    for (;;) { const { value } = await call("/sessions/" + id), view = value as unknown as SessionView; if (predicate(view)) return view; if (Date.now() > deadline) throw new Error("the conversation did not reach the expected state: " + JSON.stringify(view.runs.map(run => run.status))); await new Promise(done => setTimeout(done, 25)); }
  };
  /** The first frame the conversation's live stream sends: the whole view. */
  const snapshot = async (id: string): Promise<SessionStreamFrame> => {
    const abort = new AbortController(), response = await fetch(origin + "/api/v1/sessions/" + id + "/events/stream?afterSeq=0", { headers: { Cookie: cookie, Origin: origin }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) throw new Error("the stream ended before its first frame");
        buffer += decoder.decode(next.value, { stream: true });
        const end = buffer.indexOf("\n\n"), data = end < 0 ? undefined : buffer.slice(0, end).split("\n").find(line => line.startsWith("data: "));
        if (data !== undefined) return JSON.parse(data.slice(6)) as SessionStreamFrame;
      }
    } finally { abort.abort(); }
  };
  const start = async (text: string, nativeModel?: string) => {
    const created = await call("/sessions", { selection: { harnessId: "native-alpha", ...(nativeModel === undefined ? {} : { nativeModel }) }, commandId: "create" }); assert.equal(created.status, 201);
    const id = String(created.value.id); assert.equal((await call("/sessions/" + id + "/messages", { text, commandId: "send" })).status, 202); return id;
  };
  return { call, until, snapshot, start, workspace };
}
const turnOf = (view: SessionView, index = 0): ProtocolTurn => { const turn = view.runs[index]?.protocol; assert.ok(turn !== undefined, "the Run has no protocol Turn"); return turn as ProtocolTurn; };
const byType = <T extends ProtocolItem["type"]>(turn: ProtocolTurn, type: T) => turn.items.filter((item): item is Extract<ProtocolItem, { type: T }> => item.type === type);

test("the conversation view and its live stream carry each Run as a protocol Turn: the trial's tool calls, in five Harnesses' spellings, become their types", { timeout: 30000 }, async t => {
  const f = await fixture(t, "protocol-trial"), id = await f.start("tell me about the project");
  const view = await f.until(id, current => current.runs[0]?.status === "completed" && current.runs[0].tools?.length === 7 && current.runs[0].tools.every(tool => tool.status === "completed" && (tool.detail !== undefined || tool.id === "h-term" || tool.id === "x-odd")));
  const turn = turnOf(view);
  assert.equal(turn.version, "hh/1"); assert.equal(turn.n, 1); assert.equal(turn.runId, view.runs[0]!.id); assert.equal(turn.status, "completed"); assert.equal(turn.stopReason, "end_turn");
  assert.deepEqual(turn.executor, { harnessId: "native-alpha", harness: "native-alpha" });
  assert.deepEqual(turn.items.map(item => item.type), ["user_message", "command", "file_read", "command", "mcp_tool", "file_change", "command", "tool", "assistant_message"]);
  // DeepSeek Harness's `bash` and `read` have only their names for titles: the Hub reads what they ran and read from their stored details.
  const [bash, read, test, hub, edit, terminal, odd] = turn.items.slice(1, 8);
  assert.ok(bash?.type === "command" && bash.command === "pwd && ls -la" && bash.nativeName === "bash" && bash.status === "completed"); assert.ok(read?.type === "file_read" && read.path === "/w/src/cart.js");
  assert.ok(test?.type === "command" && test.command === "npm test" && test.nativeName === "Bash"); assert.ok(hub?.type === "mcp_tool" && hub.server === "harnesshub" && hub.tool === "hub_turns" && hub.hub === true);
  assert.ok(edit?.type === "file_change" && edit.nativeName === "Edit"); assert.deepEqual(edit.changes, [{ path: "/w/a.txt", op: "modify", added: 1, removed: 1 }]);
  assert.ok(terminal?.type === "command" && terminal.command === "ls -la"); assert.ok(odd?.type === "tool" && odd.name === "Brainstorm");
  // The stored detail is what the client opens a call for; the Run's own facts are as they were.
  for (const item of [bash, read, test, hub, edit]) assert.ok(item?.detail !== undefined);
  assert.equal(view.runs[0]!.tools!.length, 7); assert.deepEqual(view.runs[0]!.usage?.context, { used: 1200, size: 200000 });
  // The reply is the Run's own message; the usage is read in the protocol's one meaning (this Harness reports no tokens a Turn can be told by).
  assert.deepEqual(byType(turn, "assistant_message").map(item => [item.messageId, item.phase]), [[view.runs[0]!.assistantMessageId, "final"]]);
  assert.deepEqual(turn.usage, { completeness: "unavailable", context: { used: 1200, size: 200000 } });
  // The stream's first frame is the same view, protocol and all.
  const frame = await f.snapshot(id);
  assert.equal(frame.type, "snapshot"); assert.ok(frame.type === "snapshot"); assert.deepEqual(frame.session.runs[0]!.protocol, turn);
  // Reading it again is the same Turn: a stored detail never changes.
  assert.deepEqual(turnOf(await f.until(id, current => current.runs[0]?.status === "completed")), turn);
});

test("a Turn that waits for the user's decision is waiting, and ends completed once it is decided", { timeout: 30000 }, async t => {
  const f = await fixture(t, "permission"), id = await f.start("fixture approval");
  const waiting = await f.until(id, view => (view.permissions ?? []).some(request => !request.decided));
  assert.equal(turnOf(waiting).status, "waiting"); assert.equal(turnOf(waiting).stopReason, undefined);
  const request = waiting.permissions!.find(item => !item.decided)!;
  assert.equal((await f.call(`/sessions/${id}/permissions/${request.id}`, { optionId: "allow", commandId: "decision" })).status, 200);
  const done = await f.until(id, view => view.runs[0]?.status === "completed");
  assert.equal(turnOf(done).status, "completed"); assert.equal(turnOf(done).stopReason, "end_turn");
});

test("a Turn the model refused is failed with its reason, and no error item that has nothing to say", { timeout: 30000 }, async t => {
  const f = await fixture(t, "refusal"), id = await f.start("something refused");
  const view = await f.until(id, current => current.runs[0]?.status === "failed"), turn = turnOf(view);
  assert.equal(view.runs[0]!.error, null); assert.equal(turn.status, "failed"); assert.equal(turn.stopReason, "refusal"); assert.deepEqual(byType(turn, "error"), []);
});

test("a model is shown by the name its Harness's catalog gives it once the Hub has read that catalog, and by its native spelling made readable until then", { timeout: 30000 }, async t => {
  const f = await fixture(t, "native-experience"), id = await f.start("which model", "native-model-a");
  const before = await f.until(id, view => view.runs[0]?.status === "completed");
  assert.deepEqual(turnOf(before).executor.model, { id: "native-model-a", label: "Native Model A" });
  // The message box's picker reads the catalog; from then on the same Turn names its model as the catalog does.
  assert.equal((await f.call("/harnesses/native-alpha/models?controlId=native-alpha&workspace=" + encodeURIComponent(f.workspace))).status, 200);
  assert.deepEqual(turnOf(await f.until(id, view => view.runs[0]?.status === "completed")).executor.model, { id: "native-model-a", label: "Native A" });
});
