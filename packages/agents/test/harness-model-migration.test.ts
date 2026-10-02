// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activeHarnessModel,
  HarnessModelService,
  migratedProvider,
  writeHarnessModelFile,
} from "../src/application/harness-model.js";
import { builtinConfigurationAdapter } from "../src/engine/builtins.js";
import { normalizeEngine } from "../src/engine/registry.js";
import type { HarnessModel } from "@harnesshub/core/harness-model";
import type { LogFields, LogSink } from "@harnesshub/core/logging";
import type {
  ModelPlaneStore,
  ProviderConfig,
  RouteGroup,
} from "@harnesshub/core/model-plane";

const unified: HarnessModel = {
  model: "GLM-V5_1-DX",
  provider: {
    protocol: "openai-completions",
    baseUrl: "http://aigateway.example/v1",
    apiKey: { kind: "keychain", value: "harnesshub/upstream" },
    headers: { "X-Tenant": "contest" },
    contextWindow: 131072,
    maxOutputTokens: 16384,
    compatibility: {
      includeUsage: true,
      maxTokensField: "max_completion_tokens",
      dropParameters: ["prompt_cache_key"],
      images: "passthrough",
    },
  },
};

void test("the unified model maps to a translate-only provider with the legacy normalization as patches", () => {
  const provider = migratedProvider(
    activeHarnessModel({ file: unified })!,
    "2026-10-03T00:00:00.000Z",
  );
  assert.ok(!("unsupported" in provider));
  assert.deepEqual(provider.endpoints, { chat: "http://aigateway.example/v1" });
  assert.deepEqual(provider.credentials, [
    {
      id: "migrated",
      name: "migrated",
      ref: { kind: "keychain", value: "harnesshub/upstream" },
      enabled: true,
    },
  ]);
  assert.deepEqual(provider.headers, { "X-Tenant": "contest" });
  assert.deepEqual(provider.models.list, [
    {
      id: "default",
      wire: "GLM-V5_1-DX",
      contextWindow: 131072,
      maxOutputTokens: 16384,
      inputModalities: ["text", "image"],
    },
  ]);
  assert.equal(provider.translateOnly, true);
  assert.deepEqual(provider.patches, {
    chat: {
      patches: [
        "developer-to-system",
        "json-schema-to-json-object",
        "drop-fields",
        "max-tokens-field",
        "include-usage",
      ],
      dropFields: [
        "store",
        "metadata",
        "service_tier",
        "user",
        "parallel_tool_calls",
        "prompt_cache_key",
      ],
    },
  });
  const keyless = migratedProvider(
    activeHarnessModel({
      file: {
        model: "m",
        provider: {
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      },
    })!,
    "2026-10-03T00:00:00.000Z",
  );
  assert.ok(!("unsupported" in keyless) && keyless.credentials.length === 0);
  for (const [change, reason] of [
    [
      { secretHeaders: { Authorization: { kind: "env", value: "X" } } },
      "secretHeaders",
    ],
    [
      { compatibility: { reasoning: "strip" } },
      "compatibility.reasoning strip",
    ],
    [
      { compatibility: { dropParameters: ["reasoning_effort"] } },
      "compatibility.dropParameters reasoning_effort",
    ],
  ] as const) {
    const result = migratedProvider(
      activeHarnessModel({
        file: {
          ...unified,
          provider: { ...unified.provider, ...change },
        } as HarnessModel,
      })!,
      "2026-10-03T00:00:00.000Z",
    );
    assert.deepEqual(result, { unsupported: reason });
  }
});

/** The two ModelPlaneStore methods the migration uses, plus their writes. */
function fakeStore() {
  const providers = new Map<string, ProviderConfig>();
  const groups = new Map<string, RouteGroup>();
  const store = {
    getProvider: async (id: string) => providers.get(id),
    putProvider: async (provider: ProviderConfig) =>
      void providers.set(provider.id, provider),
    getRouteGroup: async (id: string) => groups.get(id),
    putRouteGroup: async (group: RouteGroup) =>
      void groups.set(group.id, group),
  } as unknown as ModelPlaneStore;
  return { store, providers, groups };
}
function recordingLog() {
  const lines: [string, LogFields | undefined][] = [];
  const log: LogSink = {
    level: "info",
    info: (event, fields) => lines.push([event, fields]),
    debug: () => undefined,
  };
  return { log, lines };
}

void test("syncing creates group/default once, follows the file and never changes an existing group", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hh-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "harness-model.json");
  await writeHarnessModelFile(file, {
    ...unified,
    provider: {
      ...unified.provider,
      apiKey: { kind: "env", value: "UPSTREAM_KEY" },
    },
  });
  const service = await HarnessModelService.load({
    environment: {},
    file,
    ports: {
      normalize: normalizeEngine,
      inferAdapter: builtinConfigurationAdapter,
    },
  });
  const { store, providers, groups } = fakeStore();
  const { log, lines } = recordingLog();
  assert.deepEqual(await service.syncModelPlane({ store, log }), {
    status: "synced",
    groupCreated: true,
  });
  assert.equal(service.migrated(), true);
  assert.deepEqual(groups.get("default")?.members, ["migrated/default"]);
  const stored = providers.get("migrated")!;
  assert.equal(
    stored.name,
    "Unified model (managed by legacy harness-model source)",
  );
  assert.deepEqual(await service.syncModelPlane(), {
    status: "synced",
    groupCreated: false,
  });
  assert.equal(
    providers.get("migrated"),
    stored,
    "an unchanged provider is not written again",
  );
  assert.deepEqual(
    lines.map(([event]) => event),
    ["model.migrated"],
    "logged once",
  );
  // A manual edit is overwritten while the legacy source exists, and logged.
  providers.set("migrated", { ...stored, headers: { "X-Edited": "1" } });
  await service.syncModelPlane();
  assert.deepEqual(providers.get("migrated")!.headers, {
    "X-Tenant": "contest",
  });
  assert.equal(providers.get("migrated")!.createdAt, stored.createdAt);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]![1]?.providerChanged, true);
  groups.set("default", {
    ...groups.get("default")!,
    members: ["other/model" as RouteGroup["members"][number]],
  });
  await service.syncModelPlane();
  assert.deepEqual(groups.get("default")?.members, ["other/model"]);

  const none = await HarnessModelService.load({
    environment: {},
    file: path.join(directory, "missing.json"),
    ports: {
      normalize: normalizeEngine,
      inferAdapter: builtinConfigurationAdapter,
    },
  });
  assert.deepEqual(await none.syncModelPlane({ store, log }), {
    status: "none",
  });
  assert.equal(none.migrated(), false);
});
