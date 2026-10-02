// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { HubError } from "@harnesshub/core/errors";
import type { ModelCallEntry } from "@harnesshub/core/model-plane";
import { parseCatalog } from "@harnesshub/gateway/catalog";
import {
  CatalogRefresher,
  DEFAULT_CATALOG_URL,
  resolveCatalogSettings,
  type CatalogSettings,
  type RefreshTimers,
} from "@harnesshub/gateway/catalog-refresh";
import { temporaryDirectory } from "../support/temporary.js";

const URL_ = "http://127.0.0.1:9/api.json";
const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-10-03T00:00:00.000Z");

/** A bundled snapshot retrieved before the test's clock starts. */
const bundled = (retrievedAt = "2026-10-01T00:00:00.000Z") =>
  parseCatalog(
    JSON.stringify({
      meta: {
        schemaVersion: 1,
        source: DEFAULT_CATALOG_URL,
        repository: "https://github.com/anomalyco/models.dev",
        license: "MIT (models.dev.LICENSE)",
        retrievedAt,
        etag: 'W/"bundled"',
        commit: "0".repeat(40),
        sha256: "b".repeat(64),
        bytes: 10,
        providers: 1,
        models: 1,
      },
      providers: {
        "vendor-cn": {
          name: "Vendor",
          models: { "chat-1": { context: 1000, price: { input: 9 } } },
        },
      },
    }),
  );

/** A models.dev api.json with one model at `input` USD per million tokens. */
function api(input: number): string {
  return JSON.stringify({
    "vendor-cn": {
      id: "vendor-cn",
      name: "Vendor",
      models: {
        "chat-1": {
          limit: { context: 2000, output: 100 },
          cost: { input, output: 2 },
          tool_call: true,
        },
      },
    },
  });
}

type Reply = (signal: AbortSignal) => Response | Promise<Response>;

function upstream(...replies: Reply[]) {
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      ifNoneMatch: new Headers(init?.headers).get("if-none-match"),
    });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected catalog request");
    return reply(init!.signal!);
  }) as typeof globalThis.fetch;
  return { fetch, requests, replies };
}

const ok =
  (body: string, etag?: string): Reply =>
  () =>
    new Response(body, {
      status: 200,
      headers: etag ? { etag } : {},
    });

