// SPDX-License-Identifier: MIT
/**
 * The behaviour every global wiring adapter must show, as one registered
 * test per case: golden output into an empty home and into existing
 * configuration, byte-exact and key-level unwire, parse-failure and symlink
 * refusal, drift and key rotation. The existing configuration holds every
 * file the adapter writes. The drift cases edit the key and the model where
 * a setting holds them as a value of their own; an adapter that keeps them
 * inside a list, or writes no model selection, tests that drift by itself.
 */
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
import { formatPath, leaves } from "../src/wiring/formats/values.js";
import {
  directories,
  KEY,
  NEW_KEY,
  sandbox,
  snapshot,
  TARGET,
  writeFiles,
} from "./wiring-support.js";

/** An adapter's declaration and reviewed fixtures; paths are relative to the home. */
export interface AdapterFixture {
  protocol: string;
  executables: readonly string[];
  /** The files wired in an empty home, in the adapter's order. */
  files: readonly string[];
  /** Directory variables and the files they move the configuration to, relative to the sandbox root. */
  locations: ReadonlyArray<{
    env: Readonly<Record<string, string>>;
    files: readonly string[];
  }>;
  /** Existing user configuration: comments, unrelated keys and a value wiring replaces. */
  existing: Readonly<Record<string, string>>;
  /** What wiring TARGET writes into an empty home and into `existing`. */
  golden: {
    empty: Readonly<Record<string, string>>;
    existing: Readonly<Record<string, string>>;
  };
  /**
   * Files in which wiring replaces an object of the user's own (a provider
   * slot it takes over): a key-level unwire writes that object back by value,
   * so the file is compared parsed rather than byte for byte.
   */
  restoresByValue?: readonly string[];
}

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

