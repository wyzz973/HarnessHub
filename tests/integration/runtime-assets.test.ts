// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startHub } from "@harnesshub/daemon/main";
import { assetPath } from "@harnesshub/agents/assets";
import type { RunRecord, SessionRecord } from "@harnesshub/core/types";
import { temporaryDirectory } from "../support/temporary.js";

/** Where this checkout kept the portable launcher before it moved into @harnesshub/agents. */
const LEGACY_LAUNCHER = fileURLToPath(
  new URL("../../../scripts/launch-engine.mjs", import.meta.url),
);

void test(
  "an engine command stored with the launcher's former scripts/ path keeps its record and runs through the moved launcher",
  { timeout: 30_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "hh-runtime-assets-",
    );
    const options = {
      dataDir: join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
    };
    let hub = await startHub(options);
    defer(() => hub.server.close());
    // The same registration as discovery made before the move: the launcher's
    // environment assignment, the boundary, then the engine command.
    const command = [
      process.execPath,
      LEGACY_LAUNCHER,
      "HH_ASSET_FIXTURE=unwrapped",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write(process.env.HH_ASSET_FIXTURE + ':'); process.stdin.pipe(process.stdout);",
    ];
    const registered = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: {
        id: "legacy-launcher",
        driver: "cli",
        command,
        cli: { inputMode: "stdin" },
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);

    // A restarted Gateway reads the record back unchanged from SQLite.
    await hub.server.close();
    hub = await startHub(options);
    assert.deepEqual(hub.app.engineProfile("legacy-launcher").command, command);

    const created = await hub.server.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: { engineId: "legacy-launcher" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const session = created.json<SessionRecord>();
    const accepted = await hub.server.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/runs`,
      payload: { text: "stored launcher", timeoutMs: 10_000 },
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    let run = accepted.json<RunRecord>();
    const deadline = Date.now() + 15_000;
    while (!run.finishedAt) {
      assert.ok(Date.now() < deadline, "the Run must reach a terminal state");
      await delay(20);
      run = (
        await hub.server.inject({ method: "GET", url: `/v1/runs/${run.id}` })
      ).json<RunRecord>();
    }
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    const events = hub.app.events(run.id);
    // Preparation recognised the launcher and applied its assignment.
    assert.equal(
      events
        .filter((event) => event.type === "message.delta")
        .map((event) => event.data.text)
        .join(""),
      "unwrapped:stored launcher",
    );
    // The installation evidence names the launcher where it is now.
    const installation = events.find(
      (event) => event.type === "engine.installation",
    )?.data.installation as { files: { path: string }[] } | undefined;
    const files = installation?.files.map((file) => file.path) ?? [];
    assert.ok(
      files.includes(await realpath(assetPath("launch-engine.mjs"))),
      files.join(", "),
    );
    assert.equal(files.includes(LEGACY_LAUNCHER), false);
    assert.deepEqual(hub.app.engineProfile("legacy-launcher").command, command);
  },
);
