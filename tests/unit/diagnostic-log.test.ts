import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubError } from "../../src/domain/errors.js";
import {
  excerpt,
  parseLogLevel,
  type LogFields,
  type LogSink,
} from "../../src/domain/logging.js";
import { JsonLogFile } from "../../src/logging/json-log-file.js";
import { AcpTrafficLog } from "../../src/drivers/acp/traffic-log.js";
import { observeStore } from "../../src/logging/observed-store.js";
import { createRedactor } from "../../src/worker/diagnostics.js";
import type { Store } from "../../src/domain/ports.js";

function directory(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "hh-log-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const read = (file: string) =>
  readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

class MemorySink implements LogSink {
  readonly records: ({ event: string; level: string } & LogFields)[] = [];
  constructor(readonly level: "info" | "debug" = "info") {}
  info(event: string, fields?: LogFields) {
    this.records.push({ ...fields, event, level: "info" });
  }
  debug(event: string, fields?: LogFields) {
    if (this.level === "debug")
      this.records.push({ ...fields, event, level: "debug" });
  }
  of(event: string) {
    return this.records.filter((record) => record.event === event);
  }
}

void test("HARNESSHUB_LOG_LEVEL accepts info and debug only, defaulting to info", () => {
  assert.equal(parseLogLevel(undefined), "info");
  assert.equal(parseLogLevel(""), "info");
  assert.equal(parseLogLevel("  "), "info");
  assert.equal(parseLogLevel(" DEBUG "), "debug");
  assert.equal(parseLogLevel("Info"), "info");
  for (const invalid of ["verbose", "trace", "0", "debug2"])
    assert.throws(
      () => parseLogLevel(invalid),
      (error: unknown) =>
        error instanceof HubError && error.code === "INVALID_CONFIG",
    );
});

void test("excerpts count code points and report what was cut", () => {
  assert.equal(excerpt("short", 10), "short");
  assert.equal(excerpt("0123456789", 10), "0123456789");
  assert.equal(excerpt("01234567890", 10), "0123456789…(+1)");
  // Emoji and CJK are single characters; no surrogate pair is split.
  assert.equal(excerpt("😀😀😀中文", 2), "😀😀…(+3)");
});

void test("the log file writes one bounded, redacted JSON object per line and filters debug", (t) => {
  const root = directory(t);
  const file = join(root, "logs", "gateway.log");
  const secrets = new Set(["company-secret-value-123"]);
  const echoed: string[] = [];
  const log = new JsonLogFile({
    file,
    level: "info",
    redact: createRedactor(secrets),
    echo: (line) => echoed.push(line),
    now: () => new Date("2026-09-20T01:02:03.004Z"),
  });
  log.info("run.finish", {
    runId: "r1",
    skipped: undefined,
    error: { code: "X", message: "upstream said company-secret-value-123" },
    header: "Authorization: Bearer abcdefghijklmnop",
    level: "not the record level",
    long: "x".repeat(20000),
  });
  log.debug("acp.request.params", { params: "hidden at info" });
  const records = read(file);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record!.time, "2026-09-20T01:02:03.004Z");
  assert.equal(record!.level, "info");
  assert.equal(record!.event, "run.finish");
  assert.equal(record!._level, "not the record level");
  assert.equal("skipped" in record!, false);
  assert.deepEqual(record!.error, {
    code: "X",
    message: "upstream said [REDACTED]",
  });
  assert.doesNotMatch(String(record!.header), /abcdefghijklmnop/);
  assert.match(String(record!.header), /^Authorization: .*\[REDACTED\]$/);
  assert.equal((record!.long as string).length, 8192 + "…(+11808)".length);
  assert.equal(echoed.length, 1);
  assert.equal(echoed[0], readFileSync(file, "utf8").trimEnd());
  assert.equal(readFileSync(file, "utf8").includes("company-secret"), false);

  const debug = new JsonLogFile({
    file: join(root, "debug.log"),
    level: "debug",
  });
  debug.debug("acp.update", { update: "{}" });
  debug.info("acp.turn", {});
  assert.deepEqual(
    read(join(root, "debug.log")).map((entry) => [entry.level, entry.event]),
    [
      ["debug", "acp.update"],
      ["info", "acp.turn"],
    ],
  );
});

void test("the log file rotates by size and keeps the configured generations", (t) => {
  const root = directory(t);
  const file = join(root, "engine.log");
  const log = new JsonLogFile({ file, level: "info", maxBytes: 1024, keep: 2 });
  for (let index = 0; index < 60; index++)
    log.info("engine.stderr", { index, line: "y".repeat(80) });
  assert.ok(existsSync(file));
  assert.ok(existsSync(`${file}.1`));
  assert.ok(existsSync(`${file}.2`));
  assert.equal(existsSync(`${file}.3`), false);
  const newest = read(file);
  for (const generation of [file, `${file}.1`, `${file}.2`]) {
    assert.ok(readFileSync(generation).length <= 1024);
    for (const entry of read(generation))
      assert.equal(entry.event, "engine.stderr");
  }
  assert.equal(newest.at(-1)!.index, 59);
  // Ordering across generations is preserved: .1 ends right before the current file.
  assert.equal(
    (read(`${file}.1`).at(-1)!.index as number) + 1,
    newest[0]!.index,
  );
});

