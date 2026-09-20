import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PREINSTALLED_LIST,
  PREINSTALL_MARKER,
  readPreinstalledList,
  readPreinstallMarker,
  writePreinstallMarker,
  type PreinstallEngineResult,
  type PreinstallMarker,
  type PreinstallOutcome,
  type PreinstalledPack,
} from "./distribution/preinstalled.js";
import type { BundleContext, BundleManifest } from "./distribution/types.js";
import type { LogSink } from "./domain/logging.js";
import type { JsonValue } from "./domain/types.js";
import { inspectImport } from "./tool-packages/index.js";
import type { ToolPackageManagementService } from "./tool-packages/management.js";
import { installToolPackIntoBundle } from "./tool-packages-oneclick-main.js";

const MESSAGE_LIMIT = 300;
/** Gateway-side memory of the pack digests it already reconciled with engine overrides. */
export const PREINSTALL_ENSURED = "preinstalled-tool-packs.ensured.json";

export interface PreinstallReport {
  enabled: boolean;
  /** Marker path handed to the Gateway (`startHub({ preinstalledToolPacks })`). */
  markerFile: string;
  outcomes: PreinstallOutcome[];
}

function describe(error: unknown): { code: string; message: string } {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "PREINSTALL_FAILED";
  return {
    code,
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      MESSAGE_LIMIT,
    ),
  };
}

function summary(outcome: PreinstallOutcome): string {
  const name = outcome.package
    ? `${outcome.package.id} ${outcome.package.version}`
    : outcome.directory;
  const count = (status: PreinstallEngineResult["status"]) =>
    outcome.results?.filter((result) => result.status === status).length ?? 0;
  switch (outcome.status) {
    case "unchanged":
      return `Preinstalled Tool Pack ${name}: unchanged`;
    case "applied":
      return `Preinstalled Tool Pack ${name}: applied to ${count("applied")} engine(s), ${count("skipped")} skipped`;
    case "incomplete":
      return `Preinstalled Tool Pack ${name}: ${count("failed")} engine(s) failed (${count("applied")} applied); the next start tries again`;
    case "failed":
      return `Preinstalled Tool Pack ${name} was not installed (${outcome.code ?? "PREINSTALL_FAILED"}): ${outcome.message ?? "unknown error"}; the Gateway starts without it`;
  }
}

/**
 * Entry-point phase of preinstalled Tool Packs, run by `gateway.cmd` and
 * `hub.cmd start` before they read `state/settings.json` for the Gateway
 * configuration, so the first Session already has the packs.
 *
 * For every directory in `<bundle>/tool-packs/preinstalled.json` the content digest is
 * computed without touching the store. A digest already recorded in
 * `state/preinstalled-tool-packs.json` is left alone (bindings the user removed stay
 * removed); a new digest is imported and bound to every bundled engine through the same
 * settings path as Install-Tool-Pack.cmd with replace semantics, incompatible engines
 * are skipped, and the marker advances only when no engine failed.
 *
 * Never throws and never blocks startup: every problem becomes a `failed` or
 * `incomplete` outcome, is passed to `report` as one line and is stored in the
 * marker's `lastRun` for the Gateway log. `enabled: false` does nothing at all.
 */
export async function preinstallToolPacks(
  context: BundleContext,
  manifest: BundleManifest,
  options: {
    enabled: boolean;
    commandMcpEntry: string;
    /** Receives one human-readable line per pack that changed or failed. */
    report?: (line: string) => void;
    now?: () => number;
  },
): Promise<PreinstallReport> {
  const markerFile = path.join(context.state, PREINSTALL_MARKER);
  const outcomes: PreinstallOutcome[] = [];
  const finish = (): PreinstallReport => {
    for (const outcome of outcomes)
      if (outcome.status !== "unchanged") options.report?.(summary(outcome));
    return { enabled: options.enabled, markerFile, outcomes };
  };
  if (!options.enabled) return finish();

  let packs: PreinstalledPack[];
  try {
    packs = await readPreinstalledList(context.root);
  } catch (error) {
    outcomes.push({
      directory: PREINSTALLED_LIST,
      status: "failed",
      ...describe(error),
    });
    return finish();
  }
  if (!packs.length) return finish();

  let marker: PreinstallMarker;
  try {
    marker = await readPreinstallMarker(markerFile);
  } catch (error) {
    // Guessing here could re-bind packs the user removed, so nothing is applied.
    const failure = describe(error);
    for (const pack of packs)
      outcomes.push({
        directory: pack.directory,
        status: "failed",
        code: "PREINSTALL_MARKER_UNREADABLE",
        message:
          `${failure.message}; fix or delete state/${PREINSTALL_MARKER} to apply preinstalled packs again`.slice(
            0,
            MESSAGE_LIMIT,
          ),
      });
    return finish();
  }

  // A directory the bundle no longer lists is no longer reported as preinstalled;
  // its bindings stay until the user removes them.
  marker.packs = Object.fromEntries(
    Object.entries(marker.packs).filter(([directory]) =>
      packs.some((pack) => pack.directory === directory),
    ),
  );
  const now = options.now ?? Date.now;
  for (const pack of packs) {
    try {
      const inspection = await inspectImport(pack.source);
      const previous = marker.packs[pack.directory];
      if (previous?.digest === inspection.digest) {
        outcomes.push({
          directory: pack.directory,
          status: "unchanged",
          package: previous.package,
          digest: inspection.digest,
        });
        continue;
      }
      const installed = await installToolPackIntoBundle(
        context,
        manifest,
        { source: pack.source, engines: "all", replace: true },
        options.commandMcpEntry,
      );
      const selected = {
        id: installed.package.id,
        version: installed.package.version,
      };
      const results: PreinstallEngineResult[] = installed.results.map(
        (result) => ({
          engineId: result.engineId,
          status: result.status,
          ...(result.code ? { code: result.code } : {}),
          ...(result.reason
            ? { reason: result.reason.slice(0, MESSAGE_LIMIT) }
            : {}),
        }),
      );
      const failed = results.some((result) => result.status === "failed");
      if (!failed)
        marker.packs[pack.directory] = {
          digest: inspection.digest,
          package: selected,
          appliedAt: now(),
          results,
        };
      outcomes.push({
        directory: pack.directory,
        status: failed ? "incomplete" : "applied",
        package: selected,
        digest: inspection.digest,
        results,
      });
    } catch (error) {
      outcomes.push({
        directory: pack.directory,
        status: "failed",
        ...describe(error),
      });
    }
  }
  marker.lastRun = { at: now(), outcomes };
  try {
    await writePreinstallMarker(markerFile, marker);
  } catch (error) {
    options.report?.(
      `Preinstalled Tool Pack marker could not be written (${describe(error).message}); packs applied now are applied again at the next start`,
    );
  }
  return finish();
}

