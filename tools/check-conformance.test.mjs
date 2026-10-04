// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { BEGIN, END, renderTable, replaceBlock } from "./conformance.mjs";

const row = {
  agent: "codex",
  name: "Codex CLI",
  version: "codex-cli 0.144.5",
  status: "partially verified",
  reason: "rejected | upstream",
  notes: ["a note"],
  date: "2026-10-04",
  platform: "darwin-arm64",
};

test("the compatibility table has a row per agent with its reason and notes, pipes escaped", () => {
  assert.equal(
    renderTable([row, { ...row, agent: "pi", name: "Pi", reason: undefined, notes: [] }]),
    [
      "| Agent | Version | Status | Date | Platform | Observed |",
      "|---|---|---|---|---|---|",
      "| Codex CLI (`codex`) | codex-cli 0.144.5 | partially verified | 2026-10-04 | darwin-arm64 | rejected \\| upstream; a note |",
      "| Pi (`pi`) | codex-cli 0.144.5 | partially verified | 2026-10-04 | darwin-arm64 | - |",
    ].join("\n"),
  );
});

test("only the generated block of the document is replaced; a document without it is refused", () => {
  const document = `# Title\n\nBefore.\n\n${BEGIN}\n\nold table\n\n${END}\n\nAfter.\n`;
  assert.equal(
    replaceBlock(document, "new table"),
    `# Title\n\nBefore.\n\n${BEGIN}\n\nnew table\n\n${END}\n\nAfter.\n`,
  );
  assert.throws(() => replaceBlock("# Title\n", "new table"), /lacks the/);
  assert.throws(() => replaceBlock(`${END}\n${BEGIN}\n`, "x"), /lacks the/);
});
