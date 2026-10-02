// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { startHub } from "@harnesshub/daemon/main";
import { HarnessHubError } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeProvider } from "../support/fake-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

const UPSTREAM_KEY = "sk-synthetic-agents-upstream-0001";
const MODEL = "fake/upstream-sim";
const ORIGINAL = `# my Codex settings
model = "o3" # mine

[projects."/work"]
trust_level = "trusted"
`;

function problem(code: string, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * A daemon whose wiring home is a temporary directory with a Codex
 * configuration and a `codex` command on its PATH (never run), a provider
 * on the strict fake upstream, and an SDK client.
 */
async function setup(t: TestContext, wiring = true) {
  const { directory, defer } = await temporaryDirectory(t, "hh-agents-");
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(home, ".codex", "config.toml"), ORIGINAL);
  const command = path.join(
    bin,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  await writeFile(command, "exit 1\n");
  await chmod(command, 0o755);
  const upstream = await startFakeProvider({
    models: ["upstream-sim"],
    keys: { upstream: UPSTREAM_KEY },
    chunkDelayMs: 0,
  });
  defer(() => upstream.close());
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    ...(wiring ? { wiringHome: { home, env: { PATH: bin } } } : {}),
  });
  defer(() => hub.server.close());
  const client = await connectLocal({ dataDir, url: hub.url });
  await client.providers.create({
    id: "fake",
    name: "Fake",
    kind: "custom",
    endpoints: { chat: `${upstream.url}/v1` },
    models: {
      source: "manual",
      list: [
        { id: "upstream-sim", contextWindow: 64000, maxOutputTokens: 4096 },
      ],
      expose: "all",
    },
    credential: { value: UPSTREAM_KEY },
  });
  const info = await client.system.info();
  return {
    client,
    url: hub.url,
    home,
    bin,
    dataDir,
    upstream,
    config: path.join(home, ".codex", "config.toml"),
    gateway: info.gateway!.openaiBaseUrl,
  };
}

/** The base URL and key that the wired Codex configuration holds. */
async function wired(config: string) {
  const text = await readFile(config, "utf8");
  return {
    text,
    baseUrl: /^base_url = "([^"]+)"$/m.exec(text)?.[1],
    key: /^experimental_bearer_token = "(hhk_a_[^"]+)"$/m.exec(text)?.[1],
  };
}

async function chat(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.arrayBuffer();
  return response.status;
}

