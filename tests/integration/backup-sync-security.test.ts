// SPDX-License-Identifier: MIT
/**
 * The second security review's group G through `startHub`: redaction rules
 * that can backtrack without bound (M6) and search addresses with
 * credentials are refused at every entry point; crafted backups cannot
 * point keys at this machine's own secrets (M5); sync refuses an older
 * snapshot of the server's file (L8) and turns redaction off only from a
 * strictly newer one (L9).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { open, seal } from "@harnesshub/daemon/backup-envelope";
import {
  decodeBundle,
  encodeBundle,
  type BackupBundle,
} from "@harnesshub/daemon/backup";
import { startHub } from "@harnesshub/daemon/main";
import {
  HarnessHubError,
  type BackupEnvelope,
  type HarnessHubClient,
  type SyncSettings,
} from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeWebDav } from "../support/fake-storage.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only.
const PASSPHRASE = "synthetic security passphrase";
const SLOW = String.raw`(\w+\s?)+$`;

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  configDir: string;
  directory: string;
}

async function machine(t: TestContext, name: string): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(t, `hh-g-${name}-`);
  const dataDir = path.join(directory, "data");
  const configDir = path.join(directory, "config");
  const home = path.join(directory, "home");
  await mkdir(home);
  const hub = await startHub({
    dataDir,
    configDir,
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
  });
  defer(() => hub.server.close());
  return {
    client: await connectLocal({ dataDir, url: hub.url }),
    url: hub.url,
    dataDir,
    configDir,
    directory,
  };
}

/** `hh <args> --url … --data-dir …` against `on`, `input` on stdin. */
function hh(
  on: Machine,
  args: string[],
  input = "",
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(HH_ENTRY),
        ...args,
        "--url",
        on.url,
        "--data-dir",
        on.dataDir,
      ],
      { cwd: on.directory, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });
}

/** `backup` opened, changed by `change` and sealed again: what a crafted file holds. */
async function crafted(
  backup: BackupEnvelope,
  change: (bundle: BackupBundle) => void,
): Promise<BackupEnvelope> {
  const bundle = decodeBundle(await open(backup, PASSPHRASE));
  change(bundle);
  return (await seal(encodeBundle(bundle), PASSPHRASE)) as BackupEnvelope;
}

/** `backup` written to a file in `on`'s directory, for `hh restore`. */
async function saved(on: Machine, backup: BackupEnvelope): Promise<string> {
  const file = path.join(
    on.directory,
    `${Math.random().toString(36).slice(2)}.harnesshub-backup`,
  );
  await writeFile(file, JSON.stringify(backup));
  return file;
}

const invalid = (code: string) => (error: unknown) =>
  error instanceof HarnessHubError && error.code === code;

void test("redaction rules that can backtrack without bound and search addresses with credentials are refused everywhere (M6)", async (t) => {
  const a = await machine(t, "rules");
  const started = performance.now();
  await assert.rejects(
    a.client.gatewayFeatures.setRedaction({
      rules: [{ name: "slow", pattern: SLOW }],
    }),
    invalid("GATEWAY_FEATURES_INVALID"),
  );
  const cli = await hh(a, [
    "gateway",
    "redaction",
    "rule",
    "add",
    "slow",
    SLOW,
  ]);
  assert.notEqual(cli.code, 0);
  assert.match(cli.stdout, /can take too long/);
  await assert.rejects(
    a.client.gatewayFeatures.addSearch({
      kind: "searxng",
      baseUrl: "https://alice:secret@search.example",
    }),
    invalid("GATEWAY_FEATURES_INVALID"),
  );
  // A crafted backup or sync file carrying them does not open.
  await a.client.gatewayFeatures.setRedaction({
    rules: [{ name: "ticket", pattern: "TCK-[0-9]+" }],
  });
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: false,
  });
  const b = await machine(t, "rules-b");
  for (const change of [
    (bundle: BackupBundle) =>
      bundle.gatewayFeatures!.redaction.rules.push({
        name: "slow",
        pattern: SLOW,
      }),
    (bundle: BackupBundle) =>
      bundle.gatewayFeatures!.search.push({
        id: "search-9",
        kind: "searxng",
        baseUrl: "https://alice:secret@search.example",
      }),
  ])
    await assert.rejects(
      b.client.backup.restore({
        backup: await crafted(backup, change),
        passphrase: PASSPHRASE,
        dryRun: true,
      }),
      invalid("BACKUP_INVALID"),
    );
  // The daemon answered all along: nothing ran the pattern.
  assert.ok(performance.now() - started < 30_000);
  assert.deepEqual((await b.client.gatewayFeatures.get()).redaction.rules, []);
});

/** A machine with a provider whose key is read from the environment, and a search backend. */
async function withReferences(t: TestContext): Promise<Machine> {
  const a = await machine(t, "refs-a");
  await a.client.providers.create({
    id: "relay",
    kind: "custom",
    endpoints: { chat: "https://relay.example.test/v1" },
    models: { source: "manual", list: [{ id: "m" }], expose: "all" },
    credential: { ref: { kind: "env", value: "SYNTH_RELAY_KEY" } },
  });
  await a.client.gatewayFeatures.addSearch({
    kind: "tavily",
    key: "tvly-synthetic-g-0001",
  });
  return a;
}

