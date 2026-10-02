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
  assert.throws(
    () => windowsTestFiles(root, "linux"),
    /requires native Windows/,
  );
  writeFileSync(join(root, "dist/tests/unit/windows-launch.test.js"), "");
  assert.throws(() => windowsTestFiles(root, "win32"), /suites are missing/);
});

test("Windows acceptance selects compiled native suites only after all required groups are present", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hh-windows-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suites = [
    "unit/windows-launch",
    "unit/windows-secrets",
    "integration/windows-engine-launch",
    "integration/windows-file-artifacts",
    "integration/windows-file-lock",
    "integration/windows-process",
  ];
  for (const suite of suites) {
    const file = join(root, "dist/tests", `${suite}.test.js`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
  }
  assert.equal(windowsTestFiles(root, "win32").length, 6);
});
