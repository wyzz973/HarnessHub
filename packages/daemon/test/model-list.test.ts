// SPDX-License-Identifier: MIT
/** Lists read per credential, merged (Magpie `fetchPerKey`), and where each credential is asked. */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CredentialId,
  ProviderConfig,
  ProviderModels,
} from "@harnesshub/core/model-plane";
import {
  credentialListing,
  mergeCredentialLists,
} from "../src/http/model-list.js";

const a = "cred-a" as CredentialId;
const b = "cred-b" as CredentialId;
const c = "cred-c" as CredentialId;

void test("lists read per credential mark the credentials that list each model, all of them by leaving it unmarked", () => {
  const empty: ProviderModels = { source: "manual", list: [], expose: "all" };
  const merged = mergeCredentialLists(empty, [
    {
      credential: a,
      models: [{ id: "shared", contextWindow: 1000 }, { id: "a-only" }],
    },
    {
      credential: b,
      models: [{ id: "shared", contextWindow: 2000 }, { id: "b-only" }],
    },
  ]);
  assert.deepEqual(merged.listedFor, [a, b]);
  assert.deepEqual(merged.list, [
    { id: "shared" },
    { id: "a-only", credentials: [a] },
    { id: "b-only", credentials: [b] },
  ]);
  // The first list's metadata is the model's.
  assert.equal(merged.fresh.get("shared")?.contextWindow, 1000);
});

void test("a credential whose list cannot be read now keeps the models it listed last time; one never read is not known", () => {
  const previous: ProviderModels = {
    source: "live",
    expose: "all",
    listedFor: [a, b],
    list: [{ id: "shared" }, { id: "b-only", credentials: [b] }],
  };
  const merged = mergeCredentialLists(previous, [
    { credential: a, models: [{ id: "shared" }, { id: "new-a" }] },
    { credential: b },
    { credential: c },
  ]);
  assert.deepEqual(merged.listedFor, [a, b]);
  assert.deepEqual(merged.list, [
    { id: "shared" },
    { id: "new-a", credentials: [a] },
    { id: "b-only", credentials: [b] },
  ]);
  assert.deepEqual([...merged.fresh.keys()], ["shared", "new-a"]);
});

void test("a credential is asked at the first list endpoint it may use", () => {
  const provider = {
    endpoints: {
      chat: "https://p.example/v1",
      anthropic: "https://p.example/anthropic",
    },
  } as unknown as ProviderConfig;
  const credential = (
    protocols?: ProviderConfig["credentials"][number]["protocols"],
  ) =>
    ({
      id: a,
      name: "a",
      ref: { kind: "env", value: "A" },
      enabled: true,
      ...(protocols ? { protocols } : {}),
    }) as ProviderConfig["credentials"][number];
  assert.equal(credentialListing(provider, credential()), "chat");
  assert.equal(
    credentialListing(provider, credential(["anthropic"])),
    "anthropic",
  );
  assert.equal(credentialListing(provider, credential(["gemini"])), undefined);
});
