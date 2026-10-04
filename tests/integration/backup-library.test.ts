// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { open, parseEnvelope } from "@harnesshub/daemon/backup-envelope";
import { startHub } from "@harnesshub/daemon/main";
import type { BackupEnvelope, HarnessHubClient } from "@harnesshub/sdk/client";
import { connectLocal } from "@harnesshub/sdk/local";
import { HH_ENTRY } from "../support/entries.js";
import { startFakeWebDav } from "../support/fake-storage.js";
import { temporaryDirectory } from "../support/temporary.js";

// Synthetic values only: they never reach a real service.
const PASSPHRASE = "synthetic library passphrase";
const SEARCH_TOKEN = "synthetic-library-search-0001";
const LOCAL_TOKEN = "synthetic-library-local-0002";
const BIG = 2 * 1024 * 1024 + 1;

interface Machine {
  client: HarnessHubClient;
  url: string;
  dataDir: string;
  home: string;
  directory: string;
}

/** A daemon on temporary directories with a `claude` command (never run) on its PATH. */
async function machine(t: TestContext, name: string): Promise<Machine> {
  const { directory, defer } = await temporaryDirectory(
    t,
    `hh-backup-library-${name}-`,
  );
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  await mkdir(home);
  await mkdir(bin);
  const command = path.join(
    bin,
    process.platform === "win32" ? "claude.cmd" : "claude",
  );
  await writeFile(command, "exit 1\n");
  await chmod(command, 0o755);
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
  };
}

