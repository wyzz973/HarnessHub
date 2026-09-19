import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubError } from "../../src/domain/errors.js";
import type { SessionLogQuery } from "../../src/domain/logging.js";
import { JsonLogFile } from "../../src/logging/json-log-file.js";
import { createSessionLogReader } from "../../src/logging/session-log-reader.js";
import { createRedactor } from "../../src/worker/diagnostics.js";

function directory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "hh-session-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const line = (event: string, fields: Record<string, unknown> = {}) =>
  `${JSON.stringify({ time: new Date().toISOString(), level: "info", event, ...fields })}\n`;

function setup(
  t: test.TestContext,
  options: { scanBytes?: number; maxResponseBytes?: number } = {},
) {
  const root = directory(t);
  const gatewayLog = join(root, "logs", "gateway.log");
  const engineLog = (sessionId: string) =>
    join(root, "backends", sessionId, "diagnostics", "engine.log");
  mkdirSync(join(root, "logs"), { recursive: true });
  mkdirSync(join(root, "backends", "s1", "diagnostics"), { recursive: true });
  const reader = createSessionLogReader({
    gatewayLog,
    engineLog,
    redact: createRedactor(new Set(["company-secret-value"])),
    ownRoute: "/v1/sessions/:id/logs",
    ...options,
  });
  const query = (
    overrides: Partial<SessionLogQuery> = {},
  ): SessionLogQuery => ({
    sessionId: "s1",
    runIds: ["r1"],
    source: "engine",
    limit: 200,
    ...overrides,
  });
  return { root, gatewayLog, engine: engineLog("s1"), reader, query };
}

const events = (records: readonly Record<string, unknown>[]) =>
  records.map((record) => record.event);

void test("a missing engine log is reported as absent with no cursor", async (t) => {
  const { reader, query } = setup(t);
  const page = await reader.read(query());
  assert.equal(page.exists, false);
  assert.deepEqual(page.records, []);
  assert.equal(page.cursor, null);
  assert.equal(page.truncated, false);
});

void test("tail returns the newest records oldest first and a cursor continues after them", async (t) => {
  const { engine, reader, query } = setup(t);
  for (const event of ["a", "b", "c", "d", "e"])
    appendFileSync(engine, line(event));
  const tail = await reader.read(query({ limit: 3 }));
  assert.deepEqual(events(tail.records), ["c", "d", "e"]);
  assert.equal(tail.truncated, true, "older records exist");
  assert.match(tail.cursor ?? "", /^[0-9]+:[0-9]+$/);

  const idle = await reader.read(query({ after: tail.cursor! }));
  assert.deepEqual(idle.records, []);
  assert.equal(idle.cursor, tail.cursor);
  assert.equal(idle.truncated, false);

  appendFileSync(engine, line("f") + line("g"));
  // A record still being written (no newline yet) is not consumed.
  appendFileSync(
    engine,
    '{"time":"2026-01-01T00:00:00.000Z","level":"info","ev',
  );
  const next = await reader.read(query({ after: tail.cursor! }));
  assert.deepEqual(events(next.records), ["f", "g"]);
  assert.equal(next.truncated, false);
  appendFileSync(engine, 'ent":"h"}\n');
  const finished = await reader.read(query({ after: next.cursor! }));
  assert.deepEqual(events(finished.records), ["h"]);
});

void test("a cursor survives rotation and reads the rest of the rotated file before the new one", async (t) => {
  const { engine, reader, query } = setup(t);
  appendFileSync(engine, line("before"));
  const first = await reader.read(query());
  appendFileSync(engine, line("rotated-tail"));
  renameSync(engine, `${engine}.1`);
  appendFileSync(engine, line("after-rotation"));
  const page = await reader.read(query({ after: first.cursor! }));
  assert.deepEqual(events(page.records), ["rotated-tail", "after-rotation"]);
  assert.equal(page.truncated, false);

  // The tail also reaches into rotated generations.
  const tail = await reader.read(query({ limit: 10 }));
  assert.deepEqual(events(tail.records), [
    "before",
    "rotated-tail",
    "after-rotation",
  ]);
  assert.equal(tail.truncated, false);
});

void test("a cursor whose file was rotated away falls back to the newest records and reports the gap", async (t) => {
  const { engine, reader, query } = setup(t);
  appendFileSync(engine, line("old"));
  const stale = await reader.read(query());
  rmSync(engine);
  appendFileSync(engine, line("new-1") + line("new-2"));
  const page = await reader.read(query({ after: stale.cursor! }));
  assert.deepEqual(events(page.records), ["new-1", "new-2"]);
  assert.equal(page.truncated, true);
});

