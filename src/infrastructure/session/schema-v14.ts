import { CONTEXT_EFFECTS } from "../../contracts/relay.js";

/*
 * The tables of a conversation kept as rows (ADR-057 3.1, store v14): SQL text only. Nothing runs it until the cut
 * (docs/proposals/protocol/step2-plan.md); its test (tests/integration/schema-v14.test.ts) runs it on a temporary database.
 *
 * Reading it:
 *  - `sessions`, `events`, `create_keys`, `owner_metadata` and the `relay_*` tables keep their names and foreign keys. A v13 database gets
 *    `sessions` altered (`SESSIONS_V13_TO_V14`): `snapshot` becomes `head` and holds the whole v13 snapshot until the conversation is
 *    converted (`format` 13), then the small head object (`format` 14). Every trigger that guards a converted conversation looks at
 *    `sessions.format`, so a conversation being converted is written freely, in its own transaction, and is frozen when it is set to 14.
 *  - What the old whole-snapshot checks guarded is guarded here by a key, a foreign key, a partial unique index or a trigger; the table
 *    "invariant → who guarantees it" in ADR-057 3.3 gives every one its place. Ordinals count from 0 and are the indexes the rows had in
 *    the old arrays (so the relay's stored ranges and `relay_index.run_index` need no change).
 *  - Nothing here limits a size or a count, and no CHECK lists the words the protocol may still add (an item's type or status, a
 *    command's kind): a later protocol version must not need a new format for a word.
 *  - Order inside a commit (Mutation, src/contracts/conversation.ts): a new conversation's head first, otherwise the head last; commands,
 *    a Run before its items, its items and text before its terminal change, a binding after the Run it points at and archived before the
 *    one that replaces it.
 *  - A conversation is deleted by setting `deleted_at` (its live native bindings are archived by the trigger, so another conversation
 *    can continue that native session); only then may its rows be deleted (a purge), children first.
 *  - `items.text_bytes` and `items.text_chunks` are kept by the insert trigger of `item_text`; a writer leaves them at their defaults.
 *  - The full-text indexes are derived data: nothing converts into them, `derived` says whether each is complete, and a maintenance
 *    command rebuilds them from the chunks.
 *  - THIS FILE IS FROZEN. The digest of what `schemaV14Definition` returns is written into every database made or upgraded to v14 (`schema_stamp`, schema-fingerprint.ts) and compared at
 *    every start: a database written by a build whose statements differ is refused (SCHEMA_MISMATCH) before anything is written to it. Changing a statement here therefore means a
 *    new version of the store and a migration from this one, not an edit; `derived` once gained a column without either, and a data root written before it failed deep inside a backfill.
 */

const list = (words: readonly string[]): string => words.map(word => "'" + word + "'").join(",");
const RUN_STATUSES = ["queued", "preparing", "running", "settling", "completed", "cancelled", "failed", "unknown"] as const;
const TERMINAL = list(["completed", "cancelled", "failed", "unknown"]);
const ACTIVE = list(["preparing", "running", "settling"]);
const OPEN = list(["queued", "preparing", "running", "settling"]);
const UNFINISHED_ITEM = list(["pending", "running", "waiting"]);
const PENDING_SWITCH = list(["requested", "validated"]);
const CONTEXT_EFFECT_CHECK = `IN(${list(CONTEXT_EFFECTS)})`;

/** The `sessions` table of a new database. */
const SESSIONS = `CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version>=1),
  last_seq INTEGER NOT NULL CHECK(last_seq>=0),
  head TEXT NOT NULL CHECK(json_valid(head)),
  format INTEGER NOT NULL DEFAULT 13 CHECK(format IN(13,14)),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed','blocked')),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1),
  active_run_id TEXT,
  pending_switch_id TEXT,
  kept INTEGER NOT NULL DEFAULT 0 CHECK(kept IN(0,1)),
  title TEXT NOT NULL DEFAULT '',
  run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count>=0),
  updated_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  last_error TEXT
) STRICT`;

/** What a v13 database's `sessions` becomes: the same rows, `snapshot` renamed, the head's columns added with the defaults of an unconverted row. */
export const SESSIONS_V13_TO_V14: readonly string[] = [
  "ALTER TABLE sessions RENAME COLUMN snapshot TO head",
  "ALTER TABLE sessions ADD COLUMN format INTEGER NOT NULL DEFAULT 13 CHECK(format IN(13,14))",
  "ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','closed','blocked'))",
  "ALTER TABLE sessions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch>=1)",
  "ALTER TABLE sessions ADD COLUMN active_run_id TEXT",
  "ALTER TABLE sessions ADD COLUMN pending_switch_id TEXT",
  "ALTER TABLE sessions ADD COLUMN kept INTEGER NOT NULL DEFAULT 0 CHECK(kept IN(0,1))",
  "ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0 CHECK(run_count>=0)",
  "ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN deleted_at INTEGER",
  "ALTER TABLE sessions ADD COLUMN last_error TEXT",
];

