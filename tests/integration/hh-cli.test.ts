// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ModelCallEntry,
  ModelCallId,
  ModelRef,
  ProviderId,
} from "@harnesshub/core/model-plane";
import { startHub } from "@harnesshub/daemon/main";
import { SqliteModelPlaneStore } from "@harnesshub/store/storage/model-plane-store";
import { HH_ENTRY } from "../support/entries.js";
import { temporaryDirectory } from "../support/temporary.js";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real `hh` launcher with piped stdin (so never interactive). */
function hh(
  cwd: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

void test(
  "hh manages providers, credentials, keys and groups and reports usage through the daemon",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(t, "harnesshub-cli-");
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
    });
    let running = true;
    defer(() => (running ? hub.server.close() : undefined));
    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const run = (args: string[], options?: Parameters<typeof hh>[2]) =>
      hh(directory, [...args, ...daemon], options);
    const canary = `sk-synthetic-cli-${Date.now()}`;
    const outputs: string[] = [];
    const ok = async (args: string[], options?: Parameters<typeof hh>[2]) => {
      const outcome = await run(args, options);
      outputs.push(outcome.stdout, outcome.stderr);
      assert.equal(outcome.code, 0, `${args.join(" ")}: ${outcome.stderr}`);
      return outcome;
    };
    const fails = async (
      args: string[],
      code: number,
      options?: Parameters<typeof hh>[2],
    ) => {
      const outcome = await run(args, options);
      outputs.push(outcome.stdout, outcome.stderr);
      assert.equal(outcome.code, code, `${args.join(" ")}: ${outcome.stderr}`);
      return outcome;
    };

    const status = JSON.parse((await ok(["status", "--json"])).stdout) as {
      daemon: { apiVersion: string; secretBackend: string };
      providers: number;
    };
    assert.equal(status.daemon.apiVersion, "v1");
    assert.equal(status.daemon.secretBackend, "file");
    assert.equal(status.providers, 0);
    assert.match((await ok(["status"])).stdout, /Daemon: +running, pid \d+/);

    assert.equal(
      (
        await ok([
          "provider",
          "add",
          "alpha",
          "--chat",
          "https://api.example.test/v1",
          "--name",
          "Alpha",
          "--model",
          "chat-1",
          "--model",
          "chat-2",
        ])
      ).stdout,
      "Added provider alpha\n",
    );
    const invalid = await fails(
      [
        "provider",
        "add",
        "beta",
        "--chat",
        "https://api.example.test/v1/chat/completions",
      ],
      2,
    );
    assert.match(invalid.stderr, /PROVIDER_INVALID/);
    assert.match(invalid.stderr, /\/endpoints\/chat: must be the base URL/);
    await fails(["provider", "add", "beta"], 2);
    const list = (await ok(["provider", "list"])).stdout;
    assert.match(list, /^ID +NAME +KIND +ENDPOINTS +CREDENTIALS +MODELS\n/);
    assert.match(list, /\nalpha +Alpha +custom +chat +0 +2\n/);
    await fails(["provider", "show", "missing"], 2);

    // Secrets come from stdin or the environment, never from argv or a prompt here.
    const added = await ok(
      ["credential", "add", "alpha", "--name", "main", "--from-stdin"],
      { input: `${canary}\n` },
    );
    assert.match(
      added.stdout,
      /^Added credential key-1 to alpha \(store:[0-9a-f-]{36}\)\n$/,
    );
    await ok(
      [
        "credential",
        "rotate",
        "alpha",
        "key-1",
        "--from-env",
        "HH_TEST_SECRET",
      ],
      {
        env: { HH_TEST_SECRET: `${canary}-rotated` },
      },
    );
    const secretFile = path.join(directory, "secret.txt");
    await writeFile(secretFile, `${canary}-file\n`, { mode: 0o600 });
    await ok([
      "credential",
      "add",
      "alpha",
      "--id",
      "backup",
      "--from-file",
      secretFile,
    ]);
    const noSource = await fails(["credential", "add", "alpha"], 2);
    assert.match(noSource.stderr, /--from-stdin/);
    await fails(
      ["credential", "add", "alpha", "--from-stdin", "--from-env", "X"],
      2,
    );
    const shown = (await ok(["provider", "show", "alpha"])).stdout;
    assert.match(shown, /key-1 +main +store:[0-9a-f-]{36} +all +yes/);
    // Removal needs confirmation; without a terminal it stops with 4 and changes nothing.
    await fails(["credential", "remove", "alpha", "backup"], 4);
    await ok(["credential", "remove", "alpha", "backup", "--yes"]);
    assert.doesNotMatch(
      (await ok(["credential", "list", "alpha"])).stdout,
      /backup/,
    );

    const created = await ok([
      "key",
      "create",
      "--name",
      "ci",
      "--allow",
      "alpha/*",
    ]);
    const keyText = created.stdout.trim();
    const keyMatch = /^hhk_c_([a-z2-7]{12})_[A-Za-z0-9_-]{43}$/.exec(keyText);
    assert.ok(keyMatch, created.stdout);
    assert.match(created.stderr, /not shown again/);
    const keys = (await ok(["key", "list", "--json"])).stdout;
    assert.equal(keys.includes(keyText), false);
    assert.equal(
      (JSON.parse(keys) as { items: Array<{ keyId: string }> }).items[0]?.keyId,
      keyMatch[1],
    );
    await fails(["key", "create", "--name", "ci"], 2);

    assert.equal(
      (
        await ok([
          "group",
          "add",
          "fast",
          "--member",
          "alpha/chat-1",
          "--strategy",
          "latency",
        ])
      ).stdout,
      "Added group/fast\n",
    );
    assert.match(
      (await ok(["group", "list"])).stdout,
      /group\/fast +latency +auto +alpha\/chat-1/,
    );
    // The provider is in use: a conflict exits with 5 and names the user.
    const inUse = await fails(["provider", "remove", "alpha", "--yes"], 5);
    assert.match(inUse.stderr, /PROVIDER_IN_USE/);
    assert.match(inUse.stderr, /used by route-group fast/);
    const problem = JSON.parse(
      (await fails(["provider", "remove", "alpha", "--yes", "--json"], 5))
        .stdout,
    ) as { code: string; status: number };
    assert.equal(problem.code, "PROVIDER_IN_USE");
    assert.equal(problem.status, 409);

    // Usage over ledger rows seeded through the store of the running daemon.
    const plane = new SqliteModelPlaneStore(
      path.join(dataDir, "harnesshub.sqlite"),
    );
    try {
      const base: ModelCallEntry = {
        callId: "call-1" as ModelCallId,
        occurredAt: new Date().toISOString(),
        inbound: {
          protocol: "chat",
          path: "/v1/chat/completions",
          stream: true,
        },
        modelRef: "alpha/chat-1" as ModelRef,
        provider: "alpha" as ProviderId,
        patches: [],
        unmapped: [],
        status: 200,
        usage: {
          input: 120,
          cacheRead: 30,
          cacheWrite: 0,
          output: 40,
          reasoning: 8,
          source: "reported",
        },
        timing: { durationMs: 900 },
        attempts: [],
        cost: { amountUsd: 0.25, priceSource: "user" },
      };
      await plane.appendModelCall(base);
      await plane.appendModelCall({
        ...base,
        callId: "call-2" as ModelCallId,
        status: 429,
        cost: null,
      });
    } finally {
      plane.close();
    }
    const usage = (await ok(["usage", "--by", "provider", "--since", "1d"]))
      .stdout;
    assert.match(
      usage,
      /^PROVIDER +CALLS +FAILED +INPUT +CACHE READ +CACHE WRITE +OUTPUT +REASONING +COST USD +UNPRICED\n/,
    );
    assert.match(usage, /\nalpha +2 +1 +240 +60 +0 +80 +16 +0\.25 +1\n/);
    const byModel = JSON.parse((await ok(["usage", "--json"])).stdout) as {
      groupBy: string;
      items: Array<{ key: string; calls: number }>;
    };
    assert.equal(byModel.groupBy, "model");
    assert.deepEqual(
      byModel.items.map((item) => [item.key, item.calls]),
      [["alpha/chat-1", 2]],
    );
    assert.equal(
      (await ok(["usage", "--by", "day", "--from", "2030-01-01T00:00:00Z"]))
        .stdout,
      "(none)\n",
    );
    await fails(["usage", "--by", "week"], 2);
    await fails(["usage", "--since", "soon"], 2);

    await fails(["key", "revoke", keyMatch[1]!], 4);
    assert.match(
      (await ok(["key", "revoke", keyMatch[1]!, "--yes"])).stdout,
      /^Revoked key /,
    );
    assert.match((await ok(["key", "list"])).stdout, / revoked\n/);
    await ok(["group", "remove", "fast", "--yes"]);
    await ok(["provider", "remove", "alpha", "--yes"]);
    assert.equal((await ok(["provider", "list"])).stdout, "(none)\n");

    // Failures map to the exit codes of 06 section 5.
    await fails(["provider", "list", "--frobnicate"], 2);
    await fails(["provider", "explode"], 2);
    const elsewhere = path.join(directory, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    const noToken = await hh(directory, [
      "status",
      "--url",
      hub.url,
      "--data-dir",
      elsewhere,
    ]);
    assert.equal(noToken.code, 3, noToken.stderr);
    assert.match(noToken.stderr, /admin\.token/);
    await writeFile(
      path.join(elsewhere, "admin.token"),
      `${"A".repeat(43)}\n`,
      { mode: 0o600 },
    );
    const wrongToken = await hh(directory, [
      "status",
      "--url",
      hub.url,
      "--data-dir",
      elsewhere,
    ]);
    assert.equal(wrongToken.code, 6, wrongToken.stderr);
    assert.match(wrongToken.stderr, /ADMIN_TOKEN_INVALID/);
    const down = await hh(directory, [
      "status",
      "--url",
      "http://127.0.0.1:9",
      "--data-dir",
      dataDir,
    ]);
    assert.equal(down.code, 3, down.stderr);
    assert.match(down.stderr, /not reachable/);

    // No command printed a secret, and the daemon log holds none.
    running = false;
    await hub.server.close();
    const log = await readFile(hub.logFile, "utf8");
    for (const text of [...outputs, log])
      assert.equal(text.includes(canary), false);
  },
);

