import assert from "node:assert/strict";
import {
  appendFile,
  cp,
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
import { fileURLToPath } from "node:url";
import type { EngineMcpServer } from "../../src/domain/engine-configuration.js";
import { createGateway } from "../../src/gateway/server.js";
import { registerToolPackageRoutes } from "../../src/gateway/tool-package-routes.js";
import { startHub } from "../../src/main.js";
import { SESSION_WORKSPACE_PLACEHOLDER } from "../../src/tool-packages/index.js";
import { createToolPackageManagement } from "../../src/tool-packages/management.js";
import {
  startMcp,
  substituteSessionWorkspace,
} from "../fixtures/tool-pack-mcp-client.js";

const example = fileURLToPath(
  new URL("../../../examples/tool-packages/simple-toolkit", import.meta.url),
);
const commandMcpEntry = fileURLToPath(
  new URL("../../src/drivers/tool-command/command-mcp.js", import.meta.url),
);
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123";

interface EngineResult {
  engineId: string;
  status: string;
  revision?: string;
  code?: string;
  reason?: string;
  capabilities?: { skills: string[]; mcp: string[]; cli: string[] };
  replaced?: string[];
  removed?: { skills: string[]; mcp: string[] };
}
interface ApplyBody {
  ok: boolean;
  package: { id: string; version: string };
  results: EngineResult[];
  warnings: string[];
  engineId?: string;
  revision?: string;
  capabilities?: { skills: string[]; mcp: string[]; cli: string[] };
}
function byEngine(results: EngineResult[]): Record<string, EngineResult> {
  return Object.fromEntries(results.map((result) => [result.engineId, result]));
}

/**
 * Formal startHub Gateway plus, when `wired`, a second formal Gateway
 * (createGateway + tool-pack routes) for the same application whose Tool Pack
 * service also lists engines, as the composition root is expected to wire it.
 * Both share one teardown: the wired server closes first because either
 * server's close hook closes the shared application.
 */
async function hubWithEngines(t: test.TestContext, wired = false) {
  const dataDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "hh-tool-pack-gateway-")),
  );
  const hub = await startHub({ dataDir, cwd: dataDir, demo: true, port: 0 });
  const listing = wired ? await createGateway(hub.app) : undefined;
  t.after(async () => {
    try {
      await listing?.close();
    } finally {
      await hub.server.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  if (listing)
    registerToolPackageRoutes(
      listing,
      createToolPackageManagement({
        root: path.join(dataDir, "tool-packages"),
        nodeExecutable: process.execPath,
        commandMcpEntry,
        engineProfile: (id) => hub.app.engineProfile(id),
        registerEngine: (input) => hub.app.registerEngine(input),
        listEngines: () => hub.app.engines(),
      }),
    );
  for (const engine of [
    { id: "acp-a", driver: "acp", configuration: { adapter: "generic" } },
    { id: "acp-b", driver: "acp" },
    { id: "cli-c", driver: "cli" },
    { id: "acp-off", driver: "acp", enabled: false },
  ]) {
    const response = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: { ...engine, command: [process.execPath, "never-run.js"] },
    });
    assert.equal(response.statusCode, 201, response.body);
  }
  return { dataDir, hub, wired: listing };
}

