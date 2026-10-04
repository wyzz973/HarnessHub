// SPDX-License-Identifier: MIT
/** Route group members: nested groups, efforts fixed on a member, the fast mode, and what a group offers. */
import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig, RouteGroup } from "@harnesshub/core/model-plane";
import { canFast, fastMode } from "@harnesshub/core/route-groups";
import {
  CLAUDE_FAST_BETA,
  memberFast,
  memberPassthrough,
  withFastBeta,
} from "../src/members.js";
import {
  modelCandidates,
  planGroup,
  type Candidate,
  type GroupPlanning,
} from "../src/routing.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  until,
  upstream,
} from "./shared-support.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();

const ANTHROPIC_REPLY = json(200, {
  id: "m",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  model: "x",
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

void test("fast mode: OpenAI's GPT and o models on api.openai.com, a ChatGPT account's GPT, Claude Opus with fast mode", () => {
  const openai = provider("openai", {
    chat: "https://api.openai.com/v1",
    responses: "https://api.openai.com/v1",
  });
  assert.equal(fastMode(openai, "gpt-5.5", "responses"), "priority");
  assert.equal(fastMode(openai, "o4-mini", "chat"), "priority");
  assert.equal(fastMode(openai, "text-embedding-3", "chat"), undefined);
  const relay = provider("relay", { chat: "https://relay.example/v1" });
  assert.equal(fastMode(relay, "gpt-5.5", "chat"), undefined);
  assert.equal(canFast(relay, "gpt-5.5"), false);
  const anthropic = provider("anthropic", {
    anthropic: "https://api.anthropic.com",
  });
  assert.equal(fastMode(anthropic, "claude-opus-5", "anthropic"), "speed");
  assert.equal(
    fastMode(anthropic, "claude-opus-4-8-20260501", "anthropic"),
    "speed",
  );
  assert.equal(
    fastMode(anthropic, "claude-sonnet-4-6", "anthropic"),
    undefined,
  );
  assert.equal(canFast(anthropic, "claude-opus-5-5"), true);
  const account = provider(
    "chatgpt",
    { responses: "https://chatgpt.example/backend-api/codex" },
    { subscription: { backend: "siwc" } },
  );
  assert.equal(fastMode(account, "gpt-5.5-codex", "responses"), "priority");
  assert.equal(fastMode(account, "codex-mini", "responses"), undefined);
});

void test("a member's effort and fast mode in a passthrough body, the encoded body and the beta header", () => {
  const openai = provider("openai", {
    responses: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
  });
  const [responses] = modelCandidates(
    openai,
    "gpt-5.5",
    "responses",
  ).candidates;
  assert.ok(responses);
  const fixed: Candidate = { ...responses, effort: "xhigh", fast: true };
  assert.deepEqual(
    memberPassthrough(
      "responses",
      { model: "x", reasoning: { effort: "low", summary: "auto" } },
      fixed,
    ),
    {
      raw: {
        model: "x",
        reasoning: { effort: "xhigh", summary: "auto" },
        service_tier: "priority",
      },
      patches: ["member-effort:xhigh", "fast:service-tier"],
    },
  );
  assert.equal(
    memberPassthrough("responses", { model: "x" }, responses),
    undefined,
  );
  const [claude] = modelCandidates(
    openai,
    "claude-opus-5",
    "anthropic",
  ).candidates;
  const fast: Candidate = { ...claude!, fast: true };
  const body: Record<string, unknown> = {};
  assert.deepEqual(memberFast(body, fast), ["fast:speed"]);
  assert.equal(body.speed, "fast");
  const headers = new Headers({ "anthropic-beta": "context-1m-2025-08-07" });
  withFastBeta(headers, fast);
  assert.equal(
    headers.get("anthropic-beta"),
    `context-1m-2025-08-07,${CLAUDE_FAST_BETA}`,
  );
  // A member that is not fast adds nothing.
  const plain = new Headers();
  withFastBeta(plain, claude!);
  assert.equal(plain.get("anthropic-beta"), null);
});

void test("planning: groups inside keep together, loops and depth are cut, one model at one effort once, :fast where it can be", async () => {
  const providers = new Map<string, ProviderConfig>([
    ["a", provider("a", { chat: "http://a.invalid/v1" })],
    ["b", provider("b", { chat: "http://b.invalid/v1" })],
    [
      "openai",
      provider(
        "openai",
        { chat: "https://api.openai.com/v1" },
        {
          models: {
            source: "manual",
            list: [{ id: "gpt-5.5" }],
            expose: "all",
          },
        },
      ),
    ],
  ]);
  const groups = new Map<string, RouteGroup>([
    ["inner", group("inner", ["b/model-a", "a/model-a", "group/outer"])],
    [
      "outer",
      group("outer", [
        "a/model-a",
        "group/inner",
        "a/model-a:high",
        "openai/gpt-5.5:fast",
        "a/model-b:fast",
        "group/missing",
      ]),
    ],
  ]);
  const planning: GroupPlanning = {
    provider: async (id) => providers.get(id),
    group: async (id) => groups.get(id),
    order: (item) => item.members,
    weigh: async (_, list) => list,
    blocked: () => false,
  };
  const planned = await planGroup(groups.get("outer")!, "chat", planning);
  assert.deepEqual(
    planned.candidates.map((candidate) => [
      candidate.ref,
      candidate.effort ?? "",
      candidate.fast === true,
    ]),
    [
      ["a/model-a", "", false],
      ["b/model-a", "", false],
      ["a/model-a", "high", false],
      ["openai/gpt-5.5", "", true],
      ["a/model-b", "", false],
    ],
  );
  assert.deepEqual(planned.skipped, [
    "group/outer: the group is already on the way down",
    "a/model-b:fast: a/model-b has no fast mode on its chat endpoint; sent as it is",
    "group/missing: unknown group",
  ]);
  // A chain of nine groups: the ninth is past the limit.
  const chain = new Map<string, RouteGroup>(
    Array.from({ length: 10 }, (_, index): [string, RouteGroup] => [
      `g${index}`,
      group(`g${index}`, index === 9 ? ["b/model-a"] : [`group/g${index + 1}`]),
    ]),
  );
  const deep = await planGroup(chain.get("g0")!, "chat", {
    ...planning,
    group: async (id) => chain.get(id),
  });
  assert.deepEqual(deep.candidates, []);
  assert.deepEqual(deep.skipped, ["group/g9: groups nest at most 8 deep"]);
});

void test("through the gateway: a group inside a group fails over in order, and a smart group weighs the inner one as a unit", async (t) => {
  const a = await upstream(t, json(500, { error: { message: "down" } }));
  const b = await upstream(t, CHAT_REPLY);
  const c = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  await store.putProvider(
    provider("c", { chat: `${c.base}/v1` }, { secrets: ["key-a"] }),
  );
  await store.putRouteGroup(group("inner", ["b/model-a", "c/model-a"]));
  await store.putRouteGroup(group("outer", ["a/model-a", "group/inner"]));
  // b's restored reading (95% used) is low; a, without one, is fine.
  await store.putRouteGroup(
    group("smart", ["group/inner", "a/model-a"], { strategy: "smart" }),
  );
  const key = await addKey(store, ["group/outer", "group/smart"]);
  const gw = await mount(
    t,
    store,
    {},
    {
      allowances: {
        load: async () => [
          {
            provider: "b",
            credential: "cred-0",
            reading: {
              window: "requests",
              usedPercent: 95,
              resetsAt: iso(NOW + 3_600_000),
              observedAt: iso(NOW - 60_000),
            },
          },
        ],
        save: async () => {},
      },
    },
  );
  const call = (model: string) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model, messages: [{ role: "user", content: "hi" }] },
    });
  assert.equal((await call("group/outer")).status, 200);
  await until(() => store.entries.length === 1);
  assert.deepEqual(
    store.entries[0]!.attempts.map((attempt) => [
      attempt.provider,
      attempt.decision,
    ]),
    [
      ["a", "failover"],
      ["b", "success"],
    ],
  );
  // a is fine and goes first, the inner group (low by its head b) after
  // it; unweighed, b would have answered first.
  assert.equal((await call("group/smart")).status, 200);
  await until(() => store.entries.length === 2);
  assert.deepEqual(
    store.entries[1]!.attempts.map((attempt) => attempt.provider),
    ["a", "b"],
  );
});

