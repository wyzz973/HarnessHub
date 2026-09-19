import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { excerpt } from "../domain/logging.js";
import type { LogFields, LogLevel, LogSink } from "../domain/logging.js";

/** Longest string value inside one written record, in characters. */
const MAX_FIELD_CHARS = 8192;

export interface JsonLogFileOptions {
  /** Absolute path. The directory is created 0700 and the file 0600 on the first write. */
  file: string;
  level: LogLevel;
  /** Applied to every serialized line before it is written or echoed. Must be pure. */
  redact?: (text: string) => string;
  /** Size that triggers rotation before the next write; default 16 MiB. */
  maxBytes?: number;
  /** Rotated generations kept as `<file>.1` (newest) … `<file>.<keep>`; default 3. */
  keep?: number;
  /** Receives each accepted line (redacted, without newline), its level and event. Exceptions are ignored. */
  echo?: (line: string, level: LogLevel, event: string) => void;
  /**
   * Called once with the first write or rotation failure. After a write failure
   * the file is abandoned; `echo` keeps receiving lines.
   */
  onError?: (error: unknown) => void;
  now?: () => Date;
}

/**
 * Append-only JSON Lines diagnostic file: one `{"time","level","event",...}`
 * object per line, string values bounded to 8 KiB, secrets removed by `redact`,
 * size-based rotation. Each record is appended synchronously and the file is not
 * held open, so records keep causal order, survive a crash of the owning process
 * right after the call, and need no close. Never throws from {@link LogSink}
 * methods.
 */
export class JsonLogFile implements LogSink {
  readonly level: LogLevel;
  readonly file: string;
  private readonly redact: (text: string) => string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private size: number | undefined;
  private abandoned = false;
  private reported = false;
  private closed = false;

  constructor(private readonly options: JsonLogFileOptions) {
    this.level = options.level;
    this.file = options.file;
    this.redact = options.redact ?? ((text) => text);
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.keep = options.keep ?? 3;
    if (!path.isAbsolute(this.file))
      throw new Error("Log file path must be absolute");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024)
      throw new Error("Log rotation size must be at least 1024 bytes");
    if (!Number.isSafeInteger(this.keep) || this.keep < 1 || this.keep > 20)
      throw new Error("Rotated log generations must be between 1 and 20");
  }

  info(event: string, fields?: LogFields): void {
    this.record("info", event, fields);
  }

  debug(event: string, fields?: LogFields): void {
    if (this.level === "debug") this.record("debug", event, fields);
  }

  /** Stop writing the file (records are still echoed). Idempotent. */
  close(): void {
    this.closed = true;
  }

  private record(level: LogLevel, event: string, fields?: LogFields): void {
    let line: string;
    try {
      const time = (this.options.now?.() ?? new Date()).toISOString();
      const entry: Record<string, unknown> = { time, level, event };
      // Fields never replace the record's own time, level or event.
      for (const [key, value] of Object.entries(fields ?? {}))
        entry[key in entry ? `_${key}` : key] = value;
      const serialized = JSON.stringify(entry, (_key, value: unknown) =>
        typeof value === "string" ? excerpt(value, MAX_FIELD_CHARS) : value,
      );
      line = this.redact(serialized);
      // Redaction must not turn a record into invalid JSON Lines.
      JSON.parse(line);
    } catch {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        event: "log.unserializable",
        source: excerpt(String(event), 200),
      });
    }
    try {
      this.options.echo?.(line, level, event);
    } catch {
      // Echo targets (stdout) are best-effort mirrors of the file.
    }
    if (this.closed || this.abandoned) return;
    try {
      this.append(`${line}\n`);
    } catch (error) {
      this.abandoned = true;
      this.report(error);
    }
  }

  private append(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.size === undefined) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        this.size = statSync(this.file).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.size = 0;
      }
    }
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.file, text, { mode: 0o600 });
    this.size += bytes;
  }

  private rotate(): void {
    try {
      for (let index = this.keep - 1; index >= 1; index--)
        try {
          renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      renameSync(this.file, `${this.file}.1`);
      this.size = 0;
    } catch (error) {
      // A reader holding the file without delete sharing (for example an
      // antivirus scan on Windows) can block the rename; keep appending and
      // try again after another `maxBytes`.
      this.size = 0;
      this.report(error);
    }
  }

  private report(error: unknown): void {
    if (this.reported) return;
    this.reported = true;
    try {
      this.options.onError?.(error);
    } catch {
      // The owner's reporting channel failed as well; nothing else can observe it.
    }
  }
}
