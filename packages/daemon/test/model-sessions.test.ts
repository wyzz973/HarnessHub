// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  issueGatewayKey,
  type GatewayKeyRecord,
  type GatewayKeyScope,
  type ModelCallEntry,
  type ModelCallId,
  type ModelPlaneStore,
  type ProviderConfig,
  type RouteGroup,
} from "@harnesshub/core/model-plane";
import { NO_LOG } from "@harnesshub/core/logging";
import type {
  EngineProfile,
  EventDraft,
  RunId,
  RunRecord,
  SessionId,
  SessionRecord,
} from "@harnesshub/core/types";
import { ModelSessions } from "../src/model-sessions.js";

const STAMP = "2026-10-03T00:00:00.000Z";

/** The ModelPlaneStore methods ModelSessions uses. */
function fakeStore() {
  const keys = new Map<string, GatewayKeyRecord>();
  const provider = {
    id: "p",
    models: {
      list: [{ id: "m", contextWindow: 32768, maxOutputTokens: 4096 }],
    },
  } as unknown as ProviderConfig;
  const store = {
    createGatewayKey: async (record: GatewayKeyRecord) =>
      void keys.set(record.keyId, record),
    listGatewayKeys: async () => [...keys.values()],
    revokeGatewayKey: async (id: string, at: string) => {
      const key = keys.get(id);
      if (key) key.revokedAt = at;
      return key !== undefined;
    },
    getProvider: async (id: string) => (id === "p" ? provider : undefined),
    getRouteGroup: async (id: string) =>
      id === "default"
        ? ({ id, members: ["p/m"] } as unknown as RouteGroup)
        : undefined,
  } as unknown as ModelPlaneStore;
  return { store, keys };
}
function sessions(store: ModelPlaneStore, events: EventDraft[] = []) {
  return new ModelSessions({
    store,
    events: () => ({
      appendEvent: (_run: RunId, draft: EventDraft) => events.push(draft),
    }),
    gateway: () => ({ awaitSessionIdle: async () => undefined }),
    origin: () => "http://127.0.0.1:3180",
    route: (profile) =>
      profile.id === "native"
        ? undefined
        : { adapter: "claude", required: false },
    clock: () => Date.parse(STAMP),
    log: NO_LOG,
  });
}
const profile = (id = "engine") => ({ id }) as EngineProfile;
const session = (id: string) => ({ id }) as SessionRecord;
const run = (id: string, model?: string) =>
  ({
    id,
    generation: 2,
    input: { text: "", timeoutMs: 1, ...(model ? { model } : {}) },
  }) as unknown as RunRecord;

void test("a Run gets the session key and target; a re-issued key revokes the Session's earlier key", async () => {
  const { store, keys } = fakeStore();
  const first = sessions(store);
  const gateway = await first.begin(session("s1"), run("r1"), profile());
  assert.deepEqual(
    { ...gateway, key: undefined },
    {
      baseUrl: "http://127.0.0.1:3180",
      key: undefined,
      adapter: "claude",
      contextWindow: 32768,
      maxOutputTokens: 4096,
    },
  );
  assert.match(gateway!.key, /^hhk_s_/);
  assert.deepEqual(first.activeRun("s1" as SessionId), {
    runId: "r1",
    generation: 2,
    target: "group/default",
  });
  await first.end(session("s1"), run("r1"));
  assert.equal(first.activeRun("s1" as SessionId), undefined);
  // A later Run keeps the same key.
  assert.equal(
    (await first.begin(session("s1"), run("r2", "p/m"), profile()))!.key,
    gateway!.key,
  );
  assert.equal(first.activeRun("s1" as SessionId)?.target, "p/m");
  assert.equal(keys.size, 1);

  // A process that lost the key text issues a new one and revokes the earlier key.
  const second = sessions(store);
  const again = await second.begin(session("s1"), run("r3"), profile());
  assert.notEqual(again!.key, gateway!.key);
  const records = [...keys.values()];
  assert.equal(records.length, 2);
  assert.ok(records[0]!.revokedAt, "the earlier key is revoked");
  assert.equal(records[1]!.revokedAt, undefined);

  await second.close("s1" as SessionId);
  assert.ok([...keys.values()].every((key) => key.revokedAt));
});

void test("startup revokes every earlier session key and leaves client keys alone", async () => {
  const { store, keys } = fakeStore();
  const scopes: GatewayKeyScope[] = [
    { kind: "session", sessionId: "open-session" as SessionId },
    { kind: "session", sessionId: "closed-session" as SessionId },
    { kind: "client", name: "script" },
  ];
  for (const scope of scopes) {
    const issued = issueGatewayKey(scope);
    keys.set(issued.keyId, {
      keyId: issued.keyId,
      name: "k",
      scope,
      modelAllow: [],
      secretHash: issued.secretHash,
      createdAt: STAMP,
    } as GatewayKeyRecord);
  }
  await sessions(store).revokeAll();
  assert.deepEqual(
    [...keys.values()].map((key) => [
      key.scope.kind,
      key.revokedAt !== undefined,
    ]),
    [
      ["session", true],
      ["session", true],
      ["client", false],
    ],
  );
});

void test("routing decisions: no target keeps the native login, a named model must exist, committed calls become events", async () => {
  const { store } = fakeStore();
  const events: EventDraft[] = [];
  const models = sessions(store, events);
  assert.equal(
    await models.begin(session("native"), run("r1"), profile("native")),
    undefined,
  );
  await assert.rejects(
    models.begin(session("native"), run("r2", "p/m"), profile("native")),
    { code: "MODEL_SELECTION_UNSUPPORTED" },
  );
  await assert.rejects(
    models.begin(session("s2"), run("r3", "nope/x"), profile()),
    { code: "MODEL_NOT_CONFIGURED" },
  );
  await models.begin(session("s3"), run("r4"), profile());
  const entry = (status: number, error?: string): ModelCallEntry => ({
    callId: `mc_${status}` as ModelCallId,
    occurredAt: STAMP,
    sessionId: "s3" as SessionId,
    runId: "r4" as RunId,
    scope: { kind: "session", sessionId: "s3" as SessionId },
    inbound: { protocol: "chat", path: "/v1/chat/completions", stream: false },
    patches: [],
    unmapped: [],
    status,
    ...(error ? { errorClass: "upstream_rejected", error } : {}),
    timing: { durationMs: 5 },
    attempts: [],
    cost: null,
  });
  models.committed(entry(200));
  models.committed(entry(400, "bad request"));
  models.committed(entry(499));
  assert.equal(events.length, 3);
  assert.deepEqual(await models.end(session("s3"), run("r4")), {
    calls: 3,
    successfulCalls: 1,
    lastError: "上游模型返回 HTTP 400：bad request",
  });
});
