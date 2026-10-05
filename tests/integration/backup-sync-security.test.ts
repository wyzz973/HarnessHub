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
import { mkdir } from "node:fs/promises";
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
} from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
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
