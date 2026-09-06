import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSecret,
  deleteSecret,
  resolveSecret,
} from "../../src/drivers/configuration/secrets.js";
import { ensurePrivateDirectory } from "../../src/platform/windows-acl.js";

void test(
  "Windows DPAPI persists encrypted immutable values and deletion makes a reference unavailable",
  { skip: process.platform !== "win32" },
  async () => {
    const value = `fixture-only-${randomUUID()}-${"测".repeat(2700)}`;
    const first = await createSecret(value);
    const second = await createSecret(value);
    try {
      assert.notEqual(first.value, second.value);
      assert.equal(await resolveSecret(first, {}), value);
      const encrypted = await readFile(
        path.join(
          process.env.LOCALAPPDATA!,
          "HarnessHub",
          "secrets-v1",
          `${first.value}.dpapi`,
        ),
      );
      assert.equal(encrypted.includes(Buffer.from(value)), false);
    } finally {
      await deleteSecret(first);
      await deleteSecret(second);
    }
    await assert.rejects(resolveSecret(first, {}), {
      code: "SECRET_UNAVAILABLE",
    });
    await assert.rejects(
      resolveSecret({ kind: "keychain", value: "../foreign" }, {}),
      { code: "SECRET_UNAVAILABLE" },
    );
  },
);

void test(
  "Windows environment references are case insensitive and conflicting aliases fail",
  { skip: process.platform !== "win32" },
  async () => {
    assert.equal(
      await resolveSecret({ kind: "env", value: "KEY" }, { key: "fixture" }),
      "fixture",
    );
    await assert.rejects(
      resolveSecret({ kind: "env", value: "KEY" }, { key: "one", KEY: "two" }),
      { code: "SECRET_UNAVAILABLE" },
    );
  },
);

void test(
  "Windows private file references resolve without weakening the file ACL",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "hh-secret 中文 "));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await ensurePrivateDirectory(directory);
    const file = path.join(directory, "fixture-key");
    await writeFile(file, "fixture-value");
    assert.equal(
      await resolveSecret({ kind: "file", value: file }, {}),
      "fixture-value",
    );
    await writeFile(file, "invalid\nmultiline");
    await assert.rejects(resolveSecret({ kind: "file", value: file }, {}), {
      code: "SECRET_UNAVAILABLE",
    });
  },
);

void test(
  "Windows DPAPI references retain the token profile when a Worker replaces HOME and AppData",
  { skip: process.platform !== "win32", timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hh-private-worker-home-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const value = `fixture-private-worker-${randomUUID()}-中文`;
    const reference = await createSecret(value);
    let deleted = false;
    try {
      const module = new URL(
        "../../src/drivers/configuration/secrets.js",
        import.meta.url,
      ).href;
      const script = `import { resolveSecret, deleteSecret } from ${JSON.stringify(module)};
import { createHash } from 'node:crypto';
let input=''; for await (const bytes of process.stdin) input+=bytes;
const request=JSON.parse(input);
try {
  const resolved=await resolveSecret(request.reference, {});
  if(createHash('sha256').update(resolved).digest('hex')!==request.digest) throw new Error('mismatch');
  await deleteSecret(request.reference);
  process.stdout.write(JSON.stringify({readMatched:true,deleted:true}));
} catch { process.stderr.write('Fixture credential was unavailable in the private Worker environment'); process.exitCode=1; }`;
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_.*)$/i.test(name),
        ),
      );
      Object.assign(environment, {
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: path.join(directory, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(directory, "AppData", "Local"),
        XDG_CONFIG_HOME: path.join(directory, ".config"),
        XDG_CACHE_HOME: path.join(directory, ".cache"),
      });
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          env: environment,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => {
        stdout += text;
      });
      child.stderr.on("data", (text: string) => {
        stderr += text;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stdin.end(
        JSON.stringify({
          reference,
          digest: createHash("sha256").update(value).digest("hex"),
        }),
      );
      const timer = setTimeout(() => child.kill(), 10000);
      try {
        assert.equal(await closed, 0, stderr);
      } finally {
        clearTimeout(timer);
      }
      assert.deepEqual(JSON.parse(stdout) as unknown, {
        readMatched: true,
        deleted: true,
      });
      deleted = true;
      await assert.rejects(resolveSecret(reference, {}), {
        code: "SECRET_UNAVAILABLE",
      });
    } finally {
      if (!deleted) await deleteSecret(reference);
    }
  },
);
