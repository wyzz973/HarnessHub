import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A process that stands for a service running on a data root of a build before the cut: it holds the root's owner lock, keeps `gateway.sqlite` open in write-ahead mode with a
// committed change that is only in the log and a write transaction open, which is what a read-only check run beside a service meets. It says `ready` on its standard output, and on
// SIGTERM commits the open transaction (which fails, and so does the exit code, if anything took a lock it should not have) and lets go.
//
//   node service-peer.mjs <root>
const [root] = process.argv.slice(2);
const owner = new DatabaseSync(join(root, "owner.sqlite"), { timeout: 0 });
owner.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
const db = new DatabaseSync(join(root, "gateway.sqlite"), { timeout: 0 });
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS held_marker(x INTEGER); INSERT INTO held_marker VALUES(1)");
db.exec("BEGIN IMMEDIATE; INSERT INTO held_marker VALUES(2)");
process.stdout.write("ready\n");
const timer = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  clearInterval(timer);
  try { db.exec("COMMIT"); db.close(); owner.exec("ROLLBACK"); owner.close(); process.exit(0); }
  catch (error) { process.stderr.write(String(error?.message ?? error) + "\n"); process.exit(3); }
});
