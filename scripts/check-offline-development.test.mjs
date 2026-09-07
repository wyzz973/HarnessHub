import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "hh-devkit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle"),
    checkout = path.join(root, "company 中文");
  const files = [];
  async function add(relative, content) {
    const file = path.join(bundle, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    files.push({
      path: relative,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  for (const relative of [
    "scripts/offline-development.mjs",
    "scripts/lib/bundle-copy.mjs",
  ])
    await add(relative, await readFile(path.join(repo, relative)));
  // Reuse the compiled production inventory validator; no mock hash checker.
  await add(
    "dist/src/distribution/manifest.js",
    `export * from ${JSON.stringify(new URL("../dist/src/distribution/manifest.js", import.meta.url).href)};`,
  );
  await add("package.json", '{"type":"module"}');
  for (const label of ["root", "web"]) {
    const metadata = JSON.stringify({
      name: `fixture-${label}`,
      devDependencies: { compiler: "1.0.0" },
      ...(label === "root"
        ? {
            pnpm: {
              patchedDependencies: {
                "compiler@1.0.0": "patches/compiler.patch",
              },
            },
          }
        : {}),
    });
    await add(`development/${label}.package.json`, metadata);
    await add(
      `development/${label}/node_modules/compiler/package.json`,
      '{"name":"compiler","version":"1.0.0"}',
    );
    const directory = label === "root" ? checkout : path.join(checkout, "web");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), metadata);
  }
  await writeFile(
    path.join(checkout, "company-gateway.txt"),
    "private company source preserved",
  );
  await add("development/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await writeFile(
    path.join(checkout, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );
  await add("patches/compiler.patch", "synthetic fixed dependency patch\n");
  await mkdir(path.join(checkout, "patches"));
  await writeFile(
    path.join(checkout, "patches/compiler.patch"),
    "synthetic fixed dependency patch\n",
  );
  for (const relative of [
    "runtime/node.exe",
    "scripts/launch-engine.mjs",
    "console/server.js",
  ])
    await add(relative, "fixture");
  await writeFile(
    path.join(bundle, "bundle.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "arm64",
      nodeVersion: "24.20.0",
      consoleEntry: "console/server.js",
      engines: [
        {
          id: "fixture",
          name: "Fixture",
          version: "1",
          driver: "cli",
          command: ["fixture"],
        },
      ],
      components: [],
      files,
    }),
  );
  const run = (command, target = checkout) =>
    execute(
      process.execPath,
      [path.join(bundle, "scripts/offline-development.mjs"), command, target],
      {
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
      },
    );
  return { bundle, checkout, run };
}

void test("offline developer kit copies verified dependencies and preserves company source and existing folders", async (t) => {
  const { checkout, run } = await fixture(t);
  assert.equal(JSON.parse((await run("prepare")).stdout).downloads, false);
  assert.equal(
    await readFile(path.join(checkout, "company-gateway.txt"), "utf8"),
    "private company source preserved",
  );
  for (const relative of ["node_modules", "web/node_modules"])
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(checkout, relative, "compiler/package.json"),
          "utf8",
        ),
      ).version,
      "1.0.0",
    );
  await assert.rejects(run("prepare"), /Target already exists/);
  await assert.rejects(run("unknown"), /Usage/);
  await assert.rejects(run("prepare", "relative"), /ABSOLUTE/);
});

void test("offline developer kit rejects changed payload or unavailable dependency before mutation", async (t) => {
  const first = await fixture(t);
  await writeFile(
    path.join(
      first.bundle,
      "development/root/node_modules/compiler/package.json",
    ),
    "tampered",
  );
  await assert.rejects(first.run("prepare"), /Bundle file changed/);
  await assert.rejects(
    readFile(path.join(first.checkout, "node_modules/compiler/package.json")),
    { code: "ENOENT" },
  );
  const second = await fixture(t);
  await writeFile(
    path.join(second.checkout, "package.json"),
    '{"name":"fixture-root","devDependencies":{"compiler":"2.0.0"},"pnpm":{"patchedDependencies":{"compiler@1.0.0":"patches/compiler.patch"}}}',
  );
  await assert.rejects(second.run("prepare"), /does not contain/);
  await assert.rejects(
    readFile(path.join(second.checkout, "node_modules/compiler/package.json")),
    { code: "ENOENT" },
  );
  const third = await fixture(t);
  await writeFile(
    path.join(third.checkout, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nchanged: true\n",
  );
  await assert.rejects(third.run("prepare"), /lockfile differs/);
  await assert.rejects(
    readFile(path.join(third.checkout, "node_modules/compiler/package.json")),
    { code: "ENOENT" },
  );
  const fourth = await fixture(t);
  await writeFile(
    path.join(fourth.checkout, "patches/compiler.patch"),
    "different company patch\n",
  );
  await assert.rejects(fourth.run("prepare"), /dependency patch differs/);
  await assert.rejects(
    readFile(path.join(fourth.checkout, "node_modules/compiler/package.json")),
    { code: "ENOENT" },
  );
});

void test("offline developer kit refuses existing web dependencies before creating root dependencies", async (t) => {
  const { checkout, run } = await fixture(t);
  const existing = path.join(checkout, "web/node_modules");
  await mkdir(existing);
  await writeFile(
    path.join(existing, "company.txt"),
    "preserve existing web dependencies",
  );
  await assert.rejects(run("prepare"), /Target already exists/);
  await assert.rejects(lstat(path.join(checkout, "node_modules")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(path.join(existing, "company.txt"), "utf8"),
    "preserve existing web dependencies",
  );
});

void test("offline developer kit rejects a web junction outside the company checkout before writes", async (t) => {
  const { checkout, run } = await fixture(t);
  const web = path.join(checkout, "web");
  // Both paths stay inside this test's owned temporary root.
  const external = path.join(path.dirname(checkout), "external-web");
  const source = await readFile(path.join(web, "package.json"), "utf8");
  await rename(web, external);
  await symlink(
    external,
    web,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const command of ["prepare", "typecheck", "build"])
    await assert.rejects(run(command), /web workspace resolves outside/);
  for (const directory of [checkout, external])
    await assert.rejects(lstat(path.join(directory, "node_modules")), {
      code: "ENOENT",
    });
  assert.equal(
    await readFile(path.join(external, "package.json"), "utf8"),
    source,
  );
});
