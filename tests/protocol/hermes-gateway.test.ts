import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { ControlEvent, ControlLaunch, ControlOptions, HarnessControl } from "../../src/contracts/control.js";
import { createNativeControl, relayCapabilities } from "../../src/adapters/control/factory.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes/control.js";

// Replays of real hermes-gateway-v1 traffic (recorded 2026-11-15 against Hermes v0.23.1, commit 3b421578, deepseek-flash; tests/fixtures/hermes/,
// personal paths and private fields removed): a fake control socket answers identify and session-ticket as the gateway does, and a fake WebSocket
// answers each request the driver sends with the recorded answer to the same method, then the events recorded after it, until the next request.
// Nothing here reaches a Hermes.

type Frame = Record<string, unknown>;
interface Entry { readonly dir: "out" | "in"; readonly frame: Frame }
const launch: ControlLaunch = { protocol: "hermes-gateway", executable: "/nonexistent/hermes", args: [], env: {} };
const WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/hermes-trial/workspace";

interface Gateway {
  readonly home: string;
  /** Every request the driver wrote, in order. */
  readonly sent: Frame[];
  control(overrides?: Partial<ControlOptions>): Promise<HarnessControl>;
}
/** Answers a request: a frame to send back, or null to hang up without an answer. */
type Override = (request: Frame, socket: WebSocket) => Frame | null | "close";
async function gateway(t: TestContext, recording: readonly Entry[], overrides: Readonly<Record<string, Override>> = {}, state = "ready"): Promise<Gateway> {
  const home = await mkdtemp(join(tmpdir(), "hh-hermes-")); t.after(() => rm(home, { recursive: true, force: true }));
  const sent: Frame[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, handleProtocols: protocols => protocols.has("hermes-gateway-v1") && [...protocols].some(name => name.startsWith("hermes-gateway-ticket.")) ? "hermes-gateway-v1" : false });
  await new Promise<void>(done => wss.once("listening", () => done()));
  t.after(() => new Promise<void>(done => { for (const client of wss.clients) client.terminate(); wss.close(() => done()); }));
  const port = (wss.address() as { port: number }).port;
  let at = 0;
  const push = (socket: WebSocket, until: number) => { for (; at < until; at++) { const entry = recording[at]!; if (entry.dir === "in" && entry.frame.method === "event") socket.send(JSON.stringify(entry.frame)); } };
  wss.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw)) as Frame;
    sent.push(request);
    if (typeof request.method !== "string") return;
    const override = overrides[request.method];
    if (override !== undefined) { const answer = override(request, socket); if (answer === "close") socket.terminate(); else if (answer !== null) socket.send(JSON.stringify(answer)); return; }
    const index = recording.findIndex((entry, position) => position >= at && entry.dir === "out" && entry.frame.method === request.method);
    if (index < 0) { socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown_method", data: { reason: "unknown_method" } } })); return; }
    push(socket, index);
    const recordedId = recording[index]!.frame.id, answer = recording.find((entry, position) => position > index && entry.dir === "in" && entry.frame.id === recordedId && entry.frame.method === undefined);
    at = index + 1;
    socket.send(JSON.stringify({ ...(answer?.frame ?? { jsonrpc: "2.0", result: {} }), id: request.id }));
    const next = recording.findIndex((entry, position) => position >= at && entry.dir === "out");
    push(socket, next < 0 ? recording.length : next);
  }));
  const control: Server = createServer(connection => {
    let data = "";
    connection.on("data", chunk => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.split("\n")[0]!) as Frame;
      const identity = { protocol: 1, kind: "hermes-gateway", state, runtime_protocol: 1, served_profiles: [{ profile_id: home, home }], capabilities: ["session-authority-v1", "durable-admission-v1", "event-replay-v1"],
        authority_epoch: 3, instance_id: "instance-fixture", api_origin: "http://127.0.0.1:" + port, supervisor: "launchd", code_sha: "3b421578588243f920886e6fe79a6faa87ea026e", code_version: "0.23.1" };
      const result = request.verb === "identify" ? identity : request.verb === "session-ticket" ? { profile_id: home, instance_id: "instance-fixture", runtime_protocol: 1, ticket: "ticket-fixture" } : null;
      connection.end(JSON.stringify(result === null ? { ok: false, protocol: 1, id: 1, error: "unknown verb" } : { ok: true, protocol: 1, id: 1, result }) + "\n");
    });
  });
  const socketPath = join(home, "gateway.sock");
  await new Promise<void>(done => control.listen(socketPath, () => done()));
  await chmod(socketPath, 0o600);
  t.after(() => new Promise<void>(done => control.close(() => done())));
  return { home, sent, control: async (overrides = {}) => {
    const options: ControlOptions = { cwd: WORKSPACE, env: { HOME: home, HERMES_HOME: home }, requestTimeoutMs: 5000, maxFrameBytes: 16 << 20, maxDiagnosticBytes: 1 << 14, closeGraceMs: 100, ...overrides };
    const driver = await createNativeControl("hermes", launch, options);
    t.after(() => driver.close().then(() => undefined, () => undefined));
    return driver;
  } };
}
async function recording(name: string): Promise<Entry[]> {
  return (await readFile(resolve("tests/fixtures/hermes/" + name + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Entry);
}
async function turn(control: HarnessControl, id: Parameters<HarnessControl["startText"]>[0], text: string, on?: (event: ControlEvent, run: Awaited<ReturnType<HarnessControl["startText"]>>) => void) {
  const events: ControlEvent[] = [];
  let run: Awaited<ReturnType<HarnessControl["startText"]>> | undefined;
  run = await control.startText(id, text, event => { events.push(event); if (run !== undefined) on?.(event, run); else queueMicrotask(() => on?.(event, run!)); });
  return { result: await run.result, events };
}
const texts = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "text" ? [event] : []);

test("Hermes gateway replay: a turn's reply, its reasoning and its tools keep Hermes's own ids; the committed user row is the input's evidence; the receipt gives the Turn's usage and cost", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("basic")), control = await g.control();
  const observed = await control.initialize();
  assert.deepEqual([observed.protocol, observed.protocolVersion, observed.agentVersion], ["hermes-gateway", 1, "0.23.1"]);
  assert.equal(control.relayCapabilities, hermesRelayCapabilities); assert.equal(relayCapabilities("hermes", "hermes-gateway"), hermesRelayCapabilities);
  const catalog = await control.models!();
  assert.equal(catalog.defaultModel, "deepseek:deepseek-v4-pro"); assert.ok(catalog.models.some(model => model.id === "deepseek:deepseek-flash"));
  assert.equal(catalog.authentication, "ready");
  const id = await control.open(WORKSPACE, "deepseek:deepseek-flash", { reasoning_effort: "low" });
  const create = g.sent.find(frame => frame.method === "session.create")!.params as Frame;
  assert.deepEqual([create.source, create.model, create.provider, create.reasoning, create.checkpoints], ["acp", "deepseek-flash", "deepseek", "low", true]);
  assert.deepEqual(await control.nativeConfig!(), { model: "deepseek:deepseek-flash", options: { edit_policy: "ask", reasoning_effort: "low" } });
  const first = await turn(control, id, "Read a.txt with your file tool, then reply with exactly its content.");
  assert.deepEqual(first.result, { status: "completed", reason: "completed", input: "recorded" });
  const reply = texts(first.events);
  assert.equal(reply.map(event => event.text).join("").trim(), "hello");
  assert.ok(reply.every(event => event.item === reply[0]!.item) && /^[0-9a-f]{32}:0$/u.test(reply[0]!.item!), "one segment, by Hermes's turn id and segment");
  const thinking = first.events.filter(event => event.type === "thinking");
  assert.ok(thinking.length > 0 && thinking.every(event => event.type === "thinking" && event.item === "reasoning:" + thinking[0]!.item!.split(":")[1] + ":0"));
  const tools = first.events.flatMap(event => event.type === "tool" ? [event] : []);
  assert.deepEqual(tools.map(event => [event.title, event.status, event.detail?.kind]), [["读取 a.txt", "in_progress", "read"], ["读取 a.txt", "completed", "read"]]);
  assert.ok(tools.every(event => event.id === tools[0]!.id && event.id.startsWith("call_")), "the tool call's own id");
  assert.equal(first.events.filter(event => event.type === "input_recorded").length, 1);
  const usage = first.events.flatMap(event => event.type === "usage" && event.usage.turn !== undefined ? [event.usage] : []);
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0]!.turn, { input: 34162, output: 80, cachedInput: 16896, cacheWrite: 0, reasoning: 39, total: 34242, own: true });
  assert.deepEqual([usage[0]!.cost?.currency, usage[0]!.cost?.scope, usage[0]!.context], ["USD", "turn", { used: 17150, size: 1048576 }]);
  const second = await turn(control, id, "Now reply with the single word: pong");
  assert.equal(texts(second.events).map(event => event.text).join(""), "pong");
  const secondUsage = second.events.flatMap(event => event.type === "usage" && event.usage.turn ? [event.usage] : [])[0]!;
  assert.deepEqual([secondUsage.turn?.input, secondUsage.turn?.cachedInput, secondUsage.turn?.output], [17166, 17024, 3], "the cache read is this Turn's share of the session's running total");
  await control.setTitle!(id, "HarnessHub 试用");
  const rename = g.sent.find(frame => frame.method === "session.mutate")!.params as Frame;
  assert.deepEqual([rename.operation, rename.payload, "expected_generation" in rename], ["rename", { title: "HarnessHub 试用" }, false], "a rename carries no generation fence");
  await control.close();
  assert.ok(g.sent.some(frame => frame.method === "session.detach"), "the session is left to the gateway, never ended");
  assert.deepEqual(g.sent.map(frame => frame.method).filter(method => !["runtime.describe", "model.options", "session.create", "config.set", "session.info", "prompt.submit", "prompt.receipt", "session.resume", "session.mutate", "session.detach"].includes(String(method))), []);
});

