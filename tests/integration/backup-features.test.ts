// SPDX-License-Identifier: MIT
/**
 * The gateway's features in backups and sync, through `startHub`: redaction
 * (its switch and rules), the vision model and the search backends with
 * their keys, restored on a fresh data directory with and without keys,
 * from a backup made before the part existed, and synced between two
 * daemons through a fake WebDAV server, a conflict included.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { open, parseEnvelope, seal } from "@harnesshub/daemon/backup-envelope";
import { decodeBundle, encodeBundle } from "@harnesshub/daemon/backup";
import { startHub } from "@harnesshub/daemon/main";
import type {
  BackupEnvelope,
  HarnessHubClient,
  SyncSettings,
} from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeWebDav } from "../support/fake-storage.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only.
const PASSPHRASE = "synthetic backup passphrase";
const TAVILY_KEY = "tvly-synthetic-search-key-0001";
const OTHER_KEY = "tvly-synthetic-search-key-0002";
const PROVIDER_KEY = "sk-synthetic-features-0003";
const SEARXNG = "https://search.example.test";
const DAV_USER = "sync-user";
const DAV_PASSWORD = "synthetic-dav-password";
const RULE = { name: "TICKET", pattern: "TCK-[0-9]{6}" };

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  directory: string;
}

async function machine(t: TestContext, name: string): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(
    t,
    `hh-features-${name}-`,
  );
  const dataDir = path.join(directory, "data");
  const home = path.join(directory, "home");
  await mkdir(home);
  const hub = await startHub({
    dataDir,
    configDir: path.join(directory, "config"),
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
    catalog: { autoRefresh: false },
    // A home with no agents: the Library sync after a restore finds none.
    wiringHome: { home, env: { PATH: path.join(directory, "bin") } },
  });
  defer(() => hub.server.close());
  return {
    client: await connectLocal({ dataDir, url: hub.url }),
    url: hub.url,
    dataDir,
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

/** A machine with redaction off and a rule, a vision model, two search backends and a usage alert. */
async function configured(t: TestContext): Promise<Machine> {
  const a = await machine(t, "a");
  await a.client.providers.create({
    id: "seer",
    kind: "custom",
    endpoints: { chat: "https://upstream.invalid/v1" },
    models: { source: "manual", list: [{ id: "eyes" }], expose: "all" },
    credential: { value: PROVIDER_KEY },
  });
  await a.client.gatewayFeatures.setRedaction({
    enabled: false,
    rules: [RULE],
  });
  await a.client.gatewayFeatures.setVision("seer/eyes");
  await a.client.gatewayFeatures.addSearch({ kind: "tavily", key: TAVILY_KEY });
  await a.client.gatewayFeatures.addSearch({
    kind: "searxng",
    baseUrl: SEARXNG,
  });
  await a.client.gatewayFeatures.setAlerts(75);
  return a;
}

/** The backup's gateway features as they were sealed. */
async function carried(envelope: BackupEnvelope) {
  return decodeBundle(await open(envelope, PASSPHRASE)).gatewayFeatures;
}

/** A search backend's key as this machine would carry it in a backup. */
async function searchKey(
  on: Machine,
  kind: string,
): Promise<string | undefined> {
  const features = await carried(
    await on.client.backup.create({ passphrase: PASSPHRASE, keys: true }),
  );
  const key = features?.search.find((item) => item.kind === kind)?.key;
  return key?.source === "store" ? key.value : undefined;
}

