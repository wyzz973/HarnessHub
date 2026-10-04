// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyWiring, detectAgent, detectDrift } from "../src/wiring/index.js";
import { editors } from "../src/wiring/formats/index.js";
import { NEW_KEY, sandbox, TARGET } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("t3code", {
  protocol: "anthropic",
  executables: [],
  files: [".t3/userdata/settings.json"],
  locations: [
    { env: { T3CODE_HOME: "t3" }, files: ["t3/userdata/settings.json"] },
  ],
  existing: {
    ".t3/userdata/settings.json": `{
  "theme": "dark",
  "providerInstances": {
    "claudeAgent": { "driver": "claudeAgent", "enabled": true }
  }
}
`,
  },
  golden: {
    empty: {
      ".t3/userdata/settings.json": `{
  "providerInstances": {
    "harnesshub": {
      "driver": "claudeAgent",
      "displayName": "HarnessHub",
      "enabled": true,
      "environment": [
        {
          "name": "ANTHROPIC_BASE_URL",
          "value": "http://127.0.0.1:3180",
          "sensitive": false
        },
        {
          "name": "ANTHROPIC_AUTH_TOKEN",
          "value": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
          "sensitive": false
        }
      ],
      "config": {
        "customModels": [
          {
            "slug": "deepseek/deepseek-chat",
            "name": "deepseek/deepseek-chat"
          },
          {
            "slug": "openai/gpt-5",
            "name": "openai/gpt-5"
          }
        ]
      }
    }
  }
}
`,
    },
    existing: {
      ".t3/userdata/settings.json": `{
  "theme": "dark",
  "providerInstances": {
    "claudeAgent": { "driver": "claudeAgent", "enabled": true },
    "harnesshub": {
      "driver": "claudeAgent",
      "displayName": "HarnessHub",
      "enabled": true,
      "environment": [
        {
          "name": "ANTHROPIC_BASE_URL",
          "value": "http://127.0.0.1:3180",
          "sensitive": false
        },
        {
          "name": "ANTHROPIC_AUTH_TOKEN",
          "value": "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS",
          "sensitive": false
        }
      ],
      "config": {
        "customModels": [
          {
            "slug": "deepseek/deepseek-chat",
            "name": "deepseek/deepseek-chat"
          },
          {
            "slug": "openai/gpt-5",
            "name": "openai/gpt-5"
          }
        ]
      }
    }
  }
}
`,
    },
  },
});

void test("t3code: tells another key and a foreign gateway inside the instance's environment list", async (t) => {
  const context = await sandbox(t);
  const { record, plan } = await applyWiring("t3code", TARGET, context);
  const file = plan.files[0]!.path;
  const wired = await readFile(file, "utf8");
  const environment = ["providerInstances", "harnesshub", "environment"];
  const withEnvironment = (base: string, key: string) =>
    editors.json.set(wired, environment, [
      { name: "ANTHROPIC_BASE_URL", value: base, sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: key, sensitive: false },
    ]);
  // An unrelated edit leaves the list matching its template.
  await writeFile(file, editors.json.set(wired, ["theme"], "light"));
  assert.equal((await detectDrift(record, context)).drifted, false);
  await writeFile(file, withEnvironment(TARGET.baseUrl, NEW_KEY.keyText));
  let report = await detectDrift(record, context);
  assert.deepEqual(report.kinds, ["unwired"]);
  assert.deepEqual(report.findings[0]!.keyPath, environment);
  assert.equal(report.findings[0]!.reason, "other-key");
  assert.doesNotMatch(JSON.stringify(report), /hhk_/);
  await writeFile(
    file,
    withEnvironment("http://127.0.0.1:9999", TARGET.keyText),
  );
  report = await detectDrift(record, context);
  assert.deepEqual(report.kinds, ["foreign-gateway"]);
  assert.equal(report.findings[0]!.reason, "changed");
});

void test("t3code: having no command, is found by its configuration directory", async (t) => {
  const context = await sandbox(t);
  const env = { PATH: path.join(context.root, "bin") };
  await mkdir(env.PATH);
  assert.equal(
    (await detectAgent("t3code", { ...context, env })).status,
    "not-found",
  );
  const directory = path.join(context.home, ".t3", "userdata");
  await mkdir(directory, { recursive: true });
  assert.deepEqual(await detectAgent("t3code", { ...context, env }), {
    status: "configured-only",
    configDirectories: [directory],
  });
});
