// Plays dsh's Web host (`dsh --profile web`) from a recording (tests/fixtures/dsh-web/<scenario>.json, $DSH_REPLAY_FIXTURE): prints the startup line,
// answers /connect with a cookie, and replays the recorded unary calls and mux frames. Each call and each stream the driver opens or cancels takes the
// first recorded one of its kind not yet taken; the Host's frames are sent in recorded order, each once every call or stream action recorded before it
// was taken. Identities the driver makes itself (session, request, stream ids) are learned from its calls and put in place of the recorded ones.
// The overlay the driver started it with (`--patch <file>`) is copied to $DSH_REPLAY_PATCH_COPY when set. Anything unexpected is said on stderr.
import { copyFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const fixture = JSON.parse(readFileSync(process.env.DSH_REPLAY_FIXTURE, "utf8")), entries = fixture.entries, taken = entries.map(() => false);
const args = process.argv.slice(2), patch = args[args.indexOf("--patch") + 1];
if (process.env.DSH_REPLAY_PATCH_COPY && patch) copyFileSync(patch, process.env.DSH_REPLAY_PATCH_COPY);
const ids = new Map(), streams = new Map();
const ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const fail = message => process.stderr.write("replay: " + message + "\n");
function learn(recorded, live) {
  if (typeof recorded === "string" && typeof live === "string") { if (recorded !== live && ID.test(recorded) && ID.test(live)) ids.set(recorded, live); return; }
  if (recorded && live && typeof recorded === "object" && typeof live === "object") for (const key of Object.keys(recorded)) learn(recorded[key], live[key]);
}
const translate = value => { let text = JSON.stringify(value); for (const [from, to] of ids) text = text.split(from).join(to); return JSON.parse(text); };
let socket = null;
function pump() {
  for (let index = 0; index < entries.length; index++) {
    if (taken[index]) continue;
    const entry = entries[index];
    if (entry.dir !== "down") return;
    const live = streams.get(entry.frame.streamId);
    if (live === undefined || socket === null) return;
    taken[index] = true;
    socket.send(JSON.stringify(translate({ ...entry.frame, streamId: live })));
  }
}
function take(test) {
  const index = entries.findIndex((entry, at) => !taken[at] && test(entry));
  if (index === -1) return null;
  taken[index] = true;
  return entries[index];
}
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    if (request.url.startsWith("/connect")) { response.writeHead(302, { Location: "./api/remote.mux", "Set-Cookie": "dsh-replay=1; Path=/; HttpOnly" }); response.end(); return; }
    if (!request.url.startsWith("/api/") || request.method !== "POST") { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}"), endpoint = request.url.slice(5);
    const entry = take(row => row.dir === "call" && row.endpoint === endpoint);
    if (entry === null) { fail("the driver called " + endpoint + " where the recording has no such call left"); response.writeHead(500); response.end(); return; }
    learn(entry.args, body.payload?.args);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: translate(entry.result) }));
    setImmediate(pump);
  });
});
const mux = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, raw, head) => mux.handleUpgrade(request, raw, head, ws => {
  socket = ws;
  ws.on("message", data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "open") {
      const entry = take(row => row.dir === "up" && row.frame.type === "open" && row.frame.endpoint === frame.endpoint);
      if (entry === null) { fail("the driver opened " + frame.endpoint + " where the recording has no such stream left"); return; }
      learn(entry.frame.payload, frame.payload);
      streams.set(entry.frame.streamId, frame.streamId);
    } else if (frame.type === "cancel") {
      const recorded = [...streams].find(([, live]) => live === frame.streamId)?.[0];
      take(row => row.dir === "up" && row.frame.type === "cancel" && row.frame.streamId === recorded);
    }
    setImmediate(pump);
  });
}));
server.listen(0, "127.0.0.1", () => process.stdout.write("dsh web: http://127.0.0.1:" + server.address().port + "/?token=replay\n"));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { mux.close(); server.close(); process.exit(0); });
