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
  checkSource,
  legacyDestination,
  legacyPathOf,
} from "./check-boundaries.mjs";

const root = join(tmpdir(), "harnesshub-boundary-fixture");
const check = (file, contents) =>
  checkSource(join(root, "src", file), contents, root);
const checkAt = (file, contents) =>
  checkSource(join(root, file), contents, root);

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

test("diagnostic log files are written by process owners, never by business modules", () => {
  assert.deepEqual(
    check(
      "worker/log.ts",
      'import { JsonLogFile } from "../logging/json-log-file.js";',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "logging/json-log-file.ts",
      'import type { LogSink } from "../domain/logging.js";',
    ),
    [],
  );
  assert.match(
    check(
      "logging/store.ts",
      'import { Runtime } from "../runtime/runtime.js";',
    ).join("\n"),
    /logging cannot depend on runtime/,
  );
  assert.match(
    check(
      "gateway/log.ts",
      'import { JsonLogFile } from "../logging/json-log-file.js";',
    ).join("\n"),
    /gateway cannot depend on logging/,
  );
  assert.match(
    check(
      "drivers/acp/log.ts",
      'import { JsonLogFile } from "../../logging/json-log-file.js";',
    ).join("\n"),
    /drivers cannot depend on logging/,
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
  const gateway = join(directory, "src", "gateway");
  mkdirSync(gateway, { recursive: true });
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

test("src imports a package only through its legacy alias, under the aliased module's rules", () => {
  assert.deepEqual(
    check(
      "gateway/http.ts",
      'import type { RunId } from "@harnesshub/core/types";',
    ),
    [],
  );
  assert.deepEqual(
    check("main.ts", 'import { HubError } from "@harnesshub/core/errors";'),
    [],
  );
  assert.match(
    check("cli.ts", 'import { client } from "@harnesshub/sdk/index";').join(
      "\n",
    ),
    /src cannot import @harnesshub\/sdk before it has a legacy alias/,
  );
  assert.match(
    check("main.ts", 'import { x } from "@harnesshub/nope/x";').join("\n"),
    /unknown workspace package: @harnesshub\/nope\/x/,
  );
  assert.match(
    check(
      "worker/main.ts",
      'import type { Run } from "../../packages/core/src/types.js";',
    ).join("\n"),
    /worker cannot depend on outside-src/,
  );
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
    /process creation belongs in ProcessHost or Driver/,
  );
  assert.match(
    checkAt(
      "packages/runtime/src/runtime/run.ts",
      'import { open } from "../storage/sqlite.js";',
    ).join("\n"),
    /runtime cannot depend on storage/,
  );
  // Tests are bound by the graph only, as tests/ is not scanned at all.
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
  mkdirSync(source, { recursive: true });
  mkdirSync(join(directory, "packages", "core", "node_modules"));
  // A junction needs no privilege on Windows; other systems ignore the type.
  symlinkSync(
    source,
    join(directory, "packages", "core", "node_modules", "self"),
    "junction",
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)),
        directory,
      ],
      { encoding: "utf8" },
    );
  writeFileSync(join(source, "types.ts"), 'import "@harnesshub/store/x";');
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stderr,
    /packages\/core\/src\/types\.ts:1 packages\/core cannot depend on @harnesshub\/store/,
  );
  writeFileSync(join(source, "types.ts"), "export type RunId = string;");
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /verified for 1 source files/);
});

