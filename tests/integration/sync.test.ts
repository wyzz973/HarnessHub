// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { open, parseEnvelope } from "@harnesshub/daemon/backup-envelope";
import { startHub } from "@harnesshub/daemon/main";
import {
  HarnessHubError,
  type HarnessHubClient,
  type SyncSettings,
} from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import {
  startFakeS3,
  startFakeWebDav,
  type FakeStorage,
} from "../support/fake-storage.js";
import { seedSubscription } from "../support/subscription-provider.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only.
const KEY_A = "sk-synthetic-sync-a-0001";
const KEY_B = "sk-synthetic-sync-b-0002";
const PASSPHRASE = "synthetic sync passphrase";
const DAV_USER = "sync-user";
const DAV_PASSWORD = "synthetic-dav-password";
const S3_ID = "AKIASYNTHETIC0001";
const S3_SECRET = "synthetic-s3-secret-0002";
const DAV_FILE = "/dav/harnesshub/harnesshub.harnesshub-backup";
const S3_FILE = "team/harnesshub/harnesshub.harnesshub-backup";

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  directory: string;
}

async function machine(
  t: TestContext,
  name: string,
  codex = false,
): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(t, `hh-sync-${name}-`);
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(home);
  await mkdir(bin);
  if (codex) {
    await mkdir(path.join(home, ".codex"));
    const command = path.join(
      bin,
      process.platform === "win32" ? "codex.cmd" : "codex",
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
    directory,
  };
}

const models = {
  source: "manual" as const,
  list: [{ id: "m1", contextWindow: 64000 }],
  expose: "all" as const,
};

async function provider(
  on: Machine,
  id: string,
  key: string,
  name = id,
): Promise<void> {
  await on.client.providers.create({
    id,
    name,
    kind: "custom",
    endpoints: { chat: "https://upstream.invalid/v1" },
    models,
    credential: { value: key },
  });
}

async function ids(on: Machine): Promise<string[]> {
  return (await on.client.providers.list()).items.map((item) => item.id).sort();
}

/** The server's file, opened: what it holds, and its raw text. */
async function server(storage: FakeStorage, key: string) {
  const stored = storage.object(key);
  assert.ok(stored, "the server holds the file");
  const raw = stored.data.toString("utf8");
  const bundle = JSON.parse(
    (await open(parseEnvelope(stored.data), PASSPHRASE)).toString("utf8"),
  ) as {
    providers: Array<{ config: { id: string; name: string } }>;
    agents: Array<{ agent: string; model: string }>;
  };
  return { raw, bundle };
}

/** Two machines syncing to `target`, the second preempted once by the first. */
async function conflictRoundTrip(
  t: TestContext,
  storage: FakeStorage,
  key: string,
  settings: SyncSettings,
) {
  const a = await machine(t, "a");
  const b = await machine(t, "b", true);
  await provider(a, "pa", KEY_A);
  await a.client.sync.configure(settings);
  await a.client.sync.now();
  const first = await server(storage, key);
  assert.deepEqual(
    first.bundle.providers.map((item) => item.config.id),
    ["pa"],
  );
  // The server holds ciphertext only.
  assert.doesNotMatch(first.raw, new RegExp(`${KEY_A}|"pa"`));
  assert.match(
    (await open(parseEnvelope(Buffer.from(first.raw)), PASSPHRASE)).toString(),
    new RegExp(KEY_A),
  );

  // B joins: the server's providers come in, keys included.
  await b.client.sync.configure(settings);
  const joined = await b.client.sync.now();
  assert.equal(joined.lastError, undefined);
  assert.deepEqual(await ids(b), ["pa"]);
  assert.equal((await b.client.providers.get("pa")).credentials.length, 1);

  // B wires codex (its agents part); before B's write lands, A adds a
  // provider and syncs: B's write is refused, B reads A's version, merges
  // and writes again.
  const wiring = { model: "pa/m1", models: ["pa/m1"] };
  await b.client.agents.wire("codex", {
    ...wiring,
    expect: await b.client.agents.plan("codex", wiring),
  });
  storage.beforeWrite(key, async () => {
    await provider(a, "pb", KEY_A);
    await a.client.sync.now();
  });
  const merged = await b.client.sync.now();
  assert.equal(merged.lastError, undefined);
  assert.equal(merged.notice, undefined, "no part changed on both sides");
  assert.deepEqual(await ids(b), ["pa", "pb"]);
  const after = await server(storage, key);
  assert.deepEqual(
    after.bundle.providers.map((item) => item.config.id),
    ["pa", "pb"],
  );
  assert.deepEqual(after.bundle.agents, [
    {
      agent: "codex",
      model: "pa/m1",
      options: { codexAuth: "gateway-key" },
      models: ["pa/m1"],
    },
  ]);
  // A brings nothing it lacks; codex is not installed there.
  await a.client.sync.now();
  assert.deepEqual(await ids(a), ["pa", "pb"]);
  assert.equal((await a.client.agents.get("codex")).wiring, null);
  return { a, b };
}

