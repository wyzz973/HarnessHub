import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCompleteExtraction,
  EXTRACTION_ROOT_WARN,
} from "../../src/distribution/extraction.js";
import type { BundleManifest } from "../../src/distribution/types.js";

function manifest(paths: string[]): BundleManifest {
  return {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    consoleEntry: "console/web/server.js",
    engines: [],
    components: [],
    files: paths.map((file) => ({
      path: file,
      size: 1,
      sha256: "0".repeat(64),
    })),
  };
}

async function place(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "x");
  }
}

// Ordered so that the deepest entries are not the ones listed first.
const shallow = ["runtime/node.exe", "bundle.json", "dist/src/main.js"];
const deep = [
  `engines/npm/node_modules/@scope/${"a".repeat(80)}/lib/index.js`,
  `engines/npm/node_modules/@scope/${"b".repeat(90)}/lib/index.js.map`,
];

void test("a complete extraction passes and a deep root only warns", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-extract-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await place(root, [...shallow, ...deep]);
  const warnings: string[] = [];
  await assertCompleteExtraction(root, manifest([...shallow, ...deep]), {
    warn: (message) => warnings.push(message),
  });
  // The temporary root is already longer than the threshold on every platform here.
  assert.ok(path.resolve(root).length > EXTRACTION_ROOT_WARN);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /解压路径较长/);
  assert.match(warnings[0]!, /shorter path/);
});

void test("missing deep files fail with an actionable bilingual message", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-extract-short-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Exactly what Explorer leaves behind: everything but the longest paths.
  await place(root, shallow);
  await assert.rejects(
    assertCompleteExtraction(root, manifest([...shallow, ...deep])),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /解压不完整/);
      assert.match(error.message, /7-Zip/);
      assert.match(error.message, /tar -xf/);
      assert.match(error.message, /missing 2 file\(s\)/);
      return true;
    },
  );
});

void test("only the probed deepest files are checked, and a symlink is not a file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hh-extract-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await place(root, deep);
  // `shallow` is absent but outside a probe of two, so the check still passes.
  await assertCompleteExtraction(root, manifest([...shallow, ...deep]), {
    probe: 2,
  });

  const linked = path.join(root, ...deep[0]!.split("/"));
  await rm(linked);
  await symlink(path.join(root, "bundle.json"), linked);
  await assert.rejects(
    assertCompleteExtraction(root, manifest([...shallow, ...deep]), {
      probe: 2,
    }),
    /解压不完整/,
  );
});
