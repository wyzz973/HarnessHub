// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  BEGIN,
  END,
  parseArguments,
  renderTable,
  replaceBlock,
} from "./conformance.mjs";

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

test("the compatibility table has a column per item and the observations, pipes escaped", () => {
  const items = {
    tools: { result: "partial", detail: "no | token" },
    stream: { result: "pass", detail: "streamed" },
    cancel: { result: "fail", detail: "no 499" },
    usage: { result: "not run", detail: "rejected" },
  };
  assert.equal(
    renderTable([
      { ...row, items },
      { ...row, agent: "pi", name: "Pi", status: "not installed", reason: undefined, notes: [] },
    ]),
    [
      "| Agent | Version | Chat | Tools | Stream | Cancel | Usage | Date | Platform | Observed |",
      "|---|---|---|---|---|---|---|---|---|---|",
      "| Codex CLI (`codex`) | codex-cli 0.144.5 | partial | partial | ✓ | ✗ | not run | 2026-10-04 | darwin-arm64 | chat: rejected \\| upstream; tools: no \\| token; stream: streamed; cancel: no 499; usage: rejected; a note |",
      "| Pi (`pi`) | codex-cli 0.144.5 | not installed | - | - | - | - | 2026-10-04 | darwin-arm64 | - |",
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

test("the runner writes docs/compatibility.md only when asked, and refuses other arguments", () => {
  assert.deepEqual(parseArguments([]), { writeDocs: false });
  assert.deepEqual(parseArguments(["--write-docs"]), { writeDocs: true });
  // The old opt-out is gone with the default it opted out of.
  assert.throws(() => parseArguments(["--no-docs"]), /Unknown argument --no-docs/);
});