void test("WebDAV sync: first push, join, a refused conditional write merged and retried, newer side of a conflict kept", async (t) => {
  const storage = await startFakeWebDav({
    user: DAV_USER,
    password: DAV_PASSWORD,
  });
  t.after(() => storage.close());
  const settings: SyncSettings = {
    kind: "webdav",
    url: `${storage.url}/dav`,
    user: DAV_USER,
    secret: DAV_PASSWORD,
    passphrase: PASSPHRASE,
  };
  const { a, b } = await conflictRoundTrip(t, storage, DAV_FILE, settings);
  const puts = storage.requests.filter((request) => request.method === "PUT");
  assert.ok(
    puts.some((request) => request.status === 412),
    "a write was refused",
  );
  assert.ok(
    storage.requests.some((request) => request.status === 304),
    "an unchanged file is not downloaded again",
  );

  // Both rename pa; B's rename is the later one and wins; the server's
  // copy it replaced is kept beside B's data.
  await a.client.providers.update("pa", { name: "Renamed on A" });
  await a.client.sync.now();
  await delay(20);
  await b.client.providers.update("pa", { name: "Renamed on B" });
  const conflict = await b.client.sync.now();
  assert.deepEqual(conflict.notice?.there, ["providers"]);
  assert.deepEqual(conflict.notice?.here, []);
  const saved = await readdir(path.join(b.dataDir, "sync", "conflicts"));
  assert.equal(saved.length, 1);
  assert.match(saved[0]!, /-server\.harnesshub-backup$/);
  await a.client.sync.now();
  assert.equal((await a.client.providers.get("pa")).name, "Renamed on B");

  // A provider removed on one machine goes from the others.
  await b.client.providers.remove("pb");
  await b.client.sync.now();
  await a.client.sync.now();
  assert.deepEqual(await ids(a), ["pa"]);

  // Wiring profiles travel as their own part, deletions too.
  await b.client.profiles.save("work");
  await b.client.sync.now();
  await a.client.sync.now();
  assert.deepEqual(Object.keys((await a.client.profiles.get("work")).agents), [
    "codex",
  ]);
  await a.client.profiles.remove("work");
  await a.client.sync.now();
  await b.client.sync.now();
  assert.deepEqual((await b.client.profiles.list()).items, []);

  // A wrong passphrase opens nothing and says so.
  const c = await machine(t, "c");
  await c.client.sync.configure({ ...settings, passphrase: "another one" });
  await assert.rejects(c.client.sync.now(), (error: unknown) => {
    assert.ok(error instanceof HarnessHubError);
    assert.equal(error.code, "SYNC_PASSPHRASE");
    return true;
  });
  assert.match((await c.client.sync.status()).lastError ?? "", /passphrase/);
  assert.deepEqual(await ids(c), []);
});

