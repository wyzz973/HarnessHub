// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { ConsoleSessions } from "../src/http/console-session.js";

const HOUR = 60 * 60_000;

function clock(start = Date.UTC(2026, 9, 4)) {
  const time = { now: start };
  return { time, now: () => time.now };
}

void test("a login code works once and only within 60 seconds", () => {
  const { time, now } = clock();
  const sessions = new ConsoleSessions(now);
  const link = sessions.createLink();
  assert.match(link.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(link.expiresAt, new Date(time.now + 60_000).toISOString());
  const created = sessions.exchange(link.code);
  assert.ok(created);
  assert.match(created.browserKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(created.browserKey, created.token);
  assert.equal(sessions.exchange(link.code), undefined, "used");

  const late = sessions.createLink();
  time.now += 60_000;
  assert.equal(sessions.exchange(late.code), undefined, "expired at 60 s");
  time.now -= 1;
  assert.equal(sessions.exchange(late.code), undefined, "spent by the attempt");
  const fresh = sessions.createLink();
  time.now += 59_999;
  assert.ok(sessions.exchange(fresh.code), "valid until the last millisecond");
  assert.equal(sessions.exchange("A".repeat(22)), undefined, "unknown");
});

void test("a session needs its tab's token and the browser key it was created with", () => {
  const { now } = clock();
  const sessions = new ConsoleSessions(now);
  const first = sessions.exchange(sessions.createLink().code)!;
  // A second tab of the same browser keeps the browser key and gets its own token.
  const second = sessions.exchange(
    sessions.createLink().code,
    first.browserKey,
  )!;
  assert.equal(second.browserKey, first.browserKey);
  assert.notEqual(second.token, first.token);
  assert.ok(
    sessions.use(first.token, first.browserKey),
    "the first tab goes on",
  );
  assert.ok(sessions.use(second.token, first.browserKey));
  // Another browser, a malformed cookie or a missing token opens nothing.
  const other = sessions.exchange(sessions.createLink().code, "short")!;
  assert.notEqual(other.browserKey, "short", "a malformed key is replaced");
  assert.equal(sessions.use(first.token, other.browserKey), undefined);
  assert.equal(sessions.use(other.token, first.browserKey), undefined);
  assert.equal(
    sessions.use(first.browserKey, first.browserKey),
    undefined,
    "the cookie is not a token",
  );
  assert.equal(sessions.use("", first.browserKey), undefined);
  assert.equal(sessions.use(first.token, ""), undefined);
  // Signing one tab out leaves the browser's other sessions.
  assert.equal(sessions.revoke(first.token), true);
  assert.equal(sessions.use(first.token, first.browserKey), undefined);
  assert.equal(
    sessions.bound(first.browserKey),
    true,
    "the second tab still uses it",
  );
  assert.equal(sessions.revoke(second.token), true);
  assert.equal(sessions.bound(first.browserKey), false);
  assert.equal(sessions.revoke(second.token), false);
});

void test("a session ends after 12 idle hours, 7 days after creation, or when revoked", () => {
  const { time, now } = clock();
  const sessions = new ConsoleSessions(now);
  const start = time.now;
  const idle = sessions.exchange(sessions.createLink().code)!;
  const busy = sessions.exchange(sessions.createLink().code)!;
  assert.equal(
    idle.session.expiresAt,
    new Date(start + 7 * 24 * HOUR).toISOString(),
  );
  assert.equal(
    idle.session.idleExpiresAt,
    new Date(start + 12 * HOUR).toISOString(),
  );

  // Use restarts the idle timeout, never the lifetime.
  for (let hour = 11; hour < 7 * 24; hour += 11) {
    time.now = start + hour * HOUR;
    const used = sessions.use(busy.token, busy.browserKey);
    assert.ok(used, `hour ${hour}`);
    assert.equal(
      used.idleExpiresAt,
      new Date(time.now + 12 * HOUR).toISOString(),
    );
  }
  assert.equal(
    sessions.use(idle.token, idle.browserKey),
    undefined,
    "idle for days",
  );
  assert.equal(sessions.bound(idle.browserKey), false);
  time.now = start + 7 * 24 * HOUR;
  assert.equal(
    sessions.use(busy.token, busy.browserKey),
    undefined,
    "lifetime reached",
  );
});

void test("outstanding codes and live sessions are bounded, dropping the oldest", () => {
  const { now } = clock();
  const sessions = new ConsoleSessions(now);
  const links = Array.from({ length: 33 }, () => sessions.createLink());
  assert.equal(sessions.exchange(links[0]!.code), undefined, "dropped");
  const created = links.slice(1).map((link) => sessions.exchange(link.code)!);
  for (let index = 0; index < 32; index += 1)
    created.push(sessions.exchange(sessions.createLink().code)!);
  assert.equal(created.length, 64);
  created.push(sessions.exchange(sessions.createLink().code)!);
  const use = (index: number) =>
    sessions.use(created.at(index)!.token, created.at(index)!.browserKey);
  assert.equal(use(0), undefined, "oldest dropped");
  assert.ok(use(1));
  assert.ok(use(-1));
});