test("Hermes gateway replay: a dangerous command and an edit proposal are asked with Hermes's choices and its own wait; the user's choice goes back by prompt id and generation", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("approval")), control = await g.control({ permission: "ask" });
  await control.initialize(); control.enablePermissions!();
  const id = await control.open(WORKSPACE, "deepseek:deepseek-flash");
  const asked: Extract<ControlEvent, { type: "permission_requested" }>[] = [];
  const decide = (option: string) => (event: ControlEvent) => { if (event.type === "permission_requested") { asked.push(event); void control.decidePermission!(event.id, option); } };
  const removed = await turn(control, id, "Use the terminal tool to run exactly this command: rm -rf ./junk  (it is a scratch folder). Then say done.", decide("allow_once"));
  assert.deepEqual(removed.result, { status: "completed", reason: "completed", input: "recorded" });
  assert.deepEqual([asked[0]!.title, asked[0]!.options.map(option => option.id), asked[0]!.toolKind, asked[0]!.expiresBy], ["运行命令：rm -rf ./junk; ls -la ./junk 2>&1", ["allow_once", "deny", "allow_session", "allow_always"], "execute", "native"]);
  assert.ok((asked[0]!.expiresInMs ?? 0) > 50_000 && (asked[0]!.expiresInMs ?? 0) <= 58_000, "Hermes's 60 s, less the margin");
  assert.match(asked[0]!.detail ?? "", /command_allowlist/u, "what “always” changes is said");
  const refused = await turn(control, id, "Create a file named note.md containing the line 'hello from hermes' using your write_file tool.", decide("deny"));
  assert.equal(refused.result.status, "completed");
  assert.deepEqual(asked.slice(1).map(event => [event.title, event.toolKind, event.options.map(option => option.id)]), [["修改 note.md", "edit", ["allow_once", "deny"]], ["修改 note.md", "edit", ["allow_once", "deny"]]]);
  assert.match(asked[1]!.detail ?? "", /\+hello from hermes/u, "the edit proposal as a diff");
  const answers = g.sent.filter(frame => frame.method === "approval.respond").map(frame => (frame.params as Frame).choice);
  assert.deepEqual(answers, ["once", "deny", "deny"]);
});

