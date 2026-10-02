// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkManifest,
  checkSource,
  declaredDependencies,
  legacyPathOf,
} from "./check-boundaries.mjs";

const root = join(tmpdir(), "harnesshub-boundary-fixture");
/** Check a file at a repository path; `declared` enables that rule. */
const checkAt = (file, contents, declared) =>
  checkSource(join(root, file), contents, root, declared);
const cli = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));
/** Run the CLI on a repository directory. */
const run = (directory) =>
  spawnSync(process.execPath, [cli, directory], { encoding: "utf8" });
/** Write files below a directory, creating their parents. */
function write(directory, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, ...path.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }
}
const manifest = (name, dependencies = {}, devDependencies = {}) =>
  JSON.stringify({ name, dependencies, devDependencies });

test("release templates and tool packages cannot create a second execution path", () => {
  assert.deepEqual(
    checkAt(
      "packages/agents/src/distribution/config.ts",
      'import type { EngineRegistration } from "@harnesshub/core/engines";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/agents/src/tool-packages/store.ts",
      'import { ensurePrivateDirectory } from "@harnesshub/store/platform/windows-acl";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/agents/src/distribution/run.ts",
      'import { prepareConfiguration } from "../configuration/prepare.js";',
    ).join("\n"),
    /distribution cannot depend on drivers/,
  );
  assert.match(
    checkAt(
      "packages/agents/src/tool-packages/run.ts",
      'import { normalizeEngine } from "../engine/registry.js";',
    ).join("\n"),
    /tool-packages cannot depend on engine/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/tools.ts",
      'import { installLocal } from "@harnesshub/agents/tool-packages/index";',
    ).join("\n"),
    /gateway cannot depend on tool-packages/,
  );
});

test("diagnostic log files are written by process owners, never by business modules", () => {
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/worker/log.ts",
      'import { JsonLogFile } from "../logging/json-log-file.js";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/logging/json-log-file.ts",
      'import type { LogSink } from "@harnesshub/core/logging";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/daemon/src/logging/store.ts",
      'import { Runtime } from "@harnesshub/runtime/runtime/runtime";',
    ).join("\n"),
    /logging cannot depend on runtime/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/log.ts",
      'import { JsonLogFile } from "../logging/json-log-file.js";',
    ).join("\n"),
    /gateway cannot depend on logging/,
  );
  assert.match(
    checkAt(
      "packages/drivers/src/acp/log.ts",
      'import { JsonLogFile } from "@harnesshub/daemon/logging/json-log-file";',
    ).join("\n"),
    /packages\/drivers cannot depend on @harnesshub\/daemon/,
  );
});

test("platform filesystem primitives have bounded dependencies and cannot leak into business modules", () => {
  assert.deepEqual(
    checkAt(
      "packages/runtime/src/artifacts/files.ts",
      'import { verifyPrivateFile } from "@harnesshub/store/platform/windows-acl";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/store/src/platform/windows-acl.ts",
      'import { HubError } from "@harnesshub/core/errors";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/store/src/platform/windows-acl.ts",
      'import { SqliteStore } from "../storage/sqlite-store.js";',
    ).join("\n"),
    /platform cannot depend on storage/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import { verifyPrivateFile } from "@harnesshub/store/platform/windows-acl";',
    ).join("\n"),
    /runtime cannot depend on platform/,
  );
});

test("allows domain ports, ACP implementation and composition injection", () => {
  assert.deepEqual(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import type { Run } from "@harnesshub/core/run";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/core/src/ids.ts",
      'import { randomUUID } from "node:crypto";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/drivers/src/acp/index.ts",
      'import type { Runtime } from "acpx/runtime";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/main.ts",
      'import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";',
    ),
    [],
  );
});

const storage = "@harnesshub/store/storage/sqlite-store";
for (const [kind, source] of [
  ["import", `import { db } from "${storage}";`],
  ["type-only import", `import type { Store } from "${storage}";`],
  ["re-export", `export * from "${storage}";`],
  ["dynamic import", `const db = import("${storage}");`],
  ["import type expression", `type DB = import("${storage}").Store;`],
  ["require", `const db = require("${storage}");`],
]) {
  test(`rejects Gateway to storage ${kind}`, () => {
    assert.match(
      checkAt("packages/daemon/src/http/http.ts", source).join("\n"),
      /gateway cannot depend on storage/,
    );
  });
}

