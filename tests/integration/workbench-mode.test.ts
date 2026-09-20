import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "../../src/main.js";
import type { EngineProfile } from "../../src/domain/types.js";

type Hub = Awaited<ReturnType<typeof startHub>>;
const peer = fileURLToPath(
  new URL("../fixtures/configuration-peer.js", import.meta.url),
);

function engine(id: string) {
  return {
    id,
    driver: "acp" as const,
    command: [process.execPath, peer],
    configuration: { adapter: "copilot" as const },
  };
}

/**
 * `Start.cmd` starts the Competition entry with `--workbench` and no pinned engine, so the
 * console can choose one per task while `/session` keeps serving with the configured default.
 * The evaluation entries still pin their engine, which is covered by the Competition tests.
 */
void test(
  "an unpinned workbench Gateway serves /session with the default engine and keeps every engine selectable",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hh-workbench-"));
    let hub: Hub | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(root, { recursive: true, force: true });
    });
    const workspace = path.join(root, "workspace");
    await writeFile(
      path.join(root, "engines.json"),
      JSON.stringify({
        // Ordered so that a "first enabled engine" fallback would pick the wrong one.
        engines: [engine("beta"), engine("alpha")],
        workspaces: [{ id: "default", path: root }],
        defaultWorkspace: "default",
        defaultEngine: "alpha",
      }),
    );
    hub = await startHub({
      dataDir: path.join(root, "data"),
      configFile: path.join(root, "engines.json"),
      demo: false,
      competition: true,
      // No defaultEngine and no competitionEngine: exactly what `--workbench` passes.
      requireHarnessModel: false,
      cwd: root,
      port: 0,
    });

    const engines = await hub.server
      .inject({ method: "GET", url: "/v1/engines" })
      .then(
        (response) => response.json<{ engines: EngineProfile[] }>().engines,
      );
    assert.deepEqual(
      engines.map((profile) => profile.id).sort(),
      ["alpha", "beta"],
      "every enabled engine stays selectable",
    );

    const created = await hub.server.inject({
      method: "POST",
      url: "/session",
      payload: { title: "workbench", directory: workspace },
    });
    assert.equal(created.statusCode, 200, created.body);
    const session = created.json<{ id: string; directory: string }>();
    assert.equal(
      await readFile(path.join(workspace, ".keep"), "utf8").catch(() => ""),
      "",
      "the Session directory is created by POST /session",
    );

    // The Session runs on the configuration's defaultEngine, not the first listed one.
    const record = await hub.server
      .inject({ method: "GET", url: `/v1/sessions/${session.id}` })
      .then((response) => response.json<{ engineId: string }>());
    assert.equal(record.engineId, "alpha");

    // A per-task choice still works: the console picks any enabled engine explicitly.
    const chosen = await hub.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { engineId: "beta" },
    });
    assert.equal(chosen.statusCode, 201, chosen.body);
    assert.equal(chosen.json<{ engineId: string }>().engineId, "beta");
  },
);
