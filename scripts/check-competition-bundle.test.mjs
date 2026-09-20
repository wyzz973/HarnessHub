import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCompetitionFullBundle } from "./build-competition-full-bundle.mjs";

// The builder ships the compiled Gateway, so these tests need `pnpm build` (as `pnpm test` does).
const compiled = (relative) =>
  import(
    pathToFileURL(
      path.join(
        fileURLToPath(new URL("../dist/src/", import.meta.url)),
        relative,
      ),
    ).href
  );

async function write(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/** A minimal prepared portable bundle: only what readBundle and the builder require. */
async function portableBundle(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh bundle 预装-")),
  );
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  );
  const bundle = path.join(root, "bundle");
  await write(bundle, {
    "console/server.js": "// console placeholder\n",
    "runtime/node.exe": "placeholder, never executed\n",
    "scripts/launch-engine.mjs": "// launcher placeholder\n",
    "engines/fixture/peer.mjs": "// engine placeholder\n",
    "bundle.json": JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      nodeVersion: "24.20.0",
      consoleEntry: "console/server.js",
      components: [],
      engines: [
        {
          id: "fixture",
          name: "Fixture",
          version: "1.0.0",
          driver: "acp",
          command: ["${node}", "${bundle}/engines/fixture/peer.mjs"],
          configuration: { adapter: "generic" },
          requiredFiles: ["engines/fixture/peer.mjs"],
        },
      ],
      files: [{ path: "stale.txt", size: 0, sha256: "0".repeat(64) }],
    }),
  });
  return { root, bundle };
}

const pack = (skill) => ({
  "skills/guide/SKILL.md": `---\nname: guide\ndescription: fixture\n---\n${skill}\n`,
  "skills/guide/references/more.md": "details\n",
  "cli.json": JSON.stringify({
    cliTools: [{ name: "count", entry: "bin/count.mjs", launch: "node" }],
  }),
  "bin/count.mjs": "process.stdout.write('1\\n');\n",
});

test("the builder ships packs/ as preinstalled Tool Packs that the runtime list, the inventory and doctor --full accept", async (t) => {
  const { root, bundle } = await portableBundle(t);
  const packs = path.join(root, "packs");
  await write(packs, {
    "README.md": "not a pack: only directories are listed\n",
    ...Object.fromEntries(
      Object.entries(pack("Use the office tools.")).map(([name, content]) => [
        `office-fixture/${name}`,
        content,
      ]),
    ),
    "office-fixture/.DS_Store": "finder noise",
    "office-fixture/.env": "SECRET=never-shipped",
    "zeta-pack/skills/only/SKILL.md":
      "---\nname: only\ndescription: skill only\n---\nRead me.\n",
  });

  const result = await buildCompetitionFullBundle(bundle, { packs });
  assert.deepEqual(result.preinstalledToolPacks, [
    "office-fixture",
    "zeta-pack",
  ]);
  const toolPacks = path.join(bundle, "tool-packs");
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(toolPacks, "preinstalled.json"), "utf8"),
    ),
    {
      schemaVersion: 1,
      packs: [{ directory: "office-fixture" }, { directory: "zeta-pack" }],
    },
  );
  for (const shipped of [
    "office-fixture/skills/guide/SKILL.md",
    "office-fixture/skills/guide/references/more.md",
    "office-fixture/cli.json",
    "office-fixture/bin/count.mjs",
    "zeta-pack/skills/only/SKILL.md",
    // The examples for Install-Tool-Pack.cmd are still shipped next to them.
    "simple-toolkit/cli.json",
  ])
    assert.ok(
      (await lstat(path.join(toolPacks, ...shipped.split("/")))).isFile(),
      shipped,
    );
  for (const filtered of ["office-fixture/.DS_Store", "office-fixture/.env"])
    await assert.rejects(
      lstat(path.join(toolPacks, ...filtered.split("/"))),
      { code: "ENOENT" },
      filtered,
    );
  const readme = await readFile(
    path.join(bundle, "README-COMPETITION.txt"),
    "utf8",
  );
  assert.match(readme, /\(office-fixture, zeta-pack\) are applied to every/);
  assert.match(readme, /HARNESSHUB_PREINSTALL_TOOL_PACKS = "0"/);

  // The runtime reads exactly what the builder wrote.
  const { readPreinstalledList } = await compiled(
    "distribution/preinstalled.js",
  );
  assert.deepEqual(
    (await readPreinstalledList(bundle)).map((entry) => entry.directory),
    ["office-fixture", "zeta-pack"],
  );

  // bundle.json covers the new files, and the doctor --full verification accepts them.
  const { readBundle, verifyBundle } = await compiled(
    "distribution/manifest.js",
  );
  const manifest = await readBundle(bundle);
  const inventory = new Set(manifest.files.map((file) => file.path));
  for (const listed of [
    "tool-packs/preinstalled.json",
    "tool-packs/office-fixture/skills/guide/SKILL.md",
    "tool-packs/office-fixture/bin/count.mjs",
    "tool-packs/zeta-pack/skills/only/SKILL.md",
    "dist/src/preinstalled-tool-packs.js",
    "dist/src/distribution/preinstalled.js",
  ])
    assert.ok(inventory.has(listed), `inventory lists ${listed}`);
  assert.equal(inventory.has("stale.txt"), false);
  const verified = await verifyBundle(bundle, manifest, true);
  assert.equal(verified.hashesVerified, true);
  assert.equal(verified.files, manifest.files.length);
  await appendFile(
    path.join(toolPacks, "office-fixture", "skills", "guide", "SKILL.md"),
    "tampered\n",
  );
  await assert.rejects(
    verifyBundle(bundle, manifest, true),
    /Bundle file changed: tool-packs\/office-fixture\/skills\/guide\/SKILL.md/,
  );
});

test("a bundle without packs/ lists nothing, and unusable pack directories fail the build", async (t) => {
  const { root, bundle } = await portableBundle(t);
  const none = await buildCompetitionFullBundle(bundle, {
    packs: path.join(root, "no-such-directory"),
  });
  assert.deepEqual(none.preinstalledToolPacks, []);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(bundle, "tool-packs", "preinstalled.json"),
        "utf8",
      ),
    ),
    { schemaVersion: 1, packs: [] },
  );
  assert.match(
    await readFile(path.join(bundle, "README-COMPETITION.txt"), "utf8"),
    /\(none in this build\)/,
  );

  const cases = [
    [
      "Bad_Name",
      pack("x"),
      /Preinstalled Tool Pack directory must be a lower-case package id: packs\/Bad_Name/,
    ],
    [
      "simple-toolkit",
      pack("x"),
      /packs\/simple-toolkit collides with an example/,
    ],
    [
      "broken-pack",
      {
        "cli.json": JSON.stringify({
          cliTools: [
            { name: "lost", entry: "bin/missing.mjs", launch: "node" },
          ],
        }),
      },
      /packs\/broken-pack cannot be installed: /,
    ],
  ];
  for (const [directory, files, expected] of cases) {
    const packs = path.join(root, `packs-${directory}`);
    await write(
      packs,
      Object.fromEntries(
        Object.entries(files).map(([name, content]) => [
          `${directory}/${name}`,
          content,
        ]),
      ),
    );
    await assert.rejects(
      buildCompetitionFullBundle(bundle, { packs }),
      expected,
      directory,
    );
  }
});