test("rejects SDK leakage, Worker database access and unknown dynamic imports", () => {
  assert.match(
    checkAt(
      "packages/core/src/driver.ts",
      'export type { AcpRuntime } from "acpx/runtime";',
    ).join("\n"),
    /drivers\/acp/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/worker/main.ts",
      'import { DatabaseSync } from "node:sqlite";',
    ).join("\n"),
    /SQLite belongs in storage/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/http.ts",
      "const impl = import(name);",
    ).join("\n"),
    /nonliteral/,
  );
});

test("CLI returns nonzero for invalid fixtures and accepts a valid tree", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  write(directory, {
    "packages/daemon/package.json": manifest("@harnesshub/daemon", {
      "@harnesshub/core": "workspace:*",
      "@harnesshub/store": "workspace:*",
    }),
    "packages/daemon/src/http/http.ts":
      'import type { Store } from "@harnesshub/store/storage/sqlite";',
  });
  const invalid = run(directory);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /gateway cannot depend on storage/);
  write(directory, {
    "packages/daemon/src/http/http.ts":
      'import type { Run } from "@harnesshub/core/run";',
  });
  const valid = run(directory);
  assert.equal(valid.status, 0, valid.stderr);
});

test("empty source tree cannot report success", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-empty-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = run(directory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No source files found/);
});

test("packages and applications follow the dependency graph", () => {
  assert.deepEqual(
    checkAt(
      "packages/store/src/storage/sqlite.ts",
      'import type { RunId } from "@harnesshub/core/types";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "apps/hh/src/main.ts",
      'import { main } from "@harnesshub/daemon/main";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/core/src/types.ts",
      'import type { Store } from "@harnesshub/store/storage/sqlite";',
    ).join("\n"),
    /packages\/core cannot depend on @harnesshub\/store/,
  );
  assert.match(
    checkAt(
      "packages/cli/src/cli.ts",
      'export { startHub } from "@harnesshub/daemon/main";',
    ).join("\n"),
    /packages\/cli cannot depend on @harnesshub\/daemon/,
  );
  assert.match(
    checkAt(
      "packages/core/test/types.test.ts",
      'const store = import("@harnesshub/store/storage/sqlite");',
    ).join("\n"),
    /packages\/core cannot depend on @harnesshub\/store/,
  );
  assert.match(
    checkAt(
      "apps/hh/src/main.ts",
      'import { open } from "@harnesshub/store/storage/sqlite";',
    ).join("\n"),
    /apps\/hh cannot depend on @harnesshub\/store/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/main.ts",
      'import { x } from "@harnesshub/nope/x";',
    ).join("\n"),
    /unknown workspace package: @harnesshub\/nope\/x/,
  );
  // V1: configuration preparation, in agents, may not reach the gateway.
  assert.match(
    checkAt(
      "packages/agents/src/configuration/prepare.ts",
      'import { startModelGateway } from "@harnesshub/gateway/gateway";',
    ).join("\n"),
    /packages\/agents cannot depend on @harnesshub\/gateway/,
  );
  assert.match(
    checkAt("packages/extras/src/index.ts", "export {};").join("\n"),
    /unknown package extras; add it to the dependency graph/,
  );
  assert.match(
    checkAt("apps/tray/src/main.ts", "export {};").join("\n"),
    /unknown app tray; add it to the dependency graph/,
  );
});

test("relative imports and new URL stay inside their package", () => {
  assert.deepEqual(
    checkAt(
      "packages/core/src/ipc.ts",
      'import { HubError } from "./errors.js";\nconst schema = new URL("./schema.json", import.meta.url);',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/core/test/ipc.test.ts",
      'import { parse } from "../src/ipc.js";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/core/src/ipc.ts",
      'import { startHub } from "../../../src/main.js";',
    ).join("\n"),
    /relative import leaves packages\/core: \.\.\/\.\.\/\.\.\/src\/main\.js/,
  );
  assert.match(
    checkAt(
      "packages/core/test/ipc.test.ts",
      'import { temporaryDirectory } from "../../../tests/support/temporary.js";',
    ).join("\n"),
    /relative import leaves packages\/core/,
  );
  assert.match(
    checkAt(
      "packages/core/src/ipc.ts",
      'const launcher = new URL("../../../scripts/launch-engine.mjs", import.meta.url);',
    ).join("\n"),
    /new URL leaves packages\/core: \.\.\/\.\.\/\.\.\/scripts\/launch-engine\.mjs/,
  );
  assert.match(
    checkAt(
      "apps/hh/src/main.ts",
      "const entry = new URL(`../${name}/main.js`, import.meta.url);",
    ).join("\n"),
    /nonliteral new URL\(\.\.\., import\.meta\.url\) cannot be checked/,
  );
});

