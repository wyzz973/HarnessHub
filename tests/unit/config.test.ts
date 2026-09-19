import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMPETITION_RUN_TIMEOUT_MS,
  RUN_TIMEOUT_ENVIRONMENT,
  loadConfig,
} from "../../src/engine/registry.js";

void test("profile resolution rejects invalid fields and allows an empty registry for dynamic registration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  assert.equal(
    (await loadConfig({ cwd: directory, demo: false })).defaultEngine,
    "",
  );
  assert.equal(
    (await loadConfig({ cwd: directory, demo: true })).defaultEngine,
    "fake",
  );
  const file = path.join(directory, "config.json");
  for (const invalid of [
    { typo: true },
    {
      engines: [
        { id: "engine", driver: "acp", command: ["engine"], enabled: "false" },
      ],
    },
    {
      engines: [
        {
          id: "engine",
          driver: "acp",
          command: ["engine"],
          credentialEnv: ["not-a-variable"],
        },
      ],
    },
    { workspaces: [{ id: "bad", path: file }] },
  ]) {
    await writeFile(file, JSON.stringify(invalid));
    await assert.rejects(loadConfig({ cwd: directory, demo: true, file }));
  }
});

void test("Competition Runs default to one hour; the configuration file and HARNESSHUB_RUN_TIMEOUT_MS override it and invalid values fail", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-config-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const environment = {};
  const deadline = async (
    options: {
      competition?: boolean;
      file?: string;
      environment?: Record<string, string>;
    } = {},
  ) =>
    (
      await loadConfig({
        cwd: directory,
        demo: true,
        environment,
        ...options,
      })
    ).defaultTimeoutMs;
  assert.equal(RUN_TIMEOUT_ENVIRONMENT, "HARNESSHUB_RUN_TIMEOUT_MS");
  assert.equal(await deadline(), 60_000);
  assert.equal(await deadline({ competition: true }), 3_600_000);
  assert.equal(COMPETITION_RUN_TIMEOUT_MS, 3_600_000);
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({ defaultTimeoutMs: 90_000 }));
  assert.equal(await deadline({ competition: true, file }), 90_000);
  const override = { HARNESSHUB_RUN_TIMEOUT_MS: " 7200000 " };
  assert.equal(
    await deadline({ competition: true, file, environment: override }),
    7_200_000,
  );
  assert.equal(await deadline({ environment: override }), 7_200_000);
  assert.equal(
    await deadline({
      competition: true,
      environment: { HARNESSHUB_RUN_TIMEOUT_MS: "" },
    }),
    3_600_000,
  );
  for (const value of ["0", "-5", "1.5", "1e6", "abc", "60s", "86400001"])
    await assert.rejects(
      deadline({
        competition: true,
        environment: { HARNESSHUB_RUN_TIMEOUT_MS: value },
      }),
      /HARNESSHUB_RUN_TIMEOUT_MS must be whole milliseconds/,
      value,
    );
  assert.equal(
    await deadline({ environment: { HARNESSHUB_RUN_TIMEOUT_MS: "86400000" } }),
    86_400_000,
  );
});