void test("a backup carries the gateway features, and a restore on a fresh machine shows and applies them, redaction turned off called out", async (t) => {
  const a = await configured(t);
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: true,
  });
  const part = await carried(backup);
  assert.ok(part?.updatedAt, "the time of the last change travels");
  assert.deepEqual(
    { ...part, updatedAt: undefined },
    {
      updatedAt: undefined,
      redaction: { enabled: false, rules: [RULE] },
      vision: { model: "seer/eyes" },
      search: [
        {
          id: "search-1",
          kind: "tavily",
          key: { source: "store", value: TAVILY_KEY },
        },
        { id: "search-2", kind: "searxng", baseUrl: SEARXNG },
      ],
      alerts: { usagePercent: 75 },
    },
  );

  const b = await machine(t, "b");
  const dry = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(dry.gatewayFeatures, {
    redaction: { enabled: false, turnsOff: true, turnsOn: false },
    rules: { added: ["TICKET"], replaced: [], removed: [] },
    vision: { model: "seer/eyes", changed: true },
    search: {
      added: ["tavily", `searxng ${SEARXNG}`],
      replaced: [],
      removed: [],
      needKey: [],
      refused: [],
    },
    alerts: { usagePercent: 75, changed: true },
  });
  assert.equal(
    (await b.client.gatewayFeatures.get()).redaction.enabled,
    true,
    "a dry run writes nothing",
  );

  const done = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(done.gatewayFeatures, dry.gatewayFeatures);
  const restored = await b.client.gatewayFeatures.get();
  assert.deepEqual(restored.redaction, { enabled: false, rules: [RULE] });
  assert.deepEqual(restored.vision, { model: "seer/eyes" });
  assert.deepEqual(restored.alerts, { usagePercent: 75 });
  assert.deepEqual(
    restored.search?.backends.map((item) => [
      item.kind,
      item.baseUrl,
      item.hasKey,
    ]),
    [
      ["tavily", undefined, true],
      ["searxng", SEARXNG, false],
    ],
  );
  assert.equal(
    await searchKey(b, "tavily"),
    TAVILY_KEY,
    "the key went to B's secret store",
  );

  // hh restore says so before and after.
  const c = await machine(t, "c");
  const file = path.join(c.directory, "a.harnesshub-backup");
  await writeFile(file, JSON.stringify(backup));
  const cli = await hh(c, ["restore", file, "--yes"], `${PASSPHRASE}\n`);
  assert.equal(cli.code, 0, cli.stdout);
  assert.match(
    cli.stdout,
    /WARNING: outbound redaction will be turned OFF by this backup/,
  );
  assert.match(
    cli.stdout,
    /WARNING: outbound redaction was turned OFF by this backup/,
  );
  assert.match(
    cli.stdout,
    /Gateway features: redaction rules: added TICKET; search backends: added tavily, searxng/,
  );
  assert.match(cli.stdout, /usage alert: set at 75%/);

  // The same backup again changes nothing.
  const again = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(again.gatewayFeatures, {
    redaction: { enabled: false, turnsOff: false, turnsOn: false },
    rules: { added: [], replaced: [], removed: [] },
    vision: { model: "seer/eyes", changed: false },
    search: {
      added: [],
      replaced: [],
      removed: [],
      needKey: [],
      refused: [],
    },
    alerts: { usagePercent: 75, changed: false },
  });
});

void test("without keys a search backend keeps this machine's key, or is listed as needing one and left out", async (t) => {
  const a = await configured(t);
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: false,
  });
  const part = await carried(backup);
  assert.deepEqual(part?.search[0]?.key, { source: "store" });
  assert.doesNotMatch(JSON.stringify(part), new RegExp(TAVILY_KEY));

  // A fresh machine has no key for it.
  const fresh = await machine(t, "fresh");
  const summary = await fresh.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(summary.gatewayFeatures?.search, {
    added: [`searxng ${SEARXNG}`],
    replaced: [],
    removed: [],
    needKey: ["tavily"],
    refused: [],
  });
  assert.deepEqual(
    (await fresh.client.gatewayFeatures.get()).search?.backends.map(
      (item) => item.kind,
    ),
    ["searxng"],
  );

  // A machine with its own Tavily key keeps it, and its other backends stay.
  const b = await machine(t, "b");
  await b.client.gatewayFeatures.addSearch({ kind: "tavily", key: OTHER_KEY });
  await b.client.gatewayFeatures.addSearch({ kind: "brave", key: OTHER_KEY });
  const kept = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(kept.gatewayFeatures?.search.needKey, []);
  assert.deepEqual(kept.gatewayFeatures?.search.added, [`searxng ${SEARXNG}`]);
  assert.deepEqual(
    (await b.client.gatewayFeatures.get()).search?.backends.map((item) => [
      item.id,
      item.kind,
    ]),
    [
      ["search-1", "tavily"],
      ["search-2", "brave"],
      ["search-3", "searxng"],
    ],
  );
  assert.equal(await searchKey(b, "tavily"), OTHER_KEY);
});