void test("wiring Codex points it at the gateway with a working agent key; rotate and unwire revoke keys and restore the file", async (t) => {
  const { client, config, dataDir, gateway, bin } = await setup(t);
  const listed = await client.agents.list();
  const codex = listed.items.find((agent) => agent.id === "codex")!;
  assert.equal(codex.installation.status, "installed");
  assert.equal(codex.installation.executable?.startsWith(bin), true);
  assert.equal(codex.wiring, null);
  assert.equal(
    listed.items.find((agent) => agent.id === "claude")!.installation.status,
    "not-found",
  );

  const plan = await client.agents.plan("codex", { model: MODEL });
  assert.equal(plan.changed, true);
  assert.match(
    plan.files[0]!.diff,
    /^\+experimental_bearer_token = "hhk_a_[a-z2-7]{4}…"$/m,
  );
  assert.doesNotMatch(JSON.stringify(plan), /hhk_a_[a-z2-7]{12}_/);
  assert.equal(await readFile(config, "utf8"), ORIGINAL);
  assert.deepEqual(
    (await client.gatewayKeys.list()).items.filter(
      (key) => key.scope.kind === "agent",
    ),
    [],
  );

  const agent = await client.agents.wire("codex", {
    model: MODEL,
    expect: plan,
  });
  assert.equal(agent.wiring?.model, MODEL);
  assert.deepEqual(agent.wiring?.models, [MODEL]);
  assert.equal(agent.wiring?.keyState, "active");
  assert.equal(agent.wiring?.drift?.drifted, false);
  const first = await wired(config);
  assert.equal(first.baseUrl, gateway);
  assert.ok(first.key);
  assert.equal(await chat(first.baseUrl!, first.key!), 200);
  // The ledger attributes the call to the agent.
  const usage = await client.usage.aggregate({ groupBy: "adapter" });
  assert.equal(usage.items.find((bucket) => bucket.key === "codex")?.calls, 1);
  const keys = (await client.gatewayKeys.list()).items;
  const issued = keys.find((key) => key.keyId === agent.wiring!.keyId)!;
  assert.deepEqual(issued.scope, { kind: "agent", adapterId: "codex" });
  assert.deepEqual(issued.modelAllow, [MODEL]);
  assert.equal(issued.expiresAt, undefined);
  // The daemon keeps no copy of the key text.
  for (const file of await files(dataDir))
    assert.equal((await readFile(file)).includes(first.key!), false, file);

  const rotated = await client.agents.rotate("codex");
  assert.notEqual(rotated.wiring?.keyId, agent.wiring?.keyId);
  const second = await wired(config);
  assert.notEqual(second.key, first.key);
  assert.equal(await chat(gateway, first.key!), 401);
  assert.equal(await chat(gateway, second.key!), 200);

  const unwired = await client.agents.unwire("codex");
  assert.deepEqual(
    unwired.files.map((file) => file.action),
    ["restored"],
  );
  assert.equal(unwired.agent.wiring, null);
  assert.equal(await readFile(config, "utf8"), ORIGINAL);
  assert.equal(await chat(gateway, second.key!), 401);
  assert.ok(
    (await client.gatewayKeys.list()).items
      .filter((key) => key.scope.kind === "agent")
      .every((key) => key.revokedAt),
  );
  await assert.rejects(
    client.agents.unwire("codex"),
    problem("AGENT_NOT_WIRED", 409),
  );
});

void test("a manual edit shows as drift, and unwire then restores only HarnessHub's entries", async (t) => {
  const { client, config } = await setup(t);
  const plan = await client.agents.plan("codex", {
    model: MODEL,
    models: [MODEL],
  });
  await client.agents.wire("codex", { model: MODEL, expect: plan });
  const text = await readFile(config, "utf8");
  await writeFile(
    config,
    text.replace(`model = "${MODEL}"`, 'model = "gpt-5"') + "\n# added later\n",
  );
  const drifted = await client.agents.get("codex");
  assert.equal(drifted.wiring?.drift?.drifted, true);
  assert.deepEqual(drifted.wiring?.drift?.kinds, ["replaced"]);
  assert.deepEqual(drifted.wiring?.drift?.findings[0]?.keyPath, ["model"]);
  const unwired = await client.agents.unwire("codex");
  assert.deepEqual(
    unwired.files.map((file) => file.action),
    ["reverse-patched"],
  );
  assert.equal(await readFile(config, "utf8"), `${ORIGINAL}\n# added later\n`);
});

void test("a failed apply revokes the key it issued and leaves the file as the user changed it", async (t) => {
  const { client, config } = await setup(t);
  const plan = await client.agents.plan("codex", { model: MODEL });
  await writeFile(config, `${ORIGINAL}approval_policy = "never"\n`);
  await assert.rejects(
    client.agents.wire("codex", { model: MODEL, expect: plan }),
    problem("WIRING_CONCURRENT_MODIFICATION", 409),
  );
  assert.equal(
    await readFile(config, "utf8"),
    `${ORIGINAL}approval_policy = "never"\n`,
  );
  const agentKeys = (await client.gatewayKeys.list()).items.filter(
    (key) => key.scope.kind === "agent",
  );
  assert.equal(agentKeys.length, 1);
  assert.ok(agentKeys[0]!.revokedAt);
  assert.equal((await client.agents.get("codex")).wiring, null);
});