test("legacy module and third-party rules apply inside packages", () => {
  assert.deepEqual(
    checkAt("packages/core/src/ipc.ts", 'import { Ajv } from "ajv";'),
    [],
  );
  assert.match(
    checkAt("packages/core/src/ipc.ts", 'import Fastify from "fastify";').join(
      "\n",
    ),
    /domain cannot import concrete dependency: fastify/,
  );
  assert.match(
    checkAt(
      "packages/sdk/src/index.ts",
      'import { DatabaseSync } from "node:sqlite";',
    ).join("\n"),
    /SQLite belongs in storage/,
  );
  assert.match(
    checkAt(
      "packages/plugin-host/src/index.ts",
      'import { spawn } from "node:child_process";',
    ).join("\n"),
    /process creation belongs in runtime's process\//,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import { open } from "../storage/sqlite.js";',
    ).join("\n"),
    /runtime cannot depend on storage/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";',
    ).join("\n"),
    /runtime cannot depend on storage/,
  );
  // Package tests have no module rules: only the graph and their declarations.
  assert.deepEqual(
    checkAt(
      "packages/core/test/ipc.test.ts",
      'import { spawn } from "node:child_process";',
    ),
    [],
  );
});

test("CLI scans packages and applications and does not follow their node_modules", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-pkg-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "packages", "core", "src");
  write(directory, {
    "packages/core/package.json": manifest("@harnesshub/core"),
  });
  mkdirSync(source, { recursive: true });
  mkdirSync(join(directory, "packages", "core", "node_modules"));
  // A junction needs no privilege on Windows; other systems ignore the type.
  symlinkSync(
    source,
    join(directory, "packages", "core", "node_modules", "self"),
    "junction",
  );
  writeFileSync(join(source, "types.ts"), 'import "@harnesshub/store/x";');
  const invalid = run(directory);
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stderr,
    /packages\/core\/src\/types\.ts:1 packages\/core cannot depend on @harnesshub\/store/,
  );
  writeFileSync(join(source, "types.ts"), "export type RunId = string;");
  const valid = run(directory);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /verified for 1 source files/);
});

test("SQLite belongs in the storage module of @harnesshub/store", () => {
  assert.deepEqual(
    checkAt(
      "packages/store/src/storage/sqlite-store.ts",
      'import { DatabaseSync } from "node:sqlite";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/store/src/platform/windows-acl.ts",
      'import { DatabaseSync } from "node:sqlite";',
    ).join("\n"),
    /SQLite belongs in storage of @harnesshub\/store/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/storage/cache.ts",
      'import { DatabaseSync } from "node:sqlite";',
    ).join("\n"),
    /SQLite belongs in storage of @harnesshub\/store/,
  );
});

test("child_process belongs in runtime's process/, and the files that once used it may not", () => {
  const source = 'import { execFile } from "node:child_process";';
  const rejected = /takes an injected ProcessLauncher/;
  assert.deepEqual(
    checkAt("packages/runtime/src/process/launcher.ts", source),
    [],
  );
  // The four former exceptions (ADR 0017 decision 4) and another store file.
  for (const file of [
    "packages/store/src/platform/windows-acl.ts",
    "packages/store/src/platform/windows-file-session.ts",
    "packages/secrets/src/secrets.ts",
    "packages/drivers/src/cli/driver.ts",
    "packages/agents/src/tool-command/command-mcp.ts",
    "packages/agents/src/tool-command/server.ts",
    "packages/store/src/storage/sqlite-store.ts",
  ])
    assert.match(checkAt(file, source).join("\n"), rejected, file);
  // They take the launcher's interface from core; the Worker entry creates it.
  const port =
    'import type { ProcessLauncher } from "@harnesshub/core/process-launcher";';
  assert.deepEqual(
    checkAt("packages/store/src/platform/windows-acl.ts", port),
    [],
  );
  assert.deepEqual(checkAt("packages/drivers/src/cli/driver.ts", port), []);
  const implementation =
    'import { sharedProcessLauncher } from "@harnesshub/runtime/process/launcher";';
  assert.deepEqual(
    checkAt("packages/daemon/src/worker/main.ts", implementation),
    [],
  );
  assert.match(
    checkAt("packages/drivers/src/cli/driver.ts", implementation).join("\n"),
    /packages\/drivers cannot depend on @harnesshub\/runtime/,
  );
  assert.match(
    checkAt("packages/daemon/src/http/engines.ts", implementation).join("\n"),
    /gateway cannot depend on process/,
  );
});