void test(
  "hh lists presets, adds a provider from one with a key from stdin and refreshes its models",
  { timeout: 120_000 },
  async (t) => {
    const { directory, defer } = await temporaryDirectory(
      t,
      "harnesshub-cli-presets-",
    );
    const dataDir = path.join(directory, "data");
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
    });
    defer(() => hub.server.close());
    const key = `sk-synthetic-cli-preset-${Date.now()}`;
    const { createServer } = await import("node:http");
    const upstream = createServer((request, response) => {
      const ok = request.headers.authorization === `Bearer ${key}`;
      response.writeHead(ok ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(
        ok
          ? '{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}'
          : "{}",
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    defer(
      () => new Promise<void>((resolve) => upstream.close(() => resolve())),
    );
    const base = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const run = (args: string[], input?: string) =>
      hh(directory, [...args, ...daemon], input === undefined ? {} : { input });

    const presets = await run(["provider", "presets"]);
    assert.equal(presets.code, 0, presets.stderr);
    assert.match(
      presets.stdout,
      /^PRESET +NAME +KIND +ENDPOINTS +KEY +VERIFIED\n/,
    );
    assert.match(
      presets.stdout,
      /\ndeepseek +DeepSeek +vendor +chat,anthropic +required +/,
    );
    assert.match(presets.stdout, /\nollama +Ollama +local +chat +none +/);

    const added = await run(
      [
        "provider",
        "add",
        "--preset",
        "deepseek",
        "--chat",
        base,
        "--credential-from-stdin",
      ],
      `${key}\n`,
    );
    assert.equal(added.code, 0, added.stderr);
    assert.equal(
      added.stdout,
      "Added provider deepseek from preset deepseek with a stored credential\n",
    );
    const refreshed = await run([
      "provider",
      "models",
      "deepseek",
      "--refresh",
    ]);
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.match(refreshed.stdout, /^Source: live, refreshed /);
    assert.match(refreshed.stdout, /\ndeepseek\/deepseek-chat +- +yes\n/);
    assert.match(refreshed.stdout, /\ndeepseek\/deepseek-reasoner +- +yes\n/);
    const shown = await run(["provider", "models", "deepseek", "--json"]);
    assert.equal(
      (JSON.parse(shown.stdout) as { list: unknown[] }).list.length,
      2,
    );

    // A failed refresh keeps the list, reports stale and exits with 1 (502).
    await run(
      [
        "provider",
        "add",
        "--preset",
        "deepseek",
        "team",
        "--chat",
        base,
        "--credential-from-stdin",
      ],
      "sk-synthetic-wrong\n",
    );
    const failed = await run(["provider", "models", "team", "--refresh"]);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /MODELS_REFRESH_FAILED/);
    assert.match(failed.stderr, /answered HTTP 401/);
    assert.match(
      (await run(["provider", "models", "team"])).stdout,
      /\(stale: the last refresh failed\)/,
    );
    const unknown = await run(["provider", "add", "--preset", "nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /PRESET_NOT_FOUND/);
    for (const outcome of [presets, added, refreshed, shown, failed])
      assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(key), false);
  },
);
