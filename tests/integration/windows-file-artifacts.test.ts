import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { startHub } from "../../src/main.js";
import type {
  ArtifactRecord,
  RunRecord,
  SessionRecord,
} from "../../src/domain/types.js";
import {
  verifyPrivateDirectory,
  verifyPrivateFile,
} from "../../src/platform/windows-acl.js";

type RunView = RunRecord & { artifacts: ArtifactRecord[] };

void test(
  "Windows Gateway files: Chinese/space paths, DACL, immutable bytes, SQLite reopen, junction rejection",
  { skip: process.platform !== "win32", timeout: 40_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "harnesshub-windows-files-"),
    );
    const workspace = path.join(directory, "中文 工作目录");
    const dataDir = path.join(directory, "应用 数据");
    await mkdir(workspace);
    await mkdir(path.join(workspace, "文件 结果"));
    const source = path.join(workspace, "文件 结果", "输出.bin");
    const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
    await writeFile(source, bytes);
    let hub: Awaited<ReturnType<typeof startHub>> | undefined;
    t.after(async () => {
      await hub?.server.close();
      await rm(directory, { recursive: true, force: true });
    });
    hub = await startHub({ dataDir, demo: true, cwd: workspace, port: 0 });
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${hub!.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { response, value: (await response.json()) as unknown };
    };
    const created = await post("/v1/sessions", {});
    assert.equal(created.response.status, 201);
    const session = created.value as SessionRecord;
    const submitted = await post(`/v1/sessions/${session.id}/runs`, {
      text: "snapshot",
      timeoutMs: 10_000,
      outputs: [{ path: "文件 结果/输出.bin", name: "输出.bin" }],
    });
    assert.equal(submitted.response.status, 202);
    const id = (submitted.value as RunRecord).id;
    async function finished(runId: string): Promise<RunView> {
      const until = Date.now() + 15_000;
      for (;;) {
        const response = await fetch(`${hub!.url}/v1/runs/${runId}`);
        const result = (await response.json()) as RunView;
        if (
          [
            "completed",
            "failed",
            "timed_out",
            "interrupted",
            "cancelled",
          ].includes(result.status)
        )
          return result;
        assert.ok(
          Date.now() < until,
          `Run did not finish: ${JSON.stringify(result)}`,
        );
        await delay(10);
      }
    }
    const result = await finished(id);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.artifacts.length, 1);
    const artifact = (await hub.app.artifact(result.artifacts[0]!.id)).record;
    await verifyPrivateDirectory(path.dirname(artifact.path));
    await verifyPrivateFile(artifact.path);
    await verifyPrivateFile(artifact.path.replaceAll("\\", "/"));
    await writeFile(source, "changed source");
    const first = await fetch(`${hub.url}/v1/artifacts/${artifact.id}`);
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
    await hub.server.close();
    hub = await startHub({ dataDir, demo: true, cwd: workspace, port: 0 });
    const reopened = await fetch(`${hub.url}/v1/artifacts/${artifact.id}`);
    assert.equal(reopened.status, 200);
    assert.deepEqual(Buffer.from(await reopened.arrayBuffer()), bytes);
    for (const invalid of [
      "C:/secret.txt",
      "C:secret.txt",
      "//server/share/secret",
      "output.txt:stream",
      "LPT¹.txt",
      "../secret.txt",
    ]) {
      assert.equal(
        (
          await post(`/v1/sessions/${session.id}/runs`, {
            text: "invalid",
            outputs: [{ path: invalid, name: "result" }],
          })
        ).response.status,
        400,
      );
    }
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(outside, path.join(workspace, "junction"), "junction");
    const linked = await post(`/v1/sessions/${session.id}/runs`, {
      text: "junction",
      timeoutMs: 10_000,
      outputs: [{ path: "junction/secret.txt", name: "secret.txt" }],
    });
    assert.equal(linked.response.status, 202);
    const rejected = await finished((linked.value as RunRecord).id);
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.error?.code, "INVALID_ARTIFACT_PATH");
    assert.equal(
      await readFile(path.join(outside, "secret.txt"), "utf8"),
      "outside",
    );
    await promisify(execFile)(
      path.join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [artifact.path, "/grant", "*S-1-1-0:R"],
      { windowsHide: true },
    );
    const publicFile = await fetch(`${hub.url}/v1/artifacts/${artifact.id}`);
    assert.equal(publicFile.status, 403);
    assert.equal(
      ((await publicFile.json()) as { error: { code: string } }).error.code,
      "INVALID_PRIVATE_PATH",
    );
  },
);