void test("through the gateway: a member's effort reaches Chat and Responses as asked, and Anthropic translated", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const native = await upstream(t, ANTHROPIC_REPLY);
  const responses = await upstream(
    t,
    json(200, {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  const store = new MemoryStore();
  await store.putProvider(provider("p", { chat: `${up.base}/v1` }));
  await store.putProvider(
    provider("claude", { anthropic: native.base }, { secrets: ["key-b"] }),
  );
  await store.putProvider(
    provider(
      "r",
      { responses: `${responses.base}/v1` },
      { secrets: ["key-b"] },
    ),
  );
  await store.putRouteGroup(group("high", ["p/model-a:high"]));
  await store.putRouteGroup(group("think", ["claude/model-a:low"]));
  await store.putRouteGroup(group("brief", ["r/model-a:minimal"]));
  const key = await addKey(store, ["group/high", "group/think", "group/brief"]);
  const gw = await mount(t, store);
  const chat = await send(gw.port, "/v1/chat/completions", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "group/high",
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(chat.status, 200);
  assert.equal(up.seen[0]!.json().reasoning_effort, "high");
  assert.equal(up.seen[0]!.json().model, "model-a");
  await until(() => store.entries.length === 1);
  assert.equal(store.entries[0]!.mode, "passthrough");
  assert.ok(store.entries[0]!.patches.includes("member-effort:high"));
  // Anthropic in, Anthropic upstream: translated, so that the effort is set.
  const messages = await send(gw.port, "/v1/messages", {
    headers: { "x-api-key": key.text, "anthropic-version": "2023-06-01" },
    body: {
      model: "group/think",
      max_tokens: 32_000,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(messages.status, 200, messages.text);
  const sent = native.seen[0]!.json();
  assert.equal(at(sent, "thinking", "type"), "enabled");
  assert.equal(at(sent, "thinking", "budget_tokens"), 2_048, "low's budget");
  await until(() => store.entries.length === 2);
  assert.equal(store.entries[1]!.mode, "translated");
  assert.ok(store.entries[1]!.patches.includes("member-effort:low"));
  const brief = await send(gw.port, "/v1/responses", {
    headers: { authorization: `Bearer ${key.text}` },
    body: {
      model: "group/brief",
      reasoning: { effort: "high", summary: "auto" },
      input: "hi",
    },
  });
  assert.equal(brief.status, 200, brief.text);
  assert.deepEqual(responses.seen[0]!.json().reasoning, {
    effort: "minimal",
    summary: "auto",
  });
  await until(() => store.entries.length === 3);
  assert.equal(store.entries[2]!.mode, "passthrough");
});

void test("/v1/models: a group offers the smallest window of its models, groups inside included, and the levels they share", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(
    provider(
      "p",
      { chat: `${up.base}/v1` },
      {
        models: {
          source: "manual",
          list: [
            {
              id: "big",
              contextWindow: 1_000_000,
              maxOutputTokens: 64_000,
              reasoning: true,
              inputModalities: ["text", "image"],
            },
            {
              id: "small",
              contextWindow: 200_000,
              maxOutputTokens: 8_192,
              reasoning: true,
              inputModalities: ["text"],
            },
            { id: "plain", contextWindow: 100_000, reasoning: false },
          ],
          expose: "all",
        },
      },
    ),
  );
  await store.putRouteGroup(group("inner", ["p/small"]));
  await store.putRouteGroup(group("outer", ["p/big", "group/inner"]));
  await store.putRouteGroup(group("fixed", ["p/big:max", "p/plain:minimal"]));
  const key = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const listed = await send(gw.port, "/v1/models", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  const models = new Map(
    (at(listed.json(), "data") as { id: string }[]).map((item) => [
      item.id,
      item as Record<string, unknown>,
    ]),
  );
  const outer = models.get("group/outer")!;
  assert.equal(outer.context_window, 200_000);
  assert.equal(outer.max_output_tokens, 8_192);
  assert.equal(outer.reasoning, true);
  assert.deepEqual(outer.supported_reasoning_levels, ["low", "medium", "high"]);
  assert.deepEqual(outer.input_modalities, ["text"]);
  const fixed = models.get("group/fixed")!;
  assert.deepEqual(fixed.supported_reasoning_levels, ["minimal", "max"]);
  assert.deepEqual(models.get("p/big")!.supported_reasoning_levels, [
    "low",
    "medium",
    "high",
  ]);
  assert.equal(models.get("p/plain")!.supported_reasoning_levels, undefined);
});
