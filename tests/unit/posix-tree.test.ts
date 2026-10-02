// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  environmentCarries,
  ownedProcesses,
  parseProcStat,
  parsePsRows,
  readProcessTable,
  workerTree,
  type ProcessRow,
} from "../../src/process/posix-tree.js";

function row(
  pid: number,
  ppid: number,
  pgid: number,
  options: { zombie?: boolean; started?: string } = {},
): ProcessRow {
  return {
    pid,
    ppid,
    pgid,
    zombie: options.zombie ?? false,
    started: options.started ?? `t${pid}`,
  };
}
function table(...rows: ProcessRow[]): Map<number, ProcessRow> {
  return new Map(rows.map((entry) => [entry.pid, entry]));
}
const pids = (rows: readonly { pid: number }[]) =>
  rows.map((entry) => entry.pid).sort((a, b) => a - b);

void test("macOS ps rows keep the start time as identity and the command with its environment", () => {
  const rows = parsePsRows(
    [
      "    1     0     1 Ss   Fri Sep 25 12:46:28 2026    ",
      " 6194  6193   523 Z    Fri Sep 25 12:47:43 2026     <defunct>",
      "  412     1   412 Ss   Wed Oct  2 09:05:01 2026     /usr/bin/node a b HARNESSHUB_WORKER_TREE=t PATH=/bin",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...rows.keys()], [1, 6194, 412]);
  assert.deepEqual(rows.get(1), {
    pid: 1,
    ppid: 0,
    pgid: 1,
    zombie: false,
    started: "Fri Sep 25 12:46:28 2026",
    command: "",
  });
  assert.equal(rows.get(6194)?.zombie, true);
  assert.equal(rows.get(412)?.started, "Wed Oct 2 09:05:01 2026");
  assert.equal(
    rows.get(412)?.command,
    "/usr/bin/node a b HARNESSHUB_WORKER_TREE=t PATH=/bin",
  );
  // An unreadable row fails the inspection instead of hiding a process.
  assert.throws(() => parsePsRows("  12 1 12 Ss yesterday"), /Unexpected/);
});

void test("Linux /proc stat parsing tolerates spaces and parentheses in the command name", () => {
  const fields = Array.from({ length: 49 }, (_, index) => String(index));
  fields[0] = "S";
  fields[1] = "77";
  fields[2] = "70";
  fields[19] = "123456";
  assert.deepEqual(parseProcStat(`4242 (odd ) (name) ${fields.join(" ")}\n`), {
    pid: 4242,
    ppid: 77,
    pgid: 70,
    zombie: false,
    started: "123456",
  });
  fields[0] = "Z";
  assert.equal(parseProcStat(`9 (z) ${fields.join(" ")}`).zombie, true);
  assert.throws(() => parseProcStat("9 (truncated) S 1"), /Unexpected/);
  // proc(5) layout: state ppid pgrp session tty_nr tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice num_threads
  // itrealvalue starttime ...
  assert.deepEqual(
    parseProcStat(
      "1234 (node) S 1 1230 1230 0 -1 4194560 2051 0 0 0 10 5 0 0 20 0 11 0 8812345 1167360000 12345 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
    ),
    { pid: 1234, ppid: 1, pgid: 1230, zombie: false, started: "8812345" },
  );
});

void test("the macOS marker counts only after the arguments of the same process", () => {
  const token = "HARNESSHUB_WORKER_TREE=t";
  const withEnvironment = (command: string, started = "s") => ({
    ...row(5, 1, 5, { started }),
    command,
  });
  const args = withEnvironment("node peer.js sentinel");
  assert.equal(
    environmentCarries(
      withEnvironment(`node peer.js sentinel PATH=/bin ${token}`),
      args,
      token,
    ),
    "marked",
  );
  // The marker text in the arguments, another value in the environment.
  const lookAlike = withEnvironment(`node peer.js ${token}`);
  assert.equal(
    environmentCarries(
      withEnvironment(`node peer.js ${token} HARNESSHUB_WORKER_TREE=other`),
      lookAlike,
      token,
    ),
    "unmarked",
  );
  // `ps -E` shows no environment for platform binaries or other users.
  assert.equal(
    environmentCarries(
      withEnvironment(`sh ${token}`),
      withEnvironment(`sh ${token}`),
      token,
    ),
    "unmarked",
  );
  assert.equal(
    environmentCarries(withEnvironment(`x ${token}`), undefined, token),
    "unmarked",
  );
  // A reused PID or an exec between the two reads cannot be attributed.
  assert.equal(
    environmentCarries(
      withEnvironment(`node a ${token}`),
      withEnvironment("node a", "later"),
      token,
    ),
    "unknown",
  );
  assert.equal(
    environmentCarries(
      withEnvironment(`node a ${token}`),
      withEnvironment("node b"),
      token,
    ),
    "unknown",
  );
});

void test("ownership follows parent links from seeds and never includes or passes through this process or its ancestors", () => {
  const snapshot = table(
    row(1, 0, 1),
    row(50, 1, 50), // shell, ancestor of self
    row(100, 50, 100), // self (the Gateway)
    row(101, 100, 100), // a child of self
    row(200, 1, 200), // escaped seed (reparented)
    row(201, 200, 200),
    row(202, 201, 300),
    row(203, 201, 300, { zombie: true }),
    row(300, 1, 300), // unrelated
  );
  assert.deepEqual(pids(ownedProcesses(snapshot, [200], 100)), [200, 201, 202]);
  // A seed above self (a nested Gateway started inside the old tree) is never
  // owned, and nothing is reached through self.
  assert.deepEqual(pids(ownedProcesses(snapshot, [50, 100, 1], 100)), []);
  assert.deepEqual(pids(ownedProcesses(snapshot, [999], 100)), []);
});

void test("a recorded Worker tree includes group members and escaped descendants, and nothing for a reused root PID", () => {
  const snapshot = table(
    row(1, 0, 1),
    row(500, 1, 500), // Worker
    row(501, 500, 500), // engine
    row(502, 501, 502), // setsid descendant of the engine
    row(503, 1, 500), // group member already reparented
    row(504, 503, 504), // its setsid child
    row(600, 1, 600), // unrelated
  );
  assert.deepEqual(
    pids(workerTree(snapshot, 500, true)),
    [500, 501, 502, 503, 504],
  );
  assert.deepEqual(
    workerTree(snapshot, 500, true).find((entry) => entry.pid === 502),
    { pid: 502, started: "t502" },
  );
  // Root exited: its group members still attribute their descendants.
  const exited = new Map(snapshot);
  exited.delete(500);
  assert.deepEqual(pids(workerTree(exited, 500, false)), [501, 502, 503, 504]);
  // Root unverified but present: the PID and its group ID may be reused.
  assert.deepEqual(workerTree(snapshot, 500, false), []);
});

void test(
  "the live process table contains this process with its parent",
  {
    skip: !["darwin", "linux"].includes(process.platform)
      ? "Process tables are read on macOS and Linux only"
      : false,
  },
  async () => {
    const live = await readProcessTable();
    const self = live.get(process.pid);
    assert.ok(self, "the snapshot must include this process");
    assert.equal(self.ppid, process.ppid);
    assert.equal(self.zombie, false);
    assert.ok(live.size > 1);
  },
);
