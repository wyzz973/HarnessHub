// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  applyWiring,
  detectDrift,
  planWiring,
  unwire,
  WiringError,
} from "../src/wiring/index.js";
import {
  EXISTING,
  sandbox,
  snapshot,
  syntheticKey,
  TARGET,
  writeFiles,
} from "./wiring-support.js";

const posix = process.platform !== "win32";

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
): Promise<WiringError> {
  let caught: unknown;
  await assert.rejects(promise, (error: unknown) => {
    caught = error;
    return error instanceof WiringError && error.code === code;
  });
  return caught as WiringError;
}

void test("a symlinked configuration inside the home is written through and stays a link", async (t) => {
  const context = await sandbox(t);
  const target = path.join(context.home, "dotfiles", "claude.json");
  await writeFiles(context.home, {
    "dotfiles/claude.json": EXISTING.claude![".claude/settings.json"]!,
  });
  await mkdir(path.join(context.home, ".claude"));
  const settings = path.join(context.home, ".claude", "settings.json");
  await symlink(target, settings);
  const { record } = await applyWiring("claude", TARGET, context);
  assert.ok((await lstat(settings)).isSymbolicLink());
  assert.match(await readFile(target, "utf8"), /ANTHROPIC_AUTH_TOKEN/);
  assert.equal(record.files[0]!.path, settings);
  await unwire(record, context);
  assert.ok((await lstat(settings)).isSymbolicLink());
  assert.equal(
    await readFile(target, "utf8"),
    EXISTING.claude![".claude/settings.json"],
  );
});

void test("a symlinked file pointing out of the home and a dangling link are refused", async (t) => {
  const context = await sandbox(t);
  const outside = path.join(context.root, "outside.json");
  await writeFile(outside, "{}\n");
  await mkdir(path.join(context.home, ".claude"));
  await symlink(outside, path.join(context.home, ".claude", "settings.json"));
  await rejectsWith(
    applyWiring("claude", TARGET, context),
    "WIRING_SYMLINK_ESCAPE",
  );
  assert.equal(await readFile(outside, "utf8"), "{}\n");
  await mkdir(path.join(context.home, ".codex"));
  await symlink(
    path.join(context.home, "missing"),
    path.join(context.home, ".codex", "config.toml"),
  );
  await rejectsWith(
    planWiring("codex", TARGET, context),
    "WIRING_NOT_REGULAR_FILE",
  );
});

void test("a file with several hard links is rewritten in place for every link", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, EXISTING.codex!);
  const config = path.join(context.home, ".codex", "config.toml");
  const other = path.join(context.home, "config-link.toml");
  await link(config, other);
  const inode = (await stat(config)).ino;
  const { record } = await applyWiring("codex", TARGET, context);
  assert.equal((await stat(config)).ino, inode);
  assert.equal(await readFile(other, "utf8"), await readFile(config, "utf8"));
  assert.match(await readFile(other, "utf8"), /model_providers\.harnesshub/);
  await unwire(record, context);
  assert.equal(
    await readFile(other, "utf8"),
    EXISTING.codex![".codex/config.toml"],
  );
  assert.equal((await stat(config)).ino, inode);
});

void test(
  "a read-only file keeps its mode and a new file is private",
  { skip: !posix },
  async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING.claude!);
    const settings = path.join(context.home, ".claude", "settings.json");
    await chmod(settings, 0o444);
    const { record } = await applyWiring("claude", TARGET, context);
    assert.equal((await stat(settings)).mode & 0o777, 0o444);
    await unwire(record, context);
    assert.equal((await stat(settings)).mode & 0o777, 0o444);
    assert.equal(
      await readFile(settings, "utf8"),
      EXISTING.claude![".claude/settings.json"],
    );
    const fresh = await applyWiring("codex", TARGET, context);
    assert.equal((await stat(fresh.record.files[0]!.path)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(path.dirname(fresh.record.files[0]!.path))).mode & 0o777,
      0o700,
    );
  },
);

