import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SecretReference } from "../domain/engine-configuration.js";
import type { EngineRegistration } from "../domain/engines.js";
import { HubError } from "../domain/errors.js";
import type { ToolPackageManagement } from "../domain/tool-packages.js";
import type { EngineProfile } from "../domain/types.js";
import { bindInstalled } from "./bind.js";
import {
  capabilities,
  footprint,
  isEmpty,
  ownedEntries,
  planBinding,
  withoutEntries,
  type PackageFootprint,
} from "./footprint.js";
import {
  importKinds,
  importLocal,
  slug,
  type ToolPackImportKind,
} from "./importer.js";
import {
  installLocal,
  listInstalled,
  listManifests,
  readManifest,
  verifyInstalled,
} from "./store.js";
import type { ToolPackageCapabilities, ToolPackageRecord } from "./types.js";

/** Engine view needed for binding; `capabilities` differs between callers and is not used. */
export type ToolPackageEngine = Omit<EngineProfile, "capabilities">;

export interface ToolPackageManagementOptions {
  root: string;
  nodeExecutable: string;
  commandMcpEntry: string;
  /** Enabled engine by id; throws ENGINE_UNAVAILABLE otherwise. */
  engineProfile(id: string): EngineProfile;
  /** Validates (prepareEngine) and publishes a new engine revision. */
  registerEngine(input: unknown): Promise<EngineProfile>;
  /**
   * Every registered engine including disabled ones. Required for
   * `engineIds: "all"`, unbinding from all engines and the per-package
   * `engines` list; without it those requests fail with 501.
   */
  listEngines?(): readonly ToolPackageEngine[];
  /**
   * Package versions the release preinstalled (see distribution/preinstalled.ts);
   * listings mark them with `preinstalled: true`. A rejected promise only drops
   * the marks, it never fails a listing.
   */
  preinstalled?(): Promise<readonly { id: string; version: string }[]>;
}

export type ToolPackTargets = "all" | string[];
export interface ToolPackEngineResult {
  engineId: string;
  status: "applied" | "skipped" | "failed";
  revision?: string;
  /** Machine-readable reason for skipped/failed results. */
  code?: string;
  /** Human-readable reason for skipped/failed results. */
  reason?: string;
  capabilities?: ToolPackageCapabilities;
  /** Other versions of the package removed by `replace: true`. */
  replaced?: string[];
}
export interface ToolPackApplyResponse {
  /** True when at least one engine was applied and none failed. */
  ok: boolean;
  package: { id: string; version: string };
  results: ToolPackEngineResult[];
  warnings: string[];
  note: string;
  /** Legacy single-engine fields, present only for `engineId` requests. */
  engineId?: string;
  revision?: string;
  capabilities?: ToolPackageCapabilities;
}
export interface ToolPackImportResponse {
  /** True when the import succeeded and, if requested, the apply result is ok. */
  ok: boolean;
  package: { id: string; version: string };
  displayName: string;
  digest: string;
  format: "tool-package" | "generated";
  counts: { skills: number; mcp: number; cli: number };
  warnings: string[];
  apply?: ToolPackApplyResponse;
}
export interface ToolPackUnbindResult {
  engineId: string;
  status: "unbound" | "skipped" | "failed";
  revision?: string;
  code?: string;
  reason?: string;
  removed?: { skills: string[]; mcp: string[] };
}
export interface ToolPackUnbindResponse {
  /** True when no engine failed; engines without the binding are skipped. */
  ok: boolean;
  package: { id: string; version: string };
  results: ToolPackUnbindResult[];
  note: string;
}
export interface ToolPackListing extends ToolPackageRecord {
  displayName?: string;
  counts?: { skills: number; mcp: number; cli: number };
  /** Engines whose current configuration contains this version; absent when engines cannot be listed. */
  engines?: string[];
  /** Present and true when the release preinstalled exactly this version. */
  preinstalled?: true;
  /** Why the stored manifest could not be read; the record is still listed. */
  problem?: { code: string; message: string };
}
/** Gateway-facing Tool Pack service; extends the domain port with import and unbind. */
export interface ToolPackageManagementService extends ToolPackageManagement {
  list(): Promise<{ packages: ToolPackListing[] }>;
  apply(input: unknown): Promise<ToolPackApplyResponse>;
  import(input: unknown): Promise<ToolPackImportResponse>;
  unbind(
    id: string,
    version: string,
    input: unknown,
  ): Promise<ToolPackUnbindResponse>;
  /**
   * Bind an installed version (replacing other versions of the package) only on
   * the named engines whose current configuration does not already contain it.
   * Engines that already have it, are disabled, unknown or incompatible are
   * `skipped` and keep their revision, so no engine override is created for
   * them. Used for preinstalled packs hidden by an existing engine override.
   */
  ensure(
    selected: { id: string; version: string },
    engineIds: readonly string[],
  ): Promise<ToolPackApplyResponse>;
}

