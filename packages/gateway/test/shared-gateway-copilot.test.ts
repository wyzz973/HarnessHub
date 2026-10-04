// SPDX-License-Identifier: MIT
/**
 * Copilot accounts: the gateway's bridge to Copilot sessions, through the
 * real handler, with a scripted in-memory runtime in place of the daemon's
 * Copilot hosts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type {
  AllowanceReading,
  CredentialId,
  ProviderConfig,
} from "@harnesshub/core/model-plane";
import { SUBSCRIPTION_NOTICES } from "@harnesshub/core/subscriptions";
import {
  CopilotError,
  copilotUnmapped,
  type CopilotEvent,
  type CopilotRuntime,
  type CopilotSession,
  type CopilotSessionOptions,
} from "../src/copilot.js";
import type { StoredReading } from "../src/routing.js";
import {
  addKey,
  at,
  MemoryStore,
  mount,
  provider,
  send,
  until,
} from "./shared-support.js";

const STAMP = "2026-10-02T00:00:00.000Z";

function copilotProvider(id = "copilot"): ProviderConfig {
  return {
    ...provider(id, {}),
    name: "GitHub Copilot",
    kind: "vendor",
    subscription: { backend: "copilot" },
    credentials: [
      {
        id: "account-1" as CredentialId,
        name: "octocat",
        ref: { kind: "store", value: "00000000-0000-4000-8000-00000000c0p1" },
        enabled: true,
        account: {
          backend: "copilot",
          subject: "octocat",
          host: "https://github.com",
          auth: "login",
          consent: {
            notice: SUBSCRIPTION_NOTICES.copilot.version,
            acceptedAt: STAMP,
          },
        },
      },
    ],
    models: { source: "live", list: [{ id: "gpt-5" }], expose: "all" },
  };
}

type Answered = { text: string } | { error: string };

/** What a fake session does when it gets a prompt or a tool result. */
interface Script {
  prompt(session: FakeSession, prompt: string): void;
  answer?(session: FakeSession, requestId: string, result: Answered): void;
}

