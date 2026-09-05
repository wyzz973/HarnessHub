import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

if (process.argv.includes("--acp-peer")) {
  let turns = 0;
  new AgentSideConnection(
    (connection) => ({
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        authMethods: [],
        agentCapabilities: {},
      }),
      authenticate: async () => ({}),
      newSession: async () => ({ sessionId: "local-acp-session" }),
      cancel: async () => {},
      prompt: async (request) => {
        turns += 1;
        if (
          request.prompt.some(
            (content) =>
              content.type === "text" && content.text === "inspect-environment",
          )
        ) {
          await connection.sessionUpdate({
            sessionId: request.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: JSON.stringify({
                  ambient: process.env.HH_TEST_AMBIENT_SECRET ?? null,
                  declared: process.env.HH_TEST_DECLARED_SECRET ?? null,
                  explicit: process.env.HH_TEST_EXPLICIT_VALUE ?? null,
                  home: process.env.HOME,
                  userProfile: process.env.USERPROFILE,
                  appData: process.env.APPDATA,
                  localAppData: process.env.LOCALAPPDATA,
                  tmpdir: process.env.TMPDIR,
                  temp: process.env.TEMP,
                  tmp: process.env.TMP,
                }),
              },
            },
          });
          return { stopReason: "end_turn" };
        }
        const permission = await connection.requestPermission({
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: `tool-${turns}`,
            title: "Local test permission",
          },
          options: [
            {
              optionId: "actual-local-allow",
              name: "Allow once",
              kind: "allow_once",
            },
            {
              optionId: "actual-local-reject",
              name: "Reject once",
              kind: "reject_once",
            },
          ],
        });
        const text =
          permission.outcome.outcome === "selected"
            ? permission.outcome.optionId
            : "cancelled";
        await connection.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `turn${turns}:${text}` },
          },
        });
        return { stopReason: "end_turn" };
      },
    }),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
} else if (process.argv.includes("--env-host")) {
  const directory = process.argv.at(-1);
  if (!directory) throw new Error("Environment fixture needs a directory");
  const host = new ProcessWorkerHost({
    env: { HH_TEST_EXPLICIT_VALUE: "explicit-fixture" },
  });
  try {
    const handle = await host.start(
      {
        sessionId: "env-session" as SessionId,
        runId: "env-run" as RunId,
        generation: 1,
        cwd: directory,
        stateDir: join(directory, "backend"),
        input: { text: "inspect-environment", timeoutMs: 10_000 },
        profile: {
          id: "local-acp",
          driver: "acp",
          revision: "1",
          enabled: true,
          command: [
            process.execPath,
            fileURLToPath(import.meta.url),
            "--acp-peer",
          ],
          credentialEnv: ["HH_TEST_DECLARED_SECRET"],
          maxConcurrency: 1,
          capabilities: { permissions: true, resume: false, images: false },
        },
      },
      async () => {},
    );
    const result = await handle.result;
    if (result.status !== "completed" || !result.output)
      throw new Error("Environment fixture did not complete");
    await new Promise<void>((resolve, reject) => {
      if (!process.send) {
        reject(new Error("Missing fixture IPC"));
        return;
      }
      process.send(result.output, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  } finally {
    await host.close();
    process.disconnect?.();
  }
} else {
  void test(
    "ACP runtime uses fixed local argv, preserves actual permission option IDs, and reuses backend state",
    { timeout: 30_000 },
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "harnesshub-acp-"));
      const host = new ProcessWorkerHost({ shutdownGraceMs: 500 });
      context.after(async () => {
        await host.close();
        await rm(directory, { recursive: true });
      });
      const spec: ExecutionSpec = {
        sessionId: "acp-session" as SessionId,
        runId: "acp-turn-1" as RunId,
        generation: 1,
        cwd: directory,
        stateDir: join(directory, "backend"),
        input: { text: "local fixture", timeoutMs: 20_000 },
        profile: {
          id: "local-acp",
          driver: "acp",
          revision: "1",
          enabled: true,
          command: [
            process.execPath,
            fileURLToPath(import.meta.url),
            "--acp-peer",
          ],
          maxConcurrency: 1,
          capabilities: { permissions: true, resume: false, images: false },
        },
      };
      for (const generation of [1, 2]) {
        const request =
          Promise.withResolvers<
            Extract<WorkerMessage, { type: "permission" }>
          >();
        const handle = await host.start(
          { ...spec, runId: `acp-turn-${generation}` as RunId, generation },
          async (message) => {
            if (message.type === "permission") request.resolve(message);
          },
        );
        const permission = await Promise.race([
          request.promise,
          handle.result.then((result) => {
            throw new Error(
              `ACP ended before requesting permission: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        assert.equal(
          permission.permission.options[0]?.id,
          "actual-local-allow",
        );
        await handle.respondPermission(
          permission.permission.id,
          "actual-local-allow",
        );
        assert.deepEqual(await handle.result, {
          status: "completed",
          stopReason: "end_turn",
          output: `turn${generation}:actual-local-allow`,
        });
      }
      assert.ok(
        (await readdir(join(directory, "backend", "sessions"))).length > 0,
      );
      assert.equal(await host.closeSession(spec.sessionId), "confirmed");
    },
  );
  void test(
    "Worker inherits only declared credentials and owns private home and temporary directories",
    { timeout: 20_000 },
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "harnesshub-worker-env-"));
      const child = fork(
        fileURLToPath(import.meta.url),
        ["--env-host", directory],
        {
          env: {
            ...process.env,
            HH_TEST_AMBIENT_SECRET: "must-not-leak",
            HH_TEST_DECLARED_SECRET: "declared-fixture",
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          execArgv: [],
        },
      );
      const exit = once(child, "exit");
      context.after(async () => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exit;
        }
        await rm(directory, { recursive: true });
      });
      const message = await Promise.race([
        once(child, "message"),
        exit.then(([code]) => {
          throw new Error(
            `Environment fixture exited without a message: ${String(code)}`,
          );
        }),
      ]);
      assert.equal(typeof message[0], "string");
      const actual: unknown = JSON.parse(String(message[0]));
      const home = join(directory, "backend", "home");
      const temporary = join(directory, "backend", "tmp");
      assert.deepEqual(actual, {
        ambient: null,
        declared: "declared-fixture",
        explicit: "explicit-fixture",
        home,
        userProfile: home,
        appData: join(home, "AppData", "Roaming"),
        localAppData: join(home, "AppData", "Local"),
        tmpdir: temporary,
        temp: temporary,
        tmp: temporary,
      });
      assert.equal((await exit)[0], 0);
      // Embedding records the default event-log path; it need not create a log file until used.
      const record: unknown = JSON.parse(
        await readFile(
          join(directory, "backend", "sessions", "env-session.json"),
          "utf8",
        ),
      );
      assert.ok(
        typeof record === "object" && record !== null && "event_log" in record,
      );
      const eventLog = record.event_log;
      assert.ok(
        typeof eventLog === "object" &&
          eventLog !== null &&
          "active_path" in eventLog,
      );
      assert.equal(typeof eventLog.active_path, "string");
      assert.equal(
        dirname(String(eventLog.active_path)),
        join(home, ".acpx", "sessions"),
      );
    },
  );
}
