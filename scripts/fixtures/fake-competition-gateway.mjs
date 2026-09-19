#!/usr/bin/env node
/**
 * Test fixture only: a contract-level stand-in for dist/src/competition-bundle-main.js used
 * by scripts/check-competition-acceptance.test.mjs. It follows docs/competition-api.md
 * (v1.1) for the routes the acceptance tooling calls, and a tiny "engine" that talks
 * streaming Chat Completions to HARNESSHUB_MODEL_BASE_URL (the mock upstream), executes the
 * returned shell tool call in the session directory and records one model.call event per
 * upstream call.
 *
 * Faults for negative tests (environment): FAKE_DROP_REASONING=1 omits reasoning_content
 * pass-back; FAKE_UPSTREAM_MODEL reports another upstream model; FAKE_FINISH overrides
 * info.finish; FAKE_PRINT_ENV=1 prints vendor key names and the unified key;
 * AGENT_ENGINE=broken exits before listening.
 */
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    port: { type: "string", default: "6217" },
    host: { type: "string", default: "127.0.0.1" },
    "console-port": { type: "string" },
    "no-console": { type: "boolean", default: false },
  },
  strict: true,
});
const engine = values.engine ?? process.env.AGENT_ENGINE;
if (!engine) {
  console.error("Competition bundle requires --engine or AGENT_ENGINE");
  process.exit(1);
}
if (engine === "broken") {
  console.error("Engine broken is not included in this bundle");
  process.exit(3);
}
const model = process.env.HARNESSHUB_MODEL;
const upstreamBase = process.env.HARNESSHUB_MODEL_BASE_URL;
const apiKey = process.env.HARNESSHUB_MODEL_API_KEY;
if (process.env.FAKE_PRINT_ENV === "1") {
  const vendorKeys = Object.keys(process.env).filter(
    (name) =>
      /(_API_KEY|_AUTH_TOKEN)$/i.test(name) && !name.startsWith("HARNESSHUB_"),
  );
  console.log(JSON.stringify({ vendorKeys }));
  console.log(`debug upstream key ${apiKey}`);
}
const sessions = new Map();
const runs = new Map();
const feed = [];
const tools = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          description: { type: "string" },
        },
        required: ["command", "description"],
      },
    },
  },
];

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}
const busy = (session) =>
  [...runs.values()].some(
    (run) => run.sessionId === session.id && !run.finished,
  );
const publish = (payload) => feed.push(payload);

