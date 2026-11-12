import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Rebuilds frozen Session v13 business databases (README.md next to this file) as a data root a Session v13 build would have left: the
 * ownership marker, then `gateway.sqlite` with its tables, their rows and user_version 13, no owner holding it. A test opens such a root
 * with the SqliteSessionStore (today: it recovers whatever the owner left unfinished and keeps v13; after the cut: it converts to v14), and
 * the pure functions (the storage conversion) read the same fixtures as plain snapshots.
 *
 * The DDL is a FROZEN COPY of what a v13 build created (sqlite-store.ts and relay-tables.ts at the commit the fixtures were generated
 * at): it must not follow the sources, which turn to v14 at the cut.
 */

export interface V13Event { readonly type: string; readonly data: Readonly<Record<string, unknown>>; readonly sessionId: string; readonly seq: number; readonly ownerGeneration: number; readonly timestamp: string }
export interface V13Session { readonly id: string; readonly version: number; readonly lastSeq: number; readonly snapshot: Readonly<Record<string, unknown>>; readonly events: readonly V13Event[] }
type Row = Readonly<Record<string, string | number | null>>;
/** The rows of the relay tables as the database holds them (column name → value); `index_json`, `manifest_json` and the like stay JSON text. */
export interface V13Relay { readonly bodies: readonly Row[]; readonly packets: readonly Row[]; readonly deliveries: readonly Row[]; readonly index: readonly Row[]; readonly log: readonly Row[]; readonly prefs: readonly Row[] }
/** What the content store held for an object the conversations refer to: its public reference, and its text when the Runtime stored it as UTF-8 (a tool's detail). */
export interface V13Content { readonly ref: Readonly<Record<string, unknown>>; readonly text?: string }
export interface V13Fixture {
  readonly fixture: string;
  readonly describe: string;
  readonly userVersion: 13;
  readonly ownerGeneration: number;
  /** true: the database was copied while its owner was working, so some Run is not finished or a switch is pending: opening it recovers (OWNER_ENDED). */
  readonly unfinished: boolean;
  readonly sessions: readonly V13Session[];
  readonly createKeys: readonly { readonly commandId: string; readonly sessionId: string; readonly fingerprint: string }[];
  readonly relay: V13Relay;
  /** Content-store objects by id: every id any conversation of the fixture refers to. */
  readonly contents: Readonly<Record<string, V13Content>>;
  /** `contentReferences()` of the v13 store that wrote the fixture: the set the collector keeps (tool details, outputs, attachments, quoted attachments). */
  readonly contentReferences: readonly string[];
}

export const V13_FIXTURES = [
  "switches", "relay-states", "commands", "branch", "branch-pending", "import", "tools", "text-extremes", "at-the-old-limits", "kept-process", "unknown-recovered", "unknown-acknowledged",
  "running-crash", "recovered-after-crash", "waiting-crash", "recovered-after-waiting-crash", "trial-2026-11-11",
  "from-v12-d1", "from-v12-dispatch-failed", "from-v12-insert-rejected", "from-v12-import", "from-v12-branch", "from-v12-clear", "from-v12-reset-d1",
] as const;
export type V13FixtureName = typeof V13_FIXTURES[number];

const directory = fileURLToPath(new URL("../../../../../tests/fixtures/storage/v13/", import.meta.url));
export function loadV13Fixture(name: V13FixtureName): V13Fixture {
  return JSON.parse(readFileSync(join(directory, name + ".json"), "utf8")) as V13Fixture;
}
/** The files of the fixture directory this module is read from (for tests that read a fixture that is not a database). */
export function v13Path(name: string): string { return join(directory, name); }

/** The v13 business tables as a v13 build created them (sqlite-store.ts claimAndRecover at version 0, and RELAY_DDL). */
export const V13_DDL = `
CREATE TABLE owner_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=0),owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,owner_active INTEGER NOT NULL CHECK(owner_active IN(0,1))) STRICT;
CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
CREATE TABLE create_keys(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT;
CREATE TABLE relay_bodies(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT;
CREATE TABLE relay_packets(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta')), tier TEXT NOT NULL CHECK(tier IN('full','brief')),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')),
  body_sha256 TEXT NOT NULL, est_tokens INTEGER NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=65536),
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies(session_id, sha256)) STRICT;
CREATE TABLE relay_deliveries(session_id TEXT NOT NULL, run_id TEXT NOT NULL, packet_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN('text_block','single_text')),
  handoff_log_seq INTEGER, input_hmac TEXT NOT NULL, auto_resend INTEGER NOT NULL CHECK(auto_resend IN(0,1)),
  redaction_rules_version TEXT NOT NULL, redaction_key_id TEXT NOT NULL, redaction_set_hmac TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN('in_flight','recorded','not_recorded','unknown')),
  evidence TEXT CHECK(evidence IN('E1','E3')), reason TEXT, decided_seq INTEGER, decided_at INTEGER,
  PRIMARY KEY(session_id, run_id), FOREIGN KEY(session_id, packet_id) REFERENCES relay_packets(session_id, packet_id),
  CHECK((outcome='in_flight') = (evidence IS NULL AND reason IS NULL AND decided_seq IS NULL)),
  CHECK(outcome<>'recorded' OR evidence IS NOT NULL), CHECK(outcome NOT IN('not_recorded','unknown') OR reason IS NOT NULL)) STRICT;
CREATE TABLE relay_index(session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL, run_index INTEGER NOT NULL,
  index_json TEXT NOT NULL CHECK(json_valid(index_json) AND length(CAST(index_json AS BLOB))<=2048), PRIMARY KEY(session_id, run_id)) STRICT;
CREATE TABLE relay_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, harness_id TEXT NOT NULL UNIQUE, first_at INTEGER NOT NULL) STRICT;
CREATE TABLE relay_prefs(key TEXT PRIMARY KEY CHECK(key IN('relay.attach')),
  value TEXT NOT NULL CHECK(length(value)<=64), updated_at INTEGER NOT NULL) STRICT;
CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END;
CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END;
CREATE TRIGGER relay_log_immutable BEFORE UPDATE ON relay_log BEGIN SELECT RAISE(ABORT,'relay log is append-only'); END;
CREATE TRIGGER relay_deliveries_transition BEFORE UPDATE OF outcome ON relay_deliveries
  WHEN NOT ((OLD.outcome='in_flight') OR (OLD.outcome=NEW.outcome))
  BEGIN SELECT RAISE(ABORT,'illegal delivery transition'); END;
`;

