import assert from "node:assert/strict";
import test from "node:test";
import { DiscoveryInputError, parseDiscoveryManifest } from "../../src/contexts/catalog/domain/discovery.js";
import { migrateLegacyManifest, parseCatalogManifest, validateDefinitions } from "../../src/contexts/catalog/domain/catalog-parser.js";
import { MAX_CONTROLS, MAX_DEFINITIONS, type HarnessDefinition } from "../../src/contexts/catalog/domain/catalog.js";
import { loadBuiltinCatalog } from "../../src/adapters/catalog.js";

const definition: HarnessDefinition = {
  id: "example", name: "Example", aliases: ["example-cli"], binaryNames: ["example"], configHints: [".config/example"],
  controls: [{ id: "example-acp", protocol: "acp-v1", executableNames: ["example"], args: ["--acp"], env: {}, package: null, distribution: null, requiredExecutables: [],
    source: { repository: "example/harness", revision: "revision", upstreamId: "example", url: "https://example.com/harness" } }],
};
const valid = { version: 2, definitions: [definition], overrides: { "example-acp": { executable: "/opt/example" } }, installationOverrides: { example: "/opt/native-example" } };
function copy(): Record<string, unknown> { return structuredClone(valid); }

test("v2 preserves product, control, configuration and explicit override identities", () => {
  const manifest = parseCatalogManifest(valid);
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.definitions[0]?.aliases, ["example-cli"]);
  assert.equal(manifest.overrides.get("example-acp")?.executable, "/opt/example");
  assert.equal(manifest.installationOverrides.get("example"), "/opt/native-example");
  assert.equal(parseCatalogManifest({ version: 2 }).overrides.size, 0);
  assert.equal(parseCatalogManifest({ version: 2 }).installationOverrides.size, 0);
});

test("v2 rejects wrong types, versions and unknown external fields at every boundary", () => {
  for (const value of [null, [], { version: 1 }, { version: 3 }, { version: 2, extra: true },
    { version: 2, definitions: null }, { version: 2, overrides: null }, { version: 2, installationOverrides: null },
    { version: 2, overrides: { bad: { executable: "/bin/x", secret: "x" } } },
    { version: 2, overrides: { bad: { executable: "relative" } } },
    { version: 2, installationOverrides: { bad: "relative" } },
    { version: 2, definitions: [{ ...definition, extra: true }] },
    { version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], protocol: "unknown" }] }] },
    { version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], extra: true }] }] },
    { version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], source: { ...definition.controls[0]?.source, extra: true } }] }] },
    { version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], source: { ...definition.controls[0]?.source, url: "urn:arbitrary:source" } }] }] },
    { version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], source: { ...definition.controls[0]?.source, url: "urn:harnessgateway:operator-manifest:v1" } }] }] },
  ]) assert.throws(() => parseCatalogManifest(value), DiscoveryInputError);
});

test("duplicate products, selection aliases and control identities never silently merge", () => {
  assert.throws(() => validateDefinitions([definition, definition]), /duplicate/);
  assert.throws(() => validateDefinitions([definition, { ...definition, id: "example-cli", aliases: [], controls: [] }]), /alias/);
  assert.throws(() => validateDefinitions([{ ...definition, aliases: ["example"] }]), /alias/);
  assert.throws(() => validateDefinitions([definition, { ...definition, id: "other", aliases: [] }]), /control id/);
  assert.throws(() => validateDefinitions([{ ...definition, binaryNames: ["example", "example"] }]), /duplicate/);
  assert.throws(() => validateDefinitions([{ ...definition, controls: [definition.controls[0]!, definition.controls[0]!] }]), /duplicate/);
});

test("bounded product, control, argv and environment collections reject excess input", () => {
  const all = Array.from({ length: MAX_DEFINITIONS }, (_, index) => ({ ...definition, id: "h-" + index, aliases: [], controls: [] }));
  validateDefinitions(all);
  assert.throws(() => validateDefinitions([...all, { ...definition, id: "last", aliases: [], controls: [] }]), /too many/);
  const controls = Array.from({ length: MAX_CONTROLS }, (_, index) => ({ ...definition.controls[0]!, id: "c-" + index }));
  const products = Array.from({ length: 17 }, (_, index) => ({ ...definition, id: "p-" + index, aliases: [], controls: controls.slice(index * 16, (index + 1) * 16) }));
  validateDefinitions(products);
  assert.throws(() => validateDefinitions([...products, { ...definition, id: "extra", aliases: [] }]), /too many control/);
  assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], args: Array(33).fill("x") }] }] }), /bounded array/);
  assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["E" + index, "x"])) }] }] }), /too many/);
});

test("path traversal, shell executable strings, malformed packages and mixed distributions reject", () => {
  const control = definition.controls[0]!;
  for (const hint of ["/absolute", "../escape", "a/../escape", "a\\escape", "C:/escape", "a//b"]) {
    assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, configHints: [hint] }] }), /relative path/);
    assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...control, distribution: { kind: "binary", archive: "https://example.com/archive", relativeExecutable: hint } }] }] }), /relative path/);
  }
  for (const executableNames of [["npx thing"], ["../thing"], ["/bin/thing"]]) assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...control, executableNames }] }] }), /executable name/);
  for (const change of [
    { package: { kind: "guess", name: "thing", version: "1", binNames: [] } },
    { package: { kind: "npm", name: "thing@latest", version: "1", binNames: [] } },
    { package: { kind: "npm", name: "thing", version: "1", binNames: [], unknown: true } },
    { distribution: { kind: "npm", packageSpec: "thing@1", archive: "https://example.com/archive" } },
    { package: { kind: "npm", name: "thing", version: "1", binNames: [] }, distribution: { kind: "python", packageSpec: "thing==1" } },
    { distribution: { kind: "binary", archive: "https://example.com/archive", relativeExecutable: "thing", sha256: "bad" } },
    { env: { "INVALID-KEY": "x" } },
  ]) assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...control, ...change }] }] }), DiscoveryInputError);
});

