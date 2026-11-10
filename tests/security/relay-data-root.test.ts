import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nativeConversationId, type BackendResult, type HarnessControl } from "../../src/contracts/control.js";
import { EPHEMERAL_KEY_ID, RelayError, parseVendorKey, type RelayCapabilities, type VendorKey } from "../../src/contracts/relay.js";
import { SessionError, sessionId, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration } from "../../src/contracts/session.js";
import { dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { sharedClassify } from "../../src/adapters/control/relay-classify.js";
import { measureBy } from "../../src/adapters/control/relay-turn.js";
import { openRelayKeys, relayIsolation } from "../../src/cli/session-application.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { recoverRelay } from "../../src/contexts/session/domain/relay/recover.js";
import { RelayKeys, defaultRelayKeyPath, insideByIdentity } from "../../src/infrastructure/session/relay-keys.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";

// G072-S01 (ADR-055 §10.1, INV-36, D5; relay-architecture §17): the data directory, the relay key and the workspace must not
// contain one another, compared by device and inode, for a cross-vendor handoff; each way of spelling one directory — its own
// path, a symbolic link into it, another letter case on a case-insensitive volume, the firmlink of the Data volume — and a copy of
// a data directory's marker left in the workspace are found; a same-vendor handoff and a single-Harness conversation go on. The
// installation's relay key is created O_EXCL with mode 0600 and answers each finding of §10.2's "异常语义". Real files on
// temporary directories; the Runtime with a real SqliteSessionStore and in-process fake Harnesses.

function temporary(t: TestContext): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "g072-root-"))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
/** A data directory as the Store makes one (its ownership marker inside), at `path`. */
function dataAt(path: string): string { mkdirSync(path, { recursive: true }); new SqliteSessionStore(path).close(); return path; }

test("G072-S01 the data directory in a workspace, by every spelling: its own path, a symbolic link in the workspace, another letter case (case-insensitive APFS), the Data volume's firmlink; and a workspace in the data directory", t => {
  const root = temporary(t), workspace = join(root, "workspace"), outside = dataAt(join(root, "outside-data"));
  mkdirSync(workspace);
  assert.equal(relayIsolation(outside, null)(workspace), true, "a data directory beside the workspace");
  const inside = dataAt(join(workspace, "data"));
  assert.equal(relayIsolation(inside, null)(workspace), false, "its own path");
  rmSync(inside, { recursive: true, force: true });
  // A link in the workspace that leads to a data directory elsewhere: the Harness reaches it through the link.
  const linkedRoot = temporary(t), linked = dataAt(join(linkedRoot, "data")), link = join(workspace, "data-link");
  symlinkSync(linked, link);
  assert.equal(relayIsolation(link, null)(workspace), false, "spelled through a link in the workspace");
  rmSync(link);
  // Another letter case: on a case-insensitive volume (APFS's default) the same directory, found by device and inode; on a
  // case-sensitive one the other spelling names nothing, and what cannot be read is not isolated either.
  const cased = dataAt(join(workspace, "Data"));
  assert.equal(relayIsolation(join(workspace, "DATA"), null)(workspace), false, "the data directory spelled in another case");
  const upper = join(root.toUpperCase(), "workspace");
  if (existsSync(upper) && statSync(upper).ino === statSync(workspace).ino) assert.equal(relayIsolation(cased, null)(upper), false, "the workspace spelled in upper case");
  rmSync(cased, { recursive: true, force: true });
  // The firmlink of the Data volume names the same directories on macOS.
  const firmlink = "/System/Volumes/Data" + workspace;
  if (existsSync(firmlink)) {
    const again = dataAt(join(workspace, "data"));
    assert.equal(relayIsolation("/System/Volumes/Data" + again, null)(workspace), false, "the data directory by its firmlink");
    assert.equal(relayIsolation(again, null)(firmlink), false, "the workspace by its firmlink");
    rmSync(again, { recursive: true, force: true });
  }
  // A workspace inside the data directory.
  const holding = dataAt(join(root, "holding")), nested = join(holding, "work"); mkdirSync(nested);
  assert.equal(relayIsolation(holding, null)(nested), false, "the workspace in the data directory");
  // What cannot be read is not isolated.
  assert.equal(relayIsolation(outside, null)(join(root, "missing")), false);
});