/** The columns of `runs`, in the order of its table: the terminal-Run trigger names all of them but `acknowledged_by`. */
const RUN_COLUMNS = ["session_id", "ordinal", "run_id", "command_id", "status", "epoch", "harness_id", "control_id", "managed", "accepted_at", "preparing_at", "ready_at", "reused",
  "user_seq", "ended_seq", "dispatched", "executed_harness_id", "executed_control_id", "executed_epoch", "is_command", "command_effect", "settled_effect", "acknowledged_by",
  "cancel_requested", "stop_requested", "legacy_order", "run_json"] as const;

const TABLES: readonly string[] = [
  `CREATE TABLE bindings(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  harness_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('ready','unconfirmed','archived','fork-pending','forking')),
  opens_new INTEGER NOT NULL DEFAULT 0 CHECK(opens_new IN(0,1)),
  through_run_id TEXT,
  relay_epoch INTEGER NOT NULL DEFAULT 1 CHECK(relay_epoch>=1),
  relay_mark INTEGER NOT NULL DEFAULT -1 CHECK(relay_mark>=-1),
  relay_floor INTEGER NOT NULL DEFAULT -1 CHECK(relay_floor>=-1),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  PRIMARY KEY(session_id, ordinal)
) STRICT`,
  `CREATE TABLE runs(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  run_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN(${list(RUN_STATUSES)})),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  harness_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0 CHECK(managed IN(0,1)),
  accepted_at INTEGER,
  preparing_at INTEGER,
  ready_at INTEGER,
  reused INTEGER NOT NULL DEFAULT 0 CHECK(reused IN(0,1)),
  user_seq INTEGER NOT NULL CHECK(user_seq>=1),
  ended_seq INTEGER CHECK(ended_seq IS NULL OR ended_seq>=1),
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN(0,1)),
  executed_harness_id TEXT,
  executed_control_id TEXT,
  executed_epoch INTEGER,
  is_command INTEGER NOT NULL DEFAULT 0 CHECK(is_command IN(0,1)),
  command_effect TEXT CHECK(command_effect IS NULL OR command_effect ${CONTEXT_EFFECT_CHECK}),
  settled_effect TEXT CHECK(settled_effect IS NULL OR settled_effect ${CONTEXT_EFFECT_CHECK}),
  acknowledged_by TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN(0,1)),
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN(0,1)),
  legacy_order INTEGER NOT NULL DEFAULT 0 CHECK(legacy_order IN(0,1)),
  run_json TEXT NOT NULL CHECK(json_valid(run_json)),
  PRIMARY KEY(session_id, ordinal),
  CHECK((executed_harness_id IS NULL)=(executed_control_id IS NULL) AND (executed_harness_id IS NULL)=(executed_epoch IS NULL))
) STRICT`,
  // `id` is the item's stable integer: the full-text indexes are keyed by it, and an explicit integer key survives VACUUM (an implicit rowid does not).
  `CREATE TABLE items(
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  seq INTEGER NOT NULL CHECK(seq>=1),
  item_id TEXT NOT NULL CHECK(item_id<>''),
  type TEXT NOT NULL CHECK(type<>''),
  status TEXT NOT NULL CHECK(status<>''),
  started_at INTEGER,
  ended_at INTEGER,
  parent_id TEXT,
  created_seq INTEGER,
  text_bytes INTEGER NOT NULL DEFAULT 0 CHECK(text_bytes>=0),
  text_chunks INTEGER NOT NULL DEFAULT 0 CHECK(text_chunks>=0),
  item_json TEXT NOT NULL CHECK(json_valid(item_json)),
  UNIQUE(run_id, seq),
  UNIQUE(run_id, item_id)
) STRICT`,
  `CREATE TABLE item_text(
  run_id TEXT NOT NULL,
  item_seq INTEGER NOT NULL,
  chunk INTEGER NOT NULL CHECK(chunk>=0),
  byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),
  text TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes=length(CAST(text AS BLOB))),
  PRIMARY KEY(run_id, item_seq, chunk),
  FOREIGN KEY(run_id, item_seq) REFERENCES items(run_id, seq)
) STRICT, WITHOUT ROWID`,
  `CREATE TABLE content_refs(
  ref_id INTEGER PRIMARY KEY,
  content_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT,
  item_seq INTEGER,
  role TEXT NOT NULL CHECK(role IN('tool_detail','output','attachment','origin_attachment','superseded_detail'))
) STRICT`,
  `CREATE TABLE commands(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind<>''),
  fingerprint TEXT NOT NULL,
  result_id TEXT NOT NULL,
  PRIMARY KEY(session_id, command_id),
  UNIQUE(session_id, ordinal)
) STRICT`,
  `CREATE TABLE switches(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  switch_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('requested','validated','effective','failed')),
  requested_seq INTEGER NOT NULL CHECK(requested_seq>=1),
  through_seq INTEGER NOT NULL CHECK(through_seq>=0),
  source_through_ordinal INTEGER,
  switch_json TEXT NOT NULL CHECK(json_valid(switch_json)),
  PRIMARY KEY(session_id, switch_id),
  UNIQUE(session_id, ordinal)
) STRICT`,
  `CREATE TABLE origin_history(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  idx INTEGER NOT NULL CHECK(idx>=0),
  kind TEXT NOT NULL CHECK(kind IN('fork','import')),
  message_json TEXT NOT NULL CHECK(json_valid(message_json)),
  PRIMARY KEY(session_id, idx)
) STRICT, WITHOUT ROWID`,
  // The fingerprints of the Harness notices already shown in a conversation: one is shown once (a Harness started again per Turn repeats its warnings).
  `CREATE TABLE notice_prints(
  session_id TEXT NOT NULL REFERENCES sessions(id),
  print TEXT NOT NULL,
  PRIMARY KEY(session_id, print)
) STRICT, WITHOUT ROWID`,
  // Whether each derived index is complete; a reader that finds it not `ready` says so and scans instead. `progress` is how far the backfill that fills an index after an
  // upgrade has got: every finished item with an `items.id` up to it is in the index (0 before it begins); a restart goes on from there.
  `CREATE TABLE derived(
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN('empty','building','ready')),
  updated_at INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress>=0)
) STRICT, WITHOUT ROWID`,
];