void test("Gateway pages keep only the Session's own lines and never the log route's access lines", async (t) => {
  const { gatewayLog, reader, query } = setup(t);
  appendFileSync(
    gatewayLog,
    line("gateway.start") +
      line("session.create", { sessionId: "s1" }) +
      line("session.create", { sessionId: "s2" }) +
      line("run.accept", { runId: "r1", sessionId: "s1" }) +
      line("run.accept", { runId: "r2", sessionId: "s2" }) +
      line("permission.decide", { permissionId: "p1", runId: "r1" }) +
      line("http", { route: "/v1/runs/:id", id: "r1", status: 200 }) +
      line("http", {
        route: "/session/:id/prompt_async",
        id: "s1",
        status: 204,
      }) +
      line("http", { route: "/v1/sessions/:id/logs", id: "s1", status: 200 }) +
      line("http", { route: "/v1/runs/:id", id: "r2", status: 200 }) +
      line("worker.exit", { sessionId: "s1", code: 0 }),
  );
  const page = await reader.read(query({ source: "gateway" }));
  assert.deepEqual(events(page.records), [
    "session.create",
    "run.accept",
    "permission.decide",
    "http",
    "http",
    "worker.exit",
  ]);
  assert.ok(
    page.records.every((record) => record.route !== "/v1/sessions/:id/logs"),
  );
  assert.ok(
    page.records.every(
      (record) =>
        record.sessionId === "s1" ||
        record.runId === "r1" ||
        record.id === "r1" ||
        record.id === "s1",
    ),
  );
});

void test("every line is redacted again and lines that are not records are counted, not returned", async (t) => {
  const { engine, reader, query } = setup(t);
  appendFileSync(
    engine,
    line("engine.stderr", {
      line: "key company-secret-value and Bearer abcdefghijklmnop",
    }) +
      "not json\n" +
      "[1,2]\n" +
      '{"level":"info","event":"no-time"}\n' +
      line("run.finish"),
  );
  const page = await reader.read(query());
  assert.deepEqual(events(page.records), ["engine.stderr", "run.finish"]);
  assert.equal(page.skipped, 3);
  const text = JSON.stringify(page.records);
  assert.equal(text.includes("company-secret-value"), false);
  assert.equal(text.includes("abcdefghijklmnop"), false);
});

void test("limit and cursor are validated and the scan budget and response size are enforced", async (t) => {
  const { engine, reader, query } = setup(t);
  for (const limit of [0, 2001, 1.5])
    await assert.rejects(reader.read(query({ limit })), (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.equal(error.statusCode, 400);
      return true;
    });
  await assert.rejects(
    reader.read(query({ after: "../etc" })),
    (error: unknown) => {
      assert.ok(error instanceof HubError);
      assert.equal(error.code, "INVALID_REQUEST");
      return true;
    },
  );

  for (let index = 0; index < 50; index++)
    appendFileSync(engine, line("filler", { index, pad: "x".repeat(200) }));
  const budgeted = setup(t, { scanBytes: 1024 });
  for (let index = 0; index < 50; index++)
    appendFileSync(
      budgeted.engine,
      line("filler", { index, pad: "x".repeat(200) }),
    );
  const scan = await budgeted.reader.read(budgeted.query());
  assert.equal(scan.truncated, true, "the scan budget stops the read");
  assert.ok(scan.records.length > 0 && scan.records.length < 50);
  assert.equal(scan.records.at(-1)!.index, 49, "the newest record is kept");

  const sized = setup(t, { maxResponseBytes: 2048 });
  for (let index = 0; index < 20; index++)
    appendFileSync(
      sized.engine,
      line("filler", { index, pad: "x".repeat(200) }),
    );
  const page = await sized.reader.read(sized.query());
  assert.equal(page.truncated, true);
  assert.ok(JSON.stringify(page.records).length <= 2048 + 20 * 8);
  assert.equal(page.records.at(-1)!.index, 19);

  const all = await reader.read(query({ limit: 2000 }));
  assert.equal(all.records.length, 50);
  assert.equal(all.truncated, false);
});

void test("records written by JsonLogFile, including its rotation, read back in order", async (t) => {
  const { engine, reader, query } = setup(t);
  const log = new JsonLogFile({
    file: engine,
    level: "info",
    maxBytes: 1024,
    keep: 3,
  });
  for (let index = 0; index < 12; index++)
    log.info("step", { index, pad: "y".repeat(120) });
  const page = await reader.read(query({ limit: 2000 }));
  const indexes = page.records.map((record) => record.index);
  assert.ok(indexes.length > 4, "rotated generations are read");
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => Number(a) - Number(b)),
  );
  assert.equal(indexes.at(-1), 11);
});
