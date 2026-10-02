// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  parseProcStat,
  parseProcUids,
  scanProc,
  type ProcFs,
  type ProcessRow,
} from "@harnesshub/runtime/process/proc-scan";
import {
  environmentCarries,
  parseProcScanOutput,
  parsePsRows,
  ProcessTableError,
  readMarkerSnapshot,
  readProcessTable,
  runBounded,
} from "@harnesshub/runtime/process/process-table";
import {
  groupShieldsSelf,
  killableGroups,
  reclaimWith,
  signalTargets,
  walkOwnership,
  workerTree,
  type Survivors,
} from "@harnesshub/runtime/process/posix-tree";

const UID = 501;
const SELF = 100;
const identity = { self: SELF, uid: UID };
const posix = !["darwin", "linux"].includes(process.platform)
  ? "Process tables are read on macOS and Linux only"
  : false;

function row(
  pid: number,
  ppid: number,
  pgid: number,
  options: { zombie?: boolean; started?: string; uid?: number } = {},
): ProcessRow {
  return {
    pid,
    ppid,
    pgid,
    uid: options.uid ?? UID,
    ruid: options.uid ?? UID,
    zombie: options.zombie ?? false,
    started: options.started ?? `t${pid}`,
  };
}
function table(...rows: ProcessRow[]): Map<number, ProcessRow> {
  return new Map(rows.map((entry) => [entry.pid, entry]));
}
const pids = (rows: readonly { pid: number }[]) =>
  rows.map((entry) => entry.pid).sort((a, b) => a - b);

void test("macOS ps rows keep user IDs, the start time as identity and the command with its environment", () => {
  const rows = parsePsRows(
    [
      "    1     0     1     0     0 Ss   Fri Sep 25 12:46:28 2026    ",
      " 6194  6193   523   501   501 Z    Fri Sep 25 12:47:43 2026     <defunct>",
      "  412     1   412    -2    -2 Ss   Wed Oct  2 09:05:01 2026     /usr/bin/node a HARNESSHUB_WORKER_TREE=t PATH=/bin",
      "",
    ].join("\n"),
  );
  assert.deepEqual([...rows.keys()], [1, 6194, 412]);
  assert.deepEqual(rows.get(1), {
    pid: 1,
    ppid: 0,
    pgid: 1,
    uid: 0,
    ruid: 0,
    zombie: false,
    started: "Fri Sep 25 12:46:28 2026",
    command: "",
  });
  assert.equal(rows.get(6194)?.zombie, true);
  assert.equal(rows.get(412)?.uid, -2);
  assert.equal(rows.get(412)?.started, "Wed Oct 2 09:05:01 2026");
  assert.equal(
    rows.get(412)?.command,
    "/usr/bin/node a HARNESSHUB_WORKER_TREE=t PATH=/bin",
  );
  // An unreadable row fails the inspection instead of hiding a process.
  assert.throws(
    () => parsePsRows("  12 1 12 501 501 Ss yesterday"),
    ProcessTableError,
  );
});

void test("Linux /proc records parse the start time, user IDs and odd command names", () => {
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
  assert.deepEqual(
    parseProcUids("Name:\tsudo\nUid:\t1000\t0\t0\t0\nGid:\t1000\t1000\n"),
    { ruid: 1000, uid: 0 },
  );
  assert.throws(() => parseProcUids("Name:\tx\n"), /Unexpected/);
});

function fakeProc(
  files: Record<string, string | NodeJS.ErrnoException>,
): ProcFs {
  return {
    list: () => [
      ...new Set(Object.keys(files).map((path) => path.split("/")[2]!)),
      "self",
      "meminfo",
    ],
    read: (path) => {
      const entry = files[path];
      if (entry === undefined)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (typeof entry !== "string") throw entry;
      return Buffer.from(entry, "latin1");
    },
  };
}
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code });
const stat = (pid: number, ppid: number, state = "S") =>
  `${pid} (p) ${state} ${ppid} ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid}00 0 0`;
