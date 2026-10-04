// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { applyWiring, detectDrift } from "../src/wiring/index.js";
import { editors } from "../src/wiring/formats/index.js";
import { sandbox, TARGET } from "./wiring-support.js";
import { adapterSuite } from "./wiring-suite.js";

// Fixture shapes follow Magpie's tests of the agent at 2e340f7; the golden
// files are reviewed output: regenerate them only after reviewing a change
// to what the adapter writes.
adapterSuite("grok", {
  protocol: "chat",
  executables: ["grok"],
  files: [".grok/config.toml"],
  locations: [{ env: { GROK_HOME: "grok" }, files: ["grok/config.toml"] }],
  existing: {
    ".grok/config.toml": `# Grok Build
[models]
default = "grok-4" # mine
default_reasoning_effort = "high"

[model."local/qwen"]
model = "qwen3"
base_url = "http://localhost:11434/v1"

[ui]
theme = "dark"
`,
  },
  golden: {
    empty: {
      ".grok/config.toml": `[models]
default = "harnesshub/deepseek/deepseek-chat"

[features]
campaigns = false

[model."harnesshub/deepseek/deepseek-chat"]
model = "deepseek/deepseek-chat"
name = "deepseek/deepseek-chat"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
api_backend = "chat_completions"
context_window = 128000

[model."harnesshub/openai/gpt-5"]
model = "openai/gpt-5"
name = "openai/gpt-5"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
api_backend = "chat_completions"
context_window = 400000
`,
    },
    existing: {
      ".grok/config.toml": `# Grok Build
[models]
default = "harnesshub/deepseek/deepseek-chat" # mine
default_reasoning_effort = "high"

[model."local/qwen"]
model = "qwen3"
base_url = "http://localhost:11434/v1"

[ui]
theme = "dark"

[features]
campaigns = false

[model."harnesshub/deepseek/deepseek-chat"]
model = "deepseek/deepseek-chat"
name = "deepseek/deepseek-chat"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
api_backend = "chat_completions"
context_window = 128000

[model."harnesshub/openai/gpt-5"]
model = "openai/gpt-5"
name = "openai/gpt-5"
base_url = "http://127.0.0.1:3180/v1"
api_key = "hhk_a_abcdefghijkl_SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
api_backend = "chat_completions"
context_window = 400000
`,
    },
  },
});

void test("grok: tells a foreign gateway by the chosen model's own table", async (t) => {
  const context = await sandbox(t);
  const { record, plan } = await applyWiring("grok", TARGET, context);
  const file = plan.files[0]!.path;
  const wired = await readFile(file, "utf8");
  const elsewhere = (model: string) =>
    editors.toml.set(
      wired,
      ["model", `harnesshub/${model}`, "base_url"],
      "http://127.0.0.1:9999/v1",
    );
  // Another model's table pointing elsewhere is a replaced entry.
  await writeFile(file, elsewhere("openai/gpt-5"));
  assert.deepEqual((await detectDrift(record, context)).kinds, ["replaced"]);
  await writeFile(file, elsewhere(TARGET.model));
  assert.deepEqual((await detectDrift(record, context)).kinds, [
    "foreign-gateway",
  ]);
});
