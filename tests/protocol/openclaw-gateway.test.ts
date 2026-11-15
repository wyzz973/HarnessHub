import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlLaunch, ControlOptions, NativeConversationId } from "../../src/contracts/control.js";
import { OpenClawControl } from "../../src/adapters/control/openclaw.js";
import type { GatewayConnector, GatewayHello, LinkHandlers } from "../../src/adapters/control/openclaw/link.js";
import { ALLOWED_METHODS, FORBIDDEN_METHODS, guard, HUB_KEY } from "../../src/adapters/control/openclaw/methods.js";
import { openclawFlavor } from "../../src/adapters/flavors/openclaw.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";

// OpenClaw's driver against a recording of its real Gateway (OpenClaw 2026.11.3, deepseek-chat, 2026-11-15; tests/fixtures/openclaw/,
// paths made /Users/test, only this session's frames kept): the same Turns the recording ran, its frames replayed in their order. The
// Gateway's answers and events are the recorded ones; what the driver asks for is compared with what it asked then. Nothing here
// reaches a Gateway.

type Frame = { readonly k: "hello"; readonly hello: Omit<GatewayHello, "methods"> & { readonly methods: readonly string[] | null } }
  | { readonly k: "req"; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly k: "res"; readonly method: string; readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly remoteMessage?: string; readonly remoteFields?: Record<string, string> } }
  | { readonly k: "evt"; readonly name: string; readonly payload: unknown };
const WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/openclaw-trial/workspace";
const launch: ControlLaunch = { protocol: "openclaw-gateway", executable: "/nonexistent/openclaw", args: [], env: {} };
const options: ControlOptions = { cwd: WORKSPACE, env: {}, requestTimeoutMs: 5000, maxFrameBytes: 1 << 22, maxDiagnosticBytes: 1 << 14, closeGraceMs: 100, permission: "ask", flavor: openclawFlavor,
  entry: { tools: "cli", instructions: "first-prompt" } };
const HELLO: GatewayHello = { protocol: 4, serverVersion: "2026.11.3", methods: null, scopes: ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"], maxPayload: 26214400,
  attachments: { maxBytes: 19464192, maxImageBytes: 6291456 } };