function insertRows(database: DatabaseSync, table: string, rows: readonly Row[]): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column] as SQLInputValue));
  }
}
/**
 * Writes `fixtures` into a new data root `root` (which must not exist or be empty) as a v13 database whose owner generation is the highest
 * of the fixtures', with every session, event and relay row as a v13 build stored it. The conversations of several fixtures share one
 * database (their identities must differ: see `renamed`).
 */
export function writeV13Root(root: string, fixtures: readonly V13Fixture[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = openSync(join(root, ".harness-gateway.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(marker, JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }) + "\n"); fsyncSync(marker); } finally { closeSync(marker); }
  const database = new DatabaseSync(join(root, "gateway.sqlite"));
  try {
    database.exec("PRAGMA journal_mode=WAL"); database.exec(V13_DDL); database.exec("BEGIN");
    database.prepare("INSERT INTO owner_metadata VALUES(1,?,0,'',0)").run(Math.max(1, ...fixtures.map(row => row.ownerGeneration)));
    const session = database.prepare("INSERT INTO sessions(id,version,last_seq,snapshot) VALUES(?,?,?,?)"), key = database.prepare("INSERT INTO create_keys(command_id,session_id,fingerprint) VALUES(?,?,?)");
    const event = database.prepare("INSERT INTO events(session_id,seq,owner_generation,event_json) VALUES(?,?,?,?)");
    for (const fixture of fixtures) {
      for (const row of fixture.sessions) {
        session.run(row.id, row.version, row.lastSeq, JSON.stringify(row.snapshot));
        for (const item of row.events) event.run(row.id, item.seq, item.ownerGeneration, JSON.stringify(item));
      }
      for (const row of fixture.createKeys) key.run(row.commandId, row.sessionId, row.fingerprint);
    }
    // The relay tables, parents first. The installation-level log and preferences are written once, from the first fixture that has them.
    for (const fixture of fixtures) { insertRows(database, "relay_bodies", fixture.relay.bodies); insertRows(database, "relay_packets", fixture.relay.packets); insertRows(database, "relay_deliveries", fixture.relay.deliveries); insertRows(database, "relay_index", fixture.relay.index); }
    const logged = new Set<string>();
    for (const fixture of fixtures) {
      insertRows(database, "relay_log", fixture.relay.log.filter(row => !logged.has(String(row.harness_id))).map(row => { logged.add(String(row.harness_id)); return { harness_id: row.harness_id as string, first_at: row.first_at as number }; }));
      if (!database.prepare("SELECT 1 AS found FROM relay_prefs").get()) insertRows(database, "relay_prefs", fixture.relay.prefs);
    }
    database.exec("COMMIT"); database.exec("PRAGMA user_version=13");
  } finally { database.close(); }
}
/**
 * A copy of `fixture` whose conversations are renamed with `suffix` (their identities wherever they appear as a whole value, and the
 * create command keys), so many copies can share one database. Digests keyed by the old identity (relay HMACs) are not recomputed.
 */
export function renamed(fixture: V13Fixture, suffix: string): V13Fixture {
  const ids = new Map(fixture.sessions.map(row => [row.id, row.id + "-" + suffix]));
  const keys = new Map(fixture.createKeys.map(row => [row.commandId, row.commandId + "-" + suffix]));
  const swap = (value: unknown): unknown => typeof value === "string" ? ids.get(value) ?? value : Array.isArray(value) ? value.map(swap)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, swap(item)])) : value;
  const rows = (list: readonly Row[]): readonly Row[] => list.map(row => swap(row) as Row);
  return { ...fixture,
    sessions: fixture.sessions.map(row => {
      const snapshot = swap(row.snapshot) as Record<string, unknown>;
      const commands = (snapshot.commands as readonly Record<string, unknown>[]).map(command => command.kind === "create" ? { ...command, id: keys.get(String(command.id)) ?? command.id } : command);
      return { ...row, id: ids.get(row.id)!, snapshot: { ...snapshot, commands }, events: row.events.map(event => swap(event) as V13Event) };
    }),
    createKeys: fixture.createKeys.map(row => ({ commandId: keys.get(row.commandId)!, sessionId: ids.get(row.sessionId)!, fingerprint: row.fingerprint })),
    relay: { ...fixture.relay, bodies: rows(fixture.relay.bodies), packets: rows(fixture.relay.packets), deliveries: rows(fixture.relay.deliveries), index: rows(fixture.relay.index) } };
}
