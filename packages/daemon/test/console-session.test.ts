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
  assert.match(created.value, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.session.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(created.value, created.session.csrfToken);
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

void test("a session ends after 12 idle hours, 7 days after creation, or when revoked", () => {
  const { time, now } = clock();
  const sessions = new ConsoleSessions(now);
  const start = time.now;
  const idle = sessions.exchange(sessions.createLink().code)!;
  const busy = sessions.exchange(sessions.createLink().code)!;
  const revoked = sessions.exchange(sessions.createLink().code)!;
  assert.equal(
    idle.session.expiresAt,
    new Date(start + 7 * 24 * HOUR).toISOString(),
  );
  assert.equal(
    idle.session.idleExpiresAt,
    new Date(start + 12 * HOUR).toISOString(),
  );
  assert.equal(sessions.revoke(revoked.value), true);
  assert.equal(sessions.use(revoked.value), undefined);
  assert.equal(sessions.revoke(revoked.value), false);

  // Use restarts the idle timeout, never the lifetime.
  for (let hour = 11; hour < 7 * 24; hour += 11) {
    time.now = start + hour * HOUR;
    const used = sessions.use(busy.value);
    assert.ok(used, `hour ${hour}`);
    assert.equal(used.csrfToken, busy.session.csrfToken);
    assert.equal(
      used.idleExpiresAt,
      new Date(time.now + 12 * HOUR).toISOString(),
    );
  }
  assert.equal(sessions.use(idle.value), undefined, "idle for days");
  time.now = start + 7 * 24 * HOUR;
  assert.equal(sessions.use(busy.value), undefined, "lifetime reached");
  assert.equal(sessions.use("x".repeat(43)), undefined);
});

void test("outstanding codes and live sessions are bounded, dropping the oldest", () => {
  const { now } = clock();
  const sessions = new ConsoleSessions(now);
  const links = Array.from({ length: 33 }, () => sessions.createLink());
  assert.equal(sessions.exchange(links[0]!.code), undefined, "dropped");
  const values = links
    .slice(1)
    .map((link) => sessions.exchange(link.code)!.value);
  for (let index = 0; index < 32; index += 1)
    values.push(sessions.exchange(sessions.createLink().code)!.value);
  assert.equal(values.length, 64);
  values.push(sessions.exchange(sessions.createLink().code)!.value);
  assert.equal(sessions.use(values[0]!), undefined, "oldest dropped");
  assert.ok(sessions.use(values[1]!));
  assert.ok(sessions.use(values.at(-1)!));
});