void test("a byte order mark and CRLF line endings are kept and restored", async (t) => {
  const context = await sandbox(t);
  const original = '﻿{\r\n  "theme": "dark"\r\n}\r\n';
  await writeFiles(context.home, { ".claude/settings.json": original });
  const { record } = await applyWiring("claude", TARGET, context);
  const wired = await readFile(
    path.join(context.home, ".claude", "settings.json"),
  );
  assert.deepEqual([...wired.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.doesNotMatch(wired.toString("utf8").replaceAll("\r\n", ""), /\n/);
  await unwire(record, context);
  assert.equal(
    await readFile(path.join(context.home, ".claude", "settings.json"), "utf8"),
    original,
  );
});

void test("a file that is not UTF-8 is refused", async (t) => {
  const context = await sandbox(t);
  await mkdir(path.join(context.home, ".claude"));
  await writeFile(
    path.join(context.home, ".claude", "settings.json"),
    Buffer.from([0x7b, 0xff, 0x7d]),
  );
  await rejectsWith(
    planWiring("claude", TARGET, context),
    "WIRING_CONFIG_UNPARSEABLE",
  );
});

void test("a file changed after the preview is not overwritten", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, EXISTING.claude!);
  const plan = await planWiring("claude", TARGET, context);
  const settings = path.join(context.home, ".claude", "settings.json");
  await writeFile(settings, '{ "theme": "light" }\n');
  await rejectsWith(
    applyWiring("claude", TARGET, context, { expect: plan }),
    "WIRING_CONCURRENT_MODIFICATION",
  );
  assert.equal(await readFile(settings, "utf8"), '{ "theme": "light" }\n');
});

void test(
  "a failed write restores the files already written and reports each",
  { skip: !posix },
  async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING.gemini!);
    const env = path.join(context.home, ".gemini", ".env");
    // A second hard link makes the write in place, which a read-only file refuses.
    await link(env, path.join(context.home, "env-link"));
    await chmod(env, 0o444);
    const before = await snapshot(context.home);
    const error = await rejectsWith(
      applyWiring("gemini", TARGET, context),
      "WIRING_WRITE_FAILED",
    );
    assert.equal(error.path, env);
    assert.deepEqual(
      error.rollback.map((entry) => [
        path.basename(entry.path),
        entry.restored,
      ]),
      [
        ["settings.json", true],
        [".env", true],
      ],
    );
    assert.deepEqual(await snapshot(context.home), before);
  },
);

void test("a held lock refuses concurrent wiring and unwiring", async (t) => {
  const context = await sandbox(t);
  const { record } = await applyWiring("claude", TARGET, context);
  const lock = path.join(
    context.dataDir,
    "backups",
    "wiring",
    "claude",
    ".lock",
  );
  await mkdir(lock);
  await rejectsWith(applyWiring("claude", TARGET, context), "WIRING_BUSY");
  await rejectsWith(unwire(record, context), "WIRING_BUSY");
  await applyWiring("codex", TARGET, context);
});

void test("temporary files of an interrupted write are removed, others are kept", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, {
    ".claude/.settings.json.hh-wiring-0123456789ab.tmp": "partial",
    ".claude/.settings.json.other.tmp": "mine",
  });
  await applyWiring("claude", TARGET, context);
  assert.deepEqual((await readdir(path.join(context.home, ".claude"))).sort(), [
    ".settings.json.other.tmp",
    "settings.json",
  ]);
});

void test("agent directory overrides come only from the explicit environment", async (t) => {
  const context = await sandbox(t);
  const codexHome = path.join(context.root, "codex-home");
  const claudeDir = path.join(context.root, "claude-config");
  const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeDir };
  const codex = await applyWiring("codex", TARGET, { ...context, env });
  assert.equal(
    codex.record.files[0]!.path,
    path.join(codexHome, "config.toml"),
  );
  const claude = await applyWiring("claude", TARGET, { ...context, env });
  assert.equal(
    claude.record.files[0]!.path,
    path.join(claudeDir, "settings.json"),
  );
  assert.deepEqual(await snapshot(context.home), {});
  assert.equal(
    (await detectDrift(codex.record, { ...context, env })).drifted,
    false,
  );
  await unwire(codex.record, context);
  await unwire(claude.record, context);
  assert.deepEqual(await snapshot(codexHome), {});
  await rejectsWith(
    planWiring("codex", TARGET, {
      ...context,
      env: { CODEX_HOME: "relative/codex" },
    }),
    "WIRING_CONTEXT_INVALID",
  );
  const empty = await planWiring("codex", TARGET, {
    ...context,
    env: { CODEX_HOME: "" },
  });
  assert.equal(
    empty.files[0]!.path,
    path.join(context.home, ".codex", "config.toml"),
  );
});

void test("OpenCode edits an existing opencode.jsonc and creates opencode.json otherwise", async (t) => {
  const context = await sandbox(t);
  const created = await planWiring("opencode", TARGET, context);
  assert.equal(path.basename(created.files[0]!.path), "opencode.json");
  await writeFiles(context.home, { ".config/opencode/opencode.jsonc": "{}\n" });
  const existing = await planWiring("opencode", TARGET, context);
  assert.equal(path.basename(existing.files[0]!.path), "opencode.jsonc");
});

