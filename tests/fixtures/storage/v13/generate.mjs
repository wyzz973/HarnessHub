// Generates the frozen Session v13 fixtures of the new storage (ADR-057, step 1, task T1): one business database per scenario, written by the
// real Session v13 runtime and SQLite store of the build given as the first argument, with the in-process fake Harnesses below, then dumped
// as JSON next to this file. See README.md for when and how to run it; the files it writes are the fixtures, and the tests never run it.
//
//   node tests/fixtures/storage/v13/generate.mjs <dist directory of a v13 build> <output directory>
//
// Everything is synthetic: fixed identities, a ticking clock, a fixed relay key, no Harness, no model, nothing read from a data directory. The
// same build writes the same files.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [distArgument, outArgument] = process.argv.slice(2);
if (!distArgument || !outArgument) throw new Error("usage: node generate.mjs <dist directory of a v13 build> <output directory>");
const dist = resolve(distArgument), out = resolve(outArgument);
const load = path => import(pathToFileURL(join(dist, path)).href);
const { SessionRuntime } = await load("src/contexts/session/application/runtime.js");
const { SqliteSessionStore } = await load("src/infrastructure/session/sqlite-store.js");
const { recoverRelay } = await load("src/contexts/session/domain/relay/recover.js");
const { nativeConversationId, sharedReading } = await load("src/contracts/control.js");
const { SessionError } = await load("src/contracts/session.js");
const { writeV12Root, loadV12Fixture, V12_FIXTURES } = await load("tests/fixtures/relay/v12/database.js");
const { GENERATIONS } = await load("tests/fixtures/storage/generations/database.js");
const trial = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../protocol/trial-2026-11-11.json"), "utf8"));

// The Runtime measures how long a Turn waited for the user with the monotonic clock (run.waiting_ended.waitedMs): a fixture takes it from a counter.
let monotonic = 0;
performance.now = () => (monotonic += 1);
/** The workspace every fixture names in place of its temporary one. */
const WORKSPACE = "/fixtures/storage/v13/workspace";
const BASE_TIME = Date.UTC(2026, 10, 12, 0, 0, 0);
const CLEAN = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const sha256 = data => createHash("sha256").update(data).digest("hex");
const wait = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

// ---------------------------------------------------------------------------------------------------------------------------------
// The installation's relay key, fixed so that the HMACs of the rows are the same on every run (relay-keys.ts keeps a random one).
// ---------------------------------------------------------------------------------------------------------------------------------
const KEY = Buffer.from("fixture-relay-key-for-storage-v13".padEnd(32, "."), "utf8");
const tag = (session, label, text) => createHmac("sha256", createHmac("sha256", KEY).update("relay-tag/1" + session).digest()).update(label + text).digest("hex");
const FIXED_KEYS = {
  keyId: "kfixture0000000000000000",
  inputHmac: (session, text) => tag(session, "input:", text),
  setTag: (session, secrets) => tag(session, "set:", [...secrets].sort().join("\n")).slice(0, 8),
  requestFingerprint: (session, canonical) => tag(session, "request:", canonical),
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Fake Harnesses. Every native session has its own identity (a new one per open without a checkpoint, the same one when resumed), the
// catalog lists the commands below, and `plans` says what a prompt does: the events it emits, how it ends. A Harness' declaration
// says what its end proves (relay-architecture §3.2): `alpha` reports the input as an event (E1), `bravo` is proved by its normal end,
// `charlie` can never show a delivery. `delta` accepts attachments.
// ---------------------------------------------------------------------------------------------------------------------------------
const COMMANDS = [{ name: "compact", description: "compact the native context", contextEffect: "compact" }, { name: "clear", description: "clear the native context", contextEffect: "clear" },
  { name: "undo", description: "undo the last input", contextEffect: "rewind" }, { name: "skill:review", description: "a skill", contextEffect: "keep" },
  { name: "status", description: "report", contextEffect: "none" }, { name: "mystery", description: "declares no effect" }];
const declared = (live, proves) => ({
  delivery: { live, successProvesRecorded: proves }, execution: "process",
  commands: { classify: (text, catalog) => sharedReading(text, catalog === null ? null : (name, args) => {
    const entry = catalog.find(row => row.name === name);
    return entry === undefined ? undefined : { effect: typeof entry.effect === "string" ? entry.effect : entry.effect.byArgs(args) };
  }) },
  placement: { parts: "single", maxInput: null, measure: turn => typeof turn === "string" ? [...turn].length : [...turn.relay.body].length + [...turn.user].length + 2 },
  title: "none",
});
const DECLARATIONS = { alpha: declared("recorded_event", false), bravo: declared("none", true), charlie: declared("none", false), delta: declared("none", true),
  dsh: declared("agent_output", true), codex: declared("none", true), opencode: declared("none", true), claude: declared("none", true), hermes: declared("none", true) };
const text = value => ({ type: "text", text: value });
const thinking = value => ({ type: "thinking", text: value });
const tool = (id, title, status, detail) => ({ type: "tool", id, title, status, ...(detail === undefined ? {} : { detail }) });
const plan = (entries, explanation) => ({ type: "plan", entries, ...(explanation === undefined ? {} : { explanation }) });
const usage = value => ({ type: "usage", usage: value });
const notice = (severity, title, detail) => ({ type: "notice", severity, title, ...(detail === undefined ? {} : { detail }) });
const activity = (id, kind, title, status, detail) => ({ type: "activity", id, kind, title, status, ...(detail === undefined ? {} : { detail }) });
const link = (uri, name, title, mediaType) => ({ type: "output", output: { kind: "link", uri, name, ...(title === undefined ? {} : { title }), ...(mediaType === undefined ? {} : { mediaType }) } });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137]);
const image = name => ({ type: "output", output: { kind: "content", name, mediaType: "image/png", data: PNG } });
const file = (name, body) => ({ type: "output", output: { kind: "content", name, mediaType: "text/plain", data: new TextEncoder().encode(body) } });

