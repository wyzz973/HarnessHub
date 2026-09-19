import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  kitLayout,
  listEngines,
  offlineEnvironment,
  setupPlan,
  verifyKit,
} from "./competition-offline.mjs";
import { preparationOptions, preparationSteps } from "./prepare-contest.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("offline setup plan uses only kit-local inputs and blocks registry access", async (t) => {
  const kit = path.join(os.tmpdir(), "HH kit");
  const layout = kitLayout(kit);
  const staging = path.join(kit, "competition.staging-test");
  const plan = setupPlan(layout, staging, { install: true });
  assert.deepEqual(
    plan.map((step) => step.id),
    ["dependencies", "build", "build-console", "package", "overlay"],
  );
  for (const step of plan) {
    assert.equal(step.command, layout.node);
    assert.equal(step.cwd, layout.repository);
  }
  for (const flag of [
    "--offline",
    "--frozen-lockfile",
    "--config.node-linker=hoisted",
    "--package-import-method=copy",
  ])
    assert.ok(plan[0].args.includes(flag), flag);
  assert.equal(
    plan[0].args[plan[0].args.indexOf("--store-dir") + 1],
    layout.store,
  );
  const packaging = plan.find((step) => step.id === "package").args;
  assert.ok(packaging.includes("--runtime-only"));
  assert.equal(packaging[packaging.indexOf("--prepared") + 1], layout.prepared);
  assert.equal(packaging[packaging.indexOf("--output") + 1], staging);
  assert.deepEqual(
    setupPlan(layout, staging, { install: false }).map((step) => step.id),
    ["build", "build-console", "package", "overlay"],
  );
  const env = offlineEnvironment(
    {
      Path: "C:\\Tools",
      npm_config_registry: "https://registry.npmjs.org/",
      NPM_CONFIG_PROXY: "http://corp:8080",
      SystemRoot: "C:\\Windows",
    },
    layout,
    "win32",
  );
  assert.equal(env.npm_config_registry, "http://127.0.0.1:9/");
  assert.equal(env.npm_config_offline, "true");
  assert.equal(env.NPM_CONFIG_PROXY, undefined);
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH.split(";")[0], path.dirname(layout.node));
  assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
  for (const host of [
    { platform: "linux", arch: "x64", versions: { node: "24.20.0" } },
    { platform: "win32", arch: "arm64", versions: { node: "24.20.0" } },
    { platform: "win32", arch: "x64", versions: { node: "24.20.1" } },
  ])
    await assert.rejects(verifyKit(layout, host), /Windows x64/);
  await assert.rejects(
    verifyKit(layout, {
      platform: "win32",
      arch: "x64",
      versions: { node: "24.20.0" },
    }),
    /Offline kit is incomplete/,
  );
  const bundle = await mkdtemp(path.join(os.tmpdir(), "hh-engines-"));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  await writeFile(
    path.join(bundle, "bundle.json"),
    JSON.stringify({
      engines: [
        { id: "opencode", name: "OpenCode", version: "1.18.29" },
        { id: "hermes", name: "Hermes Agent" },
      ],
    }),
  );
  assert.deepEqual(
    (await listEngines(bundle)).map((engine) => engine.id),
    ["opencode", "hermes"],
  );
  await writeFile(path.join(bundle, "bundle.json"), "{}");
  await assert.rejects(listEngines(bundle), /no engine list/);
});

test("contest preparation can skip unhashed binaries and use an installed 7-Zip without changing the default plan", () => {
  const host = {
    platform: "win32",
    arch: "x64",
    machine: "x86_64",
    version: "24.20.0",
  };
  const options = preparationOptions(
    [
      "--skip-binaries",
      "cursor,antigravity",
      "--seven-zip",
      "C:\\Program Files\\7-Zip\\7z.exe",
    ],
    host,
  );
  assert.deepEqual(options.skipBinaries, ["cursor", "antigravity"]);
  assert.equal(options.sevenZip, "C:\\Program Files\\7-Zip\\7z.exe");
  assert.deepEqual(preparationOptions([], host).skipBinaries, []);
  for (const args of [
    ["--skip-binaries", "Cursor"],
    ["--skip-binaries", "cursor,cursor"],
    ["--seven-zip", "7z.exe"],
    ["--seven-zip", "C:\\tools\\unzip.exe"],
  ])
    assert.throws(
      () => preparationOptions(args, host),
      undefined,
      JSON.stringify(args),
    );
  const root = path.join(repo, ".tmp", "plan");
  const plain = preparationSteps(root, "x64", "C:\\pnpm.cjs", "C:\\node.exe");
  const extended = preparationSteps(
    root,
    "x64",
    "C:\\pnpm.cjs",
    "C:\\node.exe",
    { skipBinaries: ["cursor", "antigravity"], sevenZip: "C:\\7z.exe" },
  );
  const binaries = extended.find((step) => step.id === "binaries").args;
  assert.deepEqual(binaries.slice(1, 3), ["--skip", "cursor,antigravity"]);
  assert.deepEqual(binaries.slice(-4), ["--root", root, "--arch", "x64"]);
  const git = extended.find((step) => step.id === "git").args;
  assert.deepEqual(git.slice(1, 3), ["--seven-zip", "C:\\7z.exe"]);
  assert.equal(
    plain.find((step) => step.id === "binaries").args.includes("--skip"),
    false,
  );
  assert.equal(
    plain.find((step) => step.id === "git").args.includes("--seven-zip"),
    false,
  );
});
