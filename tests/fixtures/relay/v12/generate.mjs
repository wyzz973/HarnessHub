// NOTE (the cut, ADR-057 step 2): this generator loads `src/infrastructure/session/sqlite-store.js`, the store of snapshots, which was removed when the runtime moved to rows. It runs only
// against a build from before the cut (26d4907 or earlier); on a later build it fails at that import. The files it wrote are the fixtures, frozen; the tests never run it.
// Generates the frozen Session v12 fixtures of G066 (ADR-055 §14.4): one business database per binding source, written by
// the real Session v12 runtime and SQLite store of the build given as the first argument, with the in-process fake Harness
// below, then dumped as JSON next to this file. See README.md for when and how to run it; the files it writes are the
// fixtures, and the tests never run this generator.
//
//   node tests/fixtures/relay/v12/generate.mjs <dist directory of a v12 build> <output directory>
//
// Everything is synthetic: fixed identities, a ticking clock, no Harness, no model, nothing read from a data directory.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const [distArgument, outArgument] = process.argv.slice(2);
if (!distArgument || !outArgument) throw new Error("usage: node generate.mjs <dist directory of a v12 build> <output directory>");
const dist = resolve(distArgument), out = resolve(outArgument);
const load = path => import(pathToFileURL(join(dist, path)).href);
const { SessionRuntime } = await load("src/contexts/session/application/runtime.js");
const { SqliteSessionStore } = await load("src/infrastructure/session/sqlite-store.js");
const { nativeConversationId } = await load("src/contracts/control.js");
const { SessionError } = await load("src/contracts/session.js");

const clean = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
/** The workspace every fixture names in place of its temporary one. */
const WORKSPACE = "/fixtures/g066/workspace";
const recorded = { status: "completed", reason: "fake", input: "recorded" };
/** A command's reply never proves its input entered the native history (ADR-055 §7.1), so the fake reports nothing of it. */
const answered = { status: "completed", reason: "fake" };
const COMMANDS = [{ name: "compact", description: "compact the native context", contextEffect: "compact" },
  { name: "clear", description: "clear the native context", contextEffect: "clear" }];

/**
 * Fake Harnesses alpha and bravo: every native session has its own identity (a new one per open without a checkpoint, the
 * same one when resumed), "/compact" and "/clear" are listed commands, and `ending(harnessId, text)` decides how a prompt
 * ends (completed and recorded, a command completed without input evidence, unless it says otherwise). A Harness without
 * `checkAttachments` refuses attachments before dispatch, which is how the "failed before dispatch" fixture fails.
 */
