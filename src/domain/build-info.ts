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
  commit: string;
  commitDate: string;
  ref: string;
  dirty: boolean | "unknown";
  builtAt: string;
  workflowRun: string | null;
  os: string;
  arch: string;
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
  for (const field of STRING_FIELDS)
    if (typeof record[field] !== "string" || record[field] === "")
      throw invalid(`${field} must be a non-empty string`);
  if (typeof record.dirty !== "boolean" && record.dirty !== "unknown")
    throw invalid('dirty must be a boolean or "unknown"');
  if (record.workflowRun !== null && typeof record.workflowRun !== "string")
    throw invalid("workflowRun must be a string or null");
  return record as unknown as BuildInfo;
}
