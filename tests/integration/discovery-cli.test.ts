import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { catalogTarget } from "../../src/cli/catalog.js";

const discover = fileURLToPath(new URL("../../src/cli/discover.js", import.meta.url));
const catalog = fileURLToPath(new URL("../../src/cli/catalog.js", import.meta.url));
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "catalog-cli-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function invoke(cli: string, args: readonly string[], root: string) {
  return spawnSync(process.execPath, [cli, ...args], { env: { PATH: root, HOME: root }, encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
}
test("compiled default catalog/discovery includes 43 products and 47 controls without launching candidates", async (t) => {
  const root = await fixture(t), sentinel = join(root, "started");
  await writeFile(join(root, "codex"), "#!/bin/sh\nprintf started > '" + sentinel + "'\n"); await chmod(join(root, "codex"), 0o700);
  const listed = invoke(catalog, ["--json"], root); assert.equal(listed.status, 0, listed.stderr);
  const catalogData: unknown = JSON.parse(listed.stdout);
  assert.ok(catalogData && typeof catalogData === "object" && "definitions" in catalogData && Array.isArray(catalogData.definitions));
  assert.equal(catalogData.definitions.length, 43);
  const observed = invoke(discover, ["--json", "--path-only"], root); assert.equal(observed.status, 0, observed.stderr);
  const data: unknown = JSON.parse(observed.stdout);
  assert.ok(data && typeof data === "object" && "schemaVersion" in data && "harnesses" in data && Array.isArray(data.harnesses));
  assert.equal(data.schemaVersion, 2); assert.equal(data.harnesses.length, 43);
  assert.equal(data.harnesses.reduce((n: number, item: { controls: unknown[] }) => n + item.controls.length, 0), 47);
  assert.match(observed.stdout, /"id": "codex-native"/); assert.match(observed.stdout, /"probe": "not_run"/);
  await assert.rejects(() => readFile(sentinel), { code: "ENOENT" });
});
test("default discovery migrates v1 custom input while explicit legacy output remains schema1", async (t) => {
  const root = await fixture(t), manifest = join(root, "manifest.json"), executable = join(root, "custom");
  await writeFile(executable, "#!/bin/sh\nexit 91\n"); await chmod(executable, 0o700);
  await writeFile(manifest, JSON.stringify({ version: 1, recipes: [{ id: "custom", name: "Custom", binary: "custom", protocol: "acp-v1", args: [] }], overrides: { custom: { binary: executable } } }));
  const modern = invoke(discover, ["--json", "--path-only", "--manifest", manifest], root);
  assert.equal(modern.status, 0, modern.stderr); assert.match(modern.stdout, /"schemaVersion": 2/); assert.match(modern.stdout, /"id": "custom-legacy"/);
  const legacy = invoke(discover, ["--legacy", "--json", "--path-only", "--manifest", manifest], root);
  assert.equal(legacy.status, 0, legacy.stderr); assert.match(legacy.stdout, /"schemaVersion": 1/);
});
test("unknown overrides and empty v2 CLI inputs fail before producing a report", async (t) => {
  const root = await fixture(t), manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ version: 2, overrides: { unknown: { executable: "/not/a/program" } } }));
  for (const args of [["--json", "--path-only", "--manifest", manifest], ["--manifest="], ["--package-root", "relative"]]) {
    const result = invoke(discover, args, root); assert.equal(result.status, 2, result.stderr); assert.equal(result.stdout, "");
  }
});
test("host label conversion is explicit and unsupported catalog hosts reject", () => {
  assert.equal(catalogTarget("darwin", "arm64"), "darwin-aarch64");
  assert.equal(catalogTarget("linux", "x64"), "linux-x86_64");
  assert.throws(() => catalogTarget("unknown", "arm64"), /unsupported/);
  assert.throws(() => catalogTarget("darwin", "unknown"), /unsupported/);
});
