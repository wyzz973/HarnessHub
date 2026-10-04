// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  detectAgent,
  detectDrift,
  planWiring,
  unwire,
  WiringError,
} from "../src/wiring/index.js";
import { jsonEditor } from "../src/wiring/formats/json.js";
import { getPath } from "../src/wiring/formats/values.js";
import { NEW_KEY, sandbox, TARGET, writeFiles } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's agents at 2e340f7; the golden files are
// reviewed output: regenerate them only after reviewing a change to what the
// adapter writes.
const EXISTING: Record<string, string> = {
  ".config/openchamber/preferences.json": `{
  "version": 1,
  "fields": {
    "theme": { "value": "dark", "updatedAt": 1759000000000 },
    "defaultModel": { "value": "anthropic/claude-sonnet-4-5", "updatedAt": 1759000000001 },
    "defaultVariant": { "value": "high", "updatedAt": 1759000000002 }
  }
}
`,
  ".config/openchamber/settings.json": `{
  "projects": [{ "path": "/work/app", "label": "app" }],
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "defaultVariant": "high"
}
`,
  ".config/opencode/opencode.json": `{
  // my OpenCode
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "ollama": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://localhost:11434/v1" } }
  }
}
`,
};

adapterSuite("openchamber", {
  protocol: "chat",
  executables: ["openchamber"],
  files: [
    ".config/openchamber/settings.json",
    ".config/opencode/opencode.json",
  ],
  locations: [
    {
      env: { OPENCHAMBER_DATA_DIR: "chamber", OPENCODE_CONFIG_DIR: "oc" },
      files: ["chamber/settings.json", "oc/opencode.json"],
    },
  ],
  existing: EXISTING,
  // The profile's fields are objects of the user's that wiring replaces,
  // and the variant it removes comes back after the user's own keys.
  restoresByValue: [
    ".config/openchamber/preferences.json",
    ".config/openchamber/settings.json",
  ],
  golden: {
    empty: {
      ".config/openchamber/settings.json": `{
  "defaultModel": "harnesshub-openchamber/deepseek/deepseek-chat"
}
`,
      ".config/opencode/opencode.json": `{
  "provider": {
    "harnesshub-openchamber": {
      "name": "HarnessHub (OpenChamber)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3180/v1",
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "variants": {}
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000,
            "output": 0
          },
          "variants": {}
        }
      }
    }
  }
}
`,
    },
    existing: {
      ".config/openchamber/preferences.json": `{
  "version": 1,
  "fields": {
    "theme": { "value": "dark", "updatedAt": 1759000000000 },
    "defaultModel": {
      "value": "harnesshub-openchamber/deepseek/deepseek-chat",
      "updatedAt": 1790928000000
    }
  }
}
`,
      ".config/openchamber/settings.json": `{
  "projects": [{ "path": "/work/app", "label": "app" }],
  "defaultModel": "harnesshub-openchamber/deepseek/deepseek-chat"
}
`,
      ".config/opencode/opencode.json": `{
  // my OpenCode
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "provider": {
    "ollama": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://localhost:11434/v1" } },
    "harnesshub-openchamber": {
      "name": "HarnessHub (OpenChamber)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3180/v1",
        "apiKey": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
      },
      "models": {
        "deepseek/deepseek-chat": {
          "name": "deepseek/deepseek-chat",
          "limit": {
            "context": 128000,
            "output": 8192
          },
          "variants": {}
        },
        "openai/gpt-5": {
          "name": "openai/gpt-5",
          "limit": {
            "context": 400000,
            "output": 0
          },
          "variants": {}
        }
      }
    }
  }
}
`,
    },
  },
});

const PREFERENCES = ".config/openchamber/preferences.json";
const SETTINGS = ".config/openchamber/settings.json";
const OPENCODE = ".config/opencode/opencode.json";

async function json(file: string): Promise<Record<string, unknown>> {
  return jsonEditor.parse(await readFile(file, "utf8"));
}