interface EnsuredPacks {
  schemaVersion: 1;
  /** Listed directory -> pack digest already reconciled in this data directory. */
  packs: Record<string, string>;
}

async function readEnsured(file: string): Promise<EnsuredPacks> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { schemaVersion: 1, packs: {} };
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("packs" in value) ||
    typeof value.packs !== "object" ||
    value.packs === null ||
    Array.isArray(value.packs) ||
    !Object.values(value.packs).every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    )
  )
    throw new Error("Unsupported ensured Tool Pack record");
  return {
    schemaVersion: 1,
    packs: { ...(value.packs as Record<string, string>) },
  };
}

async function writeEnsured(file: string, value: EnsuredPacks): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function logged(outcome: PreinstallOutcome): Record<string, JsonValue> {
  return {
    phase: "settings",
    directory: outcome.directory,
    status: outcome.status,
    ...(outcome.package ? { package: outcome.package } : {}),
    ...(outcome.digest ? { digest: outcome.digest } : {}),
    ...(outcome.results
      ? {
          results: outcome.results.map((result) => ({
            engineId: result.engineId,
            status: result.status,
            ...(result.code ? { code: result.code } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          })),
        }
      : {}),
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
  };
}

/**
 * Gateway phase of preinstalled Tool Packs; the composition root awaits it after
 * engine management exists and before the listener opens.
 *
 * It copies the entry point's latest outcomes into the Gateway log as
 * `toolpack.preinstall` records (`phase: "settings"`). Then, once per pack digest and
 * data directory, it binds the pack on engines the marker reports as applied but whose
 * current registration does not contain it — the case of an engine override saved
 * through the console, which hides `state/settings.json` (`phase: "overrides"`).
 * Engines that already contain the version are skipped and get no override, so
 * settings stay their source of truth. The reconciled digest is remembered in
 * `<dataDir>/preinstalled-tool-packs.ensured.json`; later starts leave the pack alone,
 * which keeps bindings removed by the user removed.
 *
 * Never throws: unreadable files, an unknown package or failing engines are logged and
 * the Gateway continues. An engine failure leaves the digest unrecorded for a retry at
 * the next start.
 */
export async function ensurePreinstalledToolPacks(options: {
  markerFile: string;
  dataDir: string;
  toolPackages: Pick<ToolPackageManagementService, "ensure">;
  log: LogSink;
}): Promise<void> {
  const { log } = options;
  const ensuredFile = path.join(options.dataDir, PREINSTALL_ENSURED);
  let marker: PreinstallMarker;
  let ensured: EnsuredPacks;
  try {
    marker = await readPreinstallMarker(options.markerFile);
    ensured = await readEnsured(ensuredFile);
  } catch (error) {
    log.info("toolpack.preinstall", {
      phase: "overrides",
      status: "failed",
      ...describe(error),
    });
    return;
  }
  for (const outcome of marker.lastRun?.outcomes ?? [])
    log.info("toolpack.preinstall", logged(outcome));
  for (const [directory, entry] of Object.entries(marker.packs)) {
    if (ensured.packs[directory] === entry.digest) continue;
    const targets = entry.results
      .filter((result) => result.status === "applied")
      .map((result) => result.engineId);
    try {
      const response = await options.toolPackages.ensure(
        entry.package,
        targets,
      );
      const failed = response.results.filter(
        (result) => result.status === "failed",
      );
      log.info("toolpack.preinstall", {
        phase: "overrides",
        directory,
        status: failed.length ? "incomplete" : "applied",
        package: entry.package,
        digest: entry.digest,
        applied: response.results
          .filter((result) => result.status === "applied")
          .map((result) => result.engineId),
        skipped: response.results.filter(
          (result) => result.status === "skipped",
        ).length,
        failed: failed.map((result) => ({
          engineId: result.engineId,
          code: result.code ?? "TOOL_PACKAGE_APPLY_FAILED",
          reason: (result.reason ?? "").slice(0, MESSAGE_LIMIT),
        })),
      });
      if (failed.length) continue;
      ensured.packs[directory] = entry.digest;
      await writeEnsured(ensuredFile, ensured);
    } catch (error) {
      log.info("toolpack.preinstall", {
        phase: "overrides",
        directory,
        status: "failed",
        package: entry.package,
        ...describe(error),
      });
    }
  }
}

/** Package versions currently recorded as preinstalled; an unreadable marker rejects. */
export async function preinstalledPackages(
  markerFile: string,
): Promise<{ id: string; version: string }[]> {
  return Object.values((await readPreinstallMarker(markerFile)).packs).map(
    (entry) => entry.package,
  );
}
