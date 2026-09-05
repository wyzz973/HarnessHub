import assert from "node:assert/strict";
import test from "node:test";
import { Ajv } from "ajv";
import {
  createSessionSchema,
  runInputSchema,
} from "../../src/domain/schemas.js";

void test("HTTP schemas reject invalid controls and accept explicit demo inputs", () => {
  const ajv = new Ajv();
  const run = ajv.compile(runInputSchema);
  assert.equal(
    run({ text: "task", timeoutMs: 1000, fixture: { scenario: "permission" } }),
    true,
  );
  for (const invalid of [
    { text: "" },
    { text: "x", timeoutMs: -1 },
    { text: "x", fixture: { scenario: "unknown" } },
    { text: "x", command: "shell" },
  ])
    assert.equal(run(invalid), false);
  const session = ajv.compile(createSessionSchema);
  assert.equal(session({ engineId: "fake", workspaceId: "default" }), true);
  assert.equal(session({ cwd: "/unregistered" }), false);
});
