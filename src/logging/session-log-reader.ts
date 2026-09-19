import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { HubError } from "../domain/errors.js";
import {
  SESSION_LOG_CURSOR_PATTERN,
  SESSION_LOG_MAX_LIMIT,
} from "../domain/logging.js";
import type {
  SessionLogPage,
  SessionLogQuery,
  SessionLogReader,
} from "../domain/logging.js";
import type { JsonObject } from "../domain/types.js";

const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
const cursorPattern = new RegExp(SESSION_LOG_CURSOR_PATTERN);

export interface SessionLogReaderOptions {
  /** Absolute path of the Gateway log (`<dataDir>/logs/gateway.log`). */
  gatewayLog: string;
  /** Absolute path of a Session's engine log. */
  engineLog: (sessionId: string) => string;
  /** Applied to every line before parsing; the files are already redacted when written. */
  redact: (text: string) => string;
  /** Rotated generations next to each file (`.1` … `.N`); default 3, as written by JsonLogFile. */
  generations?: number;
  /** Bytes read per request across a file and its rotations; default 32 MiB. */
  scanBytes?: number;
  /** Largest total size of the returned lines; default 2 MiB. */
  maxResponseBytes?: number;
  /**
   * Route of the log read itself. Its access lines are left out of Gateway pages so a
   * console polling the log does not fill the page with its own requests.
   */
  ownRoute?: string;
}

interface Generation {
  handle: FileHandle;
  id: bigint;
  /** End of the last complete line that this read may consume. */
  end: number;
}

interface Budget {
  remaining: number;
  exhausted: boolean;
}

interface Entry {
  record: JsonObject;
  bytes: number;
}

function invalid(message: string): HubError {
  return new HubError("INVALID_REQUEST", message, 400);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Offset after the last newline in `[0, size)`; bytes after it are a line still being written. */
async function completeEnd(handle: FileHandle, size: number): Promise<number> {
  let position = size;
  while (position > 0) {
    const length = Math.min(CHUNK_BYTES, position);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      position - length,
    );
    const index = buffer.subarray(0, bytesRead).lastIndexOf(NEWLINE);
    if (index >= 0) return position - length + index + 1;
    position -= length;
  }
  return 0;
}

/** Complete lines of `[0, end)`, newest first, while the budget lasts. */
async function* backward(
  generation: Generation,
  budget: Budget,
): AsyncGenerator<Buffer> {
  let position = generation.end;
  let carry = Buffer.alloc(0);
  while (position > 0) {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      return;
    }
    const length = Math.min(CHUNK_BYTES, position, budget.remaining);
    const buffer = Buffer.allocUnsafe(length);
    await generation.handle.read(buffer, 0, length, position - length);
    position -= length;
    budget.remaining -= length;
    const data = carry.length ? Buffer.concat([buffer, carry]) : buffer;
    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index--) {
      if (data[index] !== NEWLINE) continue;
      if (index + 1 < lineEnd) yield data.subarray(index + 1, lineEnd);
      lineEnd = index;
    }
    carry = data.subarray(0, lineEnd);
  }
  if (carry.length) yield carry;
}

/** Complete lines of `[start, end)`, oldest first. `start` is a line boundary. */
async function* forward(
  generation: Generation,
  start: number,
): AsyncGenerator<Buffer> {
  let position = start;
  let carry = Buffer.alloc(0);
  while (position < generation.end) {
    const length = Math.min(CHUNK_BYTES, generation.end - position);
    const buffer = Buffer.allocUnsafe(length);
    await generation.handle.read(buffer, 0, length, position);
    position += length;
    const data = carry.length ? Buffer.concat([carry, buffer]) : buffer;
    let lineStart = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== NEWLINE) continue;
      if (index > lineStart) yield data.subarray(lineStart, index);
      lineStart = index + 1;
    }
    carry = data.subarray(lineStart);
  }
  if (carry.length) yield carry;
}

/**
 * {@link SessionLogReader} over the JSON Lines files written by JsonLogFile.
 *
 * Without `after` it returns the newest `limit` records of the Session (reading the
 * current file and its rotations backwards within the scan budget). With `after` it
 * returns the records written since that cursor; when the cursor's generation was
 * rotated away or the data since it exceeds the scan budget it falls back to the
 * newest records and reports `truncated`. Engine pages contain every record of the
 * Session's engine log; Gateway pages contain the records naming the Session or one
 * of its Runs. Every line is redacted again and must parse as a JSON object with
 * string `time` and `event`, else it is counted in `skipped`. Files are opened
 * read-only and closed before the promise settles.
 */