test("literal argv and environment are data; repeated options and empty arguments remain valid", () => {
  const manifest = parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...definition.controls[0], args: ["--option", "one", "--option", "", "x; touch marker"], env: { EMPTY: "" } }] }] });
  assert.deepEqual(manifest.definitions[0]?.controls[0]?.args, ["--option", "one", "--option", "", "x; touch marker"]);
  assert.equal(manifest.definitions[0]?.controls[0]?.env.EMPTY, "");
  const mutated = copy(); mutated.overrides = { "bad\n": { executable: "/bin/x" } };
  assert.throws(() => parseCatalogManifest(mutated), DiscoveryInputError);
});

test("executable names share the installation resolver's exact 64-character boundary", () => {
  const bounded = "a".repeat(64), excessive = "a".repeat(65);
  const base = definition.controls[0]!;
  const controls = [{ ...base, executableNames: [bounded], requiredExecutables: [bounded],
    package: { kind: "npm" as const, name: "example", version: "1", binNames: [bounded] } }];
  parseCatalogManifest({ version: 2, definitions: [{ ...definition, binaryNames: [bounded], controls }] });
  for (const altered of [
    { ...definition, binaryNames: [excessive] },
    { ...definition, controls: [{ ...base, executableNames: [excessive] }] },
    { ...definition, controls: [{ ...base, requiredExecutables: [excessive] }] },
    { ...definition, controls: [{ ...base, package: { kind: "npm", name: "example", version: "1", binNames: [excessive] } }] },
  ]) assert.throws(() => parseCatalogManifest({ version: 2, definitions: [altered] }), DiscoveryInputError);
});

test("configuration and distribution paths must identify a child rather than the root itself", () => {
  const control = definition.controls[0]!;
  for (const path of [".", "./.", "././."]) {
    assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, configHints: [path] }] }), /relative path/);
    assert.throws(() => parseCatalogManifest({ version: 2, definitions: [{ ...definition, controls: [{ ...control,
      distribution: { kind: "binary", archive: "https://example.com/archive", relativeExecutable: path } }] }] }), /relative path/);
  }
  parseCatalogManifest({ version: 2, definitions: [{ ...definition, configHints: ["./.config/example"], controls: [{ ...control,
    distribution: { kind: "binary", archive: "https://example.com/archive", relativeExecutable: "./bin/example" } }] }] });
});

test("v1 custom recipes retain native and adapter override semantics during migration", () => {
  const legacy = parseDiscoveryManifest({ version: 1, recipes: [{ id: "example", name: "Example", binary: "example", protocol: "acp-v1", args: ["acp"], adapterBinary: "example-acp" }], overrides: { example: { binary: "/native/example", adapter: "/adapter/example" } } });
  const migrated = migrateLegacyManifest(legacy, []);
  assert.equal(migrated.installationOverrides.get("example"), "/native/example");
  assert.equal(migrated.overrides.get("example-legacy")?.executable, "/adapter/example");
  assert.deepEqual(migrated.definitions[0]?.controls[0]?.requiredExecutables, ["example"]);
  assert.equal(migrated.definitions[0]?.controls[0]?.source.url, "urn:harnessgateway:operator-manifest:v1");
  validateDefinitions(migrated.definitions);
});

test("v1 builtin overrides bind to actual controls and optional wrappers keep independent runtime", () => {
  const builtins = loadBuiltinCatalog("darwin-aarch64");
  const migrated = migrateLegacyManifest(parseDiscoveryManifest({ version: 1, overrides: { codex: { binary: "/native/codex" }, claude: { binary: "/native/claude", adapter: "/adapter/claude" }, pi: { binary: "/native/pi" } } }), builtins);
  assert.equal(migrated.definitions.length, 0);
  assert.equal(migrated.overrides.get("codex-native")?.executable, "/native/codex");
  assert.equal(migrated.overrides.get("pi-native")?.executable, "/native/pi");
  assert.equal(migrated.overrides.get("claude-acp-npm")?.executable, "/adapter/claude");
  assert.equal(migrated.installationOverrides.get("claude"), "/native/claude");
});

test("v1 migration rejects invalid, unknown, unused and ambiguous overrides before IO", () => {
  const builtins = loadBuiltinCatalog("darwin-aarch64");
  for (const overrides of [ { missing: { binary: "/bin/x" } }, { codex: { adapter: "/bin/x" } }, { claude: { adapter: "relative" } } ])
    assert.throws(() => migrateLegacyManifest(parseDiscoveryManifest({ version: 1, overrides }), builtins), DiscoveryInputError);
  const duplicate = parseDiscoveryManifest({ version: 1, recipes: [{ id: "codex", name: "Codex", binary: "codex", protocol: "acp-v1", args: [] }] });
  assert.throws(() => migrateLegacyManifest(duplicate, builtins), /duplicate/);
});
