// SPDX-License-Identifier: MIT
/** `X-HH-Credential`: pinning a call to one credential (Magpie `X-Magpie-Account`). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  addKey,
  at,
  CHAT_REPLY,
  group,
  json,
  MemoryStore,
  mount,
  provider,
  send,
  upstream,
} from "./shared-support.js";

const MESSAGES = [{ role: "user", content: "hi" }];

/** Provider a has two credentials (key-a, key-b), provider b one (key-c); one upstream. */
async function setup(t: test.TestContext) {
  const up = await upstream(t, (response, seen, request) =>
    seen.headers.authorization === "Bearer sk-upstream-b-0002"
      ? json(402, { error: { message: "Insufficient Balance" } })(
          response,
          seen,
          request,
        )
      : CHAT_REPLY(response, seen, request),
  );
  const store = new MemoryStore();
  await store.putProvider(
    provider("a", { chat: `${up.base}/v1` }, { secrets: ["key-a", "key-b"] }),
  );
  await store.putProvider(
    provider(
      "b",
      { chat: `${up.base}/v1`, anthropic: up.base },
      { secrets: ["key-c"], translateOnly: true },
    ),
  );
  await store.putProvider(
    provider("other", { chat: `${up.base}/v1` }, { secrets: ["key-c"] }),
  );
  const named = store.providers.get("other")!;
  named.credentials[0]!.name = "Team Key";
  await store.putRouteGroup(group("g", ["a/model-a", "b/model-a"]));
  const key = await addKey(store, ["a/*", "b/*", "group/g"]);
  const gw = await mount(t, store);
  const call = (model: string, pin?: string, path = "/v1/chat/completions") =>
    send(gw.port, path, {
      headers: {
        authorization: `Bearer ${key.text}`,
        ...(pin === undefined ? {} : { "x-hh-credential": pin }),
      },
      body: { model, messages: MESSAGES, max_tokens: 5 },
    });
  const used = () =>
    up.seen.map((seen) => seen.headers.authorization?.slice(-4));
  return { up, store, gw, call, used };
}

void test("a pinned call uses only that credential, by ID or by name, and the header stays home", async (t) => {
  const { up, store, call, used } = await setup(t);
  assert.equal((await call("a/model-a", "cred-0")).status, 200);
  assert.equal((await call("a/model-a", "CREDENTIAL 0")).status, 200);
  assert.deepEqual(used(), ["0001", "0001"]);
  assert.ok(
    up.seen.every((seen) => seen.headers["x-hh-credential"] === undefined),
    "X-HH-Credential is never sent upstream",
  );
  assert.ok(store.entries[0]!.patches.includes("credential:pinned"));
  // Across a group's members: provider a's and provider b's cred-0 both match;
  // the translated path does not forward it either.
  const translated = await call("b/model-a", "cred-0", "/v1/messages");
  assert.equal(translated.status, 200);
  assert.equal(up.seen.at(-1)!.headers["x-hh-credential"], undefined);
  assert.equal((await call("group/g", "cred-0")).status, 200);
  assert.deepEqual(
    store.entries.at(-1)!.attempts.map((attempt) => attempt.provider),
    ["a"],
  );
});

void test("a pinned credential that rests answers 429 and nothing else is tried", async (t) => {
  const { up, store, call, gw } = await setup(t);
  // cred-1's credit refusal rests it (a minute, as one key's failure);
  // pinned, cred-0 does not take over.
  assert.equal((await call("a/model-a", "cred-1")).status, 402);
  assert.equal(up.seen.length, 1);
  const answer = await call("a/model-a", "cred-1");
  assert.equal(answer.status, 429);
  assert.equal(up.seen.length, 1, "no upstream contacted");
  assert.equal(answer.headers["retry-after"], "60");
  assert.equal(answer.headers["x-hh-error-source"], "gateway");
  assert.match(
    String(at(answer.json(), "error", "message")),
    /X-HH-Credential: credential "cred-1" rests until 2026-10-02T12:01:00\.000Z \(insufficient_balance\); no other credential is tried in its place/,
  );
  const entry = store.entries.at(-1)!;
  assert.deepEqual(
    [entry.status, entry.errorClass, entry.attempts.length],
    [429, "credential_resting", 0],
  );
  assert.equal(
    (await call("a/model-a")).status,
    200,
    "unpinned, cred-0 serves",
  );
  gw.clock.now += 60_000;
  assert.equal(
    (await call("a/model-a", "cred-1")).status,
    402,
    "after its rest the pinned credential is probed, and only it",
  );
  assert.deepEqual(
    up.seen.map((seen) => seen.headers.authorization?.slice(-4)),
    ["0002", "0001", "0002"],
  );
});

void test("a pinned credential that does not serve the model is 400; one outside the candidates is 404, as an unknown one", async (t) => {
  const { up, call, store } = await setup(t);
  const unlisted = await call("a/model-x", "cred-0");
  assert.equal(unlisted.status, 400, "provider a does not list model-x");
  assert.equal(at(unlisted.json(), "error", "code"), "credential_unserved");
  // Provider other's "Team Key" exists, but not among a/model-a's
  // candidates: the answer is the one for a name nothing has.
  const elsewhere = await call("a/model-a", "team key");
  const unknown = await call("a/model-a", "nobody");
  for (const [answer, label] of [
    [elsewhere, '"team key"'],
    [unknown, '"nobody"'],
  ] as const) {
    assert.equal(answer.status, 404, label);
    assert.deepEqual(answer.json(), {
      error: {
        message: `X-HH-Credential: no enabled credential ${label}; a/model-a is served by a/credential 0, a/credential 1`,
        type: "not_found_error",
        param: null,
        code: "credential_not_found",
      },
    });
  }
  assert.equal(up.seen.length, 0);
  assert.deepEqual(
    store.entries.map((entry) => [entry.status, entry.errorClass]),
    [
      [400, "credential_unserved"],
      [404, "credential_not_found"],
      [404, "credential_not_found"],
    ],
  );
});
