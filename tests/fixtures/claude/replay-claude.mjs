#!/usr/bin/env node
// A stand-in for the `claude` executable that replays a recorded wire (tests/fixtures/claude/*.ndjson, made from a real session of Claude Code 2.1.325
// through the Agent SDK 0.3.325): every line the CLI wrote is written again in order, and every line the SDK wrote is waited for. The identities the
// Hub picks anew each run (the session, each prompt, each control request of the SDK's) are put in place of the recorded ones as they arrive.
// REPLAY_FILE names the recording; REPLAY_TRACE, when set, receives every line the SDK wrote.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) { process.stdout.write("2.1.325 (Claude Code)\n"); process.exit(0); }
const script = readFileSync(process.env.REPLAY_FILE, "utf8").trim().split("\n").map(line => JSON.parse(line));
const swaps = new Map();
const at = process.argv.indexOf("--session-id");
const recordedSession = script.map(entry => JSON.parse(entry.line)).find(message => typeof message.session_id === "string")?.session_id;
if (at >= 0 && recordedSession) swaps.set(recordedSession, process.argv[at + 1]);
const swap = line => { let text = line; for (const [from, to] of swaps) text = text.split(from).join(to); return text; };
const kind = message => message.type === "control_request" ? "request:" + message.request?.subtype : message.type === "control_response" ? "response" : message.type;
const waiting = [], arrived = [];
const input = createInterface({ input: process.stdin });
let ended = false;
input.on("line", line => {
  if (!line.trim()) return;
  if (process.env.REPLAY_TRACE) appendFileSync(process.env.REPLAY_TRACE, line + "\n");
  arrived.push(JSON.parse(line));
  waiting.shift()?.();
});
input.on("close", () => { ended = true; waiting.shift()?.(); });
async function next(wanted) {
  for (;;) {
    const found = arrived.findIndex(message => kind(message) === wanted);
    if (found >= 0) return arrived.splice(found, 1)[0];
    if (ended) return null;
    await new Promise(resolve => waiting.push(resolve));
  }
}
for (const entry of script) {
  const recorded = JSON.parse(entry.line);
  if (entry.dir === "out") { process.stdout.write(swap(entry.line) + "\n"); continue; }
  const message = await next(kind(recorded));
  if (message === null) process.exit(0);
  if (recorded.type === "control_request" && recorded.request_id && message.request_id) swaps.set(recorded.request_id, message.request_id);
  if (recorded.type === "user" && recorded.uuid && message.uuid) swaps.set(recorded.uuid, message.uuid);
}
// The recording is played; the process stays until its input ends, as Claude Code does.
while (!ended) await new Promise(resolve => waiting.push(resolve));
process.exit(0);
