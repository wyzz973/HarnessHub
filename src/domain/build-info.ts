// SPDX-License-Identifier: MIT
import { HubError } from "./errors.js";

/**
 * Identity of the running build, written by `scripts/build-info.mjs` at build
 * time (fields in docs/proposals/oss/10-engineering.md section 5). Values the
 * build could not determine are the literal "unknown".
 */
export interface BuildInfo {
  version: string;
  channel: string;
  /** Full commit hash, or "unknown". */
  commit: string;
  /** Committer date of `commit` (ISO 8601), or "unknown". */
  commitDate: string;
  /** Git ref that was built, or "unknown" (including a detached HEAD). */
  ref: string;
  /** Whether tracked or untracked non-ignored files differed from `commit`. */
  dirty: boolean | "unknown";
  builtAt: string;
  /** URL of the CI run that built it, or null for a local build. */
  workflowRun: string | null;
  /** Platform of the build machine; the running process may differ. */
  os: string;
  /** Architecture of the build machine. */
  arch: string;
  /** Node.js that ran the build, not necessarily the one running now. */
  nodeVersion: string;
  installMethod: string;
}

const STRING_FIELDS = [
  "version",
  "channel",
  "commit",
  "commitDate",
  "ref",
  "builtAt",
  "os",
  "arch",
  "nodeVersion",
  "installMethod",
] as const;

/**
 * Validate a parsed build-info.json.
 *
 * @throws HubError `BUILD_INFO_INVALID` when a field is missing, has the wrong
 *   type, or the object carries unknown fields.
 */
export function parseBuildInfo(raw: unknown): BuildInfo {
  const invalid = (detail: string) =>
    new HubError(
      "BUILD_INFO_INVALID",
      `build-info.json is invalid: ${detail}`,
      500,
    );
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw invalid("expected an object");
  const record = raw as Record<string, unknown>;
  const known = new Set<string>([...STRING_FIELDS, "dirty", "workflowRun"]);
  const extra = Object.keys(record).filter((key) => !known.has(key));
  if (extra.length) throw invalid(`unknown fields ${extra.join(", ")}`);
  if (typeof record.dirty !== "boolean" && record.dirty !== "unknown")
    throw invalid('dirty must be a boolean or "unknown"');
  if (record.workflowRun !== null && typeof record.workflowRun !== "string")
    throw invalid("workflowRun must be a string or null");
  const text = (field: (typeof STRING_FIELDS)[number]): string => {
    const value = record[field];
    if (typeof value !== "string" || value === "")
      throw invalid(`${field} must be a non-empty string`);
    return value;
  };
  return {
    version: text("version"),
    channel: text("channel"),
    commit: text("commit"),
    commitDate: text("commitDate"),
    ref: text("ref"),
    dirty: record.dirty,
    builtAt: text("builtAt"),
    workflowRun: record.workflowRun,
    os: text("os"),
    arch: text("arch"),
    nodeVersion: text("nodeVersion"),
    installMethod: text("installMethod"),
  };
}
