import { restoreBackup } from "../../dist/src/infrastructure/session/restore-backup.js";

// A process that runs the restore of a backup (src/infrastructure/session/restore-backup.ts) on the data root it is given, for the tests that stop it: it kills itself at the n-th
// phase the command reports (1 locked, 2 chosen, 3 merged, 4 copied, 5 edited, 6 verified, 7 aside, 8 swapped, 9 cleaned), and prints the report as one line of JSON when it ends.
//
//   node restore-peer.mjs <root> [--kill-at <n>] [--backup <name>] [--now <iso time>]
const [root, ...rest] = process.argv.slice(2);
const option = name => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1]; };
const killAt = option("--kill-at") === undefined ? undefined : Number(option("--kill-at")), backup = option("--backup"), now = option("--now");
let steps = 0;
try {
  const report = restoreBackup(root, {
    ...(backup === undefined ? {} : { backup }), ...(now === undefined ? {} : { now: () => new Date(now) }),
    step: () => { steps++; if (killAt !== undefined && steps === killAt) process.kill(process.pid, "SIGKILL"); },
  });
  process.stdout.write(JSON.stringify({ report, steps }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error?.code ?? null, message: String(error?.message ?? error) } }) + "\n");
  process.exitCode = 2;
}
