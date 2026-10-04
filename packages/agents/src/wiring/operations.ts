// SPDX-License-Identifier: MIT
import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import {
  isGatewayKeyId,
  parseGatewayKey,
  parseModelRef,
  reasoningEfforts,
  wireProtocols,
  type GatewayKeyId,
  type ReasoningEffort,
  type WireProtocol,
  type WiringRecord,
  type WiringTier,
} from "@harnesshub/core/model-plane";
import {
  wiringAdapter,
  type AdapterEnvironment,
  type AdapterFile,
  type AdapterSetting,
  type AdapterTarget,
  type FileLocation,
  type LocatedFiles,
  type WiringAdapter,
  type WiringModel,
} from "./adapters/index.js";
import {
  BASE_URL_PLACEHOLDER,
  KEY_PLACEHOLDER,
  MANIFEST_VERSION,
  readManifest,
  readOriginal,
  saveManifest,
  saveOriginal,
  type BackupManifest,
  type OriginalFile,
} from "./backups.js";
import { unifiedDiff } from "./diff.js";
import { WiringError, type WiringRollback } from "./errors.js";
import {
  createParents,
  decodeText,
  deleteFile,
  encodeText,
  isCode,
  readState,
  removeEmptyDirectories,
  removeStaleTemporaries,
  resolveFile,
  sha256,
  withAdapterLock,
  writeAtomic,
  type FileState,
} from "./files.js";
import {
  editors,
  type ConfigFormat,
  type ConfigValue,
  type ConfigDocument,
  type FormatEditor,
  type KeyPath,
  type PathSegment,
} from "./formats/index.js";
import {
  blockingPrefix,
  clone,
  deepEqual,
  deletePath,
  formatPath,
  getPath,
  isRecord,
  isSelector,
  leaves,
  pathKey,
  selects,
  startsWith,
} from "./formats/values.js";

/**
 * Where the gateway is and which key and models an agent gets. Every
 * adapter needs `keyText` and `keyId`; `model` too, unless the adapter
 * keeps its own model with these options (`WiringAdapter.modelOptional`),
 * which then takes tiers and an effort only with a model.
 */
export interface WiringTarget {
  /** The gateway origin as agents reach it (`http://127.0.0.1:3180`); `/v1` is appended per protocol. */
  baseUrl: string;
  /** The agent-scoped Gateway Key; written only where the agent reads it, never logged or stored by wiring. */
  keyText?: string;
  keyId?: GatewayKeyId;
  /** The Model Ref or `group/<id>` the agent uses. */
  model?: string;
  /** Models the gateway exposes to this key, with the metadata of `/v1/models`; tiers' models are looked up here too. */
  models: WiringModel[];
  /** A model per tier the adapter declares (`WiringAdapter.tiers`); an absent tier follows `model`. */
  tiers?: Partial<Record<WiringTier, string>>;
  /** One of the adapter's `efforts`; absent leaves the agent's own. */
  effort?: ReasoningEffort;
  /** Values of the adapter's options; an absent one takes its default. */
  options?: Record<string, string>;
  /**
   * Whether the gateway answers hosted web search tools itself, for any
   * model (a search backend is configured); absent is false.
   */
  gatewaySearch?: boolean;
}

/**
 * The machine wiring acts on. Nothing is taken from the process: `home`
 * replaces the user's home directory and `env` is the only source of agent
 * directory overrides (CODEX_HOME, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, ...).
 */
export interface WiringContext {
  /** Absolute path of an existing directory. */
  home: string;
  /** HarnessHub's data directory; backups and locks live under `backups/wiring/`. */
  dataDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Source of `wiredAt`; defaults to the system clock. */
  clock?: () => Date;
}

/** One key-level change of a plan. Values are JSON text with keys masked. */
export interface PlannedChange {
  keyPath: string[];
  op: "set" | "remove";
  before?: string;
  after?: string;
}

export interface PlannedFile {
  /** The adapter's id for the file (`settings`, `env`, `config`, ...). */
  id: string;
  path: string;
  format: ConfigFormat;
  exists: boolean;
  /** SHA-256 of the current bytes, absent for a missing file; `applyWiring` checks it against `expect`. */
  hash?: string;
  changes: PlannedChange[];
  /**
   * Unified diff with Gateway Keys shown as `hhk_a_xxxx…` and the previous
   * values of key entries redacted. Other lines of the user's file appear as
   * context (none for dotenv files), so the diff is shown, not logged.
   */
  diff: string;
}

/** A preview of global wiring. It holds no key value and can be serialised. */
export interface WiringPlan {
  adapterId: string;
  protocol: WireProtocol;
  keyDelivery: WiringAdapter["keyDelivery"];
  /** Absent for an agent that keeps its own model choice (`modelOptional`). */
  model?: string;
  /** Absent only for the plan of a record wired without a key before keys were required. */
  keyId?: GatewayKeyId;
  /** False when the agent is already wired exactly so; applying then writes nothing. */
  changed: boolean;
  files: PlannedFile[];
}

export interface WiringOptions {
  /**
   * The current wiring of this adapter. Re-wiring keeps its original
   * backups, so unwire still restores the state before HarnessHub, and
   * restores entries it owned that the new target no longer sets.
   */
  previous?: WiringRecord;
}

/** What `applyWiring` compares of a confirmed plan: each file's existence and hash. */
export interface ConfirmedPlan {
  files: ReadonlyArray<Pick<PlannedFile, "path" | "exists" | "hash">>;
}

export interface ApplyOptions extends WiringOptions {
  /** The plan the user confirmed (a `WiringPlan` will do); a file that changed since fails with WIRING_CONCURRENT_MODIFICATION. */
  expect?: ConfirmedPlan;
}

export interface WiringOutcome {
  /** The record to persist; it replaces `previous`. */
  record: WiringRecord;
  /** What was written, as `planWiring` would have shown it. */
  plan: WiringPlan;
}

export type UnwireAction =
  /** The original bytes were written back. */
  | "restored"
  /** Wiring had created the file, which was unchanged, so it was deleted. */
  | "deleted"
  /** The file changed after wiring; only HarnessHub's entries were restored. */
  | "reverse-patched"
  /** Nothing of HarnessHub's was left to restore. */
  | "unchanged"
  /** The file no longer exists. */
  | "absent";

export interface UnwireResult {
  adapterId: string;
  /** The key that the caller now revokes; absent for a wiring without a key. */
  keyId?: GatewayKeyId;
  files: Array<{ path: string; action: UnwireAction }>;
}

/** File-based drift classes of 04 section 5; `bypassed` and `stale-key` need gateway evidence. */
export type DriftKind = "unwired" | "replaced" | "foreign-gateway";

