import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { packageBundle } from "./package-bundle.mjs";
import {
  assertAddonArchitecture,
  copyTree,
  distributableFile,
  inventory,
  materializeNodeModules,
  relocateStandalone,
} from "./lib/bundle-copy.mjs";

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "hh-bundle 中文 "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function packageAt(
  directory,
  name,
  version,
  dependencies = {},
  code = "module.exports = 'ok';",
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version, main: "index.cjs", dependencies }),
  );
  await writeFile(path.join(directory, "index.cjs"), code);
}
async function node(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { SystemRoot: process.env.SystemRoot, PATH: "", NODE_PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(errors)),
    );
  });
}

void test("open-source preparation copies only selected declared engine graphs and explicitly includes offline build dependencies", async (t) => {
  const root = await workspace(t),
    source = path.join(root, "source");
  await packageAt(source, "fixture", "1", { open: "1", closed: "1" });
  await packageAt(
    path.join(source, "node_modules/open"),
    "open",
    "1",
    { shared: "1", string_decoder: "1" },
    "module.exports = require('shared') + require('string_decoder/package.json').version;",
  );
  await packageAt(
    path.join(source, "node_modules/string_decoder"),
    "string_decoder",
    "1",
  );
  await packageAt(
    path.join(source, "node_modules/shared"),
    "shared",
    "1",
    {},
    "module.exports = 'portable';",
  );
  await packageAt(path.join(source, "node_modules/closed"), "closed", "1");
  await packageAt(path.join(source, "node_modules/compiler"), "compiler", "1");
  const manifest = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  manifest.devDependencies = { compiler: "1" };
  await writeFile(path.join(source, "package.json"), JSON.stringify(manifest));
  const target = path.join(root, "selected");
  const result = await materializeNodeModules(
    source,
    path.join(target, "node_modules"),
    { dependencies: ["open"] },
  );
  assert.deepEqual(result.map((item) => item.id).sort(), [
    "npm:open",
    "npm:shared",
    "npm:string_decoder",
  ]);
  assert.equal(
    (await node(["-e", "console.log(require('open'))"], target)).trim(),
    "portable1",
  );
  await assert.rejects(
    readFile(path.join(target, "node_modules/closed/package.json")),
    { code: "ENOENT" },
  );
  for (const dependencies of [[], ["missing"], ["open", "open"]]) {
    await assert.rejects(
      materializeNodeModules(source, path.join(root, "bad"), { dependencies }),
      /unique declared/,
    );
  }
  const development = await materializeNodeModules(
    source,
    path.join(root, "development/node_modules"),
    { includeDevelopment: true },
  );
  assert.ok(development.some((item) => item.id === "npm:compiler"));
});

