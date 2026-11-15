// Plays CodeBuddy Code's side of a recorded `codebuddy --acp` conversation (tests/fixtures/codebuddy/<scenario>.json, process <index>) over stdio.
// Each message from the driver must be the next one recorded from the client (same method, or a response to the same request); then every frame
// CodeBuddy Code sent before the client's next message is sent again, responses under the driver's own request ids.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [file, index] = process.argv.slice(2);
const frames = JSON.parse(readFileSync(file, "utf8")).processes[Number(index)];
const ids = new Map();
let cursor = 0;
const fail = message => { process.stderr.write("replay: " + message + "\n"); process.exit(3); };
const send = frame => process.stdout.write(JSON.stringify(frame.msg.method === undefined && ids.has(frame.msg.id) ? { ...frame.msg, id: ids.get(frame.msg.id) } : frame.msg) + "\n");
const flush = () => { while (cursor < frames.length && frames[cursor].dir === "out") send(frames[cursor++]); };
flush();
createInterface({ input: process.stdin }).on("line", line => {
  const got = JSON.parse(line), want = frames[cursor];
  if (want === undefined || want.dir !== "in") fail("the driver sent " + (got.method ?? "a response") + " after the recording ended");
  if (want.msg.method !== got.method) fail("the driver sent " + (got.method ?? "a response") + " where the recording has " + (want.msg.method ?? "a response"));
  if (want.msg.method !== undefined && want.msg.id !== undefined) ids.set(want.msg.id, got.id);
  cursor++;
  flush();
}).on("close", () => process.exit(0));
