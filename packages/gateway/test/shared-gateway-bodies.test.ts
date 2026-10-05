// SPDX-License-Identifier: MIT
/**
 * Committed calls for an export, and their bodies when the export asks for
 * them: masked by the handler's redactor (also with outbound redaction
 * off), a stream's text put together, cut at 256 KiB, handed over once the
 * response closed, never for an entry the ledger rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RedactionSettings } from "@harnesshub/core/gateway-features";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import {
  BODY_CUT,
  BODY_LIMIT,
  replyText,
  type CallBodies,
} from "../src/bodies.js";
import {
  addKey,
  CHAT_REPLY,
  chatChunks,
  delta,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
} from "./shared-support.js";

const PROVIDER_KEY = "sk-upstream-a-0001";
const ADMIN = "synthetic-admin-token-7f3a9c2e5b1d";

interface Handed {
  entry: ModelCallEntry;
  bodies?: CallBodies;
  /** Whether the client had its whole answer when the entry was handed over. */
  answered: boolean;
}

async function setup(
  t: test.TestContext,
  bodies: boolean,
  redaction: RedactionSettings,
  ...replies: Parameters<typeof upstream>[1][]
) {
  const up = await upstream(t, ...replies);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["a/*"]);
  const handed: Handed[] = [];
  let answered = false;
  const gw = await mount(
    t,
    store,
    {},
    {
      features: () => ({ schemaVersion: 1, redaction }),
      secrets: [ADMIN],
      calls: {
        bodies: () => bodies,
        committed: (entry, given) =>
          handed.push({ entry, ...(given ? { bodies: given } : {}), answered }),
      },
    },
  );
  const call = async (body: Record<string, unknown>) => {
    answered = false;
    const answer = await send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body,
    });
    answered = true;
    return answer;
  };
  return { up, store, key, handed, call };
}

void test("without bodies each committed entry is handed over at once, without them", async (t) => {
  const { handed, call, store } = await setup(
    t,
    false,
    { enabled: true, rules: [] },
    CHAT_REPLY,
  );
  const answer = await call({
    model: "a/model-a",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(answer.status, 200);
  await until(() => handed.length === 1);
  assert.equal(handed[0]!.bodies, undefined);
  // Before the terminal event: the commit comes first, the export with it.
  assert.equal(handed[0]!.answered, false);
  assert.equal(handed[0]!.entry.callId, store.entries[0]!.callId);
  // A rejected call is committed and handed over too.
  const refused = await call({ model: "b/model-a", messages: [] });
  assert.equal(refused.status, 403);
  await until(() => handed.length === 2);
  assert.equal(handed[1]!.entry.rejected, true);
});

void test("bodies are masked, a stream's text is put together, and they come once the response closed", async (t) => {
  const secret = "TCK-123456";
  const { handed, call, key, up } = await setup(
    t,
    true,
    // Outbound redaction off: the upstream sees the values, the export never does.
    { enabled: false, rules: [{ name: "ticket", pattern: "TCK-[0-9]+" }] },
    (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chatChunks([
          delta({ role: "assistant", content: "" }),
          delta({ content: "Your ticket is TC" }),
          // A value split across two events is still masked.
          delta({ content: "K-999999, done." }, "stop"),
        ]),
      );
    },
    json(200, {
      id: "x",
      object: "chat.completion",
      model: "served",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `Key ${PROVIDER_KEY}` },
          finish_reason: "stop",
        },
      ],
    }),
  );
  const streamed = await call({
    model: "a/model-a",
    stream: true,
    messages: [
      { role: "system", content: `Admin token: ${ADMIN}` },
      { role: "user", content: `Look at ${secret}; my key is ${key.text}` },
    ],
  });
  assert.equal(streamed.status, 200);
  assert.ok(up.seen[0]!.body.toString("utf8").includes(secret));
  await until(() => handed.length === 1);
  const first = handed[0]!;
  const request = JSON.parse(first.bodies!.request) as {
    model: string;
    messages: { content: string }[];
  };
  assert.equal(request.model, "a/model-a");
  for (const value of [secret, ADMIN, key.text])
    assert.equal(first.bodies!.request.includes(value), false, value);
  assert.match(
    request.messages[0]!.content,
    /^Admin token: \{\{HH_ADMIN_TOKEN_[a-z2-7]{8}\}\}$/,
  );
  assert.match(
    request.messages[1]!.content,
    /\{\{HH_TICKET_[a-z2-7]{8}\}\}.*\{\{HH_GATEWAY_KEY_/,
  );
  assert.match(
    first.bodies!.reply,
    /^Your ticket is \{\{HH_TICKET_[a-z2-7]{8}\}\}, done\.$/,
  );

  // A reply that is not a stream goes as it came, masked: the provider's
  // key is known once it was resolved. It is written only after the commit,
  // so having it shows the hand-off waited for the response to close.
  const whole = await call({
    model: "a/model-a",
    messages: [{ role: "user", content: "and the key?" }],
  });
  assert.equal(whole.status, 200);
  assert.ok(whole.text.includes(PROVIDER_KEY), "the client sees the reply");
  await until(() => handed.length === 2);
  const reply = JSON.parse(handed[1]!.bodies!.reply) as {
    choices: { message: { content: string } }[];
  };
  assert.match(
    reply.choices[0]!.message.content,
    /^Key \{\{HH_PROVIDER_KEY_[a-z2-7]{8}\}\}$/,
  );
});

void test("bodies past 256 KiB are cut and marked; a failed commit hands nothing over", async (t) => {
  const long = "x".repeat(BODY_LIMIT + 10);
  const { handed, call, store } = await setup(
    t,
    true,
    { enabled: true, rules: [] },
    json(200, {
      id: "x",
      object: "chat.completion",
      model: "served",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: long },
          finish_reason: "stop",
        },
      ],
    }),
  );
  const answer = await call({
    model: "a/model-a",
    messages: [{ role: "user", content: long }],
  });
  assert.equal(answer.status, 200);
  await until(() => handed.length === 1);
  const { request, reply } = handed[0]!.bodies!;
  for (const body of [request, reply]) {
    assert.ok(body.endsWith(BODY_CUT));
    assert.equal(
      Buffer.byteLength(body),
      BODY_LIMIT + Buffer.byteLength(BODY_CUT),
    );
  }

  store.failAppend = true;
  const unrecorded = await call({
    model: "a/model-a",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(unrecorded.status, 503);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handed.length, 1);
});

void test("a stream's text comes from each protocol's events; other replies stay as they are", () => {
  const sse = (events: unknown[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  assert.equal(
    replyText(
      sse([
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.completed" },
      ]),
    ),
    "Hello",
  );
  assert.equal(
    replyText(
      `event: content_block_delta\n${sse([
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hi" },
        },
        {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
      ])}`,
    ),
    "Hi",
  );
  assert.equal(
    replyText(
      sse([
        {
          candidates: [
            {
              content: {
                parts: [{ text: "thinking", thought: true }, { text: "Gem" }],
              },
            },
          ],
        },
        { candidates: [{ content: { parts: [{ text: "ini" }] } }] },
      ]),
    ),
    "Gemini",
  );
  // Only tool calls: the events as they came.
  const tools = sse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
        },
      ],
    },
  ]);
  assert.equal(replyText(tools), tools);
  assert.equal(replyText('{"a":1}'), '{"a":1}');
});