test("Hermes gateway replay: words given while a turn runs go into it (session.steer with its generation, queued: taken) and the reply follows them", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("steer")), control = await g.control();
  await control.initialize(); const id = await control.open(WORKSPACE, "deepseek:deepseek-flash");
  assert.equal(control.steering, true);
  let steered: Promise<string> | undefined;
  const { result, events } = await turn(control, id, "Use the terminal tool three times, one after another: first `sleep 4 && echo one`, then `sleep 4 && echo two`, then `sleep 4 && echo three`. After all three, summarize.", event => {
    if (steered === undefined && event.type === "tool") steered = control.steer!(id, "Also, at the very end of your summary, add the word BANANA.");
  });
  assert.equal(await steered, "taken");
  assert.equal(result.status, "completed");
  assert.match(texts(events).map(event => event.text).join(""), /BANANA\s*$/u);
  assert.deepEqual((g.sent.find(frame => frame.method === "session.steer")!.params as Frame).execution_generation, 1);
});

test("Hermes gateway replay: a stop retires the admission (prompt.cancel), the turn ends cancelled with its input recorded, and the next turn runs", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("interrupt")), control = await g.control();
  await control.initialize(); const id = await control.open(WORKSPACE, "deepseek:deepseek-flash");
  let stopped: Promise<unknown> | undefined;
  const stop = await turn(control, id, "Use the terminal tool to run: sleep 25 && echo finished. Then report what it printed.", (event, run) => {
    if (stopped === undefined && event.type === "tool" && event.status === "in_progress") stopped = run.requestStop();
  });
  assert.deepEqual(await stopped, { requested: true });
  assert.deepEqual(stop.result, { status: "cancelled", reason: "interrupted", input: "recorded" });
  assert.equal(stop.events.flatMap(event => event.type === "tool" ? [event.status] : []).at(-1), "failed", "the command Hermes killed");
  assert.equal((await turn(control, id, "Reply with the single word: after")).result.status, "completed");
  assert.equal(g.sent.filter(frame => frame.method === "session.interrupt").length, 0, "the cancel alone stopped it");
});

