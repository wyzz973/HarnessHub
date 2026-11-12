import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateToV14 } from "../../dist/src/infrastructure/session/migrate-v14.js";

// A process that runs the v14 migration (src/infrastructure/session/migrate-v14.ts) on the data root it is given, for the tests that stop it: the parent
// kills it with SIGKILL at a chosen time, or this process kills itself at a chosen step, and the parent then runs the migration again on what is left.
//
//   node migration-peer.mjs <root> [--pause <ms>] [--kill-at <step>] [--free <bytes>]
//
//   --pause    sleep this long (synchronously) at every step of the migration, so that a parent's timer lands inside the work and not after it
//   --kill-at  SIGKILL itself at the n-th step (1 is the backup about to be taken); the steps are the ones `step` of the options reports
//   --free     the free bytes to tell the migration instead of the disk's (to see it refuse)
//
// Prints `ready` when the database is open and the migration is about to begin, and, if it ends, one line of JSON: the report, the seconds it took and the
// peak resident memory in KiB.
const [root, ...rest] = process.argv.slice(2);
const option = name => { const at = rest.indexOf(name); return at < 0 ? undefined : Number(rest[at + 1]); };
const pause = option("--pause"), killAt = option("--kill-at"), free = option("--free");
const sleep = new Int32Array(new SharedArrayBuffer(4));
let steps = 0;
const db = new DatabaseSync(join(root, "gateway.sqlite"));
process.stdout.write("ready\n");
const started = process.hrtime.bigint();
try {
  const report = migrateToV14(db, {
    root,
    ...(free === undefined ? {} : { freeBytes: () => free }),
    step: () => {
      steps++;
      if (pause !== undefined && pause > 0) Atomics.wait(sleep, 0, 0, pause);
      if (killAt !== undefined && steps === killAt) process.kill(process.pid, "SIGKILL");
    },
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  process.stdout.write(JSON.stringify({ report, seconds, steps, maxRssKb: process.resourceUsage().maxRSS }) + "\n");
  db.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? null, message: String(error?.message ?? error) } }) + "\n");
  process.exitCode = 2;
}