test("G072-S01 a copy of a data directory's marker left in the workspace is found (the bounded search, at the first check and when the workspace changes); the relay key in or beside the workspace is too", t => {
  const root = temporary(t), workspace = join(root, "workspace"), data = dataAt(join(root, "data"));
  mkdirSync(join(workspace, "old", "copy"), { recursive: true });
  const isolated = relayIsolation(data, null);
  assert.equal(isolated(workspace), true);
  // A copied data directory deep in the workspace: found when the workspace's own directory changes (a new top-level entry).
  writeFileSync(join(workspace, "old", "copy", ".harness-gateway.json"), readFileSync(join(data, ".harness-gateway.json")));
  writeFileSync(join(workspace, "touched"), "x");
  const later = statSync(workspace).mtime; utimesSync(workspace, later, new Date(later.getTime() + 5000));
  assert.equal(isolated(workspace), false, "a marker copy");
  assert.equal(relayIsolation(data, null)(workspace), false, "found at a first check too");
  // The relay key in the workspace, or the workspace in the key's directory.
  const other = join(root, "other"); mkdirSync(join(other, "keys"), { recursive: true });
  assert.equal(relayIsolation(data, join(other, "keys", "relay-key"))(other), false, "the key in the workspace");
  assert.equal(relayIsolation(data, join(root, "relay-key"))(join(root, "work-beside")) , false, "a workspace that cannot be read");
  mkdirSync(join(root, "work-beside"));
  assert.equal(relayIsolation(data, join(root, "keys2", "relay-key"))(join(root, "work-beside")), true, "the key beside, not in it");
  assert.equal(insideByIdentity(join(other, "keys", "relay-key"), other), true); assert.equal(insideByIdentity(join(root, "work-beside"), other), false);
});

const DECLARED: RelayCapabilities = { ...dshRelayCapabilities, probed: true, execution: "process",
  delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: false },
  commands: { ...dshRelayCapabilities.commands, unlistedSlash: "executed", classify: sharedClassify },
  placement: { parts: "single", maxInput: null, pointersAfterUser: true, measure: measureBy("single", "chars", ["file"]) },
  resolveVendor: observed => parseVendorKey(observed.authKind ?? "unknown:fake") };