const status = (uid: number) =>
  `Name:\tp\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;

void test("the /proc scan skips hidden and vanished processes, matches the marker exactly and fails on unexpected errors", () => {
  const token = "HARNESSHUB_WORKER_TREE=t";
  const files: Record<string, string | NodeJS.ErrnoException> = {
    "/proc/10/stat": stat(10, 1),
    "/proc/10/status": status(UID),
    "/proc/10/environ": `PATH=/bin\0${token}\0`,
    // The marker text inside another variable's value does not count.
    "/proc/11/stat": stat(11, 1),
    "/proc/11/status": status(UID),
    "/proc/11/environ": `NOTE=${token}\0`,
    // hidepid=1: another user's records are listed but unreadable.
    "/proc/12/stat": errno("EACCES"),
    // Exited between the listing and the read.
    "/proc/13/stat": errno("ESRCH"),
    // Readable record, environment not readable by this user.
    "/proc/14/stat": stat(14, 1),
    "/proc/14/status": status(0),
    "/proc/14/environ": errno("EACCES"),
    // A zombie's environment is never read.
    "/proc/15/stat": stat(15, 10, "Z"),
    "/proc/15/status": status(UID),
    "/proc/15/environ": errno("EIO"),
  };
  const scan = scanProc(fakeProc(files), token);
  assert.deepEqual(pids(scan.rows), [10, 11, 14, 15]);
  assert.deepEqual(scan.marked, [10]);
  assert.equal(scan.hidden, 1);
  assert.equal(scan.rows.find((entry) => entry.pid === 14)?.uid, 0);
  // Without a token no environment is read at all.
  assert.deepEqual(scanProc(fakeProc(files)).marked, []);
  // Any other read error fails the whole scan rather than hiding a process.
  assert.throws(
    () =>
      scanProc(fakeProc({ ...files, "/proc/10/environ": errno("EIO") }), token),
    { code: "EIO" },
  );
  assert.throws(
    () => scanProc(fakeProc({ ...files, "/proc/12/stat": errno("EIO") })),
    { code: "EIO" },
  );
});

void test("scanner output is validated before it becomes a process table", () => {
  assert.deepEqual(
    parseProcScanOutput(
      '{"rows":[[10,1,10,501,501,0,"1000"]],"marked":[10],"hidden":2}',
    ),
    {
      rows: [row(10, 1, 10, { started: "1000" })],
      marked: [10],
      hidden: 2,
    },
  );
  for (const output of [
    "",
    "[]",
    '{"rows":[[10,1,10,501,501,0]],"marked":[],"hidden":0}',
    '{"rows":[[10,1,10,501,501,2,"1"]],"marked":[],"hidden":0}',
    '{"rows":[],"marked":["10"],"hidden":0}',
  ])
    assert.throws(() => parseProcScanOutput(output), ProcessTableError);
});

void test("the macOS marker counts only after the arguments of the same process", () => {
  const token = "HARNESSHUB_WORKER_TREE=t";
  const withEnvironment = (command: string, started = "s") => ({
    ...row(5, 1, 5, { started }),
    command,
  });
  assert.equal(
    environmentCarries(
      withEnvironment(`node peer.js sentinel PATH=/bin ${token}`),
      withEnvironment("node peer.js sentinel"),
      token,
    ),
    "marked",
  );
  // The marker text in the arguments, another value in the environment.
  assert.equal(
    environmentCarries(
      withEnvironment(`node peer.js ${token} HARNESSHUB_WORKER_TREE=other`),
      withEnvironment(`node peer.js ${token}`),
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
  // It exited between the two reads: absent, or a zombie in the second.
  assert.equal(
    environmentCarries(withEnvironment(`x ${token}`), undefined, token),
    "unmarked",
  );
  assert.equal(
    environmentCarries(
      withEnvironment(`node a ${token}`),
      { ...row(5, 1, 5, { started: "s", zombie: true }), command: "<defunct>" },
      token,
    ),
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

void test("ownership follows parent links, never includes or passes through this process or its ancestors, and stops at other users", () => {
  const snapshot = table(
    row(1, 0, 1, { uid: 0 }),
    row(50, 1, 50), // shell, ancestor of self
    row(SELF, 50, SELF),
    row(101, SELF, SELF), // a child of self
    row(200, 1, 200), // escaped seed (reparented)
    row(201, 200, 200),
    row(202, 201, 300),
    row(203, 201, 300, { zombie: true }),
    row(204, 201, 204, { uid: 0 }), // sudo: another user
    row(205, 204, 205), // below it, back as this user
    row(300, 1, 300), // unrelated
  );
  const walk = walkOwnership(snapshot, [200], identity);
  assert.deepEqual(pids(walk.owned), [200, 201, 202]);
  assert.deepEqual(pids(walk.foreign), [204]);
  // A seed above self (a Gateway started inside an older tree) is never
  // owned, and nothing is reached through self.
  assert.deepEqual(walkOwnership(snapshot, [50, SELF, 1], identity), {
    owned: [],
    foreign: [],
  });
  // Another user's process carrying the marker is never owned.
  assert.deepEqual(
    pids(walkOwnership(snapshot, [204], identity).foreign),
    [204],
  );
  assert.deepEqual(walkOwnership(snapshot, [999], identity).owned, []);
});

void test("a recorded Worker tree seeds from the group when the root is a zombie, and attributes nothing for a reused root PID", () => {
  const rows = [
    row(1, 0, 1, { uid: 0 }),
    row(SELF, 1, SELF),
    row(500, SELF, 500), // Worker
    row(501, 500, 500), // engine
    row(502, 501, 502), // setsid child of the engine, cleared environment
    row(503, 1, 500), // group member already reparented
    row(504, 503, 504), // its setsid child
    row(505, 501, 505, { uid: 0 }), // another user's process in the tree
    row(600, 1, 600), // unrelated
  ];
  const live = table(...rows);
  assert.deepEqual(
    pids(workerTree(live, 500, true, identity)),
    [500, 501, 502, 503, 504, 505],
  );
  assert.deepEqual(
    workerTree(live, 500, true, identity).find((entry) => entry.pid === 502),
    { pid: 502, started: "t502" },
  );
  // The Worker crashed and is an unreaped zombie: its PID and group ID are
  // still reserved, so its group members attribute the tree.
  const zombie = table(
    ...rows.map((entry) =>
      entry.pid === 500 ? { ...entry, zombie: true } : entry,
    ),
  );
  assert.deepEqual(
    pids(workerTree(zombie, 500, true, identity)),
    [501, 502, 503, 504, 505],
  );
  // Reaped before the snapshot and absent: group members still attribute.
  const reaped = new Map(live);
  reaped.delete(500);
  assert.deepEqual(
    pids(workerTree(reaped, 500, false, identity)),
    [501, 502, 503, 504, 505],
  );
  // Reaped before the snapshot but present: the PID and group may be reused.
  assert.deepEqual(workerTree(live, 500, false, identity), []);
  assert.deepEqual(workerTree(zombie, 500, false, identity), []);
  // A snapshot that does not show this process cannot shield it or its
  // ancestors, so it counts as unreadable.
  const withoutSelf = new Map(live);
  withoutSelf.delete(SELF);
  assert.throws(
    () => workerTree(withoutSelf, 500, true, identity),
    ProcessTableError,
  );
});

void test("a group is signalled whole only when its leader and all live members are owned and it is not this process's group", () => {
  const snapshot = table(
    row(SELF, 1, 90),
    row(200, 1, 200),
    row(201, 200, 200),
    row(202, 200, 200, { zombie: true }),
    row(300, 1, 300),
    row(301, 1, 300), // unowned member
    row(400, 1, 400, { uid: 0 }),
    row(401, 400, 400),
    row(90, 1, 90), // this process's group leader
  );
  const owned = [200, 201, 300, 401, 90].map((pid) => snapshot.get(pid)!);
  assert.deepEqual(killableGroups(owned, snapshot, 90), [200]);
  // An unknown own group allows no group signal at all.
  assert.deepEqual(killableGroups(owned, snapshot, undefined), []);
  const lowGroups = table(row(1, 0, 1), row(0, 0, 0));
  assert.deepEqual(killableGroups([...lowGroups.values()], lowGroups, 90), []);
});

void test("signal targets never include PID or group 0/1, this process or its own group", () => {
  assert.deepEqual(
    signalTargets([0, 1, 90, 200], [0, 1, SELF, 300], {
      self: SELF,
      ownGroup: 90,
    }),
    [-200, 300],
  );
  assert.deepEqual(
    signalTargets([200], [300], { self: SELF, ownGroup: undefined }),
    [300],
  );
});

void test("recovery refuses a leased group that holds this process or an ancestor", () => {
  const snapshot = table(
    row(1, 0, 1, { uid: 0 }),
    row(700, 1, 700), // leased root
    row(701, 700, 700), // ancestor of self in the leased group
    row(SELF, 701, 800),
    row(900, 1, 900),
  );
  assert.equal(groupShieldsSelf(snapshot, 700, SELF), true);
  assert.equal(groupShieldsSelf(snapshot, 800, SELF), true);
  assert.equal(groupShieldsSelf(snapshot, 900, SELF), false);
  const missing = new Map(snapshot);
  missing.delete(SELF);
  assert.equal(groupShieldsSelf(missing, 900, SELF), true);
});

function survivors(partial: Partial<Survivors> = {}): Survivors {
  return {
    owned: [],
    groups: [],
    foreign: 0,
    unknown: 0,
    hidden: 0,
    ownGroup: 90,
    ...partial,
  };
}

void test("reclaim confirms only a clean final scan of a complete record", async () => {
  const signals: [number, string][] = [];
  const steps = (scans: (Survivors | Error)[], alive = () => false) => ({
    scan: () => {
      const next = scans.shift() ?? survivors();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
    kill: (target: number, signal: NodeJS.Signals) => {
      signals.push([target, signal]);
    },
    alive,
  });
  const options = { graceMs: 30, recordedComplete: true, self: SELF };
  assert.equal(
    (await reclaimWith(steps([survivors()]), options)).status,
    "confirmed",
  );
  // Survivors that exit after SIGTERM.
  const escaped = survivors({ owned: [row(200, 1, 200)], groups: [200] });
  const ended = await reclaimWith(steps([escaped, survivors()]), options);
  assert.equal(ended.status, "confirmed");
  assert.deepEqual(signals.splice(0), [
    [-200, "SIGTERM"],
    [200, "SIGTERM"],
  ]);
  // Survivors that outlive SIGTERM and SIGKILL.
  const stuck = await reclaimWith(
    steps([escaped, escaped, escaped], () => true),
    options,
  );
  assert.deepEqual([stuck.status, stuck.reason], ["unconfirmed", "survivors"]);
  assert.deepEqual(
    signals.splice(0).map(([, signal]) => signal),
    ["SIGTERM", "SIGTERM", "SIGKILL", "SIGKILL"],
  );
  // Nothing signallable, yet not provably clean. An unknown verdict is
  // scanned again and only a persistent one keeps the outcome unconfirmed.
  for (const [scans, reason] of [
    [[survivors({ foreign: 1 })], "foreign"],
    [[1, 2, 3].map(() => survivors({ unknown: 1 })), "unknown"],
  ] as const) {
    const outcome = await reclaimWith(steps([...scans]), options);
    assert.deepEqual([outcome.status, outcome.reason], ["unconfirmed", reason]);
  }
  assert.equal(
    (await reclaimWith(steps([survivors({ unknown: 1 })]), options)).status,
    "confirmed",
  );
  const unrecorded = await reclaimWith(steps([survivors()]), {
    ...options,
    recordedComplete: false,
  });
  assert.deepEqual(
    [unrecorded.status, unrecorded.reason],
    ["unconfirmed", "tree_unrecorded"],
  );
  const failed = await reclaimWith(
    steps([new ProcessTableError("ps timed out after 5000 ms")]),
    options,
  );
  assert.deepEqual(
    [failed.status, failed.reason, failed.error],
    ["unconfirmed", "scan_failed", "ps timed out after 5000 ms"],
  );
  assert.deepEqual(signals, []);
  // An unexpected signalling error is a failed cleanup.
  const broken = await reclaimWith(
    {
      ...steps([escaped]),
      kill: () => {
        throw Object.assign(new Error("invalid"), { code: "EINVAL" });
      },
    },
    options,
  );
  assert.equal(broken.status, "failed");
});

void test(
  "a bounded snapshot child is killed at its deadline, and errors never carry its output",
  { skip: process.platform === "win32" ? "POSIX snapshot children" : false },
  async () => {
    const started = Date.now();
    await assert.rejects(
      runBounded(
        "fixture",
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { timeoutMs: 200, maxBuffer: 1024, env: {} },
      ),
      (error: unknown) =>
        error instanceof ProcessTableError &&
        error.message === "fixture timed out after 200 ms",
    );
    assert.ok(Date.now() - started < 2_000);
    const secret = "SECRET_TOKEN=do-not-log";
    await assert.rejects(
      runBounded(
        "fixture",
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(secret.repeat(100))})`],
        { timeoutMs: 5_000, maxBuffer: 64, env: {} },
      ),
      (error: unknown) =>
        error instanceof ProcessTableError &&
        error.message === "fixture output exceeded its limit" &&
        !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
          "do-not-log",
        ),
    );
    const exit = await runBounded(
      "fixture",
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(secret)}); process.exitCode = 3`,
      ],
      { timeoutMs: 5_000, maxBuffer: 1024, env: {} },
    );
    assert.deepEqual([exit.status, exit.stdout], [3, secret]);
  },
);

void test(
  "the live snapshot shows this process as its own user, and the marker only where the environment carries it",
  { skip: posix },
  async (t) => {
    const marker = randomUUID();
    const children = [
      { HARNESSHUB_WORKER_TREE: marker },
      { NOTE: `HARNESSHUB_WORKER_TREE=${marker}` },
    ].map((env) =>
      spawn(
        process.execPath,
        [
          "-e",
          "process.stdout.write('ready'); setTimeout(() => {}, 30_000)",
          `HARNESSHUB_WORKER_TREE=${marker}`,
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          env: { PATH: process.env.PATH ?? "", ...env },
        },
      ),
    );
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    // Before it prints, a child may not have exec'd node with its own environment yet.
    await Promise.all(children.map((child) => once(child.stdout, "data")));
    const live = await readProcessTable();
    const self = live.table.get(process.pid);
    assert.ok(self, "the snapshot must include this process");
    assert.equal(self.ppid, process.ppid);
    assert.equal(self.uid, process.geteuid!());
    assert.equal(self.zombie, false);
    const snapshot = await readMarkerSnapshot(marker);
    assert.deepEqual([...snapshot.marked], [children[0]!.pid]);
    assert.deepEqual([...snapshot.unknown], []);
  },
);