void test("a crafted backup cannot point a search key at any secret of this machine: only stored keys come in (M5)", async (t) => {
  const a = await withReferences(t);
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: true,
  });
  const b = await machine(t, "refs-b");
  const evil = await crafted(backup, (bundle) => {
    bundle.gatewayFeatures!.search = [
      {
        id: "search-8",
        kind: "brave",
        baseUrl: "https://collector.example.test",
        key: {
          source: "reference",
          kind: "file",
          name: path.join(b.dataDir, "admin.token"),
        },
      },
      {
        id: "search-9",
        kind: "exa",
        key: { source: "reference", kind: "env", name: "OPENAI_API_KEY" },
      },
      ...bundle.gatewayFeatures!.search,
    ];
  });
  const preview = await b.client.backup.restore({
    backup: evil,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(preview.gatewayFeatures?.search.added, ["tavily"]);
  assert.deepEqual(preview.gatewayFeatures?.search.refused, [
    `brave https://collector.example.test: its key would be read from the file ${path.join(b.dataDir, "admin.token")}; only keys stored in HarnessHub are restored`,
    "exa: its key would be read from the environment variable OPENAI_API_KEY; only keys stored in HarnessHub are restored",
  ]);
  await b.client.backup.restore({
    backup: evil,
    passphrase: PASSPHRASE,
    references: true,
  });
  assert.deepEqual(
    (await b.client.gatewayFeatures.get()).search?.backends.map(
      (item) => item.kind,
    ),
    ["tavily"],
  );
  const cli = await hh(
    b,
    ["restore", await saved(b, evil), "--yes", "--allow-references"],
    `${PASSPHRASE}\n`,
  );
  assert.equal(cli.code, 0, cli.stdout);
  assert.match(
    cli.stdout,
    /Search backends not restored: brave https:\/\/collector\.example\.test: its key would be read from the file/,
  );
});

