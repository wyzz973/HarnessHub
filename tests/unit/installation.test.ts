import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { HubError } from "../../src/domain/errors.js";
import type { EngineProfile, JsonObject } from "../../src/domain/types.js";
import { inspectEngineInstallation } from "../../src/engine/installation.js";
import { portableLauncher } from "../../src/drivers/configuration/launch.js";

function profile(command: string[]): EngineProfile {
  return {
    id: "installation",
    driver: "cli",
    revision: "v1",
    enabled: true,
    command,
    maxConcurrency: 1,
    capabilities: { resume: false, permissions: false, images: false },
  };
}
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "harnesshub-installation-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function files(value: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(value.files));
  return value.files.map((entry) => {
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
    return entry;
  });
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof HubError && error.code === code;
}

void test("installation snapshots identify Node and owning package without executing the program", async (t) => {
  const root = await fixture(t);
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@example/agent",
      version: "1.2.3",
      secret: "DO_NOT_INCLUDE_PRIVATE_FIELDS",
    }),
  );
  const entry = join(packageRoot, "dist", "agent.mjs");
  const source =
    "throw new Error('This file must never execute during inspection');\n";
  await writeFile(entry, source);
  const result = await inspectEngineInstallation(
    profile([process.execPath, entry]),
    { pathEnv: "" },
  );
  assert.equal(result.source, "local-files");
  const entries = files(result);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.path, await realpath(process.execPath));
  assert.ok(Number(entries[0]?.size) > 0);
  const script = entries[1];
  assert.ok(script);
  assert.equal(script.path, entry);
  assert.equal(
    script.sha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(script.size, Buffer.byteLength(source));
  assert.equal(typeof script.mtimeMs, "number");
  assert.deepEqual(script.package, {
    name: "@example/agent",
    version: "1.2.3",
  });
  assert.equal(
    JSON.stringify(result).includes("DO_NOT_INCLUDE_PRIVATE_FIELDS"),
    false,
  );
});

void test("env assignments and secret configuration flags never become input files", async (t) => {
  const root = await fixture(t);
  const launcher = join(root, "launcher");
  const script = join(root, "agent.mjs");
  const secret = join(root, "secret.mjs");
  await writeFile(launcher, "not executable content", { mode: 0o700 });
  await writeFile(script, "export {};\n");
  // A directory is an invalid startup input on every OS and needs no symlink privileges.
  await mkdir(secret);
  const result = await inspectEngineInstallation(
    profile([
      process.execPath,
      portableLauncher,
      `HOME=${secret}`,
      `PROVIDER_TOKEN=${secret}`,
      "--",
      launcher,
      script,
      "--config",
      secret,
      `--patch=${secret}`,
      "--token",
      "/definitely/not/a/token.mjs",
    ]),
    { pathEnv: "" },
  );
  assert.deepEqual(
    files(result).map((entry) => entry.path),
    [await realpath(process.execPath), portableLauncher, launcher, script],
  );
  assert.equal(JSON.stringify(result).includes("secret.mjs"), false);
});

void test("explicit PATH resolution is reproducible and binary version directories are not interpreted", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "999.99.99");
  await mkdir(directory);
  const launcher = join(directory, "agent");
  await writeFile(launcher, Buffer.from([1, 2, 3, 4]), { mode: 0o700 });
  const engine = profile(["agent", "run"]);
  const first = await inspectEngineInstallation(engine, { pathEnv: directory });
  const second = await inspectEngineInstallation(engine, {
    pathEnv: directory,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(files(first)[0]?.package, null);
  await writeFile(launcher, Buffer.from([4, 3, 2, 1]));
  const changed = await inspectEngineInstallation(engine, {
    pathEnv: directory,
  });
  assert.notEqual(files(first)[0]?.sha256, files(changed)[0]?.sha256);
});

void test("missing launchers and declared startup scripts fail clearly", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    inspectEngineInstallation(profile([join(root, "missing")]), {
      pathEnv: "",
    }),
    errorCode("ENGINE_INSTALLATION_MISSING"),
  );
  await assert.rejects(
    inspectEngineInstallation(profile(["missing"]), { pathEnv: root }),
    errorCode("ENGINE_INSTALLATION_MISSING"),
  );
  await assert.rejects(
    inspectEngineInstallation(
      profile([process.execPath, join(root, "missing.mjs")]),
      { pathEnv: "" },
    ),
    errorCode("ENGINE_INSTALLATION_MISSING"),
  );
  await assert.rejects(
    inspectEngineInstallation(profile(["./relative-launcher"]), {
      pathEnv: root,
    }),
    errorCode("ENGINE_INSTALLATION_INVALID"),
  );
});

void test("snapshot limits reject excessive file count and oversized sparse files", async (t) => {
  const root = await fixture(t);
  const launcher = join(root, "launcher");
  await writeFile(launcher, "launcher");
  const scripts = Array.from({ length: 8 }, (_, i) => join(root, `${i}.mjs`));
  for (const script of scripts) await writeFile(script, "script");
  await assert.rejects(
    inspectEngineInstallation(profile([launcher, ...scripts]), { pathEnv: "" }),
    errorCode("ENGINE_INSTALLATION_TOO_LARGE"),
  );
  await truncate(launcher, 512 * 1024 * 1024 + 1);
  await assert.rejects(
    inspectEngineInstallation(profile([launcher]), { pathEnv: "" }),
    errorCode("ENGINE_INSTALLATION_TOO_LARGE"),
  );
});

void test("package lookup stops after three ancestors and does not traverse a manifest symlink", async (t) => {
  const root = await fixture(t);
  const entry = join(root, "a", "b", "c", "agent.mjs");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "source");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "outside", version: "2.0.0" }),
  );
  const result = await inspectEngineInstallation(profile([entry]), {
    pathEnv: "",
  });
  assert.equal(files(result)[0]?.package, null);
  // Directory junctions exercise the same reparse rejection without administrator privileges.
  await symlink(
    process.platform === "win32" ? root : join(root, "package.json"),
    join(dirname(entry), "package.json"),
    process.platform === "win32" ? "junction" : "file",
  );
  await assert.rejects(
    inspectEngineInstallation(profile([entry]), { pathEnv: "" }),
    errorCode("ENGINE_INSTALLATION_INVALID"),
  );
});

void test(
  "Windows installation snapshots resolve executable suffixes and retain launcher targets",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fixture(t);
    const executable = join(root, "agent.exe");
    await writeFile(executable, "not executed");
    const result = await inspectEngineInstallation(profile(["agent"]), {
      pathEnv: root,
    });
    assert.equal(files(result)[0]?.path, executable);
    const wrapped = await inspectEngineInstallation(
      profile([
        process.execPath,
        portableLauncher,
        "HOME=private",
        "--",
        executable,
      ]),
      { pathEnv: "" },
    );
    assert.deepEqual(
      files(wrapped).map((item) => item.path),
      [await realpath(process.execPath), portableLauncher, executable],
    );
    assert.equal(JSON.stringify(wrapped).includes("HOME=private"), false);
  },
);

void test("an aborted installation inspection preserves its reason before reading a launcher", async () => {
  const controller = new AbortController();
  const reason = new Error("Run cancelled before inspection");
  controller.abort(reason);
  await assert.rejects(
    inspectEngineInstallation(profile(["/missing/should-not-be-read"]), {
      pathEnv: "",
      signal: controller.signal,
    }),
    (error: unknown) => error === reason,
  );
});
