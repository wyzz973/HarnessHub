import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parsePreinstallMarker,
  preinstallEnabled,
  readPreinstalledList,
  readPreinstallMarker,
  writePreinstallMarker,
  type PreinstallMarker,
} from "../../src/distribution/preinstalled.js";
import { importLocal, inspectImport } from "../../src/tool-packages/index.js";

const DIGEST = "a".repeat(64);

async function temporary(t: test.TestContext): Promise<string> {
  const directory = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh preinstalled 列表-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function tree(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

void test("inspectImport reports exactly what importLocal registers and leaves no store behind", async (t) => {
  const directory = await temporary(t);
  const source = path.join(directory, "office-fixture");
  await tree(source, {
    "skills/guide/SKILL.md":
      "---\nname: guide\ndescription: fixture\n---\nUse the tool.\n",
    "skills/guide/references/more.md": "details\n",
    "cli.json": JSON.stringify({
      cliTools: [{ name: "count", entry: "bin/count.mjs", launch: "node" }],
    }),
    "bin/count.mjs": "process.stdout.write('1\\n');\n",
  });
  const before = (await readdir(directory)).sort();
  const inspected = await inspectImport(source);
  assert.deepEqual(
    (await readdir(directory)).sort(),
    before,
    "inspection creates nothing next to the source",
  );
  assert.equal(inspected.format, "generated");
  assert.deepEqual(inspected.counts, { skills: 1, mcp: 0, cli: 1 });
  assert.equal(inspected.manifest.id, "office-fixture");
  assert.match(inspected.manifest.version, /^auto-[a-f0-9]{12}$/);

  const store = path.join(directory, "store");
  const imported = await importLocal(source, store);
  assert.equal(imported.installed.digest, inspected.digest);
  assert.deepEqual(imported.installed.manifest, inspected.manifest);
  assert.deepEqual(imported.counts, inspected.counts);
  assert.equal((await inspectImport(source)).digest, inspected.digest);

  // Any payload change is a different digest and version.
  await writeFile(path.join(source, "bin", "count.mjs"), "// changed\n");
  const changed = await inspectImport(source);
  assert.notEqual(changed.digest, inspected.digest);
  assert.notEqual(changed.manifest.version, inspected.manifest.version);

  // A directory with its own manifest is inspected unchanged, like importLocal.
  const declared = path.join(
    directory,
    "store",
    "objects",
    imported.installed.digest,
  );
  const fromManifest = await inspectImport(declared);
  assert.equal(fromManifest.format, "tool-package");
  assert.equal(fromManifest.digest, imported.installed.digest);

  // The same validation errors as importLocal, still without a store.
  await assert.rejects(inspectImport("relative/source"), {
    code: "INVALID_TOOL_PACKAGE_SOURCE",
  });
  await assert.rejects(inspectImport(path.join(directory, "missing")), {
    code: "INVALID_TOOL_PACKAGE_SOURCE",
  });
  const broken = path.join(directory, "broken");
  await tree(broken, {
    "cli.json": JSON.stringify({
      cliTools: [{ name: "lost", entry: "bin/missing.mjs", launch: "node" }],
    }),
  });
  await assert.rejects(inspectImport(broken), {
    code: "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
  });
});

void test("the preinstalled list accepts only single lower-case directories under tool-packs", async (t) => {
  const root = await temporary(t);
  assert.deepEqual(await readPreinstalledList(root), [], "no file, no packs");
  const write = (value: unknown) =>
    tree(root, { "tool-packs/preinstalled.json": JSON.stringify(value) });

  await write({
    schemaVersion: 1,
    packs: [{ directory: "office-suite" }, { directory: "b2" }],
  });
  assert.deepEqual(await readPreinstalledList(root), [
    {
      directory: "office-suite",
      source: path.join(root, "tool-packs", "office-suite"),
    },
    { directory: "b2", source: path.join(root, "tool-packs", "b2") },
  ]);
  await write({ schemaVersion: 1, packs: [] });
  assert.deepEqual(await readPreinstalledList(root), []);

  for (const invalid of [
    { schemaVersion: 2, packs: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, packs: [], extra: true },
    { schemaVersion: 1, packs: [{ directory: "../outside" }] },
    { schemaVersion: 1, packs: [{ directory: "a/b" }] },
    { schemaVersion: 1, packs: [{ directory: "C:\\packs" }] },
    { schemaVersion: 1, packs: [{ directory: "Office" }] },
    { schemaVersion: 1, packs: [{ directory: "a", source: "/tmp" }] },
    { schemaVersion: 1, packs: [{ directory: "a" }, { directory: "a" }] },
    {
      schemaVersion: 1,
      packs: Array.from({ length: 17 }, (_, index) => ({
        directory: `p${index}`,
      })),
    },
  ]) {
    await write(invalid);
    await assert.rejects(
      readPreinstalledList(root),
      Error,
      JSON.stringify(invalid),
    );
  }
  await tree(root, { "tool-packs/preinstalled.json": "{ not json" });
  await assert.rejects(readPreinstalledList(root), SyntaxError);
});

void test("the marker is replaced atomically, validated on both sides and never guessed", async (t) => {
  const state = path.join(await temporary(t), "state dir");
  const file = path.join(state, "preinstalled-tool-packs.json");
  assert.deepEqual(await readPreinstallMarker(file), {
    schemaVersion: 1,
    packs: {},
  });
  const marker: PreinstallMarker = {
    schemaVersion: 1,
    packs: {
      "office-suite": {
        digest: DIGEST,
        package: { id: "office-suite", version: "auto-0123456789ab" },
        appliedAt: 1_790_000_000_000,
        results: [
          { engineId: "codex", status: "applied" },
          {
            engineId: "kimi",
            status: "skipped",
            code: "INVALID_ENGINE_CONFIGURATION",
            reason: "x".repeat(1000),
          },
        ],
      },
    },
    lastRun: {
      at: 1_790_000_000_001,
      outcomes: [
        { directory: "office-suite", status: "unchanged", digest: DIGEST },
        {
          directory: "broken",
          status: "failed",
          code: "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
          message: "cli.json names a missing file",
        },
      ],
    },
  };
  await writePreinstallMarker(file, marker);
  const stored = await readPreinstallMarker(file);
  assert.equal(
    stored.packs["office-suite"]!.results[1]!.reason!.length,
    300,
    "engine reasons are bounded",
  );
  assert.deepEqual(stored.lastRun, marker.lastRun);
  assert.deepEqual(
    (await readdir(state)).sort(),
    ["preinstalled-tool-packs.json"],
    "no temporary file is left behind",
  );

  // An invalid replacement is rejected before the previous marker is touched.
  const previous = await readFile(file, "utf8");
  await assert.rejects(
    writePreinstallMarker(file, {
      schemaVersion: 1,
      packs: { "Bad Name": marker.packs["office-suite"]! },
    }),
    /invalid directory/,
  );
  assert.equal(await readFile(file, "utf8"), previous);

  for (const invalid of [
    null,
    [],
    { schemaVersion: 2, packs: {} },
    { schemaVersion: 1, packs: {}, other: 1 },
    { schemaVersion: 1, packs: { a: { digest: "short" } } },
    {
      schemaVersion: 1,
      packs: {
        a: {
          digest: DIGEST,
          package: { id: "a", version: "1" },
          appliedAt: -1,
          results: [],
        },
      },
    },
    {
      schemaVersion: 1,
      packs: {
        a: {
          digest: DIGEST,
          package: { id: "a", version: "1" },
          appliedAt: 1,
          results: [{ engineId: "x", status: "maybe" }],
        },
      },
    },
    { schemaVersion: 1, packs: {}, lastRun: { at: 1, outcomes: [{}] } },
  ])
    assert.throws(
      () => parsePreinstallMarker(invalid),
      Error,
      JSON.stringify(invalid),
    );
  await writeFile(file, "{ not json");
  await assert.rejects(readPreinstallMarker(file), SyntaxError);
});

void test("HARNESSHUB_PREINSTALL_TOOL_PACKS accepts only 0 and 1", () => {
  assert.equal(preinstallEnabled({}), true);
  assert.equal(
    preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: "" }),
    true,
  );
  assert.equal(
    preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: "1" }),
    true,
  );
  assert.equal(
    preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: "0" }),
    false,
  );
  for (const value of ["true", "false", "no", "2", "off"])
    assert.throws(
      () => preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: value }),
      /must be 0 or 1/,
      value,
    );
});
