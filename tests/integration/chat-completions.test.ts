import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startHub } from "../../src/main.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";
import type { HubApplication } from "../../src/application/service.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";
import { writePrivateSecretFile } from "../fixtures/private-secret-file.js";

void test(
  "Chat bridges retain MCP, Skills, artifact permission and cancellation through HTTP, SQLite and real Workers",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "hh-chat-bridge-"));
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    const started = Promise.withResolvers<void>(),
      disconnected = Promise.withResolvers<void>();
    const requests: {
      path: string | undefined;
      key: boolean;
      skill: boolean;
      mcp: boolean;
      toolResult: boolean;
    }[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          model: string;
          messages: { role: string; content?: string }[];
        };
        const serialized = JSON.stringify(body);
        requests.push({
          path: request.url,
          key:
            request.headers.authorization ===
            "Bearer synthetic-bridge-integration-key",
          skill: serialized.includes("bridge skill instruction"),
          mcp: serialized.includes("MCP_COUNT=1"),
          toolResult: body.messages.some((message) => message.role === "tool"),
        });
        assert.equal(body.model, "fixture");
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (serialized.includes("CANCEL_BARRIER")) {
          response.once("close", () => disconnected.resolve());
          response.write(
            'data: {"choices":[{"index":0,"delta":{"content":"waiting"},"finish_reason":null}]}\n\n',
          );
          started.resolve();
          return;
        }
        const tool = body.messages.some((message) => message.role === "tool");
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool ? { content: "BRIDGE_TOOL_DONE" } : { tool_calls: [{ index: 0, id: "call_write", type: "function", function: { name: "fixture_write", arguments: '{"text":"精确产物"}' } }] }, finish_reason: tool ? "stop" : "tool_calls" }] })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      })().catch(() => {
        response.destroy();
      });
    });
    t.after(async () => {
      await hub?.server.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const key = join(root, "fixture.key"),
      skill = join(root, "SKILL.md");
    if (process.platform === "win32") await ensurePrivateDirectory(root);
    await writePrivateSecretFile(key, "synthetic-bridge-integration-key");
    await writeFile(skill, "bridge skill instruction");
    hub = await startHub({
      cwd: root,
      dataDir: join(root, "data"),
      demo: false,
      port: 0,
    });
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
    async function terminal(id: string) {
      let run = await json<ReturnType<HubApplication["getRun"]>>(
        `/v1/runs/${id}`,
      );
      const end = Date.now() + 12000;
      while (!run.finishedAt) {
        assert.ok(Date.now() < end, "Run did not settle");
        for (const permission of run.permissions.filter(
          (p) => p.status === "pending",
        ))
          await json(`/v1/permissions/${permission.id}/decision`, {
            optionId: "write-once",
          });
        await delay(10);
        run = await json<ReturnType<HubApplication["getRun"]>>(
          `/v1/runs/${id}`,
        );
      }
      return run;
    }
    for (const adapter of ["codex", "gemini"] as const) {
      await json("/v1/engines", {
        id: adapter,
        driver: "acp",
        command: [
          process.execPath,
          fileURLToPath(
            new URL("../fixtures/chat-bridge-peer.js", import.meta.url),
          ),
          adapter,
        ],
        model: "fixture",
        configuration: {
          adapter,
          provider: {
            protocol: "openai-completions",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: { kind: "file", value: key },
          },
          skills: [{ path: skill, enabled: true }],
          mcpServers: [
            {
              name: "files",
              type: "http",
              url: "http://127.0.0.1:1/mcp",
              enabled: true,
            },
          ],
        },
      });
      const check = await json<{ checks: { status: string }[] }>(
        `/v1/engines/${adapter}/test`,
        {},
      );
      assert.ok(
        check.checks.every((c) => c.status === "passed"),
        JSON.stringify(check),
      );
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: adapter,
      });
      for (let i = 0; i < 2; i++) {
        const accepted = await json<RunRecord>(
          `/v1/sessions/${session.id}/runs`,
          {
            text: "Use tools",
            timeoutMs: 10000,
            outputs: [
              {
                path: `${adapter}-proof.txt`,
                name: "proof",
                mediaType: "text/plain",
              },
            ],
          },
        );
        const run = await terminal(accepted.id);
        assert.equal(run.status, "completed", JSON.stringify(run.error));
        assert.equal(run.output, "BRIDGE_TOOL_DONE");
        assert.equal(run.cleanupStatus, "confirmed");
        assert.equal(run.permissions[0]?.status, "applied");
        assert.equal(run.artifacts.length, 1);
        const artifact: { bytes: Buffer } = await hub.app.artifact(
          run.artifacts[0]!.id,
        );
        assert.equal(artifact.bytes.toString(), "精确产物");
      }
      if (adapter === "codex") {
        const accepted = await json<RunRecord>(
          `/v1/sessions/${session.id}/runs`,
          { text: "CANCEL_BARRIER", timeoutMs: 10000 },
        );
        await started.promise;
        await json(`/v1/runs/${accepted.id}/cancel`, {});
        const result = await terminal(accepted.id);
        assert.equal(result.status, "cancelled");
        assert.equal(result.cleanupStatus, "confirmed");
        await disconnected.promise;
      }
      await json(`/v1/sessions/${session.id}/close`, {});
    }
    assert.equal(requests.length, 9);
    assert.ok(
      requests.every(
        (request) =>
          request.path === "/v1/chat/completions" &&
          request.key &&
          request.skill &&
          request.mcp,
      ),
    );
    assert.equal(requests.filter((request) => request.toolResult).length, 4);
    for (const file of (await readdir(root)).filter((file) =>
      /^peer-\d+\.json$/.test(file),
    )) {
      const record = JSON.parse(await readFile(join(root, file), "utf8")) as {
        url: string;
        pid: number;
      };
      await assert.rejects(fetch(record.url));
      assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    }
    const db = await readFile(join(root, "data", "harnesshub.sqlite"));
    assert.equal(
      db.includes(Buffer.from("synthetic-bridge-integration-key")),
      false,
    );
  },
);