void test("wiring refuses unknown agents, models the gateway does not offer, and agents that are not wired", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(
    client.agents.plan("nobody", { model: MODEL }),
    problem("WIRING_ADAPTER_UNKNOWN", 404),
  );
  await assert.rejects(
    client.agents.plan("codex", { model: "fake/absent" }),
    problem("AGENT_MODEL_UNAVAILABLE", 400),
  );
  await assert.rejects(
    client.agents.plan("codex", { model: MODEL, models: ["other/model"] }),
    problem("AGENT_MODEL_UNAVAILABLE", 400),
  );
  await assert.rejects(
    client.agents.rotate("codex"),
    problem("AGENT_NOT_WIRED", 409),
  );
});

void test("a daemon started without a wiring home refuses every wiring operation instead of using the account's home", async (t) => {
  const { client } = await setup(t, false);
  await assert.rejects(
    client.agents.list(),
    problem("AGENT_WIRING_UNAVAILABLE", 503),
  );
  await assert.rejects(
    client.agents.plan("codex", { model: MODEL }),
    problem("AGENT_WIRING_UNAVAILABLE", 503),
  );
  await assert.rejects(
    client.agents.wire("codex", { model: MODEL, expect: { files: [] } }),
    problem("AGENT_WIRING_UNAVAILABLE", 503),
  );
  await assert.rejects(
    client.agents.unwire("codex"),
    problem("AGENT_WIRING_UNAVAILABLE", 503),
  );
});

/** Run the real `hh` launcher with piped stdin, so it is never interactive. */
function hh(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(HH_ENTRY), ...args], {
      cwd,
      env: process.env,
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
    child.stdin.end("");
  });
}

void test(
  "hh agents, wire, use and unwire show redacted diffs and ask before writing",
  { timeout: 120_000 },
  async (t) => {
    const { url, dataDir, config, home } = await setup(t);
    const run = (...args: string[]) =>
      hh(home, [...args, "--url", url, "--data-dir", dataDir]);
    const outputs: string[] = [];
    const ok = async (...args: string[]) => {
      const outcome = await run(...args);
      outputs.push(outcome.stdout, outcome.stderr);
      assert.equal(outcome.code, 0, `${args.join(" ")}: ${outcome.stderr}`);
      return outcome;
    };

    const listed = await ok("agents");
    assert.match(listed.stdout, /^codex\s+Codex CLI\s+installed\s+no\s+-/m);

    const unconfirmed = await run("wire", "codex", MODEL);
    assert.equal(unconfirmed.code, 4, unconfirmed.stderr);
    assert.match(unconfirmed.stdout, /^Change .*config\.toml$/m);
    assert.match(
      unconfirmed.stdout,
      /^\+experimental_bearer_token = "hhk_a_[a-z2-7]{4}…"$/m,
    );
    assert.match(unconfirmed.stderr, /--yes/);
    assert.equal(await readFile(config, "utf8"), ORIGINAL);

    const used = await ok("use", "codex", MODEL, "--yes");
    assert.match(used.stdout, /^Wired Codex CLI to fake\/upstream-sim/m);
    const first = await wired(config);
    assert.ok(first.key);
    const json = JSON.parse((await ok("agents", "--json")).stdout) as {
      items: Array<{ id: string; wiring: { model: string } | null }>;
    };
    assert.equal(
      json.items.find((agent) => agent.id === "codex")?.wiring?.model,
      MODEL,
    );

    await ok("wire", "codex", "--rotate", "--yes");
    const second = await wired(config);
    assert.notEqual(second.key, first.key);
    // Re-wiring without a model keeps the current one.
    await ok("wire", "codex", "--yes");
    const third = await wired(config);

    const unwired = await ok("unwire", "codex", "--yes");
    assert.match(unwired.stdout, /^restored\s+.*config\.toml$/m);
    assert.equal(await readFile(config, "utf8"), ORIGINAL);
    for (const text of outputs)
      for (const key of [first.key!, second.key!, third.key!])
        assert.equal(text.includes(key), false);

    const missing = await run("use", "codex");
    assert.equal(missing.code, 2);
    const notWired = await run("unwire", "codex", "--yes");
    assert.equal(notWired.code, 5, notWired.stderr);
    assert.match(notWired.stderr, /AGENT_NOT_WIRED/);
  },
);
