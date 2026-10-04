// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { LibraryError } from "../src/library/errors.js";
import { LibraryStore } from "../src/library/store.js";
import { writeSkill } from "./library-support.js";
import { sandbox } from "./wiring-support.js";

const TIMES = {
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

void test("library store: skill files are stored as the same version as their directory, and invalid paths are refused", async (t) => {
  const { root, dataDir } = await sandbox(t);
  const store = new LibraryStore(dataDir);
  const source = await writeSkill(path.join(root, "src"), "pdf-tools", "PDFs.");
  const imported = await store.importSkill(source, []);
  const files = await store.skillFiles(imported.sha256, "pdf-tools");
  const stored = await store.storeSkillFiles("pdf-tools", files);
  assert.equal(stored.sha256, imported.sha256);
  assert.equal(stored.files, 2);

  const manifest = files.find((file) => file.path === "SKILL.md")!;
  for (const bad of [
    "../escape.md",
    "scripts/../../x",
    "a\\b",
    "/abs",
    ".git/config",
  ])
    await assert.rejects(
      store.storeSkillFiles("pdf-tools", [
        manifest,
        { path: bad, bytes: Buffer.from("x"), executable: false },
      ]),
      (error: unknown) =>
        error instanceof LibraryError && error.code === "LIBRARY_SKILL_INVALID",
      bad,
    );
  await assert.rejects(
    store.storeSkillFiles("other-name", [manifest]),
    (error: unknown) =>
      error instanceof LibraryError && error.code === "LIBRARY_SKILL_INVALID",
  );
  // Nothing is left behind by the refused ones.
  assert.deepEqual(
    (await readdir(path.join(store.directory, "skills"))).filter((name) =>
      name.startsWith("."),
    ),
    [],
  );
});

void test("library store: restore replaces and adds with the given timestamps, moves agents to the given sets, and mirrors on request", async (t) => {
  const { dataDir } = await sandbox(t);
  const store = new LibraryStore(dataDir);
  await store.putInstructionSet("mine", {
    text: "Mine.",
    agents: ["claude", "codex"],
  });
  await store.putInstructionSet("old", { text: "Old.", agents: ["gemini"] });
  await store.putMcpServer({
    name: "kept",
    transport: "stdio",
    command: "a",
    agents: [],
  });
  const given = {
    instructions: [
      {
        id: "team",
        name: "Team",
        text: "Team.",
        sha256: "0".repeat(64),
        size: 5,
        agents: ["claude" as const],
        ...TIMES,
      },
    ],
    mcp: [
      {
        name: "new",
        transport: "stdio" as const,
        command: "b",
        agents: [],
        ...TIMES,
      },
    ],
    skills: [],
  };
  await store.restore(given, false);
  const index = await store.index();
  assert.deepEqual(
    index.instructions.map((item) => [item.id, item.agents]),
    [
      ["mine", ["codex"]],
      ["old", ["gemini"]],
      ["team", ["claude"]],
    ],
  );
  assert.equal(await store.instructionText("team"), "Team.\n");
  assert.deepEqual(
    index.mcp.map((item) => [item.name, item.updatedAt]),
    [
      ["kept", index.mcp[0]!.updatedAt],
      ["new", TIMES.updatedAt],
    ],
  );

  const { removed } = await store.restore(given, true);
  assert.deepEqual(removed.instructions, ["mine", "old"]);
  assert.deepEqual(
    removed.mcp.map((item) => item.name),
    ["kept"],
  );
  const mirrored = await store.index();
  assert.deepEqual(
    mirrored.instructions.map((item) => item.id),
    ["team"],
  );
  await assert.rejects(store.instructionText("mine"));
});
