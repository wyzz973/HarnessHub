import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const entry = fileURLToPath(new URL("../../src/main.js", import.meta.url));
async function launch(directory: string) {
  const child = spawn(
    process.execPath,
    [entry, "--demo", "--port", "0", "--data-dir", directory],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const ready = new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Gateway startup timeout: ${stderr}`));
    }, 8000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Gateway exited ${code}: ${stderr}`));
    });
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
      const line = output.split("\n").find((value) => value.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve((JSON.parse(line) as { url: string }).url);
      }
    });
  });
  return { child, url: await ready };
}
void test(
  "published CLI starts in plain Node and repairs an interrupted run after process crash",
  { timeout: 25_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "harnesshub-cli-"));
    let running = await launch(directory);
    t.after(async () => {
      if (
        running.child.exitCode === null &&
        running.child.signalCode === null
      ) {
        const exited = once(running.child, "exit");
        running.child.kill("SIGTERM");
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const session = (await (
      await fetch(`${running.url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { id: string };
    const run = (await (
      await fetch(`${running.url}/v1/sessions/${session.id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "wait for crash",
          fixture: { scenario: "wait" },
          timeoutMs: 15_000,
        }),
      })
    ).json()) as { id: string };
    const deadline = Date.now() + 6000;
    for (;;) {
      const current = (await (
        await fetch(`${running.url}/v1/runs/${run.id}`)
      ).json()) as { status: string };
      if (current.status === "running") break;
      assert.ok(Date.now() < deadline, "run must enter running");
      await delay(10);
    }
    const exited = once(running.child, "exit");
    running.child.kill("SIGKILL");
    await exited;
    running = await launch(directory);
    const recovered = (await (
      await fetch(`${running.url}/v1/runs/${run.id}`)
    ).json()) as { status: string; stopReason: string; cleanupStatus: string };
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.stopReason, "gateway_restarted");
    assert.equal(
      recovered.cleanupStatus,
      process.platform === "win32" ? "unconfirmed" : "confirmed",
    );
  },
);