/** Where the adapter's settings put the key, the base URL and the model. */
async function fields(id: string, context: WiringContext) {
  const plan = await planWiring(id, TARGET, context);
  const adapter = wiringAdapter(id);
  const files = new Map(plan.files.map((file) => [file.id, file]));
  const resolved = {
    baseUrl: TARGET.baseUrl,
    keyText: TARGET.keyText,
    model: TARGET.model,
    models: TARGET.models,
    ownModel: false,
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
  const field = adapter.baseUrlField;
  const basePath =
    typeof field.path === "function"
      ? field.path(TARGET.model, {})
      : field.path;
  const base = all.find(
    (candidate) =>
      files.get(field.file)!.path === candidate.file &&
      JSON.stringify(candidate.path) === JSON.stringify(basePath),
  );
  assert.ok(base, `${id}: the base URL field is among the settings`);
  return {
    key: all.find((candidate) => candidate.value === TARGET.keyText),
    base,
    model: all.find((candidate) => candidate.value === TARGET.model),
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

/** A key path as reports show it: an array element as `[field="value"]`. */
function asText(path: KeyPath): string[] {
  return path.map((segment) =>
    typeof segment === "string" ? segment : formatPath([segment]),
  );
}

/** `text` made unparseable in its format, judged by the file name. */
function broken(relative: string, text: string): string {
  if (relative.endsWith(".toml")) return `${text}\n[broken\n`;
  if (relative.endsWith(".env")) return `${text}X="open\n`;
  if (/\.ya?ml$/.test(relative)) return `${text}broken: [unclosed\n`;
  return text.slice(0, -3);
}

/** Registers the adapter's tests. */
export function adapterSuite(id: string, fixture: AdapterFixture): void {
  const { existing, golden } = fixture;

  void test(`${id}: declares its protocol, key delivery, commands and files, which directory variables move`, async (t) => {
    const context = await sandbox(t);
    const adapter = wiringAdapter(id);
    assert.equal(adapter.protocol, fixture.protocol);
    assert.equal(adapter.keyDelivery, "config-file");
    assert.deepEqual(adapter.executables, fixture.executables);
    const plan = await planWiring(id, TARGET, context);
    assert.deepEqual(
      plan.files.map((file) => path.relative(context.home, file.path)),
      fixture.files,
    );
    for (const location of fixture.locations) {
      const env = Object.fromEntries(
        Object.entries(location.env).map(([name, value]) => [
          name,
          path.join(context.root, value),
        ]),
      );
      const moved = await planWiring(id, TARGET, { ...context, env });
      assert.deepEqual(
        moved.files.map((file) => path.relative(context.root, file.path)),
        location.files.map((file) => path.normalize(file)),
        JSON.stringify(location.env),
      );
    }
  });

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
    assert.deepEqual(await snapshot(context.home), golden.empty);
    assert.equal(record.adapterId, id);
    assert.equal(record.keyId, KEY.keyId);
    assert.equal(record.model, TARGET.model);
    assert.deepEqual(
      record.files.map((file) => path.relative(context.home, file.path)).sort(),
      Object.keys(golden.empty).sort(),
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
    const repeated = await applyWiring(id, TARGET, context, {
      previous: record,
    });
    assert.deepEqual(repeated.record.files, record.files);
    assert.equal((await detectDrift(record, context)).drifted, false);

    const result = await unwire(record, context);
    assert.equal(result.keyId, KEY.keyId);
    assert.ok(result.files.every((file) => file.action === "deleted"));
    assert.deepEqual(await snapshot(context.home), {});
    assert.deepEqual(await directories(context.home), []);
  });

  void test(`${id}: wires an existing configuration keeping comments and unrelated keys, and restores it byte for byte`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, existing);
    const first = path.join(context.home, Object.keys(existing)[0]!);
    await chmod(first, 0o640);
    const before = await snapshot(context.home);

    const { record } = await applyWiring(id, TARGET, context);
    assert.deepEqual(await snapshot(context.home), golden.existing);
    assert.ok(record.files.every((file) => file.beforeHash !== undefined));
    if (process.platform !== "win32")
      assert.equal((await stat(first)).mode & 0o777, 0o640);

    const result = await unwire(record, context);
    assert.ok(result.files.every((file) => file.action === "restored"));
    assert.deepEqual(await snapshot(context.home), before);
    if (process.platform !== "win32")
      assert.equal((await stat(first)).mode & 0o777, 0o640);
  });

  void test(`${id}: unwire after a user edit restores only HarnessHub's entries`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, existing);
    const { record, plan } = await applyWiring(id, TARGET, context);
    const expected: Record<string, string> = {};
    for (const file of plan.files) {
      const editor = editors[file.format];
      const relative = path.relative(context.home, file.path);
      await edit(file.path, (text) =>
        editor.set(text, userEntry(file.format), "kept"),
      );
      expected[relative] = editor.set(
        existing[relative]!,
        userEntry(file.format),
        "kept",
      );
    }
    const result = await unwire(record, context);
    assert.ok(result.files.every((file) => file.action === "reverse-patched"));
    const after = await snapshot(context.home);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(expected).sort());
    for (const file of plan.files) {
      const relative = path.relative(context.home, file.path);
      if (fixture.restoresByValue?.includes(relative))
        assert.deepEqual(
          editors[file.format].parse(after[relative]!),
          editors[file.format].parse(expected[relative]!),
          relative,
        );
      else assert.equal(after[relative], expected[relative], relative);
    }
    assert.doesNotMatch(await allText(context.home), /hhk_/);
  });

  void test(`${id}: refuses a configuration it cannot parse and writes nothing`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, existing);
    const [relative, text] = Object.entries(existing)[0]!;
    await writeFile(path.join(context.home, relative), broken(relative, text));
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
    await writeFiles(outside, existing);
    const directory = path.dirname(Object.keys(existing)[0]!);
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
    const cases = [
      ...(key
        ? [
            {
              field: key,
              value: NEW_KEY.keyText,
              kind: "unwired",
              reason: "other-key",
            },
          ]
        : []),
      {
        field: base,
        value: "http://127.0.0.1:9999/v1",
        kind: "foreign-gateway",
        reason: "changed",
      },
      ...(model
        ? [
            {
              field: model,
              value: "other/model",
              kind: "replaced",
              reason: "changed",
            },
          ]
        : []),
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
        [[field.file, asText(field.path), reason]],
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
    // Base URLs other than the agent's own (another model's entry, a model
    // list's provider) are wired values that changed.
    assert.deepEqual(
      moved.kinds.filter((kind) => kind !== "replaced"),
      ["foreign-gateway"],
    );
    assert.ok(
      moved.findings.some(
        (finding) =>
          finding.path === base.file &&
          JSON.stringify(finding.keyPath) ===
            JSON.stringify(asText(base.path)) &&
          finding.kind === "foreign-gateway",
      ),
    );
    await rm(record.files[0]!.path);
    const missing = await detectDrift(record, context);
    assert.deepEqual(missing.kinds, ["unwired"]);
    assert.equal(missing.findings[0]!.reason, "file-missing");
  });

  void test(`${id}: re-wiring replaces the key id and unwire still restores the original`, async (t) => {
    const context = await sandbox(t);
    await writeFiles(context.home, existing);
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
