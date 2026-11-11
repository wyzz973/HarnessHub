import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseVendorKey } from "../../src/contracts/relay.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import { openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { dshModelKey, harnessVendor, hermesModelKey, slashModelKey } from "../../src/adapters/control/relay-vendor.js";

// The decision log of 2026-11-11 took the vendor reading out of the Drivers: the relay hands a conversation to a Harness by its
// name, and no Driver reads the user's Harness configuration to find out who serves its model. What stays of relay-vendor.ts is
// the model key (a model's name without its provider prefix and version decorations) and the one vendor key a declaration says.

test("a declaration's vendor key is the Harness's own name, whatever was observed, and a key the contract parses; no Driver module reads a configuration file for it", async () => {
  const none = { model: null, modelKey: "", authKind: null, endpoint: null, loopback: false };
  const declared = { claude: claudeRelayCapabilities, codex: codexRelayCapabilities, opencode: openCodeRelayCapabilities, dsh: dshRelayCapabilities, hermes: hermesRelayCapabilities, openclaw: openClawRelayCapabilities };
  for (const [harness, declaration] of Object.entries(declared)) {
    assert.equal(parseVendorKey(declaration.resolveVendor(none)), "unknown:" + harness, harness);
    assert.equal(declaration.resolveVendor({ model: "anthropic/claude", modelKey: "claude", authKind: "api_key", endpoint: { host: "gateway.example", layer: "user_config" }, loopback: false }), "unknown:" + harness, harness + ": an observation changes nothing");
  }
  assert.equal(harnessVendor("x")(none), "unknown:x");
  // The module has no way to read a file, a directory or the environment: it is names and strings.
  const source = await readFile(new URL("../../../src/adapters/control/relay-vendor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|node:os|node:path|process\.env|readFile|\bopen\(/u);
});

// G074-F8 (probe record 2026-11-10, DeepSeek Harness 0.2.1-rc.5): dsh reports its model as a JSON array text of the provider and the
// model, `["deepseek-official","deepseek-v4-flash"]`, and the key was that whole text. The last item is the model that runs.
test("G074-F8 DeepSeek Harness's model key is the last item of the JSON array text it reports; any other text is read as before; an array whose last item is no string names no model", () => {
  const key = dshRelayCapabilities.normalizeModel;
  assert.equal(key, dshModelKey, "the declaration's model key is this one");
  const cases: readonly [string | null, string][] = [
    // The array text as dsh reports it, one item, whitespace around it and inside, and the last item's own decorations.
    ['["deepseek-official","deepseek-v4-flash"]', "deepseek-v4-flash"], ['["deepseek-v4-flash"]', "deepseek-v4-flash"], [' [ "deepseek-official" , "deepseek-v4-flash" ]\n', "deepseek-v4-flash"],
    ['["a","b","Deepseek/DeepSeek-V4-Flash-20260101"]', "deepseek-v4-flash"], ['["deepseek-official","deepseek-v4-flash","deepseek-v4-pro"]', "deepseek-v4-pro"],
    // A single string is read as for the other Drivers: its last `/` segment without decorations.
    ["deepseek-v4-flash", "deepseek-v4-flash"], ["deepseek/deepseek-v4-flash", "deepseek-v4-flash"], ["DeepSeek-V4-Flash", "deepseek-v4-flash"],
    // An empty array, an array whose last item is no string, and an empty or over-long last item name no model.
    ["[]", ""], ['["deepseek-official",1]', ""], ['["deepseek-official",["deepseek-v4-flash"]]', ""], ['["deepseek-official",null]', ""], ['["deepseek-official",{"model":"deepseek-v4-flash"}]', ""],
    ['["deepseek-official",true]', ""], ['["deepseek-official",""]', ""], ['["deepseek-official","' + "m".repeat(97) + '"]', ""],
    // A non-string item before the last one does not matter.
    ['[1,"deepseek-v4-flash"]', "deepseek-v4-flash"], ['[["deepseek-official"],"deepseek-v4-flash"]', "deepseek-v4-flash"],
    // Text that is no JSON array is read as before, invalid JSON included: nothing is guessed from it.
    ['["deepseek-official","deepseek-v4-flash"', slashModelKey('["deepseek-official","deepseek-v4-flash"')], ["[deepseek-v4-flash]", slashModelKey("[deepseek-v4-flash]")],
    ['{"model":"deepseek-v4-flash"}', slashModelKey('{"model":"deepseek-v4-flash"}')],
    [null, ""], ["", ""], ["   ", ""],
  ];
  for (const [model, expected] of cases) assert.equal(key(model), expected, JSON.stringify(model));
  // The invalid sample: the key every other Driver uses is the defect the probe found, the whole text.
  const array = '["deepseek-official","deepseek-v4-flash"]';
  assert.equal(slashModelKey(array), array);
  assert.notEqual(slashModelKey(array), "deepseek-v4-flash");
});

test("G069-C08 normalizeModel: provider/model and <provider>:<model> lose the provider, version decorations go, aliases stay their own key, null and over-long models are empty", () => {
  const cases: readonly [(model: string | null) => string, string | null, string][] = [
    [slashModelKey, null, ""], [slashModelKey, "", ""], [slashModelKey, "   ", ""],
    [slashModelKey, "anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"], [slashModelKey, "openrouter/anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"],
    [slashModelKey, "ollama/gpt-oss:120b-cloud", "gpt-oss:120b-cloud"], [slashModelKey, "openai/GPT-5.5", "gpt-5.5"],
    [slashModelKey, "claude-sonnet-4-5-20250929", "claude-sonnet-4-5"], [slashModelKey, "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    [slashModelKey, "anthropic.claude-opus-4-1-20250805-v1:0", "claude-opus-4-1"], [slashModelKey, "claude-opus-4-1@20250805", "claude-opus-4-1"],
    [slashModelKey, "gpt-4o-2024-08-06", "gpt-4o"], [slashModelKey, "claude-3-5-sonnet-latest", "claude-3-5-sonnet"], [slashModelKey, "claude-sonnet-4-5[1m]", "claude-sonnet-4-5[1m]"],
    // Aliases a CLI resolves at run time stay their own key; a version-like name is not a decoration.
    [slashModelKey, "opus", "opus"], [slashModelKey, "deepseek-v3", "deepseek-v3"], [slashModelKey, "provider/", ""],
    [slashModelKey, "m".repeat(96), "m".repeat(96)], [slashModelKey, "m".repeat(97), ""],
    [hermesModelKey, null, ""], [hermesModelKey, "openrouter:anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"], [hermesModelKey, "custom:qwen3:8b", "qwen3:8b"],
    [hermesModelKey, "Anthropic:claude-opus-4-1-20250805", "claude-opus-4-1"], [hermesModelKey, "nous/hermes-4-405b", "hermes-4-405b"],
  ];
  for (const [normalize, model, expected] of cases) assert.equal(normalize(model), expected, JSON.stringify(model));
  // Each declaration's normalizeModel is one of these.
  assert.equal(hermesRelayCapabilities.normalizeModel, hermesModelKey);
  for (const declaration of [claudeRelayCapabilities, codexRelayCapabilities, openCodeRelayCapabilities, openClawRelayCapabilities]) assert.equal(declaration.normalizeModel, slashModelKey);
  assert.equal(dshRelayCapabilities.normalizeModel, dshModelKey, "dsh's models are a JSON array text (G074-F8)");
  // Invalid sample: Hermes's provider rule does not apply to slash models, whose colon is a tag.
  assert.equal(slashModelKey("custom:qwen3:8b"), "custom:qwen3:8b");
});
