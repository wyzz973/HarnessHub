// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readFile,
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
  wiringAdapter,
  WiringError,
  type WiringContext,
} from "../src/wiring/index.js";
import { resolveOptions } from "../src/wiring/operations.js";
import {
  editors,
  type ConfigFormat,
  type KeyPath,
} from "../src/wiring/formats/index.js";
import { leaves } from "../src/wiring/formats/values.js";
import { GOLDEN } from "./wiring-golden.js";
import {
  directories,
  EXISTING,
  KEY,
  NEW_KEY,
  sandbox,
  snapshot,
  TARGET,
  writeFiles,
} from "./wiring-support.js";

const ADAPTERS = [
  "claude",
  "codex",
  "gemini",
  "qwen",
  "opencode",
  "pi",
  "crush",
  "kimi",
];

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

/** The text of every file under `directory`, for searching key values. */
async function allText(directory: string): Promise<string> {
  return Object.values(await snapshot(directory)).join("\n");
}

/** Where the adapter's settings put a value, by file path (relative to home) and key path. */
async function fields(id: string, context: WiringContext) {
  const plan = await planWiring(id, TARGET, context);
  const adapter = wiringAdapter(id);
  const files = new Map(plan.files.map((file) => [file.id, file]));
  const resolved = {
    baseUrl: TARGET.baseUrl,
    keyText: TARGET.keyText,
    model: TARGET.model,
    models: TARGET.models,
    selected: TARGET.models.find((model) => model.ref === TARGET.model),
    tiers: {},
    effort: undefined,
    options: resolveOptions(adapter, {}),
    gatewaySearch: false,
  };
  const located = {
    path: (fileId: string) => files.get(fileId)!.path,
    current: () => ({}),
  };
  const all = adapter.settings(resolved, located).flatMap((setting) =>
    ("remove" in setting ? [] : leaves(setting.value, setting.path)).map(
      ([leaf, value]) => ({
        file: files.get(setting.file)!.path,
        format: files.get(setting.file)!.format,
        path: leaf,
        value,
      }),
    ),
  );
  const base = all.find(
    (field) =>
      files.get(adapter.baseUrlField.file)!.path === field.file &&
      JSON.stringify(field.path) === JSON.stringify(adapter.baseUrlField.path),
  )!;
  return {
    key: all.find((field) => field.value === TARGET.keyText)!,
    base,
    model: all.find((field) => field.value === TARGET.model)!,
  };
}

async function edit(
  file: string,
  change: (text: string) => string,
): Promise<void> {
  await writeFile(file, change(await readFile(file, "utf8")));
}

function userEntry(format: ConfigFormat): KeyPath {
  return format === "dotenv"
    ? ["USER_ADDED"]
    : format === "toml"
      ? ["user_added"]
      : ["userAdded"];
}