async function upstreamCall(run, messages) {
  const started = Date.now();
  const record = {
    id: randomUUID(),
    inbound: "openai-completions",
    stream: true,
    requestedModel: "harnesshub-model",
    upstreamModel: process.env.FAKE_UPSTREAM_MODEL ?? model,
    status: 0,
    ok: false,
    durationMs: 0,
    toolCalls: 0,
  };
  try {
    const response = await fetch(`${upstreamBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages,
        tools,
        max_tokens: 1024,
      }),
      signal: run.abort.signal,
    });
    record.status = response.status;
    if (!response.ok) {
      const text = await response.text();
      record.error = {
        code: "MODEL_UPSTREAM_ERROR",
        message: text.slice(0, 200),
      };
      return { error: text };
    }
    const result = { content: "", reasoning: "", calls: [] };
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true });
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const data = buffer
          .slice(0, end)
          .replace(/^data: /, "")
          .trim();
        buffer = buffer.slice(end + 2);
        if (!data || data === "[DONE]") continue;
        const chunk = JSON.parse(data);
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta ?? {};
          if (delta.reasoning_content)
            result.reasoning += delta.reasoning_content;
          if (delta.content) {
            result.content += delta.content;
            publish({
              type: "message.part.updated",
              properties: {
                sessionID: run.sessionId,
                messageID: `${run.id}:assistant:1`,
                part: { type: "text", content: result.content },
              },
            });
          }
          for (const call of delta.tool_calls ?? []) {
            const target = (result.calls[call.index ?? 0] ??= {
              id: "",
              name: "",
              arguments: "",
            });
            if (call.id) target.id = call.id;
            if (call.function?.name) target.name += call.function.name;
            if (call.function?.arguments)
              target.arguments += call.function.arguments;
          }
          if (choice.finish_reason) record.finishReason = choice.finish_reason;
        }
        if (chunk.usage)
          record.usage = {
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
          };
      }
    }
    record.ok = true;
    record.toolCalls = result.calls.length;
    return result;
  } catch (error) {
    record.error = {
      code: "MODEL_UPSTREAM_ERROR",
      message: String(error.message).slice(0, 200),
    };
    return { error: record.error.message };
  } finally {
    record.durationMs = Date.now() - started;
    run.events.push({
      seq: run.events.length + 1,
      type: "model.call",
      data: record,
    });
  }
}

async function execute(run, session, text) {
  const messages = [
    { role: "system", content: "You are a fake engine." },
    ...session.history,
    { role: "user", content: text },
  ];
  for (let round = 0; round < 4; round++) {
    const result = await upstreamCall(run, messages);
    if (run.abort.signal.aborted) return { status: "cancelled" };
    if (result.error) return { status: "failed", error: result.error };
    if (!result.calls.length) {
      session.history.push(
        { role: "user", content: text },
        { role: "assistant", content: result.content },
      );
      return { status: "completed", output: result.content };
    }
    messages.push({
      role: "assistant",
      content: null,
      ...(process.env.FAKE_DROP_REASONING === "1"
        ? {}
        : { reasoning_content: result.reasoning }),
      tool_calls: result.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });
    for (const call of result.calls) {
      const args = JSON.parse(call.arguments);
      const output = await new Promise((resolve) =>
        exec(
          args.command,
          { cwd: session.directory },
          (error, stdout, stderr) =>
            resolve(error ? `error: ${stderr}` : stdout),
        ),
      );
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output || "(no output)",
      });
    }
  }
  return { status: "failed", error: "too many rounds" };
}

function finishOf(run) {
  if (process.env.FAKE_FINISH) return process.env.FAKE_FINISH;
  if (!run.finished) return "running";
  return run.status === "completed"
    ? "stop"
    : run.status === "cancelled"
      ? "cancelled"
      : "error";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (url.pathname === "/health/ready")
      return json(response, 200, { ready: true });
    if (url.pathname === "/") {
      response.writeHead(302, { Location: consoleUrl ?? "/health/ready" });
      return response.end();
    }
    if (url.pathname === "/v1/runtime/info")
      return json(response, 200, {
        competition: true,
        competitionEngine: engine,
        fullAccess: true,
        ...(consoleUrl ? { consoleUrl } : {}),
      });
    if (url.pathname === "/v1/harness/model")
      return json(response, 200, {
        configured: Boolean(model),
        ...(model ? { source: "environment", model } : {}),
        alias: "harnesshub-model",
        engines: [{ engineId: engine, status: model ? "applied" : "disabled" }],
      });
    if (url.pathname === "/session" && request.method === "POST") {
      const body = await readJson(request);
      await mkdir(body.directory, { recursive: true });
      const session = {
        id: `ses_${randomUUID()}`,
        title: body.title,
        directory: body.directory,
        open: true,
        history: [],
      };
      sessions.set(session.id, session);
      return json(response, 200, {
        id: session.id,
        title: session.title,
        created_at: new Date().toISOString(),
        status: "idle",
        directory: session.directory,
      });
    }
    if (url.pathname === "/session/status") {
      const status = {};
      for (const session of sessions.values())
        status[session.id] = { type: busy(session) ? "busy" : "idle" };
      return json(response, 200, status);
    }
    if (url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
      );
      let cursor = feed.length;
      const timer = setInterval(() => {
        while (cursor < feed.length)
          response.write(`data: ${JSON.stringify(feed[cursor++])}\n\n`);
      }, 20);
      request.once("close", () => clearInterval(timer));
      return undefined;
    }
    if (parts[0] === "session" && parts[1]) {
      const session = sessions.get(parts[1]);
      if (!session)
        return json(response, 404, {
          code: "NOT_FOUND",
          message: "Session not found",
        });
      if (parts[2] === "prompt_async" && request.method === "POST") {
        const body = await readJson(request);
        if (!session.open)
          return json(response, 400, {
            code: "VALIDATION_ERROR",
            message: "Session is closed",
          });
        const run = {
          id: `run_${randomUUID()}`,
          sessionId: session.id,
          text: body.parts.map((part) => part.text).join("\n"),
          abort: new AbortController(),
          events: [],
          finished: false,
        };
        runs.set(run.id, run);
        publish({
          type: "session.status",
          properties: { sessionID: session.id, status: { type: "busy" } },
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const outcome = await execute(run, session, run.text);
        Object.assign(run, outcome, { finished: true });
        if (run.status === "failed")
          publish({
            type: "session.error",
            properties: {
              sessionID: session.id,
              error: { message: run.error, data: { runId: run.id } },
            },
          });
        if (run.status !== "completed") session.open = false;
        publish({
          type: "session.status",
          properties: { sessionID: session.id, status: { type: "idle" } },
        });
        publish({
          type: "session.idle",
          properties: { sessionID: session.id },
        });
        if (run.status === "completed" || run.status === "cancelled") {
          response.writeHead(204);
          return response.end();
        }
        return json(response, 502, { code: "BAD_GATEWAY", message: run.error });
      }
      if (parts[2] === "message") {
        const messages = [...runs.values()]
          .filter((run) => run.sessionId === session.id)
          .flatMap((run) => [
            { id: `${run.id}:user`, role: "user", content: run.text },
            {
              id: `${run.id}:assistant:1`,
              role: "assistant",
              content: run.output ?? "",
              tool_calls: [],
              info: {
                role: "assistant",
                finish: finishOf(run),
                ...(run.status === "failed"
                  ? { error: { code: "ENGINE_FAILED", message: run.error } }
                  : {}),
              },
              parts: [
                { type: "text", content: run.output ?? "" },
                ...(run.finished ? [{ type: "step-finish" }] : []),
              ],
            },
          ]);
        return json(response, 200, messages);
      }
      if (parts[2] === "abort" && request.method === "POST") {
        for (const run of runs.values())
          if (run.sessionId === session.id && !run.finished) run.abort.abort();
        return json(response, 200, { ok: true });
      }
      if (!parts[2] && request.method === "DELETE") {
        session.open = false;
        return json(response, 200, { ok: true });
      }
      if (!parts[2])
        return json(response, 200, {
          id: session.id,
          title: session.title,
          status: busy(session) ? "busy" : "idle",
        });
    }
    if (parts[0] === "v1" && parts[1] === "sessions" && parts[3] === "runs")
      return json(response, 200, {
        runs: [...runs.values()]
          .filter((run) => run.sessionId === parts[2])
          .map((run) => ({
            id: run.id,
            status: run.finished ? run.status : "running",
          })),
      });
    if (parts[0] === "v1" && parts[1] === "runs" && parts[3] === "event-log") {
      const run = runs.get(parts[2]);
      const after = Number(url.searchParams.get("afterSeq") ?? 0);
      return json(response, 200, {
        events: (run?.events ?? []).filter((event) => event.seq > after),
      });
    }
    return json(response, 404, { code: "NOT_FOUND", message: url.pathname });
  } catch (error) {
    return json(response, 500, {
      code: "INTERNAL_ERROR",
      message: error.message,
    });
  }
});

let consoleUrl;
if (!values["no-console"]) {
  const consoleServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<!doctype html><title>HarnessHub</title><p>HarnessHub console</p>",
    );
  });
  consoleServer.listen(Number(values["console-port"] ?? 0), "127.0.0.1");
  await new Promise((resolve) => consoleServer.once("listening", resolve));
  consoleUrl = `http://127.0.0.1:${consoleServer.address().port}`;
}
server.listen(Number(values.port), values.host);
await new Promise((resolve) => server.once("listening", resolve));
console.log(
  JSON.stringify({
    event: "competition.ready",
    url: `http://${values.host}:${values.port}`,
    engine,
    port: Number(values.port),
    pid: process.pid,
  }),
);