/** A skill directory with a script and a file too big for a backup. */
async function skill(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Work with PDF files.\n---\n\nUse scripts/run.sh.\n`,
  );
  await writeFile(path.join(directory, "scripts", "run.sh"), "#!/bin/sh\n");
  await chmod(path.join(directory, "scripts", "run.sh"), 0o755);
  await writeFile(
    path.join(directory, "assets", "model.bin"),
    Buffer.alloc(BIG, 0x61),
  );
  return directory;
}

/** Machine A's Library: a set, servers with each kind of secret, a skill. */
async function populate(a: Machine): Promise<void> {
  await a.client.library.instructions.create("team", {
    name: "Team rules",
    text: "Run the tests before you commit.",
    agents: ["claude"],
  });
  await a.client.library.mcp.create("github", {
    transport: "stdio",
    command: "github-mcp",
    secretEnv: { GITHUB_TOKEN: { kind: "env", value: "GITHUB_TOKEN" } },
    agents: ["claude"],
  });
  await a.client.library.mcp.create("search", {
    transport: "http",
    url: "https://mcp.example.test/search",
    secretHeaders: { Authorization: { secret: SEARCH_TOKEN } },
    agents: ["claude"],
  });
  await a.client.library.skills.import(
    await skill(path.join(a.directory, "src"), "pdf-tools"),
    ["claude"],
  );
}

async function plain(envelope: BackupEnvelope): Promise<string> {
  return (await open(envelope, PASSPHRASE)).toString("utf8");
}

interface CarriedLibrary {
  instructions: Array<{ id: string; text: string; agents: string[] }>;
  mcp: Array<{
    name: string;
    secretEnv?: Record<string, Record<string, unknown>>;
    secretHeaders?: Record<string, Record<string, unknown>>;
  }>;
  skills: Array<{
    name: string;
    files: Record<string, string>;
    exec?: string[];
    left?: string[];
  }>;
}

void test("a backup carries the Library: texts, references, stored values only with keys, skills without files over 2 MiB", async (t) => {
  const a = await machine(t, "a");
  await populate(a);
  const withKeys = await plain(
    await a.client.backup.create({ passphrase: PASSPHRASE }),
  );
  const library = (JSON.parse(withKeys) as { library: CarriedLibrary }).library;
  assert.deepEqual(
    library.instructions.map((item) => [item.id, item.text, item.agents]),
    [["team", "Run the tests before you commit.", ["claude"]]],
  );
  assert.deepEqual(library.mcp[0]!.secretEnv, {
    GITHUB_TOKEN: { source: "reference", kind: "env", name: "GITHUB_TOKEN" },
  });
  assert.deepEqual(library.mcp[1]!.secretHeaders, {
    Authorization: { source: "store", value: SEARCH_TOKEN },
  });
  const pdf = library.skills[0]!;
  assert.deepEqual(Object.keys(pdf.files).sort(), [
    "SKILL.md",
    "scripts/run.sh",
  ]);
  assert.deepEqual(pdf.exec, ["scripts/run.sh"]);
  assert.deepEqual(pdf.left, ["assets/model.bin"]);

  const withoutKeys = await plain(
    await a.client.backup.create({ passphrase: PASSPHRASE, keys: false }),
  );
  assert.doesNotMatch(withoutKeys, new RegExp(SEARCH_TOKEN));
  assert.deepEqual(
    (JSON.parse(withoutKeys) as { library: CarriedLibrary }).library.mcp[1]!
      .secretHeaders,
    { Authorization: { source: "store" } },
  );
});

void test("restore brings the Library in item by item, keeps this machine's secret, refuses HarnessHub credentials, and syncs into agents on request", async (t) => {
  const a = await machine(t, "a");
  await populate(a);
  // A server A may keep: the variable is nobody's credential there. On B it
  // is a provider credential's, which a tool may not receive.
  await a.client.library.mcp.create("leaky", {
    transport: "stdio",
    command: "tool",
    secretEnv: { API_KEY: { kind: "env", value: "B_PROVIDER_KEY" } },
    agents: ["claude"],
  });
  await a.client.library.mcp.create("stored", {
    transport: "stdio",
    command: "tool",
    secretEnv: { TOKEN: { secret: "synthetic-only-on-a" } },
  });
  const sealed = await a.client.backup.create({
    passphrase: PASSPHRASE,
    keys: false,
  });

  const b = await machine(t, "b");
  await b.client.providers.create({
    id: "local",
    name: "Local",
    kind: "custom",
    endpoints: { chat: "https://upstream.invalid/v1" },
    models: { source: "manual", list: [{ id: "m1" }], expose: "all" },
  });
  await b.client.credentials.add("local", {
    name: "env",
    ref: { kind: "env", value: "B_PROVIDER_KEY" },
  });
  await b.client.library.instructions.create("team", {
    text: "This machine's rules.",
    agents: ["claude"],
  });
  await b.client.library.mcp.create("search", {
    transport: "http",
    url: "https://mcp.example.test/old",
    secretHeaders: { Authorization: { secret: LOCAL_TOKEN } },
  });

  const preview = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: true,
  });
  assert.deepEqual(preview.library, {
    instructions: { added: [], replaced: ["team"], removed: [] },
    mcp: {
      added: ["github", "stored"],
      replaced: ["search"],
      removed: [],
      needSecret: ["stored: TOKEN"],
    },
    skills: {
      added: ["pdf-tools"],
      replaced: [],
      removed: [],
      incomplete: ["pdf-tools"],
    },
    refused: [
      {
        kind: "mcp",
        name: "leaky",
        reason: preview.library!.refused[0]!.reason,
      },
    ],
  });
  assert.match(
    preview.library!.refused[0]!.reason,
    /reference of credential .* of provider local/,
  );
  assert.equal(
    (await b.client.library.instructions.get("team")).text,
    "This machine's rules.",
    "a dry run writes nothing",
  );

  const restored = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: false,
  });
  assert.deepEqual(restored.library, preview.library);
  assert.equal(
    (await b.client.library.instructions.get("team")).text,
    "Run the tests before you commit.",
  );
  const search = await b.client.library.mcp.get("search");
  assert.equal(search.url, "https://mcp.example.test/search");
  assert.equal(search.secretHeaders?.Authorization?.kind, "store");
  assert.deepEqual(
    (await b.client.library.mcp.get("stored")).secretEnv,
    undefined,
  );
  await assert.rejects(b.client.library.mcp.get("leaky"));
  const pdf = await b.client.library.skills.get("pdf-tools");
  assert.equal(pdf.files, 2, "the file over 2 MiB stayed behind");

  // The stored secret B had is kept: with consent, B's value is written.
  const plan = await b.client.library.sync.plan({
    agents: ["claude"],
    allowPlaintextSecret: true,
  });
  await b.client.library.sync.apply({
    agents: ["claude"],
    allowPlaintextSecret: true,
    expect: plan,
  });
  const claude = await readFile(path.join(b.home, ".claude.json"), "utf8");
  assert.match(claude, new RegExp(`"Authorization": "${LOCAL_TOKEN}"`));
  assert.match(claude, /"GITHUB_TOKEN": "\$\{GITHUB_TOKEN\}"/);
  assert.match(
    await readFile(path.join(b.home, ".claude", "CLAUDE.md"), "utf8"),
    /Run the tests before you commit\./,
  );
  assert.ok(
    (
      await lstat(path.join(b.home, ".claude", "skills", "pdf-tools"))
    ).isSymbolicLink(),
  );
  // Restoring the same backup again changes nothing: the skill's carried
  // files are this machine's, so its version stays.
  const again = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    dryRun: false,
  });
  assert.deepEqual(again.library?.skills.incomplete, []);
  assert.equal(
    (await b.client.library.skills.get("pdf-tools")).sha256,
    pdf.sha256,
  );

  // Without the Library, nothing of it is brought in.
  const without = await b.client.backup.restore({
    backup: sealed,
    passphrase: PASSPHRASE,
    library: false,
    dryRun: true,
  });
  assert.equal(without.library, null);
});

/** Run the real `hh` launcher with `input` on stdin, so it is never interactive. */
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

void test("hh restore syncs the restored Library into installed agents; --no-library leaves it out", async (t) => {
  const a = await machine(t, "a");
  await populate(a);
  const file = path.join(a.directory, "library.harnesshub-backup");
  const made = await hh(
    a.directory,
    ["backup", file, "--url", a.url, "--data-dir", a.dataDir],
    `${PASSPHRASE}\n`,
  );
  assert.equal(made.code, 0, made.stderr);

  const b = await machine(t, "b");
  const common = ["--url", b.url, "--data-dir", b.dataDir, "--yes"];
  const skipped = await hh(
    b.directory,
    ["restore", file, "--no-library", ...common],
    `${PASSPHRASE}\n`,
  );
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stdout, /Library/);
  assert.deepEqual((await b.client.library.mcp.list()).items, []);

  const done = await hh(
    b.directory,
    ["restore", file, ...common],
    `${PASSPHRASE}\n`,
  );
  assert.equal(done.code, 0, done.stderr);
  assert.match(
    done.stdout,
    /Library: instruction sets: added team; MCP servers: added github, search; skills: added pdf-tools/,
  );
  assert.match(done.stdout, /Skills without their files over 2 MiB.*pdf-tools/);
  assert.match(done.stdout, /Create .*CLAUDE\.md/);
  assert.match(done.stdout, /Library synced into claude/);
  assert.match(
    await readFile(path.join(b.home, ".claude", "CLAUDE.md"), "utf8"),
    /Run the tests/,
  );
  // The stored secret is refused for Claude Code without consent.
  assert.doesNotMatch(
    await readFile(path.join(b.home, ".claude.json"), "utf8"),
    new RegExp(SEARCH_TOKEN),
  );
  assert.doesNotMatch(done.stdout + done.stderr, new RegExp(SEARCH_TOKEN));
});

void test("sync carries the Library as its own part, into the agents of the other machine, deletions too", async (t) => {
  const storage = await startFakeWebDav({
    user: "sync-user",
    password: "synthetic-dav-password",
  });
  t.after(() => storage.close());
  const settings = {
    kind: "webdav" as const,
    url: `${storage.url}/dav`,
    user: "sync-user",
    secret: "synthetic-dav-password",
    passphrase: PASSPHRASE,
  };
  const a = await machine(t, "a");
  const b = await machine(t, "b");
  await populate(a);
  await a.client.sync.configure(settings);
  await a.client.sync.now();
  const stored = storage.object("/dav/harnesshub/harnesshub.harnesshub-backup");
  assert.ok(stored);
  assert.doesNotMatch(stored.data.toString("utf8"), /Run the tests/);
  assert.match(
    (await open(parseEnvelope(stored.data), PASSPHRASE)).toString("utf8"),
    /Run the tests/,
  );

  await b.client.sync.configure(settings);
  const joined = await b.client.sync.now();
  assert.equal(joined.lastError, undefined);
  assert.deepEqual(
    (await b.client.library.mcp.list()).items.map((item) => item.name),
    ["github", "search"],
  );
  // Agent wirings are synced, so the Library went into B's Claude Code.
  assert.match(
    await readFile(path.join(b.home, ".claude", "CLAUDE.md"), "utf8"),
    /Run the tests/,
  );
  assert.ok(
    (
      await lstat(path.join(b.home, ".claude", "skills", "pdf-tools"))
    ).isSymbolicLink(),
  );

  // A server removed on B goes from A, and A's sync changes nothing else.
  await b.client.library.mcp.remove("github");
  await b.client.sync.now();
  const back = await a.client.sync.now();
  assert.equal(back.lastError, undefined);
  assert.deepEqual(
    (await a.client.library.mcp.list()).items.map((item) => item.name),
    ["search"],
  );
  // A keeps its skill version: the carried files are its own.
  assert.equal(
    (await a.client.library.skills.get("pdf-tools")).files,
    3,
    "the file over 2 MiB is still on A",
  );
  const quiet = await b.client.sync.now();
  assert.equal(quiet.notice, undefined);
});
