import { HubError } from "./errors.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * Diagnostic log detail. `info` records lifecycle, traffic summaries and errors;
 * `debug` adds bounded, redacted payload excerpts of ACP messages and model calls.
 */
export type LogLevel = "info" | "debug";

/** Environment variable read once by each process entry point; see {@link parseLogLevel}. */
export const LOG_LEVEL_ENVIRONMENT = "HARNESSHUB_LOG_LEVEL";

/** Longest payload excerpt written at `debug` level, in characters. */
export const LOG_EXCERPT_LIMIT = 2048;

/** Fields of one record; `undefined` values are omitted from the written line. */
export type LogFields = Record<string, JsonValue | undefined>;

/**
 * Structured diagnostic log owned by one process. Implementations never throw
 * from `info`/`debug` and never affect the operation being logged; a failing
 * sink reports its own failure once through its owner's channel.
 */
export interface LogSink {
  readonly level: LogLevel;
  info(event: string, fields?: LogFields): void;
  /** Dropped unless {@link LogSink.level} is `debug`. */
  debug(event: string, fields?: LogFields): void;
}

/** A sink that discards every record, for callers without a diagnostic log. */
export const NO_LOG: LogSink = {
  level: "info",
  info: () => undefined,
  debug: () => undefined,
};

/**
 * Resolve {@link LOG_LEVEL_ENVIRONMENT}: absent or empty means `info`; `info` and
 * `debug` are accepted case-insensitively. Anything else throws `INVALID_CONFIG`
 * so a mistyped level fails startup instead of silently logging less.
 */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") return "info";
  if (normalized === "info" || normalized === "debug") return normalized;
  throw new HubError(
    "INVALID_CONFIG",
    `${LOG_LEVEL_ENVIRONMENT} must be info or debug`,
  );
}

/** Diagnostic file of one Session: its Worker's engine log or its lines in the Gateway log. */
export type SessionLogSource = "engine" | "gateway";

/** Records returned by one read when the caller gives no limit. */
export const SESSION_LOG_DEFAULT_LIMIT = 200;
/** Largest `limit` a caller may request. */
export const SESSION_LOG_MAX_LIMIT = 2000;
/**
 * Opaque paging cursor `<file id>:<byte offset>`: the identity of the newest file
 * generation that was read and the end of its last complete line. A rotation
 * renames the file without changing its identity, so the cursor stays valid.
 */
export const SESSION_LOG_CURSOR_PATTERN = "^[0-9]{1,40}:[0-9]{1,16}$";

export interface SessionLogQuery {
  sessionId: string;
  /** Runs of the Session; Gateway records that carry only a Run id are matched through them. */
  runIds: readonly string[];
  source: SessionLogSource;
  /** Most records returned; the newest are kept. */
  limit: number;
  /** Cursor of an earlier page: only records written after it are returned. */
  after?: string;
}

export interface SessionLogPage {
  source: SessionLogSource;
  /** Current generation of the file that was read (rotated `.1`–`.3` are read too). */
  file: string;
  /** False when the file and its rotations do not exist yet (for example no Run started). */
  exists: boolean;
  /** Parsed JSON Lines records in written order, oldest first. */
  records: JsonObject[];
  /**
   * Cursor for the next page (`after`): the end of the last complete line read.
   * Null when no generation of the file exists yet.
   */
  cursor: string | null;
  /**
   * Matching records that this page skipped exist: the limit, the response size
   * bound or the scan budget stopped the read, or `after` pointed to data that
   * was rotated away.
   */
  truncated: boolean;
  /** Lines that were not valid JSON records after redaction and were skipped. */
  skipped: number;
}

/**
 * Read-only access to a Session's diagnostic files for operators. Implementations
 * read files only (never a Worker), redact every line again before parsing and
 * bound the scanned bytes and the returned size. Rejects with `INVALID_REQUEST`
 * (400) for a malformed cursor or limit; I/O failures other than a missing file
 * reject with `LOG_READ_FAILED` (500).
 */
export interface SessionLogReader {
  read(query: SessionLogQuery): Promise<SessionLogPage>;
}

/**
 * Bound `text` to `limit` characters (code points), appending how many were cut.
 * Callers redact before or after; this function never adds content of its own
 * beyond the `…(+N)` marker.
 */
export function excerpt(text: string, limit = LOG_EXCERPT_LIMIT): string {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters.slice(0, limit).join("")}…(+${characters.length - limit})`;
}