class Harnesses {
  constructor(content) {
    this.content = content; this.opened = 0; this.prompts = []; this.plans = new Map(); this.held = []; this.deciding = new Map(); this.kept = false;
    /** Harnesses that take attachments. */
    this.attachments = new Set(["alpha", "delta", "claude"]);
  }
  /** What the prompt `input` does on any Harness (or on `harnessId` only): see the fields below. */
  on(input, plan, harnessId = "*") { this.plans.set(harnessId + "\n" + input, plan); }
  relayCapabilities(selection) { return DECLARATIONS[selection.harnessId] ?? null; }
  async relaySecrets() { return []; }
  async validate(request) {
    if (!(request.harnessId in DECLARATIONS)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp", ...(request.provider == null ? {} : { provider: request.provider }),
      ...(request.nativeModel === undefined ? {} : { nativeModel: request.nativeModel }), ...(request.nativeOptions === undefined ? {} : { nativeOptions: request.nativeOptions }) };
  }
  async prepare(selected, configuration) {
    const harnessId = selected.harnessId; let session = null, healthy = true;
    const control = {
      relayCapabilities: DECLARATIONS[harnessId],
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session,
      fork: async checkpoint => checkpoint + "-fork-" + ++this.opened,
      healthy: () => healthy,
      processGroup: () => 4242,
      models: async () => ({ models: [{ id: "model-a", name: "A" }, { id: "model-b", name: "B" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: COMMANDS }),
      nativeConfig: async () => ({ model: selected.nativeModel ?? "model-a", options: {} }),
      ...(this.attachments.has(harnessId) ? { checkAttachments: async () => {} } : {}),
      decidePermission: async (id, option, input) => { this.deciding.get(id)?.({ option, input }); },
      startText: async (_id, turn, output, files) => {
        const input = typeof turn === "string" ? turn : turn.user, found = this.plans.get(harnessId + "\n" + input) ?? this.plans.get("*\n" + input) ?? {};
        this.prompts.push({ harnessId, input, session, packet: typeof turn === "object", files: files?.length ?? 0 });
        if (found.live === true) output({ type: "input_recorded", ...(typeof turn === "object" ? { packetId: turn.relay.packetId } : {}) });
        for (const item of found.events ?? [text("reply from " + harnessId)]) output(item);
        const extra = found.cleared === true ? { native: { cleared: true } } : {};
        let result;
        switch (found.result ?? "recorded") {
          case "recorded": result = Promise.resolve({ status: "completed", reason: found.reason ?? "fake", input: "recorded", ...extra }); break;
          case "unrecorded": result = Promise.resolve({ status: "completed", reason: found.reason ?? "fake", ...extra }); break;
          case "not_recorded": result = Promise.resolve({ status: "failed", reason: "refused", input: "not_recorded", error: { code: "REMOTE_ERROR", message: "the native side refused the input" } }); break;
          case "failed": result = Promise.resolve({ status: "failed", reason: found.reason ?? "model_error", input: "recorded", error: found.error ?? { code: "NATIVE_RATE_LIMITED", message: "rate limit reached" } }); break;
          case "lost": result = new Promise((_resolve, reject) => { setImmediate(() => reject(new SessionError("CONTROL_FAILED", "the connection ended without a result"))); }); break;
          case "hold": result = new Promise((resolveHold, rejectHold) => { this.held.push({ harnessId, input, release: () => resolveHold({ status: "completed", reason: "fake", input: "recorded" }), lose: () => rejectHold(new SessionError("CONTROL_FAILED", "the connection ended without a result")),
            stop: () => resolveHold({ status: "cancelled", reason: "stopped" }), emit: output }); }); break;
          case "decision": result = new Promise(resolveDecision => { for (const item of found.events ?? []) if (item.type === "permission_requested") this.deciding.set(item.id, () => resolveDecision({ status: "completed", reason: "fake", input: "recorded" })); }); break;
        }
        return { result, requestStop: async () => { for (const held of this.held.splice(0)) held.stop(); return { requested: true }; } };
      },
      close: async () => { healthy = false; return CLEAN; },
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  async readNativeSession(_selection, _configuration, nativeId) {
    if (nativeId.includes("unread")) return { checkpoint: nativeId, title: null, complete: false, historyRead: false, omitted: 0, history: [] };
    return { checkpoint: nativeId, title: "an imported conversation", complete: true, historyRead: true, omitted: 3, history: [
      { role: "user", text: "an earlier question about the build" }, { role: "assistant", text: "an earlier answer: run it twice" },
      { role: "user", text: "and the 日本語 tests？" }, { role: "assistant", text: "they pass 🎉" }] };
  }
}

/** A content store that keeps nothing but what it was given, by a digest: the references are real-looking and the same on every run. */
class Contents {
  constructor() { this.objects = new Map(); }
  async storeOutput({ name, mediaType, data }) {
    const id = "content-" + sha256(name + "\n" + mediaType + "\n").slice(0, 8) + sha256(data).slice(0, 24);
    const ref = { id, name, mediaType, kind: mediaType.startsWith("image/") ? "image" : "file", bytes: data.byteLength, sha256: sha256(data) };
    this.objects.set(id, { ref, ...(mediaType === "application/json" || mediaType.startsWith("text/") ? { text: new TextDecoder().decode(data) } : {}) });
    return ref;
  }
  /** An upload staged ahead: `photo-1` is a PNG, `notes-1` a text file, and so on by their prefix. */
  resolve(ids) {
    return ids.map(id => {
      const image = id.startsWith("photo"), name = (image ? "photo-" : "notes-") + id.replace(/\D+/gu, "") + (image ? ".png" : ".txt");
      const ref = { id: "content-" + id.replace(/[^A-Za-z0-9]+/gu, "-"), name, mediaType: image ? "image/png" : "text/plain", kind: image ? "image" : "file", bytes: image ? PNG.byteLength : 20, sha256: sha256("upload:" + id) };
      this.objects.set(ref.id, { ref }); return ref;
    });
  }
  async materialize(refs) { return refs.map(ref => ({ ...ref, path: "/fixtures/uploads/" + ref.name })); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A world: a temporary data root, a store, a runtime, and what the scripts of a scenario need.
// ---------------------------------------------------------------------------------------------------------------------------------
async function open(prefix, describe, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "storage-v13-fixture-")), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  let tick = 0, ids = 0, keys = 0;
  const now = () => new Date(BASE_TIME + 1000 * tick++);
  const store = new SqliteSessionStore(data, { now, recoverRelay });
  const contents = settings.contents ?? new Contents(), harnesses = new Harnesses(contents);
  const processes = { identify: async group => "Thu Nov 12 00:00:00 2026 pid " + group, end: async () => "terminated", outsiders: async () => [], running: async () => [] };
  const app = new SessionRuntime(store, harnesses, { id: () => prefix + "-" + ++ids, now, publish: () => {}, content: contents, relayKeys: FIXED_KEYS, processes,
    // A window of streamed text is committed when something else of the Turn is, or when it holds 16 KiB: never by a timer (timers are real time).
    schedule: () => () => {},
    // A command's fingerprint covers the conversation's configuration; it is taken as if the workspace were the fixed one.
    fingerprint: value => createHash("sha256").update(value.split(JSON.stringify(workspace).slice(1, -1)).join(WORKSPACE)).digest("hex") });
  const configuration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const w = { prefix, describe, root, data, workspace, store, app, harnesses: harnesses, contents, configuration, now };
  w.create = async (harnessId, extra = {}) => (await app.create(configuration, { harnessId, ...extra }, prefix + "-create-" + ++keys)).id;
  w.key = label => prefix + "-" + label + "-" + ++keys;
  w.send = async (id, input, options = {}) => { const receipt = app.send(id, input, w.key("send"), options.attachments ?? [], options.relay); if (options.wait !== false) await app.wait(id).catch(blocked); return receipt.runId; };
  w.to = async (id, harnessId, extra = {}) => { app.switch(id, { harnessId, ...extra }, w.key("switch")); await app.wait(id).catch(blocked); };
  w.resume = async (id, harnessId, acknowledge = true) => { app.resume(id, { harnessId }, w.key("resume"), acknowledge); await app.wait(id).catch(blocked); };
  w.cancel = (id, run) => app.cancel(id, w.key("cancel"), run);
  w.until = async (condition, label) => { for (let tries = 0; tries < 4000; tries++) { if (condition()) return; await wait(5); } throw new Error("never happened: " + label); };
  w.close = async () => { try { await app.close(); } catch { /* a runtime whose owner is gone */ } try { store.close(); } catch { /* closed */ } await rm(root, { recursive: true, force: true }); };
  return w;
}
/** A session that blocked on an unknown Turn makes `wait` throw SESSION_BLOCKED; a script that expects it goes on. */
function blocked(error) { if (!(error instanceof SessionError && error.code === "SESSION_BLOCKED")) throw error; }

// ---------------------------------------------------------------------------------------------------------------------------------
// The dump: the business database as plain JSON.
// ---------------------------------------------------------------------------------------------------------------------------------
const rowsOf = (database, sql) => database.prepare(sql).all().map(row => ({ ...row }));
function dumpDatabase(databasePath, w, store, name, describe) {
  const workspace = w.workspace;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    if (userVersion !== 13) throw new Error("the build given is not a Session v13 build (user_version " + userVersion + ")");
    const owner = database.prepare("SELECT owner_generation FROM owner_metadata WHERE singleton=1").get();
    const sessions = database.prepare("SELECT id,version,last_seq,snapshot FROM sessions ORDER BY rowid").all().map(row => ({
      id: row.id, version: row.version, lastSeq: row.last_seq, snapshot: JSON.parse(row.snapshot),
      events: database.prepare("SELECT event_json FROM events WHERE session_id=? ORDER BY seq").all(row.id).map(event => JSON.parse(event.event_json)),
    }));
    const createKeys = database.prepare("SELECT command_id,session_id,fingerprint FROM create_keys ORDER BY rowid").all().map(row => ({ commandId: row.command_id, sessionId: row.session_id, fingerprint: row.fingerprint }));
    const relay = { bodies: rowsOf(database, "SELECT * FROM relay_bodies ORDER BY rowid"), packets: rowsOf(database, "SELECT * FROM relay_packets ORDER BY rowid"),
      deliveries: rowsOf(database, "SELECT * FROM relay_deliveries ORDER BY rowid"), index: rowsOf(database, "SELECT * FROM relay_index ORDER BY rowid"),
      log: rowsOf(database, "SELECT * FROM relay_log ORDER BY seq"), prefs: rowsOf(database, "SELECT * FROM relay_prefs ORDER BY key") };
    const references = [...store.contentReferences()].sort();
    const contents = Object.fromEntries(references.map(id => [id, w.contents.objects.get(id) ?? { ref: { id, note: "not in the generator's content store" } }]));
    const dump = { fixture: name, describe, generator: "tests/fixtures/storage/v13/generate.mjs", userVersion, ownerGeneration: owner.owner_generation, sessions, createKeys, relay, contents, contentReferences: references };
    // The temporary workspace is named at random; the fixture names a fixed one so that the same build writes the same file.
    return JSON.parse(JSON.stringify(dump).split(JSON.stringify(workspace).slice(1, -1)).join(WORKSPACE));
  } finally { database.close(); }
}
/** The business database as it stands now, while its owner may be working: what an owner that dies leaves behind. */
const dumpNow = (w, name, describe = w.describe) => dumpDatabase(join(w.data, "gateway.sqlite"), w, w.store, name, describe);
const finished = dump => !dump.sessions.some(row => row.snapshot.runs.some(run => ["queued", "preparing", "running", "settling"].includes(run.status)) || row.snapshot.pendingSwitchId !== null);
const written = [];
function writeFixture(dump) {
  const unfinished = !finished(dump);
  writeFileSync(join(out, dump.fixture + ".json"), JSON.stringify({ ...dump, unfinished }, null, 1) + "\n");
  written.push(dump.fixture + ": " + dump.sessions.map(row => row.id + " v" + row.version + " seq" + row.lastSeq + " runs" + row.snapshot.runs.length).join(", ") + (unfinished ? " (unfinished)" : ""));
}
/**
 * Runs a scenario in a world and writes what it dumps. A scenario that returns nothing is dumped once its runtime is closed (every Turn
 * ended); one that returns dumps (of the databases it copied while a Turn was still going) names the fixtures itself.
 */
async function scenario(name, prefix, describe, script) {
  const w = await open(prefix, describe);
  try {
    const dumps = await script(w);
    if (dumps === undefined) { await w.app.close(); writeFixture(dumpNow(w, name, describe)); w.store.close(); }
    else for (const dump of dumps) writeFixture(dump);
  } finally { await w.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The scenarios.
// ---------------------------------------------------------------------------------------------------------------------------------
mkdirSync(out, { recursive: true });

await scenario("switches", "sw", "Several Harnesses and the switches between them: alpha, bravo and back; the same Harness on another model only (and back); alpha, bravo, charlie and Native options", async w => {
  const a = await w.create("alpha");
  await w.send(a, "a1 on alpha"); await w.send(a, "a2 on alpha");
  await w.to(a, "bravo"); await w.send(a, "b1 on bravo"); await w.send(a, "b2 on bravo");
  await w.to(a, "alpha"); await w.send(a, "a3 back on alpha");
  const m = await w.create("alpha", { nativeModel: "model-a" });
  await w.send(m, "m1 on model-a"); await w.to(m, "alpha", { nativeModel: "model-b" }); await w.send(m, "m2 on model-b"); await w.to(m, "alpha", { nativeModel: "model-a" }); await w.send(m, "m3 on model-a again");
  const t = await w.create("alpha", { nativeOptions: { effort: "high" } });
  await w.send(t, "t1 on alpha with an effort"); await w.to(t, "bravo"); await w.send(t, "t2 on bravo"); await w.to(t, "charlie"); await w.send(t, "t3 on charlie");
  await w.to(t, "bravo", { nativeModel: "model-b" }); await w.send(t, "t4 on bravo, model-b"); await w.to(t, "alpha", { nativeOptions: { effort: "low" } }); await w.send(t, "t5 on alpha, effort low");
});

await scenario("relay-states", "rs", "What the relay did with a handoff: carried and confirmed by the end, carried and never confirmed then sent again, only the user's words, the whole history again, confirmed by an E1 event, refused by the native side", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  await w.send(id, "a1 a fact only alpha knows");
  await w.to(id, "bravo"); await w.send(id, "b1 carries a1, proved by bravo's end");
  await w.to(id, "charlie"); await w.send(id, "c1 carries a1 b1, charlie can never show it"); await w.send(id, "c2 sends the unconfirmed packet again");
  await w.send(id, "c3 only my words", { relay: { attach: "none" } });
  await w.to(id, "alpha"); h.on("a2 back on alpha, E1", { live: true }); await w.send(id, "a2 back on alpha, E1");
  await w.send(id, "a3 the whole history again", { relay: { attach: "full" } });
  await w.to(id, "delta"); h.on("d1 refused", { result: "not_recorded" }); await w.send(id, "d1 refused");
  await w.send(id, "d2 after the refusal");
  // The same, in a conversation whose first Harness never confirms anything and whose second is told nothing: unrecorded endings.
  const u = await w.create("charlie");
  await w.send(u, "u1 on charlie"); await w.to(u, "bravo"); h.on("u2 unrecorded", { result: "unrecorded" }); await w.send(u, "u2 unrecorded"); await w.send(u, "u3 follows");
});

await scenario("commands", "cm", "Native command Turns: /compact, the Hub's clear (a new native session next), /status, a command of unknown effect, a listed skill, /undo; and a command as the first input after a switch (D1)", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  await w.send(id, "a1 before the commands"); await w.send(id, "/compact"); await w.send(id, "a2 after compact");
  h.on("/clear", { cleared: true }); await w.send(id, "/clear"); await w.send(id, "a3 after the clear");
  await w.send(id, "/status"); await w.send(id, "/mystery"); await w.send(id, "/skill:review"); await w.send(id, "/undo"); await w.send(id, "a4 after undo");
  h.on("/compact refused", { result: "not_recorded" }); await w.send(id, "/compact");
  const d = await w.create("alpha");
  await w.send(d, "d1 on alpha"); await w.send(d, "d2 on alpha"); await w.to(d, "bravo"); await w.send(d, "d3 on bravo"); await w.to(d, "alpha"); await w.send(d, "/compact");
  await w.send(d, "d4 after the first command back");
  const c = await w.create("bravo");
  await w.send(c, "c1 on bravo"); h.on("/clear", { cleared: true }, "bravo"); await w.send(c, "/clear"); await w.to(c, "alpha"); await w.send(c, "c2 on alpha after bravo's clear");
});

await scenario("branch", "br", "Branches: one made after an older Turn (public history, attachments quoted), one made after the latest Turn (a native fork), a branch of a branch, and Turns on them", async w => {
  const src = await w.create("alpha");
  await w.send(src, "s1 with a picture", { attachments: ["photo-1"] });
  const second = await w.send(src, "s2 a notes file and a picture", { attachments: ["notes-2", "photo-3"] });
  await w.send(src, "s3 work", { });
  const older = w.app.fork(src, w.key("fork"), second); await w.app.wait(older.id);
  await w.send(older.id, "o1 on the branch of the older Turn");
  const latest = w.app.fork(src, w.key("fork")); await w.app.wait(latest.id);
  await w.send(latest.id, "l1 on the native fork"); await w.send(latest.id, "l2 on the native fork, with a picture", { attachments: ["photo-4"] });
  const deeper = w.app.fork(older.id, w.key("fork")); await w.app.wait(deeper.id);
  await w.send(deeper.id, "d1 on the branch of a branch");
});

await scenario("branch-pending", "bp", "A branch whose native fork has not been made yet: the database right after the branch was recorded (a fork-pending binding), before the Runtime did anything about it", async w => {
  const src = await w.create("alpha");
  await w.send(src, "s1 before the branch"); await w.send(src, "s2 before the branch");
  const branch = w.app.fork(src, w.key("fork"));
  const pending = dumpNow(w, "branch-pending", w.describe);
  await w.app.wait(branch.id);
  return [pending];
});

await scenario("import", "im", "Native sessions continued in the Hub: one with its recent history quoted (and older messages left out), one whose history could not be read; Turns on them and a branch of the first", async w => {
  const first = (await w.app.importNative(w.configuration, { harnessId: "alpha" }, "native-alpha-imported", w.key("import"))).id;
  await w.send(first, "i1 after the import"); await w.send(first, "i2 after the import");
  const unread = (await w.app.importNative(w.configuration, { harnessId: "bravo" }, "native-bravo-unread", w.key("import"))).id;
  await w.send(unread, "u1 on an import with no history");
  const branch = w.app.fork(first, w.key("fork")); await w.app.wait(branch.id);
  await w.send(branch.id, "b1 on a branch of an import");
  await w.to(first, "bravo"); await w.send(first, "i3 on bravo, which is owed the imported history");
});

// ---- tools: every shape a Turn holds -------------------------------------------------------------------------------------------
const WS = WORKSPACE;
await scenario("tools", "tl", "Every shape of a Turn's work: commands (with and without detail, a diff, an exit code), reads, searches, fetches, Hub tools, a sub-agent with nested calls, task-list calls (with and without detail), a plan with priorities, usage, notices of each severity (an error notice with the Run's own error), activities of each kind with detail, outputs (content, links with and without title and type), attachments, a Codex sub-agent told as both a tool and an activity, approvals and a question, a cancelled Turn with a call still open, and every word of status", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  h.on("t1 work", { events: [
    thinking("Let me look at the repository first. "), thinking("Then the failing test."),
    tool("Bash:1", "git status --short", "pending", { kind: "execute", name: "Bash", input: "git status --short" }),
    tool("Bash:1", "git status --short", "completed", { kind: "execute", name: "Bash", input: "git status --short", output: " M src/a.ts\n?? notes.txt\n", exitCode: 0 }),
    tool("Bash:2", "npm test", "failed", { kind: "execute", name: "Bash", input: "npm test", output: "1 failing\n  a.test.ts: expected 2, got 3", exitCode: 1 }),
    tool("Read:1", "Read src/a.ts", "completed", { kind: "read", name: "Read", input: JSON.stringify({ file_path: WS + "/src/a.ts" }), output: "export const a = 1;\n", locations: [WS + "/src/a.ts:1"] }),
    tool("Edit:1", "Edit src/a.ts", "completed", { kind: "edit", name: "Edit", input: JSON.stringify({ file_path: WS + "/src/a.ts" }), locations: [WS + "/src/a.ts"],
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n" }),
    tool("Edit:2", "Edit 2 files", "completed", { kind: "edit", name: "MultiEdit", locations: [WS + "/src/b.ts", WS + "/src/c.ts"],
      diff: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+B\n--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-c\n+C\n" }),
    tool("Grep:1", "Grep \"TODO\"", "completed", { kind: "search", name: "Grep", input: JSON.stringify({ pattern: "TODO", path: WS + "/src" }), output: "src/a.ts:3: TODO" }),
    tool("Web:1", "WebFetch https://example.com/docs", "completed", { kind: "fetch", name: "WebFetch", input: JSON.stringify({ url: "https://example.com/docs" }), output: "<html>…</html>" }),
    tool("Mcp:1", "mcp__harnesshub__hub_turns", "completed", { kind: "other", name: "mcp__harnesshub__hub_turns", output: "Turn 1 of 3 …" }),
    tool("Task:1", "Task: audit the tests", "in_progress", { kind: "other", name: "Task", input: JSON.stringify({ description: "audit the tests" }) }),
    tool("Bash:3", "ls tests", "completed", { kind: "execute", name: "Bash", input: "ls tests", output: "a.test.ts\n", exitCode: 0, parentId: "Task:1" }),
    tool("Read:2", "Read tests/a.test.ts", "completed", { kind: "read", name: "Read", input: JSON.stringify({ file_path: WS + "/tests/a.test.ts" }), parentId: "Task:1" }),
    tool("Task:1", "Task: audit the tests", "completed", { kind: "other", name: "Task", output: "two gaps found" }),
    tool("Todo:1", "TodoWrite", "completed", { kind: "other", name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "fix a", status: "in_progress" }, { content: "run the tests", status: "pending" }] }) }),
    tool("Todo:2", "update_plan", "completed", { kind: "other", name: "update_plan" }),
    tool("Todo:3", "todo_write", "completed"),
    plan([{ content: "Fix a.ts", status: "completed", priority: "high" }, { content: "Run the tests", status: "in_progress", priority: "medium" }, { content: "Write notes", status: "pending", priority: "low" }, { content: "No priority yet", status: "pending" }], "Two steps done, one to go."),
    usage({ turn: { input: 12000, output: 700, cachedInput: 9000, cacheWrite: 300, reasoning: 120, total: 12700 }, context: { used: 50000, size: 200000 }, cost: { amount: 0.0123, currency: "USD", scope: "turn" } }),
    notice("info", "Using cached credentials"), notice("warning", "Slow network", "latency 2.3 s"),
    activity("sub-1", "subagent", "Audit subagent", "running", "started"), activity("sub-1", "subagent", "Audit subagent", "completed", "done after 3 calls"),
    activity("task-1", "task", "Background task", "completed", "indexed 40 files"), activity("comp-1", "compaction", "Context compacted", "completed", "kept 20% of the history"),
    activity("retry-1", "retry", "Retrying the request", "completed", "attempt 2 of 3"), activity("review-1", "review", "Code review", "failed", "two comments"),
    link("https://example.com/report", "report", "The report", "text/html"), link("https://example.com/plain", "plain"), link("file:///fixtures/out/build.log", "build.log", undefined, "text/plain"),
    image("shot.png"), file("notes.txt", "hello from a Harness\n"),
    thinking(" One last thought."), text("Here is the "), text("summary of the work."),
  ] });
  await w.send(id, "t1 work");
  // A Codex sub-agent: the tool entry `agent:<thread>` and the activity of the same thread; its nested call; a sub-agent of a sub-agent.
  await w.to(id, "bravo");
  h.on("t2 codex agents", { events: [
    tool("agent:thread-aaaa", "子 Agent · explorer", "in_progress", { kind: "subagent", name: "codex-subagent" }), activity("thread-aaaa", "subagent", "/root/explorer", "running", "gpt-5"),
    tool("cmd-1", "/bin/zsh -lc 'rg -n todo src'", "in_progress", { kind: "execute", name: "shell", input: "rg -n todo src", parentId: "agent:thread-aaaa" }),
    tool("cmd-1", "/bin/zsh -lc 'rg -n todo src'", "completed", { kind: "execute", name: "shell", input: "rg -n todo src", output: "src/a.ts:3", exitCode: 0, parentId: "agent:thread-aaaa" }),
    tool("agent:thread-bbbb", "子 Agent · worker", "in_progress", { kind: "subagent", name: "codex-subagent", parentId: "agent:thread-aaaa" }), activity("thread-bbbb", "subagent", "/root/explorer/worker", "running"),
    tool("agent:thread-bbbb", "子 Agent · worker", "completed", { kind: "subagent", name: "codex-subagent" }), activity("thread-bbbb", "subagent", "/root/explorer/worker", "completed"),
    tool("agent:thread-aaaa", "子 Agent · explorer", "completed", { kind: "subagent", name: "codex-subagent" }), activity("thread-aaaa", "subagent", "/root/explorer", "completed", "gpt-5"),
    tool("mcp-1", "harnesshub.hub_read_turn", "completed", { kind: "mcp", name: "harnesshub/hub_read_turn", input: JSON.stringify({ n: 1, part: "tools" }), output: "Turn 1 …" }),
    text("The agents are done."),
    usage({ turn: { input: 36563, output: 66, cachedInput: 13440, cacheWrite: 0, reasoning: 48, total: 36629 }, context: { used: 36629, size: 828400 } }),
  ] });
  await w.send(id, "t2 codex agents");
  // Every word of status a call can end on, and an exit code on a call that is no command.
  await w.to(id, "alpha");
  h.on("t3 statuses", { events: [
    ...["pending", "in_progress", "completed", "failed", "declined", "cancelled", "interrupted", "error", "waiting", "mystery-state", "COMPLETED", "In Progress"].map((status, at) => tool("S:" + at, "call " + at + " " + status, status, at % 3 === 0 ? { kind: "execute", name: "Bash", input: "true", exitCode: at % 2 } : undefined)),
    tool("S:read", "Read /etc/hosts", "completed", { kind: "read", name: "Read", exitCode: 0 }),
    text("Statuses reported."),
  ] });
  await w.send(id, "t3 statuses");
  // A failed Turn: the backend's error, and an error notice beside it; a Turn that failed with a limit; a rate-limited one.
  h.on("t4 fails", { result: "failed", error: { code: "NATIVE_QUOTA_EXCEEDED", message: "The quota is used up for this month." }, events: [
    text("Starting. "), tool("F:1", "npm run build", "failed", { kind: "execute", name: "Bash", input: "npm run build", output: "error TS2304", exitCode: 2 }),
    notice("error", "The build failed", "error TS2304: cannot find name 'x'"), notice("error", "Quota"), notice("warning", "Close to the limit")] });
  await w.send(id, "t4 fails");
  h.on("t5 rate limited", { result: "failed", reason: "max_tokens", error: { code: "NATIVE_RATE_LIMITED", message: "slow down" }, events: [] });
  await w.send(id, "t5 rate limited");
  // An error notice without an error of the Run's own (the Run completed).
  h.on("t6 error notice only", { events: [notice("error", "A tool reported an error", "and the model went on"), text("Went on anyway.")] });
  await w.send(id, "t6 error notice only");
  // Attachments (two, an image and a text file) on a Turn, and a Turn with a Provider as its model.
  await w.send(id, "t7 with attachments", { attachments: ["photo-9", "notes-9"] });
  await w.to(id, "alpha", { provider: { providerId: "provider-0a1b2c3d-0000-4000-8000-000000000001", revision: 3, model: "gpt-x" } });
  h.on("t8 on a Provider", { events: [thinking("Provider thinking."), text("Answered by a managed Provider."), usage({ turn: { input: 10, output: 5 }, context: { used: 777 }, cost: { amount: 0.001, currency: "USD", scope: "session" } })] });
  await w.send(id, "t8 on a Provider");
  await w.to(id, "alpha", { provider: null });
  // A cancelled Turn: a call still open, thinking and a window of text in flight.
  h.on("t9 stopped", { result: "hold", events: [thinking("Starting to think"), tool("C:1", "sleep 600", "in_progress", { kind: "execute", name: "Bash", input: "sleep 600" }), tool("C:2", "Read big.log", "pending", { kind: "read", name: "Read" }), text("Working on it")] });
  w.app.send(id, "t9 stopped", w.key("send"));
  await w.until(() => h.held.length === 1, "t9 held");
  w.cancel(id); await w.app.wait(id).catch(blocked);
  // An approval allowed, a question answered with a choice, a question answered in text.
  h.on("t10 asks", { result: "decision", events: [text("I need to run a command. "), tool("P:1", "rm -rf build", "pending", { kind: "execute", name: "Bash", input: "rm -rf build" }),
    { type: "permission_requested", id: "native-perm-1", title: "Run rm -rf build?", detail: "in " + WS, options: [{ id: "allow", name: "Allow once" }, { id: "deny", name: "Deny" }], expiresInMs: 600000, expiresBy: "turn" }] });
  w.app.send(id, "t10 asks", w.key("send")); await w.until(() => w.app.attention().length === 1, "t10 pending");
  await w.app.decidePermission(id, w.app.attention()[0].permissionId, "allow", w.key("decide")); await w.app.wait(id);
  h.on("t11 questions", { result: "decision", events: [text("Two questions. "), { type: "permission_requested", id: "native-q-1", kind: "question", title: "Which branch?", options: [{ id: "main", name: "main" }, { id: "dev", name: "dev" }], expiresInMs: 600000, expiresBy: "turn" }] });
  w.app.send(id, "t11 questions", w.key("send")); await w.until(() => w.app.attention().length === 1, "t11 pending");
  await w.app.decidePermission(id, w.app.attention()[0].permissionId, "dev", w.key("decide")); await w.app.wait(id);
  h.on("t12 free text", { result: "decision", events: [{ type: "permission_requested", id: "native-q-2", kind: "question", title: "What should the file be called?", input: { kind: "text", value: "" }, options: [{ id: "submit", name: "Submit" }], expiresInMs: 600000, expiresBy: "turn" }] });
  w.app.send(id, "t12 free text", w.key("send")); await w.until(() => w.app.attention().length === 1, "t12 pending");
  await w.app.decidePermission(id, w.app.attention()[0].permissionId, "submit", w.key("decide"), "notes-final.md"); await w.app.wait(id);
  await w.send(id, "t13 a plain Turn after all of it");
});

// ---- text-extremes: strings the old runtime stored and the new one must keep ----------------------------------------------------------
const mixed = length => { const unit = "paragraph 段落 ünï — "; let value = ""; while (value.length < length) value += unit; return value.slice(0, length - (value.slice(0, length).endsWith("\ud83d") ? 1 : 0)); };
const REASONING_CUT = 64 * 1024;
const longThinking = mixed(REASONING_CUT - 1) + "😀" + mixed(900) + " the end of a long thought.";
const exact4096 = "你".repeat(1364) + "😀";
await scenario("text-extremes", "tx", "Strings at their extremes: a thinking longer than 64 KiB with a surrogate pair across the 65,536th unit, a call titled with 1,500 characters and one titled with exactly 4,096 bytes of multi-byte text, notices/activities/plan steps at their byte limits, control characters and look-alike identities, an empty thinking and an empty reply, a failed Turn whose reply ends in half a surrogate pair, a long input", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  const chunks = []; for (let at = 0; at < longThinking.length; at += 4093) chunks.push(thinking(longThinking.slice(at, at + 4093)));
  h.on("x1 a very long thought", { events: [...chunks, text(mixed(6000) + "\n\nDone."), tool("L:1", "echo " + "x".repeat(1495), "completed", { kind: "execute", name: "Bash", input: "echo " + "x".repeat(1495), exitCode: 0 }),
    tool("L:2", exact4096, "completed", { kind: "other", name: "Custom" }), tool("L:3", "你好".repeat(680) + "…", "completed", { kind: "execute", name: "Bash" })] });
  await w.send(id, "x1 a very long thought");
  const title1024 = "测".repeat(341) + "a", detail4096 = "详".repeat(1365) + "a";
  h.on("x2 limits of the runtime's own bounds", { events: [notice("warning", title1024, detail4096), activity("A".repeat(512), "subagent", title1024, "completed", detail4096),
    plan([{ content: "步".repeat(1365) + "a", status: "pending", priority: "high" }, { content: "", status: "completed" }], detail4096), link("https://example.com/" + "p".repeat(3000), "n".repeat(900), "t".repeat(1000), "application/vnd.example+json"), text("limits")] });
  await w.send(id, "x2 limits of the runtime's own bounds");
  h.on("x3 strange identities", { events: [
    tool("tool:weird#1", "id with a colon and a hash", "completed", { kind: "other", name: "N" }), tool("__proto__", "id __proto__", "completed", { kind: "other", name: "constructor" }),
    tool("constructor", "id constructor", "completed"), tool(" padded ", "padded id", "completed", { kind: "other", name: "hasOwnProperty" }), tool("Id", "case", "completed"), tool("id", "case", "completed"),
    tool("long-" + "i".repeat(500), "a 505-unit id", "completed"), tool("tool:weird#1#2", "id that looks disambiguated", "completed"),
    tool("ctl", "line1\nline2\ttab\r\nCRLF \u2028 \u0085 \u007f \u001b[31mred\u001b[0m \u200d\u200b\ufeff \u202eRTL\u202c e\u0301 \"quoted\" back\\slash </script>", "completed", { kind: "execute", name: "Bash", input: "echo é" }),
    notice("info", "line1\nline2 \u2028 😀"), activity("act:weird#1", "task", "colon:id", "completed"), activity("__proto__", "retry", "proto", "completed"), text("Café ☕ 🎉\r\nCRLF line\ttab")] });
  await w.send(id, "x3 strange identities");
  h.on("x4 empty on purpose", { events: [thinking(""), text("")] });
  await w.send(id, "x4 empty on purpose");
  h.on("x5 nothing at all", { events: [] });
  await w.send(id, "x5 nothing at all");
  h.on("x6 half a pair", { result: "failed", error: { code: "NATIVE_CONNECTION_FAILED", message: "the connection dropped" }, events: [thinking("half \ud83d"), tool("H:1", "after the thought", "completed"), text("the reply ends in half a surrogate pair: \ud83d")] });
  await w.send(id, "x6 half a pair");
  await w.send(id, "  x7 a long input, with spaces around and 😀 emoji and 日本語\r\n" + mixed(8000) + "  \n");
  h.on("x8 empty plan", { events: [plan([]), text("an empty plan")] });
  await w.send(id, "x8 empty plan");
});

// ---- at-the-old-limits: a Run at every cap the old runtime had ---------------------------------------------------------------------
await scenario("at-the-old-limits", "ol", "A Turn at every count the old runtime allowed: 128 calls, 32 notices, 64 activities, a plan of 64 steps, 32 outputs, 8 attachments", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  h.on("l1 at the limits", { events: [
    ...Array.from({ length: 128 }, (_, at) => tool("N:" + at, "call number " + at, at % 7 === 0 ? "failed" : "completed", at % 2 ? { kind: "execute", name: "Bash", input: "echo " + at, exitCode: at % 7 === 0 ? 1 : 0, ...(at % 5 === 0 && at > 0 ? { parentId: "N:" + (at - 5) } : {}) } : { kind: "read", name: "Read" })),
    ...Array.from({ length: 32 }, (_, at) => notice(at % 3 === 0 ? "warning" : "info", "notice number " + at, at % 2 ? "detail " + at : undefined)),
    ...Array.from({ length: 64 }, (_, at) => activity("act-" + at, ["subagent", "task", "compaction", "retry", "review"][at % 5], "activity " + at, ["running", "completed", "failed", "cancelled"][at % 4], at % 3 ? "detail " + at : undefined)),
    plan(Array.from({ length: 64 }, (_, at) => ({ content: "step " + at, status: ["pending", "in_progress", "completed"][at % 3], ...(at % 4 === 0 ? { priority: ["high", "medium", "low"][at % 3] } : {}) }))),
    ...Array.from({ length: 32 }, (_, at) => link("https://example.com/o/" + at, "out-" + at, at % 2 ? "Output " + at : undefined, at % 3 ? "text/html" : undefined)),
    text("Everything at its limit.")] });
  await w.send(id, "l1 at the limits", { attachments: Array.from({ length: 8 }, (_, at) => (at % 2 ? "notes-" : "photo-") + (20 + at)) });
});