function timers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const fake: RefreshTimers = {
    set: (callback, ms) => {
      next += 1;
      pending.set(next, { callback, ms });
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  const only = () => {
    assert.equal(pending.size, 1, "one timer is pending");
    const [entry] = [...pending];
    assert.ok(entry);
    const [handle, timer] = entry;
    return { handle, ...timer };
  };
  const fire = () => {
    const { handle, callback } = only();
    pending.delete(handle);
    callback();
  };
  return { fake, pending, only, fire };
}

function call(patch: Partial<ModelCallEntry> = {}): ModelCallEntry {
  return {
    status: 200,
    cost: null,
    usage: {
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 5,
      reasoning: 0,
      source: "reported",
    },
    ...patch,
  } as ModelCallEntry;
}

function rejectsWith(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HubError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

void test("background refresh is on by default; HH_OFFLINE=1 or the setting turns it off", () => {
  assert.deepEqual(resolveCatalogSettings(undefined, {}), {
    autoRefresh: true,
    url: DEFAULT_CATALOG_URL,
  });
  assert.deepEqual(
    resolveCatalogSettings({ autoRefresh: true }, { HH_OFFLINE: "1" }),
    {
      autoRefresh: false,
      disabledBy: "offline",
      url: DEFAULT_CATALOG_URL,
    },
  );
  assert.deepEqual(
    resolveCatalogSettings(
      { autoRefresh: false, url: URL_ },
      { HH_OFFLINE: "0" },
    ),
    { autoRefresh: false, disabledBy: "setting", url: URL_ },
  );
  for (const [input, environment] of [
    [{ autoRefresh: "no" }, {}],
    [{ refresh: true }, {}],
    [{ url: "http://models.example/api.json" }, {}],
    [{ url: "https://user:secret@models.example/api.json" }, {}],
    [{ url: "not a url" }, {}],
    [[], {}],
    [undefined, { HH_OFFLINE: "yes" }],
  ] as const)
    assert.throws(
      () => resolveCatalogSettings(input, environment),
      /catalog|HH_OFFLINE/,
      JSON.stringify(input),
    );
});

void test("a refresh replaces the catalog in use beside the bundled snapshot, and a failure keeps it", async (t) => {
  const { directory } = await temporaryDirectory(t, "harnesshub-catalog-");
  const settings: CatalogSettings = {
    autoRefresh: false,
    disabledBy: "setting",
    url: URL_,
  };
  const body = api(1);
  const fake = upstream(
    ok(body, 'W/"e2"'),
    () => new Response(null, { status: 304 }),
    () => new Response("upstream says no", { status: 500 }),
    ok("[]"),
  );
  let now = START;
  const logs: string[] = [];
  const open = (bundle = () => bundled()) =>
    CatalogRefresher.open({
      directory,
      settings,
      bundled: bundle,
      fetch: fake.fetch,
      now: () => now,
      log: {
        level: "info",
        info: (event) => void logs.push(event),
        debug: () => undefined,
      },
    });
  const refresher = await open();
  t.after(() => refresher.close());
  let updates = 0;
  refresher.subscribe(async () => {
    updates += 1;
  });
  assert.equal(refresher.status().source, "bundled");
  assert.equal(refresher.status().lastRefresh, null);
  assert.equal(
    refresher.current().lookup("vendor-cn", "chat-1")?.context,
    1000,
  );

  // A manual refresh runs with the background refresh off.
  const updated = await refresher.refresh();
  assert.equal(updated.source, "refreshed");
  assert.deepEqual(updated.lastRefresh, {
    at: new Date(START).toISOString(),
    outcome: "updated",
  });
  assert.equal(updated.snapshot.source, URL_);
  assert.equal(updated.snapshot.etag, 'W/"e2"');
  assert.equal(updated.snapshot.commit, null);
  assert.equal(
    updated.snapshot.sha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.deepEqual(refresher.current().lookup("vendor-cn", "chat-1"), {
    context: 2000,
    output: 100,
    toolCall: true,
    price: { input: 1, output: 2 },
  });
  assert.equal(updates, 1);
  assert.deepEqual(fake.requests[0], { url: URL_, ifNoneMatch: 'W/"bundled"' });
  // The bundled snapshot is untouched; the copy is in the data directory.
  assert.equal(
    parseCatalog(
      await readFile(path.join(directory, "models-dev.json"), "utf8"),
    ).meta.etag,
    'W/"e2"',
  );

  // Not modified: nothing changes and no listener runs.
  now += HOUR;
  assert.equal((await refresher.refresh()).lastRefresh?.outcome, "unchanged");
  assert.equal(fake.requests[1]?.ifNoneMatch, 'W/"e2"');
  assert.equal(updates, 1);

  // Failures keep the catalog in use and name only the host and status.
  now += HOUR;
  await assert.rejects(
    refresher.refresh(),
    rejectsWith("CATALOG_REFRESH_FAILED", /127\.0\.0\.1:9 answered HTTP 500$/),
  );
  await assert.rejects(
    refresher.refresh(),
    rejectsWith(
      "CATALOG_REFRESH_FAILED",
      /did not return a valid models\.dev catalog/,
    ),
  );
  assert.equal(refresher.status().lastRefresh?.outcome, "failed");
  assert.equal(
    refresher.current().lookup("vendor-cn", "chat-1")?.context,
    2000,
  );
  assert.equal(updates, 1);
  assert.equal(
    JSON.stringify(refresher.status()).includes("upstream says no"),
    false,
  );

  // The copy and the last attempt survive a reopen; a newer bundled snapshot wins.
  const reopened = await open();
  t.after(() => reopened.close());
  assert.equal(reopened.status().source, "refreshed");
  assert.equal(reopened.status().lastRefresh?.outcome, "failed");
  assert.equal(reopened.current().lookup("vendor-cn", "chat-1")?.context, 2000);
  const upgraded = await open(() => bundled("2026-12-01T00:00:00.000Z"));
  t.after(() => upgraded.close());
  assert.equal(upgraded.status().source, "bundled");

  // A damaged copy is ignored and logged.
  await writeFile(path.join(directory, "models-dev.json"), "{");
  const damaged = await open();
  t.after(() => damaged.close());
  assert.equal(damaged.status().source, "bundled");
  assert.ok(logs.includes("catalog.load_failed"));
});

void test("background refresh runs at start, every 24 hours, and early after an unpriced call at most every 6 hours", async (t) => {
  const { directory } = await temporaryDirectory(t, "harnesshub-catalog-");
  let now = START;
  const clock = timers();
  const fake = upstream(
    ok(api(1), '"a"'),
    () => new Response(null, { status: 304 }),
    ok(api(2), '"b"'),
  );
  const refresher = await CatalogRefresher.open({
    directory,
    settings: { autoRefresh: true, url: URL_ },
    bundled,
    fetch: fake.fetch,
    now: () => now,
    timers: clock.fake,
  });
  t.after(() => refresher.close());
  // Nothing runs before the owner starts it, and calls do not trigger it.
  refresher.noteCall(call());
  assert.equal(clock.pending.size, 0);
  assert.equal(fake.requests.length, 0);
  refresher.start();
  assert.equal(clock.only().ms, 0);
  assert.equal(refresher.status().nextRefreshAt, new Date(START).toISOString());
  clock.fire();
  await refresher.refresh(); // joins the background refresh
  assert.equal(fake.requests.length, 1);
  assert.equal(refresher.status().lastRefresh?.outcome, "updated");
  assert.equal(clock.only().ms, 24 * HOUR);
  assert.equal(
    refresher.status().nextRefreshAt,
    new Date(START + 24 * HOUR).toISOString(),
  );

  // An unpriced call refreshes early only 6 hours after the last attempt.
  now += 5 * HOUR;
  refresher.noteCall(call());
  assert.equal(fake.requests.length, 1);
  now += HOUR;
  for (const priced of [
    call({ cost: { amountUsd: 0, priceSource: "provider" } }),
    call({ rejected: true }),
    call({ status: 502 }),
    (({ usage: _usage, ...rest }) => rest as ModelCallEntry)(call()),
    call({
      usage: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        source: "missing",
      },
    }),
  ])
    refresher.noteCall(priced);
  assert.equal(fake.requests.length, 1);
  refresher.noteCall(call());
  await refresher.refresh();
  assert.equal(fake.requests.length, 2);
  assert.equal(refresher.status().lastRefresh?.outcome, "unchanged");
  assert.equal(clock.only().ms, 24 * HOUR);

  // The next day's refresh, then close: the timer is cleared.
  now += 24 * HOUR;
  clock.fire();
  await refresher.refresh();
  assert.equal(fake.requests.length, 3);
  assert.equal(
    refresher.current().lookup("vendor-cn", "chat-1")?.price?.input,
    2,
  );
  await refresher.close();
  assert.equal(clock.pending.size, 0);
  assert.equal(refresher.status().nextRefreshAt, null);
  refresher.noteCall(call());
  await assert.rejects(refresher.refresh(), rejectsWith("CATALOG_CLOSED"));
});

void test("with background refresh off nothing is scheduled, and closing aborts a running refresh", async (t) => {
  const { directory } = await temporaryDirectory(t, "harnesshub-catalog-");
  const clock = timers();
  let aborted = false;
  const fake = upstream(
    (signal) =>
      new Promise<Response>((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason as Error);
        }),
      ),
  );
  const refresher = await CatalogRefresher.open({
    directory,
    settings: { autoRefresh: false, disabledBy: "offline", url: URL_ },
    bundled,
    fetch: fake.fetch,
    timers: clock.fake,
  });
  refresher.start();
  refresher.noteCall(call());
  assert.equal(clock.pending.size, 0);
  assert.equal(fake.requests.length, 0);
  assert.deepEqual(refresher.status().autoRefresh, {
    enabled: false,
    disabledBy: "offline",
  });
  const running = refresher.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.requests.length, 1);
  await refresher.close();
  assert.equal(aborted, true);
  await assert.rejects(
    running,
    rejectsWith("CATALOG_REFRESH_FAILED", /shutting down/),
  );
  // A refresh cut short by closing records nothing.
  assert.equal(refresher.status().lastRefresh, null);
  await assert.rejects(
    readFile(path.join(directory, "refresh.json"), "utf8"),
    /ENOENT/,
  );
});
