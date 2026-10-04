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
    const human = (await ok(["status"])).stdout;
    assert.match(human, /Daemon: +running, pid \d+/);
    assert.match(human, /Model gateway: http:\/\/127\.0\.0\.1:\d+\/v1\n/);
    assert.match(
      human,
      /Point your OpenAI client at http:\/\/127\.0\.0\.1:\d+\/v1 \(Anthropic: http:\/\/127\.0\.0\.1:\d+\) with a key from hh key create\./,
    );

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

    // Keys for the LAN listener, and sharing it.
    const lanCreated = await ok([
      "key",
      "create",
      "--name",
      "laptop",
      "--allow",
      "alpha/*",
      "--lan",
    ]);
    assert.match(lanCreated.stdout, /^hhk_c_[a-z2-7]{12}_/);
    await fails(
      [
        "key",
        "create",
        "--name",
        "forever",
        "--allow",
        "alpha/*",
        "--lan",
        "--no-expiry",
      ],
      2,
    );
    const keyList = (await ok(["key", "list"])).stdout;
    assert.match(
      keyList,
      /^KEY ID +NAME +SCOPE +ALLOW +EXPIRES +LAN +STATUS\n/,
    );
    assert.match(
      keyList,
      /\n[a-z2-7]{12} +laptop +client +alpha\/\* +.+ +yes +active\n/,
    );
    assert.match(
      keyList,
      /\n[a-z2-7]{12} +ci +client +alpha\/\* +.+ +- +active\n/,
    );
    assert.match(
      (await ok(["gateway", "share", "status"])).stdout,
      /^LAN sharing: +off\n/,
    );
    const noHost = await fails(["gateway", "share", "on"], 2);
    assert.match(noHost.stderr, /needs --host/);
    await fails(["gateway", "share", "status", "--host", "127.0.0.1"], 2);
    await fails(["gateway", "share", "explode"], 2);
    await fails(["gateway", "open"], 2);
    const badHost = await fails(
      ["gateway", "share", "on", "--host", "my-laptop"],
      2,
    );
    assert.match(badHost.stderr, /GATEWAY_SHARE_INVALID/);
    assert.match(badHost.stderr, /\/lan\/host/);
    const on = JSON.parse(
      (
        await ok([
          "gateway",
          "share",
          "on",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--name",
          "hh.lan",
          "--json",
        ])
      ).stdout,
    ) as { listening: boolean; boundPort: number; urls: string[] };
    assert.equal(on.listening, true);
    assert.deepEqual(on.urls, [
      `http://127.0.0.1:${on.boundPort}`,
      `http://hh.lan:${on.boundPort}`,
    ]);
    const shared = (await ok(["gateway", "share", "status"])).stdout;
    assert.match(shared, /^LAN sharing: +on\n/);
    assert.match(
      shared,
      /\nPeers use http:\/\/127\.0\.0\.1:\d+ or http:\/\/hh\.lan:\d+ with a key from hh key create --lan\n/,
    );
    const off = (await ok(["gateway", "share", "off"])).stdout;
    assert.match(off, /^LAN sharing: +off\n/);
    assert.match(off, /\nAddress: +127\.0\.0\.1 port 0\n/);
    assert.match(off, /\nNames: +hh\.lan\n/);
    const laptopId = /^hhk_c_([a-z2-7]{12})_/.exec(lanCreated.stdout)![1]!;
    await ok(["key", "revoke", laptopId, "--yes"]);

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
    const key = `sk-synthetic-cli-preset-${Date.now()}`;
    const { createServer } = await import("node:http");
    const upstream = createServer((request, response) => {
      // A models.dev stand-in for hh catalog refresh.
      if (request.url === "/catalog/api.json") {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(
          JSON.stringify({
            deepseek: {
              id: "deepseek",
              name: "DeepSeek",
              models: { "deepseek-chat": { limit: { context: 64000 } } },
            },
          }),
        );
      }
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
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const base = `${origin}/v1`;
    const hub = await startHub({
      dataDir,
      configDir: path.join(directory, "config"),
      secretsBackend: "file",
      demo: true,
      cwd: directory,
      port: 0,
      host: "127.0.0.1",
      catalog: { url: `${origin}/catalog/api.json` },
    });
    defer(() => hub.server.close());
    const daemon = ["--url", hub.url, "--data-dir", dataDir];
    const run = (args: string[], input?: string) =>
      hh(directory, [...args, ...daemon], input === undefined ? {} : { input });

    const presets = await run(["provider", "presets"]);
    assert.equal(presets.code, 0, presets.stderr);
    // Grouped like `magpie presets`: vendors, relays, local servers.
    assert.match(
      presets.stdout,
      /^Vendors \(\d+\)\nPRESET +NAME +ENDPOINTS +REGIONS +PLANS +KEY +VERIFIED\n/,
    );
    assert.match(presets.stdout, /\n\nRelays \(\d+\)\nPRESET /);
    assert.match(presets.stdout, /\n\nLocal \(3\)\nPRESET /);
    assert.match(
      presets.stdout,
      /\ndeepseek +DeepSeek +chat,responses,anthropic +- +- +required +2026-10-02\n/,
    );
    assert.match(
      presets.stdout,
      /\nmoonshot +Moonshot AI \(Kimi\) +chat,responses,anthropic +cn,global +- +required +2026-10-02\n/,
    );
    assert.match(
      presets.stdout,
      /\nzhipu +.+ +- +api,coding +required +2026-10-02\n/,
    );
    assert.match(
      presets.stdout,
      /\nazure +Azure OpenAI +.+ \+base URL +unverified\n/,
    );
    assert.match(
      presets.stdout,
      /\nollama +Ollama +chat,responses,anthropic +- +- +none +2026-10-02\n/,
    );

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
    // A region; a region that the preset lacks is a usage error.
    const regional = await run([
      "provider",
      "add",
      "kimi",
      "--preset",
      "moonshot",
      "--region",
      "global",
    ]);
    assert.equal(regional.code, 0, regional.stderr);
    assert.equal(
      regional.stdout,
      "Added provider kimi from preset moonshot, region global\n",
    );
    assert.match(
      (await run(["provider", "show", "kimi"])).stdout,
      /\nPreset: +moonshot, region global\n(.|\n)*Endpoint: chat https:\/\/api\.moonshot\.ai\/v1\n/,
    );
    const mars = await run([
      "provider",
      "add",
      "x",
      "--preset",
      "moonshot",
      "--region",
      "mars",
    ]);
    assert.equal(mars.code, 2);
    assert.match(mars.stderr, /PRESET_REGION_NOT_FOUND/);
    // --base moves the chosen plan's endpoints.
    const planned = await run([
      "provider",
      "add",
      "ark",
      "--preset",
      "volcengine",
      "--plan",
      "api",
      "--base",
      "http://10.0.0.2:8080",
      "--json",
    ]);
    assert.equal(planned.code, 0, planned.stderr);
    assert.deepEqual(
      (JSON.parse(planned.stdout) as { endpoints: object }).endpoints,
      {
        chat: "http://10.0.0.2:8080/api/v3",
        responses: "http://10.0.0.2:8080/api/v3",
      },
    );

    // An import link: previewed, refused without a terminal or --yes, then added.
    const link = `harnesshub://import?preset=openai&models=gpt-6-sol&key=${key}`;
    const unconfirmed = await run(["import", link]);
    assert.equal(unconfirmed.code, 4, unconfirmed.stderr);
    assert.match(unconfirmed.stdout, /^Add: openai \(OpenAI\)\n/);
    assert.match(unconfirmed.stdout, /\n {2}Sends to: +api\.openai\.com\n/);
    assert.match(unconfirmed.stdout, /\n {2}Models: +gpt-6-sol\n/);
    assert.match(
      unconfirmed.stdout,
      new RegExp(`\\n {2}Key: +from the link \\(…${key.slice(-4)}\\)`),
    );
    assert.match(unconfirmed.stderr, /pass --yes/);
    assert.equal((await run(["provider", "show", "openai"])).code, 2);
    const imported = await run(["import", "-", "--yes"], `${link}\n`);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(
      imported.stdout,
      /\nAdded provider openai with a stored credential\n$/,
    );
    const repeated = await run(["import", link, "--yes"]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, /^Exists: openai \(OpenAI\) — A provider/);
    assert.match(repeated.stdout, /\nNothing to add\.\n$/);
    const badLink = await run([
      "import",
      "harnesshub://import?preset=openai&x=1",
    ]);
    assert.equal(badLink.code, 2);
    assert.match(badLink.stderr, /IMPORT_LINK_INVALID/);
    // This daemon reads no home, so other apps cannot be imported.
    const noHome = await run(["import", "--from", "codex"]);
    assert.equal(noHome.code, 5);
    assert.match(noHome.stderr, /IMPORT_SOURCE_UNAVAILABLE/);
    assert.equal((await run(["import"])).code, 2);
    assert.equal((await run(["import", link, "--from", "codex"])).code, 2);

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

    // Model metadata: values with their sources, and overrides set by key.
    const unknownModel = await run(["model", "show", "deepseek/deepseek-chat"]);
    assert.equal(unknownModel.code, 0, unknownModel.stderr);
    assert.match(unknownModel.stdout, /^Model: +deepseek\/deepseek-chat\n/);
    assert.match(unknownModel.stdout, /\nKEY +VALUE +SOURCE +SINCE\n/);
    assert.match(unknownModel.stdout, /\ncontext +unknown +- +-\n/);
    const set = await run([
      "model",
      "set",
      "deepseek/deepseek-chat",
      "context=64000",
      "price.input=0.27",
      "price.output=1.1",
    ]);
    assert.equal(set.code, 0, set.stderr);
    assert.equal(
      set.stdout,
      "Override deepseek/deepseek-chat: context=64000 price.input=0.27 price.output=1.1\n",
    );
    const merged = await run([
      "model",
      "set",
      "deepseek/deepseek-chat",
      "price.output=",
      "reasoning=yes",
    ]);
    assert.equal(
      merged.stdout,
      "Override deepseek/deepseek-chat: context=64000 reasoning=yes price.input=0.27\n",
    );
    const overridden = await run(["model", "show", "deepseek/deepseek-chat"]);
    assert.match(overridden.stdout, /\ncontext +64000 +override +\S/);
    assert.match(overridden.stdout, /\nprice\.output +unknown +- +-\n/);
    assert.match(
      overridden.stdout,
      /\n\nOverride deepseek\/deepseek-chat: context=64000 reasoning=yes price\.input=0\.27\n$/,
    );
    assert.equal(
      (await run(["model", "set", "deepseek/*", "output=4096"])).code,
      0,
    );
    assert.match(
      (await run(["model", "show", "deepseek/*"])).stdout,
      /^Override: +deepseek\/\*\nValues: +output=4096\n/,
    );
    const reasoner = JSON.parse(
      (await run(["model", "show", "deepseek/deepseek-reasoner", "--json"]))
        .stdout,
    ) as { fields: Record<string, { value: unknown; source: string }> };
    assert.deepEqual(reasoner.fields.maxOutputTokens?.value, 4096);
    assert.equal(reasoner.fields.maxOutputTokens?.source, "override-provider");
    const badValue = await run([
      "model",
      "set",
      "deepseek/deepseek-chat",
      "context=0",
    ]);
    assert.equal(badValue.code, 2);
    assert.match(badValue.stderr, /context must be a positive whole number/);
    assert.equal(
      (await run(["model", "set", "deepseek/deepseek-chat", "window=1"])).code,
      2,
    );
    assert.equal(
      (await run(["model", "unset", "deepseek/*"])).stdout,
      "Removed the override of deepseek/*.\n",
    );
    const missing = await run(["model", "unset", "deepseek/*"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /MODEL_OVERRIDE_NOT_FOUND/);
    assert.equal(
      (
        await run([
          "model",
          "set",
          "deepseek/deepseek-chat",
          "context=",
          "reasoning=",
          "price.input=",
        ])
      ).stdout,
      "Removed the override of deepseek/deepseek-chat.\n",
    );
    const catalog = await run(["catalog", "status"]);
    assert.equal(catalog.code, 0, catalog.stderr);
    assert.match(
      catalog.stdout,
      /^Catalog: +bundled snapshot of models\.dev, \d+ providers, \d+ models\n/,
    );
    assert.match(catalog.stdout, /\nCommit: +[0-9a-f]{40}\n/);
    assert.match(catalog.stdout, /\nLicense: +MIT/);
    assert.match(
      catalog.stdout,
      /\nRefresh: +off \(HH_OFFLINE=1\); hh catalog refresh fetches http:\/\/127\.0\.0\.1:\d+\/catalog\/api\.json\n/,
    );
    assert.match(catalog.stdout, /\nLast: +never\n/);
    const refreshedCatalog = await run(["catalog", "refresh"]);
    assert.equal(refreshedCatalog.code, 0, refreshedCatalog.stderr);
    assert.match(
      refreshedCatalog.stdout,
      /^Catalog: +refreshed copy of models\.dev, 1 providers, 1 models\n/,
    );
    assert.match(refreshedCatalog.stdout, /\nCommit: +unknown\n/);
    assert.match(refreshedCatalog.stdout, /\nLast: +.+, updated\n/);
    // The refreshed catalog reaches the provider's models.
    assert.match(
      (await run(["model", "show", "deepseek/deepseek-chat"])).stdout,
      /\ncontext +64000 +catalog +\S/,
    );
    assert.match(
      (
        JSON.parse((await run(["catalog", "status", "--json"])).stdout) as {
          snapshot: { sha256: string };
        }
      ).snapshot.sha256,
      /^[0-9a-f]{64}$/,
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

    // --base moves every endpoint of a preset onto another address; an
    // explicit endpoint still wins.
    const remote = await run([
      "provider",
      "add",
      "office",
      "--preset",
      "harnesshub-remote",
      "--base",
      "http://192.168.50.10:3180/hh/",
      "--gemini",
      "http://192.168.50.11:3180",
      "--json",
    ]);
    assert.equal(remote.code, 0, remote.stderr);
    const office = JSON.parse(remote.stdout) as {
      kind: string;
      endpoints: Record<string, string>;
    };
    assert.equal(office.kind, "relay");
    assert.deepEqual(office.endpoints, {
      chat: "http://192.168.50.10:3180/hh/v1",
      responses: "http://192.168.50.10:3180/hh/v1",
      anthropic: "http://192.168.50.10:3180/hh",
      gemini: "http://192.168.50.11:3180",
    });
    for (const args of [
      ["provider", "add", "x", "--chat", base, "--base", "http://a.test"],
      ["provider", "add", "--preset", "ollama", "--base", "ftp://a.test"],
      ["provider", "add", "--preset", "ollama", "--base", "http://a.test?q=1"],
    ])
      assert.equal((await run(args)).code, 2, args.join(" "));
    for (const outcome of [
      presets,
      added,
      refreshed,
      shown,
      failed,
      unconfirmed,
      imported,
      repeated,
    ])
      assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(key), false);
  },
);
