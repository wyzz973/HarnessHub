import assert from "node:assert/strict";
import {
  appendFile,
  cp,
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
import { fileURLToPath } from "node:url";
import {
  materializeEngines,
  readSettings,
} from "../../src/distribution/configuration.js";
import type {
  BundleContext,
  BundleManifest,
} from "../../src/distribution/types.js";
import { prepareEngine } from "../../src/engine/registry.js";
import { SESSION_WORKSPACE_PLACEHOLDER } from "../../src/tool-packages/index.js";
import { installToolPackIntoBundle } from "../../src/tool-packages-oneclick-main.js";

const example = fileURLToPath(
  new URL("../../../examples/tool-packages/simple-toolkit", import.meta.url),
);
const commandMcpEntry = fileURLToPath(
  new URL("../../src/drivers/tool-command/command-mcp.js", import.meta.url),
);

void test(
  "Install-Tool-Pack imports simple formats into bundle settings, skips incompatible engines and needs --replace to switch versions",
  { timeout: 60_000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-pack-bundle-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const engine = (id: string, driver: "acp" | "cli") => ({
      id,
      name: id,
      version: "1.0.0",
      driver,
      command: ["${node}", `\${bundle}/engines/${id}/peer.mjs`],
      configuration: { adapter: "generic" as const },
    });
    const manifest: BundleManifest = {
      schemaVersion: 1,
      platform: "win32",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      nodeVersion: process.versions.node,
      consoleEntry: "console/server.js",
      components: [],
      engines: [
        engine("alpha", "acp"),
        engine("beta", "cli"),
        engine("gamma", "acp"),
      ],
      files: [],
    };
    const context: BundleContext = {
      root,
      state: path.join(root, "state"),
      workspace: path.join(root, "state", "workspace"),
      node: process.execPath,
    };
    await mkdir(context.state, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(context.state, "settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        engines: { gamma: { enabled: false } },
      }),
    );

    const first = await installToolPackIntoBundle(
      context,
      manifest,
      {
        source: example,
        engines: "all",
        replace: false,
        workspace: "/legacy/workspace",
      },
      commandMcpEntry,
    );
    assert.equal(first.ok, true);
    assert.equal(first.package.id, "simple-toolkit");
    assert.deepEqual(first.counts, { skills: 1, mcp: 1, cli: 1 });
    assert.deepEqual(
      first.results.map((result) => [
        result.engineId,
        result.status,
        result.code,
      ]),
      [
        ["alpha", "applied", undefined],
        ["beta", "skipped", "INVALID_ENGINE_CONFIGURATION"],
        ["gamma", "skipped", "ENGINE_DISABLED"],
      ],
    );
    assert.match(first.warnings.join("\n"), /--workspace is ignored/);
    let settings = await readSettings(context.state);
    const alpha = settings.engines!.alpha!.configuration!;
    assert.equal(alpha.skills!.length, 1);
    assert.deepEqual(
      alpha.mcpServers!.map((server) => server.args!.at(-1)),
      [SESSION_WORKSPACE_PLACEHOLDER, SESSION_WORKSPACE_PLACEHOLDER],
    );
    assert.equal(
      settings.engines!.beta,
      undefined,
      "skipped engines keep their settings",
    );
    const materialized = materializeEngines(manifest, settings, context).find(
      (item) => item.id === "alpha",
    )!;
    assert.equal(
      (await prepareEngine(materialized)).revision,
      first.results[0]!.revision,
    );

    const copyRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-pack-bundle-copy-")),
    );
    t.after(() => rm(copyRoot, { recursive: true, force: true }));
    const copy = path.join(copyRoot, "simple-toolkit");
    await cp(example, copy, { recursive: true });
    await appendFile(path.join(copy, "servers/overview-mcp.mjs"), "\n// v2\n");
    const saved = await readFile(path.join(context.state, "settings.json"));
    const conflict = await installToolPackIntoBundle(
      context,
      manifest,
      { source: copy, engines: "alpha", replace: false },
      commandMcpEntry,
    );
    assert.equal(conflict.ok, false);
    assert.notEqual(conflict.package.version, first.package.version);
    assert.deepEqual(
      [conflict.results[0]!.status, conflict.results[0]!.code],
      ["failed", "TOOL_PACKAGE_BIND_CONFLICT"],
    );
    assert.deepEqual(
      await readFile(path.join(context.state, "settings.json")),
      saved,
      "settings are not rewritten when no engine accepted the pack",
    );
    const replaced = await installToolPackIntoBundle(
      context,
      manifest,
      { source: copy, engines: "alpha", replace: true },
      commandMcpEntry,
    );
    assert.equal(replaced.ok, true);
    assert.deepEqual(replaced.results[0]!.replaced, [first.package.version]);
    settings = await readSettings(context.state);
    assert.equal(settings.engines!.alpha!.configuration!.skills!.length, 1);
    assert.equal(settings.engines!.alpha!.configuration!.mcpServers!.length, 2);

    // A hub.cmd `tools use` selection of the same pack must not be bound twice.
    await writeFile(
      path.join(context.state, "settings.json"),
      JSON.stringify({
        ...settings,
        engines: {
          ...settings.engines,
          alpha: {
            ...settings.engines!.alpha,
            toolPackages: [{ id: "simple-toolkit", version: "0.0.1" }],
          },
        },
      }),
    );
    const selected = await installToolPackIntoBundle(
      context,
      manifest,
      { source: copy, engines: "alpha", replace: false },
      commandMcpEntry,
    );
    assert.equal(selected.results[0]!.code, "TOOL_PACKAGE_BIND_CONFLICT");
    assert.match(selected.results[0]!.reason!, /hub\.cmd tools use/);
    const switched = await installToolPackIntoBundle(
      context,
      manifest,
      { source: copy, engines: "alpha", replace: true },
      commandMcpEntry,
    );
    assert.equal(switched.results[0]!.status, "applied");
    assert.equal(
      (await readSettings(context.state)).engines!.alpha!.toolPackages,
      undefined,
    );
    await assert.rejects(
      installToolPackIntoBundle(
        context,
        manifest,
        { source: copy, engines: "alpha,missing", replace: false },
        commandMcpEntry,
      ),
      /Engine missing is not in this bundle/,
    );
  },
);
