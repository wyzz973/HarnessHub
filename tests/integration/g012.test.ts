import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DiscoverHarnesses } from "../../src/contexts/catalog/application/discover.js";
import { MAX_MANIFEST_BYTES, type HarnessRecipe } from "../../src/contexts/catalog/domain/discovery.js";
import { LocalExecutableLocator } from "../../src/infrastructure/discovery/local.js";
import { readManifest } from "../../src/cli/discover.js";

const recipe: HarnessRecipe = { id: "example", name: "Example", binary: "example", protocol: "acp-v1", args: ["acp"] };
const cli = fileURLToPath(new URL("../../src/cli/discover.js", import.meta.url));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harness-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(file: string, content = "#!/bin/sh\nexit 91\n") {
  await writeFile(file, content);
  await chmod(file, 0o700);
}

test("PATH priority, symlink identity and explicit overrides are preserved", async (t) => {
  const root = await fixture(t), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await executable(join(second, "example"));
  await symlink(join(second, "example"), join(first, "example"));
  const locator = new LocalExecutableLocator([{ path: first, source: "path" }, { path: second, source: "path" }]);
  const found = await locator.lookup("example", undefined);
  assert.equal(found.status, "found");
  if (found.status !== "found") throw new Error("expected candidate");
  assert.equal(found.path, join(first, "example"));
  assert.equal(found.resolvedPath, await realpath(join(second, "example")));
  const override = await locator.lookup("example", join(second, "example"));
  assert.equal(override.status === "found" && override.source, "override");
});

test("an invalid explicit override never falls back to a valid PATH entry", async (t) => {
  const root = await fixture(t);
  await executable(join(root, "example"));
  const locator = new LocalExecutableLocator([{ path: root, source: "path" }]);
  const result = await locator.lookup("example", join(root, "missing"));
  assert.equal(result.status, "missing");
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]?.path, join(root, "missing"));
  await assert.rejects(() => locator.lookup("example", "relative/example"), /absolute/);
});

test("all overrides are validated even if a required native CLI is missing", async (t) => {
  const root = await fixture(t);
  const service = new DiscoverHarnesses(new LocalExecutableLocator([{ path: root, source: "path" }]), () => new Date(0));
  await assert.rejects(
    () => service.execute(
      [{ ...recipe, adapterBinary: "example-acp" }],
      new Map([["example", { adapter: "relative/adapter" }]]),
    ),
    /absolute/,
  );
});

test("directories, nonexecutable files and broken symlinks do not become candidates", async (t) => {
  const root = await fixture(t);
  const locator = new LocalExecutableLocator([{ path: root, source: "path" }]);
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "plain"), "not executable"); await chmod(join(root, "plain"), 0o600);
  await symlink(join(root, "missing-target"), join(root, "broken"));
  assert.equal((await locator.lookup("folder", undefined)).status, "unavailable");
  assert.equal((await locator.lookup("plain", undefined)).status, "unavailable");
  assert.equal((await locator.lookup("broken", undefined)).status, "missing");
});

test("a later valid candidate is found after a nonexecutable shadow", async (t) => {
  const root = await fixture(t), first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, "example"), "not executable"); await chmod(join(first, "example"), 0o600);
  await executable(join(second, "example"));
  const found = await new LocalExecutableLocator([{ path: first, source: "path" }, { path: second, source: "configured-directory" }]).lookup("example", undefined);
  assert.equal(found.status, "found");
  if (found.status !== "found") throw new Error("expected candidate");
  assert.equal(found.path, join(second, "example"));
  assert.equal(found.notes[0]?.code, "not_executable");
});

test("known user bins and external adapters resolve through the same port", async (t) => {
  const root = await fixture(t);
  await executable(join(root, "example"));
  await executable(join(root, "example-acp"));
  const report = await new DiscoverHarnesses(
    new LocalExecutableLocator([{ path: root, source: "known-directory" }]), () => new Date(0),
  ).execute([{ ...recipe, adapterBinary: "example-acp" }]);
  const harness = report.harnesses[0];
  assert.equal(harness?.control.state, "candidate");
  assert.equal(harness?.control.command?.executable, join(root, "example-acp"));
  assert.equal(harness?.installation.status === "found" && harness.installation.source, "known-directory");
  assert.equal(report.observedAt, "1970-01-01T00:00:00.000Z");
});