const NOTE =
  "Existing sessions keep their pinned engine revision; new sessions use the new revision.";
/** prepareEngine rejections meaning the engine cannot take this package at all. */
const INCOMPATIBLE = new Set([
  "INVALID_ENGINE_CONFIGURATION",
  "ENGINE_CONFIGURATION_UNSUPPORTED",
  "INVALID_CONFIG",
  "ENGINE_RESERVED",
]);

function invalid(message: string): HubError {
  return new HubError("INVALID_REQUEST", message, 400);
}
function object(
  value: unknown,
  field = "Request body",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw invalid(`${field} must be a non-empty string`);
  return value;
}
/** Largest inline `mcp` document accepted by import, as serialized JSON. */
const INLINE_MCP_BYTES = 256 * 1024;
/**
 * An `mcp` request field: the usual `{"mcpServers":{...}}` document pasted by a user.
 * Returns its JSON text and a default package id derived from the first server name.
 * The importer still validates every server, so local commands fail there with its
 * offline guidance (an inline document has no files next to it).
 */
function inlineMcp(value: unknown): { text: string; id: string | undefined } {
  const document = object(value, "mcp");
  const servers = object(document.mcpServers, "mcp.mcpServers");
  const names = Object.keys(servers);
  if (!names.length) throw invalid("mcp.mcpServers must declare a server");
  const serialized = JSON.stringify(document, null, 2);
  if (Buffer.byteLength(serialized) > INLINE_MCP_BYTES)
    throw invalid("mcp must be at most 256 KiB of JSON");
  const id = slug(`mcp-${names[0]}`);
  return { text: `${serialized}\n`, id: id || undefined };
}
function only(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`Unknown field: ${unknown.join(", ")}`);
}
/** `"all"` or 1-64 unique engine ids. */
export function parseTargets(value: unknown, field: string): ToolPackTargets {
  if (value === "all") return "all";
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 64 ||
    !value.every((id) => typeof id === "string" && id.trim().length > 0)
  )
    throw invalid(`${field} must be "all" or a non-empty array of engine ids`);
  if (new Set(value).size !== value.length)
    throw invalid(`${field} contains duplicate engine ids`);
  return [...(value as string[])];
}
function bindings(value: unknown): Record<string, SecretReference> | undefined {
  return value === undefined
    ? undefined
    : (object(value, "secretBindings") as Record<string, SecretReference>);
}
function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalid(`${field} must be a boolean`);
  return value;
}
function describe(error: unknown): { code: string; reason: string } {
  if (error instanceof HubError)
    return { code: error.code, reason: error.message };
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "TOOL_PACKAGE_APPLY_FAILED";
  return {
    code,
    reason: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
  };
}
function registration(profile: ToolPackageEngine): EngineRegistration {
  if (profile.driver === "fake" || !profile.command?.length)
    throw new HubError(
      "ENGINE_CONFIGURATION_UNSUPPORTED",
      "Tool packs require a configured real engine",
      400,
    );
  return {
    id: profile.id,
    driver: profile.driver,
    command: [...profile.command],
    enabled: profile.enabled,
    maxConcurrency: profile.maxConcurrency,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.credentialEnv
      ? { credentialEnv: [...profile.credentialEnv] }
      : {}),
    ...(profile.configuration
      ? { configuration: structuredClone(profile.configuration) }
      : {}),
    ...(profile.cli ? { cli: { ...profile.cli } } : {}),
    ...(profile.acp ? { acp: { ...profile.acp } } : {}),
  };
}