void test("S3 sync with conditional writes: signed requests, a refused write merged and retried", async (t) => {
  const storage = await startFakeS3({
    bucket: "shared",
    accessKeyId: S3_ID,
    secretAccessKey: S3_SECRET,
    region: "us-east-1",
    conditional: true,
    versioning: false,
  });
  t.after(() => storage.close());
  await conflictRoundTrip(t, storage, S3_FILE, {
    kind: "s3",
    url: "s3://shared/team",
    user: S3_ID,
    secret: S3_SECRET,
    endpoint: storage.url,
    passphrase: PASSPHRASE,
  });
  assert.ok(
    storage.requests.some(
      (request) => request.method === "PUT" && request.status === 412,
    ),
  );
  assert.ok(storage.requests.every((request) => request.status !== 403));
});

void test("S3 sync without conditional writes compares ETags and, with versions, finds a write that came in between", async (t) => {
  const storage = await startFakeS3({
    bucket: "shared",
    accessKeyId: S3_ID,
    secretAccessKey: S3_SECRET,
    region: "eu-west-1",
    conditional: false,
    versioning: true,
  });
  t.after(() => storage.close());
  await conflictRoundTrip(t, storage, S3_FILE, {
    kind: "s3",
    url: "s3://shared/team",
    user: S3_ID,
    secret: S3_SECRET,
    endpoint: storage.url,
    region: "eu-west-1",
    passphrase: PASSPHRASE,
  });
  const puts = storage.requests.filter((request) => request.method === "PUT");
  assert.ok(puts.some((request) => request.status === 501));
  assert.ok(
    storage.requests.some((request) => request.path.includes("versions")),
    "the version before B's write was compared",
  );
});

void test("sync is off by default, refuses invalid settings, and off forgets its secrets", async (t) => {
  const storage = await startFakeWebDav({
    user: DAV_USER,
    password: DAV_PASSWORD,
  });
  t.after(() => storage.close());
  const a = await machine(t, "a");
  assert.equal((await a.client.sync.status()).enabled, false);
  await assert.rejects(a.client.sync.now(), (error: unknown) => {
    assert.ok(error instanceof HarnessHubError);
    assert.equal(error.code, "SYNC_DISABLED");
    return true;
  });
  for (const invalid of [
    { kind: "webdav", url: "ftp://example.invalid", passphrase: PASSPHRASE },
    { kind: "s3", url: "s3://shared", passphrase: PASSPHRASE },
    { kind: "webdav", url: `${storage.url}/dav`, user: DAV_USER },
  ] as SyncSettings[])
    await assert.rejects(a.client.sync.configure(invalid), (error: unknown) => {
      assert.ok(error instanceof HarnessHubError);
      assert.ok(
        ["SYNC_CONFIG_INVALID", "INVALID_REQUEST"].includes(error.code),
        error.code,
      );
      return true;
    });
  const on = await a.client.sync.configure({
    kind: "webdav",
    url: `${storage.url}/dav`,
    user: DAV_USER,
    secret: DAV_PASSWORD,
    passphrase: PASSPHRASE,
    keys: false,
  });
  assert.equal(on.enabled, true);
  assert.equal(on.keys, false);
  assert.match(on.warnings?.join(" ") ?? "", /passphrase is kept/);
  const config = await readFile(
    path.join(a.dataDir, "sync", "config.json"),
    "utf8",
  );
  assert.doesNotMatch(config, new RegExp(`${DAV_PASSWORD}|${PASSPHRASE}`));
  // Without keys, the server's copy carries no credential value.
  await provider(a, "pa", KEY_B);
  await a.client.sync.now();
  const { raw, bundle } = await server(storage, DAV_FILE);
  assert.doesNotMatch(raw, new RegExp(KEY_B));
  assert.doesNotMatch(JSON.stringify(bundle), new RegExp(KEY_B));
  const off = await a.client.sync.disable();
  assert.equal(off.enabled, false);
  assert.deepEqual(
    (await readdir(path.join(a.dataDir, "sync"))).filter(
      (name) => !name.startsWith("conflicts"),
    ),
    [],
  );
});