/** The recording as a Gateway: each request the driver sends must be the next one recorded; events and answers follow in the recorded order. */
function replay(frames: readonly Frame[]) {
  const first = frames[0]!;
  const hello: GatewayHello = first.k === "hello" ? { ...first.hello, methods: first.hello.methods === null ? null : new Set(first.hello.methods) } : HELLO;
  let index = first.k === "hello" ? 1 : 0, handlers: LinkHandlers | null = null, pumping = false, failure: Error | null = null;
  const keys = new Map<string, string>(), asked: { method: string; params: Record<string, unknown> }[] = [];
  const open: { method: string; params: Record<string, unknown>; matched: boolean; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const waiters: { readonly method: string; readonly wake: () => void }[] = [];
  // Recorded deadlines are absolute: the replay moves them as far as the recording is behind, the first one ten minutes from now.
  const recorded = frames.flatMap(frame => [...JSON.stringify(frame).matchAll(/"expiresAtMs":(\d+)/gu)].map(match => Number(match[1])));
  const shift = recorded.length === 0 ? 0 : Date.now() + 10 * 60_000 - Math.min(...recorded);
  const rewrite = (value: unknown): unknown => {
    let text = JSON.stringify(value ?? null); for (const [from, to] of keys) text = text.split(from).join(to);
    return JSON.parse(text.replace(/"expiresAtMs":(\d+)/gu, (_, at: string) => `"expiresAtMs":${Number(at) + shift}`));
  };
  const pump = async (): Promise<void> => {
    if (pumping) return; pumping = true;
    try {
      while (index < frames.length) {
        const frame = frames[index]!;
        if (frame.k === "evt") { index++; handlers!.event(frame.name, rewrite(frame.payload)); await new Promise(setImmediate); continue; }
        if (frame.k === "req") {
          const call = open.find(item => !item.matched);
          if (call === undefined) { for (const waiter of waiters.splice(0)) if (waiter.method === frame.method) waiter.wake(); else waiters.push(waiter); return; }
          if (call.method !== frame.method) { failure = new Error("asked " + call.method + " where the recording asked " + frame.method + " (frame " + index + ")"); call.reject(failure); return; }
          if (frame.method === "sessions.create" && typeof frame.params.key === "string" && typeof call.params.key === "string") keys.set(frame.params.key, call.params.key);
          call.matched = true; index++; continue;
        }
        if (frame.k === "res") {
          const at = open.findIndex(item => item.matched && item.method === frame.method);
          if (at < 0) { failure = new Error("no request for the recorded answer of " + frame.method); return; }
          const [call] = open.splice(at, 1);
          index++;
          if (frame.ok) call!.resolve(rewrite(frame.result));
          else call!.reject(new ControlError(frame.error?.code ?? "REMOTE_ERROR", "recorded refusal", undefined, { code: -32000, ...(frame.error?.remoteMessage ? { message: frame.error.remoteMessage } : {}), ...(frame.error?.remoteFields ? { fields: frame.error.remoteFields } : {}) }));
          await new Promise(setImmediate); continue;
        }
        index++;
      }
    } finally { pumping = false; }
  };
  const connector: GatewayConnector = async given => {
    handlers = given;
    return { hello, connected: () => true, close: async () => {},
      request: (method, params) => new Promise((resolve, reject) => { asked.push({ method, params: { ...params } }); open.push({ method, params: { ...params }, matched: false, resolve, reject }); void pump(); }) };
  };
  return {
    connector, asked, get failure() { return failure; }, get done() { return index >= frames.length; },
    /** Resolves once the replay waits for the driver to send `method`: the point where the recording sent it. */
    waitFor: (method: string) => new Promise<void>(wake => { const next = frames[index]; if (next?.k === "req" && next.method === method && !open.some(item => !item.matched)) wake(); else waiters.push({ method, wake }); }),
  };
}
async function frames(): Promise<Frame[]> {
  return (await readFile(resolve("tests/fixtures/openclaw/gateway-session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame);
}
async function turn(control: OpenClawControl, id: NativeConversationId, text: string, answer?: (event: Extract<ControlEvent, { type: "permission_requested" }>) => string, during?: () => Promise<void>) {
  const events: ControlEvent[] = [];
  const run = await control.startText(id, text, event => {
    events.push(event);
    if (event.type === "permission_requested" && answer) setImmediate(() => void control.decidePermission(event.id, answer(event)));
  });
  if (during) await during();
  return { result: await run.result, events };
}
const texts = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "text" ? [event.text] : []).join("");

test("OpenClaw over its Gateway, replayed: the session is made in the chosen folder with the level's permission mode; a turn with a tool, a question, an approval, words in the middle of a turn, /compact, a rollback and a title", async () => {
  const gateway = replay(await frames());
  const control = new OpenClawControl(launch, options, gateway.connector);
  const observed = await control.initialize();
  assert.deepEqual([observed.protocol, observed.protocolVersion, observed.agentVersion], ["openclaw-gateway", 4, "2026.11.3"]);
  control.enablePermissions();
  const catalog = await control.models();
  assert.deepEqual([catalog.defaultModel, catalog.models.map(model => model.id), catalog.authentication], ["deepseek/deepseek-chat", ["deepseek/deepseek-chat"], "ready"]);
  assert.equal(catalog.commands?.find(command => command.name === "compact")?.contextEffect, "compact");
  control.setSessionInstructions("When you finish, say DONE in capitals.");
  const id = await control.open(WORKSPACE);
  assert.match(id, HUB_KEY);
  const create = gateway.asked.find(call => call.method === "sessions.create")!.params;
  assert.deepEqual([create.cwd, create.permissionMode, create.category, create.communication, create.agentId], [WORKSPACE, "guarded", "HarnessHub", { send: "never", receive: "never" }, "main"],
    "the conversation's folder is the session's root; the level is the session's mode; the session talks to no other session");

  // One turn with a tool: the Gateway's receipt says the input was committed; the tool's title and output; the reply; usage per request.
  const one = await turn(control, id, "Use the exec tool to run `pwd`, then reply with the output only.");
  assert.deepEqual(one.result, { status: "completed", reason: "stop", input: "recorded" });
  assert.equal(one.events[0]?.type, "input_recorded");
  const tool = one.events.filter(event => event.type === "tool").at(-1);
  assert.ok(tool?.type === "tool" && tool.status === "completed" && tool.detail?.kind === "execute" && tool.detail.output?.includes(WORKSPACE), "the command ran in the chosen folder");
  assert.ok(texts(one.events).startsWith(WORKSPACE));
  const usage = one.events.find(event => event.type === "usage");
  assert.ok(usage?.type === "usage" && (usage.usage.turn?.input ?? 0) > 0 && usage.usage.context?.size === 131072 && (usage.usage.requests?.length ?? 0) >= 1);
  const sent = gateway.asked.filter(call => call.method === "chat.send").map(call => call.params);
  assert.ok(String(sent[0]!.message).includes("<harnesshub-session-instructions>"), "the instructions go after the first prompt of a new session");
  assert.equal(sent[0]!.expectedPermissionMode, "guarded");

  // OpenClaw's ask_user reaches the user as a question, which no level answers.
  const two = await turn(control, id, "Use your ask_user tool to ask me one multiple-choice question: tea or coffee? Then reply with just my answer.", event => event.options.find(option => /coffee/iu.test(option.name))!.id);
  const question = two.events.find(event => event.type === "permission_requested");
  assert.ok(question?.type === "permission_requested" && question.kind === "question" && question.options.some(option => option.name === "Tea") && (question.expiresInMs ?? 0) > 0);
  assert.deepEqual(gateway.asked.find(call => call.method === "question.resolve")!.params.answers, { answers: { tea_or_coffee: ["Coffee"] } });
  assert.equal(two.result.status, "completed"); assert.match(texts(two.events), /Coffee/u);

  // An exec approval is the Hub's to answer by the level, for the command it names.
  const three = await turn(control, id, "Use the exec tool to run exactly: touch replay-approval.txt — then reply done.", event => event.options.find(option => option.id === "allow-once")!.id);
  const approval = three.events.find(event => event.type === "permission_requested");
  assert.ok(approval?.type === "permission_requested" && approval.kind === undefined && approval.toolKind === "execute" && approval.title.includes("touch replay-approval.txt"));
  assert.deepEqual(approval.options.map(option => option.id), ["allow-once", "allow-always", "deny"]);
  assert.equal(three.result.status, "completed");

  // Words in the middle of a turn go into the run that runs; the Turn ends once their run ended too.
  let steered: string | undefined;
  const four = await turn(control, id, "Use exec to run `sleep 6`, then use exec to run `echo first-done`, then tell me which commands you ran.", event => event.options.find(option => option.id === "allow-once")!.id,
    async () => { await gateway.waitFor("chat.send"); steered = await control.steer(id, "Also, at the very end, write the word BANANA."); });
  assert.equal(steered, "taken");
  assert.equal(gateway.asked.filter(call => call.method === "chat.send").at(-1)!.params.queueMode, "steer");
  assert.equal(four.result.status, "completed"); assert.match(texts(four.events), /BANANA/u);

  // /compact alone is the Gateway's compaction, not a turn.
  const five = await turn(control, id, "/compact");
  assert.deepEqual(five.result, { status: "completed", reason: "compacted", input: "not_recorded" });
  assert.deepEqual(five.events.map(event => event.type === "activity" ? event.status : event.type), ["running", "completed"]);

  // A rollback rewinds to the user entry that began the last turn (the steer's words are not a turn of their own).
  await control.rollback(id, 1);
  const rewound = gateway.asked.find(call => call.method === "sessions.rewind")!.params;
  assert.equal(rewound.sessionKey, id);
  await control.setTitle(id, "Replay");
  assert.deepEqual(await control.nativeConfig(), { model: "deepseek/deepseek-chat", options: {} });
  assert.deepEqual(JSON.parse((await control.checkpoint())!), { key: id });
  await control.close();
  assert.equal(gateway.failure, null); assert.ok(gateway.done, "every recorded frame was replayed");

  // Nothing outside the allowed methods, nothing on another session, no delivery.
  for (const call of gateway.asked) {
    assert.ok((ALLOWED_METHODS as readonly string[]).includes(call.method), call.method);
    for (const field of ["key", "sessionKey"]) if (typeof call.params[field] === "string") assert.equal(call.params[field], id, call.method);
    if (call.method === "chat.send") for (const name of ["deliver", "originatingChannel", "originatingTo", "replyToId"]) assert.equal(call.params[name], undefined);
  }
});

test("the Gateway methods the driver may call are a fixed list, none of them sends anywhere, and a call outside it, on another session or with a delivery throws before anything is sent", async () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), ["agents.list", "chat.abort", "chat.history", "chat.send", "commands.list", "exec.approval.resolve", "models.list", "plugin.approval.resolve", "question.list",
    "question.resolve", "sessions.compact", "sessions.create", "sessions.describe", "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch", "sessions.rewind", "skills.status", "tools.catalog"]);
  const forbidden = (method: string) => FORBIDDEN_METHODS.some(entry => entry.endsWith(".*") ? method.startsWith(entry.slice(0, -1)) : method === entry);
  for (const method of ALLOWED_METHODS) assert.ok(!forbidden(method), method);
  const hub = "agent:main:harnesshub:0123abcd-0000-4000-8000-000000000000", channel = "agent:main:feishu:direct:ou_123";
  const refused = (method: string, params: Record<string, unknown>) => assert.throws(() => guard(method, params), (error: unknown) => error instanceof ControlError && error.code === "METHOD_NOT_ALLOWED", method);
  for (const method of ["send", "agent", "sessions.send", "conversations.send", "message.action", "cron.add", "config.patch", "sessions.delete", "push.send"]) refused(method, { sessionKey: hub, key: hub });
  refused("chat.send", { sessionKey: hub, message: "x", idempotencyKey: "k", deliver: true });
  refused("chat.send", { sessionKey: hub, message: "x", idempotencyKey: "k", originatingChannel: "feishu", originatingTo: "ou_123" });
  refused("chat.send", { sessionKey: channel, message: "x", idempotencyKey: "k" });
  refused("sessions.patch", { key: hub, sendPolicy: "allow" });
  refused("sessions.create", { key: channel });
  refused("sessions.create", { key: hub, parentSessionKey: channel, fork: true });
  guard("chat.send", { sessionKey: hub, message: "x", idempotencyKey: "k", queueMode: "steer" });
  guard("sessions.patch", { key: hub, label: "t" });
  // Through the driver: the refusal comes before the connection is asked anything.
  const asked: string[] = [];
  const control = new OpenClawControl(launch, options, async () => ({ hello: HELLO, connected: () => true, close: async () => {}, request: async method => { asked.push(method); return {}; } }));
  await control.initialize();
  await assert.rejects((control as unknown as { call(method: string, params: object): Promise<unknown> }).call("send", { to: "ou_123", message: "x" }), (error: unknown) => error instanceof ControlError && error.code === "METHOD_NOT_ALLOWED");
  assert.deepEqual(asked, []);
  await control.close();
});