interface ApplyRequest {
  targets: ToolPackTargets;
  /** Legacy single-engine request: failures are thrown as before. */
  legacy?: string;
  source?: string;
  package?: { id: string; version: string };
  secretBindings?: Record<string, SecretReference>;
  replace: boolean;
  warnings: string[];
  /** Skip engines that already contain this version or are not registered. */
  onlyMissing?: boolean;
}
function parseApply(input: unknown): ApplyRequest {
  const body = object(input);
  only(body, [
    "engineIds",
    "engineId",
    "package",
    "source",
    "workspace",
    "secretBindings",
    "replace",
  ]);
  if ((body.engineIds === undefined) === (body.engineId === undefined))
    throw invalid("Provide exactly one of engineIds or engineId");
  const warnings: string[] = [];
  if (body.workspace !== undefined) {
    const workspace = text(body.workspace, "workspace");
    if (!path.isAbsolute(workspace))
      throw invalid("workspace must be an absolute directory");
    warnings.push(
      "workspace is ignored: Tool Pack bindings use each Session's own working directory",
    );
  }
  if ((body.source === undefined) === (body.package === undefined))
    throw invalid("Provide exactly one of source or package");
  let source: string | undefined;
  let selected: { id: string; version: string } | undefined;
  if (body.source !== undefined) {
    source = text(body.source, "source");
    if (!path.isAbsolute(source))
      throw invalid(
        "source must be an absolute local Tool Pack directory; use POST /v1/tool-packs/import for Skill directories, mcp.json or cli.json",
      );
  } else {
    const value = object(body.package, "package");
    only(value, ["id", "version"]);
    selected = {
      id: text(value.id, "package.id"),
      version: text(value.version, "package.version"),
    };
  }
  const legacy =
    body.engineId === undefined ? undefined : text(body.engineId, "engineId");
  const secretBindings = bindings(body.secretBindings);
  return {
    targets: legacy ? [legacy] : parseTargets(body.engineIds, "engineIds"),
    ...(legacy ? { legacy } : {}),
    ...(source ? { source } : {}),
    ...(selected ? { package: selected } : {}),
    ...(secretBindings ? { secretBindings } : {}),
    replace: flag(body.replace, "replace"),
    warnings,
  };
}

/**
 * Tool Pack service behind the Gateway routes. Every mutation runs in one
 * serialized queue so concurrent requests cannot overwrite each other's engine
 * revisions. Engines are processed one at a time; each engine's result is
 * independent and a failure never rolls back engines already applied.
 */
