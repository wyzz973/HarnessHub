import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializeEngines,
  parseSettings,
  readSettings,
  writeSettings,
} from "../../src/distribution/configuration.js";
import {
  bundlePath,
  readBundle,
  verifyBundle,
} from "../../src/distribution/manifest.js";
import type {
  BundleContext,
  BundleManifest,
} from "../../src/distribution/types.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function context(root: string): BundleContext {
  return {
    root,
    state: path.join(root, "state"),
    workspace: path.join(root, "state", "workspace"),
    node: path.join(root, "runtime", "node.exe"),
  };
}
function manifest(): BundleManifest {
  return {
    schemaVersion: 1,
    platform: "win32",
    arch: "arm64",
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
        env: {
          FIXTURE_CACHE: "${home}/cache",
          FIXTURE_WORKSPACE: "${workspace}",
        },
        configuration: { adapter: "codex" },
        requiredFiles: ["engines/fixture/peer.mjs"],
      },
    ],
    files: [
      "runtime/node.exe",
      "console/server.js",
      "scripts/launch-engine.mjs",
      "engines/fixture/peer.mjs",
    ].map((name) => ({ path: name, size: 7, sha256: digest("payload") })),
  };
}
async function writeManifest(root: string, value: unknown): Promise<void> {
  await writeFile(path.join(root, "bundle.json"), JSON.stringify(value));
}
async function temporary(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "hh-distribution-")));
}

void test("bundle templates rebuild commands and private paths for a moved root without mutating templates or settings", () => {
  const template = manifest();
  const settings = parseSettings({
    schemaVersion: 1,
    defaultEngine: "fixture",
    modelProfiles: {
      judge: {
        model: "judge-model",
        provider: {
          protocol: "openai-responses",
          apiKey: { kind: "env", value: "JUDGE_MODEL_KEY" },
        },
      },
    },
    engines: { fixture: { modelProfile: "judge" } },
  });
  const before = JSON.stringify({ template, settings });
  const old = context(path.resolve("fixture old"));
  const moved = context(path.resolve("fixture moved 中文"));
  const original = materializeEngines(template, settings, old)[0]!;
  const engine = materializeEngines(template, settings, moved)[0]!;
  assert.equal(engine.command[0], moved.node);
  assert.equal(
    engine.command[1],
    path.join(moved.root, "scripts", "launch-engine.mjs"),
  );
  assert.ok(
    engine.command.includes(
      `HOME=${path.join(moved.state, "engine-homes", "fixture")}`,
    ),
  );
  assert.ok(engine.command.includes(`FIXTURE_WORKSPACE=${moved.workspace}`));
  assert.equal(
    path.normalize(engine.command.at(-1)!),
    path.join(moved.root, "engines", "fixture", "peer.mjs"),
  );
  assert.notDeepEqual(engine.command, original.command);
  assert.equal(
    engine.command.some((argument) => argument.includes(old.root)),
    false,
  );
  assert.equal(engine.model, "judge-model");
  assert.deepEqual(engine.configuration!.provider!.apiKey, {
    kind: "env",
    value: "JUDGE_MODEL_KEY",
  });
  assert.equal(JSON.stringify({ template, settings }), before);
});

void test("bundle templates reject absolute developer commands, anchor traversal, prototype anchors and host home overrides", () => {
  const root = context(path.resolve("fixture"));
  for (const command of [
    ["C:/Users/developer/engine.exe"],
    ["${bundle}/../../outside.exe"],
    ["${unknown}/engine.exe"],
    ["${__proto__}/engine.exe"],
    ["${node}", "${constructor}"],
  ]) {
    const template = manifest();
    template.engines[0]!.command = command;
    assert.throws(
      () => materializeEngines(template, { schemaVersion: 1 }, root),
      command.join(" "),
    );
  }
  const template = manifest();
  template.engines[0]!.env = { HOME: "C:/Users/developer" };
  assert.throws(() => materializeEngines(template, { schemaVersion: 1 }, root));
  for (const name of [
    "../outside",
    "dir/../outside",
    "C:/outside",
    "C:outside",
    "//host/share",
    "CON.txt",
    "a/NUL",
    "trailing.",
    "trailing ",
    "name:stream",
  ])
    assert.throws(() => bundlePath(root.root, name), name);
});

