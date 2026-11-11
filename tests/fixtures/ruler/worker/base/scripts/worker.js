// Processes every pending job in queue/ and prints one line per job. A processed job is removed from the queue.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";

const dir = new URL("../queue/", import.meta.url);
const names = readdirSync(dir).filter(name => name.endsWith(".json")).sort();
console.log("worker: " + names.length + " pending jobs");

let ok = 0;
let failed = 0;
for (const name of names) {
  const file = new URL(name, dir);
  const text = readFileSync(file, "utf8");
  const job = JSON.parse(text);
  const etag = createHash("sha256").update(text).digest("hex").slice(0, 8);
  if (job.sizeBytes > 900000) {
    failed++;
    console.log("FAIL " + job.id + " " + job.kind + " rejected: " + job.sizeBytes + " bytes is over the limit");
  } else {
    ok++;
    console.log("ok   " + job.id + " " + job.kind.padEnd(10) + String(job.sizeBytes).padStart(8) + "B  etag=" + etag);
  }
  unlinkSync(file);
}
console.log("worker: done, " + ok + " ok, " + failed + " failed");