export interface DriftFinding {
  path: string;
  keyPath: string[];
  kind: DriftKind;
  reason: "missing" | "changed" | "other-key" | "file-missing" | "unreadable";
}

export interface DriftReport {
  adapterId: string;
  keyId?: GatewayKeyId;
  drifted: boolean;
  kinds: DriftKind[];
  files: Array<{
    path: string;
    state: "unchanged" | "modified" | "missing" | "unreadable";
  }>;
  findings: DriftFinding[];
}

type Operation =
  | { op: "set"; path: KeyPath; value: ConfigValue }
  | { op: "remove"; path: KeyPath };

/** Stands for the model of a wiring without one in the target handed to the adapter; it must not reach a file. */
const MODEL_PLACEHOLDER = "{{harnesshub:model}}";

/** An adapter target with what the operations need besides it. */
interface ResolvedTarget extends AdapterTarget {
  keyId: GatewayKeyId;
}

interface FilePlan {
  spec: AdapterFile;
  editor: FileEditor;
  path: string;
  realPath: string;
  root: string;
  state: FileState;
  bom: boolean;
  before: string | undefined;
  after: string;
  operations: Operation[];
  pruned: KeyPath[];
  settings: AdapterSetting[];
  previous?: { entry: WiringRecord["files"][number]; manifest: BackupManifest };
  changed: boolean;
}

/**
 * Computes the edits that wire `adapterId` to `target` without writing
 * anything. The same files and target give the same plan; an agent already
 * wired this way gives `changed: false`. Fails before any write when a file
 * cannot be parsed, when an entry to set sits under a non-object value or in
 * an unsupported structure, or when a symlink leads outside the home.
 */
export async function planWiring(
  adapterId: string,
  target: WiringTarget,
  context: WiringContext,
  options: WiringOptions = {},
): Promise<WiringPlan> {
  const adapter = wiringAdapter(adapterId);
  const resolved = resolveTarget(adapter, target);
  const plans = await planFiles(adapter, resolved, context, options.previous);
  return preview(adapter, resolved, plans);
}

/**
 * Wires the agent: under the adapter's cross-process lock it re-plans, checks
 * `expect`, stores the original bytes under `<dataDir>/backups/wiring/`,
 * writes each changed file atomically (mode and symlinks kept) and re-reads
 * it to verify both the wired values and that nothing else changed. When any
 * step fails, files already written are restored from the bytes they had
 * before and the error lists each restore (`WiringError.rollback`). The
 * returned record is not persisted here: the caller commits it, then revokes
 * the previous key. Nothing is written when the plan is unchanged.
 */
export async function applyWiring(
  adapterId: string,
  target: WiringTarget,
  context: WiringContext,
  options: ApplyOptions = {},
): Promise<WiringOutcome> {
  const adapter = wiringAdapter(adapterId);
  const resolved = resolveTarget(adapter, target);
  return withAdapterLock(context.dataDir, adapter.id, async () => {
    const plans = await planFiles(adapter, resolved, context, options.previous);
    if (options.expect) checkExpected(plans, options.expect);
    const changed = plans.filter((plan) => plan.changed);
    const originals = new Map<FilePlan, OriginalFile>();
    for (const plan of changed)
      originals.set(plan, await originalOf(plan, context, adapter.id));
    const entries = new Map<FilePlan, WiringRecord["files"][number]>();
    const written: Array<{ plan: FilePlan; created: string[] }> = [];
    for (const plan of changed) {
      const bytes = encodeText(plan.after, plan.bom);
      const inPlace = plan.state.exists && plan.state.links > 1;
      let created: string[] = [];
      try {
        await removeStaleTemporaries(plan.realPath);
        created = await createParents(plan.realPath);
        const backupId = await saveManifest(
          context.dataDir,
          manifestOf(adapter, plan, resolved, originals.get(plan)!, created),
        );
        // An in-place write that fails midway must be restored as well.
        if (inPlace) written.push({ plan, created });
        await writeAtomic(plan.realPath, bytes, {
          mode: plan.state.exists ? plan.state.mode : 0o600,
          expectedHash: plan.state.exists ? plan.state.hash : undefined,
          inPlace,
        });
        if (!inPlace) written.push({ plan, created });
        await verifyWritten(plan, sha256(bytes));
        const beforeHash = plan.previous
          ? plan.previous.entry.beforeHash
          : plan.state.exists
            ? plan.state.hash
            : undefined;
        entries.set(plan, {
          path: plan.path,
          ...(beforeHash !== undefined ? { beforeHash } : {}),
          afterHash: sha256(bytes),
          backupId,
        });
      } catch (error) {
        const rollback = await rollBack(written);
        if (!written.some((item) => item.plan === plan))
          await removeEmptyDirectories(created).catch((cleanup: unknown) => {
            rollback.push({
              path: plan.path,
              restored: false,
              error: `Removing created directories failed: ${message(cleanup)}`,
            });
          });
        throw failure(error, plan.path, rollback);
      }
    }
    const files: WiringRecord["files"] = [];
    for (const plan of plans) {
      const entry = entries.get(plan) ?? plan.previous?.entry;
      if (entry) files.push(entry);
    }
    // Entries of files this adapter no longer locates (an override changed)
    // stay recorded so that unwire still restores them.
    for (const entry of options.previous?.files ?? [])
      if (!plans.some((plan) => plan.path === entry.path)) files.push(entry);
    return {
      record: {
        adapterId: adapter.id,
        ...(resolved.keyId !== undefined ? { keyId: resolved.keyId } : {}),
        ...choiceOf(adapter, resolved),
        files,
        wiredAt: (context.clock?.() ?? new Date()).toISOString(),
      },
      plan: preview(adapter, resolved, plans),
    };
  });
}

/**
 * Removes the wiring of `record`. A file unchanged since wiring gets its
 * original bytes back (or is deleted, with the directories wiring created,
 * when wiring created it). A file the user changed afterwards keeps those
 * changes: only the entries HarnessHub wrote are restored to their original
 * values or removed. Files are handled in reverse order under the adapter's
 * lock; on failure the error names the file, files already handled stay
 * restored, and running unwire again is safe. The caller revokes `keyId`
 * and deletes the record after success.
 */