class FakeHarnesses {
  constructor(ending = (_harnessId, text) => text.startsWith("/") ? answered : recorded) { this.ending = ending; this.opened = 0; this.prompts = []; }
  async validate(request) {
    if (request.harnessId !== "alpha" && request.harnessId !== "bravo") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected, configuration) {
    const harnessId = selected.harnessId; let session = null;
    const control = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + harnessId + "-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session,
      fork: async checkpoint => checkpoint + "-branch-" + ++this.opened,
      models: async () => ({ models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: COMMANDS }),
      nativeConfig: async () => ({ model: "model-a", options: {} }),
      startText: async (_id, text, output) => {
        this.prompts.push({ harnessId, session, text });
        output({ type: "text", text: "reply from " + harnessId });
        return { result: Promise.resolve(this.ending(harnessId, text)), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
  async readNativeSession(_selection, _configuration, nativeId) {
    return { checkpoint: nativeId, title: "imported", history: [{ role: "user", text: "an earlier question" }, { role: "assistant", text: "an earlier answer" }], omitted: 0, complete: true, historyRead: true };
  }
}
/** A content store that admits one staged image and is never asked for its bytes (the Harness refuses it first). */
const content = {
  storeOutput: async () => { throw new Error("no outputs in fixtures"); },
  resolve: ids => ids.map(id => ({ id, name: "photo.png", mediaType: "image/png", kind: "image", bytes: 8, sha256: "0".repeat(64) })),
  materialize: async () => { throw new Error("attachments are refused before they are copied"); },
};

/** Runs one fixture in a fresh temporary data root and returns its business database as plain JSON. */
async function fixture(name, describe, script, ending) {
  const root = await mkdtemp(join(tmpdir(), "g066-v12-fixture-")), workspace = join(root, "workspace"), data = join(root, "data");
  await mkdir(workspace);
  let tick = 0, ids = 0;
  const now = () => new Date(Date.UTC(2026, 10, 9, 0, 0, 0) + 1000 * tick++);
  const store = new SqliteSessionStore(data, { now });
  const fake = new FakeHarnesses(ending);
  const app = new SessionRuntime(store, fake, { id: () => String(++ids), now, publish: () => {}, content,
    // A command's fingerprint covers the conversation's configuration; it is taken as if the workspace were the fixed one.
    fingerprint: value => createHash("sha256").update(value.split(JSON.stringify(workspace).slice(1, -1)).join(WORKSPACE)).digest("hex") });
  const configuration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  try {
    const send = async (id, text, key, attachments = []) => { const receipt = app.send(id, text, key, attachments); await app.wait(id); return receipt.runId; };
    const to = async (id, harnessId, key) => { app.switch(id, { harnessId }, key); await app.wait(id); };
    await script({ app, configuration, send, to });
  } finally { await app.close(); store.close(); }
  const database = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
  try {
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    if (userVersion !== 12) throw new Error("the build given is not a Session v12 build (user_version " + userVersion + ")");
    const owner = database.prepare("SELECT owner_generation FROM owner_metadata WHERE singleton=1").get();
    const sessions = database.prepare("SELECT id,version,last_seq,snapshot FROM sessions ORDER BY rowid").all().map(row => ({
      id: row.id, version: row.version, lastSeq: row.last_seq, snapshot: JSON.parse(row.snapshot),
      events: database.prepare("SELECT event_json FROM events WHERE session_id=? ORDER BY seq").all(row.id).map(event => JSON.parse(event.event_json)),
    }));
    const createKeys = database.prepare("SELECT command_id,session_id,fingerprint FROM create_keys ORDER BY rowid").all().map(row => ({ commandId: row.command_id, sessionId: row.session_id, fingerprint: row.fingerprint }));
    const dump = { fixture: name, describe, generator: "tests/fixtures/relay/v12/generate.mjs", userVersion, ownerGeneration: owner.owner_generation, sessions, createKeys };
    // The temporary workspace is named at random; the fixture names a fixed one so that the same build writes the same file.
    return JSON.parse(JSON.stringify(dump).split(JSON.stringify(workspace).slice(1, -1)).join(WORKSPACE));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

const rejected = { status: "failed", reason: "request_rejected", error: { code: "REMOTE_ERROR", message: "refused before insertion" }, input: "not_recorded" };
/** alpha takes two Turns, bravo two (the first carrying alpha's), and the conversation goes back to alpha. */
async function aroundBravo({ app, configuration, send, to }) {
  const session = await app.create(configuration, { harnessId: "alpha" }, "create");
  await send(session.id, "a1 on alpha", "a1"); await send(session.id, "a2 on alpha", "a2");
  await to(session.id, "bravo", "to-bravo");
  await send(session.id, "b1 on bravo", "b1"); await send(session.id, "b2 on bravo", "b2");
  await to(session.id, "alpha", "to-alpha");
  return session.id;
}
const fixtures = [
  ["d1", "A→B→A, and the first input back on alpha is a native command (/compact): alpha owes bravo's two Turns (D1 shape)",
    async world => { const id = await aroundBravo(world); await world.send(id, "/compact", "a3"); }],
  ["dispatch-failed", "A→B→A, and the first input back on alpha carries bravo's Turns but fails before dispatch (its attachment is refused)",
    async world => { const id = await aroundBravo(world); await world.send(id, "a3 with an attachment", "a3", ["content-photo"]); }],
  ["insert-rejected", "A→B→A, and the first input back on alpha carries bravo's Turns but alpha refuses it before inserting it (request_rejected)",
    async world => { const id = await aroundBravo(world); await world.send(id, "a3 refused", "a3"); },
    (_harness, text) => text.endsWith("a3 refused") ? rejected : text.startsWith("/") ? answered : recorded],
  ["import", "A native session of alpha continued in the Hub (ADR-029), then two Turns on it",
    async ({ app, configuration, send }) => {
      const session = await app.importNative(configuration, { harnessId: "alpha" }, "native-alpha-imported", "import");
      await send(session.id, "a1 after the import", "a1"); await send(session.id, "a2 after the import", "a2");
    }],
  ["branch", "A conversation of two Turns on alpha branched after its second Turn with a native fork (ADR-025), then one Turn on the branch",
    async ({ app, configuration, send }) => {
      const source = await app.create(configuration, { harnessId: "alpha" }, "create");
      await send(source.id, "a1 on alpha", "a1"); const through = await send(source.id, "a2 on alpha", "a2");
      const branch = app.fork(source.id, "branch", through); await app.wait(branch.id);
      await send(branch.id, "c1 on the branch", "c1");
    }],
  ["clear", "One Harness: two Turns, a /clear the Harness ran, then one more Turn",
    async ({ app, configuration, send }) => {
      const session = await app.create(configuration, { harnessId: "alpha" }, "create");
      await send(session.id, "a1 on alpha", "a1"); await send(session.id, "a2 on alpha", "a2");
      await send(session.id, "/clear", "a3"); await send(session.id, "a4 after the clear", "a4");
    }],
  ["reset-d1", "One Harness: three Turns, a native reset (new native session), then a native command (/compact) as the new session's first input",
    async ({ app, configuration, send }) => {
      const session = await app.create(configuration, { harnessId: "alpha" }, "create");
      await send(session.id, "a1 on alpha", "a1"); await send(session.id, "a2 on alpha", "a2"); await send(session.id, "a3 on alpha", "a3");
      app.resetNative(session.id, "reset", app.read(session.id).epoch);
      await send(session.id, "/compact", "a4");
    }],
];
await mkdir(out, { recursive: true });
for (const [name, describe, script, ending] of fixtures) {
  const dump = await fixture(name, describe, script, ending);
  await writeFile(join(out, name + ".json"), JSON.stringify(dump, null, 1) + "\n");
  process.stdout.write(name + ": " + dump.sessions.map(row => row.id + " v" + row.version + " seq" + row.lastSeq).join(", ") + "\n");
}
