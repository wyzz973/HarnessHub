import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { migrateSession as liveMigrate, type MigrationEvent } from "../../src/contexts/session/domain/relay/migrate.js";
import { parseSession as liveParse } from "../../src/contexts/session/domain/state.js";
import { RELAY_MAX_RUNS as LIVE_MAX_RUNS, RELAY_MAX_SEQ as LIVE_MAX_SEQ } from "../../src/contracts/relay.js";
import { migrateSession as legacyMigrate } from "../../src/infrastructure/session/legacy/migrate.js";
import { RELAY_MAX_RUNS, RELAY_MAX_SEQ, parseBindingRelayState, parseRunRelay, parseSourceRange } from "../../src/infrastructure/session/legacy/relay-contract.js";
import { parseSession as legacyParse } from "../../src/infrastructure/session/legacy/state.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { V12_FIXTURES, loadV12Fixture, writeV12Root } from "../fixtures/relay/v12/database.js";

// The frozen copy of the whole-snapshot parse (src/infrastructure/session/legacy/, ADR-057 3.6): taken from the live code with its bounds
// as they were, so that a v13 database is read the same way whatever the live code becomes. Held here to the live code on the repository's own
// fixtures (the seven frozen v12 databases, and what the live store makes of them: v13), to its old bounds, and to its own imports.

