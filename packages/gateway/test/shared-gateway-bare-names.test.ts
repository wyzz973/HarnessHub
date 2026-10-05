// SPDX-License-Identifier: MIT
/**
 * Models asked for by a bare name (no `provider/` or `group/`), resolved in
 * Magpie's order: the route group of that ID, the group of the name as
 * vendors spell it, its automatic group, the one model of that ID the
 * providers expose, the one a provider lists. Several models refuse with
 * their names. Only what the key may use counts: a name of something else
 * answers as an unknown one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderId, RouteGroupId } from "@harnesshub/core/model-plane";
import { resolveBareName } from "../src/bare-names.js";
import {
  addKey,
  at,
  CHAT_REPLY,
  group,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

void test("a bare name resolves to a group of its ID, then its spelling, then its automatic group, then the one model that has it", async () => {
  const store = new MemoryStore();
  // a and b both list model-a and model-b: their automatic groups exist.
  await store.putProvider(provider("a", { chat: "https://a.invalid/v1" }));
  await store.putProvider(provider("b", { chat: "https://b.invalid/v1" }));
  await store.putProvider(
    provider(
      "c",
      { chat: "https://c.invalid/v1" },
      {
        models: {
          source: "manual",
          list: [{ id: "solo" }, { id: "kept-back" }],
          expose: ["solo"],
        },
      },
    ),
  );
  const resolve = (name: string, usable = (_ref: string) => true) =>
    resolveBareName(name, store, async (ref) => usable(ref));
  assert.deepEqual(await resolve("model-a"), {
    kind: "resolved",
    ref: "group/auto-model-a",
    via: "auto-group",
  });
  // However a vendor spells it: case, `_`, a version's `.`, a snapshot date.
  for (const spelt of ["MODEL_A", "Model-A-20260101"])
    assert.deepEqual(await resolve(spelt), {
      kind: "resolved",
      ref: "group/auto-model-a",
      via: "auto-group",
    });
  // A user group of the spelt name comes first, and one of the exact ID before it.
  await store.putRouteGroup(group("model-a", ["b/model-a"]));
  assert.deepEqual(await resolve("Model_A"), {
    kind: "resolved",
    ref: "group/model-a",
    via: "group",
  });
  await store.putRouteGroup(group("fast", ["a/model-b"]));
  assert.deepEqual(await resolve("FAST"), {
    kind: "resolved",
    ref: "group/fast",
    via: "group",
  });
  // An automatic group asked for by its own ID.
  assert.deepEqual(await resolve("auto-model-b"), {
    kind: "resolved",
    ref: "group/auto-model-b",
    via: "auto-group",
  });
  // The one model of that ID exposed, else listed.
  assert.deepEqual(await resolve("solo"), {
    kind: "resolved",
    ref: "c/solo",
    via: "model",
  });
  assert.deepEqual(await resolve("kept-back"), {
    kind: "resolved",
    ref: "c/kept-back",
    via: "model",
  });
  // A hidden automatic group leaves two models of the name: none is picked.
  await store.setAutoGroupHidden("auto-model-b" as RouteGroupId, true);
  assert.deepEqual(await resolve("model-b"), {
    kind: "ambiguous",
    refs: ["a/model-b", "b/model-b"],
  });
  for (const name of ["nothing", "", "  ", "a b"])
    assert.deepEqual(await resolve(name), { kind: "none" }, name);
  // Only what the key may use: the next step of the order, or nothing.
  const onlyB = (ref: string) => ref.startsWith("b/");
  assert.deepEqual(await resolve("model-b", onlyB), {
    kind: "resolved",
    ref: "b/model-b",
    via: "model",
  });
  assert.deepEqual(await resolve("model-a", onlyB), {
    kind: "resolved",
    ref: "b/model-a",
    via: "model",
  });
  assert.deepEqual(await resolve("solo", onlyB), { kind: "none" });
  // A provider switched off names nothing: b alone has model-b.
  const off = async (id: string) =>
    store.putProvider({
      ...(await store.getProvider(id as ProviderId))!,
      enabled: false,
    });
  await off("a");
  assert.deepEqual(await resolve("model-b"), {
    kind: "resolved",
    ref: "b/model-b",
    via: "model",
  });
  assert.deepEqual((await resolve("solo")).kind, "resolved");
  await off("c");
  assert.deepEqual(await resolve("solo"), { kind: "none" });
});

void test("through the gateway: the resolved group or model serves, the ledger keeps the name, ambiguity and the allowlist refuse", async (t) => {
  const up = await upstream(t, CHAT_REPLY);
  const store = new MemoryStore();
  await store.putProvider(provider("a", { chat: `${up.base}/v1` }));
  await store.putProvider(provider("b", { chat: `${up.base}/v1` }));
  await store.putProvider(
    provider(
      "c",
      { chat: `${up.base}/v1` },
      {
        models: { source: "manual", list: [{ id: "solo" }], expose: "all" },
      },
    ),
  );
  await store.setAutoGroupHidden("auto-model-b" as RouteGroupId, true);
  const every = await addKey(store, ["*"]);
  const onlyA = await addKey(store, ["a/*", "group/auto-model-a"]);
  const gw = await mount(t, store);
  const call = (model: string, key = every.text) =>
    send(gw.port, "/v1/chat/completions", {
      headers: { authorization: `Bearer ${key}` },
      body: { model, messages: [{ role: "user", content: "hi" }] },
    });

  assert.equal((await call("model-a")).status, 200);
  let entry = store.entries.at(-1)!;
  assert.equal(entry.requestedModel, "model-a");
  assert.equal(entry.group, "auto-model-a");
  assert.equal((await call("solo")).status, 200);
  entry = store.entries.at(-1)!;
  assert.equal(entry.requestedModel, "solo");
  assert.equal(entry.modelRef, "c/solo");
  assert.equal(up.seen.at(-1)!.json().model, "solo");

  // Two models of the name: refused, naming those the key may use.
  const both = await call("model-b");
  assert.equal(both.status, 400);
  assert.equal(at(both.json(), "error", "code"), "model_ambiguous");
  assert.match(
    String(at(both.json(), "error", "message")),
    /model-b names more than one model: a\/model-b, b\/model-b; name one as provider\/model/,
  );
  // For a key that may use one of them, the name names that one.
  assert.equal((await call("model-b", onlyA.text)).status, 200);
  assert.equal(store.entries.at(-1)!.modelRef, "a/model-b");

  // Resolving does not widen a key's access, and a name of what the key may
  // not use answers as an unknown name: nothing about what is here (L6).
  const unknownTo = await call("solo", onlyA.text);
  const nothing = await call("nothing-there", onlyA.text);
  assert.deepEqual(
    [unknownTo.status, nothing.status, at(unknownTo.json(), "error", "code")],
    [404, 404, "model_not_found"],
  );
  assert.equal(
    String(at(unknownTo.json(), "error", "message")).replace("solo", "X"),
    String(at(nothing.json(), "error", "message")).replace(
      "nothing-there",
      "X",
    ),
  );
  // What the key does allow resolves and serves.
  assert.equal((await call("model-a", onlyA.text)).status, 200);

  const unknown = await call("nothing-here");
  assert.equal(unknown.status, 404);
  assert.equal(at(unknown.json(), "error", "code"), "model_not_found");
  assert.match(
    String(at(unknown.json(), "error", "message")),
    /No route group or model is named nothing-here/,
  );
});
