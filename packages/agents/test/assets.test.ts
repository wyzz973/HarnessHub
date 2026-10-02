// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ASSET_NAMES,
  assetPath,
  currentAssetPath,
  currentEngineCommand,
} from "../src/assets.js";
import {
  COMMAND_MCP_ENTRY,
  currentCommandMcpEntry,
} from "../src/tool-command/entry.js";

/** This checkout: packages/agents/assets/launch-engine.mjs is four levels below it. */
const checkout = path.resolve(assetPath("launch-engine.mjs"), "../../../..");

void test("every runtime asset is a file in the package's assets/ directory", () => {
  const assets = path.join(checkout, "packages", "agents", "assets");
  assert.equal(ASSET_NAMES.length, 7);
  for (const name of ASSET_NAMES) {
    const file = assetPath(name);
    assert.equal(file, path.join(assets, ...name.split("/")));
    assert.ok(existsSync(file), file);
  }
});

void test("a stored path of a moved file of this checkout maps to its current location, and nothing else does", () => {
  const legacy = (relative: string) =>
    path.join(checkout, ...relative.split("/"));
  for (const name of ASSET_NAMES)
    assert.equal(currentAssetPath(legacy(`scripts/${name}`)), assetPath(name));
  assert.equal(
    currentAssetPath(
      path.join(checkout, "scripts", "..", "scripts", "launch-pi-acp.mjs"),
    ),
    assetPath("launch-pi-acp.mjs"),
  );
  const unchanged = [
    path.join(
      path.dirname(checkout),
      "other-checkout",
      "scripts",
      "launch-engine.mjs",
    ),
    legacy("scripts/launch-unknown-acp.mjs"),
    legacy("launch-engine.mjs"),
    "scripts/launch-engine.mjs",
    "launch-engine.mjs",
    "--",
  ];
  for (const argument of unchanged)
    assert.equal(currentAssetPath(argument), argument);
  if (process.platform === "win32")
    assert.equal(
      currentAssetPath(legacy("scripts/launch-engine.mjs").toUpperCase()),
      assetPath("launch-engine.mjs"),
    );

  const stored = [
    process.execPath,
    legacy("scripts/launch-engine.mjs"),
    "NAME=value",
    "--",
    process.execPath,
    legacy("scripts/launch-dsh-acp.mjs"),
  ];
  const copy = [...stored];
  assert.deepEqual(currentEngineCommand(stored), [
    process.execPath,
    assetPath("launch-engine.mjs"),
    "NAME=value",
    "--",
    process.execPath,
    assetPath("launch-dsh-acp.mjs"),
  ]);
  assert.deepEqual(stored, copy);

  const entry = legacy("dist/src/drivers/tool-command/command-mcp.js");
  assert.equal(currentCommandMcpEntry(entry), COMMAND_MCP_ENTRY);
  const foreign = path.join(
    path.dirname(checkout),
    "other-checkout",
    "dist/src/drivers/tool-command/command-mcp.js",
  );
  assert.equal(currentCommandMcpEntry(foreign), foreign);
  assert.equal(
    currentCommandMcpEntry("dist/src/drivers/tool-command/command-mcp.js"),
    "dist/src/drivers/tool-command/command-mcp.js",
  );
});
