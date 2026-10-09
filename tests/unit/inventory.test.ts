import assert from "node:assert/strict";
import test from "node:test";
import { DiscoverInventory } from "../../src/contexts/catalog/application/inventory.js";
import type { HarnessDefinition, InstallationEnumerator, InstallationEnumeration, LocalPackageResolver } from "../../src/contexts/catalog/domain/catalog.js";

const absent: InstallationEnumeration = { candidates: [], selected: null, defaultResolution: "none", diagnostics: [] };
const found: InstallationEnumeration = {
  candidates: [{ path: "/bin/demo", resolvedPath: "/real/demo", source: "path", entries: [{ path: "/bin/demo", name: "demo", source: "path" }] }],
  selected: { path: "/bin/demo", resolvedPath: "/real/demo", source: "path", entries: [{ path: "/bin/demo", name: "demo", source: "path" }] },
  defaultResolution: "located", diagnostics: [],
};
const definition: HarnessDefinition = { id: "demo", name: "Demo", aliases: [], binaryNames: ["demo"], configHints: [".demo"], controls: [{
  id: "demo-acp", protocol: "acp-v1", executableNames: ["demo-acp"], args: ["acp"], env: { DEMO_MODE: "1" }, package: null, distribution: null, requiredExecutables: [],
  source: { repository: "example/demo", revision: "fixed", upstreamId: "demo", url: "https://example.com/demo" },
}] };
const nonePackage: LocalPackageResolver = { resolve: async () => ({ command: null, diagnostics: [] }) };

function service(lookup: InstallationEnumerator, packages: LocalPackageResolver = nonePackage) {
  return new DiscoverInventory(lookup, packages, { observe: async () => [{ path: "/home/.demo", state: "configured" }] }, () => new Date(0));
}
test("configuration evidence does not promote a missing control into an installed executor", async () => {
  const report = await service({ validateOverride: () => {}, enumerate: async () => absent }).execute([definition]);
  assert.equal(report.schemaVersion, 2); assert.equal(report.protocolProbesRun, 0);
  assert.equal(report.harnesses[0]?.configuration[0]?.state, "configured");
  assert.equal(report.harnesses[0]?.controls[0]?.state, "missing_dependency");
});
test("separate control candidates preserve arguments and environment as data", async () => {
  const report = await service({ validateOverride: () => {}, enumerate: async () => found }).execute([definition]);
  assert.deepEqual(report.harnesses[0]?.controls[0]?.command, { executable: "/bin/demo", args: ["acp"], env: { DEMO_MODE: "1" } });
  assert.equal(report.observedAt, "1970-01-01T00:00:00.000Z");
});
test("all unknown and relative overrides are rejected before filesystem observations", async () => {
  let calls = 0;
  const locator: InstallationEnumerator = { validateOverride: (path) => { if (!path.startsWith("/")) throw new Error("absolute"); }, enumerate: async () => { calls++; return absent; } };
  await assert.rejects(() => service(locator).execute([definition], new Map([["unknown", { executable: "/bin/x" }]])), /unknown/);
  await assert.rejects(() => service(locator).execute([definition], new Map([["demo-acp", { executable: "relative" }]])), /absolute/);
  await assert.rejects(() => service(locator).execute([definition], new Map(), new Map([["demo", "relative"]])), /absolute/);
  await assert.rejects(() => service(locator).execute([definition, definition]), /duplicate/);
  assert.equal(calls, 0);
});
test("blocked PATH default never falls back to package resolution", async () => {
  let packageCalls = 0;
  const withPackage = { ...definition, controls: definition.controls.map((control) => ({ ...control, package: { kind: "npm" as const, name: "demo-acp", version: "1.0.0", binNames: [] } })) };
  const report = await service({ validateOverride: () => {}, enumerate: async () => ({ ...found, selected: null, defaultResolution: "blocked" }) }, { resolve: async () => { packageCalls++; return { command: { executable: "/node", args: ["/package/bin.js"], env: {} }, diagnostics: [] }; } }).execute([withPackage]);
  assert.equal(packageCalls, 0); assert.equal(report.harnesses[0]?.controls[0]?.state, "blocked");
  assert.equal(report.harnesses[0]?.controls[0]?.command, null);
});
test("a local wrapper runtime is candidate without a global native CLI", async () => {
  const withPackage = { ...definition, controls: definition.controls.map((control) => ({ ...control, executableNames: [], package: { kind: "npm" as const, name: "demo-acp", version: "1.0.0", binNames: [] } })) };
  const report = await service({ validateOverride: () => {}, enumerate: async () => absent }, { resolve: async () => ({ command: { executable: "/node", args: ["/bin.js"], env: {} }, diagnostics: [] }) }).execute([withPackage]);
  assert.equal(report.harnesses[0]?.installation.candidates.length, 0);
  assert.deepEqual(report.harnesses[0]?.controls[0]?.command?.args, ["/bin.js", "acp"]);
});
test("native dependency overrides are consumed independently from adapter overrides", async () => {
  const paths: string[] = [];
  const locator: InstallationEnumerator = { validateOverride: () => {}, enumerate: async (_names, override) => { if (override) { paths.push(override); return found; } return absent; } };
  const requiringNative = { ...definition, controls: definition.controls.map((control) => ({ ...control, requiredExecutables: ["demo"] })) };
  const report = await service(locator).execute([requiringNative], new Map([["demo-acp", { executable: "/adapter" }]]), new Map([["demo", "/native"]]));
  assert.deepEqual(paths, ["/native", "/adapter", "/native"]);
  assert.equal(report.harnesses[0]?.controls[0]?.state, "candidate");
});

test("an installed ACP wrapper is not proof that its required native program exists", async () => {
  const mixed = { ...definition, binaryNames: ["demo", "demo-acp"], controls: definition.controls.map((control) => ({ ...control, requiredExecutables: ["demo"] })) };
  const locator: InstallationEnumerator = { validateOverride: () => {}, enumerate: async (names) => names.includes("demo-acp") ? found : absent };
  const report = await service(locator).execute([mixed]);
  assert.equal(report.harnesses[0]?.installation.candidates.length, 1);
  assert.equal(report.harnesses[0]?.controls[0]?.state, "missing_dependency");
  assert.deepEqual(report.harnesses[0]?.controls[0]?.missingDependencies, ["demo"]);
  assert.equal(report.harnesses[0]?.controls[0]?.command, null);
});
