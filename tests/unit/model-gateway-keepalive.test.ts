// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_GATEWAY_LIMITS,
  createModelGateway,
  type GatewayLimits,
  type ModelCallRecord,
  type ModelGatewayOptions,
} from "../../src/drivers/chat-completions/gateway.js";
import { HttpWriter } from "../../src/drivers/chat-completions/output.js";
import { ResponsesSink } from "../../src/drivers/chat-completions/responses.js";

type Body = Record<string, unknown>;
/** Text to write to the upstream response, or milliseconds to wait. */
type Step = string | number;

/**
 * A fake upstream that answers every request by playing `steps` after
 * sending (and flushing) 200 SSE headers. Playback stops when the gateway
 * closes the request, e.g. after its idle timeout.
 */
async function upstream(
  t: test.TestContext,
  steps: (body: Body) => Step[],
): Promise<{ baseUrl: string; requests: Body[] }> {
  const requests: Body[] = [];
  const play = async (response: ServerResponse, script: Step[]) => {
    const closed = new AbortController();
    response.once("close", () => closed.abort());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    try {
      for (const step of script)
        if (typeof step === "number")
          await delay(step, undefined, { signal: closed.signal });
        else response.write(step);
      response.end();
    } catch (error) {
      // Only the gateway closing the request may end the script early.
      if (!closed.signal.aborted) throw error;
    }
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
      requests.push(body);
      await play(response, steps(body));
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}
function data(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
function delta(value: Body, finish: string | null = null): Body {
  return { choices: [{ index: 0, delta: value, finish_reason: finish }] };
}
/** `count` waits of `every` ms, each followed by the next of `activity` in turn. */
function busy(count: number, every: number, activity: string[]): Step[] {
  return Array.from({ length: count }, (_, index) => [
    every,
    activity[index % activity.length]!,
  ]).flat();
}
const DONE = "data: [DONE]\n\n";
const USAGE = {
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

async function gateway(
  t: test.TestContext,
  baseUrl: string,
  limits: Partial<GatewayLimits> = {},
  options: Partial<ModelGatewayOptions> = {},
) {
  const calls: ModelCallRecord[] = [];
  const gw = await createModelGateway(
    {
      upstream: { protocol: "openai-completions", baseUrl },
      model: "upstream-model",
      alias: "harnesshub-model",
      onCall: (call) => calls.push(call),
      ...options,
    },
    { ...DEFAULT_GATEWAY_LIMITS, ...limits },
  );
  t.after(() => gw.close());
  gw.beginRun(new AbortController().signal);
  /** POST and resolve with the response and the milliseconds until its headers arrived. */
  const send = async (path: string, body: unknown) => {
    const started = performance.now();
    const response = await fetch(gw.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gw.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { response, started, headersMs: performance.now() - started };
  };
  return { gw, calls, send };
}

interface Timed {
  /** Milliseconds from the request start to the arrival of this event. */
  at: number;
  event?: string;
  data: unknown;
}
/** Read an SSE body, timestamping each event when it arrives. */
async function timedEvents(
  response: Response,
  started: number,
): Promise<Timed[]> {
  const list: Timed[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  assert.ok(response.body);
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!block.trim()) continue;
      let event: string | undefined;
      const lines: string[] = [];
      for (const line of block.split("\n"))
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) lines.push(line.slice(6));
      const text = lines.join("\n");
      list.push({
        at: performance.now() - started,
        ...(event ? { event } : {}),
        data: text === "[DONE]" ? text : (JSON.parse(text) as unknown),
      });
    }
  }
  return list;
}
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
/** Remove per-call ids and timestamps so two calls' outputs compare equal. */
function normalized(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9a-f]{32}/g, "ID")
      .replace(/"(created|created_at)":\d+/g, '"$1":0')
      .replace(/"sequence_number":\d+,?/g, ""),
  ) as unknown;
}
/** A call record without the fields that differ between any two calls. */
function evidence(call: ModelCallRecord | undefined): unknown {
  assert.ok(call);
  const { id, durationMs, firstByteMs, ...rest } = call;
  assert.ok(id && durationMs >= 0 && (firstByteMs ?? 0) >= 0);
  return rest;
}
const GEMINI_KEEPALIVE = {
  candidates: [{ content: { role: "model", parts: [] }, index: 0 }],
};