test("secrets keeps the drivers rules and starts its helper through an injected launcher", () => {
  assert.deepEqual(
    checkAt(
      "packages/agents/src/configuration/prepare.ts",
      'import { resolveSecret } from "@harnesshub/secrets/secrets";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/secrets.ts",
      'import { createSecret } from "@harnesshub/secrets/secrets";',
    ).join("\n"),
    /gateway cannot depend on drivers/,
  );
  assert.match(
    checkAt(
      "packages/secrets/src/secrets.ts",
      'import { open } from "@harnesshub/store/storage/sqlite-store";',
    ).join("\n"),
    /packages\/secrets cannot depend on @harnesshub\/store/,
  );
  assert.deepEqual(
    checkAt(
      "packages/secrets/src/secrets.ts",
      'import type { ProcessLauncher } from "@harnesshub/core/process-launcher";',
    ),
    [],
  );
  const source = 'import { spawn } from "node:child_process";';
  for (const file of [
    "packages/secrets/src/secrets.ts",
    "packages/secrets/src/native-helper.ts",
  ])
    assert.match(
      checkAt(file, source).join("\n"),
      /packages\/secrets takes an injected ProcessLauncher/,
      file,
    );
});

test("drivers keep their module rules, and only the Worker loads them inside the daemon", () => {
  const acp = 'import { AcpDriver } from "@harnesshub/drivers/acp/driver";';
  assert.match(
    checkAt("packages/runtime/src/runtime/run.ts", acp).join("\n"),
    /packages\/runtime cannot depend on @harnesshub\/drivers/,
  );
  assert.deepEqual(checkAt("packages/daemon/src/worker/main.ts", acp), []);
  assert.match(
    checkAt("packages/daemon/src/main.ts", acp).join("\n"),
    /only worker\/ of packages\/daemon may import @harnesshub\/drivers/,
  );
  // A daemon test may combine drivers with daemon code.
  assert.deepEqual(
    checkAt("packages/daemon/test/diagnostic-log.test.ts", acp),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/drivers/src/acp/driver.ts",
      'import { createAcpRuntime } from "acpx/runtime";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/drivers/src/cli/driver.ts",
      'import { createAcpRuntime } from "acpx/runtime";',
    ).join("\n"),
    /ACP SDK types and implementation belong in drivers\/acp/,
  );
  assert.match(
    checkAt(
      "packages/drivers/src/acp/driver.ts",
      'import { resolveSecret } from "@harnesshub/secrets/secrets";',
    ).join("\n"),
    /packages\/drivers cannot depend on @harnesshub\/secrets/,
  );
  const spawn = 'import { spawn } from "node:child_process";';
  for (const file of [
    "packages/drivers/src/cli/driver.ts",
    "packages/drivers/src/fake/driver.ts",
  ])
    assert.match(
      checkAt(file, spawn).join("\n"),
      /packages\/drivers takes an injected ProcessLauncher/,
      file,
    );
});

test("agents files keep the rules of the legacy modules they came from", () => {
  assert.equal(
    legacyPathOf("agents", "configuration/prepare.ts"),
    "drivers/configuration/prepare.ts",
  );
  assert.equal(
    legacyPathOf("agents", "engine/registry.ts"),
    "engine/registry.ts",
  );
  assert.equal(
    legacyPathOf("secrets", "secrets.ts"),
    "drivers/configuration/secrets.ts",
  );
  assert.equal(legacyPathOf("plugin-host", "index.ts"), undefined);
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/main.ts",
      'import { normalizeEngine } from "@harnesshub/agents/engine/registry";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/http/harness-model-routes.ts",
      'import { HarnessModelService } from "@harnesshub/agents/application/harness-model";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/engines.ts",
      'import { EngineManager } from "@harnesshub/agents/engine/manager";',
    ).join("\n"),
    /gateway cannot depend on engine/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import { prepareConfiguration } from "@harnesshub/agents/configuration/prepare";',
    ).join("\n"),
    /runtime cannot depend on drivers/,
  );
  assert.match(
    checkAt(
      "packages/agents/src/engine/registry.ts",
      'import { prepareConfiguration } from "../configuration/prepare.js";',
    ).join("\n"),
    /engine cannot depend on drivers/,
  );
  // Package-level code is shared by the package's modules.
  assert.deepEqual(
    checkAt(
      "packages/agents/src/engine/discovery.ts",
      'import { assetPath } from "../assets.js";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/agents/src/configuration/prepare.ts",
      'import { isFormerCommandMcpEntry } from "../tool-command/entry.js";',
    ),
    [],
  );
});