function temporary(t: TestContext): string { const root = mkdtempSync(join(tmpdir(), "harness-legacy-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
/** The same value parsed by both, or the same failure. */
function bothParse(value: unknown): SessionSnapshot {
  const legacy = attempt(() => legacyParse(value)), live = attempt(() => liveParse(value));
  assert.deepEqual(legacy, live);
  if (legacy instanceof Error) throw legacy;
  return legacy;
}
function attempt<T>(run: () => T): T | { readonly code: string; readonly message: string } & Error {
  try { return run(); } catch (error) { assert.ok(error instanceof SessionError); return Object.assign(new Error(error.message), { code: error.code }) as never; }
}
const MIGRATION_EVENT_TYPES = ["session.created", "session.recovered", "message.accepted", "run.context_prepared", "run.native_command", "run.ended", "native.binding_prepared", "native.branch_requested", "native.fork_failed"];

test("the frozen parse reads every snapshot of the seven v12 fixtures as the live parse does", () => {
  let snapshots = 0;
  for (const name of V12_FIXTURES) for (const session of loadV12Fixture(name).sessions) {
    const parsed = bothParse(session.snapshot);
    assert.equal(parsed.schemaVersion, 12); assert.equal(parsed.id, session.id);
    snapshots++;
  }
  assert.ok(snapshots >= 8);
});

test("the frozen parse reads every snapshot the live store makes of them (v13) as the live parse does, and the frozen v12 to v13 inference gives what the live one gives", t => {
  const root = temporary(t);
  const fixtures = V12_FIXTURES.map(name => loadV12Fixture(name));
  // Each fixture is its own data root (the fixtures share identities), opened by the live store to migrate it; then read straight from the database.
  let converted = 0;
  for (const [index, fixture] of fixtures.entries()) {
    const data = join(root, "root-" + index);
    writeV12Root(data, [fixture]);
    // The v12 side: the frozen inference and the live one over the same snapshot and events.
    for (const session of fixture.sessions) {
      const events: MigrationEvent[] = session.events.filter(event => MIGRATION_EVENT_TYPES.includes(event.type)).map(event => ({ seq: event.seq, type: event.type, data: event.data }));
      const state12 = liveParse(session.snapshot);
      assert.deepEqual(legacyMigrate(legacyParse(session.snapshot), events), liveMigrate(state12, events));
    }
    new SqliteSessionStore(data, { now: () => new Date("2026-11-09T12:00:00Z") }).close();
    const database = new DatabaseSync(join(data, "gateway.sqlite"), { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 13);
      for (const row of database.prepare("SELECT id, snapshot FROM sessions ORDER BY rowid").all()) {
        const parsed = bothParse(JSON.parse(String(row.snapshot)));
        assert.equal(parsed.schemaVersion, 13);
        converted++;
      }
    } finally { database.close(); }
  }
  assert.ok(converted >= 8);
});

test("the two parses refuse the same malformed snapshots in the same words", () => {
  const good = loadV12Fixture("d1").sessions[0]!.snapshot as Record<string, unknown> & { runs: Record<string, unknown>[]; messages: Record<string, unknown>[] };
  const copy = (): typeof good => JSON.parse(JSON.stringify(good)) as typeof good;
  const broken: Record<string, (value: typeof good) => unknown> = {
    "unknown field": value => ({ ...value, surprise: 1 }),
    "unknown status": value => ({ ...value, status: "weird" }),
    "a Run without its user message": value => ({ ...value, messages: value.messages.slice(1) }),
    "a Run with an unknown field": value => ({ ...value, runs: [{ ...value.runs[0], extra: true }, ...value.runs.slice(1)] }),
    "an epoch that does not match the switches": value => ({ ...value, epoch: 9 }),
    "a message text that is not text": value => ({ ...value, messages: [{ ...value.messages[0], text: 5 }, ...value.messages.slice(1)] }),
    "a NUL in an input": value => ({ ...value, runs: [{ ...value.runs[0], input: "a\0b" }, ...value.runs.slice(1)] }),
    "a schema version from the future": value => ({ ...value, schemaVersion: 14 }),
  };
  for (const [name, change] of Object.entries(broken)) {
    const mutated = change(copy());
    const legacy = attempt(() => legacyParse(mutated)), live = attempt(() => liveParse(mutated));
    assert.ok(legacy instanceof Error, name + " is refused by the frozen parse");
    assert.deepEqual(legacy, live, name);
  }
});

test("the frozen parsers keep v13's bounds: 16384 events and 256 Runs, whatever the live contract becomes", () => {
  assert.equal(RELAY_MAX_SEQ, 16_384); assert.equal(RELAY_MAX_RUNS, 256);
  const state = (mark: number) => ({ epoch: 1, mark, floor: -1, pending: null, resendAll: false });
  assert.deepEqual(parseBindingRelayState(state(RELAY_MAX_SEQ)), state(RELAY_MAX_SEQ));
  assert.throws(() => parseBindingRelayState(state(RELAY_MAX_SEQ + 1)), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  assert.deepEqual(parseSourceRange({ fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS - 1 }), { fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS - 1 });
  assert.throws(() => parseSourceRange({ fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS }), /source range|range throughRun/u);
  assert.throws(() => parseRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume_delta", tier: "full", runs: RELAY_MAX_RUNS + 1 }, executedOn: null }), /continuity runs/u);
  // The live contract is today the same; T7 (the bounds opened to the safe integers) is the change that makes this comparison the reason the copy exists.
  void LIVE_MAX_SEQ; void LIVE_MAX_RUNS;
});

test("nothing in the frozen folder reads a live parser: the values it imports are its own files and the contract's identities", () => {
  // The compiled files: a type-only import is gone from them, so every import that is left is a value one.
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/infrastructure/session/legacy");
  // The values the folder may take from outside: the identity constructors and native options of the Session contract, the Provider target parser.
  const allowed = new Set(["../../../contracts/session.js", "../../../contracts/provider.js"]);
  const files = readdirSync(folder).filter(name => name.endsWith(".js"));
  assert.ok(files.length >= 5);
  let imports = 0;
  for (const name of files) {
    for (const match of readFileSync(join(folder, name), "utf8").matchAll(/^import\s+[^;]*?\s+from\s+"([^"]+)";/gmu)) {
      imports++;
      assert.ok(match[1]!.startsWith("./") || allowed.has(match[1]!), name + " imports values from " + match[1]);
    }
  }
  assert.ok(imports >= 6);
});