void test("a failing log file reports once, never throws and keeps echoing", (t) => {
  const root = directory(t);
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "file");
  const errors: unknown[] = [];
  const echoed: string[] = [];
  const log = new JsonLogFile({
    file: join(blocker, "logs", "gateway.log"),
    level: "info",
    onError: (error) => errors.push(error),
    echo: (line) => echoed.push(line),
  });
  for (let index = 0; index < 5; index++)
    assert.doesNotThrow(() => log.info("http", { index }));
  assert.equal(errors.length, 1);
  assert.equal(echoed.length, 5);
  assert.throws(
    () => new JsonLogFile({ file: "relative.log", level: "info" }),
    /absolute/,
  );
});

void test("ACP traffic becomes request, response, turn, tool and process records", () => {
  let clock = 1000;
  const log = new MemorySink();
  const traffic = new AcpTrafficLog(log, () => clock);
  traffic.process({
    type: "spawn",
    pid: 42,
    command: "opencode",
    args: ["acp"],
    cwd: "/work",
  });
  traffic.message("outbound", {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {},
  });
  clock += 30;
  traffic.message("inbound", {
    jsonrpc: "2.0",
    id: 0,
    result: {
      protocolVersion: 1,
      agentInfo: { name: "opencode", version: "1.18.29" },
      agentCapabilities: { loadSession: true, promptCapabilities: {} },
      authMethods: [],
    },
  });
  traffic.message("outbound", {
    jsonrpc: "2.0",
    id: 1,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "task" }] },
  });
  for (const update of [
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "想" },
    },
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "答案" },
    },
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      kind: "execute",
      status: "pending",
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
    },
    { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [] },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
    },
  ])
    traffic.message("inbound", {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update },
    });
  traffic.message("inbound", {
    jsonrpc: "2.0",
    id: 7,
    method: "session/request_permission",
    params: { toolCall: { toolCallId: "t1", title: "bash" } },
  });
  traffic.message("outbound", {
    jsonrpc: "2.0",
    id: 7,
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  });
  traffic.message("outbound", { jsonrpc: "2.0", method: "session/cancel" });
  clock += 500;
  traffic.message("inbound", {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "model failed", data: { detail: "x" } },
  });
  for (const junk of [null, "text", [1], { jsonrpc: "2.0" }, 5])
    assert.doesNotThrow(() => traffic.message("inbound", junk));
  // stderr arrives in arbitrary chunks, including split UTF-8 sequences.
  const bytes = Buffer.from("第一行\nsecond line\npartial", "utf8");
  traffic.process({ type: "stderr", pid: 42, data: bytes.subarray(0, 4) });
  traffic.process({ type: "stderr", pid: 42, data: bytes.subarray(4) });
  traffic.process({
    type: "exit",
    pid: 42,
    reason: "process_exit",
    code: 1,
    signal: null,
  });

  assert.deepEqual(log.of("engine.spawn")[0], {
    event: "engine.spawn",
    level: "info",
    pid: 42,
    command: "opencode",
    args: ["acp"],
    cwd: "/work",
  });
  const initialize = log
    .of("acp.response")
    .find((record) => record.method === "initialize")!;
  assert.equal(initialize.ms, 30);
  assert.equal(initialize.agent, "opencode 1.18.29");
  assert.deepEqual(initialize.capabilities, [
    "loadSession",
    "promptCapabilities",
  ]);
  const prompt = log
    .of("acp.response")
    .find((record) => record.method === "session/prompt")!;
  assert.equal(prompt.ok, false);
  assert.equal(prompt.ms, 500);
  assert.deepEqual(prompt.error, {
    code: -32603,
    message: "model failed",
    data: '{"detail":"x"}',
  });
  assert.deepEqual(log.of("acp.turn")[0], {
    event: "acp.turn",
    level: "info",
    id: 1,
    ms: 500,
    stopReason: null,
    ok: false,
    updates: {
      agent_thought_chunk: 1,
      agent_message_chunk: 1,
      tool_call: 1,
      tool_call_update: 3,
    },
    textBytes: Buffer.byteLength("答案"),
    thoughtBytes: Buffer.byteLength("想"),
  });
  assert.deepEqual(
    log.of("acp.tool").map((record) => record.status),
    ["pending", "in_progress", "completed"],
  );
  const permission = log
    .of("acp.request")
    .find((record) => record.method === "session/request_permission")!;
  assert.equal(permission.dir, "from-engine");
  assert.equal(permission.toolCallId, "t1");
  assert.equal(
    log.of("acp.response").find((record) => record.id === 7)!.dir,
    "to-engine",
  );
  assert.deepEqual(log.of("acp.notification")[0], {
    event: "acp.notification",
    level: "info",
    dir: "to-engine",
    method: "session/cancel",
  });
  assert.deepEqual(
    log.of("engine.stderr").map((record) => record.line),
    ["第一行", "second line", "partial"],
  );
  assert.equal(log.of("engine.exit")[0]!.code, 1);
  assert.equal(
    log.records.some((record) => record.level === "debug"),
    false,
  );
});