class FakeSession implements CopilotSession {
  #handler: ((event: CopilotEvent) => void) | undefined;
  sent: string[] = [];
  answers: { requestId: string; result: Answered }[] = [];
  aborted = 0;
  closed = false;
  constructor(
    readonly options: CopilotSessionOptions,
    private readonly script: Script,
  ) {}
  emit(...events: CopilotEvent[]): void {
    for (const event of events) this.#handler!(event);
  }
  listen(handler: (event: CopilotEvent) => void): void {
    this.#handler = handler;
  }
  async send(prompt: string): Promise<void> {
    this.sent.push(prompt);
    setImmediate(() => this.script.prompt(this, prompt));
  }
  async answer(requestId: string, result: Answered): Promise<void> {
    this.answers.push({ requestId, result });
    setImmediate(() => this.script.answer?.(this, requestId, result));
  }
  async abort(): Promise<void> {
    this.aborted++;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const READING: AllowanceReading = {
  window: "premium_interactions",
  usedPercent: 40,
  resetsAt: "2026-11-01T00:00:00.000Z",
  spanSeconds: 31 * 86_400,
  observedAt: STAMP,
};

class FakeRuntime implements CopilotRuntime {
  sessions: FakeSession[] = [];
  quotas = 0;
  failOpen: CopilotError | undefined;
  constructor(private readonly script: Script) {}
  async open(
    _provider: ProviderConfig,
    _credential: unknown,
    options: CopilotSessionOptions,
  ): Promise<CopilotSession> {
    if (this.failOpen) throw this.failOpen;
    const session = new FakeSession(options, this.script);
    this.sessions.push(session);
    return session;
  }
  async quota(): Promise<AllowanceReading[]> {
    this.quotas++;
    return [READING];
  }
}

/** Says hello, or asks for the weather tool when the prompt mentions weather. */
const WEATHER: Script = {
  prompt(session, prompt) {
    if (/weather/.test(prompt) && session.options.tools.length) {
      session.emit(
        {
          type: "message",
          text: "",
          toolRequests: [
            {
              toolCallId: "call_w1",
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          ],
        },
        { type: "usage", usage: { input: 30, output: 8 } },
        { type: "tool", requestId: "req-1", toolCallId: "call_w1" },
      );
      return;
    }
    session.emit(
      { type: "delta", text: "Hello" },
      { type: "delta", text: " there" },
      { type: "message", text: "Hello there", toolRequests: [] },
      { type: "usage", usage: { input: 12, output: 3, cacheRead: 2 } },
      { type: "idle", aborted: false },
    );
  },
  answer(session, _requestId, result) {
    const text = `Sunny, ${"text" in result ? result.text : "unknown"}`;
    session.emit(
      { type: "delta", text },
      { type: "message", text, toolRequests: [] },
      { type: "usage", usage: { input: 40, output: 6 } },
      { type: "idle", aborted: false },
    );
  },
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather of a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

async function setup(t: test.TestContext, script: Script = WEATHER) {
  const store = new MemoryStore();
  await store.putProvider(copilotProvider());
  const key = await addKey(store, ["copilot/*"]);
  const runtime = new FakeRuntime(script);
  const saved: StoredReading[][] = [];
  const gw = await mount(
    t,
    store,
    {},
    {
      copilot: runtime,
      allowances: {
        load: async () => [],
        save: async (readings) => void saved.push(readings),
      },
    },
  );
  const call = (body: Record<string, unknown>) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "copilot/gpt-5", ...body },
    });
  return { store, runtime, gw, call, saved, key };
}

void test("copilotUnmapped lists what a session does not take", () => {
  assert.deepEqual(
    copilotUnmapped({
      model: "m",
      messages: [],
      stream: true,
      tools: [],
      tool_choice: "auto",
      temperature: 0.2,
      max_tokens: 100,
      reasoning_effort: "high",
    }),
    ["temperature", "max_tokens"],
  );
  assert.deepEqual(copilotUnmapped({ model: "m", tool_choice: "none" }), [
    "tool_choice",
  ]);
});

void test("a Copilot account answers through a session with the caller's system prompt and functions only", async (t) => {
  const { runtime, call, store, gw, saved } = await setup(t);
  const answer = await call({
    stream: true,
    temperature: 0.2,
    tools: TOOLS,
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(answer.status, 200);
  assert.match(answer.text, /"content":"Hello"/);
  assert.match(answer.text, /"content":" there"/);
  assert.match(answer.text, /data: \[DONE\]/);
  assert.equal(runtime.sessions.length, 1);
  const session = runtime.sessions[0]!;
  assert.equal(session.options.model, "gpt-5");
  assert.equal(session.options.system, "You are terse.");
  assert.deepEqual(
    session.options.tools.map((tool) => [tool.name, tool.description]),
    [["get_weather", "Weather of a city"]],
  );
  assert.deepEqual(session.sent, ["hi"]);
  await until(() => store.entries.length === 1);
  const entry = store.entries[0]!;
  assert.equal(entry.provider, "copilot");
  assert.equal(entry.upstreamProtocol, "chat");
  assert.ok(entry.unmapped.includes("temperature"));
  assert.deepEqual(
    [entry.usage?.input, entry.usage?.cacheRead, entry.usage?.output],
    [10, 2, 3],
  );
  // The quota after the answer becomes the account's reading.
  await until(() => runtime.quotas === 1);
  await gw.handler.close();
  assert.ok(session.closed, "closing the gateway closes its sessions");
  assert.deepEqual(
    saved
      .at(-1)
      ?.map((item) => [
        item.provider,
        item.credential,
        item.reading.window,
        item.reading.usedPercent,
      ]),
    [["copilot", "account-1", "premium_interactions", 40]],
  );
});

void test("tool calls end the answer; their results and the next user turn continue the same session", async (t) => {
  const { runtime, call, store } = await setup(t);
  const opening = [
    { role: "system", content: "Use tools." },
    { role: "user", content: "What is the weather in Paris?" },
  ];
  const first = await call({ tools: TOOLS, messages: opening });
  assert.equal(first.status, 200);
  const choice = at(first.json(), "choices", 0) as Record<string, unknown>;
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(at(choice, "message", "tool_calls", 0, "function"), {
    name: "get_weather",
    arguments: '{"city":"Paris"}',
  });
  const withResult = [
    ...opening,
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_w1",
          type: "function",
          // Re-serialized arguments still match.
          function: { name: "get_weather", arguments: '{ "city": "Paris" }' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_w1", content: "22C" },
  ];
  const second = await call({ tools: TOOLS, messages: withResult });
  assert.equal(second.status, 200);
  assert.equal(
    at(second.json(), "choices", 0, "message", "content"),
    "Sunny, 22C",
  );
  assert.equal(runtime.sessions.length, 1);
  const session = runtime.sessions[0]!;
  assert.deepEqual(session.answers, [
    { requestId: "req-1", result: { text: "22C" } },
  ]);
  const third = await call({
    tools: TOOLS,
    messages: [
      ...withResult,
      { role: "assistant", content: "Sunny, 22C" },
      { role: "user", content: "thanks" },
    ],
  });
  assert.equal(third.status, 200);
  assert.equal(runtime.sessions.length, 1);
  assert.deepEqual(session.sent, ["What is the weather in Paris?", "thanks"]);
  // A conversation the session does not hold opens one with a transcript.
  const other = await call({
    tools: TOOLS,
    messages: [
      { role: "system", content: "Use tools." },
      { role: "user", content: "An edited question" },
      { role: "assistant", content: "An answer" },
      { role: "user", content: "and now?" },
    ],
  });
  assert.equal(other.status, 200);
  assert.equal(runtime.sessions.length, 2);
  const fresh = runtime.sessions[1]!.sent[0]!;
  assert.match(
    fresh,
    /^<transcript>\n<user>\nAn edited question\n<\/user>\n<assistant>\nAn answer\n<\/assistant>\n<\/transcript>\n\nand now\?$/,
  );
  await until(() => store.entries.length === 4);
  assert.ok(store.entries[3]!.patches.includes("copilot:transcript"));
  assert.ok(!store.entries[1]!.patches.includes("copilot:transcript"));
});

void test("a session error is the upstream's error; an account that must sign in again fails as such", async (t) => {
  const limited: Script = {
    prompt(session) {
      session.emit({
        type: "error",
        message: "You have exceeded your premium request allowance",
        code: "quota_exceeded",
      });
    },
  };
  const { runtime, call, store, gw } = await setup(t, limited);
  const refused = await call({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(refused.status, 429);
  const message = String(at(refused.json(), "error", "message"));
  assert.match(message, /Usage limit reached/);
  assert.match(message, /github\.com\/settings\/billing/);
  assert.ok(runtime.sessions[0]!.closed, "a failed session is closed");
  // The used-up account rests; after that it is tried again.
  const resting = await call({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(resting.status, 429);
  assert.equal(runtime.sessions.length, 1);
  gw.clock.now += 16 * 60_000;
  runtime.failOpen = new CopilotError(
    "The Copilot CLI is not signed in",
    "signed_out",
  );
  const signedOut = await call({
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(signedOut.status, 401);
  assert.equal(
    at(signedOut.json(), "error", "code"),
    "subscription_sign_in_needed",
  );
  assert.match(
    String(at(signedOut.json(), "error", "message")),
    /hh subscription login copilot --provider copilot/,
  );
  gw.clock.now += 24 * 3_600_000;
  runtime.failOpen = new CopilotError(
    "The Copilot SDK is not installed",
    "sdk_missing",
  );
  const missing = await call({
    messages: [{ role: "user", content: "hello again" }],
  });
  assert.equal(missing.status, 503);
  assert.equal(at(missing.json(), "error", "code"), "subscription_unavailable");
  await until(() => store.entries.length === 4);
});

void test("a client that goes away stops the turn and closes its session", async (t) => {
  const hanging: Script = {
    prompt(session) {
      session.emit({ type: "delta", text: "partial" });
    },
  };
  const { runtime, gw, key } = await setup(t, hanging);
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: gw.port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${key.text}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.once("data", () => {
          request.destroy();
          resolve();
        });
      },
    );
    request.on("error", () => undefined);
    request.end(
      JSON.stringify({
        model: "copilot/gpt-5",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    setTimeout(() => reject(new Error("no data")), 5_000);
  });
  await until(() => runtime.sessions[0]?.closed === true);
  assert.equal(runtime.sessions[0]!.aborted, 1);
});
