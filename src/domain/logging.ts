import { HubError } from "./errors.js";
import type { JsonValue } from "./types.js";

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
