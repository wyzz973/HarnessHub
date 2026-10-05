// SPDX-License-Identifier: MIT
/** Usage alerts: when a window is said, once per run, and the file of what was said. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gatewayFeaturesProblems } from "@harnesshub/core/gateway-features";
import type { LogSink } from "@harnesshub/core/logging";
import type { CredentialRoutingView } from "../src/http/routing-state-routes.js";
import {
  dueAlerts,
  USAGE_ALERTS_FILE,
  UsageAlerts,
} from "../src/usage-alerts.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const minutes = (count: number) => new Date(NOW + count * 60_000).toISOString();

function credential(
  readings: CredentialRoutingView["readings"],
  id = "cred-0",
): CredentialRoutingView {
  return { provider: "alpha", credential: id, state: "closed", readings };
}

const reading = (
  usedPercent: number,
  resetsAt: string | undefined = minutes(60),
) => ({
  window: "requests",
  usedPercent,
  ...(resetsAt !== undefined ? { resetsAt } : {}),
  observedAt: minutes(0),
});

void test("a window at or past the share is said once per run of it", () => {
  const marks = {};
  assert.deepEqual(dueAlerts([credential([reading(79)])], marks, 80, NOW), []);
  const first = dueAlerts([credential([reading(80)])], marks, 80, NOW);
  assert.deepEqual(first, [
    {
      at: minutes(0),
      provider: "alpha",
      credential: "cred-0",
      window: "requests",
      usedPercent: 80,
      resetsAt: minutes(60),
    },
  ]);
  // Read again with a reset a few minutes off (Codex's moves): the same run.
  assert.deepEqual(
    dueAlerts(
      [credential([reading(95, minutes(65))])],
      marks,
      80,
      NOW + 60_000,
    ),
    [],
  );
  // The window renewed and filled up again: a new run, said again.
  assert.equal(
    dueAlerts([credential([reading(90, minutes(400))])], marks, 80, NOW).length,
    1,
  );
  // Under the share it is forgotten, so crossing again is said again.
  assert.deepEqual(
    dueAlerts([credential([reading(10, minutes(400))])], marks, 80, NOW),
    [],
  );
  assert.equal(
    dueAlerts([credential([reading(85, minutes(400))])], marks, 80, NOW).length,
    1,
  );
  // A window that says no reset is one run until it falls under the share.
  const open = {};
  assert.equal(
    dueAlerts([credential([reading(99, undefined)])], open, 80, NOW).length,
    1,
  );
  assert.equal(
    dueAlerts([credential([reading(99, undefined)])], open, 80, NOW).length,
    0,
  );
});

void test("a reading of a window that renewed since neither alerts nor clears", () => {
  const marks = {};
  assert.equal(
    dueAlerts([credential([reading(90)])], marks, 80, NOW).length,
    1,
  );
  // Past its reset: nothing new is known about the window.
  const later = NOW + 2 * 60 * 60_000;
  assert.deepEqual(
    dueAlerts([credential([reading(10)])], marks, 80, later),
    [],
  );
  assert.equal(Object.keys(marks).length, 1, "the mark stays");
  // By its span when it says no reset.
  assert.deepEqual(
    dueAlerts(
      [
        credential([
          {
            window: "day",
            usedPercent: 99,
            spanSeconds: 60,
            observedAt: minutes(-5),
          },
        ]),
      ],
      {},
      80,
      NOW,
    ),
    [],
  );
});

void test("a mark of a window not read for 40 days is dropped, one read is kept", () => {
  const marks: Record<string, { at: string; until?: string }> = {};
  dueAlerts(
    [credential([reading(90)], "kept"), credential([reading(90)], "gone")],
    marks,
    80,
    NOW,
  );
  assert.equal(Object.keys(marks).length, 2);
  const day = 24 * 60 * 60_000;
  dueAlerts([credential([reading(90)], "kept")], marks, 80, NOW + 39 * day);
  assert.equal(Object.keys(marks).length, 2);
  dueAlerts([credential([reading(90)], "kept")], marks, 80, NOW + 41 * day);
  assert.deepEqual(
    Object.keys(marks).map((key) => key.split("\u0000")[1]),
    ["kept"],
  );
});

function recorder(): {
  log: LogSink;
  lines: [string, Record<string, unknown>][];
} {
  const lines: [string, Record<string, unknown>][] = [];
  const sink = {
    info: (event: string, data: Record<string, unknown> = {}) => {
      lines.push([event, data]);
    },
    debug: () => undefined,
  };
  return { log: sink as unknown as LogSink, lines };
}

void test("what was said is kept in a 0600 file, so a restart does not say it again", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hh-alerts-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let percent: number | undefined;
  let readings = [credential([reading(90)])];
  const { log, lines } = recorder();
  const make = () =>
    new UsageAlerts({
      dataDir,
      readings: () => readings,
      percent: () => percent,
      log,
      clock: () => NOW,
    });
  const alerts = make();
  await alerts.load();
  // Off: nothing is read or written.
  assert.deepEqual(await alerts.check(), []);
  await assert.rejects(stat(path.join(dataDir, USAGE_ALERTS_FILE)));
  percent = 80;
  assert.equal((await alerts.check()).length, 1);
  assert.deepEqual(
    lines.filter(([event]) => event === "usage.alert"),
    [
      [
        "usage.alert",
        {
          provider: "alpha",
          credential: "cred-0",
          window: "requests",
          usedPercent: 90,
          threshold: 80,
          resetsAt: minutes(60),
        },
      ],
    ],
  );
  const file = path.join(dataDir, USAGE_ALERTS_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await alerts.close();
  await alerts.close();

  const again = make();
  await again.load();
  assert.equal(again.list().length, 1);
  assert.deepEqual(await again.check(), []);
  // Another window is said, and listed first.
  readings = [credential([reading(90), { ...reading(99), window: "tokens" }])];
  assert.equal((await again.check()).length, 1);
  assert.deepEqual(
    again.list().map((alert) => alert.window),
    ["tokens", "requests"],
  );
  await again.close();
});

void test("a corrupt or invalid file is logged and taken as empty; the start never fails", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "hh-alerts-bad-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, USAGE_ALERTS_FILE);
  for (const text of [
    "{not json",
    JSON.stringify({ schemaVersion: 2, marks: {}, alerts: [] }),
    JSON.stringify({
      schemaVersion: 1,
      marks: { a: { at: "yesterday" } },
      alerts: [],
    }),
    JSON.stringify({
      schemaVersion: 1,
      marks: {},
      alerts: [{ at: minutes(0) }],
    }),
  ]) {
    await writeFile(file, text);
    const { log, lines } = recorder();
    const alerts = new UsageAlerts({
      dataDir,
      readings: () => [credential([reading(90)])],
      percent: () => 80,
      log,
      clock: () => NOW,
    });
    await alerts.load();
    assert.deepEqual(
      lines.map(([event]) => event),
      ["usage.alerts_invalid"],
      text,
    );
    assert.deepEqual(alerts.list(), []);
    // Said again, and the file is good again.
    assert.equal((await alerts.check()).length, 1);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      schemaVersion: number;
    };
    assert.equal(saved.schemaVersion, 1);
    await alerts.close();
  }
});

void test("the setting is a whole percent from 1 to 100 with nothing else", () => {
  const base = { schemaVersion: 1, redaction: { enabled: true, rules: [] } };
  assert.deepEqual(
    gatewayFeaturesProblems({ ...base, alerts: { usagePercent: 80 } }),
    [],
  );
  for (const alerts of [
    { usagePercent: 0 },
    { usagePercent: 101 },
    { usagePercent: 50.5 },
    { usagePercent: "80" },
    {},
  ])
    assert.deepEqual(
      gatewayFeaturesProblems({ ...base, alerts }).map((item) => item.pointer),
      ["/alerts/usagePercent"],
      JSON.stringify(alerts),
    );
  assert.deepEqual(
    gatewayFeaturesProblems({
      ...base,
      alerts: { usagePercent: 80, balance: 5 },
    }).map((item) => item.pointer),
    ["/alerts/balance"],
  );
});