test("src imports @harnesshub/store only through its legacy modules, under their rules", () => {
  assert.deepEqual(
    check(
      "main.ts",
      'import { SqliteStore } from "@harnesshub/store/storage/sqlite-store";',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "artifacts/publisher.ts",
      'import { verifyPrivateFile } from "@harnesshub/store/platform/windows-acl";',
    ),
    [],
  );
  assert.match(
    check(
      "gateway/http.ts",
      'import type { SqliteStore } from "@harnesshub/store/storage/sqlite-store";',
    ).join("\n"),
    /gateway cannot depend on storage/,
  );
  assert.match(
    check(
      "runtime/run.ts",
      'import { verifyPrivateFile } from "@harnesshub/store/platform/windows-acl";',
    ).join("\n"),
    /runtime cannot depend on platform/,
  );
  assert.match(
    check(
      "main.ts",
      'import { cache } from "@harnesshub/store/cache/lru";',
    ).join("\n"),
    /@harnesshub\/store holds no legacy module cache/,
  );
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

test("child_process inside a package needs an unexpired exception", () => {
  const platform = join(root, "packages/store/src/platform/windows-acl.ts");
  const source = 'import { execFile } from "node:child_process";';
  assert.deepEqual(
    checkSource(platform, source, root, {
      completedTasks: new Set(["OSS-012"]),
    }),
    [],
  );
  assert.match(
    checkSource(
      join(root, "packages/store/src/storage/sqlite-store.ts"),
      source,
      root,
      { completedTasks: new Set() },
    ).join("\n"),
    /packages\/store has no child_process exception/,
  );
  assert.match(
    checkSource(platform, source, root, {
      completedTasks: new Set(["OSS-013"]),
    }).join("\n"),
    /exception for store\/platform\/ \(owner OSS-010 F08\) expired with OSS-013/,
  );
  assert.match(
    checkSource(platform, source, root).join("\n"),
    /ends with OSS-013; TODO\.md is needed to check it/,
  );
});

test("CLI ends a child_process exception when its TODO.md task is ticked", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "harnesshub-boundaries-todo-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const platform = join(directory, "packages", "store", "src", "platform");
  mkdirSync(platform, { recursive: true });
  writeFileSync(
    join(platform, "acl.ts"),
    'import { execFile } from "node:child_process";',
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url)),
        directory,
      ],
      { encoding: "utf8" },
    );
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /TODO\.md is needed to check it/);
  writeFileSync(join(directory, "TODO.md"), "- [ ] **OSS-013 M0 组合验收**\n");
  assert.equal(run().status, 0);
  writeFileSync(join(directory, "TODO.md"), "- [x] **OSS-013 M0 组合验收**\n");
  const expired = run();
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /expired with OSS-013/);
});