void test("openchamber: a field keeps its time while its value stays, and the effort is the default variant", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, { [PREFERENCES]: EXISTING[PREFERENCES]! });
  const file = path.join(context.home, PREFERENCES);
  const fields = async () =>
    (await json(file)).fields as Record<string, unknown>;
  let { record } = await applyWiring(
    "openchamber",
    { ...TARGET, effort: "high" },
    context,
  );
  const wired = Date.parse("2026-10-02T08:00:00.000Z");
  assert.deepEqual((await fields()).defaultModel, {
    value: "harnesshub-openchamber/deepseek/deepseek-chat",
    updatedAt: wired,
  });
  // The user's variant was high already: its time stays.
  assert.deepEqual((await fields()).defaultVariant, {
    value: "high",
    updatedAt: 1759000000002,
  });
  // settings.json is written only where it is, preferences.json being there.
  assert.deepEqual(
    record.files.map((entry) => path.relative(context.home, entry.path)),
    [PREFERENCES, OPENCODE],
  );
  // Later, the same choice changes nothing; another model is stamped anew.
  const later = { ...context, clock: () => new Date(wired + 60_000) };
  const same = await planWiring(
    "openchamber",
    { ...TARGET, effort: "high" },
    later,
    { previous: record },
  );
  assert.equal(same.changed, false);
  ({ record } = await applyWiring(
    "openchamber",
    { ...TARGET, model: "openai/gpt-5" },
    later,
    { previous: record },
  ));
  assert.deepEqual((await fields()).defaultModel, {
    value: "harnesshub-openchamber/openai/gpt-5",
    updatedAt: wired + 60_000,
  });
  assert.equal((await fields()).defaultVariant, undefined);
  assert.equal((await detectDrift(record, later)).drifted, false);
  await unwire(record, later);
  assert.equal(await readFile(file, "utf8"), EXISTING[PREFERENCES]);
});

void test("openchamber: a preferences.json OpenChamber would not read is refused and left as it is", async (t) => {
  const context = await sandbox(t);
  const odd = '{"version": 2, "fields": {}}\n';
  await writeFiles(context.home, { [PREFERENCES]: odd });
  await assert.rejects(
    planWiring("openchamber", TARGET, context),
    (error: unknown) =>
      error instanceof WiringError &&
      error.code === "WIRING_UNSUPPORTED_STRUCTURE" &&
      error.path === path.join(context.home, PREFERENCES),
  );
  assert.equal(
    await readFile(path.join(context.home, PREFERENCES), "utf8"),
    odd,
  );
});

void test("openchamber: its provider and OpenCode's sit side by side in one file, each wired and unwired on its own", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, { [OPENCODE]: EXISTING[OPENCODE]! });
  const file = path.join(context.home, OPENCODE);
  const providers = async () =>
    Object.keys((await json(file)).provider as object).sort();
  const opencode = await applyWiring("opencode", TARGET, context);
  const chamber = await applyWiring(
    "openchamber",
    { ...TARGET, ...NEW_KEY },
    context,
  );
  assert.deepEqual(await providers(), [
    "harnesshub",
    "harnesshub-openchamber",
    "ollama",
  ]);
  // Each provider carries its agent's own key.
  const keyOf = async (id: string) =>
    getPath(await json(file), ["provider", id, "options", "apiKey"]);
  assert.equal(await keyOf("harnesshub"), TARGET.keyText);
  assert.equal(await keyOf("harnesshub-openchamber"), NEW_KEY.keyText);
  assert.equal((await detectDrift(opencode.record, context)).drifted, false);
  assert.equal((await detectDrift(chamber.record, context)).drifted, false);
  await unwire(opencode.record, context);
  assert.deepEqual(await providers(), ["harnesshub-openchamber", "ollama"]);
  assert.equal((await detectDrift(chamber.record, context)).drifted, false);
  await unwire(chamber.record, context);
  assert.equal(await readFile(file, "utf8"), EXISTING[OPENCODE]);
});

void test("openchamber: OpenCode's configuration alone does not make it configured", async (t) => {
  const context = await sandbox(t);
  const env = { PATH: path.join(context.root, "bin") };
  await mkdir(env.PATH);
  // OpenCode is set up (wiring OpenCode creates this directory).
  await mkdir(path.join(context.home, ".config", "opencode"), {
    recursive: true,
  });
  assert.equal(
    (await detectAgent("openchamber", { ...context, env })).status,
    "not-found",
  );
  const directory = path.join(context.home, ".config", "openchamber");
  await mkdir(directory);
  assert.deepEqual(await detectAgent("openchamber", { ...context, env }), {
    status: "configured-only",
    configDirectories: [directory],
  });
});
