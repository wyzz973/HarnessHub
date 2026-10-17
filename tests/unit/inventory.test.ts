import assert from "node:assert/strict";
import test from "node:test";
import { DiscoverInventory } from "../../src/contexts/catalog/application/inventory.js";
import type { ChannelRegistry, HarnessDefinition, InstallationClassifier, InstallationEnumerator, InstallationEnumeration, InstallationPolicy, LocalPackageResolver } from "../../src/contexts/catalog/domain/catalog.js";
import type { OfficialChannels } from "../../src/contexts/catalog/domain/channels.js";

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
const nonePackage: LocalPackageResolver = { observe: async () => [], resolve: async () => ({ command: null, diagnostics: [] }) };

const recorded = (name: string): OfficialChannels => ({ npm: [name], brewFormulae: [], brewCasks: [], scripts: [], uv: [], source: { url: "https://example.com/demo", checkedAt: "2026-10-17" } });
/** Official means: the program resolves under /official/<package>/ (the real classifier's rules are tested with the real channels). */
const classifier: InstallationClassifier = { classify: async (candidate, channels) => {
  const name = channels.npm.find(item => candidate.resolvedPath.startsWith("/official/" + item + "/"));
  return name === undefined ? null : { channel: { kind: "npm", name, root: "/official/" + name, prefix: "/official" }, version: "1.2.3" };
} };
const registry: ChannelRegistry = { product: id => id === "demo" ? recorded("demo") : null, adapter: (_id, control) => control.id === "demo-acp" ? recorded("demo-acp") : null };
function service(lookup: InstallationEnumerator, packages: LocalPackageResolver = nonePackage, policy: InstallationPolicy = "any") {
  return new DiscoverInventory(lookup, packages, { observe: async () => [{ path: "/home/.demo", state: "configured" }] }, () => new Date(0), { classifier, registry, policy });
}
const at = (path: string, resolvedPath: string, source: "path" | "known-directory" | "override" = "path") => ({ path, resolvedPath, source, entries: [{ path, name: path.split("/").at(-1)!, source }] });
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
  const report = await service({ validateOverride: () => {}, enumerate: async () => ({ ...found, selected: null, defaultResolution: "blocked" }) }, { observe: async () => [], resolve: async () => { packageCalls++; return { command: { executable: "/node", args: ["/package/bin.js"], env: {} }, diagnostics: [] }; } }).execute([withPackage]);
  assert.equal(packageCalls, 0); assert.equal(report.harnesses[0]?.controls[0]?.state, "blocked");
  assert.equal(report.harnesses[0]?.controls[0]?.command, null);
});
test("a local wrapper runtime is candidate without a global native CLI", async () => {
  const withPackage = { ...definition, controls: definition.controls.map((control) => ({ ...control, executableNames: [], package: { kind: "npm" as const, name: "demo-acp", version: "1.0.0", binNames: [] } })) };
  const report = await service({ validateOverride: () => {}, enumerate: async () => absent }, { observe: async () => [], resolve: async () => ({ command: { executable: "/node", args: ["/bin.js"], env: {} }, diagnostics: [] }) }).execute([withPackage]);
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

test("G012-OC2 under the official policy a program outside every channel is not an installation and is reported apart (ADR-044)", async () => {
  const developer = at("/bin/demo-acp", "/home/me/src/demo/cli.js");
  const enumeration: InstallationEnumeration = { candidates: [developer], selected: developer, defaultResolution: "located", diagnostics: [] };
  const report = await service({ validateOverride: () => {}, enumerate: async () => enumeration }, nonePackage, "official").execute([definition]);
  const harness = report.harnesses[0]!;
  assert.deepEqual(harness.installation.candidates, []); assert.equal(harness.installation.selected, null);
  assert.deepEqual(harness.installation.unofficial, [developer]);
  assert.equal(harness.controls[0]?.state, "missing_dependency"); assert.equal(harness.controls[0]?.command, null);
  // The development policy admits it, classified as outside every channel.
  const any = await service({ validateOverride: () => {}, enumerate: async () => enumeration }).execute([definition]);
  assert.equal(any.harnesses[0]!.installation.candidates[0]?.channel, null); assert.deepEqual(any.harnesses[0]!.installation.unofficial, []);
  assert.equal(any.harnesses[0]!.controls[0]?.state, "candidate");
});
test("G012-OC2 an official installation later in search order is used when the PATH default is not official; a blocked default still selects nothing", async () => {
  const developer = at("/bin/demo-acp", "/home/me/src/demo/cli.js"), official = at("/home/me/.nvm/versions/node/v26/bin/demo-acp", "/official/demo-acp/cli.js", "known-directory");
  const enumeration: InstallationEnumeration = { candidates: [developer, official], selected: developer, defaultResolution: "located", diagnostics: [] };
  const report = await service({ validateOverride: () => {}, enumerate: async () => enumeration }, nonePackage, "official").execute([definition]);
  const control = report.harnesses[0]!.controls[0]!;
  assert.equal(control.installation.selected?.resolvedPath, "/official/demo-acp/cli.js");
  assert.deepEqual(control.installation.selected && { channel: control.installation.selected.channel?.kind, version: control.installation.selected.version, role: control.installation.selected.role }, { channel: "npm", version: "1.2.3", role: "adapter" });
  assert.equal(control.command?.executable, official.path);
  const blocked = await service({ validateOverride: () => {}, enumerate: async () => ({ ...enumeration, selected: null, defaultResolution: "blocked" }) }, nonePackage, "official").execute([definition]);
  assert.equal(blocked.harnesses[0]!.controls[0]!.state, "blocked"); assert.equal(blocked.harnesses[0]!.controls[0]!.installation.selected, null);
});
test("G012-OC2 under the official policy neither an explicit entry nor a package outside every channel counts", async () => {
  const explicit = at("/fixtures/demo-acp", "/fixtures/demo-acp", "override");
  const report = await service({ validateOverride: () => {}, enumerate: async (_names, override) => override ? { candidates: [explicit], selected: explicit, defaultResolution: "located", diagnostics: [] } : absent }, nonePackage, "official")
    .execute([definition], new Map([["demo-acp", { executable: "/fixtures/demo-acp" }]]));
  assert.equal(report.harnesses[0]!.controls[0]!.state, "missing_dependency"); assert.deepEqual(report.harnesses[0]!.controls[0]!.installation.unofficial, [explicit]);
  const withPackage = { ...definition, controls: definition.controls.map(control => ({ ...control, package: { kind: "npm" as const, name: "demo", version: "1.0.0", binNames: [] } })) };
  const packaged = (bin: string) => ({ observe: async () => [], resolve: async () => ({ command: { executable: "/node", args: [bin], env: {} }, diagnostics: [] }) });
  const outside = await service({ validateOverride: () => {}, enumerate: async () => absent }, packaged("/roots/demo/bin.js"), "official").execute([withPackage]);
  assert.equal(outside.harnesses[0]!.controls[0]!.command, null);
  const inside = await service({ validateOverride: () => {}, enumerate: async () => absent }, packaged("/official/demo-acp/bin.js"), "official").execute([withPackage]);
  assert.deepEqual(inside.harnesses[0]!.controls[0]!.command?.args, ["/official/demo-acp/bin.js", "acp"]);
});