void test("a vision model whose provider is not here after the restore is reported and set; an old backup leaves the features alone", async (t) => {
  const a = await configured(t);
  await a.client.gatewayFeatures.setVision("elsewhere/eyes");
  const backup = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: true,
  });
  const b = await machine(t, "b");
  const summary = await b.client.backup.restore({
    backup,
    passphrase: PASSPHRASE,
  });
  assert.deepEqual(summary.gatewayFeatures?.vision, {
    model: "elsewhere/eyes",
    changed: true,
    unresolved: "there is no provider elsewhere",
  });
  assert.deepEqual((await b.client.gatewayFeatures.get()).vision, {
    model: "elsewhere/eyes",
  });

  // A backup made before the part existed: the same bundle without it.
  const bundle = decodeBundle(await open(backup, PASSPHRASE));
  delete bundle.gatewayFeatures;
  const old = await seal(encodeBundle(bundle), PASSPHRASE);
  const c = await machine(t, "c");
  await c.client.gatewayFeatures.addSearch({ kind: "brave", key: OTHER_KEY });
  const before = await c.client.gatewayFeatures.get();
  const restored = await c.client.backup.restore({
    backup: old,
    passphrase: PASSPHRASE,
  });
  assert.equal(restored.gatewayFeatures, null);
  assert.deepEqual(
    (await c.client.providers.list()).items.map((item) => item.id),
    ["seer"],
  );
  assert.deepEqual(await c.client.gatewayFeatures.get(), before);
});

void test("sync carries the gateway features as their own part: brought in with keys, redaction off called out, a conflict keeps the later side", async (t) => {
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
  const a = await configured(t);
  await a.client.sync.configure(settings);
  assert.equal((await a.client.sync.now()).lastError, undefined);

  // B joins: the features come in, the key with them, and B is told that
  // redaction is now off.
  const b = await machine(t, "b");
  await b.client.sync.configure(settings);
  const joined = await b.client.sync.now();
  assert.equal(joined.lastError, undefined);
  assert.equal(joined.notice?.redactionOff, true);
  const brought = await b.client.gatewayFeatures.get();
  assert.deepEqual(brought.redaction, { enabled: false, rules: [RULE] });
  assert.deepEqual(brought.vision, { model: "seer/eyes" });
  assert.deepEqual(
    brought.search?.backends.map((item) => [item.id, item.kind, item.hasKey]),
    [
      ["search-1", "tavily", true],
      ["search-2", "searxng", false],
    ],
  );
  assert.equal(await searchKey(b, "tavily"), TAVILY_KEY);
  assert.match(
    (await hh(b, ["sync", "status"])).stdout,
    /WARNING: the server's gateway features turned outbound redaction OFF here/,
  );

  // A removal on B is mirrored on A.
  await b.client.gatewayFeatures.removeSearch("search-2");
  await b.client.sync.now();
  const mirrored = await a.client.sync.now();
  assert.equal(mirrored.lastError, undefined);
  assert.equal(
    mirrored.notice?.redactionOff,
    undefined,
    "A turned it off itself",
  );
  assert.deepEqual(
    (await a.client.gatewayFeatures.get()).search?.backends.map(
      (item) => item.kind,
    ),
    ["tavily"],
  );

  // Both change them; B's change is the later one and wins, and the
  // server's copy it replaced is kept beside B's data.
  await a.client.gatewayFeatures.setRedaction({ enabled: true });
  await a.client.sync.now();
  await delay(20);
  await b.client.gatewayFeatures.setVision("seer/other");
  const conflict = await b.client.sync.now();
  assert.deepEqual(conflict.notice?.there, ["features"]);
  assert.deepEqual(conflict.notice?.here, []);
  const saved = await readdir(path.join(b.dataDir, "sync", "conflicts"));
  assert.ok(saved.some((name) => /-server\.harnesshub-backup$/.test(name)));
  await a.client.sync.now();
  const settled = await a.client.gatewayFeatures.get();
  assert.deepEqual(settled.vision, { model: "seer/other" });
  assert.equal(
    settled.redaction.enabled,
    false,
    "B's side, redaction off, replaced A's",
  );

  // A backend removed on B goes from A, and A's key for it from A's store.
  const secretsOf = async (on: Machine) =>
    (await readdir(path.join(on.dataDir, "secrets", "v1"))).length;
  const before = await secretsOf(a);
  await b.client.gatewayFeatures.removeSearch("search-1");
  await b.client.sync.now();
  assert.equal((await a.client.sync.now()).lastError, undefined);
  assert.equal((await a.client.gatewayFeatures.get()).search, undefined);
  assert.equal(await secretsOf(a), before - 1);

  // The server only ever held ciphertext.
  const stored = storage.object("/dav/harnesshub/harnesshub.harnesshub-backup");
  assert.ok(stored);
  assert.doesNotMatch(stored.data.toString("utf8"), new RegExp(TAVILY_KEY));
  const opened = decodeBundle(
    await open(parseEnvelope(stored.data), PASSPHRASE),
  );
  assert.equal(opened.gatewayFeatures?.vision?.model, "seer/other");
  assert.deepEqual(opened.gatewayFeatures?.search, []);
});