export async function unwire(
  record: WiringRecord,
  context: WiringContext,
): Promise<UnwireResult> {
  checkRecord(record);
  const adapter = wiringAdapter(record.adapterId);
  await checkContext(context);
  return withAdapterLock(context.dataDir, adapter.id, async () => {
    const files: UnwireResult["files"] = [];
    for (const entry of [...record.files].reverse()) {
      const manifest = await readManifest(
        context.dataDir,
        adapter.id,
        entry.backupId!,
      );
      const editor = fileEditor(adapter, manifest);
      const { realPath } = await resolveFile(entry.path, [
        context.home,
        manifest.root,
      ]);
      const state = await readState(realPath);
      if (!state.exists) {
        files.push({ path: entry.path, action: "absent" });
        continue;
      }
      const { original: before } = manifest;
      if (state.hash === entry.afterHash && manifest.byteRestore) {
        if (before.existed) {
          const bytes = await readOriginal(
            context.dataDir,
            adapter.id,
            before.sha256,
          );
          await inFile(entry.path, () =>
            writeAtomic(realPath, bytes, {
              mode: before.mode,
              expectedHash: state.hash,
              inPlace: state.links > 1,
            }),
          );
          await verifyBytes(realPath, entry.path, sha256(bytes));
          files.push({ path: entry.path, action: "restored" });
        } else {
          await deleteFile(realPath);
          await removeEmptyDirectories(manifest.createdDirectories);
          files.push({ path: entry.path, action: "deleted" });
        }
        continue;
      }
      const { text, bom } = decodeText(state.bytes, entry.path);
      const original = await originalDocument(
        context.dataDir,
        adapter.id,
        manifest,
        editor,
      );
      const restored = inFileSync(entry.path, () => {
        const operations = revertOperations(manifest.owned, original);
        const after = applyOperations(editor, text, operations);
        const pruned = pruneEmpty(editor, after, operations, original);
        verifyText(editor, text, pruned.text, operations, pruned.paths);
        return pruned.text;
      });
      if (restored === text) {
        files.push({ path: entry.path, action: "unchanged" });
        continue;
      }
      const bytes = encodeText(restored, bom);
      await inFile(entry.path, () =>
        writeAtomic(realPath, bytes, {
          mode: state.mode,
          expectedHash: state.hash,
          inPlace: state.links > 1,
        }),
      );
      await verifyBytes(realPath, entry.path, sha256(bytes));
      files.push({ path: entry.path, action: "reverse-patched" });
    }
    return {
      adapterId: adapter.id,
      ...(record.keyId !== undefined ? { keyId: record.keyId } : {}),
      files: files.reverse(),
    };
  });
}

/**
 * Compares the wired files with what wiring wrote. A file whose bytes are
 * unchanged is not parsed. `options.baseUrl` checks against a gateway URL
 * other than the one wired (after a port change). The base URL entry missing
 * or a key entry missing or holding another key is `unwired`; the base URL
 * pointing elsewhere is `foreign-gateway`; any other wired entry changed is
 * `replaced`. Reads only; key values never appear in the report.
 */
export async function detectDrift(
  record: WiringRecord,
  context: WiringContext,
  options: { baseUrl?: string } = {},
): Promise<DriftReport> {
  checkRecord(record);
  const adapter = wiringAdapter(record.adapterId);
  await checkContext(context);
  const baseUrlField = baseUrlFieldOf(
    adapter,
    resolveOptions(adapter, record.options),
  );
  const files: DriftReport["files"] = [];
  const findings: DriftFinding[] = [];
  for (const entry of record.files) {
    const manifest = await readManifest(
      context.dataDir,
      adapter.id,
      entry.backupId!,
    );
    const baseUrl = options.baseUrl
      ? resolveBaseUrl(options.baseUrl)
      : manifest.baseUrl;
    const { realPath } = await resolveFile(entry.path, [
      context.home,
      manifest.root,
    ]);
    const state = await readState(realPath);
    if (!state.exists) {
      files.push({ path: entry.path, state: "missing" });
      findings.push({
        path: entry.path,
        keyPath: [],
        kind: "unwired",
        reason: "file-missing",
      });
      continue;
    }
    if (state.hash === entry.afterHash && baseUrl === manifest.baseUrl) {
      files.push({ path: entry.path, state: "unchanged" });
      continue;
    }
    let document: ConfigDocument;
    try {
      document = fileEditor(adapter, manifest).parse(
        decodeText(state.bytes, entry.path).text,
      );
    } catch (error) {
      if (!(error instanceof WiringError)) throw error;
      files.push({ path: entry.path, state: "unreadable" });
      findings.push({
        path: entry.path,
        keyPath: [],
        kind: "unwired",
        reason: "unreadable",
      });
      continue;
    }
    files.push({ path: entry.path, state: "modified" });
    const { file: baseFile, path: basePath } = baseUrlField;
    // A field per model has none for a wiring without a model.
    const baseField =
      baseFile !== manifest.fileId
        ? undefined
        : typeof basePath !== "function"
          ? basePath
          : record.model !== undefined
            ? basePath(record.model, document)
            : undefined;
    for (const expected of manifest.expected)
      for (const [leaf, template] of leaves(expected.value, expected.path)) {
        const result = matchTemplate(
          getPath(document, leaf),
          template,
          baseUrl,
          record.keyId,
        );
        if (result === "ok") continue;
        const isBase =
          baseField !== undefined && pathKey(leaf) === pathKey(baseField);
        // Another key wins over the base URL for an entry holding both.
        const kind: DriftKind =
          isBase && result !== "other-key"
            ? result === "missing"
              ? "unwired"
              : "foreign-gateway"
            : containsPlaceholder(template, KEY_PLACEHOLDER)
              ? "unwired"
              : "replaced";
        findings.push({
          path: entry.path,
          keyPath: segmentsText(leaf),
          kind,
          reason: result,
        });
      }
    // An entry wiring removed that holds a value again overrides the wiring.
    for (const absent of manifest.absent ?? [])
      if (getPath(document, absent) !== undefined)
        findings.push({
          path: entry.path,
          keyPath: segmentsText(absent),
          kind: "replaced",
          reason: "changed",
        });
  }
  const kinds = [...new Set(findings.map((finding) => finding.kind))].sort();
  return {
    adapterId: adapter.id,
    ...(record.keyId !== undefined ? { keyId: record.keyId } : {}),
    drifted: findings.length > 0,
    kinds,
    files,
    findings,
  };
}

/** A key path as API text: keys as they are, an array element as `[field="value"]`. */
function segmentsText(path: KeyPath): string[] {
  return path.map((segment) =>
    typeof segment === "string" ? segment : formatPath([segment]),
  );
}

/** Shows a Gateway Key as `hhk_<scope>_<first four of its id>…`; other text is unchanged. */
export function maskGatewayKeys(text: string): string {
  return text.replace(
    /hhk_([asc])_([a-z2-7]{12})_[A-Za-z0-9_-]+/g,
    (_, scope: string, id: string) => `hhk_${scope}_${id.slice(0, 4)}…`,
  );
}

