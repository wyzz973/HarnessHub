import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { EngineCandidate } from "../../src/domain/engines.js";
import type { RunRecord, SessionRecord } from "../../src/domain/types.js";
import { isTerminal } from "../../src/domain/types.js";

void test(
  "compiled Gateway discovers recipes and runs them through real registration, SQLite and ACP/CLI Workers",
  {
    timeout: 45_000,
    skip:
      process.platform === "win32"
        ? "POSIX executable fixtures; Windows requires native validation"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hh-discovery-flow-"),
    );
    let stopGateway: (() => Promise<void>) | undefined;
    t.after(async () => {
      await stopGateway?.();
      await rm(directory, { recursive: true, force: true });
    });
    const home = path.join(directory, "home");
    const bin = path.join(home, ".local/bin");
    const dataDir = path.join(directory, "data");
    await mkdir(bin, { recursive: true });
    const peer = new URL("../fixtures/acp-recovery-peer.js", import.meta.url);
    // Independent protocol expectations from the documented CLI contracts.
    const acpRecipes = [
      ["hermes", "hermes", ["acp"]],
      ["mimo", "mimo", ["acp"]],
      ["gemini", "gemini", ["--acp"]],
      ["copilot", "copilot", ["--acp"]],
      ["kimi", "kimi", ["acp"]],
      ["qwen", "qwen", ["--acp"]],
      ["kiro", "kiro-cli", ["acp"]],
      ["qoder", "qodercli", ["--acp"]],
    ] as const;
    const executable = async (name: string, body: string) => {
      const location = path.join(bin, name);
      await writeFile(location, `#!${process.execPath}\n${body}\n`);
      await chmod(location, 0o700);
    };
    for (const [id, binary, args] of acpRecipes) {
      const state = path.join(directory, id);
      await mkdir(state);
      await executable(
        binary,
        `require('node:assert/strict').deepEqual(process.argv.slice(2), ${JSON.stringify(args)}); process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(peer))}, ${JSON.stringify(state)}]; import(${JSON.stringify(peer.href)});`,
      );
    }
    await executable(
      "cursor-agent",
      "require('node:assert/strict').deepEqual(process.argv.slice(2), ['--print', '--output-format', 'text']); process.stdin.pipe(process.stdout);",
    );
    await executable(
      "agy",
      "require('node:assert/strict').equal(process.argv[2], '-p'); process.stdout.write(process.argv[3]);",
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../../src/main.js", import.meta.url)),
        "--port",
        "0",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: directory,
        env: { HOME: home, PATH: bin },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const closed = once(child, "close");
    stopGateway = async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(kill);
      }
    };
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Gateway readiness timeout: ${stderr}`)),
        8000,
      );
      let stdout = "";
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(stderr));
      });
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        const line = stdout.split("\n").find((value) => value.startsWith("{"));
        if (line) {
          clearTimeout(timeout);
          resolve((JSON.parse(line) as { url: string }).url);
        }
      });
    });
    async function json<T>(route: string, body?: unknown): Promise<T> {
      const response = await fetch(
        `${url}${route}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      assert.ok(
        response.ok,
        `${route}: ${await (response.ok ? Promise.resolve("") : response.text())}`,
      );
      return (await response.json()) as T;
    }
    const { candidates } = await json<{ candidates: EngineCandidate[] }>(
      "/v1/engines/discover",
    );
    for (const id of [
      ...acpRecipes.map(([id]) => id),
      "cursor",
      "antigravity",
    ]) {
      const candidate = candidates.find((item) => item.id === id);
      assert.ok(candidate?.registration, `missing recipe: ${id}`);
      await json("/v1/engines", candidate.registration);
      const session = await json<SessionRecord>("/v1/sessions", {
        engineId: id,
      });
      const cli = candidate.registration.driver === "cli";
      const run = await json<RunRecord>(`/v1/sessions/${session.id}/runs`, {
        text: cli ? "中文 prompt $literal" : "remember:中文",
        timeoutMs: 8000,
      });
      let result = run;
      const deadline = Date.now() + 10_000;
      while (!isTerminal(result.status)) {
        assert.ok(Date.now() < deadline, `run timeout for ${id}`);
        await delay(20);
        result = await json<RunRecord>(`/v1/runs/${run.id}`);
      }
      assert.equal(result.status, "completed", JSON.stringify(result.error));
      assert.equal(result.output, cli ? "中文 prompt $literal" : "stored");
      await json(`/v1/sessions/${session.id}/close`, {});
    }
    await rm(path.join(bin, "mimo"));
    const rescanned = await json<{ candidates: EngineCandidate[] }>(
      "/v1/engines/discover",
    );
    assert.equal(
      rescanned.candidates.some((item) => item.id === "mimo"),
      false,
    );
    assert.deepEqual(await readdir(path.join(dataDir, "workers")), []);
  },
);