void test(
  "hh sync reads the password and passphrase from stdin, syncs at once and turns off after confirming",
  { timeout: 120_000 },
  async (t) => {
    const storage = await startFakeWebDav({
      user: DAV_USER,
      password: DAV_PASSWORD,
    });
    t.after(() => storage.close());
    const a = await machine(t, "a");
    await provider(a, "pa", KEY_A);
    const run = (args: string[], input: string) =>
      new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(HH_ENTRY),
              ...args,
              "--url",
              a.url,
              "--data-dir",
              a.dataDir,
            ],
            {
              cwd: a.directory,
              env: process.env,
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout
            .setEncoding("utf8")
            .on("data", (chunk: string) => (stdout += chunk));
          child.stderr
            .setEncoding("utf8")
            .on("data", (chunk: string) => (stderr += chunk));
          child.once("error", reject);
          child.once("close", (code) =>
            resolve({ code: code ?? -1, stdout, stderr }),
          );
          child.stdin.end(input);
        },
      );
    const on = await run(
      [
        "sync",
        "webdav",
        "on",
        `${storage.url}/dav`,
        `user=${DAV_USER}`,
        "agents=no",
      ],
      `${DAV_PASSWORD}\n${PASSPHRASE}\n`,
    );
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /Sync to WebDAV .* as sync-user, every 3 min/);
    assert.match(on.stdout, /agent wirings not synced/);
    assert.match(on.stdout, /Note: The sync passphrase is kept/);
    assert.ok(storage.object(DAV_FILE));
    const status = await run(["sync", "status"], "");
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Last sync: (?!never)/);
    const refused = await run(["sync", "off"], "");
    assert.equal(refused.code, 4, refused.stderr);
    const off = await run(["sync", "off", "--yes"], "");
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /Sync is off/);
    for (const output of [on, status, refused, off])
      assert.doesNotMatch(
        output.stdout + output.stderr,
        new RegExp(`${DAV_PASSWORD}|${PASSPHRASE}|${KEY_A}`),
      );
  },
);

void test("sync carries no subscription provider and never removes one: sign-ins stay on their machine", async (t) => {
  const storage = await startFakeWebDav({
    user: DAV_USER,
    password: DAV_PASSWORD,
  });
  t.after(() => storage.close());
  const settings: SyncSettings = {
    kind: "webdav",
    url: `${storage.url}/dav`,
    user: DAV_USER,
    secret: DAV_PASSWORD,
    passphrase: PASSPHRASE,
  };
  const a = await machine(t, "subs-a");
  const b = await machine(t, "subs-b");
  await provider(a, "pa", KEY_A);
  await seedSubscription(a.dataDir, "chatgpt", "siwc");
  await a.client.sync.configure(settings);
  await a.client.sync.now();
  const first = await server(storage, DAV_FILE);
  assert.deepEqual(
    first.bundle.providers.map((item) => item.config.id),
    ["pa"],
  );

  // B joins with its own Copilot sign-in: the server's providers are
  // mirrored in, and B's sign-in stays.
  await seedSubscription(b.dataDir, "copilot", "copilot");
  await b.client.sync.configure(settings);
  assert.equal((await b.client.sync.now()).lastError, undefined);
  assert.deepEqual(await ids(b), ["copilot", "pa"]);
  // B's sign-in is not pushed either; a change on B goes up without it.
  await provider(b, "pb", KEY_B);
  await b.client.sync.now();
  assert.deepEqual(
    (await server(storage, DAV_FILE)).bundle.providers.map(
      (item) => item.config.id,
    ),
    ["pa", "pb"],
  );
  // A brings pb in and keeps its own ChatGPT sign-in.
  await a.client.sync.now();
  assert.deepEqual(await ids(a), ["chatgpt", "pa", "pb"]);
  assert.equal(
    (await a.client.providers.get("chatgpt")).credentials[0]?.account?.backend,
    "siwc",
  );
});
