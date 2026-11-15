#!/usr/bin/env node
// A stand-in for `opencode serve --stdio` that replays a recorded session (tests/fixtures/opencode/replay-*.json): it prints its address as the real
// one does, asks for the same Basic login, answers each request with the recorded answer to the same request, and releases the events recorded after
// that answer onto the event stream. The Driver's own message identities replace the recorded ones as they appear; the test's workspace stands for
// the recorded one. Ends when its stdin closes.
//   FAKE_CWD       the test's workspace
//   FAKE_TRACE     a file each request is appended to (JSON lines)
//   FAKE_DROP_AT   an exchange index: right after that event is sent the stream is cut, and what is released until the Driver is back is lost
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const recordedCwd = fixture.cwd, cwd = process.env.FAKE_CWD ?? recordedCwd, dropAt = process.env.FAKE_DROP_AT === undefined ? -1 : Number(process.env.FAKE_DROP_AT);
const expected = "Basic " + Buffer.from("opencode:" + (process.env.OPENCODE_PASSWORD ?? ""), "utf8").toString("base64");
const exchanges = fixture.exchanges.map((entry, index) => ({ ...entry, index, used: false }));
/** The session's messages as the recorder read them back: what a reconcile reads. */
const reference = exchanges.find(entry => entry.kind === "http" && /\/message\?order=asc&limit=100$/u.test(entry.path));
if (reference) reference.used = true;
const ids = new Map();
const swap = (text, pairs) => { for (const [from, to] of pairs) text = text.split(from).join(to); return text; };
const outward = value => JSON.parse(swap(JSON.stringify(value), [...ids, [recordedCwd, cwd], [encodeURIComponent(recordedCwd), encodeURIComponent(cwd)]]));
const inward = text => swap(text, [[encodeURIComponent(cwd), encodeURIComponent(recordedCwd)], [cwd, recordedCwd], ...[...ids].map(([recorded, own]) => [own, recorded])]);
let stream = null, connected = false, running = false;
const buffered = [], permissions = new Map();
function release(entry) {
  const event = entry.event;
  if (event.type === "session.execution.started") running = true;
  if (/^session\.execution\.(succeeded|failed|interrupted)$/u.test(event.type)) running = false;
  if (event.type === "permission.asked") permissions.set(event.data.id, event.data);
  if (event.type === "permission.replied") permissions.delete(event.data.requestID);
  if (stream === null) { if (!connected) buffered.push(entry); return; }
  stream.write("data: " + JSON.stringify(outward(event)) + "\n\n");
  if (entry.index === dropAt) { const cut = stream; stream = null; cut.end(); cut.socket?.destroy(); }
}
/** The events recorded after `index`, up to the next request the Driver makes. */
function releaseAfter(index) {
  for (let at = index + 1; at < exchanges.length; at++) {
    const entry = exchanges[at];
    if (entry.kind === "http") { if (!entry.used) return; continue; }
    if (entry.kind === "event" && !entry.used) { entry.used = true; release(entry); }
  }
}
function answer(response, status, body) {
  const text = body === undefined || body === null ? "" : JSON.stringify(outward(body));
  response.writeHead(status, text ? { "content-type": "application/json" } : {});
  response.end(text);
}
const server = createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (request.headers.authorization !== expected) { answer(response, 401, { _tag: "UnauthorizedError", message: "Unauthorized" }); return; }
    const path = inward(request.url ?? "/"), sent = body ? JSON.parse(inward(body)) : undefined;
    // What the Driver sent, as it sent it.
    if (process.env.FAKE_TRACE) appendFileSync(process.env.FAKE_TRACE, JSON.stringify({ method: request.method, path: request.url, body: body ? JSON.parse(body) : undefined }) + "\n");
    if (path === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": heartbeat\n\n");
      stream = response;
      if (!connected) { connected = true; for (const entry of buffered.splice(0)) release(entry); }
      return;
    }
    // The recorded answer to the same request: the first not given yet, its identities the Driver's own where it chose them.
    const match = exchanges.find(entry => entry.kind === "http" && !entry.used && entry.method === request.method && entry.path === path
      && (sent?.delivery === undefined) === (entry.body?.delivery === undefined));
    if (match) {
      match.used = true;
      const own = sent?.id, recorded = match.body?.id;
      if (typeof own === "string" && typeof recorded === "string" && own !== recorded) ids.set(recorded, own);
      answer(response, match.status, match.response);
      releaseAfter(match.index);
      return;
    }
    if (request.method === "GET" && path === "/api/session/active") { answer(response, 200, { data: running ? { [fixture.session]: { type: "running" } } : {} }); return; }
    if (request.method === "GET" && /^\/api\/session\/[^/]+\/message\?/u.test(path) && reference) {
      const desc = /order=desc/u.test(path), list = [...reference.response.data];
      answer(response, 200, { data: desc ? list.reverse() : list, cursor: {} }); return;
    }
    if (request.method === "GET" && /^\/api\/session\/[^/]+\/permission$/u.test(path)) { answer(response, 200, { data: [...permissions.values()] }); return; }
    // What the recording has no answer for is refused as OpenCode refuses before taking anything in.
    answer(response, request.method === "GET" ? 404 : 400, { _tag: request.method === "GET" ? "NotFoundError" : "InvalidRequestError", message: "not in the recording: " + request.method + " " + path });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port }) + "\n"); });
process.stdin.on("end", () => { stream?.end(); server.close(); process.exit(0); });
process.stdin.resume();
