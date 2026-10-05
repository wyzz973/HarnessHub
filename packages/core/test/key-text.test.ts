// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { keylessPath, redactKeyText } from "../src/key-text.js";
import { issueGatewayKey } from "../src/model-plane.js";

const key = issueGatewayKey({ kind: "agent", adapterId: "fx" }).text;

void test("Gateway Key text is redacted in every form that gives the key away", () => {
  for (const form of [
    key,
    key.slice(0, -1),
    key.toUpperCase(),
    `${key}%20`,
    key.replace("hhk_", "hhk%5F"),
    key.replace("hhk_", "HHK%5f"),
    "hhk_a_garbage",
    // Without its prefix a key still holds its secret.
    key.slice("hhk_".length),
    key.slice("hhk_".length).toUpperCase(),
  ]) {
    const redacted = redactKeyText(`before ${form} after`);
    assert.equal(redacted, "before [REDACTED] after", form);
  }
  // In a log line as JSON, the line stays JSON.
  const line = JSON.stringify({ path: `/K/${key}/v1/models` });
  assert.deepEqual(JSON.parse(redactKeyText(line)), {
    path: "/K/[REDACTED]/v1/models",
  });
  // Text without a key is unchanged.
  for (const plain of [
    "",
    "hhk",
    "hh_k",
    "/v1/models",
    "shhk-1",
    // Model names that look a little like the form without a prefix.
    "gpt-4o-mini_2024-07-18",
    "a_model_name",
    "ca_abcdefghijkl_rest",
    "fake/c_abcdefgh",
  ])
    assert.equal(redactKeyText(plain), plain);
});

void test("a path loses key text and whatever follows a /k/", () => {
  for (const [path, expected] of [
    [`/k/${key}/v1/models`, "/k/[REDACTED]/v1/models"],
    [`/K/${key}/v1/models`, "/K/[REDACTED]/v1/models"],
    [`/%6b/${key}/v1/models`, "/%6b/[REDACTED]/v1/models"],
    ["/k/not-a-key/v1/models", "/k/[REDACTED]/v1/models"],
    ["/v1beta/k/anything", "/v1beta/k/[REDACTED]"],
    [
      `/backend-api/codex/${key}/responses`,
      "/backend-api/codex/[REDACTED]/responses",
    ],
    ["/v1/chat/completions", "/v1/chat/completions"],
    ["/api/v1/keys/kx", "/api/v1/keys/kx"],
    ["/k", "/k"],
  ] as const)
    assert.equal(keylessPath(path), expected, path);
});
