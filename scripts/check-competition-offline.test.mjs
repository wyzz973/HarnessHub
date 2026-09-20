import assert from "node:assert/strict";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  kitLayout,
  listEngines,
  offlineEnvironment,
  runStep,
  setupPlan,
  verifyKit,
  writeToolShims,
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
  assert.deepEqual(env.PATH.split(";").slice(0, 2), [
    layout.shims,
    path.dirname(layout.node),
  ]);
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

// Stand-in for pnpm.cjs: `pnpm <script>` runs the package script through the platform
// shell like pnpm does; `pnpm --filter ...` records how the nested call arrived.
const fakePnpm = `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--filter") {
  fs.writeFileSync("nested-pnpm.json", JSON.stringify(args));
  process.exit(0);
}
const script = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts[args[0]];
if (typeof script !== "string") process.exit(3);
process.exit(spawnSync(script, { shell: true, stdio: "inherit" }).status ?? 1);
`;

test("a nested pnpm in package scripts runs the kit's pnpm when PATH has no pnpm", async (t) => {
  const kit = await mkdtemp(path.join(os.tmpdir(), "HH shim kit "));
  t.after(() => rm(kit, { recursive: true, force: true }));
  const layout = kitLayout(kit);
  await mkdir(path.dirname(layout.node), { recursive: true });
  if (process.platform === "win32")
    await link(process.execPath, layout.node).catch(() =>
      copyFile(process.execPath, layout.node),
    );
  else await symlink(process.execPath, layout.node);
  await mkdir(path.dirname(layout.pnpm), { recursive: true });
  await writeFile(layout.pnpm, fakePnpm);
  await mkdir(layout.repository, { recursive: true });
  // The real build:console script, which nests `pnpm --filter`.
  const { scripts } = JSON.parse(
    await readFile(path.join(repo, "package.json"), "utf8"),
  );
  await writeFile(
    path.join(layout.repository, "package.json"),
    JSON.stringify({ scripts: { "build:console": scripts["build:console"] } }),
  );
  const step = setupPlan(layout, path.join(kit, "staging"), {
    install: false,
  }).find((candidate) => candidate.id === "build-console");
  const env = offlineEnvironment(process.env, layout);
  const log = new PassThrough();
  log.resume();

  // Without the shim directory the nested pnpm cannot be found (the CI failure).
  const separator = process.platform === "win32" ? ";" : ":";
  const unshimmed = {
    ...env,
    PATH: env.PATH.split(separator)
      .filter((entry) => entry !== layout.shims)
      .join(separator),
  };
  await assert.rejects(runStep(step, unshimmed, log), /build-console failed/);

  assert.equal(await writeToolShims(layout), layout.shims);
  await runStep(step, env, log);
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(layout.repository, "nested-pnpm.json"), "utf8"),
    ),
    ["--filter", "@harnesshub/console", "build"],
  );
  // Exit codes pass through the shim.
  await writeFile(
    path.join(layout.repository, "package.json"),
    JSON.stringify({ scripts: { "build:console": "pnpm missing-script" } }),
  );
  await assert.rejects(runStep(step, env, log), /exit code 3/);
});

test("the Windows pnpm shim is relative to itself and passes the exit code", async (t) => {
  const kit = await mkdtemp(path.join(os.tmpdir(), "hh-shim-text-"));
  t.after(() => rm(kit, { recursive: true, force: true }));
  const layout = kitLayout(kit);
  await writeToolShims(layout, "win32");
  const text = await readFile(path.join(layout.shims, "pnpm.cmd"), "utf8");
  assert.equal(
    text,
    '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\pnpm-runner\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
  );
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
