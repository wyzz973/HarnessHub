// SPDX-License-Identifier: MIT
/** Automatic groups through the gateway, and the conversation and agent of each entry. */
import test from "node:test";
import assert from "node:assert/strict";
import type { RouteGroupId } from "@harnesshub/core/model-plane";
import { isModelCallEntry } from "@harnesshub/core/model-plane-records";
import { agentOf } from "../src/agents.js";
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
  upstream,
} from "./shared-support.js";

const MESSAGES = [{ role: "user", content: "hi" }];

void test("an automatic group is listed for keys that allow it and routes over its members in order", async (t) => {
  const a = await upstream(t, json(503, { error: { message: "busy" } }));
  const b = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  // Both providers list model-a and model-b: group/auto-model-a and group/auto-model-b.
  await store.putProvider(provider("a", { chat: `${a.base}/v1` }));
  await store.putProvider(
    provider("b", { chat: `${b.base}/v1` }, { secrets: ["key-b"] }),
  );
  const key = await addKey(store, ["group/auto-model-a"]);
  const gw = await mount(t, store);
  const listed = async () =>
    (
      (await send(gw.port, "/v1/models", {
        headers: { authorization: `Bearer ${key.text}` },
      }).then((answer) => answer.json().data)) as { id: string }[]
    ).map((model) => model.id);
  const call = () =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}` },
      body: { model: "group/auto-model-a", messages: MESSAGES },
    });
  assert.deepEqual(await listed(), ["group/auto-model-a"]);
  const model = await send(gw.port, "/v1/models/group/auto-model-a", {
    headers: { authorization: `Bearer ${key.text}` },
  });
  assert.equal(at(model.json(), "context_window"), 128_000);
  assert.equal((await call()).status, 200);
  const entry = store.entries[0]!;
  assert.equal(entry.group, "auto-model-a");
  assert.deepEqual(
    entry.attempts.map((attempt) => [attempt.provider, attempt.decision]),
    [
      ["a", "failover"],
      ["b", "success"],
    ],
  );
  // Hidden: neither listed nor routed.
  await store.setAutoGroupHidden("auto-model-a" as RouteGroupId, true);
  assert.deepEqual(await listed(), []);
  const hidden = await call();
  assert.equal(hidden.status, 404);
  assert.equal(at(hidden.json(), "error", "code"), "model_not_found");
  await store.setAutoGroupHidden("auto-model-a" as RouteGroupId, false);
  assert.deepEqual(await listed(), ["group/auto-model-a"]);
  // A user group of the same ID takes its place.
  await store.putRouteGroup(group("auto-model-a", ["b/model-a"]));
  const seen = a.seen.length;
  assert.equal((await call()).status, 200);
  assert.equal(a.seen.length, seen, "only the user group's member");
  assert.equal(b.seen.length, 2);
});

void test("the agent is the key's adapter, else one known by its User-Agent", () => {
  assert.deepEqual(
    agentOf({ kind: "agent", adapterId: "codex" }, "claude-cli/1.0.0"),
    { id: "codex", source: "key" },
  );
  const inferred: [string, string | undefined][] = [
    ["claude-cli/1.0.83 (external, cli)", "claude"],
    ["codex_cli_rs/0.150.0 (Mac OS 15.6.1; arm64) Apple_Terminal", "codex"],
    ["codex_exec/0.150.0", "codex"],
    ["GeminiCLI/0.9.0 (darwin; arm64)", "gemini"],
    ["QwenCode/0.0.14 (darwin; arm64)", "qwen"],
    ["KimiCLI/0.40", "kimi"],
    ["opencode/0.15.0", "opencode"],
    ["crush/0.10", "crush"],
    ["curl/8.7.1", undefined],
    ["OpenAI/JS 5.0.0", undefined],
    ["", undefined],
  ];
  for (const [userAgent, id] of inferred)
    assert.deepEqual(
      agentOf({ kind: "client", name: "x" }, userAgent),
      id === undefined ? undefined : { id, source: "user-agent" },
      userAgent,
    );
  assert.equal(agentOf(undefined, undefined), undefined);
});

void test("entries carry the hashed conversation key and the agent", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  const wired = await addKey(store, ["a/*"], {
    scope: { kind: "agent", adapterId: "opencode" },
  });
  const client = await addKey(store, ["a/*"]);
  const gw = await mount(t, store);
  const call = (
    key: { text: string },
    userAgent: string,
    conversation: string,
    model = "a/model-a",
  ) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key.text}`, "user-agent": userAgent },
      body: { model, messages: MESSAGES, prompt_cache_key: conversation },
    });
  assert.equal((await call(wired, "claude-cli/1.0", "conv-1")).status, 200);
  assert.equal((await call(client, "claude-cli/1.0", "conv-1")).status, 200);
  assert.equal((await call(client, "claude-cli/1.0", "conv-1")).status, 200);
  assert.equal((await call(client, "curl/8", "conv-2")).status, 200);
  assert.equal(
    (await call(client, "GeminiCLI/0.9 (darwin)", "conv-3", "b/model-a"))
      .status,
    403,
  );
  const entries = store.entries;
  assert.deepEqual(
    entries.map((entry) => entry.agent),
    [
      { id: "opencode", source: "key" },
      { id: "claude", source: "user-agent" },
      { id: "claude", source: "user-agent" },
      undefined,
      { id: "gemini", source: "user-agent" },
    ],
  );
  const keys = entries.map((entry) => entry.conversationKey);
  for (const value of keys.slice(0, 4)) assert.match(value!, /^[0-9a-f]{64}$/);
  assert.equal(keys[1], keys[2], "one conversation");
  assert.notEqual(keys[0], keys[1], "conversations are scoped per Gateway Key");
  assert.notEqual(keys[2], keys[3]);
  assert.equal(keys[4], undefined, "a rejected call has no conversation");
  assert.ok(!JSON.stringify(entries).includes("conv-1"));
  for (const entry of entries) assert.ok(isModelCallEntry(entry));
});