for (const id of ADAPTERS) {
  void test(`${id}: wires an empty home as the golden files and unwires back to nothing`, async (t) => {
    const context = await sandbox(t);
    const plan = await planWiring(id, TARGET, context);
    assert.equal(plan.changed, true);
    assert.equal(plan.adapterId, id);
    assert.ok(
      plan.files.every((file) => !file.exists && file.changes.length > 0),
    );
    const shown = JSON.stringify(plan);
    assert.doesNotMatch(shown, new RegExp(TARGET.keyText));
    assert.match(shown, /hhk_a_abcd…/);

    const { record } = await applyWiring(id, TARGET, context, { expect: plan });
    assert.deepEqual(await snapshot(context.home), GOLDEN[id]!.empty);
    assert.equal(record.adapterId, id);
    assert.equal(record.keyId, KEY.keyId);
    assert.equal(record.model, TARGET.model);
    assert.equal(record.wiredAt, "2026-10-02T08:00:00.000Z");
    assert.deepEqual(
      record.files.map((file) => path.relative(context.home, file.path)).sort(),
      Object.keys(GOLDEN[id]!.empty).sort(),
    );
    assert.ok(
      record.files.every(
        (file) => file.beforeHash === undefined && file.backupId,
      ),
    );
    assert.doesNotMatch(
      await allText(context.dataDir),
      new RegExp(TARGET.keyText),
    );

    const again = await planWiring(id, TARGET, context, { previous: record });
    assert.equal(again.changed, false);
    assert.ok(
      again.files.every(
        (file) => file.diff === "" && file.changes.length === 0,
      ),
    );
    const repeated = await applyWiring(id, TARGET, context, {
      previous: record,
    });
    assert.deepEqual(repeated.record.files, record.files);
    assert.deepEqual((await detectDrift(record, context)).drifted, false);

    const result = await unwire(record, context);
    assert.equal(result.keyId, KEY.keyId);
    assert.ok(result.files.every((file) => file.action === "deleted"));
    assert.deepEqual(await snapshot(context.home), {});
    assert.deepEqual(await directories(context.home), []);
  });

  void test(`${id}: wires an existing configuration keeping comments and unrelated keys, and restores it byte for byte`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING[id]!);
    const first = path.join(context.home, Object.keys(EXISTING[id]!)[0]!);
    await chmod(first, 0o640);
    const before = await snapshot(context.home);

    const { record } = await applyWiring(id, TARGET, context);
    assert.deepEqual(await snapshot(context.home), GOLDEN[id]!.existing);
    // Files the user had are restored; files wiring created (Codex's model catalog) are deleted.
    const existed = (file: string) =>
      Object.hasOwn(EXISTING[id]!, path.relative(context.home, file));
    assert.ok(
      record.files.every(
        (file) => (file.beforeHash !== undefined) === existed(file.path),
      ),
    );
    if (process.platform !== "win32")
      assert.equal((await stat(first)).mode & 0o777, 0o640);

    const result = await unwire(record, context);
    assert.ok(
      result.files.every(
        (file) => file.action === (existed(file.path) ? "restored" : "deleted"),
      ),
    );
    assert.deepEqual(await snapshot(context.home), before);
    if (process.platform !== "win32")
      assert.equal((await stat(first)).mode & 0o777, 0o640);
  });

  void test(`${id}: unwire after a user edit restores only HarnessHub's entries`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING[id]!);
    const { record, plan } = await applyWiring(id, TARGET, context);
    const expected: Record<string, string> = {};
    for (const file of plan.files) {
      const editor = editors[file.format];
      const relative = path.relative(context.home, file.path);
      await edit(file.path, (text) =>
        editor.set(text, userEntry(file.format), "kept"),
      );
      // A file wiring created keeps only the user's entry.
      expected[relative] = editor.set(
        EXISTING[id]![relative] ?? "",
        userEntry(file.format),
        "kept",
      );
    }
    const result = await unwire(record, context);
    assert.ok(result.files.every((file) => file.action === "reverse-patched"));
    assert.deepEqual(await snapshot(context.home), expected);
    assert.doesNotMatch(await allText(context.home), /hhk_/);
  });

  void test(`${id}: refuses a configuration it cannot parse and writes nothing`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING[id]!);
    const [relative, text] = Object.entries(EXISTING[id]!)[0]!;
    const broken = relative.endsWith(".toml")
      ? `${text}\n[broken\n`
      : relative.endsWith(".env")
        ? `${text}X="open\n`
        : `${text.slice(0, -3)}`;
    await writeFile(path.join(context.home, relative), broken);
    const before = await snapshot(context.home);
    const planned = await rejectsWith(
      planWiring(id, TARGET, context),
      "WIRING_CONFIG_UNPARSEABLE",
    );
    assert.equal(planned.path, path.join(context.home, relative));
    await rejectsWith(
      applyWiring(id, TARGET, context),
      "WIRING_CONFIG_UNPARSEABLE",
    );
    assert.deepEqual(await snapshot(context.home), before);
    assert.deepEqual(await snapshot(context.dataDir), {});
  });

  void test(`${id}: refuses a configuration directory that is a symlink out of the home`, async (t) => {
    const context = await sandbox(t);
    const outside = path.join(context.root, "outside");
    await writeFiles(outside, EXISTING[id]!);
    const directory = path.dirname(Object.keys(EXISTING[id]!)[0]!);
    await mkdir(path.dirname(path.join(context.home, directory)), {
      recursive: true,
    });
    await symlink(
      path.join(outside, directory),
      path.join(context.home, directory),
      "dir",
    );
    const before = await snapshot(outside);
    const error = await rejectsWith(
      planWiring(id, TARGET, context),
      "WIRING_SYMLINK_ESCAPE",
    );
    assert.doesNotMatch(error.message, new RegExp(TARGET.keyText));
    await rejectsWith(
      applyWiring(id, TARGET, context),
      "WIRING_SYMLINK_ESCAPE",
    );
    assert.deepEqual(await snapshot(outside), before);
  });

  void test(`${id}: detects a replaced key, a foreign gateway, a replaced model and a missing file`, async (t) => {
    const context = await sandbox(t);
    const { key, base, model } = await fields(id, context);
    let { record } = await applyWiring(id, TARGET, context);
    const cases: Array<{
      field: typeof key;
      value: string;
      kind: string;
      reason: string;
    }> = [
      {
        field: key,
        value: NEW_KEY.keyText,
        kind: "unwired",
        reason: "other-key",
      },
      {
        field: base,
        value: "http://127.0.0.1:9999/v1",
        kind: "foreign-gateway",
        reason: "changed",
      },
      {
        field: model,
        value: "other/model",
        kind: "replaced",
        reason: "changed",
      },
    ];
    for (const { field, value, kind, reason } of cases) {
      const editor = editors[field.format];
      await edit(field.file, (text) => editor.set(text, field.path, value));
      const report = await detectDrift(record, context);
      assert.equal(report.drifted, true);
      assert.deepEqual(report.kinds, [kind]);
      assert.deepEqual(
        report.findings.map((finding) => [
          finding.path,
          finding.keyPath,
          finding.reason,
        ]),
        [[field.file, [...field.path], reason]],
      );
      assert.doesNotMatch(JSON.stringify(report), /hhk_/);
      ({ record } = await applyWiring(id, TARGET, context, {
        previous: record,
      }));
      assert.equal((await detectDrift(record, context)).drifted, false);
    }
    const moved = await detectDrift(record, context, {
      baseUrl: "http://127.0.0.1:4000",
    });
    assert.deepEqual(moved.kinds, ["foreign-gateway"]);
    await rm(record.files[0]!.path);
    const missing = await detectDrift(record, context);
    assert.deepEqual(missing.kinds, ["unwired"]);
    assert.equal(missing.findings[0]!.reason, "file-missing");
  });

  void test(`${id}: re-wiring replaces the key id and unwire still restores the original`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, EXISTING[id]!);
    const original = await snapshot(context.home);
    const first = await applyWiring(id, TARGET, context);
    const rotated = { ...TARGET, ...NEW_KEY };
    const plan = await planWiring(id, rotated, context, {
      previous: first.record,
    });
    assert.equal(plan.changed, true);
    assert.doesNotMatch(
      JSON.stringify(plan),
      /hhk_a_abcdefghijkl_S|hhk_a_mnopqrstuvwx_N/,
    );
    const second = await applyWiring(id, rotated, context, {
      previous: first.record,
      expect: plan,
    });
    assert.equal(second.record.keyId, NEW_KEY.keyId);
    const text = await allText(context.home);
    assert.match(text, new RegExp(NEW_KEY.keyText));
    assert.doesNotMatch(text, new RegExp(KEY.keyText));
    assert.deepEqual(
      second.record.files.map((file) => file.beforeHash),
      first.record.files.map((file) => file.beforeHash),
    );
    assert.equal((await detectDrift(second.record, context)).drifted, false);
    assert.deepEqual((await detectDrift(first.record, context)).kinds, [
      "unwired",
    ]);
    // A narrower target restores what the first wiring had set.
    const narrow = { ...rotated, models: TARGET.models.slice(0, 1) };
    const third = await applyWiring(id, narrow, context, {
      previous: second.record,
    });
    await unwire(third.record, context);
    assert.deepEqual(await snapshot(context.home), original);
  });
}
