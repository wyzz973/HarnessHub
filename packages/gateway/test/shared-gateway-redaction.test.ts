// SPDX-License-Identifier: MIT
/**
 * Outbound secret redaction: known secrets never reach an upstream, and the
 * values come back only in tool-call arguments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { RedactionSettings } from "@harnesshub/core/gateway-features";
import { maskBody, Redactor, ruleProblem } from "../src/redaction.js";
import { ToolArgumentRestorer } from "../src/restore.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  chatChunks,
  delta,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
  type Seen,
} from "./shared-support.js";

const ADMIN = "synthetic-admin-token-7f3a9c2e5b1d";
const PROVIDER_KEY = "sk-upstream-a-0001";
const PLACEHOLDER = /\{\{HH_[A-Z0-9_]+_[a-z2-7]{8}\}\}/g;

void test("the redactor masks known values, Gateway Keys and user rules with stable placeholders", () => {
  const redactor = new Redactor();
  redactor.remember(ADMIN, "ADMIN_TOKEN");
  redactor.remember("short", "PROVIDER_KEY");
  const key = `hhk_c_abcdefghijk2_${"A".repeat(43)}`;
  const rules = [{ name: "codename", pattern: "falcon-([0-9]+)" }];
  const text = `token ${ADMIN}, key ${key}, project falcon-42, short`;
  const once = redactor.mask(text, rules);
  assert.equal(once.count, 3);
  assert.ok(!once.text.includes(ADMIN) && !once.text.includes(key));
  assert.match(once.text, /\{\{HH_ADMIN_TOKEN_[a-z2-7]{8}\}\}/);
  assert.match(once.text, /\{\{HH_GATEWAY_KEY_[a-z2-7]{8}\}\}/);
  // Group 1 is the value: the rest of the match stays.
  assert.match(once.text, /project falcon-\{\{HH_CODENAME_[a-z2-7]{8}\}\}/);
  assert.match(
    once.text,
    /, short$/,
    "values under 8 characters are no secrets",
  );
  // The same value, the same placeholder; masking again changes nothing.
  assert.equal(redactor.mask(text, rules).text, once.text);
  assert.deepEqual(redactor.mask(once.text, rules), {
    text: once.text,
    count: 0,
  });
  // Another redactor (another process) has another key.
  const other = new Redactor();
  other.remember(ADMIN, "ADMIN_TOKEN");
  assert.notEqual(other.mask(text, rules).text, once.text);
  // Restoring: raw, or escaped for JSON argument text.
  const quoted = new Redactor();
  quoted.remember('pa"ss\\word123', "PROVIDER_KEY");
  const masked = quoted.mask('{"p":"pa"ss\\word123"}').text;
  assert.equal(quoted.restore(masked, false).text, '{"p":"pa"ss\\word123"}');
  assert.equal(quoted.restore(masked, true).text, '{"p":"pa\\"ss\\\\word123"}');
  // An unknown placeholder stays as it is.
  assert.equal(
    redactor.restore("{{HH_ADMIN_TOKEN_aaaaaaaa}}", false).text,
    "{{HH_ADMIN_TOKEN_aaaaaaaa}}",
  );
});

void test("JSON bodies keep identifiers, models and data URLs; rules are checked", () => {
  const redactor = new Redactor();
  redactor.remember(ADMIN, "ADMIN_TOKEN");
  const body = {
    model: ADMIN,
    messages: [
      { role: "user", content: `use ${ADMIN}` },
      {
        role: "tool",
        tool_call_id: ADMIN,
        content: [{ type: "text", text: ADMIN }],
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${ADMIN}` },
          },
        ],
      },
    ],
  };
  const masked = redactor.maskJson(body);
  assert.equal(masked.count, 2);
  const text = JSON.stringify(masked.value);
  assert.equal(text.split(ADMIN).length - 1, 3, "model, id and data URL kept");
  assert.equal(
    body.messages[0]!.content,
    `use ${ADMIN}`,
    "the input is not changed",
  );
  const settings: RedactionSettings = { enabled: false, rules: [] };
  const raw = Buffer.from(JSON.stringify(body));
  assert.equal(maskBody(redactor, settings, raw).body, raw);
  assert.equal(ruleProblem({ name: "ok_1", pattern: "a+" }), undefined);
  assert.match(ruleProblem({ name: "1bad", pattern: "a" })!, /name/);
  assert.match(ruleProblem({ name: "x", pattern: "(" })!, /not a valid/);
  assert.match(ruleProblem({ name: "x", pattern: "a*" })!, /empty string/);
  assert.match(ruleProblem({ name: "x", pattern: "a", flags: "g" })!, /flags/);
});

void test("streamed tool arguments get their values back even when a placeholder is split", () => {
  const redactor = new Redactor();
  redactor.remember(ADMIN, "ADMIN_TOKEN");
  const placeholder = redactor.mask(ADMIN).text;
  const half = Math.floor(placeholder.length / 2);
  // Chat: two fragments, the placeholder cut in half; content keeps it.
  const chat = new ToolArgumentRestorer(redactor, "chat", "sse");
  const events = [
    delta({ content: `I will use ${placeholder}` }),
    delta({
      tool_calls: [
        {
          index: 0,
          id: "c1",
          function: {
            name: "f",
            arguments: `{"t":"${placeholder.slice(0, half)}`,
          },
        },
      ],
    }),
    delta({
      tool_calls: [
        { index: 0, function: { arguments: `${placeholder.slice(half)}"}` } },
      ],
    }),
    delta({}, "tool_calls"),
  ];
  const out =
    chatChunks(events)
      .split(/(?<=\n\n)/)
      .map((chunk) => chat.push(chunk))
      .join("") + chat.end();
  const parsed = out
    .split("\n\n")
    .filter((event) => event.startsWith("data: {"))
    .map((event) => JSON.parse(event.slice(6)) as Record<string, unknown>);
  const args = parsed
    .map((event) =>
      at(
        event,
        "choices",
        0,
        "delta",
        "tool_calls",
        0,
        "function",
        "arguments",
      ),
    )
    .filter((value) => typeof value === "string")
    .join("");
  assert.deepEqual(JSON.parse(args), { t: ADMIN });
  assert.equal(
    at(parsed[0], "choices", 0, "delta", "content"),
    `I will use ${placeholder}`,
  );
  assert.match(out, /data: \[DONE\]/);

  // Anthropic: input_json_delta, held back until the block stops.
  const anthropic = new ToolArgumentRestorer(redactor, "anthropic", "sse");
  const sse = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const blocks =
    anthropic.push(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: `{"t":"${placeholder}"}`,
        },
      }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{{HH_ADM" },
        }),
    ) +
    anthropic.push(
      sse("content_block_stop", { type: "content_block_stop", index: 1 }),
    ) +
    anthropic.end();
  const partial = [...blocks.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join("");
  assert.equal(partial, `{"t":"${ADMIN}"}{{HH_ADM`);
  assert.ok(
    blocks.indexOf("content_block_stop") >
      blocks.lastIndexOf("input_json_delta"),
  );

  // Non-stream answers: Chat arguments, Responses items, Gemini args.
  const whole = (protocol: "chat" | "responses" | "gemini", body: unknown) => {
    const restorer = new ToolArgumentRestorer(redactor, protocol, "json");
    return JSON.parse(
      restorer.push(JSON.stringify(body)) + restorer.end(),
    ) as unknown;
  };
  assert.equal(
    at(
      whole("chat", {
        choices: [
          {
            index: 0,
            message: {
              content: placeholder,
              tool_calls: [
                {
                  id: "c",
                  function: { name: "f", arguments: `{"t":"${placeholder}"}` },
                },
              ],
            },
          },
        ],
      }),
      "choices",
      0,
      "message",
      "tool_calls",
      0,
      "function",
      "arguments",
    ),
    `{"t":"${ADMIN}"}`,
  );
  assert.equal(
    at(
      whole("responses", {
        output: [
          { type: "function_call", arguments: `{"t":"${placeholder}"}` },
          { type: "custom_tool_call", input: `t=${placeholder}` },
        ],
      }),
      "output",
      1,
      "input",
    ),
    `t=${ADMIN}`,
  );
  assert.equal(
    at(
      whole("gemini", {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "f", args: { t: placeholder } } },
                { text: placeholder },
              ],
            },
          },
        ],
      }),
      "candidates",
      0,
      "content",
      "parts",
      0,
      "functionCall",
      "args",
      "t",
    ),
    ADMIN,
  );
});

/** Every secret value a body sent upstream must not contain. */
function leaks(seen: Seen, values: string[]): string[] {
  const body = seen.body.toString("utf8");
  return values.filter((value) => body.includes(value));
}

