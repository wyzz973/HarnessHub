// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { windowsTestFiles } from "./check-windows.mjs";

test("Windows acceptance rejects non-Windows hosts and incomplete builds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hh-windows-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const group of ["unit", "integration"])
    mkdirSync(join(root, "dist", "tests", group), { recursive: true });
  mkdirSync(join(root, "packages", "agents", "dist", "test"), {
    recursive: true,
  });
  assert.throws(
    () => windowsTestFiles(root, "linux"),
    /requires native Windows/,
  );
  writeFileSync(
    join(root, "packages/agents/dist/test/windows-launch.test.js"),
    "",
  );
  assert.throws(() => windowsTestFiles(root, "win32"), /suites are missing/);
});

test("Windows acceptance selects compiled native suites only after all required groups are present", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hh-windows-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suites = [
    "packages/agents/dist/test/windows-launch",
    "dist/tests/unit/windows-secrets",
    "dist/tests/integration/windows-engine-launch",
    "dist/tests/integration/windows-file-artifacts",
    "dist/tests/integration/windows-file-lock",
    "dist/tests/integration/windows-process",
  ];
  for (const suite of suites) {
    const file = join(root, `${suite}.test.js`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  assert.equal(windowsTestFiles(root, "win32").length, 6);
});