/**
 * Full-text search over finished messages and segments, keyed by `items.id`; the writer puts a segment's whole text in when the segment
 * closes and takes it out with `DELETE … WHERE rowid=?`. Two indexes, because neither covers every query: `search_fts` is trigram (three
 * characters or more, any script); `search_chars` is word-by-word over text whose Chinese characters were put one to a word before it went
 * in (and so the query), which finds one or two characters. One or two Latin characters scan the joined text.
 */
const SEARCH: readonly string[] = [
  "CREATE VIRTUAL TABLE search_fts USING fts5(text, content='', contentless_delete=1, tokenize='trigram')",
  "CREATE VIRTUAL TABLE search_chars USING fts5(text, content='', contentless_delete=1, tokenize='unicode61')",
];

const INDEXES: readonly string[] = [
  // Which conversations were not converted yet (the conversion's cursor), which keep a native process, which wait for a switch, and the sidebar's order.
  "CREATE INDEX sessions_unconverted ON sessions(id) WHERE format<14",
  "CREATE INDEX sessions_kept ON sessions(id) WHERE kept=1",
  "CREATE INDEX sessions_pending_switch ON sessions(pending_switch_id) WHERE pending_switch_id IS NOT NULL",
  "CREATE INDEX sessions_listing ON sessions(updated_at DESC, id) WHERE deleted_at IS NULL AND format=14",
  // One native session is held by one conversation, wherever it is; one live binding per Harness control in a conversation.
  "CREATE UNIQUE INDEX bindings_held ON bindings(harness_id, control_id, checkpoint) WHERE status IN('ready','unconfirmed') AND opens_new=0",
  "CREATE UNIQUE INDEX bindings_live ON bindings(session_id, harness_id, control_id) WHERE status<>'archived'",
  // One active Run per conversation; the Runs not finished (recovery, the queue, cancel, close); a Run's end for the relay; where it ran; whose unknown nobody acknowledged.
  `CREATE UNIQUE INDEX runs_one_active ON runs(session_id) WHERE status IN(${ACTIVE})`,
  `CREATE INDEX runs_open ON runs(session_id, status) WHERE status IN(${OPEN})`,
  "CREATE INDEX runs_ended ON runs(session_id, ended_seq) WHERE ended_seq IS NOT NULL",
  "CREATE INDEX runs_dispatched ON runs(session_id, harness_id, control_id, ordinal) WHERE dispatched=1",
  "CREATE INDEX runs_startup ON runs(harness_id, control_id, preparing_at) WHERE ready_at IS NOT NULL AND reused=0",
  "CREATE INDEX runs_unclaimed ON runs(session_id) WHERE status='unknown' AND acknowledged_by IS NULL",
  "CREATE UNIQUE INDEX runs_command ON runs(session_id, command_id)",
  // The items not finished (the Turn in progress, recovery).
  `CREATE INDEX items_unfinished ON items(run_id, status) WHERE status IN(${UNFINISHED_ITEM})`,
  "CREATE INDEX content_refs_content ON content_refs(content_id)",
  "CREATE INDEX content_refs_run ON content_refs(run_id, item_seq) WHERE run_id IS NOT NULL",
  "CREATE UNIQUE INDEX content_refs_once ON content_refs(content_id, session_id, role, COALESCE(run_id, ''), COALESCE(item_seq, -1))",
  "CREATE UNIQUE INDEX commands_one_create ON commands(session_id) WHERE kind='create'",
  `CREATE UNIQUE INDEX switches_one_pending ON switches(session_id) WHERE status IN(${PENDING_SWITCH})`,
  "CREATE INDEX switches_effective ON switches(session_id) WHERE status='effective'",
];