test("manifest reads enforce regular files, size and UTF-8 JSON", async (t) => {
  const root = await fixture(t), file = join(root, "manifest.json");
  await writeFile(file, JSON.stringify({ version: 1, recipes: [recipe] }));
  assert.equal((await readManifest(file)).recipes[0]?.id, "example");
  await writeFile(file, '{"version":1}' + " ".repeat(MAX_MANIFEST_BYTES - 13));
  assert.equal((await readManifest(file)).recipes.length, 0);
  await writeFile(file, " ".repeat(MAX_MANIFEST_BYTES + 1));
  await assert.rejects(() => readManifest(file), /64 KiB/);
  await writeFile(file, Buffer.from([0xff]));
  await assert.rejects(() => readManifest(file), /UTF-8 JSON/);
  await writeFile(file, "broken");
  await assert.rejects(() => readManifest(file), /UTF-8 JSON/);
  const link = join(root, "link.json"); await symlink(file, link);
  await assert.rejects(() => readManifest(link));
  await assert.rejects(() => readManifest(root), /regular file/);
});

test("compiled CLI detects without executing or querying the candidate", async (t) => {
  const root = await fixture(t), sentinel = join(root, "launched");
  await executable(join(root, "codex"), "#!/bin/sh\nprintf launched > '" + sentinel + "'\nexit 91\n");
  const result = spawnSync(process.execPath, [cli, "--json", "--path-only"], {
    env: { PATH: root, HOME: root, LANG: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const report: unknown = JSON.parse(result.stdout);
  assert.ok(report && typeof report === "object" && "harnesses" in report && Array.isArray(report.harnesses));
  const codex: unknown = report.harnesses.find((item: unknown) => item && typeof item === "object" && "id" in item && item.id === "codex");
  assert.ok(codex && typeof codex === "object" && "control" in codex);
  assert.match(JSON.stringify(codex), /candidate/);
  await assert.rejects(() => readFile(sentinel), { code: "ENOENT" });
  assert.equal(result.stderr, "");
});

test("compiled CLI loads a custom Harness and honors its full path", async (t) => {
  const root = await fixture(t), manifest = join(root, "manifest.json"), binary = join(root, "custom");
  await executable(binary);
  await writeFile(manifest, JSON.stringify({ version: 1, recipes: [{ ...recipe, id: "custom", binary: "not-on-path" }], overrides: { custom: { binary } } }));
  const result = spawnSync(process.execPath, [cli, "--json", "--path-only", "--manifest", manifest], {
    env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"id": "custom"/);
  assert.match(result.stdout, /"source": "override"/);
  assert.match(result.stdout, /"probe": "not_run"/);
});

test("compiled CLI rejects invalid or oversized manifests with a nonzero exit", async (t) => {
  const root = await fixture(t), manifest = join(root, "bad.json");
  for (const content of ["broken", JSON.stringify({ version: 9 }), " ".repeat(MAX_MANIFEST_BYTES + 1)]) {
    await writeFile(manifest, content);
    const result = spawnSync(process.execPath, [cli, "--json", "--path-only", "--manifest", manifest], {
      env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /HarnessGateway:/);
  }
});

test("compiled CLI help and invalid options do not scan or launch candidates", async (t) => {
  const root = await fixture(t);
  for (const [args, expected] of [[["--help"], 0], [["--unknown"], 2]] as const) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, expected);
    if (expected === 0) assert.match(result.stdout, /只读检测/);
    else assert.equal(result.stdout, "");
  }
});

test("compiled CLI rejects an explicitly empty manifest instead of using defaults", async (t) => {
  const root = await fixture(t);
  for (const args of [["--manifest="], ["--manifest", ""]]) {
    const result = spawnSync(process.execPath, [cli, "--json", "--path-only", ...args], {
      env: { PATH: "", HOME: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /must name a file/);
  }
});
