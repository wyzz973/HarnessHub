import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * Rebuilds frozen Session v12 business databases (README.md next to this file) as a data root a Session v12 build would
 * have left: the ownership marker, then `gateway.sqlite` with the four v12 tables, their rows and user_version 12, no
 * owner holding it. Tests open such a root with the current SqliteSessionStore to migrate it.
 */

export interface V12Event { readonly type: string; readonly data: Readonly<Record<string, unknown>>; readonly sessionId: string; readonly seq: number; readonly ownerGeneration: number; readonly timestamp: string }
export interface V12Session { readonly id: string; readonly version: number; readonly lastSeq: number; readonly snapshot: Readonly<Record<string, unknown>>; readonly events: readonly V12Event[] }
export interface V12Fixture {
  readonly fixture: string;
  readonly describe: string;
  readonly userVersion: 12;
  readonly ownerGeneration: number;
  readonly sessions: readonly V12Session[];
  readonly createKeys: readonly { readonly commandId: string; readonly sessionId: string; readonly fingerprint: string }[];
}
/** The seven binding sources of G066-C01. */
export const V12_FIXTURES = ["d1", "dispatch-failed", "insert-rejected", "import", "branch", "clear", "reset-d1"] as const;
export type V12FixtureName = typeof V12_FIXTURES[number];
const directory = fileURLToPath(new URL("../../../../../tests/fixtures/relay/v12/", import.meta.url));
export function loadV12Fixture(name: V12FixtureName): V12Fixture {
  return JSON.parse(readFileSync(join(directory, name + ".json"), "utf8")) as V12Fixture;
}
/** The v12 business tables as a v12 build created them (sqlite-store.ts at 5c5f12f). */
export const V12_DDL = `
CREATE TABLE owner_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=0),owner_pid INTEGER NOT NULL,owner_token TEXT NOT NULL,owner_active INTEGER NOT NULL CHECK(owner_active IN(0,1))) STRICT;
CREATE TABLE sessions(id TEXT PRIMARY KEY,version INTEGER NOT NULL CHECK(version>=1),last_seq INTEGER NOT NULL CHECK(last_seq>=0),snapshot TEXT NOT NULL CHECK(json_valid(snapshot))) STRICT;
CREATE TABLE create_keys(command_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),fingerprint TEXT NOT NULL) STRICT;
CREATE TABLE events(session_id TEXT NOT NULL REFERENCES sessions(id),seq INTEGER NOT NULL CHECK(seq>=1),owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),event_json TEXT NOT NULL CHECK(json_valid(event_json)),PRIMARY KEY(session_id,seq)) STRICT;
`;
/**
 * Writes `sessions` into a new data root `root` (which must not exist or be empty) as a v12 database whose owner
 * generation is the highest of the fixtures', with every event stored as a v12 build stored it.
 */
export function writeV12Root(root: string, fixtures: readonly V12Fixture[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = openSync(join(root, ".harness-gateway.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(marker, JSON.stringify({ application: "harness-gateway", schemaVersion: 1 }) + "\n"); fsyncSync(marker); } finally { closeSync(marker); }
  const database = new DatabaseSync(join(root, "gateway.sqlite"));
  try {
    database.exec("PRAGMA journal_mode=WAL"); database.exec(V12_DDL); database.exec("BEGIN");
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
    database.exec("COMMIT"); database.exec("PRAGMA user_version=12");
  } finally { database.close(); }
}
/**
 * A copy of `fixture` whose Sessions are renamed with `suffix` (identities wherever they appear, and create command keys),
 * so many copies can share one database.
 */
export function renamed(fixture: V12Fixture, suffix: string): V12Fixture {
  const ids = new Map(fixture.sessions.map(row => [row.id, row.id + "-" + suffix]));
  const keys = new Map(fixture.createKeys.map(row => [row.commandId, row.commandId + "-" + suffix]));
  const swap = (value: unknown): unknown => typeof value === "string" ? ids.get(value) ?? value : Array.isArray(value) ? value.map(swap)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)])) : value;
  return { ...fixture,
    sessions: fixture.sessions.map(row => {
      const snapshot = swap(row.snapshot) as Record<string, unknown>;
      const commands = (snapshot.commands as readonly Record<string, unknown>[]).map(command => command.kind === "create" ? { ...command, id: keys.get(String(command.id)) ?? command.id } : command);
      return { ...row, id: ids.get(row.id)!, snapshot: { ...snapshot, commands }, events: row.events.map(event => swap(event) as V12Event) };
    }),
    createKeys: fixture.createKeys.map(row => ({ commandId: keys.get(row.commandId)!, sessionId: ids.get(row.sessionId)!, fingerprint: row.fingerprint })) };
}
