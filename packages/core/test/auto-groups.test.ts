// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  autoGroups,
  autoRouteGroup,
  sameModel,
  slug,
} from "../src/auto-groups.js";
import type {
  CredentialId,
  ProviderConfig,
  ProviderId,
} from "../src/model-plane.js";

function provider(
  id: string,
  models: string[],
  options: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    schemaVersion: 1,
    id: id as ProviderId,
    name: id,
    kind: "custom",
    endpoints: { chat: "https://example.invalid/v1" },
    auth: { apiKeyHeader: "authorization-bearer" },
    credentials: [
      {
        id: "key-1" as CredentialId,
        name: "key",
        ref: { kind: "env", value: "SYNTHETIC" },
        enabled: true,
      },
    ],
    models: {
      source: "manual",
      list: models.map((model) => ({ id: model })),
      expose: "all",
    },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...options,
  };
}

void test("sameModel spells a model the way vendors agree on it", () => {
  const cases: [string, string][] = [
    ["anthropic/claude-sonnet-5", "claude-sonnet-5"],
    ["accounts/fireworks/models/llama-v3p1-8b", "llama-v3-1-8b"],
    ["claude-opus-5.5", "claude-opus-5-5"],
    ["deepseek-v4p1", "deepseek-v4-1"],
    ["Claude_Opus_5_5", "claude-opus-5-5"],
    ["claude-opus-5-5-20260801", "claude-opus-5-5"],
    ["gemini-3-pro@20260801", "gemini-3-pro"],
    ["deepseek-v4-1-flash-260910", "deepseek-v4-1-flash"],
    // Kept: a variant, a four-digit release, a six-digit tail that is no date.
    ["gpt-4o:free", "gpt-4o:free"],
    ["qwen3-coder-2507", "qwen3-coder-2507"],
    ["kimi-k2-0905", "kimi-k2-0905"],
    ["model-991231", "model-991231"],
    ["model-261341", "model-261341"],
    ["  GLM-4.6  ", "glm-4-6"],
    ["gpt-5", "gpt-5"],
  ];
  for (const [id, expected] of cases) assert.equal(sameModel(id), expected, id);
});

void test("slug keeps lowercase letters and digits with single dashes", () => {
  assert.equal(slug("My Relay"), "my-relay");
  assert.equal(slug("gpt-4o:free"), "gpt-4o-free");
  assert.equal(slug("--Odd__Name--"), "odd-name");
  assert.equal(slug("模型"), "");
});

void test("a model two ready providers serve under one name becomes group/auto-<slug>", () => {
  const providers = [
    provider("second", ["claude-opus-5.5", "only-here"], {
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    provider("first", ["claude-opus-5-5-20260801", "claude-opus-5-5"]),
    provider("third", ["anthropic/claude-opus-5-5"], {
      createdAt: "2026-10-03T00:00:00.000Z",
    }),
    // Not ready: its only credential is off.
    provider("off", ["claude-opus-5-5"], {
      credentials: [
        {
          id: "key-1" as CredentialId,
          name: "key",
          ref: { kind: "env", value: "SYNTHETIC" },
          enabled: false,
        },
      ],
    }),
    // Not ready either: switched off, though its credential is on.
    provider("switched-off", ["claude-opus-5-5"], { enabled: false }),
    // Keyless (a local server) is ready; an unexposed model does not count.
    provider("local", ["claude-opus-5.5", "only-here"], {
      credentials: [],
      createdAt: "2026-10-04T00:00:00.000Z",
      models: {
        source: "manual",
        list: [{ id: "claude-opus-5.5" }, { id: "only-here" }],
        expose: ["claude-opus-5.5"],
      },
    }),
  ];
  const groups = autoGroups(providers);
  assert.deepEqual(groups, [
    {
      id: "auto-claude-opus-5-5",
      model: "claude-opus-5-5",
      // Providers in the order they were added; each provider's first model.
      members: [
        "first/claude-opus-5-5-20260801",
        "second/claude-opus-5.5",
        "third/anthropic/claude-opus-5-5",
        "local/claude-opus-5.5",
      ],
      hidden: false,
      createdAt: "2026-10-04T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    autoGroups(providers, { hidden: ["auto-claude-opus-5-5"] }).map((group) => [
      group.id,
      group.hidden,
    ]),
    [["auto-claude-opus-5-5", true]],
  );
  assert.deepEqual(
    autoGroups(providers, { taken: ["auto-claude-opus-5-5"] }),
    [],
    "a user group of the same ID takes its place",
  );
  assert.deepEqual(autoRouteGroup(groups[0]!), {
    id: "auto-claude-opus-5-5",
    strategy: "order",
    stickiness: "auto",
    members: groups[0]!.members,
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  });
});

void test("an automatic group's ID is cut to fit, and names without a slug make none", () => {
  const long = `m${"x".repeat(80)}`;
  const groups = autoGroups([
    provider("a", [long, "模型"]),
    provider("b", [long, "模型"]),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.id.length, 63);
  assert.ok(groups[0]!.id.startsWith("auto-mxxx"));
  assert.deepEqual(autoGroups([provider("a", ["m"])]), []);
});
