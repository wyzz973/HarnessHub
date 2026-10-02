import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHub } from "../../src/main.js";
import type { EngineProfile } from "../../src/domain/types.js";

void test(
  "Gateway rejects unknown registration fields, reserved ids and inline credentials before persistence",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-engine-validation-"));
    const options = {
      dataDir: join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
    };
    let hub = await startHub(options);
    t.after(async () => {
      await hub.server.close();
      await rm(directory, { recursive: true });
    });
    const registration = {
      id: "valid-cli",
      driver: "cli",
      command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      cli: { inputMode: "stdin" },
    };
    const invalid = [
      { ...registration, maxConcurency: 2 },
      { ...registration, cli: { inptMode: "argv" } },
      { ...registration, id: "default" },
      { ...registration, id: "fake" },
      {
        ...registration,
        command: [
          "/usr/bin/env",
          "DEEPSEEK_API_KEY=fixture-private-value",
          ...registration.command,
        ],
      },
      {
        ...registration,
        command: [process.execPath, "--api-key=fixture-private-value"],
      },
    ];
    for (const payload of invalid) {
      const result = await hub.server.inject({
        method: "POST",
        url: "/v1/engines",
        payload,
      });
      assert.equal(result.statusCode, 400, result.body);
      assert.equal(result.body.includes("fixture-private-value"), false);
      assert.deepEqual(hub.app.engines(), []);
    }
    const accepted = await hub.server.inject({
      method: "POST",
      url: "/v1/engines",
      payload: { ...registration, credentialEnv: ["DEEPSEEK_API_KEY"] },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const profile = accepted.json<EngineProfile>();
    assert.equal(profile.cli?.inputMode, "stdin");
    assert.deepEqual(profile.credentialEnv, ["DEEPSEEK_API_KEY"]);
    await hub.server.close();
    hub = await startHub(options);
    assert.equal(hub.app.engines().length, 1);
    assert.equal(hub.app.engines()[0]?.revision, profile.revision);
    assert.deepEqual(hub.app.engines()[0]?.credentialEnv, ["DEEPSEEK_API_KEY"]);
  },
);
