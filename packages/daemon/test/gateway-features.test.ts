// SPDX-License-Identifier: MIT
/** The gateway features file: defaults, a refused hand-edited file, and keys that never reach it. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import { HubError } from "@harnesshub/core/errors";
import {
  GATEWAY_FEATURES_FILE,
  GatewayFeaturesFile,
} from "../src/gateway-features.js";
import type { ManagedSecrets } from "../src/http/api-v1.js";

/** An in-memory secret store; `fail` makes the next create throw. */
function memorySecrets() {
  const values = new Map<string, string>();
  let next = 0;
  const secrets: ManagedSecrets = {
    backend: "file",
    async create(value) {
      const ref: SecretReference = { kind: "store", value: `secret-${++next}` };
      values.set(ref.value, value);
      return ref;
    },
    async rotate(ref, value) {
      values.set(ref.value, value);
    },
    async delete(ref) {
      return values.delete(ref.value);
    },
    async resolve(ref) {
      const value = values.get(ref.value);
      if (value === undefined) throw new Error("missing");
      return value;
    },
  };
  return { secrets, values };
}

void test("the features file starts at the defaults, keeps keys out and refuses a broken file", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hh-features-file-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { secrets, values } = memorySecrets();
  const file = new GatewayFeaturesFile({ dataDir, secrets });
  await file.load();
  assert.deepEqual(file.current(), {
    schemaVersion: 1,
    redaction: { enabled: true, rules: [] },
  });
  await file.addSearch({ kind: "brave", key: "brave-synthetic-key-1" });
  // A refused backend stores no key.
  await assert.rejects(file.addSearch({ kind: "searxng" }));
  assert.equal(values.size, 1);
  const text = await readFile(
    path.join(dataDir, GATEWAY_FEATURES_FILE),
    "utf8",
  );
  assert.ok(!text.includes("brave-synthetic-key-1"));
  // A second process reads the same settings.
  const again = new GatewayFeaturesFile({ dataDir, secrets });
  await again.load();
  assert.equal(again.current().search?.backends[0]?.kind, "brave");
  await again.removeSearch("search-1");
  assert.equal(values.size, 0, "the key is deleted with its backend");
  await assert.rejects(
    again.removeSearch("search-1"),
    (error: unknown) =>
      error instanceof HubError && error.code === "SEARCH_BACKEND_NOT_FOUND",
  );
  // A hand-edited file that is not valid stops the start, not redaction.
  await writeFile(
    path.join(dataDir, GATEWAY_FEATURES_FILE),
    JSON.stringify({
      schemaVersion: 1,
      redaction: { enabled: "no", rules: [] },
    }),
  );
  await assert.rejects(
    new GatewayFeaturesFile({ dataDir, secrets }).load(),
    (error: unknown) =>
      error instanceof HubError && error.code === "GATEWAY_FEATURES_INVALID",
  );
});
