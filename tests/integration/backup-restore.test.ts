// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { open, seal } from "@harnesshub/daemon/backup-envelope";
import { startHub } from "@harnesshub/daemon/main";
import {
  HarnessHubError,
  type BackupEnvelope,
  type HarnessHubClient,
} from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeProvider,
  type FakeProvider,
} from "../support/fake-provider.js";
import { seedSubscription } from "../support/subscription-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const KEY_A = "sk-synthetic-backup-restored-0001";
const KEY_B = "sk-synthetic-backup-local-0002";
const SECRET_HEADER = "synthetic-header-token-0003";
const PASSPHRASE = "correct horse battery staple";

function problem(code: string, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof HarnessHubError, String(error));
    assert.equal(error.code, code, JSON.stringify(error.problem));
    assert.equal(error.status, status);
    return true;
  };
}

interface Daemon {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  home: string;
  directory: string;
  /** The codex configuration of the wiring home. */
  codex: string;
}

/** A daemon on temporary directories, with `codex` (and `claude`) commands, never run, on its PATH when asked. */
async function daemon(
  t: TestContext,
  name: string,
  options: { codex: boolean; claude?: boolean },
): Promise<Daemon> {
  const { directory, defer } = await temporaryDirectory(
    t,
    `hh-backup-${name}-`,
  );
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(home);
  await mkdir(bin);
  if (options.codex) {
    await mkdir(path.join(home, ".codex"));
    const command = path.join(
      bin,
      process.platform === "win32" ? "codex.cmd" : "codex",
    );
    await writeFile(command, "exit 1\n");
    await chmod(command, 0o755);
  }
  if (options.claude) {
    const command = path.join(
      bin,
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    await writeFile(command, "exit 1\n");
    await chmod(command, 0o755);
  }
  const dataDir = path.join(directory, "data");
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: { home, env: { PATH: bin } },
  });
  defer(() => hub.server.close());
  return {
    client: await connectLocal({ dataDir, url: hub.url }),
    url: hub.url,
    dataDir,
    home,
    directory,
    codex: path.join(home, ".codex", "config.toml"),
  };
}

async function upstream(t: TestContext): Promise<FakeProvider> {
  const provider = await startFakeProvider({
    models: ["upstream-sim"],
    keys: { restored: KEY_A, local: KEY_B },
    chunkDelayMs: 0,
  });
  t.after(() => provider.close());
  return provider;
}

const models = {
  source: "manual" as const,
  list: [{ id: "upstream-sim", contextWindow: 64000, maxOutputTokens: 4096 }],
  expose: "all" as const,
};

/** Machine A: two providers, a group, an override, a client key and codex wired. */
async function populate(a: Daemon, fake: FakeProvider): Promise<void> {
  await a.client.providers.create({
    id: "fake",
    name: "Fake A",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    headers: { "x-tenant": "team-1", "x-api-token": SECRET_HEADER },
    models,
    credential: { value: KEY_A },
  });
  await a.client.credentials.add("fake", {
    name: "from-env",
    ref: { kind: "env", value: "HH_SYNTHETIC_UNSET_KEY" },
    enabled: false,
  });
  await a.client.providers.create({
    id: "second",
    name: "Second",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models,
    credential: { value: KEY_A },
  });
  await a.client.routeGroups.create({
    id: "pair",
    members: ["fake/upstream-sim", "second/upstream-sim"],
  });
  await a.client.models.setOverride("fake/upstream-sim", {
    contextWindow: 32000,
  });
  await a.client.gatewayKeys.create({
    name: "laptop",
    modelAllow: ["fake/*"],
    expiresAt: null,
  });
  const plan = await a.client.agents.plan("codex", {
    model: "fake/upstream-sim",
    models: ["fake/upstream-sim", "group/pair"],
  });
  await a.client.agents.wire("codex", {
    model: "fake/upstream-sim",
    models: ["fake/upstream-sim", "group/pair"],
    expect: plan,
  });
}