// ---- kept-process: a conversation that keeps its native process ------------------------------------------------------------------
await scenario("kept-process", "kp", "Conversations that keep their native process between Turns (ADR-030): one holding it now (its head says so, with the identity of its process group), one that ended it, one that turned the setting off", async w => {
  const a = await w.create("alpha");
  w.app.setRetention(a, true, w.key("retention"));
  await w.send(a, "k1 keeps its process"); await w.send(a, "k2 reuses it"); await w.send(a, "k3 reuses it again");
  const b = await w.create("alpha");
  w.app.setRetention(b, true, w.key("retention"));
  await w.send(b, "e1 keeps its process"); await w.send(b, "e2 reuses it"); await w.app.endKept(b, w.key("end"));
  await w.send(b, "e3 starts a new process");
  const c = await w.create("bravo");
  w.app.setRetention(c, true, w.key("retention")); await w.send(c, "o1 keeps its process"); w.app.setRetention(c, false, w.key("retention")); await w.send(c, "o2 closes it first");
  // The owner has not closed anything: what a crash leaves is what the database holds now.
  return [dumpNow(w, "kept-process", w.describe)];
});

/** The content ids a conversation's snapshot refers to (what the v13 store's collector keeps of it). */
function referencesOf(snapshot) {
  const ids = new Set();
  for (const run of snapshot.runs) {
    for (const tool of run.tools ?? []) if (tool.detail !== undefined) ids.add(tool.detail.id);
    for (const output of run.outputs ?? []) if (output.kind === "content") ids.add(output.content.id);
    for (const attachment of run.attachments ?? []) ids.add(attachment.id);
  }
  for (const message of snapshot.origin?.history ?? []) for (const attachment of message.attachments ?? []) ids.add(attachment.id);
  return [...ids].sort();
}
/**
 * The first conversation of `unknown-recovered` with its recovery switch written the way a later v13 Runtime writes it: the unknown Turn is in
 * `acknowledgedUnknown` and no longer among the sources, and the switch has its mode and its timing. SHAPED BY HAND from what this build wrote: this build
 * never writes those three fields (the contract and the validation have them), so a conversation like this one is valid v13 data that the migration must
 * read, and the other way of acknowledging a Turn to test.
 */
