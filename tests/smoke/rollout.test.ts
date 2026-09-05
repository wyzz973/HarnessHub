import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "../../src/main.js";
import type {
  AgentEvent,
  RunRecord,
  SessionRecord,
} from "../../src/domain/types.js";

const entry = fileURLToPath(new URL("../../src/cli.js", import.meta.url));

async function cli(args: string[], cwd: string, signal: AbortSignal) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

void test(
  "compiled rollout CLI exports committed Gateway events and refuses overwrite",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "harnesshub-rollout-"),
    );
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    hub = await startHub({
      dataDir: directory,
      demo: true,
      cwd: directory,
      port: 0,
    });
    const sessionResponse = await fetch(`${hub.url}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: t.signal,
    });
    assert.equal(sessionResponse.status, 201);
    const session = (await sessionResponse.json()) as SessionRecord;
    const runResponse = await fetch(
      `${hub.url}/v1/sessions/${session.id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "rollout 导出 smoke", timeoutMs: 5000 }),
        signal: t.signal,
      },
    );
    assert.equal(runResponse.status, 202);
    const run = (await runResponse.json()) as RunRecord;
    const stream = await fetch(`${hub.url}/v1/runs/${run.id}/events`, {
      signal: t.signal,
    });
    assert.equal(stream.status, 200);
    await stream.text();
    const expectedResponse = await fetch(
      `${hub.url}/v1/runs/${run.id}/rollout`,
      { signal: t.signal },
    );
    const expected = await expectedResponse.text();
    const output = path.join(directory, "export 中文.jsonl");
    const args = [
      "rollout",
      "--url",
      hub.url,
      "--run",
      run.id,
      "--output",
      output,
    ];
    const exported = await cli(args, directory, t.signal);
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(await readFile(output, "utf8"), expected);
    const events = expected
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as AgentEvent);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.runId === run.id));
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.equal(
      (JSON.parse(exported.stdout) as { bytes: number }).bytes,
      Buffer.byteLength(expected),
    );

    const duplicate = await cli(args, directory, t.signal);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.stderr, /EEXIST/);
    assert.equal(await readFile(output, "utf8"), expected);

    const failedOutput = path.join(directory, "missing-run.jsonl");
    const failed = await cli(
      [
        "rollout",
        "--url",
        hub.url,
        "--run",
        "missing-run",
        "--output",
        failedOutput,
      ],
      directory,
      t.signal,
    );
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /HTTP 404/);
    await assert.rejects(stat(failedOutput), { code: "ENOENT" });
    const missing = await cli(
      ["rollout", "--url", hub.url],
      directory,
      t.signal,
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Missing --url, --run or --output/);
  },
);