void test("Gemini SSE headers are flushed with the first upstream chunk, before any content, also for a tool-only turn", async (t) => {
  const up = await upstream(t, (body) =>
    JSON.stringify(body).includes("tool")
      ? [
          data(
            delta({
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"a"}' },
                },
              ],
            }),
          ),
          1500,
          data(delta({}, "tool_calls")),
          DONE,
        ]
      : [
          data(delta({ role: "assistant" })),
          1500,
          data(delta({ content: "late" }, "stop")),
          DONE,
        ],
  );
  // Default limits: the 45 s header commit deadline is not involved here.
  const { send } = await gateway(t, up.baseUrl);
  const path = "/v1beta/models/g:streamGenerateContent?alt=sse";
  const [text, tool] = await Promise.all([
    send(path, { contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    send(path, {
      contents: [{ role: "user", parts: [{ text: "tool" }] }],
      tools: [{ functionDeclarations: [{ name: "read" }] }],
    }),
  ]);
  for (const call of [text, tool]) {
    assert.equal(call.response.status, 200);
    assert.match(
      call.response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    assert.ok(call.headersMs < 750, `headers after ${call.headersMs} ms`);
  }
  const textEvents = await timedEvents(text.response, text.started);
  assert.equal(
    at(textEvents[0]!.data, "candidates", 0, "content", "parts", 0, "text"),
    "late",
  );
  assert.ok(textEvents[0]!.at >= 1400, String(textEvents[0]!.at));
  const toolEvents = await timedEvents(tool.response, tool.started);
  assert.deepEqual(
    at(toolEvents.at(-1)!.data, "candidates", 0, "content", "parts", 0),
    { functionCall: { id: "call_1", name: "read", args: { path: "a" } } },
  );
});

void test("a Gemini answer commits 200 headers headerCommitMs after a 2xx upstream answer without chunks; other protocols keep waiting", async (t) => {
  const up = await upstream(t, () => [
    1500,
    data(delta({ content: "late" }, "stop")),
    DONE,
  ]);
  const { send, calls } = await gateway(t, up.baseUrl, {
    headerCommitMs: 300,
  });
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const [sse, json, chat] = await Promise.all([
    send("/v1beta/models/g:streamGenerateContent?alt=sse", { contents }),
    send("/v1beta/models/g:generateContent", { contents }),
    send("/v1/chat/completions", {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  ]);
  for (const call of [sse, json]) {
    assert.equal(call.response.status, 200);
    assert.ok(
      call.headersMs >= 250 && call.headersMs < 1000,
      `headers after ${call.headersMs} ms`,
    );
  }
  // Chat clients have no header timeout: its headers wait for the first chunk.
  assert.ok(chat.headersMs >= 1400, `chat headers after ${chat.headersMs} ms`);
  const events = await timedEvents(sse.response, sse.started);
  assert.equal(
    at(events[0]!.data, "candidates", 0, "content", "parts", 0, "text"),
    "late",
  );
  assert.match(
    json.response.headers.get("content-type") ?? "",
    /application\/json/,
  );
  const body = (await json.response.json()) as unknown;
  assert.equal(
    at(body, "candidates", 0, "content", "parts", 0, "text"),
    "late",
  );
  await chat.response.text();
  assert.ok(calls.every((call) => call.ok && call.status === 200));
});

void test(
  "while the upstream is active but sends nothing to forward, each streaming protocol gets its own keepalive and the same final output",
  { timeout: 30_000 },
  async (t) => {
    // Empty deltas, SSE comments and (stripped) reasoning are upstream
    // activity the engine never sees: about three seconds of it.
    const up = await upstream(t, () => [
      data(delta({ role: "assistant", content: "Hel" })),
      ...busy(15, 200, [
        ": working\n\n",
        data(delta({})),
        data(delta({ reasoning_content: "r" })),
      ]),
      data(delta({ content: "lo" })),
      data(delta({}, "stop")),
      data(USAGE),
      DONE,
    ]);
    const strip = { compatibility: { reasoning: "strip" as const } };
    const live = await gateway(t, up.baseUrl, { keepaliveGapMs: 1_000 }, strip);
    const quiet = await gateway(
      t,
      up.baseUrl,
      { keepaliveGapMs: 30_000 },
      strip,
    );
    const requests = [
      [
        "/v1/chat/completions",
        {
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "x" }],
        },
      ],
      ["/v1/responses", { model: "m", stream: true, input: "x" }],
      [
        "/v1/messages",
        {
          model: "m",
          stream: true,
          max_tokens: 64,
          messages: [{ role: "user", content: "x" }],
        },
      ],
      [
        "/v1beta/models/g:streamGenerateContent?alt=sse",
        { contents: [{ role: "user", parts: [{ text: "x" }] }] },
      ],
    ] as const;
    const run = (client: typeof live) =>
      Promise.all(
        requests.map(async ([path, body]) => {
          const { response, started } = await client.send(path, body);
          assert.equal(response.status, 200, path);
          return timedEvents(response, started);
        }),
      );
    const [withKeepalives, without] = await Promise.all([
      run(live),
      run(quiet),
    ]);
    const [chat, responses, anthropic, google] = withKeepalives as [
      Timed[],
      Timed[],
      Timed[],
      Timed[],
    ];
    const keepalives = [
      // Chat: an empty delta of the same completion, never an SSE comment.
      chat.filter(
        (event) =>
          at(event.data, "choices", 0, "finish_reason") === null &&
          JSON.stringify(at(event.data, "choices", 0, "delta")) === "{}",
      ),
      responses.filter((event) => event.event === "response.in_progress"),
      // Anthropic: every ping after the one sent with message_start.
      anthropic.filter((event, index) => index > 1 && event.event === "ping"),
      google.filter(
        (event) =>
          JSON.stringify(event.data) === JSON.stringify(GEMINI_KEEPALIVE),
      ),
    ];
    for (const [index, list] of keepalives.entries()) {
      assert.ok(list.length >= 1, `${requests[index]![0]}: no keepalive`);
      const all = withKeepalives[index]!;
      for (const keepalive of list) {
        const previous = all[all.indexOf(keepalive) - 1]!;
        assert.ok(
          keepalive.at - previous.at >= 900,
          `${requests[index]![0]}: keepalive after ${keepalive.at - previous.at} ms of silence`,
        );
      }
    }
    for (const keepalive of keepalives[0]!) {
      assert.equal(at(keepalive.data, "id"), at(chat[0]!.data, "id"));
      assert.equal(at(keepalive.data, "model"), "m");
      assert.equal(at(keepalive.data, "created"), at(chat[0]!.data, "created"));
      assert.equal(at(keepalive.data, "object"), "chat.completion.chunk");
    }
    assert.deepEqual(
      responses.map((event) => at(event.data, "sequence_number")),
      responses.map((_, index) => index),
    );
    assert.equal(responses[0]!.event, "response.created");
    for (const keepalive of keepalives[1]!) {
      assert.equal(
        at(keepalive.data, "response", "id"),
        at(responses[0]!.data, "response", "id"),
      );
      assert.equal(at(keepalive.data, "response", "status"), "in_progress");
    }
    for (const keepalive of keepalives[2]!)
      assert.deepEqual(keepalive.data, { type: "ping" });
    // Without the keepalive events, the outputs are those of the run without them.
    const content = (list: Timed[], index: number) =>
      normalized(
        list
          .filter(
            (event) =>
              !keepalives[index]!.includes(event) &&
              !(index === 2 && event.event === "ping"),
          )
          .map(({ event, data }) => ({ event, data })),
      );
    for (const index of requests.keys())
      assert.deepEqual(
        content(withKeepalives[index]!, index),
        content(
          without[index]!.filter((event) => event.event !== "ping"),
          index,
        ),
        requests[index]![0],
      );
    assert.equal(
      at(responses.at(-1)!.data, "response", "usage", "total_tokens"),
      5,
    );
    for (const protocol of [
      "openai-completions",
      "openai-responses",
      "anthropic",
      "google",
    ] as const)
      assert.deepEqual(
        evidence(live.calls.find((call) => call.inbound === protocol)),
        evidence(quiet.calls.find((call) => call.inbound === protocol)),
        protocol,
      );
    assert.ok(live.calls.every((call) => call.ok && call.usage?.total === 5));
  },
);

void test(
  "an upstream sending only SSE comments gets keepalives until maxNoDataMs, then times out: in-stream once committed, 504 before",
  { timeout: 30_000 },
  async (t) => {
    // Comments for eight seconds, then a normal end: before the fix both
    // calls succeeded because every comment reset the idle timer.
    const up = await upstream(t, (body) => [
      ...(JSON.stringify(body).includes("after-data")
        ? [data(delta({ role: "assistant", content: "a" }))]
        : []),
      ...busy(32, 250, [": still working\n\n"]),
      data(delta({ content: "late" }, "stop")),
      DONE,
    ]);
    const { send, calls } = await gateway(t, up.baseUrl, {
      keepaliveGapMs: 1_000,
      maxNoDataMs: 2_500,
      idleTimeoutMs: 4_500,
    });
    const chat = (content: string) =>
      send("/v1/chat/completions", {
        model: "m",
        stream: true,
        messages: [{ role: "user", content }],
      });
    // Read the committed stream as it arrives, while the other call waits.
    const [events, uncommitted] = await Promise.all([
      chat("after-data").then(({ response, started }) => {
        assert.equal(response.status, 200);
        return timedEvents(response, started);
      }),
      chat("comments-only"),
    ]);
    const content = events.find(
      (event) => at(event.data, "choices", 0, "delta", "content") === "a",
    );
    assert.ok(content);
    const keepalives = events.filter(
      (event) =>
        JSON.stringify(at(event.data, "choices", 0, "delta")) === "{}" &&
        at(event.data, "choices", 0, "finish_reason") === null,
    );
    assert.ok(keepalives.length >= 1, "no keepalive while within maxNoDataMs");
    for (const keepalive of keepalives)
      assert.ok(
        keepalive.at - content.at <= 2_500 + 500,
        `keepalive ${keepalive.at - content.at} ms after the last data event`,
      );
    const failure = events.at(-1)!;
    assert.equal(at(failure.data, "error", "code"), "upstream_timeout");
    assert.ok(
      failure.at - content.at >= 4_500 - 200,
      `timed out ${failure.at - content.at} ms after the last data event`,
    );
    assert.ok(failure.at - keepalives.at(-1)!.at >= 1_500);
    assert.equal(
      events.some((event) => event.data === "[DONE]"),
      false,
    );
    assert.equal(uncommitted.response.status, 504);
    assert.ok(uncommitted.headersMs >= 4_500 - 200);
    assert.equal(
      at(await uncommitted.response.json(), "error", "code"),
      "upstream_timeout",
    );
    assert.deepEqual(
      calls.map((call) => [call.status, call.ok, call.error?.code]),
      [
        [504, false, "upstream_timeout"],
        [504, false, "upstream_timeout"],
      ],
    );
  },
);

void test(
  "Gemini generateContent commits on the first chunk, writes JSON whitespace keepalives and reports a later failure in a 200 body",
  { timeout: 30_000 },
  async (t) => {
    const up = await upstream(t, (body) =>
      JSON.stringify(body).includes("fail")
        ? [
            data(delta({ content: "Hel" })),
            ...busy(7, 200, [data(delta({}))]),
            data({ error: { message: "overloaded", code: 503 } }),
          ]
        : [
            data(delta({ content: "Hel" })),
            ...busy(13, 200, [data(delta({})), ": working\n\n"]),
            data(delta({ content: "lo" }, "stop")),
            data(USAGE),
            DONE,
          ],
    );
    const live = await gateway(t, up.baseUrl, { keepaliveGapMs: 1_000 });
    const quiet = await gateway(t, up.baseUrl, { keepaliveGapMs: 30_000 });
    const path = "/v1beta/models/g:generateContent";
    const request = (text: string) => ({
      contents: [{ role: "user", parts: [{ text }] }],
    });
    const [ok, baseline, failed] = await Promise.all([
      live.send(path, request("hi")),
      quiet.send(path, request("hi")),
      live.send(path, request("fail")),
    ]);
    for (const call of [ok, failed]) {
      assert.equal(call.response.status, 200);
      assert.match(
        call.response.headers.get("content-type") ?? "",
        /application\/json/,
      );
      assert.ok(call.headersMs < 750, `headers after ${call.headersMs} ms`);
    }
    const text = await ok.response.text();
    assert.match(text, /^\n+\{/);
    const parsed = JSON.parse(text) as unknown;
    assert.equal(
      at(parsed, "candidates", 0, "content", "parts", 0, "text"),
      "Hello",
    );
    assert.deepEqual(
      normalized(parsed),
      normalized(await baseline.response.json()),
    );
    // After the commit the status cannot change: the error is the body.
    const failure = await failed.response.text();
    assert.match(failure, /^\n+\{/);
    assert.deepEqual(JSON.parse(failure), {
      error: { code: 503, message: "overloaded", status: "UNAVAILABLE" },
    });
    const failedCall = live.calls.find((call) => !call.ok);
    assert.deepEqual(
      [failedCall?.status, failedCall?.error?.code, failedCall?.stream],
      [503, "upstream_error", false],
    );
    assert.deepEqual(
      live.gw.runErrors().map((call) => call.status),
      [503],
    );
    assert.deepEqual(
      evidence(live.calls.find((call) => call.ok)),
      evidence(quiet.calls[0]),
    );
  },
);

void test("a Responses keepalive on a committed but not yet started stream sends response.created first", async (t) => {
  const server = createServer((_, response) => {
    void (async () => {
      const writer = new HttpWriter(response);
      const sink = new ResponsesSink(
        writer,
        { body: { messages: [] }, tools: new Map(), stream: true },
        {
          model: "m",
          reasoning: true,
          promptEstimate: 0,
          id: "x",
          created: 1,
        },
      );
      writer.begin(200, "text/event-stream");
      await sink.keepalive();
      await sink.start();
      await sink.text("hi");
      await sink.finish({
        text: "hi",
        reasoning: "",
        calls: [],
        finish: "stop",
      });
    })().catch(() => response.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const events = await timedEvents(response, performance.now());
  assert.deepEqual(
    events
      .slice(0, 3)
      .map((event) => [event.event, at(event.data, "sequence_number")]),
    [
      ["response.created", 0],
      ["response.in_progress", 1],
      ["response.output_item.added", 2],
    ],
  );
  assert.deepEqual(
    events.map((event) => at(event.data, "sequence_number")),
    events.map((_, index) => index),
  );
  assert.equal(events.at(-1)!.event, "response.completed");
});

void test("gateway limits outside their ranges are rejected before listening", async () => {
  const options: ModelGatewayOptions = {
    upstream: { protocol: "openai-completions", baseUrl: "http://127.0.0.1:9" },
    model: "upstream-model",
    alias: "harnesshub-model",
  };
  const invalid: [Partial<GatewayLimits>, RegExp][] = [
    [
      { keepaliveGapMs: 999 },
      /keepaliveGapMs must be an integer from 1000 to 30000/,
    ],
    [{ keepaliveGapMs: 30_001 }, /keepaliveGapMs/],
    [{ keepaliveGapMs: 1_500.5 }, /keepaliveGapMs/],
    [{ maxNoDataMs: 0 }, /maxNoDataMs/],
    [{ headerCommitMs: 60_000 }, /headerCommitMs/],
    [{ idleTimeoutMs: Number.NaN }, /idleTimeoutMs/],
    [{ maxQueued: -1 }, /maxQueued/],
  ];
  for (const [limits, message] of invalid)
    await assert.rejects(
      // A gateway wrongly created is closed before the assertion fails.
      createModelGateway(options, {
        ...DEFAULT_GATEWAY_LIMITS,
        ...limits,
      }).then((gw) => gw.close()),
      (error: unknown) =>
        error instanceof RangeError && message.test(error.message),
      JSON.stringify(limits),
    );
  for (const limits of [
    {},
    { keepaliveGapMs: 1_000 },
    { keepaliveGapMs: 30_000, maxQueued: 0 },
  ]) {
    const gw = await createModelGateway(options, {
      ...DEFAULT_GATEWAY_LIMITS,
      ...limits,
    });
    await gw.close();
  }
});