void test("bundle dependencies preserve conflicting versions and cycles without links or development packages", async (t) => {
  const root = await workspace(t),
    source = path.join(root, "source"),
    output = path.join(root, "moved");
  await packageAt(source, "fixture", "1", { a: "1", b: "1" });
  await packageAt(
    path.join(source, "node_modules", "a"),
    "a",
    "1",
    { common: "1", c: "1" },
    "module.exports = require('common');",
  );
  await packageAt(
    path.join(source, "node_modules", "b"),
    "b",
    "1",
    { common: "2" },
    "module.exports = require('common');",
  );
  await packageAt(
    path.join(source, "node_modules", "common"),
    "common",
    "1",
    {},
    "module.exports = 'first';",
  );
  await packageAt(
    path.join(source, "node_modules", "b", "node_modules", "common"),
    "common",
    "2",
    {},
    "module.exports = 'second';",
  );
  await packageAt(path.join(source, "node_modules", "c"), "c", "1", { a: "1" });
  await packageAt(
    path.join(source, "node_modules", "unused-development-only"),
    "unused-development-only",
    "1",
  );
  await writeFile(
    path.join(source, "node_modules", "a", ".env"),
    "PRIVATE_FIXTURE=must-not-copy",
  );
  const components = await materializeNodeModules(
    source,
    path.join(output, "node_modules"),
  );
  assert.equal(
    components.filter((entry) => entry.id === "npm:common").length,
    2,
  );
  assert.equal(
    components.some((entry) => entry.id.includes("development")),
    false,
  );
  const files = await inventory(output, process.arch);
  assert.equal(
    files.some((entry) => entry.path.endsWith("/.env")),
    false,
  );
  assert.ok(files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  // Remove all installed source packages before the real Node import proof.
  await rm(source, { recursive: true });
  assert.equal(
    (
      await node(["-e", "console.log(require('a'),require('b'))"], output)
    ).trim(),
    "first second",
  );
});

void test("bundle copy materializes internal links but rejects escaping targets, cycles and overwrites", async (t) => {
  const root = await workspace(t),
    source = path.join(root, "source"),
    foreign = path.join(root, "foreign");
  await mkdir(path.join(source, "ordinary"), { recursive: true });
  await mkdir(foreign);
  await writeFile(path.join(source, "ordinary", "asset.txt"), "fixture");
  await symlink(
    path.join(source, "ordinary"),
    path.join(source, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await copyTree(source, path.join(root, "copy"), {
    filter: distributableFile,
  });
  assert.equal(
    await readFile(path.join(root, "copy", "alias", "asset.txt"), "utf8"),
    "fixture",
  );
  await assert.rejects(copyTree(source, path.join(root, "copy")), {
    code: "EEXIST",
  });
  await symlink(
    foreign,
    path.join(source, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    copyTree(source, path.join(root, "escape-copy")),
    /escapes/,
  );
  await rm(path.join(source, "escape"));
  await symlink(
    source,
    path.join(source, "loop"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    copyTree(source, path.join(root, "cycle-copy")),
    /cycle/,
  );
});

void test("workspace pnpm junctions keep their dependency scope when copied into an independent console", async (t) => {
  const root = await workspace(t),
    source = path.join(root, "source"),
    web = path.join(source, "web"),
    modules = path.join(source, "node_modules"),
    output = path.join(root, "console");
  const app = path.join(modules, ".store", "app", "node_modules", "app");
  await packageAt(web, "web", "1", { app: "1" });
  await packageAt(
    app,
    "app",
    "1",
    { helper: "1" },
    "module.exports = require('helper');",
  );
  await packageAt(
    path.join(path.dirname(app), "helper"),
    "helper",
    "1",
    {},
    "module.exports = 'independent';",
  );
  await mkdir(path.join(web, "node_modules"));
  await symlink(
    app,
    path.join(web, "node_modules", "app"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await materializeNodeModules(web, path.join(output, "node_modules"), {
    allowedRoot: modules,
  });
  await rm(source, { recursive: true });
  assert.equal(
    (await node(["-e", "console.log(require('app'))"], output)).trim(),
    "independent",
  );
});

void test("bundle inventory detects wrong native-addon architecture and hashes ordinary files only", async (t) => {
  const root = await workspace(t),
    addon = path.join(root, "fixture.node");
  const bytes = Buffer.alloc(128);
  bytes.writeUInt16LE(0x5a4d);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0xaa64, 68);
  await writeFile(addon, bytes);
  await assertAddonArchitecture(addon, "arm64");
  await assert.rejects(assertAddonArchitecture(addon, "x64"), /architecture/);
  await writeFile(path.join(root, "bundle.json"), "{}");
  const files = await inventory(root, "arm64");
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "fixture.node");
  await writeFile(addon, "not a binary");
  await assert.rejects(inventory(root, "arm64"), /PE image/);
});

void test("Windows bundle copying selects target prebuilds and excludes installation and Python caches while retaining notices and source modules", async (t) => {
  const root = await workspace(t),
    source = path.join(root, "source");
  await packageAt(source, "fixture", "1", { native: "1" });
  const native = path.join(source, "node_modules", "native");
  await packageAt(native, "native", "1");
  for (const [name, machine] of [
    ["win32-arm64", 0xaa64],
    ["win32-x64", 0x8664],
    ["win32-ia32", 0x14c],
    ["darwin-arm64", 0],
    ["linux-x64", 0],
  ]) {
    await mkdir(path.join(native, "prebuilds", name), { recursive: true });
    const bytes = Buffer.alloc(128);
    if (machine) {
      bytes.writeUInt16LE(0x5a4d);
      bytes.writeUInt32LE(64, 0x3c);
      bytes.writeUInt32LE(0x4550, 64);
      bytes.writeUInt16LE(machine, 68);
    }
    await writeFile(path.join(native, "prebuilds", name, "addon.node"), bytes);
  }
  for (const name of [
    ".modules.yaml",
    ".pnpm/lock.yaml",
    ".pnpm-workspace-state-v1.json",
    "__pycache__/compiled.pyc",
    "compiled.pyc",
    "compiled.pyo",
    "sessions/index.js",
    "logs/index.js",
    "prebuilds/LICENSE",
  ]) {
    await mkdir(path.dirname(path.join(native, name)), { recursive: true });
    await writeFile(path.join(native, name), "fixture only");
  }
  for (const arch of ["arm64", "x64"]) {
    const filter = (relative, name) => distributableFile(relative, name, arch);
    const copied = path.join(root, `copied-${arch}`);
    await copyTree(source, copied, { filter });
    const installed = path.join(root, `installed-${arch}`);
    await materializeNodeModules(source, path.join(installed, "node_modules"), {
      arch,
    });
    for (const output of [copied, installed]) {
      const files = (await inventory(output, arch)).map((entry) => entry.path);
      assert.deepEqual(
        files.filter((file) => file.endsWith(".node")),
        [`node_modules/native/prebuilds/win32-${arch}/addon.node`],
      );
      assert.ok(files.includes("node_modules/native/prebuilds/LICENSE"));
      assert.ok(files.includes("node_modules/native/sessions/index.js"));
      assert.ok(files.includes("node_modules/native/logs/index.js"));
      assert.equal(
        files.some((file) => /\.modules|\.pnpm|pycache|\.py[co]$/.test(file)),
        false,
      );
      // A wrongly labelled native image must still fail the inventory guard.
      const wrong = Buffer.alloc(128);
      wrong.writeUInt16LE(0x5a4d);
      wrong.writeUInt32LE(64, 0x3c);
      wrong.writeUInt32LE(0x4550, 64);
      wrong.writeUInt16LE(arch === "arm64" ? 0x8664 : 0xaa64, 68);
      await writeFile(
        path.join(
          output,
          `node_modules/native/prebuilds/win32-${arch}/addon.node`,
        ),
        wrong,
      );
      await assert.rejects(inventory(output, arch), /architecture/);
    }
  }
  assert.throws(() => distributableFile("", "", "ia32"), /requires Windows/);
});

void test("standalone relocation removes build-machine roots and computes runtime roots from its new directory", async (t) => {
  const root = await workspace(t),
    app = path.join(root, "console", "web"),
    server = path.join(app, "server.mjs"),
    original = "C:\\private-build\\repo";
  await mkdir(path.join(app, ".next"), { recursive: true });
  const config = {
    outputFileTracingRoot: original,
    repoRoot: original,
    turbopack: { root: original },
    env: {},
  };
  await writeFile(
    server,
    `import path from 'node:path';\nimport {fileURLToPath} from 'node:url';\nconst __dirname = fileURLToPath(new URL('.', import.meta.url));\nconst nextConfig = ${JSON.stringify(config)}\nconsole.log(nextConfig.outputFileTracingRoot);`,
  );
  const manifest = path.join(app, ".next", "required-server-files.json");
  await writeFile(
    manifest,
    JSON.stringify({ config, appDir: original + "\\web", files: [] }),
  );
  await assert.rejects(
    inventory(root, process.arch, [original]),
    /build-machine path/,
  );
  await relocateStandalone(server, path.join(root, "console"));
  assert.equal((await node([server], root)).trim(), path.join(root, "console"));
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).appDir, ".");
  assert.equal((await inventory(root, process.arch, [original])).length, 2);
  await writeFile(server, "unrecognized generated server format");
  await assert.rejects(relocateStandalone(server), /Unsupported Next/);
});

void test("bundle rejects developer-local engine templates before creating output", async (t) => {
  const root = await workspace(t),
    prepared = path.join(root, "prepared"),
    output = path.join(root, "output");
  await mkdir(prepared);
  await writeFile(
    path.join(prepared, "prepared.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "arm64",
      nodeVersion: "24.20.0",
      engines: [{ command: [path.join(prepared, "engines", "engine.exe")] }],
      components: [],
    }),
  );
  await assert.rejects(
    packageBundle(prepared, output),
    /metadata contains a build-machine path/,
  );
  await assert.rejects(readFile(path.join(output, "package.json")), {
    code: "ENOENT",
  });
});