test("each start checks the Gateway's protocol: another wire version is refused, and what this Gateway lacks is turned off and said once", async () => {
  const link = (hello: Partial<GatewayHello>, asked: string[] = []): GatewayConnector => async () => ({ hello: { ...HELLO, ...hello }, connected: () => true, close: async () => {},
    request: async (method: string, params: Readonly<Record<string, unknown>>) => {
      asked.push(method);
      if (method === "models.list") return { models: [{ id: "chat", provider: "p", name: "Chat" }] };
      if (method === "agents.list") return { defaultId: "main", agents: [{ id: "main", model: { primary: "p/chat" } }] };
      if (method === "sessions.create") return { ok: true, key: params.key, entry: { sessionRoot: WORKSPACE, permissionMode: "guarded" } };
      if (method === "chat.send") return { runId: "11111111-1111-4111-8111-111111111111", status: "started" };
      return {};
    } });
  await assert.rejects(new OpenClawControl(launch, options, link({ protocol: 3 })).initialize(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_PROTOCOL_UNSUPPORTED");
  const core = new Set(["chat.send", "chat.abort", "chat.history", "sessions.create", "sessions.patch", "sessions.describe", "agents.list", "models.list"]);
  await assert.rejects(new OpenClawControl(launch, options, link({ methods: new Set([...core].filter(method => method !== "chat.abort")) })).initialize(), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_PROTOCOL_UNSUPPORTED");
  const asked: string[] = [], control = new OpenClawControl(launch, options, link({ methods: core }, asked));
  const observed = await control.initialize();
  assert.ok(Array.isArray(observed.capabilities.featuresOff) && (observed.capabilities.featuresOff as string[]).includes("rollback"));
  const id = await control.open(WORKSPACE);
  await assert.rejects(control.rollback(id, 1), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_ROLLBACK_UNAVAILABLE");
  const events: ControlEvent[] = [];
  const run = await control.startText(id, "hi", event => events.push(event));
  void run;
  await new Promise(setImmediate);
  assert.ok(events.some(event => event.type === "diagnostic" && event.message.includes("回退")), "said once in the next Turn");
  assert.ok(!asked.includes("sessions.messages.subscribe"), "a feature that is off is not used");
  await control.close();
});