test("secrets keeps the drivers rules in src/ and spawns its helper only under its exception", () => {
  assert.deepEqual(
    check(
      "drivers/configuration/prepare.ts",
      'import { resolveSecret } from "@harnesshub/secrets/secrets";',
    ),
    [],
  );
  assert.match(
    check(
      "gateway/secrets.ts",
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
  const source = 'import { spawn } from "node:child_process";';
  const open = { completedTasks: new Set() };
  assert.deepEqual(
    checkSource(
      join(root, "packages/secrets/src/secrets.ts"),
      source,
      root,
      open,
    ),
    [],
  );
  assert.match(
    checkSource(
      join(root, "packages/secrets/src/native-helper.ts"),
      source,
      root,
      open,
    ).join("\n"),
    /packages\/secrets has no child_process exception/,
  );
  assert.match(
    checkSource(join(root, "packages/secrets/src/secrets.ts"), source, root, {
      completedTasks: new Set(["OSS-013"]),
    }).join("\n"),
    /exception for secrets\/secrets\.ts \(owner OSS-010 F08\) expired with OSS-013/,
  );
});

test("a src/ file may import only the packages its destination package may depend on", () => {
  assert.equal(legacyDestination("drivers/configuration/prepare.ts"), "agents");
  assert.equal(legacyDestination("drivers/configuration/probe.ts"), "runtime");
  assert.equal(legacyDestination("drivers/acp/driver.ts"), "drivers");
  assert.equal(legacyDestination("main.ts"), "daemon");
  const gateway =
    'import { startModelGateway } from "@harnesshub/gateway/gateway";';
  assert.deepEqual(check("worker/main.ts", gateway), []);
  assert.deepEqual(check("main.ts", gateway), []);
  // V1: preparation moves to agents, which may not depend on the gateway.
  assert.match(
    check("drivers/configuration/prepare.ts", gateway).join("\n"),
    /src\/drivers\/configuration\/prepare\.ts moves to @harnesshub\/agents, which cannot depend on @harnesshub\/gateway/,
  );
  // V4: drivers never import secrets.
  assert.match(
    check(
      "drivers/acp/driver.ts",
      'import { resolveSecret } from "@harnesshub/secrets/secrets";',
    ).join("\n"),
    /moves to @harnesshub\/drivers, which cannot depend on @harnesshub\/secrets/,
  );
  assert.match(
    check("gateway/models.ts", gateway).join("\n"),
    /gateway cannot depend on drivers/,
  );
});

test("drivers keep their module rules, and only the Worker loads them inside the daemon", () => {
  const acp = 'import { AcpDriver } from "@harnesshub/drivers/acp/driver";';
  assert.deepEqual(check("worker/main.ts", acp), []);
  assert.match(
    check("main.ts", acp).join("\n"),
    /only src\/worker\/ may import @harnesshub\/drivers among the files that move to the daemon/,
  );
  assert.match(
    check("runtime/run.ts", acp).join("\n"),
    /runtime cannot depend on drivers/,
  );
  assert.deepEqual(checkAt("packages/daemon/src/worker/main.ts", acp), []);
  assert.match(
    checkAt("packages/daemon/src/main.ts", acp).join("\n"),
    /only worker\/ of packages\/daemon may import @harnesshub\/drivers/,
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
  const cli = join(root, "packages/drivers/src/cli/driver.ts");
  assert.deepEqual(
    checkSource(cli, spawn, root, { completedTasks: new Set() }),
    [],
  );
  assert.match(
    checkSource(
      join(root, "packages/drivers/src/fake/driver.ts"),
      spawn,
      root,
      { completedTasks: new Set() },
    ).join("\n"),
    /packages\/drivers has no child_process exception/,
  );
  assert.match(
    checkSource(cli, spawn, root, {
      completedTasks: new Set(["OSS-013"]),
    }).join("\n"),
    /exception for drivers\/cli\/ \(owner OSS-010 F08\) expired with OSS-013/,
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
    check(
      "main.ts",
      'import { normalizeEngine } from "@harnesshub/agents/engine/registry";',
    ),
    [],
  );
  assert.deepEqual(
    check(
      "gateway/harness-model-routes.ts",
      'import { HarnessModelService } from "@harnesshub/agents/application/harness-model";',
    ),
    [],
  );
  assert.match(
    check(
      "gateway/engines.ts",
      'import { EngineManager } from "@harnesshub/agents/engine/manager";',
    ).join("\n"),
    /gateway cannot depend on engine/,
  );
  assert.match(
    check(
      "runtime/run.ts",
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
      'import { repositoryScript } from "../repository.js";',
    ),
    [],
  );
  assert.deepEqual(
    checkAt(
      "packages/agents/src/configuration/prepare.ts",
      'import { currentCommandMcpEntry } from "../tool-command/entry.js";',
    ),
    [],
  );
});

test("only agents' repository.ts may resolve URLs outside the package, until OSS-013", () => {
  const helper = join(root, "packages/agents/src/repository.ts");
  const source =
    "const file = new URL(`../../../../${relative}`, import.meta.url);";
  assert.deepEqual(
    checkSource(helper, source, root, { completedTasks: new Set() }),
    [],
  );
  assert.match(
    checkSource(helper, source, root, {
      completedTasks: new Set(["OSS-013"]),
    }).join("\n"),
    /the new URL exception for agents\/repository\.ts \(owner OSS-004\) expired with OSS-013/,
  );
  assert.match(
    checkSource(
      join(root, "packages/agents/src/configuration/launch.ts"),
      'const launcher = new URL("../../../../scripts/launch-engine.mjs", import.meta.url);',
      root,
      { completedTasks: new Set() },
    ).join("\n"),
    /new URL leaves packages\/agents: \.\.\/\.\.\/\.\.\/\.\.\/scripts\/launch-engine\.mjs/,
  );
  const spawn = 'import { spawn } from "node:child_process";';
  assert.deepEqual(
    checkSource(
      join(root, "packages/agents/src/tool-command/command-mcp.ts"),
      spawn,
      root,
      { completedTasks: new Set() },
    ),
    [],
  );
  assert.match(
    checkSource(
      join(root, "packages/agents/src/configuration/launch.ts"),
      spawn,
      root,
      { completedTasks: new Set() },
    ).join("\n"),
    /packages\/agents has no child_process exception/,
  );
});

test("runtime owns process creation for good, and the probe keeps its drivers rules", () => {
  const spawn = 'import { spawn } from "node:child_process";';
  const done = { completedTasks: new Set(["OSS-013"]) };
  // A permanent home, not an exception: it does not expire with OSS-013.
  assert.deepEqual(
    checkSource(
      join(root, "packages/runtime/src/process/worker-host.ts"),
      spawn,
      root,
      done,
    ),
    [],
  );
  assert.match(
    checkSource(
      join(root, "packages/runtime/src/application/service.ts"),
      spawn,
      root,
      done,
    ).join("\n"),
    /packages\/runtime has no child_process exception/,
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
  assert.deepEqual(
    check(
      "gateway/server.ts",
      'import type { HubApplication } from "@harnesshub/runtime/application/service";',
    ),
    [],
  );
  assert.match(
    check(
      "gateway/server.ts",
      'import { ProcessWorkerHost } from "@harnesshub/runtime/process/worker-host";',
    ).join("\n"),
    /gateway cannot depend on process/,
  );
  assert.deepEqual(
    check(
      "main.ts",
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