/** Whether the Run is finished in a converted conversation: nothing of it changes any more. */
const frozen = (runId: string): string => `EXISTS(SELECT 1 FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.run_id=${runId} AND s.format=14 AND r.status IN(${TERMINAL}))`;
/** Whether the conversation has been deleted: only then may its rows be purged. */
const purgeable = (sessionId: string): string => `EXISTS(SELECT 1 FROM sessions WHERE id=${sessionId} AND deleted_at IS NOT NULL)`;
const refuse = (name: string, on: string, when: string, message: string): string => `CREATE TRIGGER ${name} ${on} WHEN ${when} BEGIN SELECT RAISE(ABORT,'${message.replaceAll("'", "''")}'); END`;
const changed = (column: string, json: string): string => `json_extract(OLD.${column},'${json}') IS NOT json_extract(NEW.${column},'${json}')`;
const FINISHED_NATIVE_RUN = (binding: string): string => `EXISTS(SELECT 1 FROM runs r WHERE r.run_id=${binding}.through_run_id AND r.session_id=${binding}.session_id AND r.managed=0 AND r.status IN(${TERMINAL})
  AND r.harness_id=${binding}.harness_id AND r.control_id=${binding}.control_id AND (${binding}.status<>'ready' OR (json_extract(r.run_json,'$.backend') IS NOT NULL
  AND (json_extract(r.run_json,'$.retained')=1 OR (json_extract(r.run_json,'$.cleanup.closed')=1 AND json_extract(r.run_json,'$.cleanup.protocolFailure') IS NULL)))))`;

