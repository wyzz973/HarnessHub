import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareEngine } from "../../src/engine/registry.js";
import { startHub } from "../../src/main.js";
import {
  bindInstalled,
  inspectLocal,
  installLocal,
  listInstalled,
  removeInstalled,
  runToolPackageCli,
  verifyInstalled,
  type ToolPackageBindResult,
  type ToolPackageManifest,
} from "../../src/tool-packages/index.js";
import { hash } from "../../src/tool-packages/manifest.js";

async function fixture(
  directory: string,
): Promise<{ source: string; store: string; manifest: ToolPackageManifest }> {
  const source = path.join(directory, "source 中文");
  const files = new Map([
    [
      "skills/review/SKILL.md",
      "---\nname: local-review\ndescription: Review local changes\n---\nUse references/checklist.md for the checklist.\n",
    ],
    [
      "skills/review/references/checklist.md",
      "Check intended behavior, failures, tests and limitations.\n",
    ],
    [
      "server.mjs",
      "throw new Error('Package manager must never execute this file');\n",
    ],
    [
      "node_modules/local-only/package.json",
      '{"name":"local-only","version":"1.0.0","scripts":{"install":"fail"}}\n',
    ],
  ]);
  for (const [name, bytes] of files) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await writeFile(path.join(source, name), bytes);
  }
  const manifest: ToolPackageManifest = {
    schemaVersion: 1,
    id: "local-tools",
    version: "1.0.0",
    displayName: "Local tools",
    files: [...files].map(([name, bytes]) => ({
      path: name,
      size: Buffer.byteLength(bytes),
      sha256: hash(bytes),
    })),
    skills: [{ path: "skills/review/SKILL.md" }],
    mcpServers: [
      {
        name: "files",
        launch: "node",
        entry: "server.mjs",
        args: [
          { anchor: "workspace" },
          "--config",
          { anchor: "package", path: "node_modules/local-only/package.json" },
        ],
        env: { MODE: "local" },
        secretEnv: { API_KEY: "localKey" },
      },
    ],
  };
  await writeFile(
    path.join(source, "tool-package.json"),
    JSON.stringify(manifest),
  );
  return {
    source,
    store: path.join(directory, "state", "tool-packages"),
    manifest,
  };
}
async function temporary(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "hh-tool-packages-")));
}
const bindings = {
  localKey: { kind: "env" as const, value: "HH_PACKAGE_TEST_KEY" },
};

void test(
  "offline package installation copies exact bytes, survives relocation, binds through Gateway, and soft remove retains revisions",
  { timeout: 30000 },
  async (t) => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { source, store, manifest } = await fixture(directory);
    const inspection = await inspectLocal(source);
    const installed = await installLocal(source, store);
    assert.equal(installed.digest, inspection.digest);
    assert.deepEqual(
      (await installLocal(source, store)).record,
      installed.record,
    );
    assert.equal((await listInstalled(store)).length, 1);
    assert.deepEqual(await readdir(path.join(store, ".staging")), []);
    const originalObject = path.join(store, "objects", installed.digest);
    for (const file of manifest.files)
      assert.equal(
        hash(await readFile(path.join(originalObject, file.path))),
        file.sha256,
      );
    await writeFile(
      path.join(source, "server.mjs"),
      "changed after installation",
    );
    assert.equal(
      (await verifyInstalled(store, manifest.id, manifest.version)).digest,
      installed.digest,
    );
    await rm(source, { recursive: true });
    const moved = path.join(directory, "moved store 中文");
    await rename(store, moved);
    const context = {
      root: moved,
      nodeExecutable: process.execPath,
      workspace: directory,
      prepareEngine,
    };
    await assert.rejects(
      bindInstalled(moved, manifest.id, manifest.version, {
        nodeExecutable: process.execPath,
        workspace: directory,
      }),
      { code: "INVALID_TOOL_PACKAGE_BINDING" },
    );
    const fragment = await bindInstalled(moved, manifest.id, manifest.version, {
      nodeExecutable: process.execPath,
      workspace: directory,
      secretBindings: bindings,
    });
    assert.equal(fragment.mcpServers[0]!.command, process.execPath);
    assert.equal(fragment.mcpServers[0]!.args![1], directory);
    assert.ok(fragment.mcpServers[0]!.args![0]!.startsWith(moved + path.sep));
    assert.equal(fragment.skills[0]!.sha256, manifest.files[0]!.sha256);
    const input = path.join(directory, "engine.json");
    const secrets = path.join(directory, "refs.json");
    await writeFile(
      input,
      JSON.stringify({
        id: "package-engine",
        driver: "acp",
        command: [process.execPath, "non-executed-peer.js"],
        configuration: { adapter: "generic", env: { MODE: "kept" } },
      }),
    );
    await writeFile(secrets, JSON.stringify(bindings));
    const command = [
      "bind",
      "--id",
      manifest.id,
      "--version",
      manifest.version,
      "--engine",
      input,
      "--bindings",
      secrets,
    ];
    const bound = (await runToolPackageCli(
      command,
      context,
    )) as ToolPackageBindResult;
    assert.equal(
      (await prepareEngine(bound.registration)).revision,
      bound.revision,
    );
    assert.equal(bound.registration.configuration!.env!.MODE, "kept");
    assert.equal(Object.hasOwn(bound.registration, "revision"), false);
    await writeFile(input, JSON.stringify(bound.registration));
    assert.deepEqual(
      await runToolPackageCli(command, context),
      bound,
      "rebinding the identical package is idempotent",
    );
    const hub = await startHub({
      dataDir: path.join(directory, "gateway-data"),
      cwd: directory,
      demo: true,
      port: 0,
    });
    try {
      const response = await hub.server.inject({
        method: "PUT",
        url: "/v1/engines/package-engine",
        payload: bound.registration,
      });
      assert.equal(response.statusCode, 200, response.body);
      const listed = await hub.server.inject({
        method: "GET",
        url: "/v1/engines",
      });
      assert.equal(listed.statusCode, 200);
      assert.ok(listed.body.includes(bound.revision));
    } finally {
      await hub.server.close();
    }
    const removed = await removeInstalled(moved, manifest.id, manifest.version);
    assert.equal(removed.status, "removed");
    assert.deepEqual(await listInstalled(moved), []);
    assert.deepEqual(await listInstalled(moved, { includeRemoved: true }), [
      removed,
    ]);
    assert.deepEqual(
      await removeInstalled(moved, manifest.id, manifest.version),
      removed,
    );
    await assert.rejects(
      verifyInstalled(moved, manifest.id, manifest.version),
      { code: "TOOL_PACKAGE_NOT_FOUND" },
    );
    assert.equal(
      hash(await readFile(bound.registration.configuration!.skills![0]!.path)),
      manifest.files[0]!.sha256,
      "old revisions retain their original files after remove",
    );
  },
);

