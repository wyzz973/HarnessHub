import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { HubApplication } from "../../src/application/service.js";
import type {
  AgentEvent,
  JsonObject,
  RunId,
  RunRecord,
  RunStatus,
  SessionId,
} from "../../src/domain/types.js";
import {
  CompetitionRunFeed,
  streamCompetitionEvents,
} from "../../src/gateway/competition/events.js";

const sessionId = "session-1" as SessionId;

function record(
  id: RunId,
  status: RunStatus,
  createdAt: number,
  extra: Partial<RunRecord> = {},
): RunRecord {
  return {
    id,
    sessionId,
    generation: 1,
    status,
    input: { text: id, timeoutMs: 60_000 },
    createdAt,
    deadlineAt: createdAt + 60_000,
    cleanupStatus: "confirmed",
    lastSeq: 0,
    ...extra,
  };
}

function event(
  runId: RunId,
  seq: number,
  type: string,
  data: JsonObject,
  observedAt: number,
): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: `${runId}:${seq}`,
    sessionId,
    runId,
    seq,
    occurredAt: observedAt,
    observedAt,
    type,
    data,
  };
}

/** In-memory Runs and events behind the two reads the stream uses. */
function fakeApplication() {
  const runs = new Map<RunId, RunRecord>();
  const events = new Map<RunId, AgentEvent[]>();
  const app = {
    runs: (id?: SessionId) =>
      [...runs.values()].filter((run) => !id || run.sessionId === id),
    events: (id: RunId, after: number, limit: number) =>
      (events.get(id) ?? []).filter((item) => item.seq > after).slice(0, limit),
  } as unknown as HubApplication;
  const start = (id: RunId, at: number) => {
    runs.set(id, record(id, "running", at, { lastSeq: 1 }));
    events.set(id, [event(id, 1, "RUN_STATUS", { status: "running" }, at + 1)]);
  };
  const finish = (id: RunId, at: number, output: string) => {
    const run = runs.get(id)!;
    runs.set(id, {
      ...run,
      status: "completed",
      finishedAt: at,
      output,
      lastSeq: 2,
    });
    events.get(id)!.push(event(id, 2, "RUN_COMPLETED", { output }, at));
  };
  return { app, start, finish };
}

function lifecycle(chunks: string[]): string[] {
  return chunks
    .join("")
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice(6)) as {
          type: string;
          properties: { status?: { type: string } };
        },
    )
    .flatMap((frame) =>
      frame.type === "session.status"
        ? [frame.properties.status!.type]
        : frame.type === "session.idle"
          ? ["session.idle"]
          : [],
    );
}

async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(10);
  }
}

void test("a Run accepted after the previous Run ended gets its own busy and idle frames even when both are read in one poll", async () => {
  const { app, start, finish } = fakeApplication();
  const feed = new CompetitionRunFeed();
  const first = "run-1" as RunId,
    second = "run-2" as RunId;
  start(first, 1_000);
  const chunks: string[] = [];
  let raced = false;
  const response = {
    write(chunk: string) {
      chunks.push(chunk);
      // Before the next poll: run 1 ends at 2_000 and prompt_async accepts run 2 in
      // the same millisecond, so the stream reads run 1's end after run 2 exists.
      if (!raced) {
        raced = true;
        finish(first, 2_000, "one");
        start(second, 2_000);
        feed.publish(second);
      }
      return true;
    },
  } as unknown as ServerResponse;
  const controller = new AbortController();
  const streaming = streamCompetitionEvents(
    app,
    feed,
    response,
    controller.signal,
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  try {
    await until(
      () => lifecycle(chunks).filter((item) => item === "busy").length === 2,
      "busy frames of both Runs",
    );
    finish(second, 3_000, "two");
    await until(
      () =>
        lifecycle(chunks).filter((item) => item === "session.idle").length ===
        2,
      "session.idle frames of both Runs",
    );
    assert.deepEqual(lifecycle(chunks), [
      "busy",
      "idle",
      "session.idle",
      "busy",
      "idle",
      "session.idle",
    ]);
  } finally {
    controller.abort();
    await streaming;
  }
});

void test("a Run queued before the previous Run ended keeps the Session busy until it ends", async () => {
  const { app, start, finish } = fakeApplication();
  const feed = new CompetitionRunFeed();
  const first = "run-1" as RunId,
    second = "run-2" as RunId;
  start(first, 1_000);
  const chunks: string[] = [];
  let queued = false;
  const response = {
    write(chunk: string) {
      chunks.push(chunk);
      if (!queued) {
        queued = true;
        // Run 2 was accepted at 1_500 while run 1 was still running.
        start(second, 1_500);
        feed.publish(second);
        finish(first, 2_000, "one");
      }
      return true;
    },
  } as unknown as ServerResponse;
  const controller = new AbortController();
  const streaming = streamCompetitionEvents(
    app,
    feed,
    response,
    controller.signal,
  ).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });
  try {
    await delay(200);
    assert.deepEqual(lifecycle(chunks), ["busy"]);
    finish(second, 3_000, "two");
    await until(
      () => lifecycle(chunks).includes("session.idle"),
      "session.idle after the queued Run",
    );
    assert.deepEqual(lifecycle(chunks), ["busy", "idle", "session.idle"]);
  } finally {
    controller.abort();
    await streaming;
  }
});