void test(
  "import→apply-all installs the simple-toolkit example on every compatible engine with Session workspace placeholders, then replace and unbind",
  { timeout: 60_000 },
  async (t) => {
    const setup = await hubWithEngines(t, true);
    const { hub } = setup;
    const wired = setup.wired!;
    const revisions = () =>
      Object.fromEntries(
        hub.app.engines().map((engine) => [engine.id, engine.revision]),
      );
    const before = revisions();

    const imported = await wired.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: { source: example, applyTo: "all" },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const body = imported.json<{
      ok: boolean;
      package: { id: string; version: string };
      format: string;
      counts: { skills: number; mcp: number; cli: number };
      warnings: string[];
      apply: ApplyBody;
    }>();
    assert.equal(body.ok, true);
    assert.equal(body.format, "generated");
    assert.equal(body.package.id, "simple-toolkit");
    assert.deepEqual(body.counts, { skills: 1, mcp: 1, cli: 1 });
    assert.deepEqual(body.warnings, []);
    const first = byEngine(body.apply.results);
    assert.deepEqual(Object.keys(first).sort(), [
      "acp-a",
      "acp-b",
      "acp-off",
      "cli-c",
      "fake",
    ]);
    for (const id of ["acp-a", "acp-b"]) {
      assert.equal(first[id]!.status, "applied", JSON.stringify(first[id]));
      assert.equal(first[id]!.revision, hub.app.engineProfile(id).revision);
      assert.notEqual(first[id]!.revision, before[id]);
      assert.deepEqual(first[id]!.capabilities!.mcp, [
        "simple-toolkit-overview",
        "simple-toolkit-cli",
      ]);
      assert.deepEqual(first[id]!.capabilities!.cli, ["cli_wordcount"]);
    }
    assert.deepEqual(
      [first["cli-c"]!.status, first["cli-c"]!.code],
      ["skipped", "INVALID_ENGINE_CONFIGURATION"],
    );
    assert.match(
      first["cli-c"]!.reason!,
      /MCP injection requires an ACP engine/,
    );
    assert.deepEqual(
      [first["acp-off"]!.status, first["acp-off"]!.code],
      ["skipped", "ENGINE_DISABLED"],
    );
    assert.deepEqual(
      [first.fake!.status, first.fake!.code],
      ["skipped", "ENGINE_CONFIGURATION_UNSUPPORTED"],
    );
    assert.equal(revisions()["cli-c"], before["cli-c"]);
    assert.equal(revisions()["acp-off"], before["acp-off"]);

    const configuration = hub.app.engineProfile("acp-a").configuration!;
    const server = (name: string): EngineMcpServer =>
      configuration.mcpServers!.find((entry) => entry.name === name)!;
    assert.deepEqual(server("simple-toolkit-overview").args!.slice(1), [
      "--root",
      SESSION_WORKSPACE_PLACEHOLDER,
    ]);
    assert.deepEqual(server("simple-toolkit-cli").args, [
      commandMcpEntry,
      "--workspace",
      SESSION_WORKSPACE_PLACEHOLDER,
    ]);
    assert.equal(
      Object.hasOwn(server("simple-toolkit-cli").env!, "HHCAP_CLI_WORKSPACE"),
      false,
      "no absolute workspace is pinned into the engine revision",
    );
    assert.equal(configuration.skills!.length, 1);

    // Launch both servers the way a Worker does for a Session directory.
    const session = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-pack-session-")),
    );
    t.after(() => rm(session, { recursive: true, force: true }));
    await writeFile(path.join(session, "notes.txt"), "alpha beta\ngamma\n");
    await mkdir(path.join(session, "src"));
    const overview = startMcp(
      t,
      substituteSessionWorkspace(server("simple-toolkit-overview"), session),
    );
    await overview.initialize();
    const listed = await overview.call("workspace_overview");
    assert.equal(listed.isError, false);
    const tree = JSON.parse(listed.text) as {
      root: string;
      entries: { name: string; type: string }[];
    };
    assert.equal(tree.root, session);
    assert.deepEqual(tree.entries, [
      { name: "notes.txt", type: "file" },
      { name: "src", type: "directory" },
    ]);
    assert.equal(await overview.close(), 0);
    const cli = startMcp(
      t,
      substituteSessionWorkspace(server("simple-toolkit-cli"), session),
    );
    await cli.initialize();
    const counted = await cli.call("cli_wordcount", { args: ["notes.txt"] });
    assert.equal(counted.isError, false, counted.text);
    const execution = JSON.parse(counted.text) as { stdout: string };
    assert.deepEqual(JSON.parse(execution.stdout), {
      cwd: session,
      results: [{ path: "notes.txt", lines: 2, words: 3, bytes: 17 }],
    });
    assert.equal(await cli.close(), 0);

    const packs = await wired.inject({ method: "GET", url: "/v1/tool-packs" });
    assert.equal(packs.statusCode, 200, packs.body);
    const listing = packs.json<{
      packages: {
        id: string;
        version: string;
        displayName: string;
        counts: { skills: number; mcp: number; cli: number };
        engines: string[];
      }[];
    }>().packages;
    assert.deepEqual(
      listing.map((item) => [item.id, item.version, item.engines.sort()]),
      [["simple-toolkit", body.package.version, ["acp-a", "acp-b"]]],
    );
    assert.deepEqual(listing[0]!.counts, { skills: 1, mcp: 1, cli: 1 });
    const formal = await hub.server.inject({
      method: "GET",
      url: "/v1/tool-packs",
    });
    assert.equal(formal.statusCode, 200, formal.body);
    assert.ok(formal.body.includes(body.package.version));

    // A changed copy of the same folder becomes a new version of the same id.
    const copyRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-tool-pack-copy-")),
    );
    t.after(() => rm(copyRoot, { recursive: true, force: true }));
    const copy = path.join(copyRoot, "simple-toolkit");
    await cp(example, copy, { recursive: true });
    await appendFile(
      path.join(copy, "skills/toolkit-guide/SKILL.md"),
      "\nPrefer workspace_overview before reading files.\n",
    );
    const upgraded = await wired.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: { source: copy, applyTo: ["acp-a", "acp-b"] },
    });
    assert.equal(upgraded.statusCode, 200, upgraded.body);
    const second = upgraded.json<{
      ok: boolean;
      package: { id: string; version: string };
      apply: ApplyBody;
    }>();
    assert.equal(second.package.id, "simple-toolkit");
    assert.notEqual(second.package.version, body.package.version);
    assert.equal(second.ok, false);
    for (const result of second.apply.results) {
      assert.equal(result.status, "failed");
      assert.equal(result.code, "TOOL_PACKAGE_BIND_CONFLICT");
      assert.match(result.reason!, /pass replace:true/);
      assert.equal(
        hub.app.engineProfile(result.engineId).revision,
        first[result.engineId]!.revision,
      );
    }
    const replaced = await wired.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: {
        engineIds: "all",
        package: second.package,
        replace: true,
      },
    });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const third = byEngine(replaced.json<ApplyBody>().results);
    for (const id of ["acp-a", "acp-b"]) {
      assert.equal(third[id]!.status, "applied");
      assert.deepEqual(third[id]!.replaced, [body.package.version]);
      const current = hub.app.engineProfile(id).configuration!;
      assert.equal(current.skills!.length, 1);
      assert.equal(current.mcpServers!.length, 2);
      assert.equal(
        JSON.stringify(current).includes(first[id]!.capabilities!.skills[0]!),
        false,
      );
    }

    const unbound = await wired.inject({
      method: "DELETE",
      url: `/v1/tool-packs/simple-toolkit/${second.package.version}/bindings?engineIds=all`,
    });
    assert.equal(unbound.statusCode, 200, unbound.body);
    const removal = unbound.json<{ ok: boolean; results: EngineResult[] }>();
    assert.equal(removal.ok, true);
    const removed = byEngine(removal.results);
    for (const id of ["acp-a", "acp-b"]) {
      assert.equal(removed[id]!.status, "unbound");
      assert.deepEqual(removed[id]!.removed!.mcp.sort(), [
        "simple-toolkit-cli",
        "simple-toolkit-overview",
      ]);
      assert.equal(removed[id]!.revision, hub.app.engineProfile(id).revision);
    }
    assert.deepEqual(hub.app.engineProfile("acp-a").configuration, {
      adapter: "generic",
    });
    for (const id of ["cli-c", "acp-off", "fake"])
      assert.equal(removed[id]!.code, "TOOL_PACKAGE_NOT_BOUND");
    const repeated = await wired.inject({
      method: "DELETE",
      url: `/v1/tool-packs/simple-toolkit/${second.package.version}/bindings`,
      payload: { engineIds: ["acp-a"] },
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(
      repeated.json<{ ok: boolean; results: EngineResult[] }>(),
      {
        ok: true,
        package: { id: "simple-toolkit", version: second.package.version },
        results: [
          {
            engineId: "acp-a",
            status: "skipped",
            code: "TOOL_PACKAGE_NOT_BOUND",
            reason: "This engine does not use the package version",
          },
        ],
        note: "Existing sessions keep their pinned engine revision; new sessions no longer receive these capabilities.",
      },
    );
  },
);

