import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscoveryInputError,
  MAX_RECIPES,
  parseDiscoveryManifest,
  type ExecutableLocator,
  type HarnessRecipe,
  validateRecipes,
} from "../../src/contexts/catalog/domain/discovery.js";
import { DiscoverHarnesses } from "../../src/contexts/catalog/application/discover.js";
import { searchDirectories } from "../../src/infrastructure/discovery/local.js";

const recipe: HarnessRecipe = {
  id: "example", name: "Example", binary: "example", protocol: "acp-v1", args: ["acp"],
};

test("versioned custom recipes and overrides preserve argv as data", () => {
  const manifest = parseDiscoveryManifest({
    version: 1, recipes: [recipe],
    overrides: { example: { binary: "/custom/example" } },
  });
  assert.deepEqual(manifest.recipes, [recipe]);
  assert.equal(manifest.overrides.get("example")?.binary, "/custom/example");
  const literal = parseDiscoveryManifest({ version: 1, recipes: [{ ...recipe, args: ["x; touch marker"] }] });
  assert.deepEqual(literal.recipes[0]?.args, ["x; touch marker"]);
});

test("invalid fields, versions, protocols, and shell-like binary names are rejected", () => {
  for (const value of [
    null, [], { version: 2 }, { version: 1, unexpected: true },
    { version: 1, recipes: null }, { version: 1, overrides: null },
    { version: 1, recipes: [{ ...recipe, protocol: "guess" }] },
    { version: 1, recipes: [{ ...recipe, binary: "npx example" }] },
    { version: 1, recipes: [{ ...recipe, binary: "../example" }] },
    { version: 1, recipes: [{ ...recipe, id: "__proto__" }] },
    { version: 1, recipes: [{ ...recipe, args: "acp" }] },
    { version: 1, recipes: [{ ...recipe, args: ["bad\narg"] }] },
    { version: 1, recipes: [{ ...recipe, nativeRequired: false }] },
    { version: 1, overrides: { example: {} } },
    { version: 1, overrides: { example: { binary: 3 } } },
    { version: 1, overrides: { example: { binary: "/bin/example", token: "not-supported" } } },
  ]) assert.throws(() => parseDiscoveryManifest(value), DiscoveryInputError);
});

test("duplicate IDs and recipe/argument limits are enforced before filesystem access", () => {
  assert.throws(() => validateRecipes([recipe, recipe]), /duplicate/);
  const bounded = Array.from({ length: MAX_RECIPES }, (_, n) => ({ ...recipe, id: "h-" + n }));
  validateRecipes(bounded);
  assert.throws(() => validateRecipes([...bounded, { ...recipe, id: "extra" }]), /too many/);
  assert.throws(() => parseDiscoveryManifest({ version: 1, recipes: [{ ...recipe, args: Array(33).fill("x") }] }), /32/);
});

test("search paths are ordered and deduplicated without implicitly using the cwd", () => {
  const result = searchDirectories({ path: "/first:/second::./local:/first", home: "/home/example", extra: ["/second", "/third"], pathOnly: true });
  assert.deepEqual(result.directories.map((d) => d.path), ["/first", "/second", "/third"]);
  assert.deepEqual(result.notes, [{ code: "relative_path_ignored", path: "./local" }]);
  assert.throws(() => searchDirectories({ path: "", home: "/home/example", extra: ["relative"], pathOnly: true }), /absolute/);
  assert.throws(() => searchDirectories({ path: "", home: "/home/example", extra: [""], pathOnly: true }), /non-empty/);
  assert.throws(() => searchDirectories({ path: Array.from({ length: 129 }, (_, n) => "/p" + n).join(":"), home: "/home/example", extra: [], pathOnly: true }), /too many/);
  const known = searchDirectories({ path: "", home: "/home/example", extra: [], pathOnly: false });
  assert.ok(known.directories.some((d) => d.path === "/home/example/.local/bin"));
});

test("an unknown override or duplicate custom ID performs no lookup", async () => {
  let lookups = 0;
  const locator: ExecutableLocator = { validateOverride: () => {}, lookup: async () => { lookups++; return { status: "missing", notes: [] }; } };
  const service = new DiscoverHarnesses(locator, () => new Date(0));
  await assert.rejects(() => service.execute([recipe], new Map([["unknown", { binary: "/bin/x" }]])), /unknown Harness/);
  await assert.rejects(() => service.execute([recipe, recipe]), /duplicate/);
  assert.equal(lookups, 0);
});

test("external adapter dependencies are separate from the native CLI", async () => {
  const locator: ExecutableLocator = {
    validateOverride: () => {},
    lookup: async (name) => name === "example"
      ? { status: "found", path: "/bin/example", resolvedPath: "/real/example", source: "path", notes: [] }
      : { status: "missing", notes: [] },
  };
  const service = new DiscoverHarnesses(locator, () => new Date(0));
  const report = await service.execute([{ ...recipe, adapterBinary: "example-acp" }]);
  assert.equal(report.harnesses[0]?.installation.status, "found");
  assert.equal(report.harnesses[0]?.control.state, "adapter_missing");
  assert.equal(report.harnesses[0]?.control.command, null);
  assert.equal(report.protocolProbesRun, 0);
});

test("an adapter-provided runtime may be detected without a global native CLI", async () => {
  const locator: ExecutableLocator = {
    validateOverride: () => {},
    lookup: async (name) => name === "example-acp"
      ? { status: "found", path: "/bin/example-acp", resolvedPath: "/bin/example-acp", source: "path", notes: [] }
      : { status: "missing", notes: [] },
  };
  const report = await new DiscoverHarnesses(locator, () => new Date(0)).execute([
    { ...recipe, adapterBinary: "example-acp", nativeRequired: false },
  ]);
  assert.equal(report.harnesses[0]?.installation.status, "missing");
  assert.equal(report.harnesses[0]?.control.state, "candidate");
  assert.equal(report.harnesses[0]?.control.command?.executable, "/bin/example-acp");
  assert.equal(report.harnesses[0]?.control.probe, "not_run");
});

test("missing both native CLI and adapter is not reported as an installed program", async () => {
  const locator: ExecutableLocator = { validateOverride: () => {}, lookup: async () => ({ status: "missing", notes: [] }) };
  const report = await new DiscoverHarnesses(locator, () => new Date(0)).execute([
    { ...recipe, adapterBinary: "example-acp", nativeRequired: false },
  ]);
  assert.equal(report.harnesses[0]?.installation.status, "missing");
  assert.equal(report.harnesses[0]?.control.state, "harness_missing");
  assert.equal(report.harnesses[0]?.control.command, null);
});

test("a native recipe cannot accept an unused adapter override", async () => {
  let called = false;
  const locator: ExecutableLocator = { validateOverride: () => {}, lookup: async () => { called = true; return { status: "missing", notes: [] }; } };
  await assert.rejects(
    () => new DiscoverHarnesses(locator, () => new Date(0)).execute([recipe], new Map([["example", { adapter: "/bin/unused" }]])),
    /no external adapter/,
  );
  assert.equal(called, false);
});
