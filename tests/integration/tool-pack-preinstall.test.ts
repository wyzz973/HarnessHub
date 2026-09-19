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
import { prepareCompetitionState } from "../../src/competition-bundle-main.js";
import {
  prepareDirectories,
  readSettings,
} from "../../src/distribution/configuration.js";
import {
  PREINSTALL_MARKER,
  preinstallEnabled,
  readPreinstallMarker,
} from "../../src/distribution/preinstalled.js";
import type {
  BundleContext,
  BundleManifest,
} from "../../src/distribution/types.js";
import { startHub } from "../../src/main.js";
import {
  PREINSTALL_ENSURED,
  type PreinstallReport,
} from "../../src/preinstalled-tool-packs.js";
import { prepareStartConfiguration } from "../../src/release-main.js";
import { readReleaseOverrides } from "../../src/storage/release-catalog.js";

const example = fileURLToPath(
  new URL("../../../examples/tool-packages/simple-toolkit", import.meta.url),
);
const commandMcpEntry = fileURLToPath(
  new URL("../../src/drivers/tool-command/command-mcp.js", import.meta.url),
);
const PACK = "office-fixture";

type Hub = Awaited<ReturnType<typeof startHub>>;
interface Listing {
  id: string;
  version: string;
  status: string;
  engines?: string[];
  preinstalled?: boolean;
}
interface LogRecord {
  event: string;
  phase?: string;
  status?: string;
  directory?: string;
  applied?: string[];
  skipped?: number;
  code?: string;
  [key: string]: unknown;
}

/**
 * A tiny release layout in a path with a space and non-ASCII characters: three bundled
 * engines (an incompatible CLI adapter among them) and one listed Tool Pack holding a
 * Skill, an MCP server and a CLI tool. No engine is ever started.
 */
async function bundle(t: test.TestContext, packs = [PACK]) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh preinstall 预装-")),
  );
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  );
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
  await cp(example, path.join(root, "tool-packs", PACK), { recursive: true });
  await writeFile(
    path.join(root, "tool-packs", "preinstalled.json"),
    // A byte-order mark and CRLF, as a Windows editor would save it.
    `\uFEFF${JSON.stringify({
      schemaVersion: 1,
      packs: packs.map((directory) => ({ directory })),
    })}\r\n`,
  );
  await prepareDirectories(context, manifest);
  return { root, context, manifest };
}

function competitionHub(
  context: BundleContext,
  prepared: {
    generated: { file: string };
    preinstall: PreinstallReport;
  },
): Promise<Hub> {
  // Same options as competitionBundleMain passes to the composition root.
  return startHub({
    dataDir: path.join(context.state, "competition-data"),
    configFile: prepared.generated.file,
    demo: false,
    competition: true,
    defaultEngine: "alpha",
    competitionEngine: "alpha",
    toolPackageRoot: path.join(context.state, "tool-packages"),
    harnessModelFile: path.join(context.state, "harness-model.json"),
    ...(prepared.preinstall.enabled
      ? { preinstalledToolPacks: prepared.preinstall.markerFile }
      : {}),
    cwd: context.workspace,
    port: 0,
  });
}