test("agents resolves its runtime assets inside the package, and no file may resolve URLs outside it", () => {
  assert.deepEqual(
    checkSource(
      join(root, "packages/agents/src/assets.ts"),
      'const launcher = new URL("../../assets/launch-engine.mjs", import.meta.url);',
      root,
    ),
    [],
  );
  // The former exception for repository.ts is gone.
  const helper = join(root, "packages/agents/src/repository.ts");
  assert.match(
    checkSource(
      helper,
      "const file = new URL(`../../../../${relative}`, import.meta.url);",
      root,
    ).join("\n"),
    /nonliteral new URL\(\.\.\., import\.meta\.url\) cannot be checked/,
  );
  assert.match(
    checkSource(
      helper,
      'const launcher = new URL("../../../../scripts/launch-engine.mjs", import.meta.url);',
      root,
    ).join("\n"),
    /new URL leaves packages\/agents: \.\.\/\.\.\/\.\.\/\.\.\/scripts\/launch-engine\.mjs/,
  );
  assert.match(
    checkSource(
      join(root, "packages/agents/src/configuration/launch.ts"),
      'const launcher = new URL("../../../../scripts/launch-engine.mjs", import.meta.url);',
      root,
    ).join("\n"),
    /new URL leaves packages\/agents: \.\.\/\.\.\/\.\.\/\.\.\/scripts\/launch-engine\.mjs/,
  );
  const spawn = 'import { spawn } from "node:child_process";';
  for (const file of [
    "packages/agents/src/tool-command/server.ts",
    "packages/agents/src/configuration/launch.ts",
  ])
    assert.match(
      checkAt(file, spawn).join("\n"),
      /packages\/agents takes an injected ProcessLauncher/,
      file,
    );
});

test("runtime owns process creation for good, and the probe keeps its drivers rules", () => {
  const spawn = 'import { spawn } from "node:child_process";';
  // A permanent home, not an exception.
  assert.deepEqual(
    checkAt("packages/runtime/src/process/worker-host.ts", spawn),
    [],
  );
  assert.match(
    checkAt("packages/runtime/src/application/service.ts", spawn).join("\n"),
    /packages\/runtime takes an injected ProcessLauncher/,
  );
  assert.equal(
    legacyPathOf("runtime", "process/probe.ts"),
    "drivers/configuration/probe.ts",
  );
  assert.equal(
    legacyPathOf("runtime", "process/leases.ts"),
    "process/leases.ts",
  );
  const prepared =
    'import type { PreparedConfiguration } from "@harnesshub/agents/configuration/prepare";';
  assert.deepEqual(
    checkAt("packages/runtime/src/process/probe.ts", prepared),
    [],
  );
  assert.match(
    checkAt("packages/runtime/src/process/leases.ts", prepared).join("\n"),
    /process cannot depend on drivers/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/runtime.ts",
      'import { startModelGateway } from "@harnesshub/gateway/gateway";',
    ).join("\n"),
    /packages\/runtime cannot depend on @harnesshub\/gateway/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/server.ts",
      'import { ProcessWorkerHost } from "@harnesshub/runtime/process/worker-host";',
    ).join("\n"),
    /gateway cannot depend on process/,
  );
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/main.ts",
      'import { probeConfiguration } from "@harnesshub/runtime/process/probe";',
    ),
    [],
  );
});

test("the daemon's http/ keeps the gateway rules, cli stays on core, and URLs resolve from dist", () => {
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/http/server.ts",
      'import type { HubApplication } from "@harnesshub/runtime/application/service";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/daemon/src/http/engines.ts",
      'import { EngineManager } from "@harnesshub/agents/engine/manager";',
    ).join("\n"),
    /gateway cannot depend on engine/,
  );
  assert.match(
    checkAt(
      "packages/daemon/src/logging/store.ts",
      'import { Runtime } from "@harnesshub/runtime/runtime/runtime";',
    ).join("\n"),
    /logging cannot depend on runtime/,
  );
  assert.deepEqual(
    checkAt(
      "packages/cli/src/rollout/export.ts",
      'import type { RunId } from "@harnesshub/core/types";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/cli/src/cli.ts",
      'import { Runtime } from "@harnesshub/runtime/runtime/runtime";',
    ).join("\n"),
    /packages\/cli cannot depend on @harnesshub\/runtime/,
  );
  // packages/daemon/dist/src/benchmark-main.js reads packages/daemon/package.json.
  assert.deepEqual(
    checkAt(
      "packages/daemon/src/benchmark-main.ts",
      'const file = new URL("../../package.json", import.meta.url);',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/daemon/src/benchmark-main.ts",
      'const file = new URL("../../../package.json", import.meta.url);',
    ).join("\n"),
    /new URL leaves packages\/daemon: \.\.\/\.\.\/\.\.\/package\.json/,
  );
});