function acknowledgedByList(dump) {
  const row = dump.sessions[0], snapshot = structuredClone(row.snapshot);
  const unknown = snapshot.runs.find(run => run.status === "unknown"), recovery = snapshot.switches.find(entry => entry.status === "effective" && entry.sourceRunIds.includes(unknown.id));
  const at = unknown.timing.endedAt + 1000;
  snapshot.switches = snapshot.switches.map(entry => entry !== recovery ? entry : { ...entry, sourceRunIds: entry.sourceRunIds.filter(id => id !== unknown.id), mode: "wait_current", timing: { requestedAt: at, validatedAt: at + 1000, effectiveAt: at + 2000 }, acknowledgedUnknown: [unknown.id] });
  const keep = rows => rows.filter(entry => entry.session_id === row.id), references = referencesOf(snapshot);
  return { ...dump, fixture: "unknown-acknowledged", describe: "The first conversation of unknown-recovered with its recovery switch in the form a later v13 Runtime writes it (acknowledgedUnknown, mode and timing; the unknown Turn no longer among the switch's sources). Shaped by hand: this build never writes those fields",
    sessions: [{ ...row, snapshot }], createKeys: dump.createKeys.filter(entry => entry.sessionId === row.id),
    relay: { ...dump.relay, bodies: keep(dump.relay.bodies), packets: keep(dump.relay.packets), deliveries: keep(dump.relay.deliveries), index: keep(dump.relay.index) },
    contents: Object.fromEntries(references.map(id => [id, dump.contents[id]])), contentReferences: references };
}
// ---- unknown-recovered: results nobody knows, and how a conversation goes on from them -------------------------------------------------
await scenario("unknown-recovered", "ur", "Turns that ended unknown (the connection was lost): the conversation blocks, then a recovery switch acknowledges them (S1); the same with inputs queued behind the lost Turn, one cancelled by the user on its own (S2); inputs queued before an ordinary switch (S3); a command whose outcome is unknown (S4); a conversation left blocked (S5); a closed conversation (S6); an input queued before a switch that the sources of the switch skip, lost before the switch could take effect (S7)", async w => {
  const h = w.harnesses;
  const a = await w.create("alpha");
  await w.send(a, "u1 before the loss");
  h.on("u2 connection lost", { result: "lost", events: [thinking("thinking before the loss. "), tool("U:1", "npm test", "in_progress", { kind: "execute", name: "Bash", input: "npm test" }), text("running the tests")] });
  await w.send(a, "u2 connection lost");
  await w.resume(a, "bravo");
  await w.send(a, "u3 after the recovery on bravo"); await w.send(a, "u4 once more");

  const b = await w.create("alpha");
  await w.send(b, "v1 before");
  h.on("v2 held", { result: "hold", events: [text("working")] });
  w.app.send(b, "v2 held", w.key("send")); await w.until(() => h.held.length === 1, "v2 held");
  w.app.send(b, "v3 queued behind v2", w.key("send")); const cancelled = w.app.send(b, "v4 queued then cancelled", w.key("send")).runId; w.cancel(b, cancelled);
  h.held.shift().lose(); await w.app.wait(b).catch(blocked);
  await w.resume(b, "bravo");
  await w.send(b, "v5 on bravo after the recovery");

  const c = await w.create("alpha");
  await w.send(c, "w1 before");
  h.on("w2 held", { result: "hold", events: [text("working")] });
  w.app.send(c, "w2 held", w.key("send")); await w.until(() => h.held.length === 1, "w2 held");
  w.app.send(c, "w3 queued before the switch", w.key("send")); const gone = w.app.send(c, "w4 queued then cancelled", w.key("send")).runId; w.cancel(c, gone);
  w.app.switch(c, { harnessId: "bravo" }, w.key("switch"));
  h.held.shift().release(); await w.app.wait(c);
  await w.send(c, "w5 on bravo");

  const d = await w.create("alpha");
  await w.send(d, "c1 before the command");
  h.on("/compact", { result: "lost" }, "alpha"); await w.send(d, "/compact");
  await w.resume(d, "charlie");
  await w.send(d, "c2 after the lost command");
  h.plans.delete("alpha\n/compact");

  const e = await w.create("alpha");
  await w.send(e, "b1 before the loss"); h.on("b2 lost for good", { result: "lost", events: [text("partial reply")] }); await w.send(e, "b2 lost for good");

  const f = await w.create("alpha");
  await w.send(f, "z1 then closed"); await w.app.closeSession(f, w.key("close"));

  // S7 (review I2): an input queued when a switch was asked for, which the switch's sources therefore skip (a later input, cancelled on its own, is among them),
  // runs before the switch takes effect and is lost: the switch fails with it, and a recovery switch acknowledges it later.
  const g = await w.create("alpha");
  await w.send(g, "i1 before");
  h.on("i2 held", { result: "hold", events: [text("working")] });
  w.app.send(g, "i2 held", w.key("send")); await w.until(() => h.held.length === 1, "i2 held");
  h.on("i3 queued before the switch, runs and is lost", { result: "lost", events: [text("a partial reply")] }, "alpha");
  w.app.send(g, "i3 queued before the switch, runs and is lost", w.key("send"));
  const dropped = w.app.send(g, "i4 queued then cancelled", w.key("send")).runId; w.cancel(g, dropped);
  w.app.switch(g, { harnessId: "bravo" }, w.key("switch"));
  h.held.shift().release(); await w.app.wait(g).catch(blocked);
  await w.resume(g, "bravo");
  await w.send(g, "i5 on bravo after the recovery");
  h.plans.delete("alpha\ni3 queued before the switch, runs and is lost");
  await w.app.close();
  const dump = dumpNow(w, "unknown-recovered", w.describe);
  return [dump, acknowledgedByList(dump)];
});

