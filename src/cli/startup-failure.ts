import { userInfo } from "node:os";
import { SessionError } from "../contracts/session.js";
import { scrubDiagnostics } from "../web/run-diagnostics.js";

/*
 * What a person is told when a command or the service cannot start or stops on a failure. A code alone ("STORAGE_UNAVAILABLE — local web application could not run") says nothing they can act
 * on; the reason does: SQLite names the table, the column or the rule it met, and the files and the lock name what they failed at. So a failure of the storage the data directory is kept in is told
 * with the reason it was made of (its cause, down the chain), and any other with its own words. What is told has passed the redaction a diagnostics report passes (credentials, environment
 * values, the account name, paths) and any other absolute path as well: a reason names a table or a column, never a conversation, a file of the user's or the place a root is kept.
 */

/** The failures of the storage of the data directory: what SQLite or the files said is the reason, and it names tables, columns, rules and locks. */
const STORAGE_CODES: ReadonlySet<string> = new Set(["STORAGE_UNAVAILABLE", "STORAGE_CHANGED", "INVALID_STORAGE", "STORAGE_BACKUP_FAILED", "STORE_CLOSED", "OWNER_LOST", "OWNER_BUSY",
  "OWNER_UNCONFIRMED", "INVALID_DATA", "SCHEMA_MISMATCH", "WORKSPACE_STORAGE", "DATABASE_CHANGED"]);
/** An absolute path of any shape, two segments or more, for what the prefixes the diagnostics' redaction knows leave. */
const ANY_PATH = /(?<![\w.:~/])\/(?:[^\s"'<>|:;,()[\]{}/]+\/)+[^\s"'<>|:;,()[\]{}/]*/gu;
function account(): string | null { try { return userInfo().username; } catch { return null; } }

/** A text through the redaction of what is told at a failure: nothing in it names a credential, a path, or the person. */
export function scrubbed(text: string): string {
  return scrubDiagnostics(text, { redact: value => value, user: account() }).replace(ANY_PATH, "[路径]").replace(/\s+/gu, " ").trim();
}
/** The messages of a failure's causes, innermost last, at most four deep; empty when it has none. */
function causes(error: unknown): string[] {
  const found: string[] = [];
  for (let at = error instanceof Error ? error.cause : undefined; at !== undefined && at !== null && found.length < 4; at = at instanceof Error ? at.cause : undefined) {
    if (at instanceof Error) found.push(at.message); else { found.push(String(at)); break; }
  }
  return found;
}
/** What a failure of the storage was made of, as a text (`a; b`), redacted; null when the failure is not of the storage or has no cause to tell. */
export function storageCause(error: unknown): string | null {
  if (!(error instanceof SessionError) || !STORAGE_CODES.has(error.code)) return null;
  const text = causes(error).map(scrubbed).filter(part => part !== "").join("; ");
  return text === "" ? null : text.slice(0, 512);
}
/**
 * The reason a failure is told with. A failure of the storage: its own words and its cause's. Any other failure of ours: its own words. A failure that is not ours (a system error, a mistake): the code the
 * system gave and its message. Null for a thrown value that is no error.
 */
export function reasonOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof SessionError) {
    const cause = storageCause(error);
    return scrubbed(error.message).slice(0, 512) + (cause === null ? "" : " (" + cause + ")");
  }
  const code = (error as { code?: unknown }).code;
  return (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/u.test(code) ? code + ": " : "") + scrubbed(error.message).slice(0, 512);
}