void test("secrets never reach the upstream, and tool arguments get them back through the gateway", async (t) => {
  let echo = "";
  const up = await upstream(
    t,
    CHAT_REPLY,
    (response, seen) => {
      // The model calls a tool with the admin token's placeholder, split.
      const placeholder = JSON.stringify(seen.json()).match(
        /\{\{HH_ADMIN_TOKEN_[a-z2-7]{8}\}\}/,
      )![0];
      echo = placeholder;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chatChunks([
          delta({ role: "assistant", content: `Using ${placeholder}` }),
          delta({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "login",
                  arguments: `{"token":"${placeholder.slice(0, 9)}`,
                },
              },
            ],
          }),
          delta({
            tool_calls: [
              {
                index: 0,
                function: { arguments: `${placeholder.slice(9)}"}` },
              },
            ],
          }),
          delta({}, "tool_calls"),
        ]),
      );
    },
    CHAT_REPLY,
  );
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  const key = await addKey(store, ["a/*"]);
  let settings: RedactionSettings = {
    enabled: true,
    rules: [{ name: "codename", pattern: "falcon-[0-9]+" }],
  };
  const gw = await mount(
    t,
    store,
    {},
    {
      features: () => ({ schemaVersion: 1, redaction: settings }),
      secrets: [ADMIN],
    },
  );
  const call = (messages: unknown[], stream = false) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "a/model-a", stream, messages },
    });
  const secrets = [key.text, ADMIN, "falcon-42"];
  const first = await call([
    { role: "system", content: `Admin token: ${ADMIN}` },
    { role: "user", content: `My key is ${key.text} for falcon-42` },
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(leaks(up.seen[0]!, secrets), []);
  assert.equal(
    JSON.stringify(up.seen[0]!.json()).match(PLACEHOLDER)!.length,
    3,
  );
  assert.ok(store.entries[0]!.patches.includes("redact:3"));

  // The provider's own credential is known once it was resolved.
  const second = await call(
    [
      {
        role: "user",
        content: `Log in with ${ADMIN}; the vendor key is ${PROVIDER_KEY}`,
      },
    ],
    true,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(leaks(up.seen[1]!, [...secrets, PROVIDER_KEY]), []);
  assert.match(JSON.stringify(up.seen[1]!.json()), /\{\{HH_PROVIDER_KEY_/);
  const args = [...second.text.matchAll(/"arguments":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join("");
  assert.deepEqual(JSON.parse(args), { token: ADMIN });
  assert.ok(
    second.text.includes(`Using ${echo}`),
    "text keeps the placeholder",
  );
  assert.ok(!second.text.includes(`Using ${ADMIN}`));

  // The client sends the restored call back: it is masked again, the same way.
  const third = await call([
    { role: "user", content: `Log in with ${ADMIN}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "login",
            arguments: JSON.stringify({ token: ADMIN }),
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: `ok, session for ${key.text}`,
    },
  ]);
  assert.equal(third.status, 200);
  assert.deepEqual(leaks(up.seen[2]!, secrets), []);
  assert.ok(JSON.stringify(up.seen[2]!.json()).includes(echo));

  // Opt-out: the values go as they are, and nothing is recorded.
  settings = { enabled: false, rules: [] };
  await call([{ role: "user", content: `raw ${ADMIN}` }]);
  assert.deepEqual(leaks(up.seen[3]!, [ADMIN]), [ADMIN]);
  assert.ok(
    !store.entries[3]!.patches.some((patch) => patch.startsWith("redact:")),
  );
});

void test("a passed-through Anthropic request is masked and its tool input restored", async (t) => {
  const up = await upstream(t, (response, seen) => {
    const placeholder = seen.body
      .toString("utf8")
      .match(/\{\{HH_ADMIN_TOKEN_[a-z2-7]{8}\}\}/)![0];
    const event = (name: string, data: unknown) =>
      `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      event("message_start", {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "model-a",
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }) +
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tu_1",
            name: "login",
            input: {},
          },
        }) +
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: `{"token": "${placeholder.slice(0, 5)}`,
          },
        }) +
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: `${placeholder.slice(5)}"}`,
          },
        }) +
        event("content_block_stop", { type: "content_block_stop", index: 0 }) +
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 7 },
        }) +
        event("message_stop", { type: "message_stop" }),
    );
  });
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "ant",
      { anthropic: `${up.base}/` },
      { auth: { apiKeyHeader: "x-api-key" } },
    ),
  );
  const key = await addKey(store, ["ant/*"]);
  const gw = await mount(t, store, {}, { secrets: [ADMIN] });
  const answer = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      model: "ant/model-a",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: `log in with ${ADMIN}` }],
    },
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(leaks(up.seen[0]!, [ADMIN]), []);
  assert.equal(store.entries[0]!.mode, "passthrough");
  assert.ok(store.entries[0]!.patches.includes("redact:1"));
  const input = [...answer.text.matchAll(/"partial_json":"((?:[^"\\]|\\.)*)"/g)]
    .map((match) => JSON.parse(`"${match[1]}"`) as string)
    .join("");
  assert.deepEqual(JSON.parse(input), { token: ADMIN });
  assert.match(answer.text, /event: message_stop/);
});