test("the console reaches the daemon only through the sdk", () => {
  assert.deepEqual(
    checkAt(
      "packages/console/lib/api.ts",
      'import type { Client } from "@harnesshub/sdk/index";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/console/app/page.tsx",
      'import { contracts } from "../lib/contracts";\nimport { Button } from "@/components/ui/button";',
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/console/lib/contracts.ts",
      'import type { RunId } from "@harnesshub/core/types";',
    ).join("\n"),
    /packages\/console cannot depend on @harnesshub\/core/,
  );
  assert.match(
    checkAt(
      "packages/console/components/run.tsx",
      'import { startHub } from "@harnesshub/daemon/main";',
    ).join("\n"),
    /packages\/console cannot depend on @harnesshub\/daemon/,
  );
  assert.match(
    checkAt(
      "packages/console/lib/server.ts",
      'import { createGateway } from "../../daemon/src/http/server.js";',
    ).join("\n"),
    /relative import leaves packages\/console/,
  );
});

test("CLI scans the console's app/, components/ and lib/", (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "harnesshub-boundaries-console-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  write(directory, {
    "packages/console/package.json": manifest("@harnesshub/console"),
    "packages/console/lib/contracts.ts": 'import "@harnesshub/core/types";',
  });
  const invalid = run(directory);
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stderr,
    /packages\/console\/lib\/contracts\.ts:1 packages\/console cannot depend on @harnesshub\/core/,
  );
  write(directory, {
    "packages/console/lib/contracts.ts": "export const ok = true;",
  });
  assert.equal(run(directory).status, 0);
});

test("package manifests declare only the internal dependencies of their graph entry", () => {
  assert.deepEqual(
    checkManifest("package", "runtime", {
      name: "@harnesshub/runtime",
      dependencies: { "@harnesshub/core": "workspace:*", ajv: "8.20.0" },
    }),
    [],
  );
  assert.deepEqual(
    checkManifest("app", "hh", {
      name: "harnesshub",
      dependencies: { "@harnesshub/cli": "workspace:*" },
    }),
    [],
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])
    assert.match(
      checkManifest("package", "cli", {
        name: "@harnesshub/cli",
        [field]: { "@harnesshub/daemon": "workspace:*" },
      }).join("\n"),
      new RegExp(
        `packages/cli/package\\.json declares @harnesshub/daemon in ${field}, outside its dependency graph`,
      ),
    );
  assert.match(
    checkManifest("app", "hh", {
      name: "harnesshub",
      dependencies: { "@harnesshub/store": "workspace:*" },
    }).join("\n"),
    /apps\/hh\/package\.json declares @harnesshub\/store in dependencies/,
  );
  // No package may depend on the application.
  assert.match(
    checkManifest("package", "daemon", {
      name: "@harnesshub/daemon",
      devDependencies: { harnesshub: "workspace:*" },
    }).join("\n"),
    /declares harnesshub in devDependencies, outside its dependency graph/,
  );
  assert.match(
    checkManifest("package", "core", { name: "@harnesshub/kernel" }).join("\n"),
    /packages\/core\/package\.json is named "@harnesshub\/kernel", not @harnesshub\/core/,
  );
  assert.match(
    checkManifest("package", "extras", { name: "@harnesshub/extras" }).join(
      "\n",
    ),
    /unknown package extras; add it to the dependency graph/,
  );
});

