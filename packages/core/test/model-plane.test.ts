// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayKeyMatches,
  issueGatewayKey,
  claudeModelAlias,
  isModelPattern,
  modelAllowed,
  parseGatewayKey,
  parseModelRef,
  type GatewayKeyRecord,
} from "../src/model-plane.js";

void test("an issued Gateway Key parses back to its scope and id and matches only its own secret", () => {
  const issued = issueGatewayKey({ kind: "agent", adapterId: "codex" });
  assert.match(issued.text, /^hhk_a_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
  const parsed = parseGatewayKey(issued.text);
  assert.ok(parsed);
  assert.equal(parsed.scope, "agent");
  assert.equal(parsed.keyId, issued.keyId);
  const record = {
    keyId: issued.keyId,
    name: "codex",
    scope: { kind: "agent", adapterId: "codex" },
    modelAllow: [],
    secretHash: issued.secretHash,
    createdAt: "2026-10-02T00:00:00.000Z",
  } satisfies GatewayKeyRecord;
  assert.equal(gatewayKeyMatches(record, parsed.secret), true);
  const other = parseGatewayKey(
    issueGatewayKey({ kind: "client", name: "x" }).text,
  );
  assert.ok(other);
  assert.equal(gatewayKeyMatches(record, other.secret), false);
});

void test("malformed Gateway Keys are rejected", () => {
  for (const text of [
    "",
    "sk-abc",
    "hhk_x_abcdefghijkl_" + "A".repeat(43),
    "hhk_a_ABCDEFGHIJKL_" + "A".repeat(43),
    "hhk_a_abcdefghijkl_" + "A".repeat(42),
    "hhk_a_abcdefghijkl_" + "A".repeat(43) + "=",
  ])
    assert.equal(parseGatewayKey(text), undefined, text);
});

void test("Model Refs split at the first slash; groups and invalid forms are recognized", () => {
  assert.deepEqual(parseModelRef("openrouter/deepseek/deepseek-chat"), {
    kind: "model",
    ref: "openrouter/deepseek/deepseek-chat",
    provider: "openrouter",
    model: "deepseek/deepseek-chat",
  });
  assert.deepEqual(parseModelRef("group/fast"), {
    kind: "group",
    group: "fast",
  });
  for (const text of [
    "deepseek",
    "/x",
    "x/",
    "Upper/x",
    "group/Bad",
    "p/has space",
  ])
    assert.equal(parseModelRef(text), undefined, text);
});

void test("model allowlists admit exact refs, provider wildcards and named groups only", () => {
  const allow = ["deepseek/*", "openai/gpt-5", "group/fast"];
  assert.equal(modelAllowed(allow, "deepseek/deepseek-chat"), true);
  assert.equal(modelAllowed(allow, "openai/gpt-5"), true);
  assert.equal(modelAllowed(allow, "openai/gpt-5-mini"), false);
  assert.equal(modelAllowed(allow, "group/fast"), true);
  assert.equal(modelAllowed(allow, "group/slow"), false);
  assert.equal(modelAllowed([], "deepseek/deepseek-chat"), false);
  assert.equal(modelAllowed(allow, "not-a-ref"), false);
});

void test("* admits every model and group, and a deny list takes back what the allowlist admits", () => {
  assert.equal(modelAllowed(["*"], "deepseek/deepseek-chat"), true);
  assert.equal(modelAllowed(["*"], "group/fast"), true);
  assert.equal(modelAllowed(["*"], "not-a-ref"), false);
  const deny = ["openai/*", "group/slow", "deepseek/deepseek-reasoner"];
  assert.equal(modelAllowed(["*"], "openai/gpt-5", deny), false);
  assert.equal(modelAllowed(["*"], "group/slow", deny), false);
  assert.equal(modelAllowed(["*"], "group/fast", deny), true);
  assert.equal(modelAllowed(["*"], "deepseek/deepseek-reasoner", deny), false);
  assert.equal(modelAllowed(["*"], "deepseek/deepseek-chat", deny), true);
  assert.equal(modelAllowed(["deepseek/*"], "deepseek/x", ["*"]), false);
  for (const entry of ["*", "a/b", "a/*", "group/x"])
    assert.equal(isModelPattern(entry), true, entry);
  for (const entry of ["", "**", "a", "group/Bad"])
    assert.equal(isModelPattern(entry), false, entry);
});

void test("a Claude-style alias is stable per Model Ref, says claude and names no other vendor", () => {
  const alias = claudeModelAlias("deepseek/deepseek-chat");
  assert.match(alias, /^claude-hh-\d{10}$/);
  assert.equal(claudeModelAlias("deepseek/deepseek-chat"), alias);
  assert.notEqual(claudeModelAlias("deepseek/deepseek-reasoner"), alias);
});
