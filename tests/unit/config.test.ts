import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/engine/registry.js";

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