class Fakes implements SessionBindingFactory {
  readonly vendors: Record<string, string>;
  carried = 0;
  private opened = 0;
  constructor(vendors: Record<string, string>) { this.vendors = vendors; }
  relayCapabilities(): RelayCapabilities { return DECLARED; }
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (!(request.harnessId in this.vendors)) throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    let session: string | null = null;
    const control: HarnessControl = { relayCapabilities: DECLARED,
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async (_cwd, _model, _options, checkpoint) => { session = checkpoint ?? "native-" + ++this.opened; return nativeConversationId(session); },
      checkpoint: async () => session, healthy: () => true,
      relayVendor: async () => ({ model: null, modelKey: "", authKind: this.vendors[selected.harnessId]!, endpoint: null, loopback: false }),
      startText: async (_id, turn, output) => {
        if (typeof turn !== "string") this.carried += 1;
        output({ type: "text", text: "ok" });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => ({ closed: true, exitCode: 0, signal: null, protocolFailure: null }) };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}

test("G072-S01 through the Runtime with the composition's check: a cross-vendor handoff into a workspace holding the data directory is refused synchronously (RELAY_UNAVAILABLE{data_root_in_workspace}), no Run; a same-vendor handoff, an input sent alone and a single-Harness conversation go", async t => {
  // The owner is closed before its data root is removed (after hooks run in the order they were registered).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "g072-root-"))), workspace = join(root, "workspace"); mkdirSync(workspace);
  const data = join(workspace, "data"), store = new SqliteSessionStore(data, { recoverRelay }), fakes = new Fakes({ alpha: "anthropic", bravo: "openai", delta: "anthropic" });
  let next = 0;
  const app = new SessionRuntime(store, fakes, { id: () => "s01-" + ++next, now: () => new Date(Date.UTC(2026, 10, 10, 12)), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
    relayIsolated: relayIsolation(data, null) });
  t.after(async () => { try { await app.close(); store.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const id = (await app.create(configuration, { harnessId: "alpha" }, "create")).id;
  for (const key of ["a1", "a2"]) { app.send(id, key + " on alpha alone", key); await app.wait(id); }
  assert.deepEqual(app.read(id).runs.map(run => run.status), ["completed", "completed"], "a single-Harness conversation goes");
  for (const vendor of ["unknown:bravo", "unknown:delta", "openai", "anthropic"])
    store.appendRelayLog({ commandId: "grant-" + vendor.replace(":", "-"), vendor: vendor as VendorKey, scope: { kind: "session", sessionId: id }, decision: "acknowledged", categories: ["user_text"], policyVersion: "relay/1", authKind: null, decidedAt: 1 });
  // The same vendor (delta runs anthropic, as alpha does): the data directory does not matter, the history goes.
  app.switch(id, { harnessId: "delta" }, "to-d"); await app.wait(id);
  app.send(id, "d0 alone, delta's vendor is learnt", "d0", [], { attach: "none" }); await app.wait(id);
  app.send(id, "d1 carries alpha's turns", "d1"); await app.wait(id);
  assert.equal(app.read(id).runs.at(-1)!.status, "completed"); assert.equal(fakes.carried, 1, "a same-vendor handoff goes");
  // Another vendor: refused synchronously, no Run.
  app.switch(id, { harnessId: "bravo" }, "to-b"); await app.wait(id);
  const runs = app.read(id).runs.length;
  assert.throws(() => app.send(id, "b1 would carry the turns to another vendor", "b1"), (error: unknown) => error instanceof RelayError && error.code === "RELAY_UNAVAILABLE" && error.reason === "data_root_in_workspace");
  assert.equal(app.read(id).runs.length, runs, "no Run");
  app.send(id, "b1 alone", "b1-alone", [], { attach: "none" }); await app.wait(id);
  assert.equal(app.read(id).runs.at(-1)!.status, "completed", "an input sent alone goes");
  assert.equal(fakes.carried, 1, "nothing more of the history left");
});

test("G072 relay-keys (D5, §10.2 \"异常语义\"): created O_EXCL with mode 0600 and 32 bytes; reopened the same; a wrong mode set back; a link at its path replaced, never followed; a wrong length refused; never exported, never the reserved identity", t => {
  const root = temporary(t), path = join(root, "Application Support", "HarnessHub", "relay-key");
  const created = RelayKeys.open(path);
  assert.deepEqual(created.notes, ["created"]);
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(path).size, 32);
  assert.notEqual(created.keys.keyId, EPHEMERAL_KEY_ID); assert.match(created.keys.keyId, /^k[0-9a-f]{23}$/u);
  const raw = readFileSync(path);
  for (const shown of [JSON.stringify(created.keys), String(Object.keys(created.keys)), JSON.stringify(Object.getOwnPropertyNames(created.keys).map(name => (created.keys as unknown as Record<string, unknown>)[name]))])
    assert.equal(shown.includes(raw.toString("hex")), false, "the key is never exported");
  const again = RelayKeys.open(path);
  assert.deepEqual(again.notes, []); assert.equal(again.keys.keyId, created.keys.keyId);
  const session = sessionId("session-a");
  assert.equal(again.keys.inputHmac(session, "words"), created.keys.inputHmac(session, "words"), "the same key, the same digests");
  assert.notEqual(created.keys.inputHmac(session, "words"), created.keys.inputHmac(sessionId("session-b"), "words"), "a subkey per Session");
  assert.equal(created.keys.setTag(session, ["b", "a", "a"]), created.keys.setTag(session, ["a", "b"]), "a set, whatever its order");
  // A wrong mode (chmod -R 755): set back to 0600 and reported.
  chmodSync(path, 0o644);
  assert.deepEqual(RelayKeys.open(path).notes, ["mode_repaired"]); assert.equal(statSync(path).mode & 0o777, 0o600);
  // A link at the key's path: replaced by a new key, the link's target untouched.
  const target = join(root, "elsewhere"); writeFileSync(target, "not a key, not to be read");
  const linked = join(root, "linked", "relay-key"); mkdirSync(join(root, "linked")); symlinkSync(target, linked);
  const rotated = RelayKeys.open(linked);
  assert.deepEqual(rotated.notes, ["rotated_not_regular"]); assert.equal(readFileSync(target, "utf8"), "not a key, not to be read");
  assert.equal(statSync(linked).size, 32); assert.notEqual(rotated.keys.keyId, created.keys.keyId);
  // A wrong length: refused, never overwritten; every digest asked of it fails the relay part only.
  const short = join(root, "short", "relay-key"); mkdirSync(join(root, "short")); writeFileSync(short, Buffer.alloc(16, 1), { mode: 0o600 });
  const refused = RelayKeys.open(short);
  assert.deepEqual(refused.notes, ["refused_length"]); assert.equal(statSync(short).size, 16, "not overwritten");
  assert.throws(() => refused.keys.inputHmac(session, "words"), (error: unknown) => error instanceof RelayError && error.code === "RELAY_PREPARE_FAILED" && error.reason === "redaction_failed");
  // The composition refuses a key inside the data directory, and the default lies outside it, beside HarnessHub's own data.
  const data = dataAt(join(root, "data"));
  assert.equal(openRelayKeys(join(data, "relay-key"), data), null);
  assert.equal(existsSync(join(data, "relay-key")), false, "no key file written there");
  assert.equal(defaultRelayKeyPath("/Users/someone"), "/Users/someone/Library/Application Support/HarnessHub/relay-key");
});