export function createToolPackageManagement(
  options: ToolPackageManagementOptions,
): ToolPackageManagementService {
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(action: () => Promise<T>): Promise<T> => {
    const run = tail.then(action, action);
    tail = run.catch(() => undefined);
    return run;
  };
  const engines = (): readonly ToolPackageEngine[] => {
    if (!options.listEngines)
      throw new HubError(
        "ENGINE_LISTING_UNAVAILABLE",
        "This Gateway was started without engine listing; name the engines explicitly",
        501,
      );
    return options.listEngines();
  };
  /** Resolves targets to current profiles; undefined marks an unknown or unavailable engine. */
  const resolve = (
    targets: ToolPackTargets,
  ): { id: string; profile?: ToolPackageEngine; problem?: HubError }[] => {
    if (targets === "all")
      return engines().map((profile) => ({ id: profile.id, profile }));
    const known = options.listEngines?.();
    return targets.map((id) => {
      if (known) {
        const profile = known.find((engine) => engine.id === id);
        return profile ? { id, profile } : { id };
      }
      try {
        return { id, profile: options.engineProfile(id) };
      } catch (error) {
        if (error instanceof HubError) return { id, problem: error };
        throw error;
      }
    });
  };

  const applyLocked = async (
    request: ApplyRequest,
  ): Promise<ToolPackApplyResponse> => {
    let id: string;
    let version: string;
    if (request.source) {
      const installed = await installLocal(request.source, options.root);
      id = installed.manifest.id;
      version = installed.manifest.version;
    } else {
      id = request.package!.id;
      version = request.package!.version;
    }
    const installed = await verifyInstalled(options.root, id, version);
    const fragment = await bindInstalled(options.root, id, version, {
      nodeExecutable: options.nodeExecutable,
      commandMcpEntry: options.commandMcpEntry,
      ...(request.secretBindings
        ? { secretBindings: request.secretBindings }
        : {}),
    });
    const target = footprint(installed.record, installed.manifest);
    const versions = (
      await listManifests(options.root, { includeRemoved: true, id })
    ).map((entry) => footprint(entry.record, entry.manifest));
    const added = capabilities(fragment, installed.manifest);
    const bind = async (profile: ToolPackageEngine) => {
      const plan = planBinding(
        profile.configuration,
        "generic",
        target,
        versions,
        fragment,
        request.replace,
      );
      const registered = await options.registerEngine({
        ...registration(profile),
        configuration: plan.configuration,
      });
      return { revision: registered.revision, replaced: plan.replaced };
    };
    if (request.legacy) {
      const done = await bind(options.engineProfile(request.legacy));
      return {
        ok: true,
        package: { id, version },
        results: [
          {
            engineId: request.legacy,
            status: "applied",
            revision: done.revision,
            capabilities: added,
            ...(done.replaced.length ? { replaced: done.replaced } : {}),
          },
        ],
        warnings: request.warnings,
        note: NOTE,
        engineId: request.legacy,
        revision: done.revision,
        capabilities: added,
      };
    }
    const results: ToolPackEngineResult[] = [];
    for (const { id: engineId, profile, problem } of resolve(request.targets)) {
      if (!profile) {
        results.push({
          engineId,
          status: request.onlyMissing ? "skipped" : "failed",
          code: problem?.code ?? "ENGINE_UNAVAILABLE",
          reason: problem?.message ?? "Engine is not registered",
        });
        continue;
      }
      if (
        request.onlyMissing &&
        !isEmpty(ownedEntries(profile.configuration, target))
      ) {
        results.push({
          engineId,
          status: "skipped",
          code: "TOOL_PACKAGE_ALREADY_BOUND",
          reason: "This engine already uses the package version",
        });
        continue;
      }
      if (profile.driver === "fake" || !profile.command?.length) {
        results.push({
          engineId,
          status: "skipped",
          code: "ENGINE_CONFIGURATION_UNSUPPORTED",
          reason: "Tool packs require a configured real engine",
        });
        continue;
      }
      if (!profile.enabled) {
        results.push({
          engineId,
          status: "skipped",
          code: "ENGINE_DISABLED",
          reason: "Engine is disabled",
        });
        continue;
      }
      try {
        const done = await bind(profile);
        results.push({
          engineId,
          status: "applied",
          revision: done.revision,
          capabilities: added,
          ...(done.replaced.length ? { replaced: done.replaced } : {}),
        });
      } catch (error) {
        const { code, reason } = describe(error);
        results.push({
          engineId,
          status: INCOMPATIBLE.has(code) ? "skipped" : "failed",
          code,
          reason,
        });
      }
    }
    return {
      // An ensure request succeeds when nothing failed, even if nothing was missing.
      ok:
        (request.onlyMissing === true ||
          results.some((result) => result.status === "applied")) &&
        !results.some((result) => result.status === "failed"),
      package: { id, version },
      results,
      warnings: request.warnings,
      note: NOTE,
    };
  };

  return {
    async list() {
      const known = options.listEngines?.();
      const preinstalled = new Set(
        ((await options.preinstalled?.().catch(() => undefined)) ?? []).map(
          (item) => `${item.id}\n${item.version}`,
        ),
      );
      const packages: ToolPackListing[] = [];
      for (const record of await listInstalled(options.root)) {
        let owner: PackageFootprint;
        try {
          owner = footprint(record, await readManifest(options.root, record));
        } catch (error) {
          const { code, reason } = describe(error);
          packages.push({ ...record, problem: { code, message: reason } });
          continue;
        }
        packages.push({
          ...record,
          displayName: owner.displayName,
          counts: owner.counts,
          ...(preinstalled.has(`${record.id}\n${record.version}`)
            ? { preinstalled: true as const }
            : {}),
          ...(known
            ? {
                engines: known
                  .filter(
                    (engine) =>
                      !isEmpty(ownedEntries(engine.configuration, owner)),
                  )
                  .map((engine) => engine.id),
              }
            : {}),
        });
      }
      return { packages };
    },

    async apply(input: unknown) {
      const request = parseApply(input);
      return exclusive(() => applyLocked(request));
    },

    async ensure(selected, engineIds) {
      const targets = [...new Set(engineIds)];
      if (!targets.length)
        return {
          ok: true,
          package: { id: selected.id, version: selected.version },
          results: [],
          warnings: [],
          note: NOTE,
        };
      return exclusive(() =>
        applyLocked({
          targets,
          package: { id: selected.id, version: selected.version },
          replace: true,
          warnings: [],
          onlyMissing: true,
        }),
      );
    },

    async import(input: unknown) {
      const body = object(input);
      only(body, [
        "source",
        "mcp",
        "kind",
        "id",
        "version",
        "displayName",
        "applyTo",
        "replace",
        "secretBindings",
      ]);
      if ((body.source === undefined) === (body.mcp === undefined))
        throw invalid("Provide exactly one of source or mcp");
      const inline = body.mcp === undefined ? undefined : inlineMcp(body.mcp);
      if (inline && body.kind !== undefined && body.kind !== "mcp")
        throw invalid(
          "kind must be mcp (or omitted) with an inline mcp document",
        );
      const source =
        body.source === undefined ? undefined : text(body.source, "source");
      if (source !== undefined && !path.isAbsolute(source))
        throw invalid("source must be an absolute local directory or file");
      if (
        body.kind !== undefined &&
        !importKinds.includes(body.kind as ToolPackImportKind)
      )
        throw invalid("kind must be auto, skills, mcp or cli");
      const optional = (field: string) =>
        body[field] === undefined ? undefined : text(body[field], field);
      const packageId = optional("id") ?? inline?.id;
      const packageVersion = optional("version");
      const displayName = optional("displayName");
      const applyTo =
        body.applyTo === undefined
          ? undefined
          : parseTargets(body.applyTo, "applyTo");
      const replace = flag(body.replace, "replace");
      const secretBindings = bindings(body.secretBindings);
      if (!applyTo && (body.replace !== undefined || secretBindings))
        throw invalid("replace and secretBindings require applyTo");
      return exclusive(async () => {
        // An inline document is staged as an ordinary mcp.json so both forms share one
        // importer; it has no files next to it, so only remote servers can pass.
        // The importer refuses linked ancestors; macOS and some Windows profiles reach
        // the temporary directory through a link, so stage under its real path.
        const staged = inline
          ? await mkdtemp(
              path.join(await realpath(tmpdir()), "harnesshub-mcp-import-"),
            )
          : undefined;
        let imported: Awaited<ReturnType<typeof importLocal>>;
        try {
          let file = source;
          if (staged && inline) {
            file = path.join(staged, "mcp.json");
            await writeFile(file, inline.text, { mode: 0o600 });
          }
          imported = await importLocal(file!, options.root, {
            ...(inline
              ? { kind: "mcp" as const }
              : body.kind !== undefined
                ? { kind: body.kind as ToolPackImportKind }
                : {}),
            ...(packageId ? { id: packageId } : {}),
            ...(packageVersion ? { version: packageVersion } : {}),
            ...(displayName ? { displayName } : {}),
          });
        } finally {
          if (staged) await rm(staged, { recursive: true, force: true });
        }
        const selected = {
          id: imported.installed.manifest.id,
          version: imported.installed.manifest.version,
        };
        const apply = applyTo
          ? await applyLocked({
              targets: applyTo,
              package: selected,
              ...(secretBindings ? { secretBindings } : {}),
              replace,
              warnings: [],
            })
          : undefined;
        return {
          ok: apply ? apply.ok : true,
          package: selected,
          displayName: imported.installed.manifest.displayName,
          digest: imported.installed.digest,
          format: imported.format,
          counts: imported.counts,
          warnings: imported.warnings,
          ...(apply ? { apply } : {}),
        };
      });
    },

    async unbind(id: string, version: string, input: unknown) {
      const body = input === undefined ? {} : object(input);
      only(body, ["engineIds"]);
      if (body.engineIds === undefined)
        throw invalid('engineIds is required ("all" or a list of engine ids)');
      const targets = parseTargets(body.engineIds, "engineIds");
      return exclusive(async () => {
        const owner = (
          await listManifests(options.root, { includeRemoved: true, id })
        )
          .filter((entry) => entry.record.version === version)
          .map((entry) => footprint(entry.record, entry.manifest))[0];
        if (!owner)
          throw new HubError(
            "TOOL_PACKAGE_NOT_FOUND",
            "The requested tool package version is not registered",
            404,
          );
        const results: ToolPackUnbindResult[] = [];
        for (const { id: engineId, profile, problem } of resolve(targets)) {
          if (!profile) {
            results.push({
              engineId,
              status: "failed",
              code: problem?.code ?? "ENGINE_UNAVAILABLE",
              reason: problem?.message ?? "Engine is not registered",
            });
            continue;
          }
          const owned = ownedEntries(profile.configuration, owner);
          if (isEmpty(owned) || !profile.configuration) {
            results.push({
              engineId,
              status: "skipped",
              code: "TOOL_PACKAGE_NOT_BOUND",
              reason: "This engine does not use the package version",
            });
            continue;
          }
          try {
            const registered = await options.registerEngine({
              ...registration(profile),
              configuration: withoutEntries(profile.configuration, owned),
            });
            results.push({
              engineId,
              status: "unbound",
              revision: registered.revision,
              removed: {
                skills: owned.skills.map((skill) => skill.path),
                mcp: owned.mcpServers.map((server) => server.name),
              },
            });
          } catch (error) {
            const { code, reason } = describe(error);
            results.push({ engineId, status: "failed", code, reason });
          }
        }
        return {
          ok: !results.some((result) => result.status === "failed"),
          package: { id, version },
          results,
          note: "Existing sessions keep their pinned engine revision; new sessions no longer receive these capabilities.",
        };
      });
    },
  };
}