async function planFiles(
  adapter: WiringAdapter,
  target: ResolvedTarget,
  context: WiringContext,
  previous: WiringRecord | undefined,
): Promise<FilePlan[]> {
  await checkContext(context);
  if (previous) {
    checkRecord(previous);
    if (previous.adapterId !== adapter.id)
      throw new WiringError(
        "WIRING_RECORD_INVALID",
        "The previous wiring record belongs to another adapter",
      );
  }
  const environment = adapterEnvironment(context);
  const located: Array<{
    spec: AdapterFile;
    file: string;
    location: FileLocation;
    realPath: string;
    state: FileState;
    before: { text: string | undefined; bom: boolean };
  }> = [];
  for (const spec of adapter.files) {
    const location = spec.locate(environment);
    const file = await firstExisting(location.candidates, location.create);
    const { realPath } = await resolveFile(file, [location.root]);
    const state = await readState(realPath);
    located.push({
      spec,
      file,
      location,
      realPath,
      state,
      before: state.exists
        ? decodeText(state.bytes, file)
        : { text: undefined, bom: false },
    });
  }
  const find = (fileId: string) => {
    const found = located.find((item) => item.spec.id === fileId);
    if (!found)
      throw new WiringError(
        "WIRING_TARGET_INVALID",
        `${adapter.name} has no file ${JSON.stringify(fileId)}`,
      );
    return found;
  };
  const paths: LocatedFiles = {
    path: (fileId) => find(fileId).file,
    current(fileId) {
      const { spec, file, before } = find(fileId);
      return inFileSync(file, () =>
        fileEditor(adapter, spec).parse(before.text ?? spec.initial ?? ""),
      );
    },
  };
  const settings = adapter.settings(target, paths);
  checkElements(adapter, settings);
  if (target.ownModel) checkOwnModel(adapter, settings);
  const plans: FilePlan[] = [];
  for (const { spec, file, location, realPath, state, before } of located) {
    if (!state.exists)
      for (const older of location.migratedFrom ?? [])
        if ((await firstExisting([older], file)) === older)
          throw new WiringError(
            "WIRING_UNSUPPORTED_STRUCTURE",
            `The agent has not moved ${path.basename(older)} into ${path.basename(file)} yet; start it once so it does, then wire again`,
            { path: older },
          );
    const editor = fileEditor(adapter, spec);
    const own = settings.filter((setting) => setting.file === spec.id);
    const entry = previous?.files.find((candidate) => candidate.path === file);
    const prior = entry
      ? {
          entry,
          manifest: await readManifest(
            context.dataDir,
            adapter.id,
            entry.backupId!,
          ),
        }
      : undefined;
    const original = prior
      ? await originalDocument(
          context.dataDir,
          adapter.id,
          prior.manifest,
          editor,
        )
      : undefined;
    const after = inFileSync(file, () => {
      const current = before.text ?? spec.initial ?? "";
      const document = editor.parse(current);
      // Entries owned by the previous wiring that the new one no longer sets.
      const stale = (prior?.manifest.owned ?? []).filter(
        (owned) =>
          !own.some(
            (setting) =>
              startsWith(owned, setting.path) ||
              startsWith(setting.path, owned),
          ),
      );
      const operations: Operation[] = [
        ...revertOperations(stale, original ?? document),
        ...own.map((setting): Operation =>
          "remove" in setting
            ? { op: "remove", path: setting.path }
            : { op: "set", path: setting.path, value: setting.value },
        ),
      ];
      const edited = applyOperations(editor, current, operations);
      const pruned = pruneEmpty(
        editor,
        edited,
        operations,
        original ?? document,
      );
      verifyText(editor, current, pruned.text, operations, pruned.paths);
      return { text: pruned.text, operations, pruned: pruned.paths };
    });
    plans.push({
      spec,
      editor,
      path: file,
      realPath,
      root: location.root,
      state,
      bom: before.bom,
      before: before.text,
      after: after.text,
      operations: after.operations,
      pruned: after.pruned,
      settings: own,
      ...(prior ? { previous: prior } : {}),
      changed:
        before.text === undefined
          ? own.some((setting) => !("remove" in setting))
          : after.text !== before.text,
    });
  }
  return plans;
}

function preview(
  adapter: WiringAdapter,
  resolved: ResolvedTarget,
  plans: FilePlan[],
): WiringPlan {
  return {
    adapterId: adapter.id,
    protocol: adapter.protocol,
    keyDelivery: adapter.keyDelivery,
    ...(resolved.ownModel ? {} : { model: resolved.model }),
    keyId: resolved.keyId,
    changed: plans.some((plan) => plan.changed),
    files: plans.map((plan) => {
      const before =
        plan.before === undefined ? {} : plan.editor.parse(plan.before);
      const after = plan.editor.parse(plan.after);
      // Previous values of entries that carry the key are secrets too,
      // unless the previous wiring wrote them (keys in them are masked
      // anyway): a base URL that gains a key shows what it was.
      const wrote = (leaf: KeyPath, value: string) =>
        plan.previous?.manifest.expected.some((expected) =>
          leaves(expected.value, expected.path).some(
            ([at, template]) =>
              pathKey(at) === pathKey(leaf) &&
              typeof template === "string" &&
              templatePattern(template, plan.previous!.manifest.baseUrl).test(
                value,
              ),
          ),
        ) === true;
      const secrets = plan.settings
        .flatMap((setting) =>
          "remove" in setting ? [] : leaves(setting.value, setting.path),
        )
        .filter(
          ([, value]) =>
            typeof value === "string" && value.includes(resolved.keyText),
        )
        .map(([leaf]) => [leaf, getPath(before, leaf)] as const)
        .filter(
          (pair): pair is readonly [KeyPath, string] =>
            typeof pair[1] === "string" && !wrote(pair[0], pair[1]),
        )
        .map(([, value]) => value);
      const mask = masker(secrets);
      const changes: PlannedChange[] = [];
      for (const operation of [
        ...plan.operations,
        ...plan.pruned.map((path): Operation => ({ op: "remove", path })),
      ]) {
        const old = getPath(before, operation.path);
        const next = getPath(after, operation.path);
        if (deepEqual(old, next)) continue;
        changes.push({
          keyPath: segmentsText(operation.path),
          op: operation.op,
          ...(old !== undefined
            ? { before: shorten(mask(JSON.stringify(old))) }
            : {}),
          ...(next !== undefined
            ? { after: shorten(mask(JSON.stringify(next))) }
            : {}),
        });
      }
      return {
        id: plan.spec.id,
        path: plan.path,
        format: plan.spec.format,
        exists: plan.state.exists,
        ...(plan.state.exists ? { hash: plan.state.hash } : {}),
        changes,
        diff: !plan.changed
          ? ""
          : plan.spec.generated
            ? generatedDiff(plan)
            : mask(
                unifiedDiff(
                  plan.before,
                  plan.after,
                  plan.path,
                  plan.spec.format === "dotenv" ? 0 : 3,
                ),
              ),
      };
    }),
  };
}

