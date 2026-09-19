import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundlePath, keys, object, string } from "./manifest.js";

/** Bundle-relative list of Tool Packs the release applies on first start. */
export const PREINSTALLED_LIST = "tool-packs/preinstalled.json";
/** Marker under `state/` recording what the entry points already applied. */
export const PREINSTALL_MARKER = "preinstalled-tool-packs.json";
/** `0` disables preinstalled Tool Packs; unset or `1` enables them. Anything else is rejected. */
export const PREINSTALL_ENVIRONMENT = "HARNESSHUB_PREINSTALL_TOOL_PACKS";

const DIRECTORY = /^[a-z][a-z0-9-]{0,31}$/;
const MESSAGE_LIMIT = 300;

/** One preinstalled pack: a directory directly under `<bundle>/tool-packs/`. */
export interface PreinstalledPack {
  directory: string;
  /** Absolute source directory inside the bundle. */
  source: string;
}

export interface PreinstallEngineResult {
  engineId: string;
  status: "applied" | "skipped" | "failed";
  code?: string;
  reason?: string;
}

/** What the entry point last applied for one listed directory. */
export interface PreinstallMarkerEntry {
  /** Import digest of the pack content that was applied. */
  digest: string;
  package: { id: string; version: string };
  appliedAt: number;
  results: PreinstallEngineResult[];
}

/**
 * Result of one listed directory in one entry-point start.
 * - `applied`: new content was imported and bound; the marker now has its digest.
 * - `unchanged`: the marker already has this digest; nothing was touched, so bindings
 *   the user removed later stay removed.
 * - `incomplete`: imported, but at least one engine failed for a reason other than
 *   incompatibility; the marker is not advanced and the next start tries again.
 * - `failed`: the pack could not be inspected or imported; nothing was bound.
 */
export interface PreinstallOutcome {
  directory: string;
  status: "applied" | "unchanged" | "incomplete" | "failed";
  package?: { id: string; version: string };
  digest?: string;
  results?: PreinstallEngineResult[];
  code?: string;
  message?: string;
}

export interface PreinstallMarker {
  schemaVersion: 1;
  packs: Record<string, PreinstallMarkerEntry>;
  /** Outcomes of the latest entry-point start; the Gateway copies them into its log. */
  lastRun?: { at: number; outcomes: PreinstallOutcome[] };
}

/**
 * Parse {@link PREINSTALL_ENVIRONMENT}. Unset, empty or `1` enables preinstalled Tool
 * Packs and `0` disables them; any other value throws so a typo cannot silently change
 * what engines receive.
 */
export function preinstallEnabled(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  const value = environment[PREINSTALL_ENVIRONMENT]?.trim();
  if (value === undefined || value === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${PREINSTALL_ENVIRONMENT} must be 0 or 1`);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function bounded(value: unknown, label: string): string {
  return string(value, label).slice(0, MESSAGE_LIMIT);
}

/**
 * Read `<bundle>/tool-packs/preinstalled.json`. A bundle without the file has no
 * preinstalled packs. Directory names are single lower-case path segments, so a list
 * can never point outside `tool-packs/`. Invalid content throws.
 */
export async function readPreinstalledList(
  bundleRoot: string,
): Promise<PreinstalledPack[]> {
  let text: string;
  try {
    text = await readFile(bundlePath(bundleRoot, PREINSTALLED_LIST), "utf8");
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  // Windows editors may add a byte-order mark.
  const value = object(
    JSON.parse(text.replace(/^\uFEFF/, "")) as unknown,
    "preinstalled Tool Pack list",
  );
  keys(value, ["schemaVersion", "packs"], "preinstalled Tool Pack list");
  if (value.schemaVersion !== 1 || !Array.isArray(value.packs))
    throw new Error("Unsupported preinstalled Tool Pack list");
  if (value.packs.length > 16)
    throw new Error("A bundle lists at most 16 preinstalled Tool Packs");
  const seen = new Set<string>();
  return value.packs.map((entry: unknown) => {
    const row = object(entry, "preinstalled Tool Pack");
    keys(row, ["directory"], "preinstalled Tool Pack");
    const directory = string(row.directory, "preinstalled Tool Pack directory");
    if (!DIRECTORY.test(directory) || seen.has(directory))
      throw new Error(
        `Invalid or repeated preinstalled Tool Pack directory: ${directory}`,
      );
    seen.add(directory);
    return {
      directory,
      source: bundlePath(bundleRoot, `tool-packs/${directory}`),
    };
  });
}

function engineResults(
  value: unknown,
  label: string,
): PreinstallEngineResult[] {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error(`${label} must be an array`);
  return value.map((entry: unknown) => {
    const row = object(entry, label);
    keys(row, ["engineId", "status", "code", "reason"], label);
    const status = string(row.status, `${label} status`);
    if (status !== "applied" && status !== "skipped" && status !== "failed")
      throw new Error(`${label} status is invalid`);
    return {
      engineId: string(row.engineId, `${label} engineId`),
      status,
      ...(row.code !== undefined ? { code: bounded(row.code, label) } : {}),
      ...(row.reason !== undefined
        ? { reason: bounded(row.reason, label) }
        : {}),
    };
  });
}

function packageReference(
  value: unknown,
  label: string,
): { id: string; version: string } {
  const row = object(value, label);
  keys(row, ["id", "version"], label);
  return {
    id: string(row.id, `${label} id`),
    version: string(row.version, `${label} version`),
  };
}

function digest(value: unknown, label: string): string {
  const text = string(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} is invalid`);
  return value as number;
}

