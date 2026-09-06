import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";

void test(
  "Windows Gateway executes registered cmd and PowerShell engines with UTF-8 multiline stdin and confirmed cleanup",
  {
    skip: process.platform !== "win32" ? "Windows native script launch" : false,
    timeout: 15_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-engine 中文 空格 "));
    const cmd = join(directory, "echo.cmd");
    const powershell = join(directory, "echo.ps1");
    const entry = join(directory, "echo.mjs");
    const config = join(directory, "engines.json");
    await writeFile(entry, "process.stdin.pipe(process.stdout);");
    await writeFile(
      cmd,
      `@echo off\r\n"${process.execPath}" "%~dp0echo.mjs"\r\n`,
    );
    await writeFile(
      powershell,
      "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n[Console]::Out.Write([Console]::In.ReadToEnd())\n",
    );
    await writeFile(
      config,
      JSON.stringify({
        engines: [
          {
            id: "cmd",
            driver: "cli",
            command: [cmd],
            cli: { inputMode: "stdin" },
          },
          {
            id: "powershell",
            driver: "cli",
            command: [powershell],
            cli: { inputMode: "stdin" },
          },
        ],
      }),
    );
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    const running = await startHub({
      configFile: config,
      dataDir: join(directory, "data"),
      cwd: directory,
      demo: false,
      port: 0,
    });
    hub = running;
    for (const engineId of ["cmd", "powershell"]) {
      const created = await running.server.inject({
        method: "POST",
        url: "/v1/sessions",
        payload: { engineId },
      });
      assert.equal(created.statusCode, 201, created.body);
      const session = created.json<SessionRecord>();
      const text = '中文🙂 空格\n第二行 & | %PATH% $(literal) "quote"\n';
      const accepted = await running.server.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/runs`,
        payload: { text, timeoutMs: 5000 },
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      let run = accepted.json<RunRecord>();
      const deadline = Date.now() + 8000;
      while (!run.finishedAt) {
        assert.ok(
          Date.now() < deadline,
          "Windows script Run must reach a terminal state",
        );
        await delay(20);
        run = (
          await running.server.inject({
            method: "GET",
            url: `/v1/runs/${run.id}`,
          })
        ).json<RunRecord>();
      }
      assert.equal(run.status, "completed", JSON.stringify(run.error));
      assert.equal(run.cleanupStatus, "confirmed");
      const observed = running.app
        .events(run.id)
        .filter((event) => event.type === "message.delta")
        .map((event) => event.data.text)
        .join("");
      assert.equal(observed, text);
    }
  },
);