/** Values longer than this are cut in a plan's changes; the diff shows them in full. */
const CHANGE_VALUE_LIMIT = 2000;

function shorten(text: string): string {
  return text.length <= CHANGE_VALUE_LIMIT
    ? text
    : `${text.slice(0, CHANGE_VALUE_LIMIT)}… (${text.length} characters)`;
}

/** A generated file is summarised: its size before and after, not its lines. */
function generatedDiff(plan: FilePlan): string {
  const size = (text: string | undefined) =>
    text === undefined
      ? "absent"
      : `${Buffer.byteLength(text, "utf8")} bytes, ${text.split("\n").length - (text.endsWith("\n") ? 1 : 0)} lines`;
  return [
    `--- ${plan.before === undefined ? "/dev/null" : plan.path}`,
    `+++ ${plan.path}`,
    `@@ generated by HarnessHub: ${size(plan.before)} -> ${size(plan.after)} @@`,
    "",
  ].join("\n");
}

function masker(secrets: string[]): (text: string) => string {
  const long = [...new Set(secrets)]
    .filter((secret) => secret.length >= 8)
    .sort((left, right) => right.length - left.length);
  return (text) => {
    let result = text;
    for (const secret of long) {
      result = result.split(secret).join("<redacted>");
      const quoted = JSON.stringify(secret).slice(1, -1);
      if (quoted !== secret) result = result.split(quoted).join("<redacted>");
    }
    return maskGatewayKeys(result);
  };
}

/** A format editor as one file needs it: one whose root may be a list reads it so. */
type FileEditor = Omit<FormatEditor, "parse"> & {
  parse(text: string): ConfigDocument;
};

/**
 * The editor of an adapter's file, by its spec or by the id and format a
 * backup manifest records.
 */
function fileEditor(
  adapter: WiringAdapter,
  file: { id?: string; fileId?: string; format: ConfigFormat },
): FileEditor {
  const editor = editors[file.format];
  const spec = adapter.files.find(
    (candidate) => candidate.id === (file.id ?? file.fileId),
  );
  return spec?.arrayRoot && editor.parseRoot
    ? { ...editor, parse: (text) => editor.parseRoot!(text) }
    : editor;
}

/** Restores each owned entry to its original value, or removes it if it had none. */
function revertOperations(
  owned: readonly KeyPath[],
  original: ConfigDocument,
): Operation[] {
  const top = owned.filter(
    (candidate) =>
      !owned.some(
        (other) =>
          other.length < candidate.length && startsWith(candidate, other),
      ),
  );
  return top.map((entry): Operation => {
    const value = getPath(original, entry);
    if (value === undefined) return { op: "remove", path: entry };
    const restored = configValue(value);
    if (restored === undefined)
      throw new WiringError(
        "WIRING_UNSUPPORTED_STRUCTURE",
        `The original value of ${formatPath(entry)} cannot be written back in place; restore it from the backup by hand`,
      );
    return { op: "set", path: entry, value: restored };
  });
}

function configValue(value: unknown): ConfigValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(configValue);
    return items.every((item) => item !== undefined)
      ? (items as ConfigValue[])
      : undefined;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(
      ([key, item]) => [key, configValue(item)] as const,
    );
    return entries.every(([, item]) => item !== undefined)
      ? (Object.fromEntries(entries) as Record<string, ConfigValue>)
      : undefined;
  }
  return undefined;
}

function applyOperations(
  editor: FileEditor,
  text: string,
  operations: readonly Operation[],
): string {
  let result = text;
  let document = editor.parse(result);
  for (const operation of operations) {
    const current = getPath(document, operation.path);
    if (operation.op === "remove") {
      if (current === undefined) continue;
      result = editor.remove(result, operation.path);
    } else {
      if (deepEqual(current, operation.value)) continue;
      const blocked = blockingPrefix(document, operation.path);
      if (blocked)
        throw new WiringError(
          "WIRING_PATH_CONFLICT",
          `${formatPath(blocked)} holds a value that is not an object, so ${formatPath(operation.path)} cannot be set`,
        );
      result = editor.set(result, operation.path, operation.value);
    }
    document = editor.parse(result);
  }
  return result;
}

/** An object without entries or an array without elements. */
function isEmptyContainer(value: unknown): boolean {
  return isRecord(value)
    ? Object.keys(value).length === 0
    : Array.isArray(value) && value.length === 0;
}

/** Removes objects and arrays left empty by removals that did not exist in the original. */
function pruneEmpty(
  editor: FileEditor,
  text: string,
  operations: readonly Operation[],
  original: ConfigDocument,
): { text: string; paths: KeyPath[] } {
  let result = text;
  const paths: KeyPath[] = [];
  const removed = operations
    .filter((operation) => operation.op === "remove")
    .map((operation) => operation.path)
    .sort((left, right) => right.length - left.length);
  for (const entry of removed)
    for (let length = entry.length - 1; length > 0; length--) {
      const parent = entry.slice(0, length);
      const value = getPath(editor.parse(result), parent);
      if (!isEmptyContainer(value) || getPath(original, parent) !== undefined)
        break;
      result = editor.remove(result, parent);
      paths.push(parent);
    }
  return { text: result, paths };
}

/**
 * Re-parses edited text with the real parser: every operation's final value
 * must be in place and the document with the touched entries taken out must
 * equal the original with the same entries taken out.
 */
function verifyText(
  editor: FileEditor,
  before: string,
  after: string,
  operations: readonly Operation[],
  pruned: readonly KeyPath[],
): void {
  let document: ConfigDocument;
  try {
    document = editor.parse(after);
  } catch {
    throw new WiringError(
      "WIRING_VERIFY_FAILED",
      "The edited configuration no longer parses",
    );
  }
  const wanted = new Map<
    string,
    { path: KeyPath; value: ConfigValue | undefined }
  >();
  for (const operation of operations)
    wanted.set(pathKey(operation.path), {
      path: operation.path,
      value: operation.op === "set" ? operation.value : undefined,
    });
  for (const entry of pruned)
    wanted.set(pathKey(entry), { path: entry, value: undefined });
  for (const { path: entry, value } of wanted.values())
    if (!deepEqual(getPath(document, entry), value))
      throw new WiringError(
        "WIRING_VERIFY_FAILED",
        `The edited configuration does not hold the expected value at ${formatPath(entry)}`,
      );
  const touched = [...wanted.values()].map((item) => item.path);
  if (
    !deepEqual(
      without(editor.parse(before), touched),
      without(document, touched),
    )
  )
    throw new WiringError(
      "WIRING_VERIFY_FAILED",
      "The edit changed entries outside the wired keys",
    );
}