void test(
  "formal Gateway tool-pack routes take explicit engine lists, keep the legacy single-engine contract, store secret references only and reject invalid or offline-incompatible input",
  { timeout: 60_000 },
  async (t) => {
    const { dataDir, hub } = await hubWithEngines(t);
    const source = path.join(dataDir, "github-tools");
    await mkdir(path.join(source, "server"), { recursive: true });
    await writeFile(path.join(source, "server/index.mjs"), "export {};\n");
    await writeFile(
      path.join(source, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "node",
            args: ["server/index.mjs", "--repo", "${workspaceFolder}"],
            env: { GITHUB_TOKEN: SECRET, LOG_LEVEL: "info" },
          },
        },
      }),
    );
    const imported = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: { source, kind: "mcp", version: "1.0.0" },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    const pack = imported.json<{
      package: { id: string; version: string };
      warnings: string[];
    }>();
    assert.deepEqual(pack.package, { id: "github-tools", version: "1.0.0" });
    assert.match(pack.warnings.join("\n"), /GITHUB_TOKEN looks like a secret/);

    const applied = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: { engineIds: ["acp-a", "missing"], package: pack.package },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const results = applied.json<ApplyBody>();
    assert.equal(results.ok, false);
    assert.equal(byEngine(results.results)["acp-a"]!.status, "applied");
    assert.deepEqual(
      [
        byEngine(results.results).missing!.status,
        byEngine(results.results).missing!.code,
      ],
      ["failed", "ENGINE_UNAVAILABLE"],
    );
    const github = hub.app
      .engineProfile("acp-a")
      .configuration!.mcpServers!.find(
        (server) => server.name === "github-tools-github",
      )!;
    assert.deepEqual(github.env, { LOG_LEVEL: "info" });
    assert.deepEqual(github.secretEnv, {
      GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" },
    });
    assert.equal(github.args!.at(-1), SESSION_WORKSPACE_PLACEHOLDER);
    const engines = await hub.server.inject({
      method: "GET",
      url: "/v1/engines",
    });
    assert.equal(engines.body.includes(SECRET), false);
    for (const entry of await readdir(path.join(dataDir, "tool-packages"), {
      withFileTypes: true,
      recursive: true,
    }))
      if (entry.isFile())
        assert.equal(
          (
            await readFile(path.join(entry.parentPath, entry.name), "latin1")
          ).includes(SECRET),
          false,
          entry.name,
        );

    const legacy = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: {
        engineId: "acp-b",
        package: pack.package,
        workspace: dataDir,
      },
    });
    assert.equal(legacy.statusCode, 200, legacy.body);
    const single = legacy.json<ApplyBody>();
    assert.equal(single.engineId, "acp-b");
    assert.equal(single.revision, hub.app.engineProfile("acp-b").revision);
    assert.deepEqual(single.capabilities!.mcp, ["github-tools-github"]);
    assert.equal(single.results[0]!.status, "applied");
    assert.match(single.warnings.join("\n"), /workspace is ignored/);
    const unavailable = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/apply",
      payload: { engineId: "missing", package: pack.package },
    });
    assert.equal(unavailable.statusCode, 404, unavailable.body);
    assert.equal(
      unavailable.json<{ error: { code: string } }>().error.code,
      "ENGINE_UNAVAILABLE",
    );

    await writeFile(
      path.join(source, "mcp.json"),
      JSON.stringify({
        mcpServers: { fs: { command: "npx", args: ["-y", "server-fs"] } },
      }),
    );
    const offline = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: { source },
    });
    assert.equal(offline.statusCode, 400, offline.body);
    const offlineError = offline.json<{
      error: { code: string; message: string };
    }>().error;
    assert.equal(offlineError.code, "TOOL_PACKAGE_IMPORT_UNSUPPORTED");
    assert.match(offlineError.message, /npx downloads packages .* offline/);

    // A pasted mcp document: a remote server imports and applies like a file import;
    // a local command has no files next to it and gets the same offline guidance.
    const pasted = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: {
        mcp: {
          mcpServers: {
            "Team Wiki": { url: "https://wiki.example.test/mcp" },
          },
        },
        applyTo: ["acp-a"],
        replace: true,
      },
    });
    assert.equal(pasted.statusCode, 200, pasted.body);
    const pastedBody = pasted.json<{
      package: { id: string; version: string };
      counts: { skills: number; mcp: number; cli: number };
      apply: ApplyBody;
    }>();
    assert.equal(pastedBody.package.id, "mcp-team-wiki");
    assert.deepEqual(pastedBody.counts, { skills: 0, mcp: 1, cli: 0 });
    assert.equal(pastedBody.apply.results[0]!.status, "applied");
    const named = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: {
        mcp: { mcpServers: { wiki: { url: "https://wiki.example.test/mcp" } } },
        id: "team-wiki",
      },
    });
    assert.equal(named.statusCode, 200, named.body);
    assert.equal(
      named.json<{ package: { id: string } }>().package.id,
      "team-wiki",
    );
    const pastedLocal = await hub.server.inject({
      method: "POST",
      url: "/v1/tool-packs/import",
      payload: {
        mcp: { mcpServers: { fs: { command: "npx", args: ["-y", "fs"] } } },
      },
    });
    assert.equal(pastedLocal.statusCode, 400, pastedLocal.body);
    assert.equal(
      pastedLocal.json<{ error: { code: string } }>().error.code,
      "TOOL_PACKAGE_IMPORT_UNSUPPORTED",
    );

    for (const [method, url, payload, status, code] of [
      [
        "POST",
        "/v1/tool-packs/apply",
        { engineIds: ["acp-a"], engineId: "acp-a", package: pack.package },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/apply",
        { package: pack.package },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/apply",
        { engineIds: [], package: pack.package },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/apply",
        { engineIds: "all", package: pack.package, extra: true },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/import",
        { source: "relative/tools" },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/import",
        {
          source,
          mcp: { mcpServers: { a: { url: "https://a.example.test" } } },
        },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/import",
        { mcp: { mcpServers: {} } },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/import",
        {
          mcp: { mcpServers: { a: { url: "https://a.example.test" } } },
          kind: "cli",
        },
        400,
        "INVALID_REQUEST",
      ],
      [
        "POST",
        "/v1/tool-packs/import",
        { source, replace: true },
        400,
        "INVALID_REQUEST",
      ],
      [
        "DELETE",
        "/v1/tool-packs/github-tools/1.0.0/bindings",
        undefined,
        400,
        "INVALID_REQUEST",
      ],
      [
        "DELETE",
        "/v1/tool-packs/github-tools/1.0.0/bindings?engineIds=acp-a",
        { engineIds: ["acp-a"] },
        400,
        "INVALID_REQUEST",
      ],
      [
        "DELETE",
        "/v1/tool-packs/github-tools/9.9.9/bindings?engineIds=acp-a",
        undefined,
        404,
        "TOOL_PACKAGE_NOT_FOUND",
      ],
    ] as const) {
      const response = await hub.server.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(response.statusCode, status, `${url} ${response.body}`);
      assert.equal(
        response.json<{ error: { code: string } }>().error.code,
        code,
        response.body,
      );
    }
    const unbound = await hub.server.inject({
      method: "DELETE",
      url: "/v1/tool-packs/github-tools/1.0.0/bindings?engineIds=acp-a,acp-b",
    });
    assert.equal(unbound.statusCode, 200, unbound.body);
    assert.deepEqual(
      unbound
        .json<{ results: EngineResult[] }>()
        .results.map((result) => [result.engineId, result.status]),
      [
        ["acp-a", "unbound"],
        ["acp-b", "unbound"],
      ],
    );

    const openapi = await hub.server.inject({
      method: "GET",
      url: "/openapi.json",
    });
    const paths = openapi.json<{ paths: Record<string, unknown> }>().paths;
    for (const route of [
      "/v1/tool-packs",
      "/v1/tool-packs/apply",
      "/v1/tool-packs/import",
      "/v1/tool-packs/{id}/{version}/bindings",
    ])
      assert.ok(Object.hasOwn(paths, route), route);
  },
);
