import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHub } from "../../src/main.js";

async function json<T>(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; value: T }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    value: (await response.json()) as T,
  };
}

void test(
  "competition API projects directory sessions and blocking prompts",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harnesshub-competition-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "harnesshub-workspace-"));
    const hub = await startHub({
      dataDir: root,
      demo: true,
      competition: true,
      defaultEngine: "fake",
      cwd: root,
      port: 0,
    });
    t.after(async () => {
      await hub.server.close();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    });

    const created = await json<{
      id: string;
      title: string;
      status: string;
    }>(hub.url, "/session", "POST", {
      title: "contest",
      directory: workspace,
    });
    assert.equal(created.status, 200);
    assert.equal(created.value.title, "contest");
    assert.equal(created.value.status, "idle");

    const prompt = await fetch(
      `${hub.url}/session/${created.value.id}/prompt_async`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "hello competition" }],
          model: { providerID: "test", modelID: "echo" },
          agent: "assistant",
        }),
      },
    );
    assert.equal(prompt.status, 204);

    const messages = await json<
      {
        role: string;
        content: string;
        info?: { finish?: string };
        parts?: { type: string }[];
      }[]
    >(hub.url, `/session/${created.value.id}/message`);
    assert.equal(messages.status, 200);
    assert.equal(messages.value[0]?.role, "user");
    assert.equal(messages.value[0]?.content, "hello competition");
    assert.equal(messages.value.at(-1)?.role, "assistant");
    assert.equal(messages.value.at(-1)?.content, "hello competition");
    assert.equal(messages.value.at(-1)?.info?.finish, "stop");
    assert.ok(
      messages.value.at(-1)?.parts?.some((part) => part.type === "step-finish"),
    );

    const statuses = await json<Record<string, { type: string }>>(
      hub.url,
      "/session/status",
    );
    assert.equal(statuses.value[created.value.id]?.type, "idle");

    const removed = await json<{ ok: boolean }>(
      hub.url,
      `/session/${created.value.id}`,
      "DELETE",
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.value.ok, true);
  },
);

void test("competition API uses flat validation errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harnesshub-competition-error-"));
  const hub = await startHub({
    dataDir: root,
    demo: true,
    competition: true,
    defaultEngine: "fake",
    cwd: root,
    port: 0,
  });
  t.after(async () => {
    await hub.server.close();
    await rm(root, { recursive: true, force: true });
  });
  const invalid = await json<{ code: string; message: string }>(
    hub.url,
    "/session",
    "POST",
    {},
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.value.code, "VALIDATION_ERROR");
  assert.ok(invalid.value.message.length > 0);
});