function without(
  document: ConfigDocument,
  touched: readonly KeyPath[],
): unknown {
  const copy = clone(document);
  for (const entry of touched) deletePath(copy, entry);
  for (const entry of [...touched].sort(
    (left, right) => right.length - left.length,
  ))
    for (let length = entry.length - 1; length > 0; length--) {
      const parent = getPath(copy, entry.slice(0, length));
      if (!isEmptyContainer(parent)) break;
      deletePath(copy, entry.slice(0, length));
    }
  return copy;
}

/** Reads the written file back and verifies its bytes and, re-parsed, its values. */
async function verifyWritten(plan: FilePlan, hash: string): Promise<void> {
  const state = await verifyBytes(plan.realPath, plan.path, hash);
  inFileSync(plan.path, () =>
    verifyText(
      plan.editor,
      plan.before ?? plan.spec.initial ?? "",
      decodeText(state.bytes, plan.path).text,
      plan.operations,
      plan.pruned,
    ),
  );
}

async function verifyBytes(
  realPath: string,
  file: string,
  hash: string,
): Promise<Extract<FileState, { exists: true }>> {
  const state = await readState(realPath);
  if (!state.exists || state.hash !== hash)
    throw new WiringError(
      "WIRING_VERIFY_FAILED",
      "The configuration file read back differs from what was written",
      { path: file },
    );
  return state;
}

async function rollBack(
  written: Array<{ plan: FilePlan; created: string[] }>,
): Promise<WiringRollback[]> {
  const results: WiringRollback[] = [];
  for (const { plan, created } of [...written].reverse()) {
    try {
      if (plan.state.exists) {
        const current = await readState(plan.realPath);
        // A write that failed before changing the file needs no restore.
        if (!current.exists || current.hash !== plan.state.hash)
          await writeAtomic(plan.realPath, plan.state.bytes, {
            mode: plan.state.mode,
            expectedHash: current.exists ? current.hash : undefined,
            inPlace: plan.state.links > 1,
          });
      } else {
        await deleteFile(plan.realPath);
        await removeEmptyDirectories(created);
      }
      results.push({ path: plan.path, restored: true });
    } catch (error) {
      results.push({
        path: plan.path,
        restored: false,
        error: message(error),
        ...(plan.previous?.entry.backupId
          ? { backupId: plan.previous.entry.backupId }
          : {}),
      });
    }
  }
  return results.reverse();
}

function failure(
  error: unknown,
  file: string,
  rollback: WiringRollback[],
): WiringError {
  if (error instanceof WiringError)
    return new WiringError(error.code, error.message, {
      path: error.path ?? file,
      rollback,
      cause: error,
    });
  return new WiringError(
    "WIRING_WRITE_FAILED",
    `Writing the configuration file failed: ${message(error)}`,
    { path: file, rollback, cause: error },
  );
}

function message(error: unknown): string {
  if (error instanceof WiringError) return error.message;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return error instanceof Error ? error.name : "unknown error";
}

async function originalOf(
  plan: FilePlan,
  context: WiringContext,
  adapterId: string,
): Promise<OriginalFile> {
  if (plan.previous) return plan.previous.manifest.original;
  if (!plan.state.exists) return { existed: false };
  return {
    existed: true,
    sha256: await saveOriginal(context.dataDir, adapterId, plan.state.bytes),
    size: plan.state.bytes.length,
    mode: plan.state.mode,
    mtimeMs: plan.state.mtimeMs,
  };
}

function manifestOf(
  adapter: WiringAdapter,
  plan: FilePlan,
  target: ResolvedTarget,
  original: OriginalFile,
  created: string[],
): BackupManifest {
  const prior = plan.previous;
  const owned = new Map<string, PathSegment[]>();
  for (const entry of [
    ...(prior?.manifest.owned ?? []),
    ...plan.settings.map((setting) => [...setting.path]),
  ])
    owned.set(pathKey(entry), [...entry]);
  return {
    schemaVersion: MANIFEST_VERSION,
    adapterId: adapter.id,
    fileId: plan.spec.id,
    format: plan.spec.format,
    path: plan.path,
    root: plan.root,
    baseUrl: target.baseUrl,
    original,
    byteRestore: prior
      ? prior.manifest.byteRestore &&
        plan.state.exists &&
        plan.state.hash === prior.entry.afterHash
      : true,
    createdDirectories: [
      ...new Set([...(prior?.manifest.createdDirectories ?? []), ...created]),
    ],
    owned: [...owned.values()],
    expected: plan.settings.flatMap((setting) =>
      "remove" in setting
        ? []
        : [{ path: [...setting.path], value: template(setting.value, target) }],
    ),
    absent: plan.settings
      .filter((setting) => "remove" in setting)
      .map((setting) => [...setting.path]),
  };
}

function template(value: ConfigValue, target: AdapterTarget): ConfigValue {
  if (typeof value === "string")
    return value
      .split(target.keyText)
      .join(KEY_PLACEHOLDER)
      .split(target.baseUrl)
      .join(BASE_URL_PLACEHOLDER);
  if (Array.isArray(value)) return value.map((item) => template(item, target));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, template(item, target)]),
    );
  return value;
}

function containsPlaceholder(value: ConfigValue, placeholder: string): boolean {
  if (typeof value === "string") return value.includes(placeholder);
  if (Array.isArray(value))
    return value.some((item) => containsPlaceholder(item, placeholder));
  if (typeof value === "object")
    return Object.values(value).some((item) =>
      containsPlaceholder(item, placeholder),
    );
  return false;
}

function matchTemplate(
  actual: unknown,
  expected: ConfigValue,
  baseUrl: string,
  keyId: GatewayKeyId | undefined,
): "ok" | "missing" | "changed" | "other-key" {
  if (actual === undefined) return "missing";
  if (typeof expected !== "string") {
    // Arrays are leaves, so placeholders inside their items (an entry of an
    // environment list) are matched item by item and key by key.
    if (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      actual.length === expected.length
    )
      return combineMatches(
        expected.map((item, index) =>
          matchTemplate(actual[index], item, baseUrl, keyId),
        ),
      );
    if (
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      isRecord(actual) &&
      deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort())
    )
      return combineMatches(
        Object.entries(expected).map(([key, item]) =>
          matchTemplate(actual[key], item, baseUrl, keyId),
        ),
      );
    return deepEqual(actual, expected) ? "ok" : "changed";
  }
  if (typeof actual !== "string") return "changed";
  const match = templatePattern(expected, baseUrl).exec(actual);
  if (!match) return "changed";
  const keys = match.slice(1);
  return keys.every((key) => parseGatewayKey(key!)?.keyId === keyId)
    ? "ok"
    : "other-key";
}

