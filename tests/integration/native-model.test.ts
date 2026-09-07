import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startHub } from "../../src/main.js";
import {
  isTerminal,
  type RunRecord,
  type SessionRecord,
} from "../../src/domain/types.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";
import { writePrivateSecretFile } from "../fixtures/private-secret-file.js";

void test(
  "Copilot BYOK selects its native model through real Workers while ACP-only selections still require advertised controls",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hh-native-model 中文 "),
    );
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    if (process.platform === "win32") await ensurePrivateDirectory(directory);
    else await chmod(directory, 0o700);
    const key = "synthetic-native-model-fixture-key";
    const keyFile = path.join(directory, "synthetic.key");
    await writePrivateSecretFile(keyFile, key);
    const dataDir = path.join(directory, "data");
    hub = await startHub({ cwd: directory, dataDir, demo: false, port: 0 });
    const peer = fileURLToPath(
      new URL("../fixtures/native-model-peer.js", import.meta.url),
    );
    async function json<T>(route: string, body?: unknown): Promise<T> {
      const response = await fetch(
        hub!.url + route,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      assert.ok(response.ok, `${route}: ${response.status}`);
      return (await response.json()) as T;
    }
    async function run(session: SessionRecord) {
      let result = await json<RunRecord>(`/v1/sessions/${session.id}/runs`, {
        text: "Report fixture environment without calling a model",
        timeoutMs: 8000,
      });
      const until = Date.now() + 10000;
      while (!isTerminal(result.status)) {
        assert.ok(Date.now() < until, "Run did not reach its terminal state");
        await delay(20);
        result = await json<RunRecord>(`/v1/runs/${result.id}`);
      }
      return result;
    }
    const baseUrl = "http://127.0.0.1:1/v1";
    const model = "fixture-native-selected";
    const trace = path.join(directory, "byok.trace");
    await json("/v1/engines", {
      id: "byok",
      driver: "acp",
      command: [process.execPath, peer, trace],
      model,
      configuration: {
        adapter: "copilot",
        provider: {
          protocol: "openai-completions",
          baseUrl,
          apiKey: { kind: "file", value: keyFile },
        },
      },
    });
    const session = await json<SessionRecord>("/v1/sessions", {
      engineId: "byok",
    });
    let previousPid: number | undefined;
    for (const prompts of [1, 2]) {
      const result = await run(session);
      assert.equal(result.status, "completed", JSON.stringify(result.error));
      const output = JSON.parse(result.output ?? "{}") as {
        pid: number;
        sessions: number;
        prompts: number;
        model: string;
        provider: string;
        baseUrl: string;
        offline: string;
        keyHash: string;
      };
      assert.deepEqual(output, {
        pid: previousPid ?? output.pid,
        sessions: 1,
        prompts,
        model,
        provider: "openai",
        baseUrl,
        offline: "true",
        keyHash: createHash("sha256").update(key).digest("hex"),
      });
      assert.equal(JSON.stringify(result).includes(key), false);
      previousPid = output.pid;
    }
    await json(`/v1/sessions/${session.id}/close`, {});
    assert.equal(await readFile(trace, "utf8"), "newSession\nprompt\nprompt\n");

    for (const adapter of ["generic", "copilot"]) {
      const refusedTrace = path.join(directory, `${adapter}.trace`);
      await json("/v1/engines", {
        id: adapter,
        driver: "acp",
        command: [process.execPath, peer, refusedTrace],
        model,
        configuration: { adapter },
      });
      const refusedSession = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      const result = await run(refusedSession);
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, "ACP_MODEL_UNSUPPORTED");
      assert.equal(result.output ?? "", "");
      await json(`/v1/sessions/${refusedSession.id}/close`, {});
      assert.equal(await readFile(refusedTrace, "utf8"), "newSession\n");
    }
    assert.deepEqual(await readdir(path.join(dataDir, "workers")), []);
    await hub.server.close();
    hub = undefined;
    const database = await readFile(path.join(dataDir, "harnesshub.sqlite"));
    assert.equal(database.includes(Buffer.from(key)), false);
  },
);