const TRIGGERS: readonly string[] = [
  // sessions. The head is written last, so these see the commit's rows. A converted conversation: the format only goes forward; the configuration and the origin never
  // change; a closed one stays closed and idle; an open one has no unknown Run that nobody acknowledged; its active Run and pending switch are the head's; its epoch
  // moves with one effective switch and equals their count plus one; a kept process belongs to the Run that handed it over; it is deleted before it is purged.
  refuse("sessions_format_forward", "BEFORE UPDATE ON sessions", "NEW.format<OLD.format", "a conversation is never converted back"),
  refuse("sessions_config_fixed", "BEFORE UPDATE ON sessions", `OLD.format=14 AND ${changed("head", "$.configuration")}`, "a conversation's configuration never changes"),
  refuse("sessions_origin_fixed", "BEFORE UPDATE ON sessions", `OLD.format=14 AND ${changed("head", "$.origin")}`, "a conversation's origin never changes"),
  refuse("sessions_closed_stays", "BEFORE UPDATE ON sessions", "OLD.format=14 AND OLD.status='closed' AND NEW.status<>'closed'", "a closed conversation cannot reopen"),
  refuse("sessions_closed_idle", "BEFORE UPDATE ON sessions",
    `OLD.format=14 AND NEW.status='closed' AND (NEW.pending_switch_id IS NOT NULL OR EXISTS(SELECT 1 FROM runs r WHERE r.session_id=NEW.id AND r.status IN(${OPEN})))`, "a closed conversation still admits work"),
  refuse("sessions_open_claimed", "BEFORE UPDATE ON sessions",
    "OLD.format=14 AND NEW.status='open' AND EXISTS(SELECT 1 FROM runs r WHERE r.session_id=NEW.id AND r.status='unknown' AND r.acknowledged_by IS NULL)", "an open conversation has an unknown Run nobody acknowledged"),
  refuse("sessions_active_run", "BEFORE UPDATE ON sessions",
    `OLD.format=14 AND NEW.active_run_id IS NOT (SELECT r.run_id FROM runs r WHERE r.session_id=NEW.id AND r.status IN(${ACTIVE}))`, "the head names a Run that is not the active one"),
  refuse("sessions_pending_switch_is", "BEFORE UPDATE ON sessions",
    `OLD.format=14 AND NEW.pending_switch_id IS NOT (SELECT w.switch_id FROM switches w WHERE w.session_id=NEW.id AND w.status IN(${PENDING_SWITCH}))`, "the head names a switch that is not the pending one"),
  refuse("sessions_epoch_step", "BEFORE UPDATE ON sessions", "OLD.format=14 AND (NEW.epoch<OLD.epoch OR NEW.epoch>OLD.epoch+1)", "the epoch moves with one effective switch"),
  refuse("sessions_epoch_is", "BEFORE UPDATE ON sessions",
    "OLD.format=14 AND NEW.epoch<>OLD.epoch AND NEW.epoch<>1+(SELECT COUNT(*) FROM switches w WHERE w.session_id=NEW.id AND w.status='effective')", "the epoch is the effective switches plus one"),
  refuse("sessions_kept_run", "BEFORE UPDATE ON sessions",
    `OLD.format=14 AND NEW.head IS NOT OLD.head AND json_extract(NEW.head,'$.retained') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.run_id=json_extract(NEW.head,'$.retained.runId')
      AND r.status='completed' AND json_extract(r.run_json,'$.retained')=1)`, "a kept process belongs to the Run that handed it over"),
  refuse("sessions_purge_only", "BEFORE DELETE ON sessions", "OLD.deleted_at IS NULL", "a conversation is deleted before it is purged"),
  // Deleting a conversation lets go of the native sessions it held: each live binding is archived, in its column and in its JSON (the two say one thing).
  "CREATE TRIGGER sessions_deleted_archives AFTER UPDATE OF deleted_at ON sessions WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN UPDATE bindings SET status='archived', binding_json=json_set(binding_json,'$.status','archived') WHERE session_id=NEW.id AND status<>'archived'; END",

  // runs. Identity never changes; the selection of a Run that left the queue never changes; its accepted input and what it was started with never change; what a
  // dispatched Run was given never changes; a terminal Run never changes (but an unknown one may be acknowledged, once); cancel and stop are never withdrawn; backend,
  // cleanup and the seq of the end are written once; a Run answers a send command.
  refuse("runs_identity_fixed", "BEFORE UPDATE ON runs",
    "NEW.session_id<>OLD.session_id OR NEW.ordinal<>OLD.ordinal OR NEW.run_id<>OLD.run_id OR NEW.command_id<>OLD.command_id OR NEW.user_seq<>OLD.user_seq", "a Run's identity never changes"),
  refuse("runs_selection_fixed", "BEFORE UPDATE ON runs",
    "OLD.status<>'queued' AND (NEW.harness_id<>OLD.harness_id OR NEW.control_id<>OLD.control_id OR NEW.epoch<>OLD.epoch OR NEW.managed<>OLD.managed)", "the selection of a dispatched Run never changes"),
  refuse("runs_accepted_fixed", "BEFORE UPDATE OF run_json ON runs",
    [`$.userMessageId`, `$.assistantMessageId`, `$.attachments`, `$.relayRequest`, `$.awaitingSwitchId`].map(path => changed("run_json", path)).join(" OR "), "what a Run accepted never changes"),
  refuse("runs_context_fixed", "BEFORE UPDATE OF run_json ON runs",
    `OLD.status IN('running','settling') AND (${[`$.contextThroughSeq`, `$.sourceRunIds`, `$.relay`, `$.timing.contextReadyAt`].map(path => changed("run_json", path)).join(" OR ")})`, "the context a dispatched Run was given never changes"),
  refuse("runs_terminal_fixed", `BEFORE UPDATE OF ${RUN_COLUMNS.filter(column => column !== "acknowledged_by").join(", ")} ON runs`,
    `OLD.status IN(${TERMINAL}) AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=OLD.session_id AND s.format=14)`, "a terminal Run never changes"),
  refuse("runs_acknowledged_once", "BEFORE UPDATE OF acknowledged_by ON runs",
    "(OLD.acknowledged_by IS NOT NULL AND NEW.acknowledged_by IS NOT OLD.acknowledged_by) OR (NEW.acknowledged_by IS NOT NULL AND OLD.status<>'unknown')", "only an unknown Run is acknowledged, and once"),
  refuse("runs_cancel_kept", "BEFORE UPDATE ON runs", "(OLD.cancel_requested=1 AND NEW.cancel_requested=0) OR (OLD.stop_requested=1 AND NEW.stop_requested=0)", "a cancel or a stop is never withdrawn"),
  refuse("runs_backend_once", "BEFORE UPDATE OF run_json ON runs", `json_extract(OLD.run_json,'$.backend') IS NOT NULL AND ${changed("run_json", "$.backend")}`, "backend evidence is written once"),
  refuse("runs_cleanup_once", "BEFORE UPDATE OF run_json ON runs", `json_extract(OLD.run_json,'$.cleanup') IS NOT NULL AND ${changed("run_json", "$.cleanup")}`, "cleanup evidence is written once"),
  refuse("runs_end_once", "BEFORE UPDATE ON runs", "OLD.ended_seq IS NOT NULL AND NEW.ended_seq IS NOT OLD.ended_seq", "the seq of a Run's end is written once"),
  refuse("runs_send_command", "BEFORE INSERT ON runs",
    "NOT EXISTS(SELECT 1 FROM commands c WHERE c.session_id=NEW.session_id AND c.command_id=NEW.command_id AND c.kind='send' AND c.result_id=NEW.run_id)", "a Run answers a send command"),
  refuse("runs_purge_only", "BEFORE DELETE ON runs", `NOT ${purgeable("OLD.session_id")}`, "a Run is kept"),

  // items. Place and id never change (the type may be refined while the Turn runs); a finished Run's items never change and none is added.
  refuse("items_identity_fixed", "BEFORE UPDATE ON items", "NEW.run_id<>OLD.run_id OR NEW.seq<>OLD.seq OR NEW.item_id<>OLD.item_id", "an item's place and id never change"),
  refuse("items_frozen_update", "BEFORE UPDATE ON items", frozen("OLD.run_id"), "the items of a finished Run never change"),
  refuse("items_frozen_insert", "BEFORE INSERT ON items", frozen("NEW.run_id"), "no item is added to a finished Run"),
  refuse("items_purge_only", "BEFORE DELETE ON items", `NOT EXISTS(SELECT 1 FROM runs r WHERE r.run_id=OLD.run_id AND ${purgeable("r.session_id")})`, "an item is kept"),

  // item_text. Appended one chunk after another, each where the one before ended, and never changed; its item's counters follow it.
  refuse("item_text_append_only", "BEFORE UPDATE ON item_text", "1", "text is only appended"),
  refuse("item_text_in_order", "BEFORE INSERT ON item_text",
    `NEW.chunk<>COALESCE((SELECT MAX(t.chunk)+1 FROM item_text t WHERE t.run_id=NEW.run_id AND t.item_seq=NEW.item_seq),0)
      OR NEW.byte_offset<>COALESCE((SELECT t.byte_offset+t.bytes FROM item_text t WHERE t.run_id=NEW.run_id AND t.item_seq=NEW.item_seq ORDER BY t.chunk DESC LIMIT 1),0)`, "a chunk follows the one before it"),
  refuse("item_text_frozen_insert", "BEFORE INSERT ON item_text", frozen("NEW.run_id"), "no text is added to a finished Run"),
  refuse("item_text_purge_only", "BEFORE DELETE ON item_text", `NOT EXISTS(SELECT 1 FROM runs r WHERE r.run_id=OLD.run_id AND ${purgeable("r.session_id")})`, "text is kept"),
  "CREATE TRIGGER item_text_counts AFTER INSERT ON item_text BEGIN UPDATE items SET text_bytes=text_bytes+NEW.bytes, text_chunks=text_chunks+1 WHERE run_id=NEW.run_id AND seq=NEW.item_seq; END",

  // bindings. Never deleted or taken over; an archived one is frozen; the relay's epoch and floor never go down, nor its mark within an epoch; along one Harness control
  // epochs strictly increase and floors never go down; the native position is a finished native Run of the same control, settled and closed.
  refuse("bindings_identity_fixed", "BEFORE UPDATE ON bindings",
    "NEW.session_id<>OLD.session_id OR NEW.ordinal<>OLD.ordinal OR NEW.harness_id<>OLD.harness_id OR NEW.control_id<>OLD.control_id", "a native binding is never taken over"),
  refuse("bindings_archived_fixed", "BEFORE UPDATE ON bindings", "OLD.status='archived'", "an archived native binding is frozen"),
  refuse("bindings_relay_forward", "BEFORE UPDATE ON bindings",
    "NEW.relay_epoch<OLD.relay_epoch OR NEW.relay_floor<OLD.relay_floor OR (NEW.relay_epoch=OLD.relay_epoch AND NEW.relay_mark<OLD.relay_mark)", "a binding's relay state only goes forward"),
  refuse("bindings_lineage", "BEFORE INSERT ON bindings",
    "EXISTS(SELECT 1 FROM bindings b WHERE b.session_id=NEW.session_id AND b.harness_id=NEW.harness_id AND b.control_id=NEW.control_id AND b.ordinal<NEW.ordinal AND (b.relay_epoch>=NEW.relay_epoch OR b.relay_floor>NEW.relay_floor))",
    "the epochs of one Harness control increase along its bindings"),
  refuse("bindings_cursor_insert", "BEFORE INSERT ON bindings", `NEW.through_run_id IS NOT NULL AND NOT ${FINISHED_NATIVE_RUN("NEW")}`, "the native position is a finished native Run"),
  refuse("bindings_cursor_update", "BEFORE UPDATE ON bindings", `NEW.through_run_id IS NOT NULL AND NOT ${FINISHED_NATIVE_RUN("NEW")}`, "the native position is a finished native Run"),
  refuse("bindings_purge_only", "BEFORE DELETE ON bindings", `NOT ${purgeable("OLD.session_id")}`, "a native binding is kept"),

  // commands are written once; a switch answers a switch command, is not rewritten once it ended, and its request never changes.
  refuse("commands_fixed", "BEFORE UPDATE ON commands", "1", "a committed command is never rewritten"),
  refuse("commands_purge_only", "BEFORE DELETE ON commands", `NOT ${purgeable("OLD.session_id")}`, "a command is kept"),
  refuse("switches_command", "BEFORE INSERT ON switches",
    "NOT EXISTS(SELECT 1 FROM commands c WHERE c.session_id=NEW.session_id AND c.command_id=NEW.command_id AND c.kind='switch' AND c.result_id=NEW.switch_id)", "a switch answers a switch command"),
  refuse("switches_ended_fixed", "BEFORE UPDATE ON switches", "OLD.status IN('effective','failed')", "an ended switch is never rewritten"),
  refuse("switches_request_fixed", "BEFORE UPDATE ON switches", "NEW.command_id<>OLD.command_id OR NEW.requested_seq<>OLD.requested_seq OR NEW.ordinal<>OLD.ordinal", "a switch's request never changes"),
  refuse("switches_purge_only", "BEFORE DELETE ON switches", `NOT ${purgeable("OLD.session_id")}`, "a switch is kept"),
];

