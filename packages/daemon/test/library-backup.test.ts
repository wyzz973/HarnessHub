// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  isBackupLibrary,
  libraryView,
  withLibraryValues,
  type BackupLibrary,
} from "../src/library-backup.js";

const TIMES = {
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

function valid(): BackupLibrary {
  return {
    instructions: [
      { id: "team", name: "Team", text: "Rule.", agents: ["claude"], ...TIMES },
    ],
    mcp: [
      {
        name: "search",
        transport: "http",
        url: "https://mcp.example.test/",
        secretHeaders: { Authorization: { source: "store" } },
        agents: ["claude"],
        ...TIMES,
      },
    ],
    skills: [
      {
        name: "pdf-tools",
        description: "PDFs.",
        agents: [],
        files: { "SKILL.md": Buffer.from("---\n").toString("base64") },
        left: ["assets/model.bin"],
        ...TIMES,
      },
    ],
  };
}

void test("a carried Library is checked: invalid samples are refused", () => {
  assert.equal(isBackupLibrary(valid()), true);
  const invalid: Array<[string, (library: BackupLibrary) => unknown]> = [
    ["not an object", () => []],
    [
      "a set id",
      (l) => ({ ...l, instructions: [{ ...l.instructions[0]!, id: "Team" }] }),
    ],
    [
      "a set twice",
      (l) => ({ ...l, instructions: [l.instructions[0]!, l.instructions[0]!] }),
    ],
    [
      "an agent with two sets",
      (l) => ({
        ...l,
        instructions: [
          l.instructions[0]!,
          { ...l.instructions[0]!, id: "other" },
        ],
      }),
    ],
    [
      "a timestamp",
      (l) => ({ ...l, mcp: [{ ...l.mcp[0]!, updatedAt: "yesterday" }] }),
    ],
    [
      "a transport",
      (l) => ({ ...l, mcp: [{ ...l.mcp[0]!, transport: "ws" }] }),
    ],
    [
      "a secret value in a reference",
      (l) => ({
        ...l,
        mcp: [
          {
            ...l.mcp[0]!,
            secretHeaders: {
              Authorization: { source: "reference", kind: "store", name: "x" },
            },
          },
        ],
      }),
    ],
    ["a server twice", (l) => ({ ...l, mcp: [l.mcp[0]!, l.mcp[0]!] })],
    [
      "a skill name",
      (l) => ({ ...l, skills: [{ ...l.skills[0]!, name: "PDF" }] }),
    ],
    [
      "a file that is not base64",
      (l) => ({
        ...l,
        skills: [{ ...l.skills[0]!, files: { "SKILL.md": "not base64!" } }],
      }),
    ],
  ];
  for (const [label, make] of invalid)
    assert.equal(isBackupLibrary(make(valid())), false, label);
});

void test("sync compares the Library without the files left out, and keeps stored values a side does not carry", () => {
  const here = valid();
  const there = valid();
  delete there.skills[0]!.left;
  assert.deepEqual(libraryView(here), libraryView(there));

  const withValue = valid();
  withValue.mcp[0]!.secretHeaders = {
    Authorization: { source: "store", value: "synthetic-value" },
  };
  assert.deepEqual(withLibraryValues(here, withValue).mcp[0]!.secretHeaders, {
    Authorization: { source: "store", value: "synthetic-value" },
  });
  assert.deepEqual(withLibraryValues(withValue, here).mcp[0]!.secretHeaders, {
    Authorization: { source: "store", value: "synthetic-value" },
  });
});