// ---- crashes: what an owner that dies leaves in the database --------------------------------------------------------------------------
/** Opens a data root made from `dump` with a store, which recovers what its owner left unfinished, and dumps it as it is then. */
async function afterRestart(w, dump, name, describe) {
  const root = await mkdtemp(join(tmpdir(), "storage-v13-restart-")), data = join(root, "data");
  try {
    writeV13Root(data, [{ ...dump, relay: dump.relay }]);
    let tick = 0; const now = () => new Date(BASE_TIME + 3_600_000 + 1000 * tick++);
    const store = new SqliteSessionStore(data, { now, recoverRelay });
    try { return dumpDatabase(join(data, "gateway.sqlite"), { workspace: w.workspace, contents: w.contents }, store, name, describe); } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const { writeV13Root } = await load("tests/fixtures/storage/v13/database.js");
await scenario("running-crash", "rc", "An owner died with a Turn running (it carries a handoff packet that nothing confirmed yet; thinking, a reply, a call still open), two inputs queued behind it (one cancelled on its own) and a switch asked for and not yet applied: the database as it was then; and the same after the next owner started and recovered it", async w => {
  const h = w.harnesses;
  const id = await w.create("alpha");
  await w.send(id, "r1 finished before the crash");
  await w.to(id, "bravo");
  h.on("r2 running when the owner died", { result: "hold", events: [thinking("Let me look at the tests. "), text("Looking at the tests. "),
    tool("R:1", "npm test", "in_progress", { kind: "execute", name: "Bash", input: "npm test" }), tool("R:2", "Read tests/a.test.ts", "completed", { kind: "read", name: "Read", input: JSON.stringify({ file_path: WORKSPACE + "/tests/a.test.ts" }) }),
    plan([{ content: "Run the tests", status: "in_progress" }]), notice("info", "Started"), activity("R-act", "subagent", "A helper", "running")] });
  w.app.send(id, "r2 running when the owner died", w.key("send")); await w.until(() => h.held.length === 1, "r2 held");
  w.app.send(id, "r3 queued behind r2", w.key("send"));
  const cancelled = w.app.send(id, "r4 queued then cancelled", w.key("send")).runId; w.cancel(id, cancelled);
  w.app.switch(id, { harnessId: "charlie" }, w.key("switch"));
  await wait(50);
  const crashed = dumpNow(w, "running-crash", w.describe);
  const recovered = await afterRestart(w, crashed, "recovered-after-crash", "running-crash after the next owner started: the Turn that ran is unknown (OWNER_ENDED), the queued input cancelled, the pending switch failed, the conversation blocked");
  h.held.shift().release();
  return [crashed, recovered];
});
await scenario("waiting-crash", "wc", "An owner died while Turns waited for the user: an approval pending in one conversation and a question in another (the database as it was, and after the next owner recovered it)", async w => {
  const h = w.harnesses;
  const a = await w.create("alpha");
  await w.send(a, "p1 before the approval");
  h.on("p2 asks before it runs", { result: "decision", events: [text("I need to run a command. "), tool("P:1", "rm -rf build", "pending", { kind: "execute", name: "Bash", input: "rm -rf build" }),
    { type: "permission_requested", id: "native-crash-1", title: "Run rm -rf build?", options: [{ id: "allow", name: "Allow once" }, { id: "deny", name: "Deny" }], expiresInMs: 600000, expiresBy: "turn" }] });
  w.app.send(a, "p2 asks before it runs", w.key("send"));
  // A second conversation, in a workspace of its own, so that both run at once.
  const second = { ...w.configuration, workspace: w.workspace + "-2" }; mkdirSync(second.workspace);
  const b = (await w.app.create(second, { harnessId: "bravo" }, w.key("create"))).id;
  await w.send(b, "q1 before the question");
  h.on("q2 asks which", { result: "decision", events: [text("A question. "), { type: "permission_requested", id: "native-crash-2", kind: "question", title: "Which branch?", options: [{ id: "main", name: "main" }, { id: "dev", name: "dev" }], expiresInMs: 600000, expiresBy: "turn" }] });
  w.app.send(b, "q2 asks which", w.key("send"));
  await w.until(() => w.app.attention().length === 2, "both waiting");
  const crashed = dumpNow(w, "waiting-crash", w.describe);
  const recovered = await afterRestart(w, crashed, "recovered-after-waiting-crash", "waiting-crash after the next owner started: both Turns unknown (OWNER_ENDED), no decision reached the Harness");
  await w.app.decidePermission(a, w.app.attention().find(item => item.sessionId === a).permissionId, "allow", w.key("decide"));
  await w.app.decidePermission(b, w.app.attention()[0].permissionId, "main", w.key("decide"));
  return [crashed, recovered];
});

// ---- the conversation of the 2026-11-11 trial: five Harnesses, eleven Turns, the real tool calls, titles, kinds, statuses and usage -------------
function trialEvents(entry) {
  const events = []; let tools = 0, thoughts = 0;
  for (const kind of entry.order) {
    if (kind === "thinking") events.push(thinking("Thinking " + ++thoughts + " of Turn " + entry.n + ". "));
    else if (kind === "tool") {
      const call = entry.tools[tools], id = "tool-" + entry.n + "-" + tools++;
      const detail = { ...(call.detail ?? {}), ...(call.kind === undefined ? {} : { kind: call.kind }), ...(call.name === undefined ? {} : { name: call.name }), ...(call.exitCode === undefined ? {} : { exitCode: call.exitCode }) };
      call.statuses.forEach((status, at) => events.push(tool(id, call.title, status, at === call.statuses.length - 1 && Object.keys(detail).length ? detail : undefined)));
    } else if (kind === "text") events.push(text("Reply to Turn " + entry.n + " by " + entry.harnessId + ". "));
  }
  events.push(usage(entry.usage));
  return events;
}
await scenario("trial-2026-11-11", "tr", "The conversation of the owner's trial of 2026-11-11 (tests/fixtures/protocol/trial-2026-11-11.json): five Harnesses, eleven Turns, with the tool calls, titles, kinds, statuses, stored details and usage the Drivers really reported, replayed through the real Runtime. The inputs and replies are made up (the recording kept none)", async w => {
  let id = null, current = null;
  for (const entry of trial.runs) {
    const model = entry.nativeModel ?? undefined, key = entry.harnessId + "\n" + (model ?? ""), extra = model === undefined ? {} : { nativeModel: model };
    if (id === null) id = await w.create(entry.harnessId, extra); else if (key !== current) await w.to(id, entry.harnessId, extra);
    current = key;
    const input = "Trial Turn " + entry.n + " on " + entry.harnessId;
    w.harnesses.on(input, { reason: entry.backend.reason, events: trialEvents(entry) });
    await w.send(id, input);
  }
});

// ---- conversations migrated from v12: the seven frozen v12 databases opened by this build ------------------------------------------------
for (const name of V12_FIXTURES) {
  const root = await mkdtemp(join(tmpdir(), "storage-v13-from-v12-")), data = join(root, "data");
  try {
    writeV12Root(data, [loadV12Fixture(name)]);
    let tick = 0; const now = () => new Date(BASE_TIME + 86_400_000 + 1000 * tick++);
    const store = new SqliteSessionStore(data, { now, recoverRelay });
    try {
      writeFixture(dumpDatabase(join(data, "gateway.sqlite"), { workspace: "/not/in/these/fixtures", contents: new Contents() }, store, "from-v12-" + name,
        "The frozen v12 database tests/fixtures/relay/v12/" + name + ".json (made by the real v12 build, G066) after this build opened it: migrated to v13, its Runs without relay facts and the index rows (relay_index) that say where they ran"));
    } finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ---- generations: one small conversation per business-database version before the relay tables (v1 to v11) --------------------------------------
// Shaped to the grammar of each version (state.ts parseSession names which fields a version may hold), not recorded: no old build wrote them. Version N
// holds what N introduced and nothing after: v3 an unknown Turn acknowledged by a recovery switch (by its sources, as every switch before v13), v4 native
// models and backend errors, v5 thinking and calls and permission commands, v6 native bindings, v7 plan/usage/notices/activities/outputs/attachments and the
// bounded detail of calls, v8 branches, v9 imports and observed configuration, v10 timing, v11 kept processes.
const generationsOut = resolve(out, "..", "generations");
mkdirSync(generationsOut, { recursive: true });
function generationSample(version) {
  const sid = "session-gen" + version, hex = text => sha256("gen" + version + text), iso = new Date(Date.UTC(2026, 0, version, 12, 0, 0)).toISOString();
  const ref = (n, kind, name, mediaType) => ({ id: "content-gen" + version + "x" + n, name, mediaType, kind, bytes: 10 + n, sha256: hex("ref" + n) });
  const configuration = { workspace: WORKSPACE, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const provider = { providerId: "provider-0a1b2c3d-0000-4000-8000-0000000000" + String(version).padStart(2, "0"), revision: 1, model: "gpt-x" };
  const alpha = { harnessId: "alpha", controlId: "alpha-acp", ...(version >= 4 ? { nativeModel: "model-a" } : {}), ...(version >= 5 ? { nativeOptions: { effort: "high" } } : {}) };
  const target = version >= 2 ? { harnessId: "alpha", controlId: "alpha-acp", provider } : { harnessId: "bravo", controlId: "bravo-acp" };
  const events = []; let seq = 0;
  const event = (type, data) => { events.push({ sessionId: sid, seq: ++seq, ownerGeneration: 1, timestamp: iso, type, data }); return seq; };
  const messages = [], runs = [], commands = [{ id: "gen" + version + "-create", kind: "create", fingerprint: hex("create"), resultId: sid }];
  event("session.created", { selection: alpha, continuity: "public_context_rehydrate" });
  const clock = n => version >= 10 ? { timing: { acceptedAt: 1_800_000_000_000 + n * 60_000, preparingAt: 1_800_000_000_000 + n * 60_000 + 1000, readyAt: 1_800_000_000_000 + n * 60_000 + 2000,
    dispatchedAt: 1_800_000_000_000 + n * 60_000 + 3000, firstOutputAt: 1_800_000_000_000 + n * 60_000 + 4000, endedAt: 1_800_000_000_000 + n * 60_000 + 5000 } } : {};
  const clean = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
  /** One Turn: its events, its messages, its Run (the fields of the version in `extra`). */
  const turn = (n, status, input, reply, sources, selection, epoch, extra, prepared = false) => {
    const runId = "run-gen" + version + "-" + n, userId = "message-gen" + version + "-u" + n, assistantId = "message-gen" + version + "-a" + n, commandId = "gen" + version + "-send-" + n;
    const userSeq = event("message.accepted", { runId, messageId: userId, role: "user", text: input });
    const context = event("run.preparing", { runId, selection, epoch });
    if (prepared) event("native.binding_prepared", { runId, harnessId: selection.harnessId, controlId: selection.controlId, resumed: false });
    let replySeq = null; if (reply !== null) replySeq = event("run.output", { runId, event: { type: "text", text: reply } });
    const failed = status === "failed", unknown = status === "unknown";
    if (!unknown) event("run.backend_settled", { runId, backend: { status: failed ? "failed" : "completed" } });
    event("run.ended", { runId, status });
    messages.push({ id: userId, runId, role: "user", text: input, seq: userSeq, status }); if (replySeq !== null) messages.push({ id: assistantId, runId, role: "assistant", text: reply, seq: replySeq, status });
    commands.push({ id: commandId, kind: "send", fingerprint: hex(commandId), resultId: runId });
    runs.push({ id: runId, commandId, input, userMessageId: userId, assistantMessageId: assistantId, selection, epoch, status, cancelRequested: false, contextThroughSeq: context, sourceRunIds: sources,
      backend: unknown ? null : { status: failed ? "failed" : "completed", reason: failed ? "model_error" : "end_turn", ...(failed && version >= 4 ? { error: { code: "NATIVE_RATE_LIMITED", message: "slow down" } } : {}) },
      cleanup: clean, error: failed ? { code: "NATIVE_RATE_LIMITED", message: "slow down" } : unknown ? { code: "CONTROL_FAILED", message: "the connection ended without a result" } : null, stopRequested: false, awaitingSwitchId: null, ...clock(n), ...extra });
    return runId;
  };
  const rich = version >= 7 ? {
    thinking: "Let me look.", tools: [{ id: "tool-1", title: "ls -la", status: "completed", kind: "execute", name: "Bash", exitCode: 0, detail: ref(1, "file", "tool-1.json", "application/json") },
      { id: "tool-2", title: "Read a.ts", status: "completed", kind: "read", name: "Read", parentId: "tool-1" }],
    plan: { entries: [{ content: "do it", status: "completed", priority: "high" }, { content: "check it", status: "pending" }], explanation: "two steps" },
    usage: { turn: { input: 100, output: 20, cachedInput: 50 }, context: { used: 120, size: 1000 }, cost: { amount: 0.01, currency: "USD", scope: "session" } },
    notices: [{ severity: "warning", title: "Slow", detail: "2 s" }], activities: [{ id: "act-1", kind: "subagent", title: "Helper", status: "completed", detail: "done" }],
    outputs: [{ kind: "link", uri: "https://example.com/a", name: "a", title: "A", mediaType: "text/html" }, { kind: "content", content: ref(2, "image", "shot.png", "image/png") }],
    attachments: [ref(3, "image", "pic.png", "image/png")],
  } : version >= 5 ? { thinking: "Let me look.", tools: [{ id: "tool-1", title: "ls -la", status: "completed" }, { id: "tool-2", title: "Read a.ts", status: "completed" }] } : {};
  const first = turn(1, "completed", "First question, in version " + version, "First answer.", [], alpha, 1, rich, version >= 6);
  if (version >= 5) commands.push({ id: "gen" + version + "-permission", kind: "permission", fingerprint: hex("permission"), resultId: first });
  const second = turn(2, "completed", "Second question", "Second answer.", [first], alpha, 1, version >= 11 ? { retained: true } : {});
  const keep = version >= 11 ? { retainNative: true, retained: { harnessId: "alpha", controlId: "alpha-acp", runId: second, since: 1_800_000_000_000, ...(version >= 12 ? { process: { group: 4242, startedAt: "Thu Jan 1 12:00:00 2026" } } : {}) } } : {};
  if (version >= 11) { runs[1] = { ...runs[1], cleanup: null }; commands.push({ id: "gen" + version + "-retention", kind: "retention", fingerprint: hex("retention"), resultId: sid }); }
  const third = version >= 3 ? turn(3, "unknown", "Third question, lost", "Half an answer", [first, second], alpha, 1, version >= 11 ? { reused: true } : {}) : null;
  const failedRun = turn(version >= 3 ? 4 : 3, "failed", "A question that fails", null, [], alpha, 1, {});
  const sources = [first, second, ...(third === null ? [] : [third]), failedRun];
  const requestedSeq = event("switch.requested", { switchId: "switch-gen" + version, requested: { harnessId: target.harnessId } });
  const switchId = "switch-gen" + version;
  commands.push({ id: "gen" + version + "-switch", kind: "switch", fingerprint: hex("switch"), resultId: switchId });
  event("switch.effective", { switchId });
  turn(version >= 3 ? 5 : 4, "completed", "After the switch", "Answer from the new target.", sources, target, 2, {});
  const binding = version >= 6 ? [{ harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-alpha-gen" + version, throughRunId: second, status: "ready", ...(version >= 9 ? { observed: { model: "model-a", options: { effort: "high" } } } : {}) }] : [];
  const main = { schemaVersion: version, id: sid, version: seq, lastSeq: seq, epoch: 2, status: "open", configuration, selection: target, activeRunId: null, pendingSwitchId: null, runs, messages,
    switches: [{ id: switchId, commandId: "gen" + version + "-switch", requested: { harnessId: target.harnessId }, requestedSeq, target, status: "effective", throughSeq: seq - 1, sourceRunIds: sources, error: null }],
    commands, ...(binding.length ? { nativeBindings: binding } : {}), ...keep };
  const sessions = [{ id: sid, version: seq, lastSeq: seq, snapshot: main, events }];
  const createKeys = [{ commandId: "gen" + version + "-create", sessionId: sid, fingerprint: hex("create") }];
  const other = (suffix, origin, continuity, bindingRow) => {
    const id = sid + "-" + suffix, create = "gen" + version + "-create-" + suffix, fingerprint = hex(create);
    const row = { schemaVersion: version, id, version: 1, lastSeq: 1, epoch: 1, status: "open", configuration, selection: alpha, activeRunId: null, pendingSwitchId: null, runs: [], messages: [], switches: [],
      commands: [{ id: create, kind: "create", fingerprint, resultId: id }], origin, nativeBindings: [bindingRow] };
    sessions.push({ id, version: 1, lastSeq: 1, snapshot: row, events: [{ sessionId: id, seq: 1, ownerGeneration: 1, timestamp: iso, type: "session.created", data: { selection: alpha, continuity } }] });
    createKeys.push({ commandId: create, sessionId: id, fingerprint });
  };
  if (version >= 8) other("branch", { kind: "fork", sessionId: sid, throughRunId: second, history: [{ role: "user", text: "First question, in version " + version, status: "completed", ...(version >= 7 ? { attachments: [ref(3, "image", "pic.png", "image/png")] } : {}) },
    { role: "assistant", text: "First answer.", status: "completed", harnessId: "alpha" }] }, "native_fork", { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-alpha-gen" + version, throughRunId: null, status: "fork-pending" });
  if (version >= 9) other("import", { kind: "import", harnessId: "alpha", title: "an imported conversation", omitted: 2, complete: true, historyRead: true, history: [{ role: "user", text: "an earlier question", status: "completed" }, { role: "assistant", text: "an earlier answer", status: "completed", harnessId: "alpha" }] },
    "native_import", { harnessId: "alpha", controlId: "alpha-acp", checkpoint: "native-imported-gen" + version, throughRunId: null, status: "ready", observed: { model: null, options: {} } });
  return { fixture: "v" + version, describe: "A synthetic Session v" + version + " database: " + sessions.length + " conversation(s) shaped to what v" + version + " could hold (see generate.mjs, generations)", userVersion: version, ownerGeneration: 1, sessions, createKeys };
}
for (const version of GENERATIONS) {
  const sample = generationSample(version);
  writeFileSync(join(generationsOut, "v" + version + ".json"), JSON.stringify(sample, null, 1) + "\n");
  written.push("generation v" + version + ": " + sample.sessions.map(row => row.id + " seq" + row.lastSeq + " runs" + row.snapshot.runs.length).join(", "));
}

// ---- foreign events: what a Harness may tell the Hub and the Hub of this build could not keep (task T5's input) -----------------------------
// Plain ControlEvents (JSON), each with what THIS build did with it when a Turn emitted them: `v13` is `accepted`, or the code and message of the failure that
// stopped the Runtime (D21 of the limits audit: a title over 4,096 bytes made the commit throw and the Runtime stop). The new storage must accept every case: it
// normalizes the text (NUL out, a lone surrogate replaced, an empty label given its placeholder, a number out of range left out), tells what it changed in the
// item's `native.clipped`, and never refuses or stops for it.
const nul = "\u0000", over4096 = "你".repeat(1366), pair = "😀";
const CASES = [
  ["a tool title over 4,096 bytes", [tool("T:1", over4096, "completed", { kind: "execute", name: "Bash" })]],
  ["a tool title with a NUL", [tool("T:2", "echo a" + nul + "b", "completed", { kind: "execute", name: "Bash" })]],
  ["a tool title with a NUL, a lone high surrogate, a lone low surrogate and a pair", [tool("T:3", "a\ud83d b\ude00 c" + pair + nul, "completed")]],
  ["an empty tool title", [tool("T:4", "", "completed", { kind: "execute", name: "Bash" })]],
  ["a tool title of spaces only", [tool("T:5", "   ", "completed")]],
  ["a tool id with a NUL", [tool("T:6" + nul + "x", "an id with a NUL", "completed")]],
  ["a tool id over 512 bytes", [tool("T:" + "i".repeat(600), "a long id", "completed")]],
  ["a tool status word over 128 bytes", [tool("T:7", "a long status", "s".repeat(200))]],
  ["a tool kind over 64 bytes and a tool name over 256 bytes", [tool("T:8", "long kind and name", "completed", { kind: "k".repeat(100), name: "n".repeat(300) })]],
  ["a tool parent id over 512 bytes", [tool("T:9", "long parent", "completed", { parentId: "p".repeat(600) })]],
  ["an exit code out of range", [tool("T:10", "big exit code", "completed", { kind: "execute", name: "Bash", exitCode: 2 ** 40 }), tool("T:11", "small exit code", "failed", { kind: "execute", name: "Bash", exitCode: -(2 ** 33) })]],
  ["a notice with a NUL, an empty title, a title over 1,024 bytes and a detail over 4,096", [notice("info", "a" + nul + "b"), notice("warning", ""), notice("info", "你".repeat(400)), notice("warning", "t", "详".repeat(1500))]],
  ["an activity with a NUL in its id, an id over 512 bytes and a title over 1,024 bytes", [activity("a" + nul, "task", "t", "completed"), activity("b".repeat(600), "task", "t", "completed"), activity("c", "review", "你".repeat(400), "completed")]],
  ["a plan step with a NUL, an empty step and a step over 4,096 bytes", [plan([{ content: "a" + nul, status: "pending" }, { content: "", status: "pending" }, { content: "你".repeat(1400), status: "pending" }])]],
  ["a plan of 80 steps", [plan(Array.from({ length: 80 }, (_, at) => ({ content: "step " + at, status: "pending" })))]],
  ["reply text with a NUL", [text("before" + nul + "after")]],
  ["thinking with a NUL, then a lone high surrogate at the end of one chunk and its low surrogate at the start of the next", [thinking("t" + nul + "x"), thinking("half \ud83d"), thinking("\ude00 other half")]],
  ["a lone low surrogate alone, and a reply of only a lone high surrogate", [thinking("\ude00"), text("\ud83d")]],
  ["a usage with negative, fractional, huge and out-of-range numbers", [usage({ turn: { input: -1, output: 1.5, cachedInput: 2 ** 60 }, context: { used: -5, size: 0 }, cost: { amount: -1, currency: "USD", scope: "turn" } })]],
  ["a usage with a cost of 1e12 and a 40-character currency", [usage({ cost: { amount: 1e12, currency: "C".repeat(40), scope: "session" } })]],
  ["a link with a newline in its URI, a script URI, a URI over 4,096 bytes and an empty name", [link("https://example.com/a\nb", "n"), link("javascript:alert(1)", "script"), link("https://example.com/" + "u".repeat(5000), "long"), link("https://example.com/ok", "")]],
  ["details with 40 locations of 3,000 characters each", [tool("T:12", "many locations", "completed", { kind: "read", name: "Read", locations: Array.from({ length: 40 }, (_, at) => "/p/" + at + "/" + "l".repeat(3000)) })]],
];
{
  const cases = [];
  for (const [name, events] of CASES) {
    const w = await open("fe", name);
    let outcome;
    try {
      const id = await w.create("alpha");
      w.harnesses.on("a foreign turn", { events });
      let thrown = null; try { await w.send(id, "a foreign turn"); } catch (error) { thrown = error; }
      const run = (() => { try { return w.store.get(id).runs[0]; } catch { return undefined; } })();
      outcome = thrown === null && run?.status === "completed" ? "accepted" : "refused: " + (thrown?.code ?? run?.error?.code ?? run?.status ?? "no Run") + (thrown?.message ?? run?.error?.message ? " (" + (thrown?.message ?? run?.error?.message) + ")" : "");
    } finally { await w.close(); }
    cases.push({ name, v13: outcome, events });
  }
  writeFileSync(join(out, "foreign-events.json"), JSON.stringify({ fixture: "foreign-events", describe: "ControlEvents the Drivers could send and this v13 build could not keep: for each, what this build did with them when a Turn emitted them (v13). The new storage normalizes and keeps them all (ADR-057 1.5). Not a database; for the placement of items (T5).", cases }, null, 1) + "\n");
  written.push("foreign-events: " + cases.length + " cases, " + cases.filter(item => item.v13 !== "accepted").length + " refused by v13");
}
for (const line of written) process.stdout.write(line + "\n");