void test("invalid targets and contexts are refused without echoing the key", async (t) => {
  const context = await sandbox(t);
  const session = `hhk_s_${TARGET.keyId}_${"S".repeat(43)}`;
  const cases = [
    { ...TARGET, keyText: session },
    { ...TARGET, ...syntheticKey("zzzzzzzzzzzz"), keyId: TARGET.keyId },
    { ...TARGET, baseUrl: "ftp://127.0.0.1" },
    { ...TARGET, baseUrl: "http://user:pass@127.0.0.1" },
    { ...TARGET, model: "no-slash" },
    { ...TARGET, models: [{ ref: "a/b" }, { ref: "a/b" }] },
    { ...TARGET, models: [{ ref: "a/b", contextWindow: -1 }] },
  ];
  for (const target of cases) {
    const error = await rejectsWith(
      planWiring("claude", target, context),
      "WIRING_TARGET_INVALID",
    );
    assert.doesNotMatch(error.message, /hhk_/);
  }
  await rejectsWith(
    planWiring("nobody", TARGET, context),
    "WIRING_ADAPTER_UNKNOWN",
  );
  await rejectsWith(
    planWiring("claude", TARGET, {
      ...context,
      home: path.join(context.root, "absent"),
    }),
    "WIRING_CONTEXT_INVALID",
  );
  await rejectsWith(
    planWiring("claude", TARGET, { ...context, home: "relative" }),
    "WIRING_CONTEXT_INVALID",
  );
  await rejectsWith(
    planWiring("kimi", { ...TARGET, models: [] }, context),
    "WIRING_TARGET_INVALID",
  );
});

void test("entries that cannot be edited in place are refused", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, {
    ".claude/settings.json": '{ "env": "not an object" }\n',
  });
  await rejectsWith(
    planWiring("claude", TARGET, context),
    "WIRING_PATH_CONFLICT",
  );
  await writeFiles(context.home, {
    ".codex/config.toml":
      'model_providers = { harnesshub = { name = "mine" } }\n',
  });
  await rejectsWith(
    planWiring("codex", TARGET, context),
    "WIRING_UNSUPPORTED_STRUCTURE",
  );
});

void test("the preview masks the key and redacts the value it replaces", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, EXISTING.gemini!);
  const plan = await planWiring("gemini", TARGET, context);
  const text = JSON.stringify(plan);
  assert.doesNotMatch(text, /user-google-api-key/);
  assert.doesNotMatch(text, new RegExp(TARGET.keyText));
  const env = plan.files.find((file) => file.id === "env")!;
  assert.match(env.diff, /^-export GEMINI_API_KEY=<redacted>$/m);
  assert.match(env.diff, /^\+export GEMINI_API_KEY=hhk_a_abcd…$/m);
  assert.doesNotMatch(env.diff, /OTHER_TOKEN/);
  assert.deepEqual(
    env.changes.find((change) => change.keyPath[0] === "GEMINI_API_KEY"),
    {
      keyPath: ["GEMINI_API_KEY"],
      op: "set",
      before: '"<redacted>"',
      after: '"hhk_a_abcd…"',
    },
  );
});

void test("records without backups and altered backups are refused", async (t) => {
  const context = await sandbox(t);
  const { record } = await applyWiring("claude", TARGET, context);
  const entry = { ...record.files[0]! };
  delete entry.backupId;
  await rejectsWith(
    unwire({ ...record, files: [entry] }, context),
    "WIRING_RECORD_INVALID",
  );
  const manifest = path.join(
    context.dataDir,
    "backups",
    "wiring",
    "claude",
    "manifests",
    `${record.files[0]!.backupId}.json`,
  );
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace('"claude"', '"codex"'),
  );
  await rejectsWith(unwire(record, context), "WIRING_BACKUP_INVALID");
});

void test("a user deleting a wired file leaves nothing to unwire", async (t) => {
  const context = await sandbox(t);
  const { record } = await applyWiring("codex", TARGET, context);
  await writeFile(record.files[0]!.path, "");
  const emptied = await detectDrift(record, context);
  assert.deepEqual(emptied.kinds, ["replaced", "unwired"]);
  await rm(record.files[0]!.path);
  const result = await unwire(record, context);
  assert.deepEqual(
    result.files.map((file) => file.action),
    ["absent"],
  );
});
