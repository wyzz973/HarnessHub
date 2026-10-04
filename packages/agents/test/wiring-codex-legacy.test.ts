// SPDX-License-Identifier: MIT
/**
 * A Codex wiring in ChatGPT mode from before that mode took a Gateway Key
 * (ADR 0030): no key in the record, `openai_base_url` without one. Wiring
 * it again shows the key being added to the base URL, masked, and the new
 * key's id, before anything is written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WiringRecord } from "@harnesshub/core/model-plane";
import {
  applyWiring,
  detectDrift,
  planWiring,
  unwire,
  type WiringTarget,
} from "../src/wiring/index.js";
import {
  assertUnwound,
  KEY,
  NEW_KEY,
  sandbox,
  writeFiles,
} from "./wiring-support.js";

const BASE = "http://127.0.0.1:3180";
const ORIGINAL = `model = "gpt-5.5-codex"\n`;

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The record and files a ChatGPT-mode wiring left before keys: wired now,
 * then its manifest, file and record rewritten as the older version wrote
 * them (the base URL without a key, no key id).
 */
async function legacyRecord(
  context: Awaited<ReturnType<typeof sandbox>>,
  target: WiringTarget,
): Promise<WiringRecord> {
  const { record } = await applyWiring("codex", target, context);
  const entry = record.files[0]!;
  const manifests = path.join(
    context.dataDir,
    "backups",
    "wiring",
    "codex",
    "manifests",
  );
  const manifest = await readFile(
    path.join(manifests, `${entry.backupId}.json`),
    "utf8",
  );
  const legacy = manifest.replace(
    "/backend-api/codex/{{harnesshub:gateway-key}}",
    "/backend-api/codex",
  );
  assert.notEqual(legacy, manifest);
  await writeFile(path.join(manifests, `${sha256(legacy)}.json`), legacy);
  const text = `${ORIGINAL}openai_base_url = "${BASE}/backend-api/codex"\n`;
  await writeFile(entry.path, text);
  const { keyId: _keyId, ...rest } = record;
  return {
    ...rest,
    files: [{ ...entry, backupId: sha256(legacy), afterHash: sha256(text) }],
  };
}

void test("re-wiring a ChatGPT-mode Codex wired without a key shows the key added to its base URL before writing", async (t) => {
  const context = await sandbox(t);
  await writeFiles(context.home, { ".codex/config.toml": ORIGINAL });
  const chatgpt: WiringTarget = {
    baseUrl: BASE,
    ...KEY,
    models: [],
    options: { codexAuth: "chatgpt" },
  };
  const previous = await legacyRecord(context, chatgpt);
  assert.equal(previous.keyId, undefined);
  assert.equal((await detectDrift(previous, context)).drifted, false);

  const target = { ...chatgpt, ...NEW_KEY };
  const plan = await planWiring("codex", target, context, { previous });
  assert.equal(plan.keyId, NEW_KEY.keyId);
  assert.equal(plan.model, undefined);
  const [file] = plan.files;
  assert.deepEqual(file!.changes, [
    {
      keyPath: ["openai_base_url"],
      op: "set",
      before: JSON.stringify(`${BASE}/backend-api/codex`),
      after: JSON.stringify(`${BASE}/backend-api/codex/hhk_a_mnop…`),
    },
    // The provider table both modes now write, which unwire leaves.
    {
      keyPath: ["model_providers", "harnesshub"],
      op: "set",
      after: JSON.stringify({
        name: "HarnessHub",
        base_url: `${BASE}/v1`,
        wire_api: "responses",
        experimental_bearer_token: "hhk_a_mnop…",
      }),
    },
  ]);
  assert.match(
    file!.diff,
    /^-openai_base_url = "http:\/\/127\.0\.0\.1:3180\/backend-api\/codex"$/m,
  );
  assert.match(
    file!.diff,
    /^\+openai_base_url = "http:\/\/127\.0\.0\.1:3180\/backend-api\/codex\/hhk_a_mnop…"$/m,
  );
  assert.ok(!JSON.stringify(plan).includes(NEW_KEY.keyText));

  const { record } = await applyWiring("codex", target, context, {
    previous,
    expect: plan,
  });
  assert.equal(record.keyId, NEW_KEY.keyId);
  assert.ok(
    (
      await readFile(path.join(context.home, ".codex", "config.toml"), "utf8")
    ).startsWith(
      `${ORIGINAL}openai_base_url = "${BASE}/backend-api/codex/${NEW_KEY.keyText}"\n`,
    ),
  );
  assert.equal((await detectDrift(record, context)).drifted, false);
  await unwire(record, context);
  await assertUnwound("codex", context.home, {
    ".codex/config.toml": ORIGINAL,
  });
});