/** The columns of `relay_packets` but its body: a packet row never changes in any of them. */
const RELAY_PACKET_FIXED_COLUMNS = ["session_id", "packet_id", "kind", "tier", "target_harness", "target_control", "target_model", "native_epoch", "from_seq", "through_seq",
  "supersedes_packet_id", "policy_version", "language", "est_tokens", "manifest_json"] as const;
/** The one change a packet row gets: its body is let go (set null) and nothing else moves. */
const PACKET_LOSES_ONLY_ITS_BODY = `OLD.body_sha256 IS NOT NULL AND NEW.body_sha256 IS NULL AND ${RELAY_PACKET_FIXED_COLUMNS.map(column => `NEW.${column} IS OLD.${column}`).join(" AND ")}`;

/**
 * The relay tables whose limits the no-limits decision lifts, rebuilt inside the migration's first transaction (SQLite cannot alter a
 * CHECK): a packet's body may be gone (the oldest delivered bodies are evicted past the quota, and the manifest and the delivery rows
 * stay), no packet body or manifest has a size ceiling, and a manifest holds ranges where it held indexes. Rows are copied as they
 * are. It follows SQLite's procedure for rebuilding a table other tables point at: `PRAGMA foreign_keys=OFF` BEFORE the transaction
 * begins (it does nothing inside one), these statements, `PRAGMA foreign_key_check` (it must return no rows) before COMMIT, and
 * `PRAGMA foreign_keys=ON` after it. (Deferring the keys does not do: dropping the parent counts every child as a violation for good.)
 *
 * A packet row is immutable but for that eviction: the only update the trigger lets through is `body_sha256` going from a digest to null with every other column
 * unchanged (the body row is then deleted, which the foreign key allows because nothing names it any more); a body, once let go, does not come back to the row.
 */
