import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessWorkerHost } from "../../src/process/worker-host.js";
import type { ExecutionSpec, WorkerMessage } from "../../src/domain/ports.js";
import type { RunId, SessionId } from "../../src/domain/types.js";

const peer = fileURLToPath(
  new URL("../fixtures/acp-recovery-peer.js", import.meta.url),
);

function specFor(directory: string): ExecutionSpec {
  return {
    sessionId: "recovery-session" as SessionId,
    runId: "recovery-first" as RunId,
    generation: 1,
    cwd: directory,
    stateDir: join(directory, "checkpoint"),
    profile: {
      id: "recovery-peer",
      driver: "acp",
      enabled: true,
      revision: "recovery-v1",
      command: [process.execPath, peer, directory],
      maxConcurrency: 1,
      acp: { sessionMode: "resume" },
      capabilities: { resume: true, permissions: true, images: false },
    },
    input: { text: "remember:private-test-nonce", timeoutMs: 10_000 },
  };
}

async function executeInNewWorker(spec: ExecutionSpec) {
  const host = new ProcessWorkerHost({ shutdownGraceMs: 500 });
  const messages: WorkerMessage[] = [];
  try {
    const handle = await host.start(spec, async (message) => {
      messages.push(message);
    });
    const result = await handle.result;
    assert.equal(await host.closeSession(spec.sessionId), "confirmed");
    return { result, messages };
  } finally {
    await host.close();
  }
}

async function prepared(directory: string) {
  const spec = specFor(directory);
  const first = await executeInNewWorker(spec);
  assert.equal(first.result.output, "stored");
  const event = first.messages.find(
    (message) =>
      message.type === "event" && message.event.type === "engine.session",
  );
  assert.ok(event?.type === "event");
  const backendSessionId = event.event.data.backendSessionId;
  assert.equal(typeof backendSessionId, "string");
  assert.ok(typeof backendSessionId === "string");
  const next: ExecutionSpec = {
    ...spec,
    backendSessionId,
    runId: "recovery-second" as RunId,
    generation: 2,
    input: { text: "recall", timeoutMs: 10_000 },
  };
  return { spec, next, backendSessionId };
}

async function operations(directory: string) {
  return (await readFile(join(directory, "operations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(typeof value === "object" && value !== null && "type" in value);
      return value.type;
    });
}

void test(
  "ACP resume retains exact backend context across Worker replacement without backend close",
  { timeout: 20_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-acp-resume-"));
    context.after(() => rm(directory, { recursive: true }));
    const { next, backendSessionId } = await prepared(directory);
    const second = await executeInNewWorker(next);
    assert.equal(second.result.status, "completed");
    assert.equal(second.result.output, "private-test-nonce");
    const resumed = second.messages.find(
      (message) =>
        message.type === "event" && message.event.type === "engine.session",
    );
    assert.ok(resumed?.type === "event");
    assert.deepEqual(resumed.event.data, { backendSessionId, resumed: true });
    assert.deepEqual(await operations(directory), [
      "new",
      "prompt",
      "resume",
      "prompt",
    ]);
  },
);

void test(
  "ACP missing backend fails recovery without creating or prompting an empty session",
  { timeout: 20_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-acp-lost-backend-"));
    context.after(() => rm(directory, { recursive: true }));
    const { next, backendSessionId } = await prepared(directory);
    await rm(join(directory, `${backendSessionId}.txt`));
    const second = await executeInNewWorker(next);
    assert.equal(second.result.error?.code, "ACP_SESSION_RECOVERY_FAILED");
    assert.deepEqual(await operations(directory), ["new", "prompt", "resume"]);
  },
);

for (const kind of [
  "missing-checkpoint",
  "changed-command",
  "missing-public-id",
  "corrupt-orphan",
  "disabled-resume",
] as const) {
  void test(
    `ACP rejects ${kind} before engine launch`,
    { timeout: 20_000 },
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), `hh-acp-${kind}-`));
      context.after(() => rm(directory, { recursive: true }));
      const { next } = await prepared(directory);
      if (kind === "missing-checkpoint")
        await rm(join(next.stateDir, "sessions", `${next.sessionId}.json`));
      else if (kind === "changed-command")
        next.profile = {
          ...next.profile,
          command: [...(next.profile.command ?? []), "--changed"],
        };
      else if (kind === "missing-public-id") delete next.backendSessionId;
      else if (kind === "corrupt-orphan") {
        delete next.backendSessionId;
        await writeFile(
          join(next.stateDir, "sessions", `${next.sessionId}.json`),
          "{broken",
        );
      } else delete next.profile.acp;
      const second = await executeInNewWorker(next);
      assert.equal(
        second.result.error?.code,
        kind === "disabled-resume"
          ? "ACP_SESSION_RECOVERY_UNSUPPORTED"
          : "ACP_SESSION_RECOVERY_FAILED",
      );
      assert.deepEqual(await operations(directory), ["new", "prompt"]);
    },
  );
}

void test(
  "ACP rejects a configured resume capability when the backend does not advertise it",
  { timeout: 10_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "hh-acp-unsupported-"));
    context.after(() => rm(directory, { recursive: true }));
    const spec = specFor(directory);
    spec.profile.command?.push("--unsupported");
    const outcome = await executeInNewWorker(spec);
    assert.equal(
      outcome.result.error?.code,
      "ACP_SESSION_RECOVERY_UNSUPPORTED",
    );
    assert.deepEqual(await operations(directory), ["new"]);
  },
);