test("imports target only the dependencies their package declares, internal and third-party alike", () => {
  const declared = declaredDependencies(
    {
      dependencies: { "@harnesshub/core": "workspace:*", yaml: "2.9.0" },
      peerDependencies: { react: "19" },
      optionalDependencies: { fsevents: "2" },
      devDependencies: { fastify: "5" },
    },
    "src",
  );
  assert.deepEqual([...declared].sort(), [
    "@harnesshub/core",
    "fsevents",
    "react",
    "yaml",
  ]);
  assert.equal(
    declaredDependencies({ devDependencies: { fastify: "5" } }, "test").has(
      "fastify",
    ),
    true,
  );
  const file = "packages/agents/src/engine/registry.ts";
  for (const source of [
    'import { parse } from "yaml";',
    'import type { Document } from "yaml";',
    'export { parse } from "yaml";',
    'const yaml = import("yaml");',
    'type Y = import("yaml").Document;',
  ])
    assert.deepEqual(checkAt(file, source, declared), [], source);
  // Hoisting would let these resolve at run time; the manifest decides.
  assert.match(
    checkAt(file, 'import Fastify from "fastify";', declared).join("\n"),
    /packages\/agents imports fastify without declaring it in package\.json \(dependencies, peerDependencies or optionalDependencies\)/,
  );
  assert.match(
    checkAt(
      file,
      'import { open } from "@harnesshub/store/storage/sqlite-store";',
      declared,
    ).join("\n"),
    /packages\/agents imports @harnesshub\/store without declaring it/,
  );
  assert.match(
    checkAt(file, 'const parse = require("ajv");', declared).join("\n"),
    /imports ajv without declaring it/,
  );
  // Tests may use devDependencies; built-ins need no declaration.
  assert.deepEqual(
    checkAt(
      "packages/agents/test/registry.test.ts",
      'import Fastify from "fastify";\nimport { readFile } from "node:fs/promises";\nimport path from "path";',
      declaredDependencies({ devDependencies: { fastify: "5" } }, "test"),
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/agents/test/registry.test.ts",
      'import { parse } from "yaml";',
      new Set(),
    ).join("\n"),
    /imports yaml without declaring it in package\.json \(dependencies or devDependencies\)/,
  );
  // The console's "@/" alias is its own directory, not a package.
  assert.deepEqual(
    checkAt(
      "packages/console/app/page.tsx",
      'import { Button } from "@/components/ui/button";',
      new Set(),
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/console/app/page.tsx",
      'import { x } from "@/../daemon/src/main";',
      new Set(),
    ).join("\n"),
    /relative import leaves packages\/console/,
  );
});

test("root tests use what the root package.json declares and stay in tests/", () => {
  const declared = new Set(["acpx", "@harnesshub/daemon"]);
  assert.deepEqual(
    checkAt(
      "tests/integration/run.test.ts",
      'import { startHub } from "@harnesshub/daemon/main";\nimport "acpx/runtime";\nimport { spawn } from "node:child_process";\nimport { temporaryDirectory } from "../support/temporary.js";\nconst copy = await import(location);',
      declared,
    ),
    [],
  );
  assert.match(
    checkAt(
      "tests/integration/run.test.ts",
      'import Fastify from "fastify";',
      declared,
    ).join("\n"),
    /tests imports fastify without declaring it in package\.json/,
  );
  assert.match(
    checkAt(
      "tests/integration/run.test.ts",
      'import { open } from "@harnesshub/store/storage/sqlite-store";',
      declared,
    ).join("\n"),
    /tests imports @harnesshub\/store without declaring it/,
  );
  assert.match(
    checkAt(
      "tests/unit/prepare.test.ts",
      'import { prepare } from "../../packages/agents/src/configuration/prepare.js";',
      declared,
    ).join("\n"),
    /relative import leaves tests/,
  );
});

for (const tree of ["conformance", "tests/e2e", "tests/browser", "examples"]) {
  test(`${tree}/ is a black box: only core, sdk, HTTP and the hh command`, () => {
    const file = `${tree}/run/lifecycle.test.mjs`;
    assert.deepEqual(
      checkAt(
        file,
        [
          'import { createClient } from "@harnesshub/sdk/index";',
          'import type { RunId } from "@harnesshub/core/types";',
          'import { request } from "node:http";',
          'import { spawn } from "node:child_process";',
          'import { fixture } from "./fixture.mjs";',
          'const data = new URL("./data.json", import.meta.url);',
        ].join("\n"),
      ),
      [],
    );
    const rejected =
      /black-box code may use only @harnesshub\/core, @harnesshub\/sdk, HTTP and the hh command/;
    assert.match(
      checkAt(file, 'import { startHub } from "@harnesshub/daemon/main";').join(
        "\n",
      ),
      rejected,
    );
    assert.match(
      checkAt(file, 'const { Fastify } = await import("fastify");').join("\n"),
      rejected,
    );
    assert.match(
      checkAt(
        file,
        `import { startHub } from "${"../".repeat(tree.split("/").length + 1)}packages/daemon/src/main.js";`,
      ).join("\n"),
      new RegExp(`relative import leaves ${tree}`),
    );
    assert.match(
      checkAt(
        file,
        `const main = new URL("${"../".repeat(tree.split("/").length + 1)}packages/daemon/dist/src/main.js", import.meta.url);`,
      ).join("\n"),
      new RegExp(`new URL leaves ${tree}`),
    );
  });
}