test("Hermes gateway: a submit the gateway refuses was never admitted (not recorded); one whose answer is lost is unknown and never sent again", { timeout: 30000 }, async t => {
  const recorded = await recording("basic");
  const refusing = await gateway(t, recorded, { "prompt.submit": request => ({ jsonrpc: "2.0", id: request.id, error: { code: 4001, message: "session_busy", data: { reason: "session_busy", admitted: false } } }) });
  const control = await refusing.control();
  await control.initialize(); const id = await control.open(WORKSPACE, "deepseek:deepseek-flash");
  const refused = await turn(control, id, "hello");
  assert.deepEqual([refused.result.status, refused.result.input, refused.result.error?.code], ["failed", "not_recorded", "NATIVE_REQUEST_REFUSED"]);
  const losing = await gateway(t, recorded, { "prompt.submit": () => "close" });
  const lost = await losing.control();
  await lost.initialize(); const other = await lost.open(WORKSPACE, "deepseek:deepseek-flash");
  const unknown = await turn(lost, other, "hello").then(({ result }) => ({ status: result.status, input: result.input, code: result.error?.code }), (error: { code?: string }) => ({ status: "thrown", input: undefined, code: error.code }));
  assert.deepEqual([unknown.input, unknown.code], [undefined, "NATIVE_OUTCOME_UNKNOWN"], JSON.stringify(unknown));
  assert.equal(losing.sent.filter(frame => frame.method === "prompt.submit").length, 1, "sent once");
  assert.equal(lost.healthy!(), false);
});

test("Hermes gateway: a gateway that is not ready is refused before any socket is opened, and nothing starts it", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("basic"), {}, "starting"), control = await g.control();
  await assert.rejects(control.initialize(), (error: { code?: string; message?: string }) => error.code === "NATIVE_GATEWAY_UNAVAILABLE" && /正在启动/u.test(error.message ?? ""));
  assert.deepEqual(g.sent, [], "no request reached the gateway");
});

test("Hermes gateway: /clear is the Hub's (nothing sent, the session detached, not ended); /compress, /title and /model are fenced session changes; an unsupported command is refused unsent", { timeout: 30000 }, async t => {
  const g = await gateway(t, await recording("basic"), {
    "session.mutate": request => ({ jsonrpc: "2.0", id: request.id, result: { session_id: (request.params as Frame).session_id, operation: (request.params as Frame).operation, revision: 2, status: (request.params as Frame).operation === "compress" ? "noop" : undefined, summary: { noop: true, headline: "No changes from compression: 4 messages" } } }),
  });
  const control = await g.control();
  await control.initialize(); const id = await control.open(WORKSPACE, "deepseek:deepseek-flash");
  const compressed = await turn(control, id, "/compress");
  assert.deepEqual(compressed.result, { status: "completed", reason: "compressed", input: "not_recorded", command: "noop" });
  assert.deepEqual(compressed.events.flatMap(event => event.type === "activity" ? [event.status] : []), ["running", "completed"]);
  const cron = await turn(control, id, "/cron add every day");
  assert.deepEqual([cron.result.status, cron.result.input, cron.result.error?.code], ["failed", "not_recorded", "NATIVE_COMMAND_UNSUPPORTED"]);
  const before = g.sent.length;
  const cleared = await turn(control, id, "/clear");
  assert.deepEqual(cleared.result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } });
  for (let waited = 0; g.sent.length === before && waited < 2000; waited += 20) await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(g.sent.slice(before).map(frame => frame.method), ["session.detach"], "only a detach: the session stays in Hermes");
  assert.equal(await control.checkpoint!(), null);
  assert.ok(g.sent.filter(frame => frame.method === "session.mutate").every(frame => (frame.params as Frame).operation === "compress"));
  assert.ok(!g.sent.some(frame => frame.method === "prompt.submit"), "no command went as a prompt");
  void id;
});