export const RELAY_V14_REBUILD: readonly string[] = [
  `CREATE TABLE relay_bodies_v14(session_id TEXT NOT NULL REFERENCES sessions(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=1), body TEXT NOT NULL,
  PRIMARY KEY(session_id, sha256)) STRICT`,
  "INSERT INTO relay_bodies_v14(session_id,sha256,bytes,body) SELECT session_id,sha256,bytes,body FROM relay_bodies",
  `CREATE TABLE relay_packets_v14(session_id TEXT NOT NULL REFERENCES sessions(id), packet_id TEXT NOT NULL CHECK(packet_id GLOB 'relay-*'),
  kind TEXT NOT NULL CHECK(kind IN('packet','delta')), tier TEXT NOT NULL CHECK(tier IN('full','brief')),
  target_harness TEXT NOT NULL, target_control TEXT NOT NULL, target_model TEXT, native_epoch INTEGER NOT NULL,
  from_seq INTEGER NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=from_seq), supersedes_packet_id TEXT,
  policy_version TEXT NOT NULL, language TEXT NOT NULL CHECK(language IN('zh','en')),
  body_sha256 TEXT, est_tokens INTEGER NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  PRIMARY KEY(session_id, packet_id), FOREIGN KEY(session_id, body_sha256) REFERENCES relay_bodies_v14(session_id, sha256)) STRICT`,
  `INSERT INTO relay_packets_v14(session_id,packet_id,kind,tier,target_harness,target_control,target_model,native_epoch,from_seq,through_seq,supersedes_packet_id,policy_version,language,body_sha256,est_tokens,manifest_json)
  SELECT session_id,packet_id,kind,tier,target_harness,target_control,target_model,native_epoch,from_seq,through_seq,supersedes_packet_id,policy_version,language,body_sha256,est_tokens,manifest_json FROM relay_packets`,
  "DROP TABLE relay_packets",
  "DROP TABLE relay_bodies",
  "ALTER TABLE relay_bodies_v14 RENAME TO relay_bodies",
  "ALTER TABLE relay_packets_v14 RENAME TO relay_packets",
  "CREATE TRIGGER relay_bodies_immutable BEFORE UPDATE ON relay_bodies BEGIN SELECT RAISE(ABORT,'relay body is immutable'); END",
  `CREATE TRIGGER relay_packets_immutable BEFORE UPDATE ON relay_packets WHEN NOT (${PACKET_LOSES_ONLY_ITS_BODY}) BEGIN SELECT RAISE(ABORT,'relay packet is immutable'); END`,
];

