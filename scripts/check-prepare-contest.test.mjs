import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { preparationOptions, preparationSteps } from "./prepare-contest.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const execute = promisify(execFile);
const host = {
  platform: "win32",
  arch: "arm64",
  machine: "arm64",
  version: "24.20.0",
};

test("contest preparation rejects wrong Node/platform/architecture and unsafe roots/shims before running a stage", () => {
  const options = preparationOptions(["--check"], host);
  assert.equal(options.check, true);
  assert.equal(options.arch, "arm64");
  assert.ok(options.root.startsWith(path.join(repo, ".tools")));
  for (const invalid of [
    { ...host, platform: "linux" },
    { ...host, version: "24.20.1" },
    { ...host, arch: "x64" },
    { ...host, machine: "x86_64" },
  ])
    assert.throws(() => preparationOptions([], invalid));
  for (const args of [
    ["--arch", "x64"],
    ["--unknown"],
    ["--root", repo],
    ["--root", path.join(repo, "src")],
    ["--root", path.resolve(repo, "..", "outside")],
    ["--pnpm", "pnpm.cmd"],
    ["--pnpm", path.join(repo, ".tmp/pnpm.cmd")],
  ])
    assert.throws(() => preparationOptions(args, host));
  assert.deepEqual(
    preparationOptions(["--help"], { ...host, version: "invalid" }),
    { help: true },
  );
});

test("contest preparation plan pins npm install flags and calls each existing script with its supported arguments", () => {
  const root = path.join(repo, ".tmp", "plan fixture 中文");
  const node = path.join(root, "node.exe");
  const pnpm = path.join(root, "pnpm.cjs");
  const steps = preparationSteps(root, "arm64", pnpm, node);
  assert.deepEqual(
    steps.map((step) => step.id),
    ["npm", "binaries", "hermes", "kiro", "git", "openclaw", "catalog"],
  );
  assert.equal(steps[0].executable, node);
  assert.equal(steps[0].cwd, path.join(root, "engines/npm"));
  for (const flag of [
    "--frozen-lockfile",
    "--ignore-scripts",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
    "--package-import-method=copy",
  ])
    assert.ok(steps[0].args.includes(flag));
  assert.equal(steps[0].args[0], pnpm);
  for (const id of ["binaries", "git", "catalog"])
    assert.deepEqual(steps.find((step) => step.id === id).args.slice(-4), [
      "--root",
      root,
      "--arch",
      "arm64",
    ]);
  for (const id of ["hermes", "kiro"])
    assert.deepEqual(steps.find((step) => step.id === id).args.slice(-4), [
      "-TargetRoot",
      root,
      "-Engine",
      id,
    ]);
  assert.deepEqual(
    steps.find((step) => step.id === "openclaw").args.slice(-2),
    ["--package", path.join(root, "engines/npm/node_modules/openclaw")],
  );
  assert.equal(
    steps.some((step) => step.executable.endsWith(".cmd")),
    false,
  );
});

test(
  "contest preparation CLI exits nonzero for mismatched pnpm and incomplete check roots without invoking installers",
  { skip: process.platform !== "win32" || process.versions.node !== "24.20.0" },
  async (t) => {
    await mkdir(path.join(repo, ".tmp"), { recursive: true });
    const root = await mkdtemp(path.join(repo, ".tmp/prepare-entry-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fake = path.join(root, "fake-pnpm.cjs");
    await writeFile(
      fake,
      "if(process.argv[2]!=='--version') throw new Error('Installer must not run'); process.stdout.write('9.0.0\\n');\n",
    );
    const script = path.join(repo, "scripts/prepare-contest.mjs");
    await assert.rejects(
      execute(
        process.execPath,
        [script, "--root", root, "--pnpm", fake, "--check"],
        { windowsHide: true, timeout: 10000 },
      ),
      (error) => error.code === 1 && /Expected pnpm 10.12.3/.test(error.stderr),
    );
    await writeFile(
      fake,
      "if(process.argv[2]!=='--version') throw new Error('Installer must not run'); process.stdout.write('10.12.3\\n');\n",
    );
    await assert.rejects(
      execute(
        process.execPath,
        [script, "--root", root, "--pnpm", fake, "--check"],
        { windowsHide: true, timeout: 10000 },
      ),
      (error) => error.code === 1 && /node.exe/.test(error.stderr),
    );
  },
);