/** A template string as a pattern whose groups capture the keys in it. */
function templatePattern(template: string, baseUrl: string): RegExp {
  const pattern = template
    .split(/(\{\{harnesshub:(?:gateway-key|base-url)\}\})/)
    .map((part) =>
      part === KEY_PLACEHOLDER
        ? "(hhk_[asc]_[a-z2-7]{12}_[A-Za-z0-9_-]{43})"
        : part === BASE_URL_PLACEHOLDER
          ? escapeRegExp(baseUrl)
          : escapeRegExp(part),
    )
    .join("");
  return new RegExp(`^${pattern}$`);
}

/** The match of a whole from its parts: another key only when nothing else differs. */
function combineMatches(
  results: ReadonlyArray<ReturnType<typeof matchTemplate>>,
): "ok" | "changed" | "other-key" {
  if (results.every((result) => result === "ok")) return "ok";
  return results.every((result) => result === "ok" || result === "other-key")
    ? "other-key"
    : "changed";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkExpected(plans: FilePlan[], expect: ConfirmedPlan): void {
  for (const plan of plans) {
    const confirmed = expect.files.find((file) => file.path === plan.path);
    const hash = plan.state.exists ? plan.state.hash : undefined;
    if (
      !confirmed ||
      confirmed.exists !== plan.state.exists ||
      confirmed.hash !== hash
    )
      throw new WiringError(
        "WIRING_CONCURRENT_MODIFICATION",
        "The configuration file changed after the plan was shown; plan again",
        { path: plan.path },
      );
  }
}

async function originalDocument(
  dataDir: string,
  adapterId: string,
  manifest: BackupManifest,
  editor: FileEditor,
): Promise<ConfigDocument> {
  if (!manifest.original.existed) return {};
  const bytes = await readOriginal(
    dataDir,
    adapterId,
    manifest.original.sha256,
  );
  return inFileSync(manifest.path, () =>
    editor.parse(decodeText(bytes, manifest.path).text),
  );
}

function resolveTarget(
  adapter: WiringAdapter,
  target: WiringTarget,
): ResolvedTarget {
  const invalid = (detail: string) =>
    new WiringError("WIRING_TARGET_INVALID", detail);
  const baseUrl = resolveBaseUrl(target.baseUrl);
  const options = resolveOptions(adapter, target.options);
  if (
    target.gatewaySearch !== undefined &&
    typeof target.gatewaySearch !== "boolean"
  )
    throw invalid("gatewaySearch must be true or false");
  const gatewaySearch = target.gatewaySearch ?? false;
  const seen = new Set<string>();
  for (const model of target.models) {
    if (!parseModelRef(model.ref) || seen.has(model.ref))
      throw invalid("Every listed model needs a distinct, valid Model Ref");
    seen.add(model.ref);
    for (const limit of [model.contextWindow, model.maxOutputTokens])
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
        throw invalid(`The limits of ${model.ref} must be positive integers`);
    if (
      !(model.efforts ?? []).every((effort) =>
        (reasoningEfforts as readonly string[]).includes(effort),
      ) ||
      !(model.nativeProtocols ?? []).every((protocol) =>
        (wireProtocols as readonly string[]).includes(protocol),
      )
    )
      throw invalid(`The metadata of ${model.ref} is invalid`);
  }
  const key =
    target.keyText === undefined ? undefined : parseGatewayKey(target.keyText);
  if (
    target.keyId === undefined ||
    !isGatewayKeyId(target.keyId) ||
    !key ||
    key.scope !== "agent" ||
    key.keyId !== target.keyId
  )
    throw invalid(
      "The key must be an agent-scoped Gateway Key whose id is keyId",
    );
  const ownModel =
    target.model === undefined && adapter.modelOptional?.(options) === true;
  if (ownModel) {
    if (Object.keys(target.tiers ?? {}).length || target.effort !== undefined)
      throw invalid(
        `${adapter.name} keeps its own model with these options; name a model to set tiers or an effort`,
      );
  } else if (target.model === undefined || !parseModelRef(target.model))
    throw invalid(
      "The model must be a Model Ref (provider/model) or group/<id>",
    );
  const tiers: Partial<Record<WiringTier, string>> = {};
  for (const [tier, model] of Object.entries(target.tiers ?? {})) {
    if (!(adapter.tiers ?? []).includes(tier as WiringTier))
      throw invalid(
        `${adapter.name} has no model tier ${JSON.stringify(tier)}`,
      );
    if (typeof model !== "string" || !parseModelRef(model))
      throw invalid(`The model of tier ${tier} must be a Model Ref`);
    tiers[tier as WiringTier] = model;
  }
  if (
    target.effort !== undefined &&
    !(adapter.efforts ?? []).includes(target.effort)
  )
    throw invalid(
      `${adapter.name} cannot be set to start at effort ${JSON.stringify(target.effort)}`,
    );
  return {
    baseUrl,
    keyText: target.keyText!,
    keyId: target.keyId,
    model: target.model ?? MODEL_PLACEHOLDER,
    ownModel,
    models: target.models,
    selected: ownModel
      ? undefined
      : target.models.find((model) => model.ref === target.model),
    tiers,
    effort: target.effort,
    options,
    gatewaySearch,
  };
}

/**
 * The adapter's options with defaults filled in; an option it does not
 * declare or a value it does not allow fails with WIRING_TARGET_INVALID.
 */
export function resolveOptions(
  adapter: WiringAdapter,
  given: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const declared = adapter.options ?? {};
  for (const [name, value] of Object.entries(given ?? {}))
    if (!Object.hasOwn(declared, name) || !declared[name]!.includes(value))
      throw new WiringError(
        "WIRING_TARGET_INVALID",
        Object.hasOwn(declared, name)
          ? `${adapter.name} option ${name} is one of ${declared[name]!.join(", ")}`
          : `${adapter.name} has no option ${JSON.stringify(name)}`,
      );
  return Object.fromEntries(
    Object.entries(declared).map(([name, values]) => [
      name,
      given?.[name] ?? values[0]!,
    ]),
  );
}

/** Whether the adapter, configured with `options`, may be wired without a model. */
export function isModelOptional(
  adapter: WiringAdapter,
  options: Readonly<Record<string, string>> | undefined,
): boolean {
  return adapter.modelOptional?.(resolveOptions(adapter, options)) ?? false;
}

/** The choices a record keeps: the model when named, tiers, effort and the options. */
function choiceOf(
  adapter: WiringAdapter,
  target: ResolvedTarget,
): Pick<WiringRecord, "model" | "tiers" | "effort" | "options"> {
  return {
    ...(target.ownModel ? {} : { model: target.model }),
    ...(Object.keys(target.tiers).length ? { tiers: { ...target.tiers } } : {}),
    ...(target.effort !== undefined ? { effort: target.effort } : {}),
    ...(Object.keys(adapter.options ?? {}).length
      ? { options: { ...target.options } }
      : {}),
  };
}

function baseUrlFieldOf(
  adapter: WiringAdapter,
  options: Readonly<Record<string, string>>,
): WiringAdapter["baseUrlField"] {
  return adapter.baseUrlFieldFor?.(options) ?? adapter.baseUrlField;
}

/** An element an adapter writes must be one its selector selects, or unwire could not find it. */
function checkElements(
  adapter: WiringAdapter,
  settings: readonly AdapterSetting[],
): void {
  for (const setting of settings) {
    const last = setting.path.at(-1);
    if (
      last !== undefined &&
      isSelector(last) &&
      !("remove" in setting) &&
      !selects(last, setting.value)
    )
      throw new WiringError(
        "WIRING_TARGET_INVALID",
        `${adapter.name} writes an element at ${formatPath(setting.path)} that its selector does not select`,
      );
  }
}

/** The settings of a wiring without a model must not use the model. */
function checkOwnModel(
  adapter: WiringAdapter,
  settings: readonly AdapterSetting[],
): void {
  for (const setting of settings)
    if (
      !("remove" in setting) &&
      containsPlaceholder(setting.value, MODEL_PLACEHOLDER)
    )
      throw new WiringError(
        "WIRING_TARGET_INVALID",
        `${adapter.name} writes a model at ${formatPath(setting.path)}, so it cannot be wired without one`,
      );
}

/**
 * The key text of `record` as its files hold it now, so the wiring can be
 * rewritten (for example with another model list) without issuing a new key.
 * Undefined when the record has no key or no file holds that key any more
 * (the user replaced or removed it). Reads only.
 */
export async function wiredKeyText(
  record: WiringRecord,
  context: WiringContext,
): Promise<string | undefined> {
  checkRecord(record);
  const adapter = wiringAdapter(record.adapterId);
  await checkContext(context);
  if (record.keyId === undefined) return undefined;
  for (const entry of record.files) {
    const manifest = await readManifest(
      context.dataDir,
      adapter.id,
      entry.backupId!,
    );
    const { realPath } = await resolveFile(entry.path, [
      context.home,
      manifest.root,
    ]);
    const state = await readState(realPath);
    if (!state.exists) continue;
    let document: ConfigDocument;
    try {
      document = fileEditor(adapter, manifest).parse(
        decodeText(state.bytes, entry.path).text,
      );
    } catch (error) {
      if (error instanceof WiringError) continue;
      throw error;
    }
    for (const expected of manifest.expected)
      for (const [leaf, template] of leaves(expected.value, expected.path)) {
        const found = keyIn(
          getPath(document, leaf),
          template,
          manifest.baseUrl,
          record.keyId,
        );
        if (found) return found;
      }
  }
  return undefined;
}

/**
 * The key of `keyId` where `template` has the key placeholder, looking
 * inside list items and objects as drift matching does.
 */
function keyIn(
  actual: unknown,
  template: ConfigValue,
  baseUrl: string,
  keyId: GatewayKeyId,
): string | undefined {
  if (typeof template === "string") {
    if (!template.includes(KEY_PLACEHOLDER) || typeof actual !== "string")
      return undefined;
    return templatePattern(template, baseUrl)
      .exec(actual)
      ?.slice(1)
      .find((key) => parseGatewayKey(key!)?.keyId === keyId);
  }
  const pairs: Array<[unknown, ConfigValue]> = Array.isArray(template)
    ? Array.isArray(actual)
      ? template.map((item, index) => [actual[index], item])
      : []
    : typeof template === "object" && isRecord(actual)
      ? Object.entries(template).map(([key, item]) => [actual[key], item])
      : [];
  for (const [value, item] of pairs) {
    const found = keyIn(value, item, baseUrl, keyId);
    if (found) return found;
  }
  return undefined;
}

function resolveBaseUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WiringError(
      "WIRING_TARGET_INVALID",
      "The gateway base URL is not a URL",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new WiringError(
      "WIRING_TARGET_INVALID",
      "The gateway base URL must be http(s) without credentials, query or fragment",
    );
  return text.replace(/\/+$/, "");
}

/** Checks that `home` and `dataDir` are absolute and that `home` exists. */
export async function checkContext(context: WiringContext): Promise<void> {
  for (const [name, value] of [
    ["home", context.home],
    ["dataDir", context.dataDir],
  ] as const)
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new WiringError(
        "WIRING_CONTEXT_INVALID",
        `The wiring context needs an absolute ${name}`,
      );
  let home;
  try {
    home = await stat(context.home);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  if (!home?.isDirectory())
    throw new WiringError(
      "WIRING_CONTEXT_INVALID",
      "The home of the wiring context is not an existing directory",
    );
}

function checkRecord(record: WiringRecord): void {
  const hash = /^[0-9a-f]{64}$/;
  if (
    typeof record.adapterId !== "string" ||
    (record.keyId !== undefined && !isGatewayKeyId(record.keyId)) ||
    !Array.isArray(record.files) ||
    !record.files.every(
      (file) =>
        typeof file.path === "string" &&
        path.isAbsolute(file.path) &&
        hash.test(file.afterHash) &&
        (file.beforeHash === undefined || hash.test(file.beforeHash)) &&
        typeof file.backupId === "string" &&
        hash.test(file.backupId),
    )
  )
    throw new WiringError(
      "WIRING_RECORD_INVALID",
      "The wiring record is malformed or lacks a backup id for a file",
    );
}

/** The adapter view of a context: the home and the explicit directory overrides. */
export function adapterEnvironment(context: WiringContext): AdapterEnvironment {
  return {
    home: path.resolve(context.home),
    platform: process.platform,
    directory(name) {
      const value = context.env?.[name];
      if (value === undefined || value === "") return undefined;
      if (!path.isAbsolute(value))
        throw new WiringError(
          "WIRING_CONTEXT_INVALID",
          `${name} must be an absolute path to be used as a configuration directory`,
        );
      return path.resolve(value);
    },
    variable(name) {
      return context.env?.[name];
    },
  };
}

async function firstExisting(
  candidates: readonly string[],
  create: string,
): Promise<string> {
  for (const candidate of candidates)
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "ENOTDIR")) throw error;
    }
  return create;
}

/** Runs `action`, naming `file` in a WiringError that has no path yet. */
async function inFile<T>(file: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw withPath(error, file);
  }
}

function inFileSync<T>(file: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw withPath(error, file);
  }
}

function withPath(error: unknown, file: string): unknown {
  return error instanceof WiringError && error.path === undefined
    ? new WiringError(error.code, error.message, {
        path: file,
        rollback: error.rollback,
      })
    : error;
}
