// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { HubError } from "@harnesshub/core/errors";
import type {
  ProcessLauncher,
  ProcessRun,
} from "@harnesshub/core/process-launcher";
import {
  SecretStore,
  selectSecretBackend,
  type SecretBackendSetting,
} from "../src/secret-store.js";
import { resolveSecret } from "../src/secrets.js";

const posix =
  process.platform === "win32" ? "POSIX modes do not apply on Windows" : false;
const native =
  process.platform === "darwin"
    ? "keychain"
    : process.platform === "win32"
      ? "dpapi"
      : undefined;

async function roots(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "harnesshub-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const configDir = path.join(root, "config");
  return {
    dataDir,
    configDir,
    entries: path.join(dataDir, "secrets", "v1"),
    keyFile: path.join(configDir, "secrets.key"),
    entry: (id: string) => path.join(dataDir, "secrets", "v1", `${id}.json`),
  };
}

function fails(code: string, stage?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HubError, String(error));
    assert.equal(error.code, code);
    if (stage !== undefined)
      assert.deepEqual(error.cause, { stage }, JSON.stringify(error.cause));
    return true;
  };
}

async function json(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

void test("the backend follows the platform and never falls back silently", () => {
  const cases: Array<[SecretBackendSetting, NodeJS.Platform, string]> = [
    ["auto", "darwin", "keychain"],
    ["auto", "win32", "dpapi"],
    ["auto", "linux", "file"],
    ["auto", "freebsd", "file"],
    ["file", "darwin", "file"],
    ["file", "win32", "file"],
    ["keychain", "darwin", "keychain"],
    ["dpapi", "win32", "dpapi"],
  ];
  for (const [setting, platform, expected] of cases)
    assert.equal(selectSecretBackend(setting, platform), expected);
  for (const [setting, platform] of [
    ["keychain", "linux"],
    ["keychain", "win32"],
    ["dpapi", "darwin"],
  ] as const)
    assert.throws(
      () => selectSecretBackend(setting, platform),
      fails("SECRET_BACKEND_UNAVAILABLE"),
    );
});

void test("the encrypted file backend round-trips, rotates under the same reference and deletes", async (t) => {
  const dirs = await roots(t);
  const store = await SecretStore.open({ ...dirs, backend: "file" });
  assert.equal(store.backend, "file");
  const value = `sk-synthetic-${randomBytes(12).toString("hex")}`;
  const ref = await store.create(value);
  assert.equal(ref.kind, "store");
  assert.match(ref.value, /^[0-9a-f-]{36}$/);
  assert.equal(await store.resolve(ref, {}), value);

  // Only ciphertext and metadata reach the disk.
  const entryText = await readFile(dirs.entry(ref.value), "utf8");
  assert.equal(entryText.includes(value), false);
  const entry = await json(dirs.entry(ref.value));
  assert.equal(entry.backend, "file");
  assert.equal(entry.alg, "A256GCM");
  assert.equal(entry.version, 1);
  assert.match(
    String(await readFile(dirs.keyFile, "utf8")),
    /^[A-Za-z0-9+/]{43}=\n$/,
  );

  // A new process (a new store on the same roots) reads it with the stored key.
  const reopened = await SecretStore.open({ ...dirs, backend: "file" });
  assert.equal(await reopened.resolve(ref, {}), value);

  const rotated = `${value}-rotated`;
  await reopened.rotate(ref, rotated);
  assert.equal(await store.resolve(ref, {}), rotated);
  const after = await json(dirs.entry(ref.value));
  assert.equal(after.version, 2);
  assert.equal(after.createdAt, entry.createdAt);
  assert.equal(typeof after.rotatedAt, "string");
  assert.notEqual(after.nonce, entry.nonce);
  // No temporary files are left behind.
  assert.deepEqual(await readdir(dirs.entries), [`${ref.value}.json`]);

  // UTF-8 values up to exactly 8 KiB; anything else is refused.
  const multibyte = "密钥-🔑-".padEnd(100, "x");
  assert.equal(
    await store.resolve(await store.create(multibyte), {}),
    multibyte,
  );
  const largest = "k".repeat(8192);
  assert.equal(await store.resolve(await store.create(largest), {}), largest);
  for (const invalid of ["", "   ", "a\nb", "a\rb", "a\0b", "k".repeat(8193)]) {
    await assert.rejects(store.create(invalid), fails("INVALID_SECRET"));
    await assert.rejects(store.rotate(ref, invalid), fails("INVALID_SECRET"));
  }
  assert.equal(await store.resolve(ref, {}), rotated);

  assert.equal(await store.delete(ref), true);
  await assert.rejects(
    store.resolve(ref, {}),
    fails("SECRET_UNAVAILABLE", "missing"),
  );
  assert.equal(await store.delete(ref), false);
  await assert.rejects(
    store.rotate(ref, "next-value"),
    fails("SECRET_UNAVAILABLE", "missing"),
  );
});

void test("a wrong master key, a tampered entry or a swapped entry is rejected", async (t) => {
  const dirs = await roots(t);
  const store = await SecretStore.open({ ...dirs, backend: "file" });
  const first = await store.create("synthetic-first-value");
  const second = await store.create("synthetic-second-value");
  const original = await readFile(dirs.entry(first.value), "utf8");
  const parsed = JSON.parse(original) as Record<string, string | number>;

  const tamper = async (patch: Record<string, string | number>) => {
    await writeFile(
      dirs.entry(first.value),
      JSON.stringify({ ...parsed, ...patch }),
      { mode: 0o600 },
    );
  };
  const flip = (text: string) => {
    const bytes = Buffer.from(text, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    return bytes.toString("base64url");
  };
  for (const patch of [
    { ct: flip(String(parsed.ct)) },
    { tag: flip(String(parsed.tag)) },
    { nonce: flip(String(parsed.nonce)) },
    // The version is authenticated: replaying the entry as another version fails.
    { version: 2 },
  ]) {
    await tamper(patch);
    await assert.rejects(
      store.resolve(first, {}),
      fails("SECRET_UNAVAILABLE", "decrypt"),
      JSON.stringify(Object.keys(patch)),
    );
  }
  // A ciphertext moved to another secret's entry does not decrypt there.
  const other = await json(dirs.entry(second.value));
  await writeFile(
    dirs.entry(first.value),
    JSON.stringify({ ...other, id: first.value }),
    { mode: 0o600 },
  );
  await assert.rejects(
    store.resolve(first, {}),
    fails("SECRET_UNAVAILABLE", "decrypt"),
  );
  // Malformed entries are refused before decryption.
  for (const malformed of [
    "not json",
    JSON.stringify({ ...parsed, id: second.value }),
    JSON.stringify({ ...parsed, alg: "A128GCM" }),
    JSON.stringify({ ...parsed, tag: Buffer.alloc(8).toString("base64url") }),
  ]) {
    await writeFile(dirs.entry(first.value), malformed, { mode: 0o600 });
    await assert.rejects(
      store.resolve(first, {}),
      fails("SECRET_UNAVAILABLE", "entry"),
    );
  }
  await writeFile(dirs.entry(first.value), original, { mode: 0o600 });
  assert.equal(await store.resolve(first, {}), "synthetic-first-value");

  // Another master key cannot read the entries.
  await writeFile(dirs.keyFile, `${randomBytes(32).toString("base64")}\n`, {
    mode: 0o600,
  });
  const rekeyed = await SecretStore.open({ ...dirs, backend: "file" });
  await assert.rejects(
    rekeyed.resolve(first, {}),
    fails("SECRET_UNAVAILABLE", "key"),
  );
  // A key file that is not 32 base64 bytes is refused.
  for (const bad of ["short\n", `${randomBytes(31).toString("base64")}\n`]) {
    await writeFile(dirs.keyFile, bad, { mode: 0o600 });
    const broken = await SecretStore.open({ ...dirs, backend: "file" });
    await assert.rejects(
      broken.resolve(first, {}),
      fails("SECRET_UNAVAILABLE", "key"),
    );
  }
  // Without a key file, reading fails rather than generating a new key.
  await rm(dirs.keyFile);
  const keyless = await SecretStore.open({ ...dirs, backend: "file" });
  await assert.rejects(
    keyless.resolve(first, {}),
    fails("SECRET_UNAVAILABLE", "key"),
  );
  await assert.rejects(
    keyless.rotate(first, "synthetic-next"),
    fails("SECRET_UNAVAILABLE", "key"),
  );
});

void test(
  "key, entry and directory permissions are private",
  { skip: posix },
  async (t) => {
    const dirs = await roots(t);
    const store = await SecretStore.open({ ...dirs, backend: "file" });
    const ref = await store.create("synthetic-permission-value");
    assert.equal((await stat(dirs.keyFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirs.configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(dirs.entries)).mode & 0o777, 0o700);
    assert.equal((await stat(dirs.entry(ref.value))).mode & 0o777, 0o600);

    await chmod(dirs.entry(ref.value), 0o640);
    await assert.rejects(
      store.resolve(ref, {}),
      fails("SECRET_UNAVAILABLE", "permissions"),
    );
    await chmod(dirs.entry(ref.value), 0o600);

    await chmod(dirs.keyFile, 0o644);
    const exposedKey = await SecretStore.open({ ...dirs, backend: "file" });
    await assert.rejects(
      exposedKey.resolve(ref, {}),
      fails("SECRET_UNAVAILABLE", "permissions"),
    );
    await chmod(dirs.keyFile, 0o600);

    // A symbolic link in place of an entry is not followed.
    const target = path.join(dirs.dataDir, "elsewhere.json");
    await writeFile(target, await readFile(dirs.entry(ref.value)), {
      mode: 0o600,
    });
    await rm(dirs.entry(ref.value));
    await symlink(target, dirs.entry(ref.value));
    await assert.rejects(
      store.resolve(ref, {}),
      fails("SECRET_UNAVAILABLE", "open"),
    );

    await chmod(dirs.entries, 0o755);
    await assert.rejects(
      SecretStore.open({ ...dirs, backend: "file" }),
      fails("SECRET_STORE_INSECURE"),
    );
  },
);

void test("references are checked and other kinds resolve as before", async (t) => {
  const dirs = await roots(t);
  const store = await SecretStore.open({ ...dirs, backend: "file" });
  for (const value of ["../../config/secrets.key", "not-a-uuid", ""])
    await assert.rejects(
      store.resolve({ kind: "store", value }, {}),
      fails("SECRET_UNAVAILABLE", "reference"),
    );
  await assert.rejects(
    store.rotate({ kind: "env", value: "KEY" }, "synthetic-value"),
    fails("SECRET_UNAVAILABLE", "reference"),
  );
  assert.equal(
    await store.resolve(
      { kind: "env", value: "SYNTHETIC_KEY" },
      {
        SYNTHETIC_KEY: "synthetic-env-value",
      },
    ),
    "synthetic-env-value",
  );
  // The free function cannot resolve managed references.
  await assert.rejects(
    resolveSecret(await store.create("synthetic-value"), {}),
    fails("SECRET_STORE_REQUIRED"),
  );
});

void test("concurrent first uses share one master key and writes to one secret are serialized", async (t) => {
  const dirs = await roots(t);
  const store = await SecretStore.open({ ...dirs, backend: "file" });
  const other = await SecretStore.open({ ...dirs, backend: "file" });
  const refs = await Promise.all([
    store.create("synthetic-a"),
    store.create("synthetic-b"),
    other.create("synthetic-c"),
  ]);
  const reader = await SecretStore.open({ ...dirs, backend: "file" });
  assert.deepEqual(
    await Promise.all(refs.map((ref) => reader.resolve(ref, {}))),
    ["synthetic-a", "synthetic-b", "synthetic-c"],
  );
  assert.deepEqual(await readdir(dirs.configDir), ["secrets.key"]);

  const ref = await store.create("synthetic-v1");
  await Promise.all(
    [2, 3, 4, 5, 6].map((version) =>
      store.rotate(ref, `synthetic-v${version}`),
    ),
  );
  assert.equal(await store.resolve(ref, {}), "synthetic-v6");
  assert.equal((await json(dirs.entry(ref.value))).version, 6);
});

/**
 * A launcher that plays the platform helper's protocol in memory, so the
 * native backend runs without touching the real Keychain or DPAPI store.
 */
function fakeHelper() {
  const items = new Map<string, string>();
  const requests: Array<{
    operation: string;
    id: string;
    args: readonly string[];
  }> = [];
  const failing = new Set<string>();
  const launcher: ProcessLauncher = {
    launch: () => {
      throw new Error("The secret helper is only run to completion");
    },
    run: (spec: ProcessRun) => {
      const request = JSON.parse(String(spec.input)) as {
        operation: string;
        id: string;
        value?: string;
      };
      requests.push({
        operation: request.operation,
        id: request.id,
        args: spec.args,
      });
      const reply = (code: number, body: unknown) =>
        Promise.resolve({
          code,
          signal: null,
          timedOut: false,
          aborted: false,
          stdout: Buffer.from(JSON.stringify(body)),
          stderr: Buffer.alloc(0),
        });
      if (failing.has(request.operation))
        return reply(1, { error: "synthetic", stage: request.operation });
      switch (request.operation) {
        case "create":
          if (items.has(request.id)) return reply(1, { error: "exists" });
          items.set(request.id, request.value ?? "");
          return reply(0, { ok: true });
        case "read":
          return items.has(request.id)
            ? reply(0, { value: items.get(request.id) })
            : reply(1, { error: "missing", stage: "read" });
        case "delete":
          return items.delete(request.id)
            ? reply(0, { ok: true })
            : reply(1, { error: "missing", stage: "delete" });
        default:
          return reply(1, { error: "operation" });
      }
    },
  };
  return { launcher, items, requests, failing };
}

void test(
  "a native backend keeps values in helper items and rotates by switching items",
  {
    skip: native
      ? false
      : "the platform secret helper exists on macOS and Windows only",
  },
  async (t) => {
    if (!native) return;
    const dirs = await roots(t);
    await assert.rejects(
      SecretStore.open({ ...dirs, backend: native }),
      fails("SECRET_BACKEND_UNAVAILABLE"),
    );
    const helper = fakeHelper();
    const store = await SecretStore.open({
      ...dirs,
      backend: "auto",
      launcher: helper.launcher,
    });
    assert.equal(store.backend, native);

    const ref = await store.create("synthetic-native-v1");
    const entry = await json(dirs.entry(ref.value));
    assert.equal(entry.backend, native);
    assert.deepEqual([...helper.items.values()], ["synthetic-native-v1"]);
    assert.equal(entry.item, [...helper.items.keys()][0]);
    assert.equal(JSON.stringify(entry).includes("synthetic-native"), false);
    // Requests travel on stdin; argv carries nothing.
    assert.ok(helper.requests.every((request) => request.args.length === 0));
    assert.equal(await store.resolve(ref, {}), "synthetic-native-v1");
    // No master key is created for native secrets.
    await assert.rejects(stat(dirs.keyFile), { code: "ENOENT" });

    await store.rotate(ref, "synthetic-native-v2");
    assert.equal(await store.resolve(ref, {}), "synthetic-native-v2");
    assert.deepEqual([...helper.items.values()], ["synthetic-native-v2"]);
    const rotated = await json(dirs.entry(ref.value));
    assert.equal(rotated.version, 2);
    assert.notEqual(rotated.item, entry.item);
    assert.equal(rotated.retired, undefined);

    // A failed delete of the old item keeps the rotation and is retried later.
    helper.failing.add("delete");
    await store.rotate(ref, "synthetic-native-v3");
    assert.equal(await store.resolve(ref, {}), "synthetic-native-v3");
    const pending = await json(dirs.entry(ref.value));
    assert.deepEqual(pending.retired, [rotated.item]);
    assert.equal(helper.items.size, 2);
    // Deleting while the helper fails keeps the entry so it can be repeated.
    await assert.rejects(store.delete(ref), fails("SECRET_WRITE_FAILED"));
    assert.equal(await store.resolve(ref, {}), "synthetic-native-v3");
    helper.failing.delete("delete");
    await store.rotate(ref, "synthetic-native-v4");
    assert.deepEqual([...helper.items.values()], ["synthetic-native-v4"]);
    assert.equal((await json(dirs.entry(ref.value))).retired, undefined);

    // A failed helper create stores nothing and keeps the current value.
    helper.failing.add("create");
    await assert.rejects(
      store.create("synthetic-other"),
      fails("SECRET_WRITE_FAILED"),
    );
    await assert.rejects(
      store.rotate(ref, "synthetic-v5"),
      fails("SECRET_WRITE_FAILED"),
    );
    helper.failing.delete("create");
    assert.equal(await store.resolve(ref, {}), "synthetic-native-v4");
    assert.deepEqual(await readdir(dirs.entries), [`${ref.value}.json`]);

    // A missing item reads as unavailable.
    helper.items.clear();
    await assert.rejects(store.resolve(ref, {}), fails("SECRET_UNAVAILABLE"));
    helper.items.set(String((await json(dirs.entry(ref.value))).item), "x");
    assert.equal(await store.delete(ref), true);
    assert.equal(helper.items.size, 0);
    assert.deepEqual(await readdir(dirs.entries), []);
  },
);