async function packages(hub: Hub): Promise<Listing[]> {
  const response = await hub.server.inject({
    method: "GET",
    url: "/v1/tool-packs",
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json<{ packages: Listing[] }>().packages;
}

/** Digests of the pack versions an engine's effective configuration contains. */
function bound(
  hub: Hub,
  engineId: string,
): { skills: string[]; mcp: string[] } {
  const engine = hub.app.engines().find((item) => item.id === engineId);
  assert.ok(engine, `engine ${engineId} is registered`);
  return {
    skills: (engine.configuration?.skills ?? []).map((skill) => skill.path),
    mcp: (engine.configuration?.mcpServers ?? []).map((server) => server.name),
  };
}

async function preinstallRecords(dataDir: string): Promise<LogRecord[]> {
  const text = await readFile(
    path.join(dataDir, "logs", "gateway.log"),
    "utf8",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord)
    .filter((record) => record.event === "toolpack.preinstall");
}

void test(
  "competition start preinstalls listed packs once per content, respects unbinding and re-applies changed content through engine overrides",
  { timeout: 120_000 },
  async (t) => {
    const { root, context, manifest } = await bundle(t);
    const dataDir = path.join(context.state, "competition-data");
    const database = path.join(dataDir, "harnesshub.sqlite");
    const markerFile = path.join(context.state, PREINSTALL_MARKER);
    const lines: string[] = [];
    const prepare = () =>
      prepareCompetitionState(context, manifest, {
        preinstall: true,
        commandMcpEntry,
        report: (line) => lines.push(line),
      });

    // First start: imported and bound through settings before the Gateway exists.
    const first = await prepare();
    assert.equal(first.preinstall.enabled, true);
    assert.deepEqual(
      first.preinstall.outcomes.map((outcome) => [
        outcome.directory,
        outcome.status,
      ]),
      [[PACK, "applied"]],
    );
    assert.deepEqual(
      first.preinstall.outcomes[0]!.results!.map((result) => [
        result.engineId,
        result.status,
        result.code,
      ]),
      [
        ["alpha", "applied", undefined],
        ["beta", "skipped", "INVALID_ENGINE_CONFIGURATION"],
        ["gamma", "applied", undefined],
      ],
    );
    assert.match(lines.join("\n"), /office-fixture .*applied to 2 engine/);
    const firstMarker = await readPreinstallMarker(markerFile);
    const firstEntry = firstMarker.packs[PACK]!;
    assert.equal(firstEntry.package.id, PACK);
    assert.match(firstEntry.package.version, /^auto-/);
    assert.equal(firstMarker.lastRun?.outcomes[0]?.status, "applied");

    let hub = await competitionHub(context, first);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await hub.server.close();
    };
    t.after(close);
    const listed = (await packages(hub)).filter((item) => item.id === PACK);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.version, firstEntry.package.version);
    assert.equal(listed[0]!.preinstalled, true);
    assert.deepEqual(listed[0]!.engines, ["alpha", "gamma"]);
    const alpha = bound(hub, "alpha");
    assert.equal(alpha.skills.length, 1);
    assert.ok(alpha.skills[0]!.includes(firstEntry.digest));
    assert.deepEqual(alpha.mcp, [`${PACK}-overview`, `${PACK}-cli`]);
    assert.deepEqual(bound(hub, "beta"), { skills: [], mcp: [] });
    // A new Session pins exactly the revision that carries the pack.
    const directory = path.join(root, "judge task");
    const created = await hub.server.inject({
      method: "POST",
      url: "/session",
      payload: { title: "preinstall", directory },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = hub.app
      .sessions()
      .find((item) => item.id === created.json<{ id: string }>().id);
    assert.equal(
      session?.profileRevision,
      hub.app.engines().find((item) => item.id === "alpha")!.revision,
    );
    await close();
    // Settings stayed the source of truth: the Gateway created no engine override.
    assert.deepEqual(readReleaseOverrides(database).engineIds, []);
    let records = await preinstallRecords(dataDir);
    assert.deepEqual(
      records.map((record) => [record.phase, record.status]),
      [
        ["settings", "applied"],
        ["overrides", "applied"],
      ],
    );
    assert.deepEqual(records[1]!.applied, []);
    assert.equal(records[1]!.skipped, 2);

    // Second start: the digest is known, so nothing is written or re-bound.
    const settingsBefore = await readFile(
      path.join(context.state, "settings.json"),
      "utf8",
    );
    lines.length = 0;
    const second = await prepare();
    assert.deepEqual(
      second.preinstall.outcomes.map((outcome) => outcome.status),
      ["unchanged"],
    );
    assert.deepEqual(lines, [], "an unchanged pack is not reported");
    assert.equal(
      await readFile(path.join(context.state, "settings.json"), "utf8"),
      settingsBefore,
    );
    assert.equal(
      (await readPreinstallMarker(markerFile)).packs[PACK]!.appliedAt,
      firstEntry.appliedAt,
    );
    hub = await competitionHub(context, second);
    closed = false;
    assert.equal(bound(hub, "alpha").skills.length, 1);
    // The user unbinds the pack in the console.
    const unbound = await hub.server.inject({
      method: "DELETE",
      url: `/v1/tool-packs/${PACK}/${firstEntry.package.version}/bindings?engineIds=all`,
    });
    assert.equal(unbound.statusCode, 200, unbound.body);
    assert.deepEqual(bound(hub, "alpha"), { skills: [], mcp: [] });
    await close();
    records = await preinstallRecords(dataDir);
    assert.equal(
      records.filter((record) => record.phase === "overrides").length,
      1,
      "a reconciled digest is not reconciled again",
    );

    // Third start: the unbinding is respected although settings still name the pack.
    const third = await prepare();
    assert.deepEqual(
      third.preinstall.outcomes.map((outcome) => outcome.status),
      ["unchanged"],
    );
    hub = await competitionHub(context, third);
    closed = false;
    assert.deepEqual(bound(hub, "alpha"), { skills: [], mcp: [] });
    assert.deepEqual(bound(hub, "gamma"), { skills: [], mcp: [] });
    const stillListed = (await packages(hub)).find((item) => item.id === PACK);
    assert.equal(stillListed?.preinstalled, true);
    assert.deepEqual(stillListed?.engines, []);
    await close();

    // Changed pack content: applied again, replacing the old version, also on the
    // engines whose override (from the unbinding) hides state/settings.json.
    await appendFile(
      path.join(
        root,
        "tool-packs",
        PACK,
        "skills",
        "toolkit-guide",
        "SKILL.md",
      ),
      "\nUpdated by a newer bundle.\n",
    );
    lines.length = 0;
    const fourth = await prepare();
    assert.deepEqual(
      fourth.preinstall.outcomes.map((outcome) => outcome.status),
      ["applied"],
    );
    const changed = (await readPreinstallMarker(markerFile)).packs[PACK]!;
    assert.notEqual(changed.digest, firstEntry.digest);
    assert.notEqual(changed.package.version, firstEntry.package.version);
    const settings = await readSettings(context.state);
    assert.deepEqual(
      settings.engines!.alpha!.configuration!.skills!.map((skill) =>
        skill.path.includes(changed.digest),
      ),
      [true],
      "settings hold only the new version",
    );
    hub = await competitionHub(context, fourth);
    closed = false;
    for (const engineId of ["alpha", "gamma"]) {
      const now = bound(hub, engineId);
      assert.equal(now.skills.length, 1, engineId);
      assert.ok(now.skills[0]!.includes(changed.digest), engineId);
      assert.deepEqual(now.mcp, [`${PACK}-overview`, `${PACK}-cli`]);
    }
    const versions = (await packages(hub)).filter((item) => item.id === PACK);
    assert.deepEqual(
      versions.map((item) => [
        item.version === changed.package.version,
        item.preinstalled ?? false,
        item.engines,
      ]),
      versions.map((item) =>
        item.version === changed.package.version
          ? [true, true, ["alpha", "gamma"]]
          : [false, false, []],
      ),
    );
    assert.equal(versions.length, 2, "the old version stays installed");
    await close();
    records = await preinstallRecords(dataDir);
    const reconciled = records.filter((record) => record.phase === "overrides");
    assert.equal(reconciled.length, 2);
    assert.deepEqual(reconciled[1]!.applied, ["alpha", "gamma"]);
    const ensured = JSON.parse(
      await readFile(path.join(dataDir, PREINSTALL_ENSURED), "utf8"),
    ) as { packs: Record<string, string> };
    assert.equal(ensured.packs[PACK], changed.digest);
  },
);

void test(
  "a broken pack, an unreadable marker or the disabling switch never stop the Gateway",
  { timeout: 120_000 },
  async (t) => {
    const { root, context, manifest } = await bundle(t, ["broken-pack", PACK]);
    const broken = path.join(root, "tool-packs", "broken-pack");
    await mkdir(broken, { recursive: true });
    await writeFile(
      path.join(broken, "cli.json"),
      JSON.stringify({
        cliTools: [{ name: "lost", entry: "bin/missing.mjs", launch: "node" }],
      }),
    );
    const markerFile = path.join(context.state, PREINSTALL_MARKER);
    const lines: string[] = [];
    const prepare = (preinstall: boolean) =>
      prepareCompetitionState(context, manifest, {
        preinstall,
        commandMcpEntry,
        report: (line) => lines.push(line),
      });

    // Disabled: nothing under state/ mentions a pack and the Gateway gets no marker.
    assert.equal(
      preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: "0" }),
      false,
    );
    assert.equal(preinstallEnabled({}), true);
    assert.equal(
      preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: " 1 " }),
      true,
    );
    assert.throws(
      () => preinstallEnabled({ HARNESSHUB_PREINSTALL_TOOL_PACKS: "false" }),
      /HARNESSHUB_PREINSTALL_TOOL_PACKS must be 0 or 1/,
    );
    const disabled = await prepare(false);
    assert.deepEqual(disabled.preinstall.outcomes, []);
    assert.deepEqual(await readSettings(context.state), { schemaVersion: 1 });
    await assert.rejects(readFile(markerFile), { code: "ENOENT" });
    let hub = await competitionHub(context, disabled);
    assert.deepEqual(await packages(hub), []);
    await hub.server.close();

    // Enabled: the broken pack is reported, the good one is still applied.
    const enabled = await prepare(true);
    assert.deepEqual(
      enabled.preinstall.outcomes.map((outcome) => [
        outcome.directory,
        outcome.status,
      ]),
      [
        ["broken-pack", "failed"],
        [PACK, "applied"],
      ],
    );
    assert.match(
      lines.join("\n"),
      /broken-pack was not installed \(TOOL_PACKAGE_IMPORT_UNSUPPORTED\)/,
    );
    hub = await competitionHub(context, enabled);
    const ready = await hub.server.inject({
      method: "GET",
      url: "/health/ready",
    });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(
      (await packages(hub)).map((item) => [item.id, item.preinstalled]),
      [[PACK, true]],
    );
    await hub.server.close();
    const dataDir = path.join(context.state, "competition-data");
    const failures = (await preinstallRecords(dataDir)).filter(
      (record) => record.status === "failed",
    );
    assert.deepEqual(
      failures.map((record) => [record.phase, record.directory, record.code]),
      [["settings", "broken-pack", "TOOL_PACKAGE_IMPORT_UNSUPPORTED"]],
    );

    // An unreadable marker: nothing is guessed, nothing changes, the Gateway starts.
    const settingsBefore = await readFile(
      path.join(context.state, "settings.json"),
      "utf8",
    );
    await writeFile(markerFile, "{ not json");
    lines.length = 0;
    const unreadable = await prepare(true);
    assert.deepEqual(
      unreadable.preinstall.outcomes.map((outcome) => [
        outcome.status,
        outcome.code,
      ]),
      [
        ["failed", "PREINSTALL_MARKER_UNREADABLE"],
        ["failed", "PREINSTALL_MARKER_UNREADABLE"],
      ],
    );
    assert.equal(lines.length, 2);
    assert.equal(
      await readFile(path.join(context.state, "settings.json"), "utf8"),
      settingsBefore,
    );
    assert.equal(await readFile(markerFile, "utf8"), "{ not json");
    hub = await competitionHub(context, unreadable);
    const listed = await packages(hub);
    assert.deepEqual(
      listed.map((item) => [item.id, item.preinstalled ?? false]),
      [[PACK, false]],
      "the listing survives an unreadable marker, without marks",
    );
    await hub.server.close();
    const last = (await preinstallRecords(dataDir)).at(-1)!;
    assert.deepEqual([last.phase, last.status], ["overrides", "failed"]);
  },
);