/** The tables schema-v14.ts adds (not `sessions`), parents first; a purge deletes them last to first. */
export const V14_TABLES = ["bindings", "runs", "items", "item_text", "content_refs", "commands", "switches", "origin_history", "notice_prints", "derived"] as const;
/** The full-text indexes (derived data). */
export const V14_SEARCH_TABLES = ["search_fts", "search_chars"] as const;
/** The names of every index and trigger it adds, for a check that a database has them all. */
export const V14_INDEXES: readonly string[] = INDEXES.map(sql => /^CREATE (?:UNIQUE )?INDEX (\w+)/u.exec(sql)![1]!);
export const V14_TRIGGERS: readonly string[] = TRIGGERS.map(sql => /^CREATE TRIGGER (\w+)/u.exec(sql)![1]!);
/** The columns of `runs` in table order. */
export const V14_RUN_COLUMNS: readonly string[] = RUN_COLUMNS;

/**
 * The statements that DEFINE the structure of a v14 database, as a new database has it: `sessions` as a table made whole, the other tables, the indexes and the triggers. The
 * derived full-text tables (`SEARCH`) are left out, since they are made again from the rows at any time. A database upgraded from v13 gets the same structure by `ALTER` and
 * `RELAY_V14_REBUILD`, so this list, not the upgrade's, is what the structure is. It is what the fingerprint of the structure is made of (schema-fingerprint.ts): changing a
 * statement here changes the fingerprint, and a database written by the build before it is then refused at its start, so the change comes with a version and a migration.
 */
export function schemaV14Definition(): readonly string[] {
  return [SESSIONS, ...TABLES, ...INDEXES, ...TRIGGERS];
}

/**
 * The statements that make a database v14, in order. `from: "fresh"` is a new database (the caller makes `events`, `create_keys`,
 * `owner_metadata` and the `relay_*` tables as it always has); `from: "v13"` is a database whose `sessions` is the v13 table (the
 * caller also runs `RELAY_V14_REBUILD`, in the same transaction).
 */
export function schemaV14Statements(from: "fresh" | "v13"): readonly string[] {
  return [...from === "fresh" ? [SESSIONS] : SESSIONS_V13_TO_V14, ...TABLES, ...SEARCH, ...INDEXES, ...TRIGGERS];
}