test("CLI fails on a manifest outside the graph, a missing manifest, an undeclared import and a black-box violation", (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "harnesshub-boundaries-oss005-"),
  );
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = {
    "package.json": manifest("harnesshub-workspace", {}, { yaml: "2.9.0" }),
    "packages/agents/package.json": manifest("@harnesshub/agents", {
      yaml: "2.9.0",
    }),
    "packages/agents/src/engine/registry.ts": 'import { parse } from "yaml";',
    "tests/unit/types.test.ts": 'import { parse } from "yaml";',
    "examples/lifecycle.mjs": 'import { request } from "node:http";',
  };
  write(directory, valid);
  const passed = run(directory);
  assert.equal(passed.status, 0, passed.stderr);
  for (const [files, message] of [
    [
      {
        "packages/agents/package.json": manifest("@harnesshub/agents", {
          yaml: "2.9.0",
          "@harnesshub/daemon": "workspace:*",
        }),
      },
      /packages\/agents\/package\.json declares @harnesshub\/daemon in dependencies, outside its dependency graph/,
    ],
    [
      { "packages/agents/package.json": manifest("@harnesshub/agents") },
      /packages\/agents\/src\/engine\/registry\.ts:1 packages\/agents imports yaml without declaring it/,
    ],
    [
      { "package.json": manifest("harnesshub-workspace") },
      /tests\/unit\/types\.test\.ts:1 tests imports yaml without declaring it/,
    ],
    [
      { "examples/lifecycle.mjs": 'import { parse } from "yaml";' },
      /examples\/lifecycle\.mjs:1 black-box code may use only/,
    ],
    [
      { "packages/sdk/src/index.ts": "export {};" },
      /packages\/sdk\/package\.json is missing/,
    ],
  ]) {
    write(directory, files);
    const failed = run(directory);
    assert.equal(failed.status, 1, JSON.stringify(files));
    assert.match(failed.stderr, message);
    rmSync(join(directory, "packages", "sdk"), {
      recursive: true,
      force: true,
    });
    write(directory, valid);
  }
});

test("agents' assets/ and applications' bin/ import only declared packages and stay in their package", () => {
  const agents = new Set(["cross-spawn", "yaml"]);
  // Program areas have no module rules: assets launchers start their engine
  // themselves (ADR 0017, F08 addendum).
  assert.deepEqual(
    checkAt(
      "packages/agents/assets/spawn-engine.mjs",
      'import spawn from "cross-spawn";\nimport { spawn as start } from "node:child_process";\nimport { parse } from "yaml";\nimport { spawnEngine } from "./spawn-engine.mjs";',
      agents,
    ),
    [],
  );
  assert.match(
    checkAt(
      "packages/agents/assets/launch-pi-acp.mjs",
      'import { execa } from "execa";',
      agents,
    ).join("\n"),
    /packages\/agents imports execa without declaring it in package\.json \(dependencies, peerDependencies or optionalDependencies\)/,
  );
  assert.match(
    checkAt(
      "packages/agents/assets/launch-pi-acp.mjs",
      'import { startHub } from "../../daemon/dist/src/main.js";',
      agents,
    ).join("\n"),
    /relative import leaves packages\/agents/,
  );
  // Only the named file may import a computed path.
  const computed = "const sdk = await import(config.sdk.index);";
  assert.deepEqual(
    checkAt(
      "packages/agents/assets/native-mcp/pi-extension.mjs",
      computed,
      agents,
    ),
    [],
  );
  assert.match(
    checkAt("packages/agents/assets/launch-pi-acp.mjs", computed, agents).join(
      "\n",
    ),
    /nonliteral import\/require cannot be checked/,
  );
  assert.match(
    checkAt(
      "packages/agents/assets/native-mcp/pi-extension.mjs",
      "const sdk = require(config.sdk.index);",
      agents,
    ).join("\n"),
    /nonliteral import\/require cannot be checked/,
  );
  const hh = new Set(["@harnesshub/cli", "@harnesshub/daemon"]);
  assert.deepEqual(
    checkAt(
      "apps/hh/bin/hh.mjs",
      'import { main } from "../dist/src/main.js";',
      hh,
    ),
    [],
  );
  assert.match(
    checkAt("apps/hh/bin/hh.mjs", 'import chalk from "chalk";', hh).join("\n"),
    /apps\/hh imports chalk without declaring it in package\.json/,
  );
  assert.match(
    checkAt(
      "apps/hh/bin/hh.mjs",
      'import { open } from "@harnesshub/store/storage/sqlite-store";',
      hh,
    ).join("\n"),
    /apps\/hh cannot depend on @harnesshub\/store/,
  );
});
