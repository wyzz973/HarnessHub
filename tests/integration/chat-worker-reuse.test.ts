import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { parseWorkerMessage } from "../../src/domain/ipc.js";

void test(
  "compiled Worker accepts the next Run immediately after result ACK without a scheduling gap",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-result-ack-reuse-"));
    const child = fork(
      new URL("../../src/worker/main.js", import.meta.url),
      [],
      { cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] },
    );
    const exit = once(child, "exit");
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    t.after(async () => {
      if (!exited) child.kill("SIGKILL");
      await exit;
      await rm(root, { recursive: true, force: true });
    });
    await once(child, "message");
    let count = 0;
    const done = Promise.withResolvers<void>();
    const sendRun = () =>
      child.send({
        version: 1,
        type: "run",
        spec: {
          sessionId: "reuse",
          runId: `run-${count}`,
          generation: count + 1,
          cwd: root,
          stateDir: join(root, "backend"),
          profile: {
            id: "fake",
            revision: "1",
            driver: "fake",
            enabled: true,
            maxConcurrency: 1,
            capabilities: { resume: false, permissions: true, images: false },
          },
          input: {
            text: `marker-${count}`,
            timeoutMs: 10000,
            fixture: { scenario: "echo" },
          },
        },
      });
    child.on("message", (value: unknown) => {
      const raw = parseWorkerMessage(value);
      if (raw.type === "ready") return;
      child.send({
        version: 1,
        type: "ack",
        sessionId: raw.sessionId,
        runId: raw.runId,
        generation: raw.generation,
        seq: raw.seq,
      });
      if (raw.type === "result") {
        try {
          assert.equal(raw.result.output, `marker-${count}`);
          count++;
          if (count === 100) done.resolve();
          else sendRun();
        } catch (error) {
          done.reject(error);
        }
      }
    });
    sendRun();
    await Promise.race([
      done.promise,
      exit.then(() => {
        throw new Error("Worker exited during reuse");
      }),
    ]);
    child.send({ version: 1, type: "shutdown" });
    assert.deepEqual(await exit, [0, null]);
    assert.equal(count, 100);
  },
);
