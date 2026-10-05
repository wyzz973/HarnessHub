// SPDX-License-Identifier: MIT
/**
 * A wired agent's model in place of one nothing here serves (Magpie's
 * `StandIn`): Claude Code's tier models for its built-in Claude IDs, its
 * main model otherwise, Codex's model; never for a name that resolves, a
 * group, a key other than the wiring's own, or Codex in ChatGPT mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayKeyId, WiringRecord } from "@harnesshub/core/model-plane";
import { standIn } from "../src/stand-in.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

const STAMP = "2026-10-05T00:00:00.000Z";

function wiring(
  adapterId: string,
  choice: Partial<WiringRecord>,
  keyId?: GatewayKeyId,
): WiringRecord {
  return {
    adapterId,
    ...(keyId ? { keyId } : {}),
    files: [],
    wiredAt: STAMP,
    ...choice,
  };
}

void test("Claude Code's tier IDs go to their tiers, other names to its main model; Codex's to its model", () => {
  const claude = wiring("claude", {
    model: "fake/big",
    tiers: { haiku: "fake/small", opus: "fake/deep" },
  });
  for (const [asked, model] of [
    ["claude-haiku-4-5-20251001", "fake/small"],
    ["claude-3-5-haiku-latest", "fake/small"],
    ["claude-opus-4-1", "fake/deep"],
    // No sonnet tier: the main model, as Claude Code's tiers follow it.
    ["claude-sonnet-4-6", "fake/big"],
    ["claude-fable-5-1[1m]", "fake/big"],
    ["something-else", "fake/big"],
  ] as const)
    assert.equal(standIn(claude, asked), model, asked);
  // Its own main model by name is its pick, not a tier's; the same name is none.
  assert.equal(
    standIn(
      wiring("claude", {
        model: "x/haiku-tuned",
        tiers: { haiku: "fake/small" },
      }),
      "x/haiku-tuned[1m]",
    ),
    "x/haiku-tuned",
  );
  assert.equal(standIn(claude, "fake/big"), undefined);
  assert.equal(
    standIn(wiring("claude", {}), "claude-haiku-4-5"),
    undefined,
    "no model, no stand-in",
  );
  assert.equal(
    standIn(wiring("codex", { model: "fake/big" }), "gpt-5-codex"),
    "fake/big",
  );
  assert.equal(
    standIn(
      wiring("codex", { model: "fake/big", options: { codexAuth: "chatgpt" } }),
      "gpt-5-codex",
    ),
    undefined,
    "Codex in ChatGPT mode sends its own models to ChatGPT",
  );
  assert.equal(
    standIn(wiring("opencode", { model: "fake/big" }), "gpt-5"),
    undefined,
    "only Claude Code and Codex, as in Magpie",
  );
});

void test("through the gateway: a stand-in only for the wiring's own key and a name nothing serves, recorded as stand-in", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("fake", { chat: `${up.base}/v1` }));
  // A provider that does list one of Claude's IDs.
  await store.putProvider(
    provider(
      "anthropicish",
      { chat: `${up.base}/v1` },
      {
        models: {
          source: "manual",
          list: [{ id: "claude-opus-4-1" }],
          expose: "all",
        },
      },
    ),
  );
  const agent = await addKey(store, ["*"], {
    scope: { kind: "agent", adapterId: "claude" },
  });
  await store.putWiring(
    wiring(
      "claude",
      { model: "fake/model-a", tiers: { haiku: "fake/model-b" } },
      agent.keyId,
    ),
  );
  const client = await addKey(store, ["*"]);
  const gw = await mount(t, store);
  const ask = (model: string, key = agent.text) =>
    send(gw.port, "/v1/messages", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: {
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      },
    });

  assert.equal((await ask("claude-haiku-4-5-20251001")).status, 200);
  let entry = store.entries.at(-1)!;
  assert.equal(entry.requestedModel, "claude-haiku-4-5-20251001");
  assert.equal(entry.modelRef, "fake/model-b");
  assert.ok(entry.patches.includes("stand-in"), JSON.stringify(entry.patches));
  assert.equal(up.seen.at(-1)!.json().model, "model-b");

  // A Model Ref of a provider that is not here serves nothing either.
  assert.equal((await ask("anthropic/claude-sonnet-4-6")).status, 200);
  assert.equal(store.entries.at(-1)!.modelRef, "fake/model-a");

  // A name that resolves is served as it is.
  assert.equal((await ask("claude-opus-4-1")).status, 200);
  entry = store.entries.at(-1)!;
  assert.equal(entry.modelRef, "anthropicish/claude-opus-4-1");
  assert.ok(!entry.patches.includes("stand-in"));

  // Another key, or an agent key the wiring did not write, gets no stand-in.
  const other = await ask("claude-haiku-4-5-20251001", client.text);
  assert.equal(other.status, 404);
  assert.match(
    String(at(other.json(), "error", "message")),
    /No route group or model is named claude-haiku-4-5-20251001/,
  );
  const stale = await addKey(store, ["*"], {
    scope: { kind: "agent", adapterId: "claude" },
  });
  assert.equal(
    (await ask("claude-haiku-4-5-20251001", stale.text)).status,
    404,
  );
});