async function plain(envelope: BackupEnvelope): Promise<string> {
  return (await open(envelope, PASSPHRASE)).toString("utf8");
}

/** Calls the daemon's gateway with a new client key; resolves to the upstream key id used. */
async function call(
  machine: Daemon,
  fake: FakeProvider,
  model: string,
): Promise<string | null> {
  const { key } = await machine.client.gatewayKeys.create({
    name: `probe-${Date.now()}`,
    modelAllow: [model],
    expiresAt: null,
  });
  const info = await machine.client.system.info();
  const before = fake.records().length;
  const response = await fetch(
    `${info.gateway!.openaiBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hello" }],
      }),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  await fake.idle();
  return fake.records(before).at(-1)?.keyId ?? null;
}

void test("a backup holds providers, keys, groups, overrides, wirings and settings; without keys no secret value", async (t) => {
  const fake = await upstream(t);
  const a = await daemon(t, "a", { codex: true });
  await populate(a, fake);

  const sealed = await a.client.backup.create({ passphrase: PASSPHRASE });
  assert.equal(sealed.format, "harnesshub-backup");
  assert.equal(sealed.version, 1);
  assert.equal(sealed.kdf, "pbkdf2-sha256");
  assert.equal(sealed.iterations, 600_000);
  const sealedText = JSON.stringify(sealed);
  for (const value of [KEY_A, SECRET_HEADER, "Fake A", "hhk_"])
    assert.doesNotMatch(sealedText, new RegExp(value), "ciphertext only");

  const withKeys = await plain(sealed);
  assert.match(withKeys, new RegExp(KEY_A));
  assert.match(withKeys, new RegExp(SECRET_HEADER));
  assert.doesNotMatch(withKeys, /hhk_/, "no Gateway Key text");
  const bundle = JSON.parse(withKeys) as {
    keys: boolean;
    providers: Array<{
      config: { id: string };
      credentials: Array<{ id: string; secret: Record<string, unknown> }>;
      overrides: Array<{ ref: string }>;
    }>;
    groups: Array<{ id: string }>;
    agents: Array<{ agent: string; model: string; models: string[] }>;
    clientKeys: Array<{ name: string; modelAllow: string[] }>;
    settings: { gatewayShare?: unknown; catalog?: unknown };
  };
  assert.equal(bundle.keys, true);
  assert.deepEqual(
    bundle.providers.map((item) => item.config.id),
    ["fake", "second"],
  );
  assert.deepEqual(bundle.providers[0]!.credentials[1]!.secret, {
    source: "reference",
    kind: "env",
    name: "HH_SYNTHETIC_UNSET_KEY",
  });
  assert.deepEqual(
    bundle.providers[0]!.overrides.map((item) => item.ref),
    ["fake/upstream-sim"],
  );
  assert.deepEqual(
    bundle.groups.map((item) => item.id),
    ["pair"],
  );
  assert.deepEqual(bundle.agents, [
    {
      agent: "codex",
      model: "fake/upstream-sim",
      options: { codexAuth: "gateway-key" },
      models: ["fake/upstream-sim", "group/pair"],
    },
  ]);
  assert.deepEqual(
    bundle.clientKeys.map((item) => [item.name, item.modelAllow]),
    [["laptop", ["fake/*"]]],
  );
  assert.ok(bundle.settings.gatewayShare);
  assert.deepEqual(bundle.settings.catalog, {
    autoRefresh: false,
    url: "https://models.dev/api.json",
  });

  const withoutKeys = await plain(
    await a.client.backup.create({ passphrase: PASSPHRASE, keys: false }),
  );
  assert.doesNotMatch(withoutKeys, new RegExp(KEY_A));
  assert.doesNotMatch(withoutKeys, new RegExp(SECRET_HEADER));
  assert.match(withoutKeys, /x-tenant/);
  assert.equal((JSON.parse(withoutKeys) as { keys: boolean }).keys, false);

  // A wrong passphrase, or one byte changed anywhere, opens nothing.
  await assert.rejects(
    a.client.backup.restore({
      backup: sealed,
      passphrase: "wrong",
      dryRun: true,
    }),
    problem("BACKUP_PASSPHRASE", 400),
  );
  const data = Buffer.from(sealed.data, "base64");
  data.writeUInt8(data.readUInt8(10) ^ 1, 10);
  await assert.rejects(
    a.client.backup.restore({
      backup: { ...sealed, data: data.toString("base64") },
      passphrase: PASSPHRASE,
      dryRun: true,
    }),
    problem("BACKUP_PASSPHRASE", 400),
  );
  await assert.rejects(
    a.client.backup.create({ passphrase: "" }),
    problem("INVALID_REQUEST", 400),
  );
});

void test("restore replaces providers with the same id, adds the others and re-wires installed agents with new keys", async (t) => {
  const fake = await upstream(t);
  const a = await daemon(t, "a", { codex: true });
  await populate(a, fake);
  const sealed = await a.client.backup.create({ passphrase: PASSPHRASE });

  const b = await daemon(t, "b", { codex: true });
  await b.client.providers.create({
    id: "fake",
    name: "Old",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models,
    credential: { value: KEY_B },
  });
  await b.client.providers.create({
    id: "only-here",
    name: "Only here",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models,
    credential: { value: KEY_B },
  });

  const summary = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(summary.providers, {
    added: ["second"],
    replaced: ["fake"],
    needKey: [],
    signInAgain: [],
    signedInHere: [],
  });
  assert.deepEqual(summary.groups, {
    added: ["pair"],
    replaced: [],
    skipped: [],
  });
  assert.equal(summary.overrides, 1);
  assert.equal(summary.keys, true);
  assert.deepEqual(
    summary.agents.map((agent) => [agent.agent, agent.action]),
    [["codex", "wire"]],
  );
  assert.deepEqual(
    summary.clientKeys.map((key) => key.name),
    ["laptop"],
  );
  // A dry run writes nothing.
  assert.equal((await b.client.providers.get("fake")).name, "Old");
  assert.equal((await b.client.agents.get("codex")).wiring, null);

  const result = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(
    result.agents.map((agent) => [agent.agent, agent.outcome]),
    [["codex", "wired"]],
  );
  const providers = (await b.client.providers.list()).items;
  assert.deepEqual(providers.map((item) => [item.id, item.name]).sort(), [
    ["fake", "Fake A"],
    ["only-here", "Only here"],
    ["second", "Second"],
  ]);
  const restored = providers.find((item) => item.id === "fake")!;
  assert.deepEqual(
    restored.credentials.map((item) => [item.name, item.ref.kind]),
    [
      ["default", "store"],
      ["from-env", "env"],
    ],
  );
  assert.equal(
    (await b.client.models.getOverride("fake/upstream-sim")).values
      .contextWindow,
    32000,
  );
  assert.deepEqual((await b.client.routeGroups.get("pair")).members, [
    "fake/upstream-sim",
    "second/upstream-sim",
  ]);
  // The restored credential reaches the upstream.
  assert.equal(await call(b, fake, "fake/upstream-sim"), "restored");

  // Codex on B is wired to B's gateway with a key of B's own.
  const agent = await b.client.agents.get("codex");
  assert.equal(agent.wiring?.model, "fake/upstream-sim");
  assert.deepEqual(agent.wiring?.models.sort(), [
    "fake/upstream-sim",
    "group/pair",
  ]);
  const config = await readFile(b.codex, "utf8");
  const wiredKey = /experimental_bearer_token = "(hhk_a_[^"]+)"/.exec(
    config,
  )?.[1];
  assert.ok(wiredKey);
  assert.equal(
    (await a.client.agents.get("codex")).wiring?.keyId === agent.wiring?.keyId,
    false,
  );
  const info = await b.client.system.info();
  assert.match(
    config,
    new RegExp(`base_url = "${info.gateway!.openaiBaseUrl}"`),
  );

  // A second restore finds everything as it is.
  const again = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(
    again.agents.map((item) => item.action),
    ["unchanged"],
  );
});

void test("a restore without keys keeps this machine's key, flags providers left without one and skips agents not installed", async (t) => {
  const fake = await upstream(t);
  const a = await daemon(t, "a", { codex: true });
  await populate(a, fake);
  const sealed = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: false,
  });

  const c = await daemon(t, "c", { codex: false });
  await c.client.providers.create({
    id: "fake",
    name: "Mine",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    headers: { "x-api-token": "local-header-value" },
    models,
    credential: { value: KEY_B },
  });
  const result = await c.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(result.providers.needKey, ["second"]);
  assert.deepEqual(
    result.agents.map((agent) => [agent.agent, agent.action]),
    [["codex", "skip-not-installed"]],
  );
  const restored = await c.client.providers.get("fake");
  assert.equal(restored.name, "Fake A");
  assert.deepEqual(restored.headers, {
    "x-tenant": "team-1",
    "x-api-token": "local-header-value",
  });
  assert.equal(await call(c, fake, "fake/upstream-sim"), "local");
  assert.deepEqual((await c.client.providers.get("second")).credentials, []);
  assert.equal((await c.client.agents.get("codex")).wiring, null);
});

void test("restore carries tiers, effort, hidden models and wiring profiles through plan and wire", async (t) => {
  const fake = await upstream(t);
  const a = await daemon(t, "a", { codex: true, claude: true });
  await populate(a, fake);
  const choice = {
    model: "fake/upstream-sim",
    models: ["*"],
    tiers: { haiku: "second/upstream-sim" },
    effort: "high" as const,
  };
  await a.client.agents.wire("claude", {
    ...choice,
    expect: await a.client.agents.plan("claude", choice),
  });
  await a.client.agents.setHidden("claude", ["group/pair"]);
  await a.client.profiles.save("work");
  const sealed = await a.client.backup.create({ passphrase: PASSPHRASE });
  const bundle = JSON.parse(await plain(sealed)) as {
    agents: Array<Record<string, unknown>>;
    profiles: Array<{ name: string; agents: Record<string, unknown> }>;
  };
  assert.deepEqual(
    bundle.agents.find((agent) => agent.agent === "claude"),
    {
      agent: "claude",
      model: "fake/upstream-sim",
      tiers: { haiku: "second/upstream-sim" },
      effort: "high",
      models: ["*"],
      deny: ["group/pair"],
    },
  );
  assert.deepEqual(
    bundle.profiles.map((profile) => [
      profile.name,
      Object.keys(profile.agents).sort(),
    ]),
    [["work", ["claude", "codex"]]],
  );

  // B has its own profile, and claude wired with the chosen model hidden:
  // the restore shows it again, wires, then hides what the backup hides.
  const b = await daemon(t, "b", { codex: true, claude: true });
  for (const id of ["fake", "second"])
    await b.client.providers.create({
      id,
      name: `B ${id}`,
      kind: "custom",
      endpoints: { chat: `${fake.url}/v1` },
      models,
      credential: { value: KEY_B },
    });
  const own = { model: "second/upstream-sim", models: ["*"] };
  await b.client.agents.wire("claude", {
    ...own,
    expect: await b.client.agents.plan("claude", own),
  });
  await b.client.agents.setHidden("claude", ["fake/upstream-sim"]);
  await b.client.profiles.save("home");

  const summary = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(summary.profiles, { added: ["work"], replaced: [] });
  assert.deepEqual(
    summary.agents.map((agent) => [agent.agent, agent.action]).sort(),
    [
      ["claude", "wire"],
      ["codex", "wire"],
    ],
  );
  const result = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(
    result.agents.map((agent) => [agent.agent, agent.outcome, agent.error]),
    [
      ["claude", "wired", undefined],
      ["codex", "wired", undefined],
    ],
  );
  const claude = (await b.client.agents.get("claude")).wiring!;
  assert.equal(claude.model, "fake/upstream-sim");
  assert.deepEqual(claude.tiers, { haiku: "second/upstream-sim" });
  assert.equal(claude.effort, "high");
  assert.deepEqual(claude.hidden, ["group/pair"]);
  assert.deepEqual(
    (await b.client.profiles.list()).items.map((profile) => profile.name),
    ["home", "work"],
  );
  assert.deepEqual(
    Object.keys((await b.client.profiles.get("work")).agents).sort(),
    ["claude", "codex"],
  );
  const again = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(
    again.agents.map((agent) => agent.action),
    ["unchanged", "unchanged"],
  );
  assert.deepEqual(again.profiles, { added: [], replaced: ["work"] });
});

/** Runs the installed `hh` with `input` on stdin. */
function hh(
  cwd: string,
  args: string[],
  input: string,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

void test(
  "hh backup and hh restore read the passphrase from stdin and ask before restoring",
  { timeout: 120_000 },
  async (t) => {
    const fake = await upstream(t);
    const a = await daemon(t, "a", { codex: true });
    await populate(a, fake);
    const b = await daemon(t, "b", { codex: true });
    const file = path.join(a.directory, "machine.harnesshub-backup");

    const made = await hh(
      a.directory,
      ["backup", file, "--url", a.url, "--data-dir", a.dataDir],
      `${PASSPHRASE}\n`,
    );
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /with credential values/);
    if (process.platform !== "win32")
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    const envelope = JSON.parse(await readFile(file, "utf8")) as BackupEnvelope;
    assert.match(await plain(envelope), new RegExp(KEY_A));
    // An existing file is replaced only when confirmed.
    const again = await hh(
      a.directory,
      ["backup", file, "--url", a.url, "--data-dir", a.dataDir],
      `${PASSPHRASE}\n`,
    );
    assert.equal(again.code, 4, again.stderr);

    const restoreArgs = [
      "restore",
      file,
      "--url",
      b.url,
      "--data-dir",
      b.dataDir,
    ];
    const unconfirmed = await hh(b.directory, restoreArgs, `${PASSPHRASE}\n`);
    assert.equal(unconfirmed.code, 4, unconfirmed.stderr);
    assert.match(unconfirmed.stdout, /Providers: add fake, second/);
    assert.match(
      unconfirmed.stdout,
      /codex +wire to fake\/upstream-sim \(2 models\)/,
    );
    assert.match(unconfirmed.stdout, /laptop: fake\/\*/);
    assert.equal((await b.client.providers.list()).items.length, 0);

    const wrong = await hh(b.directory, [...restoreArgs, "--yes"], "wrong\n");
    assert.equal(wrong.code, 2, wrong.stderr);
    assert.match(wrong.stderr, /BACKUP_PASSPHRASE/);

    const done = await hh(
      b.directory,
      [...restoreArgs, "--yes", "--no-agents"],
      `${PASSPHRASE}\n`,
    );
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Providers: added fake, second/);
    assert.match(done.stdout, /codex +skipped \(--no-agents\)/);
    assert.equal((await b.client.providers.list()).items.length, 2);
    assert.equal((await b.client.agents.get("codex")).wiring, null);
    for (const output of [made, again, unconfirmed, wrong, done])
      assert.doesNotMatch(
        output.stdout + output.stderr,
        new RegExp(`${KEY_A}|${PASSPHRASE}`),
      );
  },
);

void test("subscription providers stay on their machine: left out of backups, skipped by restores, kept when another is restored", async (t) => {
  const fake = await upstream(t);
  const a = await daemon(t, "subs-a", { codex: false });
  const b = await daemon(t, "subs-b", { codex: false });
  await a.client.providers.create({
    id: "fake",
    kind: "custom",
    endpoints: { chat: `${fake.url}/v1` },
    models,
    credential: { value: KEY_A },
  });
  await seedSubscription(a.dataDir, "chatgpt", "siwc");
  await seedSubscription(a.dataDir, "copilot", "copilot");

  // A backup leaves A's sign-ins out.
  const envelope = await a.client.backup.create({ passphrase: PASSPHRASE });
  const bundle = JSON.parse(await plain(envelope)) as {
    providers: Array<{ config: { id: string } }>;
  };
  assert.deepEqual(
    bundle.providers.map((item) => item.config.id),
    ["fake"],
  );
  assert.doesNotMatch(await plain(envelope), /account-1|synthetic-subject/);

  // B has its own ChatGPT sign-in, which a restore keeps.
  const own = await seedSubscription(b.dataDir, "chatgpt", "siwc");
  const restored = await b.client.backup.restore({
    backup: envelope,
    passphrase: PASSPHRASE,
    agents: false,
  });
  assert.deepEqual(restored.providers, {
    added: ["fake"],
    replaced: [],
    needKey: [],
    signInAgain: [],
    signedInHere: [],
  });
  assert.deepEqual(
    (await b.client.providers.list()).items.map((item) => item.id).sort(),
    ["chatgpt", "fake"],
  );
  assert.deepEqual(
    (await b.client.providers.get("chatgpt")).credentials,
    own.credentials,
  );
});

void test("a backup from before subscriptions were left out restores without them and says to sign in again", async (t) => {
  const b = await daemon(t, "old", { codex: false });
  await seedSubscription(b.dataDir, "copilot", "copilot");
  const now = new Date().toISOString();
  const provider = (id: string, extra: Record<string, unknown> = {}) => ({
    config: {
      schemaVersion: 1,
      id,
      name: id,
      kind: "vendor",
      endpoints: { responses: "https://chatgpt.example.test/v1" },
      auth: { apiKeyHeader: "authorization-bearer" },
      models: { source: "manual", list: [{ id: "plan-model" }], expose: "all" },
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
    // As the older HarnessHub carried them: the account field was dropped.
    credentials: [
      {
        id: "account-1",
        name: "plan-user@example.com",
        enabled: true,
        secret: { source: "store", value: "synthetic-account-bundle" },
      },
    ],
    provenance: [],
    overrides: [],
  });
  const old = {
    version: 1,
    createdAt: now,
    app: "HarnessHub 0.1.0",
    keys: true,
    providers: [
      provider("chatgpt", { subscription: { backend: "siwc" } }),
      provider("relay"),
      // A plain provider with the ID of B's Copilot sign-in.
      provider("copilot"),
    ],
    groups: [
      {
        id: "plans",
        strategy: "order",
        stickiness: "auto",
        members: ["chatgpt/plan-model", "relay/plan-model"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: {},
    agents: [],
    clientKeys: [],
  };
  const backup = await seal(Buffer.from(JSON.stringify(old)), PASSPHRASE);
  const expected = {
    added: ["relay"],
    replaced: [],
    needKey: [],
    signInAgain: ["chatgpt"],
    signedInHere: ["copilot"],
  };
  const dry = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
    agents: false,
    dryRun: true,
  });
  assert.deepEqual(dry.providers, expected);
  // Its group names a provider that is neither restored nor here.
  assert.deepEqual(dry.groups.skipped, ["plans"]);
  const done = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
    agents: false,
  });
  // The run does exactly what the dry run said.
  assert.deepEqual(done.providers, dry.providers);
  assert.deepEqual(done.groups, dry.groups);
  assert.deepEqual(
    (await b.client.providers.list()).items.map((item) => item.id).sort(),
    ["copilot", "relay"],
  );
  assert.deepEqual((await b.client.providers.get("copilot")).subscription, {
    backend: "copilot",
  });
  assert.deepEqual(
    await b.client.routeGroups.list().then((page) => page.items),
    [],
  );
});