void test(
  "hub.cmd start preinstalls through settings and reaches an engine whose console override hides them",
  { timeout: 120_000 },
  async (t) => {
    const { context, manifest } = await bundle(t);
    const dataDir = path.join(context.state, "data");
    const productHub = (prepared: {
      config: string;
      preinstall: PreinstallReport;
    }) =>
      // Same flags as startServices passes to dist/src/main.js.
      startHub({
        dataDir,
        configFile: prepared.config,
        demo: false,
        toolPackageRoot: path.join(context.state, "tool-packages"),
        harnessModelFile: path.join(context.state, "harness-model.json"),
        ...(prepared.preinstall.enabled
          ? { preinstalledToolPacks: prepared.preinstall.markerFile }
          : {}),
        cwd: context.workspace,
        port: 0,
      });

    // An earlier run without preinstalled packs; the user saved alpha in the console.
    const before = await prepareStartConfiguration(context, manifest, {
      preinstall: false,
      commandMcpEntry,
    });
    let hub = await productHub(before);
    const alpha = hub.app.engines().find((item) => item.id === "alpha")!;
    assert.ok(alpha.command);
    await hub.app.registerEngine({
      id: "alpha",
      driver: alpha.driver,
      command: [...alpha.command],
      enabled: true,
      maxConcurrency: alpha.maxConcurrency,
      configuration: {
        ...alpha.configuration,
        env: { CONSOLE_SAVED: "1" },
      },
    });
    await hub.server.close();
    assert.deepEqual(
      readReleaseOverrides(path.join(dataDir, "harnesshub.sqlite")).engineIds,
      ["alpha"],
    );

    const prepared = await prepareStartConfiguration(context, manifest, {
      preinstall: true,
      commandMcpEntry,
    });
    assert.deepEqual(
      prepared.preinstall.outcomes.map((outcome) => outcome.status),
      ["applied"],
    );
    const generated = JSON.parse(await readFile(prepared.config, "utf8")) as {
      engines: { id: string; configuration?: { skills?: unknown[] } }[];
    };
    assert.deepEqual(
      generated.engines.map((engine) => [
        engine.id,
        engine.configuration?.skills?.length ?? 0,
      ]),
      [
        ["alpha", 1],
        ["beta", 0],
        ["gamma", 1],
      ],
    );
    hub = await productHub(prepared);
    t.after(() => hub.server.close());
    const digest = (
      await readPreinstallMarker(path.join(context.state, PREINSTALL_MARKER))
    ).packs[PACK]!.digest;
    for (const engineId of ["alpha", "gamma"]) {
      const now = bound(hub, engineId);
      assert.equal(now.skills.length, 1, engineId);
      assert.ok(now.skills[0]!.includes(digest), engineId);
    }
    assert.equal(
      hub.app.engines().find((item) => item.id === "alpha")!.configuration?.env
        ?.CONSOLE_SAVED,
      "1",
      "the console's own changes are kept",
    );
    const listed = (await packages(hub)).find((item) => item.id === PACK);
    assert.equal(listed?.preinstalled, true);
    assert.deepEqual(listed?.engines, ["alpha", "gamma"]);
    const reconciled = (await preinstallRecords(dataDir)).filter(
      (record) => record.phase === "overrides",
    );
    assert.deepEqual(reconciled.at(-1)?.applied, ["alpha"]);
    assert.equal(reconciled.at(-1)?.skipped, 1);
    await hub.server.close();
    assert.deepEqual(
      readReleaseOverrides(path.join(dataDir, "harnesshub.sqlite")).engineIds,
      ["alpha"],
      "gamma keeps settings as its source of truth",
    );
  },
);