function outcome(value: unknown): PreinstallOutcome {
  const label = "preinstall outcome";
  const row = object(value, label);
  keys(
    row,
    ["directory", "status", "package", "digest", "results", "code", "message"],
    label,
  );
  const status = string(row.status, `${label} status`);
  if (
    status !== "applied" &&
    status !== "unchanged" &&
    status !== "incomplete" &&
    status !== "failed"
  )
    throw new Error(`${label} status is invalid`);
  return {
    directory: string(row.directory, `${label} directory`),
    status,
    ...(row.package !== undefined
      ? { package: packageReference(row.package, `${label} package`) }
      : {}),
    ...(row.digest !== undefined
      ? { digest: digest(row.digest, `${label} digest`) }
      : {}),
    ...(row.results !== undefined
      ? { results: engineResults(row.results, `${label} result`) }
      : {}),
    ...(row.code !== undefined ? { code: bounded(row.code, label) } : {}),
    ...(row.message !== undefined
      ? { message: bounded(row.message, label) }
      : {}),
  };
}

/** Validate marker content; unknown fields, versions and shapes throw. */
export function parsePreinstallMarker(input: unknown): PreinstallMarker {
  const label = "preinstalled Tool Pack marker";
  const value = object(input, label);
  keys(value, ["schemaVersion", "packs", "lastRun"], label);
  if (value.schemaVersion !== 1) throw new Error(`Unsupported ${label}`);
  const packs: Record<string, PreinstallMarkerEntry> = {};
  for (const [directory, entry] of Object.entries(
    object(value.packs, `${label} packs`),
  )) {
    if (!DIRECTORY.test(directory))
      throw new Error(`${label} names an invalid directory`);
    const row = object(entry, `${label} entry`);
    keys(row, ["digest", "package", "appliedAt", "results"], `${label} entry`);
    packs[directory] = {
      digest: digest(row.digest, `${label} digest`),
      package: packageReference(row.package, `${label} package`),
      appliedAt: timestamp(row.appliedAt, `${label} appliedAt`),
      results: engineResults(row.results, `${label} result`),
    };
  }
  let lastRun: PreinstallMarker["lastRun"];
  if (value.lastRun !== undefined) {
    const run = object(value.lastRun, `${label} lastRun`);
    keys(run, ["at", "outcomes"], `${label} lastRun`);
    if (!Array.isArray(run.outcomes) || run.outcomes.length > 16)
      throw new Error(`${label} lastRun outcomes are invalid`);
    lastRun = {
      at: timestamp(run.at, `${label} lastRun at`),
      outcomes: run.outcomes.map(outcome),
    };
  }
  return { schemaVersion: 1, packs, ...(lastRun ? { lastRun } : {}) };
}

/**
 * Read a marker file. A missing file is an empty marker (nothing applied yet); an
 * unreadable or invalid file throws, because guessing would either re-bind packs the
 * user removed or skip packs that were never applied.
 */
export async function readPreinstallMarker(
  file: string,
): Promise<PreinstallMarker> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return { schemaVersion: 1, packs: {} };
    throw error;
  }
  return parsePreinstallMarker(JSON.parse(text) as unknown);
}

/** Atomic replacement: a failed write keeps the previous marker. */
export async function writePreinstallMarker(
  file: string,
  marker: PreinstallMarker,
): Promise<void> {
  const checked = parsePreinstallMarker(marker);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
