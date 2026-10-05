// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import type { BackupBundle } from "../src/backup.js";
import type { ManagedSecrets } from "../src/http/api-v1.js";
import { SyncService, type SyncBackups } from "../src/sync.js";
import type { Fetch } from "../src/sync-remote.js";

const INTERVAL = 180_000;
const FIRST = 20_000;

interface Timer {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

function memorySecrets(): ManagedSecrets & { values: Map<string, string> } {
  const values = new Map<string, string>();
  let next = 0;
  return {
    backend: "file",
    values,
    async create(value) {
      next += 1;
      values.set(`s${next}`, value);
      return { kind: "store", value: `s${next}` };
    },
    async rotate(ref, value) {
      values.set(ref.value, value);
    },
    async delete(ref: SecretReference) {
      return values.delete(ref.value);
    },
    async resolve(ref) {
      const value = values.get(ref.value);
      assert.ok(value !== undefined, `no secret ${ref.value}`);
      return value;
    },
  };
}

const bundle: BackupBundle = {
  version: 1,
  createdAt: "2026-10-04T00:00:00.000Z",
  app: "HarnessHub test",
  keys: true,
  providers: [],
  groups: [],
  settings: {},
  agents: [],
  clientKeys: [],
};

const backups: SyncBackups = {
  collect: async () => structuredClone(bundle),
  lastChange: async () => undefined,
  bringProviders: async () => ({ kept: [] }),
  bringAgents: async () => [],
  bringProfiles: async () => undefined,
  bringLibrary: async () => ({
    restore: {
      instructions: { added: [], replaced: [], removed: [] },
      mcp: { added: [], replaced: [], removed: [], needSecret: [] },
      skills: { added: [], replaced: [], removed: [], incomplete: [] },
      refused: [],
    },
  }),
  bringFeatures: async () => ({
    redaction: { enabled: true, turnsOff: false, turnsOn: false },
    rules: { added: [], replaced: [], removed: [] },
    vision: null,
    search: { added: [], replaced: [], removed: [], needKey: [] },
    alerts: { usagePercent: null, changed: false },
  }),
  serial: (action) => action(),
};

void test("the loop syncs after a first delay, then every interval, waits longer for a server limiting requests, and stops on close", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hh-sync-loop-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const timers: Timer[] = [];
  const answers: Array<() => Response> = [];
  const requests: string[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push(`${init.method} ${url.pathname}`);
    const answer = answers.shift();
    assert.ok(answer, `unexpected ${init.method} ${url.href}`);
    return answer();
  };
  const service = new SyncService({
    dataDir,
    backups,
    secrets: memorySecrets(),
    environment: {},
    fetch,
    timers: {
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as Timer).cleared = true;
      },
    },
    intervalMs: INTERVAL,
    firstDelayMs: FIRST,
    clock: () => new Date("2026-10-04T08:00:00.000Z"),
  });
  await service.load();
  service.start();
  assert.equal(timers.length, 0, "off: nothing is scheduled");

  await service.configure({
    kind: "webdav",
    url: "https://dav.example.invalid/dav",
    passphrase: "synthetic passphrase",
  });
  const pending = () => timers.filter((timer) => !timer.cleared);
  assert.deepEqual(
    pending().map((timer) => timer.ms),
    [FIRST],
  );
  /** Fires the one pending timer and waits for the next to be scheduled. */
  const fire = async () => {
    const [timer] = pending();
    assert.ok(timer);
    timer.cleared = true;
    const before = timers.length;
    timer.callback();
    // Sealing derives a key on the thread pool: wait in real time.
    for (let turn = 0; turn < 2000 && timers.length === before; turn++)
      await delay(5);
    return pending().map((item) => item.ms);
  };

  // First sync: nothing on the server; this machine's setup goes up.
  answers.push(
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 201, headers: { etag: '"v1"' } }),
    () => new Response(null, { status: 200 }),
  );
  assert.deepEqual(await fire(), [INTERVAL]);
  assert.equal(service.status().lastError, undefined);
  assert.ok(service.status().lastSyncAt);

  // A server limiting requests: its Retry-After, at least the interval.
  answers.push(
    () =>
      new Response(null, { status: 429, headers: { "retry-after": "600" } }),
  );
  assert.deepEqual(await fire(), [600_000]);
  assert.match(service.status().lastError ?? "", /limiting requests/);
  // Without Retry-After: twice the last wait.
  answers.push(() => new Response(null, { status: 503 }));
  assert.deepEqual(await fire(), [1_200_000]);
  // Unchanged on both sides: one conditional read, back to the interval.
  answers.push(() => new Response(null, { status: 304 }));
  assert.deepEqual(await fire(), [INTERVAL]);
  assert.equal(service.status().lastError, undefined);
  assert.deepEqual(requests, [
    "GET /dav/harnesshub/harnesshub.harnesshub-backup",
    "PUT /dav/harnesshub/harnesshub.harnesshub-backup",
    "HEAD /dav/harnesshub/harnesshub.harnesshub-backup",
    "GET /dav/harnesshub/harnesshub.harnesshub-backup",
    "GET /dav/harnesshub/harnesshub.harnesshub-backup",
    "GET /dav/harnesshub/harnesshub.harnesshub-backup",
  ]);

  await service.close();
  assert.deepEqual(pending(), [], "close stops the loop");
});
