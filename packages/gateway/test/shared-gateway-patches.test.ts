// SPDX-License-Identifier: MIT
/**
 * The patches the real-agent conformance suite asked for: Anthropic beta
 * fields stripped for strict Anthropic-compatible upstreams, the output
 * limit field renamed either way, and system messages merged into the first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { listPresets } from "../src/presets.js";
import { passthroughBody } from "../src/passthrough.js";
import {
  addKey,
  CHAT_REPLY,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

const patch = (
  protocol: Parameters<typeof passthroughBody>[0],
  body: Record<string, unknown>,
  set: Parameters<typeof passthroughBody>[4],
) => {
  const result = passthroughBody(
    protocol,
    Buffer.from(JSON.stringify(body)),
    body,
    "wire",
    set,
  );
  return {
    body: JSON.parse(result.body.toString("utf8")) as Record<string, unknown>,
    raw: result.body.toString("utf8"),
    patches: result.patches,
  };
};

/** What Claude Code 2.1.289 sends on Anthropic passthrough, in short. */
const CLAUDE_CODE = {
  model: "glm-4.6",
  max_tokens: 32000,
  stream: true,
  system: [{ type: "text", text: "You are Claude Code." }],
  messages: [
    { role: "user", content: "hi" },
    { role: "system", content: "Today is Saturday." },
    { role: "assistant", content: "Hello" },
    { role: "user", content: [{ type: "text", text: "go on" }] },
  ],
  tools: [],
  context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
  safeguards: { level: "default" },
  output_config: { effort: "high" },
  metadata: { user_id: "u" },
};

void test("anthropic-strip-beta-fields keeps the GA request and moves system messages into system", () => {
  const stripped = patch("anthropic", CLAUDE_CODE, {
    patches: ["anthropic-strip-beta-fields"],
  });
  assert.deepEqual(Object.keys(stripped.body).sort(), [
    "max_tokens",
    "messages",
    "metadata",
    "model",
    "stream",
    "system",
    "tools",
  ]);
  assert.deepEqual(stripped.body.system, [
    { type: "text", text: "You are Claude Code." },
    { type: "text", text: "Today is Saturday." },
  ]);
  assert.deepEqual(
    (stripped.body.messages as { role: string }[]).map(
      (message) => message.role,
    ),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(stripped.patches, [
    "anthropic-strip-beta-fields:context_management",
    "anthropic-strip-beta-fields:safeguards",
    "anthropic-strip-beta-fields:output_config",
    "merge-system-messages",
  ]);
  // A string system gets the text appended.
  assert.equal(
    patch(
      "anthropic",
      { ...CLAUDE_CODE, system: "Base." },
      { patches: ["merge-system-messages"] },
    ).body.system,
    "Base.\n\nToday is Saturday.",
  );
  // Without the patch (the vendor's own API) the body stays byte for byte.
  const vendor = patch("anthropic", CLAUDE_CODE, undefined);
  assert.equal(vendor.raw, JSON.stringify({ ...CLAUDE_CODE, model: "wire" }));
  assert.deepEqual(vendor.patches, []);
});

void test("max-tokens-field renames toward the provider's field, either way", () => {
  const toPlain = patch(
    "chat",
    { model: "m", max_completion_tokens: 50, messages: [] },
    { patches: ["max-tokens-field"], maxTokensField: "max_tokens" },
  );
  assert.equal(toPlain.body.max_tokens, 50);
  assert.equal("max_completion_tokens" in toPlain.body, false);
  assert.deepEqual(toPlain.patches, ["max-tokens-field"]);
  const toCompletion = patch(
    "chat",
    { model: "m", max_tokens: 9, messages: [] },
    { patches: ["max-tokens-field"] },
  );
  assert.equal(toCompletion.body.max_completion_tokens, 9);
  // Already the provider's field: nothing changes.
  assert.deepEqual(
    patch(
      "chat",
      { model: "m", max_tokens: 9, messages: [] },
      { patches: ["max-tokens-field"], maxTokensField: "max_tokens" },
    ).patches,
    [],
  );
});

void test("merge-system-messages puts Chat and Responses system and developer messages first", () => {
  const chat = patch(
    "chat",
    {
      model: "m",
      messages: [
        { role: "system", content: "A" },
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "B" }] },
        { role: "developer", content: "C" },
      ],
    },
    { patches: ["merge-system-messages"] },
  );
  assert.deepEqual(chat.body.messages, [
    { role: "system", content: "A\n\nB\n\nC" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(chat.patches, ["merge-system-messages"]);
  // One system message first: nothing to merge.
  assert.deepEqual(
    patch(
      "chat",
      {
        model: "m",
        messages: [
          { role: "system", content: "A" },
          { role: "user", content: "x" },
        ],
      },
      { patches: ["merge-system-messages"] },
    ).patches,
    [],
  );
  const responses = patch(
    "responses",
    {
      model: "m",
      instructions: "I",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "D" }] },
        { role: "user", content: "hi" },
      ],
    },
    { patches: ["merge-system-messages"] },
  );
  assert.equal(responses.body.instructions, "I\n\nD");
  assert.deepEqual(responses.body.input, [{ role: "user", content: "hi" }]);
});

void test("through the gateway: Pi's max_completion_tokens and MiMo's second system message reach a strict upstream fixed", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const strict = await upstream(
    t,
    json(200, {
      id: "m",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "x",
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "relay",
      { chat: `${up.base}/v1`, anthropic: `${strict.base}/` },
      {
        auth: { apiKeyHeader: "x-api-key" },
        patches: {
          chat: {
            patches: ["max-tokens-field", "merge-system-messages"],
            maxTokensField: "max_tokens",
          },
          anthropic: { patches: ["anthropic-strip-beta-fields"] },
        },
      },
    ),
  );
  const key = await addKey(store, ["relay/*"]);
  const gw = await mount(t, store);
  const chat = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "relay/model-a",
      max_completion_tokens: 64,
      messages: [
        { role: "system", content: "You are MiMo." },
        { role: "system", content: "Workspace: /tmp" },
        { role: "user", content: "hi" },
      ],
    },
  });
  assert.equal(chat.status, 200);
  assert.deepEqual(up.seen[0]!.json(), {
    model: "model-a",
    max_tokens: 64,
    messages: [
      { role: "system", content: "You are MiMo.\n\nWorkspace: /tmp" },
      { role: "user", content: "hi" },
    ],
  });
  assert.deepEqual(store.entries[0]!.patches, [
    "max-tokens-field",
    "merge-system-messages",
  ]);
  const anthropic = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: { ...CLAUDE_CODE, model: "relay/model-a", stream: false },
  });
  assert.equal(anthropic.status, 200);
  const sent = strict.seen[0]!.json();
  assert.equal("context_management" in sent, false);
  assert.equal("output_config" in sent, false);
  assert.ok(
    (sent.messages as { role: string }[]).every(
      (message) => message.role !== "system",
    ),
  );
});

void test("presets of Anthropic-compatible vendors strip beta fields; OpenAI writes max_completion_tokens", () => {
  const presets = new Map(listPresets().map((preset) => [preset.id, preset]));
  assert.deepEqual(presets.get("openai")!.patches?.chat, {
    patches: ["max-tokens-field"],
    maxTokensField: "max_completion_tokens",
  });
  for (const id of ["deepseek", "moonshot", "zhipu", "siliconflow"])
    assert.ok(
      presets
        .get(id)!
        .patches?.anthropic?.patches.includes("anthropic-strip-beta-fields"),
      id,
    );
  // The vendor's own Anthropic API stays byte-faithful.
  assert.equal(presets.get("anthropic")!.patches, undefined);
});
