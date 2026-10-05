// SPDX-License-Identifier: MIT
/**
 * One rule for HarnessHub's own secrets (daemon/secret-refs.ts), checked
 * with the same cases where it applies: the rule itself, a Library tool's
 * secret reference, and a provider credential in a restored backup.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { open, seal } from "@harnesshub/daemon/backup-envelope";
import { decodeBundle, encodeBundle } from "@harnesshub/daemon/backup";
import { startHub } from "@harnesshub/daemon/main";
import { ownSecretProblem } from "@harnesshub/daemon/secret-refs";
import { HarnessHubError, type BackupEnvelope } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { temporaryDirectory } from "../support/temporary.js";

const PASSPHRASE = "synthetic secret-refs passphrase";

interface Case {
  why: string;
  ref: { kind: "env" | "file"; value: string };
  /** What the refusal names; undefined for a reference of the user's own. */
  refused?: RegExp;
}

/** The cases, with HarnessHub's directories and an outside one the user owns. */
function cases(dataDir: string, configDir: string, outside: string): Case[] {
  const own = /HarnessHub's own environment variables/;
  return [
    {
      why: "an HH_ variable",
      ref: { kind: "env", value: "HH_ADMIN_TOKEN" },
      refused: own,
    },
    {
      why: "an hh_ variable in lower case",
      ref: { kind: "env", value: "hh_token" },
      refused: own,
    },
    {
      why: "a HARNESSHUB_ variable",
      ref: { kind: "env", value: "HARNESSHUB_SECRET" },
      refused: own,
    },
    {
      why: "the admin token",
      ref: { kind: "file", value: path.join(dataDir, "admin.token") },
      refused: /data directory/,
    },
    {
      why: "the data directory itself",
      ref: { kind: "file", value: dataDir },
      refused: /data directory/,
    },
    {
      why: "a path out and back into the data directory",
      ref: {
        kind: "file",
        value: path.join(dataDir, "..", path.basename(dataDir), "admin.token"),
      },
      refused: /data directory/,
    },
    {
      why: "a link into the data directory",
      ref: { kind: "file", value: path.join(outside, "link.token") },
      refused: /data directory/,
    },
    {
      why: "the secret store's master key",
      ref: { kind: "file", value: path.join(configDir, "secrets.key") },
      refused: /configuration directory/,
    },
    {
      why: "a variable of the user's",
      ref: { kind: "env", value: "MY_TOOL_TOKEN" },
    },
    {
      why: "a file of the user's",
      ref: { kind: "file", value: path.join(outside, "tool.token") },
    },
  ];
}

void test("HarnessHub's own variables and files are refused alike by the rule, the Library and a restore", async (t) => {
  const { directory, defer } = await temporaryDirectory(t, "hh-secret-refs-");
  const dataDir = path.join(directory, "data");
  const configDir = path.join(directory, "config");
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "tool.token"), "synthetic", {
    mode: 0o600,
  });
  const hub = await startHub({
    dataDir,
    configDir,
    secretsBackend: "file",
    demo: true,
    cwd: directory,
    port: 0,
    host: "127.0.0.1",
  });
  defer(() => hub.server.close());
  await symlink(
    path.join(dataDir, "admin.token"),
    path.join(outside, "link.token"),
  );
  const client = await connectLocal({ dataDir, url: hub.url });
  const table = cases(dataDir, configDir, outside);

  // The rule itself.
  for (const item of table) {
    const problem = await ownSecretProblem(item.ref, { dataDir, configDir });
    if (item.refused) assert.match(problem ?? "", item.refused, item.why);
    else assert.equal(problem, undefined, item.why);
  }

  // A Library tool's secret: refused with the same reason, or kept.
  for (const [index, item] of table.entries()) {
    const created = client.library.mcp.create(`tool-${index}`, {
      transport: "stdio",
      command: "tool",
      secretEnv: { TOKEN: item.ref },
    });
    if (!item.refused) {
      assert.deepEqual(
        (await created).secretEnv,
        { TOKEN: item.ref },
        item.why,
      );
      continue;
    }
    await assert.rejects(created, (error: unknown) => {
      assert.ok(error instanceof HarnessHubError, item.why);
      assert.equal(error.code, "SECRET_REF_FORBIDDEN", item.why);
      assert.match(JSON.stringify(error.problem), item.refused!, item.why);
      return true;
    });
  }

  // A provider credential in a restored backup: refused with the same
  // reason, or listed as a reference to confirm.
  await client.providers.create({
    id: "relay",
    kind: "custom",
    endpoints: { chat: "https://relay.example.test/v1" },
    models: { source: "manual", list: [{ id: "m" }], expose: "all" },
    credential: { value: "sk-synthetic-secret-refs-0001" },
  });
  const backup = await client.backup.create({
    passphrase: PASSPHRASE,
    keys: false,
  });
  const bundle = decodeBundle(await open(backup, PASSPHRASE));
  const relay = bundle.providers.find((item) => item.config.id === "relay")!;
  relay.config = { ...relay.config, id: "crafted" as typeof relay.config.id };
  relay.credentials = table.map((item, index) => ({
    id: `c${index}` as (typeof relay.credentials)[number]["id"],
    name: `c${index}`,
    enabled: true,
    secret: { source: "reference", kind: item.ref.kind, name: item.ref.value },
  }));
  const crafted = (await seal(
    encodeBundle(bundle),
    PASSPHRASE,
  )) as BackupEnvelope;
  const preview = await client.backup.restore({
    backup: crafted,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  for (const [index, item] of table.entries()) {
    const refused = preview.providers.refused.find(
      (entry) => entry.credential === `c${index}`,
    );
    const listed = preview.providers.references.find(
      (entry) => entry.credential === `c${index}`,
    );
    if (item.refused) {
      assert.match(refused?.reason ?? "", item.refused, item.why);
      assert.equal(listed, undefined, item.why);
    } else {
      assert.equal(refused, undefined, item.why);
      assert.deepEqual(
        listed && [listed.kind, listed.name],
        [item.ref.kind, item.ref.value],
        item.why,
      );
    }
  }
});
