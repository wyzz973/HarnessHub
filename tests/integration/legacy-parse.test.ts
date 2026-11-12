import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SessionError, type SessionSnapshot } from "../../src/contracts/session.js";
import { migrateSession as legacyMigrate, type MigrationEvent } from "../../src/infrastructure/session/legacy/migrate.js";
import { RELAY_MAX_RUNS, RELAY_MAX_SEQ, parseBindingRelayState, parseRunRelay, parseSourceRange } from "../../src/infrastructure/session/legacy/relay-contract.js";
import { parseSession as legacyParse } from "../../src/infrastructure/session/legacy/state.js";
import { V12_FIXTURES, loadV12Fixture } from "../fixtures/relay/v12/database.js";
import { loadV13Fixture, type V13FixtureName } from "../fixtures/storage/v13/database.js";

// The frozen copy of the whole-snapshot parse (src/infrastructure/session/legacy/, ADR-057 3.6): taken from the code that read a v13 database with its bounds as they were,
// and the only one there is since the cut: the migration climbs the old ladder with it, and the read-only tools read an unconverted conversation with it. Held here to the
// repository's own fixtures (the seven frozen v12 databases and what this build made of them: the v13 fixtures `from-v12-*`), to its old bounds, and to its own imports.

function temporary(t: TestContext): string { const root = mkdtempSync(join(tmpdir(), "harness-legacy-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function attempt<T>(run: () => T): T | { readonly code: string; readonly message: string } & Error {
  try { return run(); } catch (error) { assert.ok(error instanceof SessionError); return Object.assign(new Error(error.message), { code: error.code }) as never; }
}
const MIGRATION_EVENT_TYPES = ["session.created", "session.recovered", "message.accepted", "run.context_prepared", "run.native_command", "run.ended", "native.binding_prepared", "native.branch_requested", "native.fork_failed"];

test("the frozen parse reads every snapshot of the seven v12 fixtures", () => {
  let snapshots = 0;
  for (const name of V12_FIXTURES) for (const session of loadV12Fixture(name).sessions) {
    const parsed = legacyParse(session.snapshot);
    assert.equal(parsed.schemaVersion, 12); assert.equal(parsed.id, session.id);
    snapshots++;
  }
  assert.ok(snapshots >= 8);
});

test("the frozen v12 to v13 inference gives each fixture the relay state its v13 fixture holds, and the frozen parse reads the v13 snapshots", () => {
  let migrated = 0;
  for (const name of V12_FIXTURES) {
    const v12 = loadV12Fixture(name), v13 = loadV13Fixture(("from-v12-" + name) as V13FixtureName);
    for (const session of v12.sessions) {
      const events: MigrationEvent[] = session.events.filter(event => MIGRATION_EVENT_TYPES.includes(event.type)).map(event => ({ seq: event.seq, type: event.type, data: event.data }));
      const inferred = legacyMigrate(legacyParse(session.snapshot), events), expected = legacyParse(v13.sessions.find(row => row.id === session.id)!.snapshot);
      assert.equal(expected.schemaVersion, 13);
      assert.deepEqual(inferred.bindings, (expected.nativeBindings ?? []).map(binding => binding.relay), name + " " + session.id);
      migrated++;
    }
  }
  assert.ok(migrated >= 8);
});

test("the frozen parse refuses malformed snapshots, each in words of its own", () => {
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
  for (const [name, change] of Object.entries(broken)) assert.ok(attempt(() => legacyParse(change(copy()))) instanceof Error, name + " is refused by the frozen parse");
});

test("the frozen parsers keep v13's bounds: 16384 events and 256 Runs, whatever the live contract becomes", () => {
  assert.equal(RELAY_MAX_SEQ, 16_384); assert.equal(RELAY_MAX_RUNS, 256);
  const state = (mark: number) => ({ epoch: 1, mark, floor: -1, pending: null, resendAll: false });
  assert.deepEqual(parseBindingRelayState(state(RELAY_MAX_SEQ)), state(RELAY_MAX_SEQ));
  assert.throws(() => parseBindingRelayState(state(RELAY_MAX_SEQ + 1)), (error: unknown) => error instanceof SessionError && error.code === "INVALID_DATA");
  assert.deepEqual(parseSourceRange({ fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS - 1 }), { fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS - 1 });
  assert.throws(() => parseSourceRange({ fromSeq: 1, throughSeq: 2, fromRun: 0, throughRun: RELAY_MAX_RUNS }), /source range|range throughRun/u);
  assert.throws(() => parseRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume_delta", tier: "full", runs: RELAY_MAX_RUNS + 1 }, executedOn: null }), /continuity runs/u);
  // The live contract no longer has these bounds (T7 opened them to the safe integers): that is the reason the copy exists.
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
