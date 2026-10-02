import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  portableCommand,
  portableLauncher,
  unwrapEnvironment,
} from "../../src/drivers/configuration/launch.js";
import { prepareConfiguration } from "../../src/drivers/configuration/prepare.js";
import { normalizeEngine } from "../../src/engine/registry.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-launch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function run(
  command: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(command[0]!, command.slice(1), {
    env: environment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  child.stdin.end();
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exit, stdout, stderr };
}

void test("portable environment recipes preserve literal values and configured overrides without needing /usr/bin/env", async (t) => {
  const directory = await fixture(t);
  const command = [
    process.execPath,
    portableLauncher,
    "HOME=C:\\用户 有空格",
    "CODEX_HOME=C:\\用户\\.codex",
    "--",
    process.execPath,
    "agent.js",
  ];
  assert.deepEqual(unwrapEnvironment(command).command, [
    process.execPath,
    "agent.js",
  ]);
  const profile = normalizeEngine({ id: "codex", driver: "acp", command });
  const spec = {
    profile,
    stateDir: directory,
    cwd: directory,
    sessionId: "s" as SessionId,
    runId: "r" as RunId,
    generation: 1,
    input: { text: "test", timeoutMs: 1000 },
  };
  const plain = await prepareConfiguration(spec, {});
  assert.equal(plain.env.HOME, "C:\\用户 有空格");
  assert.deepEqual(plain.command, [process.execPath, "agent.js"]);
  const configured = await prepareConfiguration(
    {
      ...spec,
      profile: normalizeEngine({
        id: "codex",
        driver: "acp",
        command,
        configuration: { adapter: "codex", env: { CODEX_HOME: directory } },
      }),
    },
    {},
  );
  assert.equal(configured.env.CODEX_HOME, directory);
  assert.throws(() =>
    unwrapEnvironment([
      process.execPath,
      portableLauncher,
      "HOME=private",
      "missing-boundary",
    ]),
  );
  assert.deepEqual(
    unwrapEnvironment([
      process.execPath,
      path.join(directory, "launch-engine.mjs"),
      "HOME=custom",
      "--",
      "arbitrary",
    ]).env,
    {},
  );
});

void test("portable launcher preserves Unicode, multiline argv and environment without shell expansion", async (t) => {
  const directory = await fixture(t);
  const marker = path.join(directory, "must-not-exist");
  const args = [
    "中文 空格",
    "",
    "quote\" and apostrophe'",
    `& echo injected > ${marker}`,
    "%PATH% !ENV! ^ ( )",
    "line1\nline2",
    "end\\",
  ];
  const result = await run([
    process.execPath,
    portableLauncher,
    "HARNESSHUB_TEST_VALUE=$literal %PATH% & 中文",
    "--",
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({args:process.argv.slice(1),value:process.env.HARNESSHUB_TEST_VALUE}))",
    ...args,
  ]);
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args,
    value: "$literal %PATH% & 中文",
  });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

void test(
  "Windows npm .cmd launch keeps prompt metacharacters literal",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await fixture(t);
    const bin = path.join(directory, "中文 有空格", "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const entry = path.join(bin, "echo.mjs");
    const script = path.join(bin, "agent.cmd");
    await writeFile(
      entry,
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    await writeFile(
      script,
      `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`,
    );
    const marker = path.join(directory, "must-not-exist");
    const args = [
      "中文 空格",
      "",
      "quote\" and apostrophe'",
      `& echo injected > ${marker}`,
      "%PATH% !ENV! ^ ( )",
      "end\\",
    ];
    const result = await run(portableCommand([script, ...args]));
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

void test(
  "Windows global npm shim arguments cannot execute a second command",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await fixture(t);
    const script = path.join(directory, "global.cmd");
    await writeFile(
      path.join(directory, "echo.mjs"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
    );
    await writeFile(
      script,
      `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`,
    );
    const marker = path.join(directory, "must-not-exist");
    const args = [
      "中文 空格",
      `& echo injected > ${marker}`,
      "%PATH% !ENV! ^ ( )",
    ];
    const result = await run(portableCommand([script, ...args]));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const multiline = await run(
      portableCommand([script, `line1\r\necho injected > ${marker}`]),
    );
    assert.equal(multiline.exit, 2);
    assert.equal(multiline.stdout, "");
    assert.match(multiline.stderr, /single-line arguments/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  },
);

void test(
  "Windows PowerShell .ps1 launch uses literal file arguments",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await fixture(t);
    const script = path.join(directory, "agent script.ps1");
    await writeFile(
      script,
      "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\nConvertTo-Json -Compress -InputObject @($args)\n",
    );
    const args = [
      "中文 空格",
      "",
      "quote' and double\"",
      "$(Write-Output bad)",
      "%PATH% & | >",
      "line1\nline2",
    ];
    const result = await run(portableCommand([script, ...args]));
    assert.equal(result.exit, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    const bridge = await run([
      process.execPath,
      path.join(path.dirname(portableLauncher), "launch-openclaw-acp.mjs"),
      script,
    ]);
    assert.equal(bridge.exit, 0, bridge.stderr);
    const bridgeArgs: unknown = JSON.parse(bridge.stdout);
    assert.ok(Array.isArray(bridgeArgs));
    assert.equal(bridgeArgs[0], "acp");
    assert.equal(bridgeArgs[1], "--session");
    assert.match(String(bridgeArgs[2]), /^agent:main:harnesshub:/);
  },
);