void test("debug ACP records carry bounded payload excerpts and stderr has a budget", () => {
  const log = new MemorySink("debug");
  const traffic = new AcpTrafficLog(log, () => 0);
  traffic.message("outbound", {
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { prompt: [{ type: "text", text: "长".repeat(5000) }] },
  });
  traffic.message("inbound", {
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "plan", entries: [] } },
  });
  const params = log.of("acp.request.params")[0]!.params as string;
  assert.ok(params.length <= 2048 + 10);
  assert.match(params, /…\(\+\d+\)$/);
  assert.equal(log.of("acp.update")[0]!.kind, "plan");

  const line = "e".repeat(1000);
  for (let index = 0; index < 400; index++)
    traffic.process({ type: "stderr", pid: 9, data: `${line}\n` });
  traffic.process({
    type: "exit",
    pid: 9,
    reason: "process_exit",
    code: 0,
    signal: null,
  });
  const logged = log.of("engine.stderr").length;
  assert.ok(logged >= 250 && logged < 400);
  assert.equal(
    log.of("engine.stderr.dropped")[0]!.bytes,
    (400 - logged) * 1000,
  );
});

void test("the observed store logs committed changes only and isolates the log", () => {
  const log = new MemorySink();
  const session = {
    id: "s1",
    engineId: "opencode",
    profileRevision: "rev",
    workspaceId: "w",
    cwd: "/w",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
  };
  const run = {
    id: "r1",
    sessionId: "s1",
    generation: 1,
    status: "completed",
    input: { text: "task", timeoutMs: 3_600_000 },
    createdAt: 1000,
    startedAt: 1500,
    finishedAt: 4500,
    deadlineAt: 3_601_000,
    stopReason: "end_turn",
    cleanupStatus: "confirmed",
    error: { code: "E", message: "m" },
    output: "out",
    lastSeq: 3,
  };
  let failWrites = false;
  const target = {
    createSession: () => session,
    acceptRun: () => ({ run, created: true }),
    finishRun: () => {
      if (failWrites) throw new Error("SQLITE_BUSY");
      return run;
    },
    getRun: () => run,
    appendEvent: () => ({
      type: "model.call",
      runId: "r1",
      sessionId: "s1",
      data: {
        ok: false,
        status: 400,
        durationMs: 9,
        error: { code: "upstream_http_error", message: "bad" },
      },
    }),
  } as unknown as Store;
  const observed = observeStore(target, log, {
    engineLog: (id) => `/data/backends/${id}/diagnostics/engine.log`,
  });
  observed.createSession({} as never, { id: "w", path: "/w" });
  observed.acceptRun("s1" as never, { text: "task", timeoutMs: 1 });
  observed.getRun("r1" as never);
  observed.appendEvent("r1" as never, { type: "model.call", data: {} });
  observed.finishRun("r1" as never, {
    status: "completed",
    stopReason: "end_turn",
    cleanupStatus: "confirmed",
  });
  failWrites = true;
  assert.throws(
    () =>
      observed.finishRun("r1" as never, {
        status: "completed",
        stopReason: "end_turn",
        cleanupStatus: "confirmed",
      }),
    /SQLITE_BUSY/,
  );
  assert.deepEqual(
    log.records.map((record) => record.event),
    ["session.create", "run.accept", "model.call", "run.finish"],
  );
  assert.equal(
    log.of("session.create")[0]!.engineLog,
    "/data/backends/s1/diagnostics/engine.log",
  );
  const finish = log.of("run.finish")[0]!;
  assert.equal(finish.ms, 3000);
  assert.equal(finish.queuedMs, 500);
  assert.deepEqual(finish.error, { code: "E", message: "m" });

  const throwing: LogSink = {
    level: "info",
    info: () => {
      throw new Error("disk full");
    },
    debug: () => undefined,
  };
  const isolated = observeStore(target, throwing, { engineLog: () => "" });
  failWrites = false;
  assert.equal(isolated.getRun("r1" as never), run);
  assert.equal(
    isolated.finishRun("r1" as never, {
      status: "completed",
      stopReason: "end_turn",
      cleanupStatus: "confirmed",
    }),
    run,
  );
});