void test("settings reject unknown versions, inline credentials and unsafe references even in unused model profiles", () => {
  const profile = {
    model: "judge",
    provider: { protocol: "openai-responses" },
  };
  for (const input of [
    null,
    [],
    {},
    { schemaVersion: 2 },
    { schemaVersion: 1, surprise: true },
    { schemaVersion: 1, engines: { fixture: { command: ["outside.exe"] } } },
    {
      schemaVersion: 1,
      modelProfiles: {
        unused: {
          ...profile,
          provider: { ...profile.provider, apiKey: "inline-secret" },
        },
      },
    },
    {
      schemaVersion: 1,
      modelProfiles: {
        unused: {
          ...profile,
          provider: {
            ...profile.provider,
            baseUrl: "https://user:password@example.com",
          },
        },
      },
    },
    {
      schemaVersion: 1,
      modelProfiles: {
        unused: {
          ...profile,
          provider: {
            ...profile.provider,
            apiKey: { kind: "file", value: "relative-secret" },
          },
        },
      },
    },
    {
      schemaVersion: 1,
      modelProfiles: {
        unused: {
          ...profile,
          provider: {
            ...profile.provider,
            apiKey: { kind: "env", value: "not an env name" },
          },
        },
      },
    },
    {
      schemaVersion: 1,
      engines: {
        fixture: {
          configuration: {
            adapter: "codex",
            env: { API_KEY: "inline-secret" },
          },
        },
      },
    },
  ])
    assert.throws(() => parseSettings(input), JSON.stringify(input));
  const root = context(path.resolve("fixture"));
  for (const settings of [
    { schemaVersion: 1 as const, engines: { outside: {} } },
    { schemaVersion: 1 as const, defaultEngine: "outside" },
    {
      schemaVersion: 1 as const,
      engines: { fixture: { modelProfile: "missing" } },
    },
    {
      schemaVersion: 1 as const,
      modelProfiles: {},
      engines: { fixture: { modelProfile: "constructor" } },
    },
    {
      schemaVersion: 1 as const,
      modelProfiles: {
        judge: {
          model: "judge",
          provider: { protocol: "openai-responses" as const },
        },
      },
      engines: { fixture: { model: "conflicting", modelProfile: "judge" } },
    },
  ])
    assert.throws(() => materializeEngines(manifest(), settings, root));
});

void test("bundle inventory rejects malformed platform types, aliases, unknown fields and verifies changed bytes and escaped links", async (t) => {
  const root = await temporary();
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = manifest();
  for (const file of template.files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), "payload");
  }
  await writeManifest(root, template);
  assert.equal((await readBundle(root)).engines[0]!.id, "fixture");
  assert.deepEqual(await verifyBundle(root, await readBundle(root), true), {
    files: 4,
    bytes: 28,
    hashesVerified: true,
  });
  for (const input of [
    { ...template, arch: ["arm64"] },
    { ...template, schemaVersion: 2 },
    { ...template, unexpected: true },
    {
      ...template,
      files: template.files.filter(
        (file) => file.path !== template.consoleEntry,
      ),
    },
    {
      ...template,
      files: template.files.filter(
        (file) => file.path !== "engines/fixture/peer.mjs",
      ),
    },
    {
      ...template,
      files: [
        ...template.files,
        { ...template.files[0]!, path: "RUNTIME/NODE.EXE" },
      ],
    },
    { ...template, files: [{ ...template.files[0]!, path: "../outside" }] },
    {
      ...template,
      files: [{ ...template.files[0]!, path: "state/settings.json" }],
    },
    { ...template, files: [{ ...template.files[0]!, size: "7" }] },
    { ...template, files: [{ ...template.files[0]!, sha256: "x".repeat(64) }] },
  ]) {
    await writeManifest(root, input);
    await assert.rejects(readBundle(root), JSON.stringify(input));
  }
  await writeManifest(root, template);
  await writeFile(path.join(root, "engines/fixture/peer.mjs"), "changed");
  assert.equal(
    (await verifyBundle(root, template, false)).hashesVerified,
    false,
  );
  await assert.rejects(verifyBundle(root, template, true), /hash|changed/i);
  await writeFile(
    path.join(root, "engines/fixture/peer.mjs"),
    "longer content",
  );
  await assert.rejects(verifyBundle(root, template, false), /changed/i);
  const external = await temporary();
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, "peer.mjs"), "payload");
  await rm(path.join(root, "engines/fixture"), { recursive: true });
  await symlink(
    external,
    path.join(root, "engines/fixture"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(verifyBundle(root, template, true), /link|escape|path/i);
});

void test("settings storage does not replace valid bytes on parsing failure or silently reset corrupt JSON", async (t) => {
  const root = await temporary();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readSettings(root), { schemaVersion: 1 });
  const settings = { schemaVersion: 1 as const, defaultEngine: "fixture" };
  await writeSettings(root, settings);
  const bytes = await readFile(path.join(root, "settings.json"));
  await assert.rejects(
    writeSettings(root, {
      ...settings,
      schemaVersion: 2,
    } as unknown as typeof settings),
  );
  assert.deepEqual(await readFile(path.join(root, "settings.json")), bytes);
  await writeFile(path.join(root, "settings.json"), "{invalid");
  await assert.rejects(readSettings(root));
});
