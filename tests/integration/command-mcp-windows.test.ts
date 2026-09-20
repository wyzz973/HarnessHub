import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindInstalled, importLocal } from "../../src/tool-packages/index.js";
import {
  startMcp,
  substituteSessionWorkspace,
} from "../fixtures/tool-pack-mcp-client.js";

const commandMcpEntry = fileURLToPath(
  new URL("../../src/drivers/tool-command/command-mcp.js", import.meta.url),
);

void test(
  "Windows .cmd CLI entries run through cmd.exe with every argument intact and unsafe arguments rejected",
  { skip: process.platform !== "win32", timeout: 60_000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "hh-command-mcp-cmd-")),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, "batch tools 中文");
    await mkdir(path.join(source, "bin"), { recursive: true });
    await writeFile(
      path.join(source, "bin", "echo.mjs"),
      "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n",
    );
    await writeFile(
      path.join(source, "bin", "echo.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs" %*\r\n`,
    );
    await writeFile(
      path.join(source, "cli.json"),
      JSON.stringify({ cliTools: [{ name: "echo", entry: "bin/echo.cmd" }] }),
    );
    const store = path.join(directory, "store");
    const imported = await importLocal(source, store);
    assert.equal(imported.installed.manifest.cliTools![0]!.launch, "native");
    const fragment = await bindInstalled(
      store,
      imported.installed.manifest.id,
      imported.installed.manifest.version,
      { nodeExecutable: process.execPath, commandMcpEntry },
    );
    const session = path.join(directory, "session workspace");
    await mkdir(session);
    const client = startMcp(
      t,
      substituteSessionWorkspace(fragment.mcpServers[0]!, session),
    );
    await client.initialize();
    const args = [
      "plain",
      "two words",
      "a&b|c",
      "<in> >out",
      "(group)",
      "caret^",
      "bang!",
      "semi;colon,comma=eq",
      "trailing\\",
      "",
      "中文 参数",
    ];
    const called = await client.call("cli_echo", { args });
    assert.equal(called.isError, false, called.text);
    const execution = JSON.parse(called.text) as {
      exitCode: number;
      stdout: string;
    };
    assert.equal(execution.exitCode, 0);
    const echoed = JSON.parse(execution.stdout) as {
      args: string[];
      cwd: string;
    };
    assert.deepEqual(echoed.args, args);
    assert.equal(await realpath(echoed.cwd), await realpath(session));
    for (const unsafe of ["%PATH%", 'say "hi"'])
      assert.match(
        (await client.call("cli_echo", { args: [unsafe] })).text,
        /cannot contain/,
      );
    assert.equal(await client.close(), 0);
  },
);