void test("provider keys read from outside HarnessHub need confirming; its own files and variables are never read (M5)", async (t) => {
  const a = await withReferences(t);
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: true,
  });
  const b = await machine(t, "refs-c");
  const evil = await crafted(backup, (bundle) => {
    const relay = bundle.providers.find((item) => item.config.id === "relay")!;
    relay.config.endpoints = { chat: "https://collector.example.test/v1" };
    relay.credentials.push(
      {
        id: "admin" as never,
        name: "admin",
        enabled: true,
        secret: {
          source: "reference",
          kind: "file",
          name: path.join(b.dataDir, "admin.token"),
        },
      },
      {
        id: "master" as never,
        name: "master",
        enabled: true,
        secret: {
          source: "reference",
          kind: "file",
          name: path.join(b.configDir, "secrets.key"),
        },
      },
      {
        id: "own-env" as never,
        name: "own-env",
        enabled: true,
        secret: {
          source: "reference",
          kind: "env",
          name: "HARNESSHUB_ADMIN_TOKEN",
        },
      },
    );
  });
  const preview = await b.client.backup.restore({
    backup: evil,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  // The preview says which keys are references, to what, and where they go.
  assert.deepEqual(preview.providers.references, [
    {
      provider: "relay",
      credential: "key-1",
      kind: "env",
      name: "SYNTH_RELAY_KEY",
      hosts: ["collector.example.test"],
    },
  ]);
  assert.deepEqual(
    preview.providers.refused.map((item) => [item.credential, item.kind]),
    [
      ["admin", "file"],
      ["master", "file"],
      ["own-env", "env"],
    ],
  );
  assert.match(preview.providers.refused[0]!.reason, /data directory/);
  assert.match(preview.providers.refused[1]!.reason, /configuration directory/);
  assert.match(
    preview.providers.refused[2]!.reason,
    /HarnessHub's own environment variables/,
  );
  // Not without saying so.
  await assert.rejects(
    b.client.backup.restore({ backup: evil, passphrase: PASSPHRASE }),
    invalid("BACKUP_REFERENCES"),
  );
  assert.deepEqual((await b.client.providers.list()).items, []);
  const file = await saved(b, evil);
  const refused = await hh(b, ["restore", file, "--yes"], `${PASSPHRASE}\n`);
  assert.equal(refused.code, 4, refused.stdout);
  assert.match(
    refused.stdout,
    /relay\/key-1: key read from the environment variable SYNTH_RELAY_KEY, sent to collector\.example\.test/,
  );
  assert.match(refused.stdout, /--allow-references/);
  assert.deepEqual((await b.client.providers.list()).items, []);
  const done = await hh(
    b,
    ["restore", file, "--yes", "--allow-references"],
    `${PASSPHRASE}\n`,
  );
  assert.equal(done.code, 0, done.stdout);
  const relay = (await b.client.providers.list()).items.find(
    (item) => item.id === "relay",
  )!;
  // Its own files and variables never, even confirmed.
  assert.deepEqual(
    relay.credentials.map((item) => [item.id, item.ref]),
    [["key-1", { kind: "env", value: "SYNTH_RELAY_KEY" }]],
  );
  // The same references again: nothing new to confirm.
  const again = await b.client.backup.restore({
    backup: evil,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(again.providers.references, []);
  await b.client.backup.restore({ backup: evil, passphrase: PASSPHRASE });
});

const DAV_USER = "sync-user";
const DAV_PASSWORD = "synthetic-dav-password";
const SYNC_FILE = "/dav/harnesshub/harnesshub.harnesshub-backup";

/** Two machines syncing through one fake WebDAV folder. */
async function syncing(t: TestContext) {
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
  const a = await machine(t, "sync-a");
  const b = await machine(t, "sync-b");
  await a.client.sync.configure(settings);
  await b.client.sync.configure(settings);
  /** Puts `data` on the server as someone with write access to it could. */
  const replace = async (data: Buffer) => {
    const response = await fetch(`${storage.url}${SYNC_FILE}`, {
      method: "PUT",
      headers: {
        authorization: `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASSWORD}`).toString("base64")}`,
      },
      body: data,
    });
    assert.ok(response.ok, String(response.status));
  };
  return { storage, a, b, replace };
}

const rules = async (on: Machine) =>
  (await on.client.gatewayFeatures.get()).redaction.rules.map(
    (rule) => rule.name,
  );

void test("sync refuses an older copy of the server's file put back in place, unless told to take it (L8)", async (t) => {
  const { storage, a, b, replace } = await syncing(t);
  await a.client.gatewayFeatures.setRedaction({
    rules: [{ name: "first", pattern: "FIRST-[0-9]+" }],
  });
  assert.equal((await a.client.sync.now()).lastError, undefined);
  const old = storage.object(SYNC_FILE)!.data;
  await a.client.gatewayFeatures.setRedaction({
    rules: [
      { name: "first", pattern: "FIRST-[0-9]+" },
      { name: "second", pattern: "SECOND-[0-9]+" },
    ],
  });
  assert.equal((await a.client.sync.now()).lastError, undefined);
  assert.equal((await b.client.sync.now()).lastError, undefined);
  assert.deepEqual(await rules(b), ["first", "second"]);

  // Someone with write access to the folder, but not the passphrase, puts
  // the older file back: it opens, so only its age gives it away.
  await replace(old);
  await assert.rejects(b.client.sync.now(), invalid("SYNC_ROLLBACK"));
  const status = await b.client.sync.status();
  assert.match(status.lastError ?? "", /older/);
  assert.equal(status.lastErrorCode, "SYNC_ROLLBACK");
  assert.deepEqual(await rules(b), ["first", "second"], "nothing was taken");
  await assert.rejects(a.client.sync.now(), invalid("SYNC_ROLLBACK"));
  const cli = await hh(b, ["sync", "status"]);
  assert.match(cli.stdout, /hh sync now --accept-older/);

  // Told to, B takes it, and what it writes back is newer than both.
  const taken = await hh(b, ["sync", "now", "--accept-older"]);
  assert.equal(taken.code, 0, taken.stdout);
  assert.equal((await b.client.sync.status()).lastErrorCode, undefined);
  assert.deepEqual(await rules(b), ["first"]);
  assert.equal((await a.client.sync.now()).lastError, undefined);
  assert.deepEqual(await rules(a), ["first"]);
});

void test("sync turns redaction off only from settings strictly newer than this machine's; otherwise it asks (L9)", async (t) => {
  const { a, b } = await syncing(t);
  assert.equal((await a.client.sync.now()).lastError, undefined);
  assert.equal((await b.client.sync.now()).lastError, undefined);
  // A turns redaction off; B changes its features after that, but A's push
  // comes later still, so B takes A's part in the conflict.
  await a.client.gatewayFeatures.setRedaction({ enabled: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await b.client.gatewayFeatures.setRedaction({
    rules: [{ name: "late", pattern: "LATE-[0-9]+" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await a.client.sync.now()).lastError, undefined);
  const held = await b.client.sync.now();
  assert.equal(held.lastError, undefined);
  assert.deepEqual(held.notice?.here, ["features"]);
  assert.equal(held.notice?.redactionOff, undefined);
  assert.equal(held.notice?.redactionOffHeld, true);
  assert.equal(
    (await b.client.gatewayFeatures.get()).redaction.enabled,
    true,
    "older settings do not turn it off",
  );
  const cli = await hh(b, ["sync", "status"]);
  assert.match(cli.stdout, /redaction stays on here/);
  assert.match(cli.stdout, /hh gateway redaction off/);

  // Turned off later than this machine's last change: it applies, and says so.
  await a.client.gatewayFeatures.setRedaction({ enabled: true });
  assert.equal((await a.client.sync.now()).lastError, undefined);
  assert.equal((await b.client.sync.now()).lastError, undefined);
  await a.client.gatewayFeatures.setRedaction({ enabled: false });
  assert.equal((await a.client.sync.now()).lastError, undefined);
  const off = await b.client.sync.now();
  assert.equal(off.notice?.redactionOff, true);
  assert.equal((await b.client.gatewayFeatures.get()).redaction.enabled, false);
});
