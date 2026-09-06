import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkSource } from "./check-boundaries.mjs";

const root = join(tmpdir(), "harnesshub-boundary-fixture", "src");
const check = (file, contents) => checkSource(join(root, file), contents, root);

test("release templates and tool packages cannot create a second execution path", () => {
  assert.deepEqual(
    check(
      "distribution/config.ts",
      'import type { EngineRegistration } from "../domain/engines.js";',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "tool-packages/store.ts",
      'import { openPrivate } from "../platform/windows-acl.js";',
    ),
    [],
  );
  assert.match(
    check(
      "distribution/run.ts",
      'import { AcpDriver } from "../drivers/acp/driver.js";',
    ).join("\n"),
    /distribution cannot depend on drivers/,
  );
  assert.match(
    check(
      "tool-packages/run.ts",
      'import { Runtime } from "../runtime/runtime.js";',
    ).join("\n"),
    /tool-packages cannot depend on runtime/,
  );
  assert.match(
    check(
      "gateway/tools.ts",
      'import { installLocal } from "../tool-packages/index.js";',
    ).join("\n"),
    /gateway cannot depend on tool-packages/,
  );
});

test("platform filesystem primitives have bounded dependencies and cannot leak into business modules", () => {
  assert.deepEqual(
    check(
      "artifacts/files.ts",
      'import { verifyPrivateFile } from "../platform/windows-acl.js";',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "platform/windows-acl.ts",
      'import { execFile } from "node:child_process";',
    ),
    [],
  );
  assert.match(
    check(
      "platform/windows-acl.ts",
      'import { Runtime } from "../runtime/run.js";',
    ).join("\n"),
    /platform cannot depend on runtime/,
  );
  assert.match(
    check(
      "runtime/run.ts",
      'import { verifyPrivateFile } from "../platform/windows-acl.js";',
    ).join("\n"),
    /runtime cannot depend on platform/,
  );
});

test("allows domain ports, ACP implementation and composition injection", () => {
  assert.deepEqual(
    check("runtime/run.ts", 'import type { Run } from "../domain/run.js";'),
    [],
  );
  assert.deepEqual(
    check("domain/ids.ts", 'import { randomUUID } from "node:crypto";'),
    [],
  );
  assert.deepEqual(
    check(
      "drivers/acp/index.ts",
      'import type { Runtime } from "acpx/runtime";',
    ),
    [],
  );
  assert.deepEqual(
    check("main.ts", 'import { Store } from "./storage/sqlite.js";'),
    [],
  );
});

for (const [kind, source] of [
  ["import", 'import { db } from "../storage/sqlite.js";'],
  ["type-only import", 'import type { Store } from "../storage/sqlite.js";'],
  ["re-export", 'export * from "../storage/sqlite.js";'],
  ["dynamic import", 'const db = import("../storage/sqlite.js");'],
  ["import type expression", 'type DB = import("../storage/sqlite.js").Store;'],
  ["require", 'const db = require("../storage/sqlite.js");'],
]) {
  test(`rejects Gateway to storage ${kind}`, () => {
    assert.match(
      check("gateway/http.ts", source).join("\n"),
      /gateway cannot depend on storage/,
    );
  });
}

test("rejects SDK leakage, Worker database access and unknown dynamic imports", () => {
  assert.match(
    check(
      "domain/driver.ts",
      'export type { AcpRuntime } from "acpx/runtime";',
    ).join("\n"),
    /drivers\/acp/,
  );
  assert.match(
    check("worker/main.ts", 'import { DatabaseSync } from "node:sqlite";').join(
      "\n",
    ),
    /SQLite belongs in storage/,
  );
  assert.match(
    check("gateway/http.ts", "const impl = import(name);").join("\n"),
    /nonliteral/,
  );
});

test("CLI returns nonzero for invalid fixtures and accepts a valid tree", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const gateway = join(directory, "gateway");
  mkdirSync(gateway);
  const file = join(gateway, "http.ts");
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)),
        directory,
      ],
      { encoding: "utf8" },
    );
  writeFileSync(file, 'import type { Store } from "../storage/sqlite.js";');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /gateway cannot depend on storage/);
  writeFileSync(file, 'import type { Run } from "../domain/run.js";');
  assert.equal(run().status, 0);
});

test("empty source tree cannot report success", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-empty-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)),
      directory,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No source files found/);
});
