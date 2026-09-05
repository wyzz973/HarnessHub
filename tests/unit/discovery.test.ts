import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { discoverEngines } from "../../src/engine/discovery.js";
import { normalizeEngine } from "../../src/engine/registry.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "harnesshub-discovery-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "HarnessHub");
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await Promise.all([cwd, home, bin].map((location) => mkdir(location)));
  const options = {
    cwd,
    home,
    pathEnv: bin,
    nodeExecutable: process.execPath,
    systemBinDirectories: [],
  };
  return { directory, cwd, home, bin, options };
}

async function file(location: string, executable = false): Promise<void> {
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, "# discovery must never execute this fixture\n");
  if (executable) await chmod(location, 0o700);
}

void test("discovery checks executable installation evidence and adapter presence without running programs", async (t) => {
  const { cwd, bin, options } = await fixture(t);
  const marker = path.join(cwd, "must-not-exist");
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh\nprintf executed > '${marker}'\n`);
  await chmod(codex, 0o700);
  await file(path.join(bin, "opencode"), true);
  await file(path.join(bin, "claude"));
  await mkdir(path.join(bin, "openclaw"));
  const before = await discoverEngines(options);
  assert.deepEqual(
    before.map((candidate) => candidate.id),
    ["codex", "opencode"],
  );
  assert.equal(before[0]?.status, "adapter-required");
  assert.equal(before[0]?.registration, undefined);
  assert.equal(before[1]?.registration?.command.at(-1), "acp");
  assert.equal(before[1]?.source, "path");
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  const adapter = path.join(
    cwd,
    ".tools/adapters/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
  );
  await file(adapter);
  const after = await discoverEngines(options);
  assert.equal(after[0]?.status, "ready");
  assert.deepEqual(after[0]?.registration?.command.slice(-2), [
    process.execPath,
    adapter,
  ]);
  assert.ok(after[0]?.registration?.command.includes(`CODEX_PATH=${codex}`));
  assert.equal(after[0]?.registration?.model, undefined);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

void test("mainstream harnesses are found outside a GUI PATH and scans observe installs/removals without execution", async (t) => {
  const { home, bin, options } = await fixture(t);
  const hermes = path.join(home, ".local/bin/hermes");
  const mimo = path.join(home, ".mimocode/bin/mimo");
  const cursor = path.join(home, ".local/bin/cursor-agent");
  await file(hermes, true);
  await file(mimo, true);
  await file(cursor, true);
  await file(path.join(bin, "gemini"), true);
  const found = await discoverEngines(options);
  assert.equal(found.find((c) => c.id === "hermes")?.executable, hermes);
  assert.equal(found.find((c) => c.id === "mimo")?.executable, mimo);
  assert.equal(
    found.find((c) => c.id === "cursor")?.registration?.driver,
    "cli",
  );
  assert.equal(
    found.find((c) => c.id === "gemini")?.registration?.command.at(-1),
    "--acp",
  );
  await rm(mimo);
  await file(path.join(bin, "kimi"), true);
  const next = await discoverEngines(options);
  assert.equal(
    next.some((c) => c.id === "mimo"),
    false,
  );
  assert.equal(
    next.find((c) => c.id === "kimi")?.registration?.command.at(-1),
    "acp",
  );
});

void test("discovery uses PATH precedence, home installations and sibling DSH with existing reference patch", async (t) => {
  const { directory, cwd, home, bin, options } = await fixture(t);
  await file(path.join(bin, "opencode"), true);
  await file(path.join(home, ".opencode/bin/opencode"), true);
  await file(path.join(home, ".local/bin/openclaw"), true);
  const dsh = path.join(directory, "deepseek-harness/apps/cli/lib/bin.js");
  await file(dsh);
  await file(path.join(cwd, "scripts/launch-dsh-acp.mjs"));
  const patch = path.join(cwd, "engines/dsh-local.patch.yaml");
  await file(patch);
  await writeFile(patch, "not: [valid YAML\n");
  const found = await discoverEngines(options);
  assert.equal(
    found.find((candidate) => candidate.id === "opencode")?.executable,
    path.join(bin, "opencode"),
  );
  assert.equal(
    found.find((candidate) => candidate.id === "openclaw")?.source,
    "known-location",
  );
  const engine = found.find((candidate) => candidate.id === "dsh");
  assert.equal(engine?.source, "known-location");
  assert.deepEqual(engine?.registration?.command, [
    process.execPath,
    path.join(cwd, "scripts/launch-dsh-acp.mjs"),
    dsh,
    "--profile",
    "acp",
    "--patch",
    patch,
  ]);
  // The patch deliberately is not valid YAML: discovery must not inspect it or credentials.
  assert.equal(await readFile(patch, "utf8"), "not: [valid YAML\n");
});

void test("new JSON manifests are discovered immediately and relative executable paths are pinned", async (t) => {
  const { cwd, bin, options } = await fixture(t);
  const manifestDir = path.join(cwd, "engines/manifests");
  assert.deepEqual(await discoverEngines(options), []);
  await mkdir(manifestDir, { recursive: true });
  const executable = path.join(bin, "custom-agent");
  await file(executable, true);
  await writeFile(
    path.join(manifestDir, "custom.json"),
    JSON.stringify({
      name: "My agent",
      registration: {
        id: "custom",
        driver: "cli",
        command: [path.relative(manifestDir, executable)],
        cli: { inputMode: "stdin" },
        credentialEnv: ["CUSTOM_API_KEY"],
      },
    }),
  );
  const [candidate] = await discoverEngines(options);
  assert.equal(candidate?.id, "custom");
  assert.equal(candidate?.name, "My agent");
  assert.equal(candidate?.source, "manifest");
  assert.equal(candidate?.registration?.driver, "cli");
  assert.deepEqual(candidate?.registration?.command, [executable]);
  assert.deepEqual(candidate?.registration?.credentialEnv, ["CUSTOM_API_KEY"]);
  assert.equal(candidate?.registration?.cli?.maxOutputBytes, 4 * 1024 * 1024);
});

void test("bad manifest schemas, unavailable commands, duplicate IDs and non-files fail explicitly", async (t) => {
  const { cwd, bin, options } = await fixture(t);
  const manifestDir = path.join(cwd, "engines/manifests");
  await mkdir(manifestDir, { recursive: true });
  await file(path.join(bin, "opencode"), true);
  const location = path.join(manifestDir, "custom.json");
  const registration = {
    id: "custom",
    driver: "acp",
    command: ["opencode", "acp"],
  };
  for (const value of [
    "{",
    JSON.stringify({ registration, typo: true }),
    JSON.stringify({ registration: { ...registration, typo: true } }),
    JSON.stringify({ registration: { ...registration, driver: "sdk" } }),
    JSON.stringify({
      registration: { ...registration, command: ["missing-engine"] },
    }),
  ]) {
    await writeFile(location, value);
    await assert.rejects(discoverEngines(options), {
      code: "INVALID_ENGINE_MANIFEST",
    });
  }
  await rm(location);
  await mkdir(location);
  await assert.rejects(discoverEngines(options), {
    code: "INVALID_ENGINE_MANIFEST",
  });
  await rm(location, { recursive: true });
  await writeFile(location, " ".repeat(65_537));
  await assert.rejects(discoverEngines(options), {
    code: "INVALID_ENGINE_MANIFEST",
  });
});

void test("local manifests replace built-in recipes without losing custom configuration; duplicate manifests fail", async (t) => {
  const { cwd, bin, options } = await fixture(t);
  await file(path.join(bin, "mimo"), true);
  const manifestDir = path.join(cwd, "engines/manifests");
  await mkdir(manifestDir, { recursive: true });
  const manifest = JSON.stringify({
    name: "My MiMo",
    registration: {
      id: "mimo",
      driver: "acp",
      command: ["mimo", "acp"],
      model: "custom/model",
    },
  });
  await writeFile(path.join(manifestDir, "mimo.json"), manifest);
  const found = await discoverEngines(options);
  assert.equal(found.filter((c) => c.id === "mimo").length, 1);
  assert.equal(found[0]?.source, "manifest");
  assert.equal(found[0]?.registration?.model, "custom/model");
  await writeFile(path.join(manifestDir, "duplicate.json"), manifest);
  await assert.rejects(discoverEngines(options), {
    code: "INVALID_ENGINE_MANIFEST",
  });
});

void test("package-manager paths, executable permissions and Pi adapter evidence remain distinct", async (t) => {
  const { cwd, home, bin, options } = await fixture(t);
  const systemBin = path.join(cwd, "homebrew/bin");
  await file(path.join(systemBin, "gemini"), true);
  await file(path.join(home, ".volta/bin/qwen"), true);
  await file(path.join(home, ".local/bin/hermes"));
  await symlink(path.join(bin, "missing"), path.join(bin, "mimo"));
  await file(path.join(bin, "pi"), true);
  let found = await discoverEngines({
    ...options,
    systemBinDirectories: [systemBin],
  });
  assert.equal(found.find((c) => c.id === "gemini")?.source, "known-location");
  assert.equal(found.find((c) => c.id === "qwen")?.source, "known-location");
  assert.equal(
    found.some((c) => c.id === "hermes" || c.id === "mimo"),
    false,
  );
  assert.equal(found.find((c) => c.id === "pi")?.status, "adapter-required");
  await file(path.join(cwd, ".tools/pi/node_modules/pi-acp/dist/index.js"));
  await file(path.join(bin, "gemini"), true);
  found = await discoverEngines({
    ...options,
    systemBinDirectories: [systemBin],
  });
  assert.equal(
    found.find((c) => c.id === "gemini")?.executable,
    path.join(bin, "gemini"),
  );
  const pi = found.find((c) => c.id === "pi");
  assert.equal(pi?.status, "ready");
  assert.ok(
    pi?.registration?.command.includes(
      `PI_ACP_PI_COMMAND=${path.join(bin, "pi")}`,
    ),
  );
  for (const candidate of found) {
    assert.ok(candidate.registration);
    assert.doesNotThrow(() => normalizeEngine(candidate.registration));
  }
});