void test(
  "package validation rejects missing, extra, linked, changing and altered bytes without registering partial packages",
  { timeout: 30000 },
  async (t) => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { source, store, manifest } = await fixture(directory);
    const server = path.join(source, "server.mjs");
    const original = await readFile(server);
    if (process.platform === "win32") {
      const writer = await open(server, "r+");
      try {
        await assert.rejects(inspectLocal(source), {
          code: "TOOL_PACKAGE_CHANGED",
        });
      } finally {
        await writer.close();
      }
    }
    await writeFile(server, Buffer.alloc(original.length, 120));
    await assert.rejects(installLocal(source, store), {
      code: "TOOL_PACKAGE_INTEGRITY",
    });
    assert.deepEqual(await listInstalled(store), []);
    assert.deepEqual(await readdir(path.join(store, ".staging")), []);
    await writeFile(server, original);
    await writeFile(path.join(source, "extra.txt"), "extra");
    await assert.rejects(inspectLocal(source), {
      code: "TOOL_PACKAGE_CONTENT_MISMATCH",
    });
    await unlink(path.join(source, "extra.txt"));
    await unlink(server);
    await assert.rejects(inspectLocal(source), {
      code: "TOOL_PACKAGE_CONTENT_MISMATCH",
    });
    const external = path.join(directory, "external.js");
    await writeFile(external, original);
    await link(external, server);
    await assert.rejects(inspectLocal(source), {
      code: "INVALID_TOOL_PACKAGE_PATH",
    });
    await unlink(server);
    await writeFile(server, original);
    const linked = path.join(directory, "source-link");
    await symlink(
      source,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(inspectLocal(linked), {
      code: "INVALID_TOOL_PACKAGE_PATH",
    });
    const skillDir = path.join(source, "skills");
    const externalSkills = path.join(directory, "external-skills");
    await rename(skillDir, externalSkills);
    await symlink(
      externalSkills,
      skillDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(inspectLocal(source), {
      code: "INVALID_TOOL_PACKAGE_PATH",
    });
    await unlink(skillDir);
    await rename(externalSkills, skillDir);
    const installed = await installLocal(source, store);
    await writeFile(server, "new version bytes");
    const newer = structuredClone(manifest);
    const declared = newer.files.find((file) => file.path === "server.mjs")!;
    declared.sha256 = hash("new version bytes");
    declared.size = Buffer.byteLength("new version bytes");
    await writeFile(
      path.join(source, "tool-package.json"),
      JSON.stringify(newer),
    );
    await assert.rejects(installLocal(source, store), {
      code: "TOOL_PACKAGE_VERSION_CONFLICT",
    });
    assert.equal(
      (await verifyInstalled(store, manifest.id, manifest.version)).digest,
      installed.digest,
    );
    const objectServer = path.join(
      store,
      "objects",
      installed.digest,
      "server.mjs",
    );
    await writeFile(objectServer, Buffer.alloc(original.length, 121));
    await assert.rejects(
      verifyInstalled(store, manifest.id, manifest.version),
      { code: "TOOL_PACKAGE_INTEGRITY" },
    );
    await writeFile(server, original);
    await writeFile(
      path.join(source, "tool-package.json"),
      JSON.stringify(manifest),
    );
    await assert.rejects(
      installLocal(source, store),
      { code: "TOOL_PACKAGE_INTEGRITY" },
      "reinstall never silently repairs or replaces an existing object",
    );
    await unlink(objectServer);
    await assert.rejects(installLocal(source, store), {
      code: "TOOL_PACKAGE_CONTENT_MISMATCH",
    });
    assert.deepEqual(await readdir(path.join(store, ".staging")), []);
  },
);

void test(
  "CLI rejects unknown inputs, unsupported MCP drivers, missing/extra secret slots and preserves caller files",
  { timeout: 30000 },
  async (t) => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { source, store, manifest } = await fixture(directory);
    const context = {
      root: store,
      nodeExecutable: process.execPath,
      workspace: directory,
      prepareEngine,
    };
    for (const args of [
      [],
      ["fetch", "https://example.com"],
      ["install"],
      ["list", "--source", source],
      ["inspect", "--source", source, "--run-hooks"],
    ])
      await assert.rejects(runToolPackageCli(args, context), {
        code: "INVALID_TOOL_PACKAGE_ARGUMENT",
      });
    await runToolPackageCli(["install", "--source", source], context);
    assert.equal(
      (
        (await runToolPackageCli(
          ["verify", "--id", manifest.id, "--version", manifest.version],
          context,
        )) as { digest: string }
      ).digest,
      (await inspectLocal(source)).digest,
    );
    const engine = path.join(directory, "engine.json");
    const refs = path.join(directory, "refs.json");
    const original = JSON.stringify({
      id: "cli-engine",
      driver: "cli",
      command: [process.execPath, "unused.js"],
    });
    await writeFile(engine, original);
    await writeFile(refs, JSON.stringify(bindings));
    const args = [
      "bind",
      "--id",
      manifest.id,
      "--version",
      manifest.version,
      "--engine",
      engine,
      "--bindings",
      refs,
    ];
    await assert.rejects(runToolPackageCli(args, context), {
      code: "INVALID_ENGINE_CONFIGURATION",
    });
    assert.equal(await readFile(engine, "utf8"), original);
    await assert.rejects(
      bindInstalled(store, manifest.id, manifest.version, {
        nodeExecutable: process.execPath,
        workspace: directory,
        secretBindings: { ...bindings, unexpected: bindings.localKey },
      }),
      { code: "INVALID_TOOL_PACKAGE_BINDING" },
    );
    await assert.rejects(
      bindInstalled(store, manifest.id, manifest.version, {
        nodeExecutable: "node",
        workspace: directory,
        secretBindings: bindings,
      }),
      { code: "INVALID_TOOL_PACKAGE_BINDING" },
    );
    await removeInstalled(store, manifest.id, manifest.version);
    const reinstalled = await installLocal(source, store);
    assert.equal(reinstalled.record.status, "installed");
    assert.equal((await listInstalled(store)).length, 1);
    const lock = path.join(store, ".mutation-lock");
    await mkdir(lock);
    try {
      await assert.rejects(installLocal(source, store), {
        code: "TOOL_PACKAGE_BUSY",
      });
      await assert.rejects(
        removeInstalled(store, manifest.id, manifest.version),
        { code: "TOOL_PACKAGE_BUSY" },
      );
      assert.equal((await listInstalled(store))[0]!.status, "installed");
    } finally {
      await rmdir(lock);
    }
    const copied = path.join(directory, "copied store");
    await cp(store, copied, { recursive: true });
    assert.equal(
      (await verifyInstalled(copied, manifest.id, manifest.version)).digest,
      reinstalled.digest,
    );
    const recordName = (await readdir(path.join(copied, "records"))).find(
      (name) => name.endsWith(".json"),
    )!;
    await writeFile(
      path.join(copied, "records", recordName),
      JSON.stringify({ ...reinstalled.record, status: ["installed"] }),
    );
    await assert.rejects(listInstalled(copied), {
      code: "TOOL_PACKAGE_REGISTRY_CORRUPT",
    });
  },
);

void test(
  "bundled portable review Skill example is complete, hash-current and installable without MCP",
  { timeout: 10000 },
  async (t) => {
    const directory = await temporary();
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = fileURLToPath(
      new URL(
        "../../../examples/tool-packages/portable-review",
        import.meta.url,
      ),
    );
    const store = path.join(directory, "tool-packages");
    const installed = await installLocal(source, store);
    assert.equal(installed.manifest.id, "portable-review");
    const fragment = await bindInstalled(store, "portable-review", "1.0.0", {
      nodeExecutable: process.execPath,
      workspace: directory,
    });
    assert.deepEqual(fragment.mcpServers, []);
    assert.equal(fragment.skills.length, 1);
    const profile = await prepareEngine({
      id: "portable-skill-cli",
      driver: "cli",
      command: [process.execPath, "never-executed.js"],
      configuration: { adapter: "generic", ...fragment },
    });
    assert.equal(
      profile.configuration!.skills![0]!.sha256,
      fragment.skills[0]!.sha256,
    );
  },
);