export function createSessionLogReader(
  options: SessionLogReaderOptions,
): SessionLogReader {
  const generations = options.generations ?? 3;
  const scanBytes = options.scanBytes ?? 32 * 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;

  const openGenerations = async (file: string): Promise<Generation[]> => {
    const opened: Generation[] = [];
    try {
      for (let index = 0; index <= generations; index++) {
        const path = index === 0 ? file : `${file}.${index}`;
        let handle: FileHandle;
        try {
          handle = await open(path, "r");
        } catch (error) {
          if (isMissing(error)) continue;
          throw error;
        }
        try {
          const stats = await handle.stat({ bigint: true });
          const size = Number(stats.size);
          opened.push({
            handle,
            id: stats.ino,
            // Only the newest generation can end in a line that is still being written.
            end: opened.length === 0 ? await completeEnd(handle, size) : size,
          });
        } catch (error) {
          await handle.close();
          throw error;
        }
      }
      return opened;
    } catch (error) {
      await Promise.allSettled(opened.map((item) => item.handle.close()));
      throw error;
    }
  };

  return {
    async read(query: SessionLogQuery): Promise<SessionLogPage> {
      if (
        !Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > SESSION_LOG_MAX_LIMIT
      )
        throw invalid(`limit must be 1 to ${SESSION_LOG_MAX_LIMIT}`);
      if (query.after !== undefined && !cursorPattern.test(query.after))
        throw invalid("after must be a cursor returned by an earlier page");
      const file =
        query.source === "engine"
          ? options.engineLog(query.sessionId)
          : options.gatewayLog;
      const runIds = new Set(query.runIds);
      const needles = [query.sessionId, ...runIds];
      const belongs = (record: JsonObject): boolean => {
        if (query.source === "engine") return true;
        if (
          options.ownRoute !== undefined &&
          record.event === "http" &&
          record.route === options.ownRoute
        )
          return false;
        for (const key of ["sessionId", "id", "runId"] as const) {
          const value = record[key];
          if (
            typeof value === "string" &&
            (value === query.sessionId || runIds.has(value))
          )
            return true;
        }
        return false;
      };
      let skipped = 0;
      const parse = (line: Buffer): Entry | undefined => {
        const text = line.toString("utf8");
        // Cheap prefilter for the shared Gateway log; exact matching follows.
        if (
          query.source === "gateway" &&
          !needles.some((needle) => text.includes(needle))
        )
          return undefined;
        let value: unknown;
        try {
          value = JSON.parse(options.redact(text));
        } catch {
          skipped++;
          return undefined;
        }
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof (value as JsonObject).time !== "string" ||
          typeof (value as JsonObject).event !== "string"
        ) {
          skipped++;
          return undefined;
        }
        const record = value as JsonObject;
        return belongs(record) ? { record, bytes: line.length } : undefined;
      };

      let opened: Generation[];
      try {
        opened = await openGenerations(file);
      } catch (error) {
        throw new HubError(
          "LOG_READ_FAILED",
          `Diagnostic log could not be read: ${error instanceof Error ? error.message : String(error)}`,
          500,
        );
      }
      try {
        const newest = opened[0];
        if (!newest)
          return {
            source: query.source,
            file,
            exists: false,
            records: [],
            cursor: null,
            truncated: false,
            skipped: 0,
          };
        const cursor = `${newest.id}:${newest.end}`;
        let truncated = false;
        let entries: Entry[] | undefined;

        const after = query.after?.split(":");
        if (after) {
          const id = BigInt(after[0]!);
          const offset = Number(after[1]);
          const start = opened.findIndex((item) => item.id === id);
          const pending =
            start < 0 || offset > opened[start]!.end
              ? Number.POSITIVE_INFINITY
              : opened
                  .slice(0, start + 1)
                  .reduce(
                    (sum, item, index) =>
                      sum + item.end - (index === start ? offset : 0),
                    0,
                  );
          if (pending <= scanBytes) {
            entries = [];
            for (let index = start; index >= 0; index--)
              for await (const line of forward(
                opened[index]!,
                index === start ? offset : 0,
              )) {
                const entry = parse(line);
                if (entry) entries.push(entry);
              }
            if (entries.length > query.limit) {
              entries = entries.slice(-query.limit);
              truncated = true;
            }
          } else truncated = true;
        }

        if (!entries) {
          const budget: Budget = { remaining: scanBytes, exhausted: false };
          const newestFirst: Entry[] = [];
          scan: for (const generation of opened)
            for await (const line of backward(generation, budget)) {
              const entry = parse(line);
              if (!entry) continue;
              if (newestFirst.length === query.limit) {
                truncated = true;
                break scan;
              }
              newestFirst.push(entry);
            }
          if (budget.exhausted) truncated = true;
          entries = newestFirst.reverse();
        }

        let size = entries.reduce((sum, entry) => sum + entry.bytes, 0);
        let first = 0;
        while (size > maxResponseBytes && first < entries.length) {
          size -= entries[first]!.bytes;
          first++;
          truncated = true;
        }
        return {
          source: query.source,
          file,
          exists: true,
          records: entries.slice(first).map((entry) => entry.record),
          cursor,
          truncated,
          skipped,
        };
      } finally {
        await Promise.allSettled(opened.map((item) => item.handle.close()));
      }
    },
  };
}
