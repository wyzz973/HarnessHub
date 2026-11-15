// Plays dsh's side of a recorded `dsh --profile acp` conversation (tests/fixtures/dsh/<scenario>.json, process <index>) over stdio.
// Each message from the driver must be the next one recorded from the client (same method, or a response to the same request); then every
// frame dsh sent before the client's next message is sent again, responses under the driver's own request ids. Before a prompt's
// response the session's log is written as far as dsh had written it then ($DSH_HOME/sessions/--replay--/<id>/session.v4.jsonl).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [file, index] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(file, "utf8")), frames = fixture.processes[Number(index)];
const home = process.env.DSH_HOME;
const ids = new Map();
let cursor = 0;
const fail = message => { process.stderr.write("replay: " + message + "\n"); process.exit(3); };
const send = frame => {
  if (frame.log !== undefined) {
    const dir = join(home, "sessions", "--replay--", fixture.session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.v4.jsonl"), fixture.log.slice(0, frame.log).map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  const msg = frame.msg.method === undefined && ids.has(frame.msg.id) ? { ...frame.msg, id: ids.get(frame.msg.id) } : frame.msg;
  process.stdout.write(JSON.stringify(msg) + "\n");
};
const flush = () => { while (cursor < frames.length && frames[cursor].dir === "out") send(frames[cursor++]); };
flush();
createInterface({ input: process.stdin }).on("line", line => {
  const got = JSON.parse(line), want = frames[cursor];
  if (want === undefined || want.dir !== "in") fail("the driver sent " + (got.method ?? "a response") + " after the recording ended");
  const recorded = want.msg;
  if (recorded.method !== got.method) fail("the driver sent " + (got.method ?? "a response") + " where the recording has " + (recorded.method ?? "a response"));
  if (recorded.method === undefined && recorded.id !== got.id) fail("the driver answered request " + got.id + " where the recording answers " + recorded.id);
  if (recorded.method !== undefined && recorded.id !== undefined) ids.set(recorded.id, got.id);
  cursor++;
  flush();
}).on("close", () => process.exit(0));
