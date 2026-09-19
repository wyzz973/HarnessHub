import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** Upper bound, in characters (code points), of any error text crossing IPC. */
export const PUBLIC_ERROR_LIMIT = 500;

/** Replaces sensitive text; pure and safe to call on any string. */
export type Redactor = (text: string) => string;

/**
 * Redact one Session's secrets from text. `secrets` is read on every call, so
 * values resolved later in the Session are covered without rebuilding the
 * redactor. Known values are replaced first, then credential shapes: `Bearer`
 * tokens, `sk-` keys and `token`/`key`/`secret`/`password`/`authorization`
 * assignments. Values shorter than 4 characters are ignored to avoid
 * destroying ordinary text.
 */
export function createRedactor(secrets: ReadonlySet<string>): Redactor {
  return (text) => {
    let output = text;
    const values = [...secrets]
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
    for (const value of values) output = output.split(value).join("[REDACTED]");
    return output
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[REDACTED]")
      .replace(
        /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;&]+/gi,
        "$1[REDACTED]",
      );
  };
}

/** Truncate to {@link PUBLIC_ERROR_LIMIT} code points without splitting a character. */
export function truncatePublic(text: string): string {
  const characters = Array.from(text.trim());
  return characters.length <= PUBLIC_ERROR_LIMIT
    ? characters.join("")
    : `${characters.slice(0, PUBLIC_ERROR_LIMIT - 1).join("")}…`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Describe an unexpected error from its whole chain: the top-level class name
 * and message, JSON-RPC `data.message`/`details`, acpx `acp` payloads and
 * `cause` links (depth-limited, cycles ignored). Messages already contained in
 * an earlier part are skipped. The result is NOT redacted.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const add = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !parts.some((part) => part.includes(trimmed)))
      parts.push(trimmed);
  };
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      add(value);
      return;
    }
    const fields = record(value);
    if (!fields || seen.has(value)) return;
    seen.add(value);
    if (typeof fields.message === "string")
      add(
        depth === 0 &&
          value instanceof Error &&
          value.name &&
          value.name !== "Error"
          ? `${value.name}: ${fields.message}`
          : fields.message,
      );
    else if (depth === 0 && value instanceof Error) add(value.name);
    for (const key of ["details", "detail", "reason"])
      if (typeof fields[key] === "string") add(fields[key]);
    for (const key of ["data", "acp", "error", "cause"])
      visit(fields[key], depth + 1);
  };
  visit(error, 0);
  return parts.join(": ") || "Unknown engine error";
}

/** Public text for an unexpected error: described, redacted and bounded. */
export function publicErrorMessage(error: unknown, redact: Redactor): string {
  return truncatePublic(redact(describeError(error)));
}

function stackReport(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const prefix = depth === 0 ? "" : "caused by: ";
    if (current instanceof Error)
      lines.push(
        prefix + (current.stack ?? `${current.name}: ${current.message}`),
      );
    else lines.push(prefix + String(current));
    const fields = record(current);
    for (const key of ["code", "data", "acp"])
      if (fields?.[key] !== undefined) {
        let text: string;
        try {
          text = JSON.stringify(fields[key]) ?? String(fields[key]);
        } catch {
          text = "[unserializable]";
        }
        lines.push(`${key}: ${text.slice(0, 16_384)}`);
      }
    current = fields?.cause;
  }
  return lines.join("\n");
}

/**
 * Append one redacted diagnostic entry, including the full stack and cause
 * chain, to `<stateDir>/diagnostics/worker-errors.log`. The directory is
 * created 0700 and the file 0600 (POSIX modes; Windows relies on the private
 * Session directory ACL). Resolves after the append completes; rejects on
 * filesystem errors, which callers treat as non-fatal to the Run result.
 */
export async function appendDiagnostic(
  stateDir: string,
  entry: { runId: string; generation: number; error: unknown },
  redact: Redactor,
): Promise<string> {
  const directory = path.join(stateDir, "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "worker-errors.log");
  const text = `[${new Date().toISOString()}] run=${entry.runId} generation=${entry.generation}\n${stackReport(entry.error)}\n\n`;
  await appendFile(file, redact(text), { mode: 0o600 });
  return file;
}
