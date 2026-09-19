import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../../src/main.js";

type Hub = Awaited<ReturnType<typeof startHub>>;

interface Part {
  id: string;
  type: string;
  content?: string;
  tool?: string;
  callID?: string;
  state?: { status: string; title: string };
}
interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
  tool_calls?: { id: string; name: string; arguments: object }[];
  tool_call_id?: string;
  tool_name?: string;
  info?: { finish?: string; error?: { code: string; message: string } };
  parts?: Part[];
}
interface Frame {
  type: string;
  properties: {
    sessionID?: string;
    messageID?: string;
    part?: Part;
    status?: { type: string };
    error?: { message: string; data: { code: string; runId: string } };
  };
}
interface ErrorBody {
  code: string;
  message: string;
}

const jsonHeader = { "content-type": "application/json" };

/**
 * Starts a compiled competition Gateway with the demo fake engine. Teardown closes
 * the Gateway first, which must end open event streams, then awaits the stream
 * readers registered with `follow` and removes the temporary root.
 */
async function competitionHub(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "harnesshub-competition-"));
  let hub: Hub;
  try {
    hub = await startHub({
      dataDir: path.join(root, "data"),
      demo: true,
      competition: true,
      competitionEngine: "fake",
      defaultEngine: "fake",
      cwd: root,
      port: 0,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const readers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= hub.server.close());
  t.after(async () => {
    try {
      await close();
    } finally {
      for (const stop of readers) await stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    base: hub.url,
    root,
    close,
    follow: (stop: () => Promise<void>) => readers.push(stop),
  };
}

async function call<T>(
  base: string,
  route: string,
  init: {
    method?: string;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; value: T; headers: Headers }> {
  const headers: Record<string, string> = { ...init.headers };
  let body: string | undefined = init.raw;
  if (body === undefined && init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  const response = await fetch(`${base}${route}`, {
    method: init.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    value: (text ? JSON.parse(text) : undefined) as T,
    headers: response.headers,
  };
}

function prompt(base: string, id: string, text: string, signal?: AbortSignal) {
  return call<ErrorBody | undefined>(base, `/session/${id}/prompt_async`, {
    method: "POST",
    body: {
      parts: [{ type: "text", text }],
      model: { providerID: "evaluator", modelID: "gpt-4" },
      agent: "assistant",
    },
    ...(signal ? { signal } : {}),
  });
}

async function createSession(base: string, directory: string, title?: string) {
  const created = await call<{
    id: string;
    title: string;
    status: string;
    created_at: string;
    directory: string;
  }>(base, "/session", {
    method: "POST",
    body: { ...(title ? { title } : {}), directory },
  });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  return created.value;
}

async function messages(base: string, id: string) {
  const listed = await call<Message[]>(base, `/session/${id}/message`);
  assert.equal(listed.status, 200);
  return listed.value;
}

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(20);
  }
}

async function sessionState(base: string, id: string) {
  const status = await call<Record<string, { type: string }>>(
    base,
    "/session/status",
  );
  return status.value[id]?.type;
}

/** Collects `/event` frames; `until` waits for a predicate with a deadline. */
async function openEvents(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/event`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const frames: Frame[] = [];
  let wake: () => void = () => undefined;
  let ended = false;
  const reader = response.body?.getReader();
  assert.ok(reader);
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (
          let end = buffer.indexOf("\n\n");
          end >= 0;
          end = buffer.indexOf("\n\n")
        ) {
          for (const line of buffer.slice(0, end).split("\n"))
            if (line.startsWith("data: "))
              frames.push(JSON.parse(line.slice(6)) as Frame);
          buffer = buffer.slice(end + 2);
        }
        wake();
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      ended = true;
      wake();
    }
  })();
  return {
    response,
    frames,
    ended: () => ended,
    async until(predicate: (frames: Frame[]) => boolean, what: string) {
      const deadline = Date.now() + 10_000;
      while (!predicate(frames)) {
        if (ended) throw new Error(`Event stream ended before ${what}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(
            `Timed out waiting for ${what}: ${JSON.stringify(frames.map((f) => f.type))}`,
          );
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          delay(Math.min(remaining, 200)),
        ]);
      }
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

function sessionFrames(frames: Frame[], id: string) {
  return frames.filter((frame) => frame.properties.sessionID === id);
}

/** Session lifecycle frames reduced to busy/idle/session.idle/session.error. */
function lifecycle(frames: Frame[], id: string) {
  return sessionFrames(frames, id)
    .filter((frame) => frame.type !== "message.part.updated")
    .map((frame) =>
      frame.type === "session.status"
        ? frame.properties.status?.type
        : frame.type,
    );
}

void test(
  "competition API creates missing directories and blocks prompt_async until the Run ends",
  { timeout: 30_000 },
  async (t) => {
    const { base, root } = await competitionHub(t);
    const directory = path.join(root, "workspace", "office_002", "nested");
    const created = await createSession(base, directory, "contest");
    assert.equal(created.title, "contest");
    assert.equal(created.status, "idle");
    assert.ok((await stat(directory)).isDirectory());
    assert.equal(created.directory, await realpath(directory));
    assert.ok(!Number.isNaN(Date.parse(created.created_at)));

    const untitled = await createSession(base, path.join(root, "second"));
    assert.ok(untitled.title.length > 0);
    // model is required but ignored for execution, so empty identifiers are accepted.
    const anyModel = await call(base, `/session/${untitled.id}/prompt_async`, {
      method: "POST",
      body: {
        parts: [{ type: "text", text: "unified model" }],
        model: { providerID: "", modelID: "" },
      },
    });
    assert.equal(anyModel.status, 204);

    const done = await prompt(
      base,
      created.id,
      "请自动打开 Outlook 邮件客户端",
    );
    assert.equal(done.status, 204);
    const listed = await messages(base, created.id);
    assert.deepEqual(
      listed.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(listed[0]?.content, "请自动打开 Outlook 邮件客户端");
    const reply = listed[1];
    assert.equal(reply?.content, "请自动打开 Outlook 邮件客户端");
    assert.equal(reply?.info?.finish, "stop");
    assert.deepEqual(reply?.tool_calls, []);
    assert.deepEqual(
      reply?.parts?.map((part) => part.type),
      ["text", "step-finish"],
    );
    const session = await call<{ status: string; message_count: number }>(
      base,
      `/session/${created.id}`,
    );
    assert.equal(session.value.status, "idle");
    assert.equal(session.value.message_count, listed.length);
    assert.equal(await sessionState(base, created.id), "idle");

    // prompt_async stays open while the Run is unfinished; stop answers 204.
    const waiting = prompt(base, created.id, "[fake:wait] hold");
    await waitFor(
      async () => (await sessionState(base, created.id)) === "busy",
      "busy session",
    );
    const early = await Promise.race([
      waiting.then(() => "answered"),
      delay(150).then(() => "pending"),
    ]);
    assert.equal(early, "pending");
    const stopped = await call<{ ok: boolean }>(
      base,
      `/session/${created.id}/stop`,
      { method: "POST", headers: jsonHeader },
    );
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.value, { ok: true });
    assert.equal((await waiting).status, 204);
    const afterStop = await messages(base, created.id);
    assert.equal(afterStop.at(-1)?.role, "assistant");
    assert.equal(afterStop.at(-1)?.info?.finish, "cancelled");
    assert.equal(afterStop.length, 4);

    const removed = await call<{ ok: boolean }>(
      base,
      `/session/${created.id}`,
      {
        method: "DELETE",
        headers: jsonHeader,
      },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.value, { ok: true });
    const again = await call<{ ok: boolean }>(base, `/session/${created.id}`, {
      method: "DELETE",
      headers: jsonHeader,
    });
    assert.deepEqual(again.value, { ok: true });
    const closed = await prompt(base, created.id, "after delete");
    assert.equal(closed.status, 400);
    assert.equal(closed.value?.code, "VALIDATION_ERROR");
  },
);

void test(
  "competition API answers every error with the specification body",
  { timeout: 30_000 },
  async (t) => {
    const { base, root } = await competitionHub(t);
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const [method, route] of [
      ["DELETE", `/session/${unknown}`],
      ["POST", `/session/${unknown}/abort`],
      ["POST", `/session/${unknown}/stop`],
      ["GET", `/session/${unknown}`],
      ["GET", `/session/${unknown}/message`],
    ] as const) {
      const missing = await call<ErrorBody>(base, route, {
        method,
        ...(method === "GET" ? {} : { headers: jsonHeader }),
      });
      assert.equal(missing.status, 404, `${method} ${route}`);
      assert.deepEqual(missing.value, {
        code: "NOT_FOUND",
        message: "Session not found",
      });
    }
    const missingPrompt = await prompt(base, unknown, "hello");
    assert.equal(missingPrompt.status, 404);
    assert.equal(missingPrompt.value?.code, "NOT_FOUND");

    const expectInvalid = async (
      result: Promise<{ status: number; value: ErrorBody | undefined }>,
      message?: RegExp,
    ) => {
      const { status, value } = await result;
      assert.equal(status, 400, JSON.stringify(value));
      assert.equal(value?.code, "VALIDATION_ERROR");
      assert.deepEqual(Object.keys(value ?? {}).sort(), ["code", "message"]);
      if (message) assert.match(value?.message ?? "", message);
    };
    await expectInvalid(
      call(base, "/session", { method: "POST", body: {} }),
      /directory/,
    );
    await expectInvalid(
      call(base, "/session", { method: "POST", headers: jsonHeader }),
      /directory/,
    );
    await expectInvalid(
      call(base, "/session", {
        method: "POST",
        raw: "{",
        headers: jsonHeader,
      }),
      /not valid JSON/,
    );
    await expectInvalid(
      call(base, "/session", {
        method: "POST",
        raw: "directory=x",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      /Content-Type/,
    );
    await expectInvalid(
      call(base, "/session", { method: "POST", body: [] }),
      /JSON object/,
    );
    await expectInvalid(
      call(base, "/session", {
        method: "POST",
        body: { title: 7, directory: root },
      }),
      /title/,
    );
    const file = path.join(root, "occupied");
    await writeFile(file, "not a directory");
    await expectInvalid(
      call(base, "/session", {
        method: "POST",
        body: { directory: path.join(file, "child") },
      }),
      /could not be created: .*\(E[A-Z]+\)/,
    );

    const session = await createSession(base, path.join(root, "valid"));
    const route = `/session/${session.id}/prompt_async`;
    for (const body of [
      {},
      { parts: [], model: { providerID: "p", modelID: "m" } },
      {
        parts: [{ type: "image", url: "x" }],
        model: { providerID: "p", modelID: "m" },
      },
      { parts: [{ type: "text", text: "hi" }] },
      { parts: [{ type: "text", text: "hi" }], model: { providerID: "p" } },
      {
        parts: [{ type: "text", text: "hi" }],
        model: { providerID: "p", modelID: "m" },
        agent: 3,
      },
    ])
      await expectInvalid(call(base, route, { method: "POST", body }));
    await expectInvalid(
      call(base, route, { method: "POST", headers: jsonHeader }),
    );
    assert.deepEqual(await messages(base, session.id), []);

    const questions = await call<unknown[]>(base, "/question");
    assert.deepEqual(questions.value, []);
    const question = await call<ErrorBody>(base, "/question/que_1/reply", {
      method: "POST",
      body: { answers: [["方案 A"]] },
    });
    assert.equal(question.status, 404);
    assert.equal(question.value.code, "NOT_FOUND");
    await expectInvalid(
      call(base, "/question/que_1/reply", {
        method: "POST",
        body: { answers: "A" },
      }),
    );
    const permissions = await call<unknown[]>(base, "/permission");
    assert.deepEqual(permissions.value, []);
    const permission = await call<ErrorBody>(base, "/permission/per_1/reply", {
      method: "POST",
      body: { reply: "always", message: "ok" },
    });
    assert.equal(permission.status, 404);
    assert.equal(permission.value.code, "NOT_FOUND");
    await expectInvalid(
      call(base, "/permission/per_1/reply", {
        method: "POST",
        body: { reply: "maybe" },
      }),
      /reply/,
    );

    // Native /v1 routes keep their envelope and now also accept bodiless JSON.
    const native = await call<{ error: { code: string } }>(
      base,
      `/v1/sessions/${unknown}/close`,
      { method: "POST", headers: jsonHeader },
    );
    assert.equal(native.status, 404);
    assert.equal(native.value.error.code, "SESSION_NOT_FOUND");
    const nativeInvalid = await call<{ error: { code: string } }>(
      base,
      "/v1/sessions",
      { method: "POST", raw: "{", headers: jsonHeader },
    );
    assert.equal(nativeInvalid.status, 400);
    assert.equal(
      nativeInvalid.value.error.code,
      "FST_ERR_CTP_INVALID_JSON_BODY",
    );
  },
);

void test(
  "competition failures return BAD_GATEWAY and emit session.error before idle",
  { timeout: 30_000 },
  async (t) => {
    const { base, root, follow } = await competitionHub(t);
    const events = await openEvents(base);
    follow(() => events.close());
    assert.equal(
      events.response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    assert.equal(events.response.headers.get("cache-control"), "no-cache");
    assert.equal(events.response.headers.get("x-accel-buffering"), "no");
    await events.until(
      (frames) => frames[0]?.type === "server.connected",
      "server.connected",
    );
    const session = await createSession(base, path.join(root, "failing"));
    const failed = await prompt(
      base,
      session.id,
      "[fake:fail] upstream model rejected the request",
    );
    assert.equal(failed.status, 502);
    assert.deepEqual(failed.value, {
      code: "BAD_GATEWAY",
      message: "upstream model rejected the request",
    });
    await events.until(
      (frames) =>
        sessionFrames(frames, session.id).some(
          (frame) => frame.type === "session.idle",
        ),
      "session.idle after failure",
    );
    assert.deepEqual(lifecycle(events.frames, session.id), [
      "busy",
      "session.error",
      "idle",
      "session.idle",
    ]);
    const error = sessionFrames(events.frames, session.id).find(
      (frame) => frame.type === "session.error",
    );
    assert.equal(
      error?.properties.error?.message,
      "upstream model rejected the request",
    );
    assert.equal(error?.properties.error?.data.code, "FAKE_FAILURE");
    const listed = await messages(base, session.id);
    const last = listed.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal(last?.info?.finish, "error");
    assert.deepEqual(last?.info?.error, {
      code: "FAKE_FAILURE",
      message: "upstream model rejected the request",
    });
    assert.ok(last?.parts?.some((part) => part.type === "step-finish"));
    assert.equal(error?.properties.error?.data.runId, last?.id.split(":")[0]);
  },
);

void test(
  "competition event stream reports each quick Run as busy then idle",
  { timeout: 30_000 },
  async (t) => {
    const { base, root, follow } = await competitionHub(t);
    const events = await openEvents(base);
    follow(() => events.close());
    await events.until((frames) => frames.length > 0, "server.connected");
    const session = await createSession(base, path.join(root, "quick"));
    const texts = ["one", "two", "three"];
    for (const text of texts)
      assert.equal((await prompt(base, session.id, text)).status, 204);
    await events.until(
      (frames) =>
        sessionFrames(frames, session.id).filter(
          (frame) => frame.type === "session.idle",
        ).length === texts.length,
      "three session.idle frames",
    );
    assert.deepEqual(
      lifecycle(events.frames, session.id),
      texts.flatMap(() => ["busy", "idle", "session.idle"]),
    );
    const listed = await messages(base, session.id);
    const replies = listed.filter((message) => message.role === "assistant");
    assert.deepEqual(
      replies.map((message) => message.content),
      texts,
    );
    for (const reply of replies) {
      const updates = sessionFrames(events.frames, session.id).filter(
        (frame) => frame.properties.messageID === reply.id,
      );
      assert.deepEqual(
        updates.map((frame) => frame.properties.part?.type),
        ["text", "step-finish"],
      );
      assert.equal(updates[0]?.properties.part?.content, reply.content);
      assert.equal(updates[0]?.properties.part?.id, reply.parts?.[0]?.id);
    }
  },
);

void test(
  "competition trajectory exposes steps, tool calls and tool results",
  { timeout: 30_000 },
  async (t) => {
    const { base, root, follow } = await competitionHub(t);
    const events = await openEvents(base);
    follow(() => events.close());
    await events.until((frames) => frames.length > 0, "server.connected");
    const session = await createSession(base, path.join(root, "tools"));
    const task = "请自动打开 Outlook 邮件客户端";
    assert.equal(
      (await prompt(base, session.id, `[fake:tools] ${task}`)).status,
      204,
    );
    const listed = await messages(base, session.id);
    assert.deepEqual(
      listed.map((message) => message.role),
      ["user", "assistant", "tool", "assistant", "tool", "tool", "assistant"],
    );
    const [user, first, listing, second, missing, large, final] = listed;
    assert.equal(user?.content, `[fake:tools] ${task}`);

    assert.equal(first?.content, `Inspecting the workspace for: ${task}`);
    assert.equal(first?.info?.finish, "tool-calls");
    assert.deepEqual(first?.tool_calls, [
      {
        id: "call_1",
        name: "bash",
        arguments: { command: "ls", description: "List workspace files" },
      },
    ]);
    assert.deepEqual(
      first?.parts?.map((part) => [part.type, part.state?.status]),
      [
        ["text", undefined],
        ["tool", "completed"],
        ["step-finish", undefined],
      ],
    );
    assert.deepEqual(first?.parts?.[1]?.state, {
      status: "completed",
      title: "List workspace files",
    });
    assert.equal(first?.parts?.[1]?.tool, "bash");
    assert.deepEqual(
      [listing?.tool_call_id, listing?.tool_name, listing?.content],
      ["call_1", "bash", "README.md\nnotes.txt\n"],
    );

    assert.equal(second?.content, "Reading the requested files.");
    assert.equal(second?.info?.finish, "tool-calls");
    assert.deepEqual(
      second?.tool_calls?.map((call) => [call.id, call.name, call.arguments]),
      [
        ["call_2", "read", { filePath: "missing.txt" }],
        ["call_3", "read", { filePath: "large.txt" }],
      ],
    );
    assert.deepEqual(
      second?.parts
        ?.filter((part) => part.type === "tool")
        .map((part) => part.state),
      [
        { status: "error", title: "read" },
        { status: "completed", title: "large.txt" },
      ],
    );
    assert.equal(missing?.tool_call_id, "call_2");
    assert.equal(missing?.content, "File not found: missing.txt");
    assert.equal(large?.tool_call_id, "call_3");
    assert.ok(large?.content.startsWith("界".repeat(8000)));
    assert.ok(large?.content.endsWith("\n…[truncated 1000 characters]"));
    assert.equal([...(large?.content ?? "")].length, 8000 + 29);

    assert.equal(final?.content, `Done: ${task}`);
    assert.equal(final?.info?.finish, "stop");
    assert.deepEqual(final?.tool_calls, []);
    assert.deepEqual(
      final?.parts?.map((part) => part.type),
      ["text", "step-finish"],
    );
    assert.ok(
      listed.every(
        (message) => !message.content.includes("Summarizing the tool results"),
      ),
    );
    const detail = await call<{ message_count: number }>(
      base,
      `/session/${session.id}`,
    );
    assert.equal(detail.value.message_count, listed.length);

    await events.until(
      (frames) =>
        sessionFrames(frames, session.id).some(
          (frame) => frame.type === "session.idle",
        ),
      "session.idle",
    );
    const updates = sessionFrames(events.frames, session.id).filter(
      (frame) => frame.type === "message.part.updated",
    );
    const toolStates = (callID: string) =>
      updates
        .filter((frame) => frame.properties.part?.callID === callID)
        .map((frame) => [
          frame.properties.part?.state?.status,
          frame.properties.part?.state?.title,
        ]);
    assert.deepEqual(toolStates("call_1"), [
      ["running", "bash"],
      ["running", "bash"],
      ["completed", "List workspace files"],
    ]);
    assert.deepEqual(toolStates("call_2"), [
      ["running", "read"],
      ["error", "read"],
    ]);
    assert.deepEqual(toolStates("call_3"), [
      ["running", "read"],
      ["completed", "large.txt"],
    ]);
    const finishes = updates
      .filter((frame) => frame.properties.part?.type === "step-finish")
      .map((frame) => frame.properties.messageID);
    assert.deepEqual(finishes, [first?.id, second?.id, final?.id]);
    for (const message of [first, second, final]) {
      const text = updates
        .filter(
          (frame) =>
            frame.properties.messageID === message?.id &&
            frame.properties.part?.type === "text",
        )
        .at(-1);
      assert.equal(text?.properties.part?.content, message?.content);
    }
    assert.deepEqual(lifecycle(events.frames, session.id), [
      "busy",
      "idle",
      "session.idle",
    ]);

    // A Run that ends right after a tool still ends with an assistant message.
    const other = await createSession(base, path.join(root, "tool-only"));
    assert.equal(
      (await prompt(base, other.id, "[fake:tool-only]")).status,
      204,
    );
    const closing = await messages(base, other.id);
    assert.deepEqual(
      closing.map((message) => [message.role, message.info?.finish]),
      [
        ["user", undefined],
        ["assistant", "tool-calls"],
        ["tool", undefined],
        ["assistant", "stop"],
      ],
    );
    assert.equal(closing.at(-1)?.content, "");
    assert.deepEqual(
      closing.at(-1)?.parts?.map((part) => part.type),
      ["step-finish"],
    );
    assert.equal(closing[2]?.content, "ok\n");
  },
);

void test(
  "competition prompts approve permissions and survive client disconnects",
  { timeout: 30_000 },
  async (t) => {
    const { base, root, follow, close } = await competitionHub(t);
    const session = await createSession(base, path.join(root, "permissions"));
    assert.equal(
      (await prompt(base, session.id, "[fake:permission] approved")).status,
      204,
    );
    const listed = await messages(base, session.id);
    assert.equal(listed.at(-1)?.content, "approved");
    assert.equal(listed.at(-1)?.info?.finish, "stop");
    const runId = listed[0]?.id.split(":")[0];
    const run = await call<{
      permissions: { decision?: string; status: string }[];
    }>(base, `/v1/runs/${runId}`);
    assert.deepEqual(
      run.value.permissions.map((permission) => permission.decision),
      ["fake-allow-once"],
    );

    // A disconnected prompt_async client does not cancel its Run.
    const client = new AbortController();
    const abandoned = prompt(
      base,
      session.id,
      "[fake:wait] keep",
      client.signal,
    );
    await waitFor(
      async () => (await sessionState(base, session.id)) === "busy",
      "busy session",
    );
    client.abort();
    await assert.rejects(abandoned);
    await delay(150);
    assert.equal(await sessionState(base, session.id), "busy");

    // A stream opened during a Run announces the busy Session; abort ends it idle.
    const events = await openEvents(base);
    follow(() => events.close());
    await events.until(
      (frames) => lifecycle(frames, session.id).includes("busy"),
      "busy snapshot",
    );
    assert.equal(events.frames[0]?.type, "server.connected");
    const aborted = await call<{ ok: boolean }>(
      base,
      `/session/${session.id}/abort`,
      { method: "POST", headers: jsonHeader },
    );
    assert.deepEqual(aborted.value, { ok: true });
    await events.until(
      (frames) => lifecycle(frames, session.id).includes("session.idle"),
      "idle after abort",
    );
    assert.deepEqual(lifecycle(events.frames, session.id), [
      "busy",
      "idle",
      "session.idle",
    ]);
    assert.equal(
      (await messages(base, session.id)).at(-1)?.info?.finish,
      "cancelled",
    );

    // Closing the Gateway ends open event streams instead of waiting for clients.
    await close();
    await events.until(() => events.ended(), "stream end on close");
  },
);
