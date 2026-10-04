// SPDX-License-Identifier: MIT
/**
 * The gateway's features as a backup or a sync carries them
 * (docs/backup-sync.md): outbound redaction (on or off, and the user's
 * rules), the vision model and the web search backends. A search backend's
 * API key follows the providers' rules: the value of a stored key only in a
 * backup with keys, an outside reference as it is. Image endpoints are part
 * of the provider records and travel with them.
 *
 * Bringing them in is a restore (additive: the backup's redaction switch,
 * rules by name and backends by kind and address replace this machine's,
 * the others are added, nothing is removed) or a sync's mirror (the
 * server's settings exactly). Turning redaction off is a security change:
 * the result says so, for the restore summary and the sync notice to show.
 */
import type { SecretReference } from "@harnesshub/core/engine-configuration";
import {
  redactionRuleProblem,
  searchBackendProblem,
  type GatewayFeatures,
  type RedactionRule,
  type SearchBackend,
  type SearchBackendKind,
} from "@harnesshub/core/gateway-features";
import { parseModelRef } from "@harnesshub/core/model-plane";
import { isTimestamp } from "@harnesshub/core/model-plane-records";
import type { BackupSecret } from "./backup.js";
import type { ManagedSecrets } from "./http/api-v1.js";

/** A search backend in a backup: its key like a provider credential's secret. */
export interface BackupSearchBackend {
  id: string;
  kind: SearchBackendKind;
  baseUrl?: string;
  /** Absent for a backend without a key (SearXNG may have none). */
  key?: BackupSecret;
}

export interface BackupGatewayFeatures {
  /** When the settings were last changed where they were collected; absent if never. */
  updatedAt?: string;
  redaction: { enabled: boolean; rules: RedactionRule[] };
  /** The vision model (a Model Ref or `group/<id>`). */
  vision?: { model: string };
  search: BackupSearchBackend[];
}

/** What bringing the features in does (a dry run) or did. */
export interface FeaturesRestore {
  redaction: {
    /** Outbound redaction after bringing them in. */
    enabled: boolean;
    /** It is on here and the backup turns it off: a security change to show. */
    turnsOff: boolean;
    turnsOn: boolean;
  };
  /** The user's redaction rules, by name. */
  rules: { added: string[]; replaced: string[]; removed: string[] };
  /** The vision model after bringing them in; null when there is none. */
  vision: {
    model: string;
    changed: boolean;
    /** Why the model or group is not here after the restore; it is set all the same. */
    unresolved?: string;
  } | null;
  /** Search backends as `kind` or `kind baseUrl`. */
  search: {
    added: string[];
    replaced: string[];
    removed: string[];
    /**
     * A stored key the backup has no value for and this machine lacks: the
     * backend is not brought in (add it again with hh gateway search add).
     */
    needKey: string[];
  };
}

/** The features file as backups use it (`GatewayFeaturesFile`). */
export interface GatewayFeaturesBackups {
  current(): GatewayFeatures;
  replace(next: GatewayFeatures): Promise<void>;
}

export interface FeaturesBackupOptions {
  features: GatewayFeaturesBackups;
  secrets: Pick<ManagedSecrets, "create" | "delete" | "resolve">;
  /** The daemon's environment snapshot, for `env` references. */
  environment: Readonly<NodeJS.ProcessEnv>;
  clock?: () => Date;
}

const label = (backend: { kind: string; baseUrl?: string | undefined }) =>
  backend.baseUrl ? `${backend.kind} ${backend.baseUrl}` : backend.kind;

/** Two backends are the same one: the same kind at the same address. */
const sameBackend = (
  left: { kind: string; baseUrl?: string | undefined },
  right: { kind: string; baseUrl?: string | undefined },
) => left.kind === right.kind && (left.baseUrl ?? "") === (right.baseUrl ?? "");

/** Carries the gateway features into backups and brings them back. */
export class FeaturesBackup {
  constructor(private readonly options: FeaturesBackupOptions) {}

  /** The features as a backup holds them; key values only with `keys`. */
  async carry(keys: boolean): Promise<BackupGatewayFeatures> {
    const current = this.options.features.current();
    const search: BackupSearchBackend[] = [];
    for (const backend of current.search?.backends ?? [])
      search.push({
        id: backend.id,
        kind: backend.kind,
        ...(backend.baseUrl !== undefined ? { baseUrl: backend.baseUrl } : {}),
        ...(backend.credential
          ? { key: await this.secretOf(backend.credential, keys) }
          : {}),
      });
    return {
      ...(current.updatedAt !== undefined
        ? { updatedAt: current.updatedAt }
        : {}),
      redaction: structuredClone(current.redaction),
      ...(current.vision ? { vision: { ...current.vision } } : {}),
      search,
    };
  }

  /** When the features were last changed here; undefined if never. */
  lastChange(): string | undefined {
    return this.options.features.current().updatedAt;
  }

  /**
   * Brings `part` in: with `mirror` (sync) the settings become the part's
   * exactly, otherwise (restore) the part's switch, rules and backends
   * replace or add to this machine's. New keys go to the secret store
   * first and are removed again when the settings cannot be written; keys
   * of this machine that no backend refers to any more are removed after.
   * `unresolved` says why a vision model is not here, if it is not.
   */
  async bring(
    part: BackupGatewayFeatures,
    options: {
      mirror: boolean;
      dryRun: boolean;
      unresolved: (model: string) => Promise<string | undefined>;
    },
  ): Promise<FeaturesRestore> {
    const { features, secrets } = this.options;
    const here = features.current();
    const local = [...(here.search?.backends ?? [])];
    const remaining = [...local];
    const summary: FeaturesRestore = {
      redaction: {
        enabled: part.redaction.enabled,
        turnsOff: here.redaction.enabled && !part.redaction.enabled,
        turnsOn: !here.redaction.enabled && part.redaction.enabled,
      },
      rules: { added: [], replaced: [], removed: [] },
      vision: null,
      search: { added: [], replaced: [], removed: [], needKey: [] },
    };
    // Rules by name, as the validator compares them.
    const name = (rule: RedactionRule) => rule.name.toUpperCase();
    let rules: RedactionRule[];
    if (options.mirror) {
      rules = structuredClone(part.redaction.rules);
      for (const rule of here.redaction.rules)
        if (!rules.some((item) => name(item) === name(rule)))
          summary.rules.removed.push(rule.name);
    } else {
      rules = structuredClone(here.redaction.rules);
      for (const rule of part.redaction.rules) {
        const at = rules.findIndex((item) => name(item) === name(rule));
        if (at >= 0) rules[at] = structuredClone(rule);
        else rules.push(structuredClone(rule));
      }
    }
    for (const rule of part.redaction.rules)
      if (!here.redaction.rules.some((item) => name(item) === name(rule)))
        summary.rules.added.push(rule.name);
      else if (
        sorted(
          here.redaction.rules.find((item) => name(item) === name(rule)),
        ) !== sorted(rule)
      )
        summary.rules.replaced.push(rule.name);
    // Backends: the same kind at the same address is the same backend.
    const created: SecretReference[] = [];
    const brought: SearchBackend[] = [];
    const replaced = new Map<SearchBackend, SearchBackend>();
    const ids = new Set(local.map((item) => item.id));
    let next = 1;
    const freshId = () => {
      while (ids.has(`search-${next}`)) next++;
      ids.add(`search-${next}`);
      return `search-${next}`;
    };
    try {
      for (const item of part.search) {
        const at = remaining.findIndex((own) => sameBackend(own, item));
        const own = at >= 0 ? remaining.splice(at, 1)[0] : undefined;
        let credential: SecretReference | undefined;
        if (item.key === undefined) credential = undefined;
        else if (item.key.source === "reference")
          credential = { kind: item.key.kind, value: item.key.name };
        else if (item.key.value !== undefined) {
          if (
            own?.credential?.kind === "store" &&
            (await this.resolve(own.credential)) === item.key.value
          )
            credential = own.credential;
          else if (options.dryRun)
            credential = { kind: "store", value: "(to be stored)" };
          else {
            credential = await secrets.create(item.key.value);
            created.push(credential);
          }
        } else if (own?.credential) credential = own.credential;
        else {
          summary.search.needKey.push(label(item));
          // A backend here stays as it is.
          if (own) remaining.splice(at, 0, own);
          continue;
        }
        const backend: SearchBackend = {
          id: options.mirror ? item.id : (own?.id ?? freshId()),
          kind: item.kind,
          ...(item.baseUrl !== undefined ? { baseUrl: item.baseUrl } : {}),
          ...(credential ? { credential } : {}),
        };
        if (own) {
          replaced.set(own, backend);
          if (sorted(own) !== sorted(backend))
            summary.search.replaced.push(label(item));
        } else summary.search.added.push(label(item));
        brought.push(backend);
      }
      let backends: SearchBackend[];
      if (options.mirror) {
        backends = brought;
        for (const own of remaining) summary.search.removed.push(label(own));
      } else
        // This machine's order, replaced in place; the backup's new ones after.
        backends = [
          ...local.map((own) => replaced.get(own) ?? own),
          ...brought.filter((item) => ![...replaced.values()].includes(item)),
        ];
      const vision = part.vision
        ? { ...part.vision }
        : options.mirror
          ? undefined
          : here.vision;
      if (vision) {
        const unresolved = await options.unresolved(vision.model);
        summary.vision = {
          model: vision.model,
          changed: here.vision?.model !== vision.model,
          ...(unresolved ? { unresolved } : {}),
        };
      }
      const settings: GatewayFeatures = {
        schemaVersion: 1,
        redaction: { enabled: part.redaction.enabled, rules },
        ...(vision ? { vision } : {}),
        ...(backends.length ? { search: { backends } } : {}),
      };
      const { updatedAt: _before, ...current } = here;
      const changed = sorted(settings) !== sorted(current);
      const updatedAt = options.mirror
        ? part.updatedAt
        : changed
          ? (this.options.clock?.() ?? new Date()).toISOString()
          : here.updatedAt;
      if (updatedAt !== undefined) settings.updatedAt = updatedAt;
      if (options.dryRun || !changed) return summary;
      await features.replace(settings);
    } catch (error) {
      for (const ref of created) await secrets.delete(ref).catch(() => false);
      throw error;
    }
    // Keys of this machine no backend refers to any more.
    const kept = new Set(
      (features.current().search?.backends ?? []).flatMap((item) =>
        item.credential?.kind === "store" ? [item.credential.value] : [],
      ),
    );
    for (const own of local)
      if (own.credential?.kind === "store" && !kept.has(own.credential.value))
        await secrets.delete(own.credential).catch(() => false);
    return summary;
  }

  private async secretOf(
    ref: SecretReference,
    keys: boolean,
  ): Promise<BackupSecret> {
    if (ref.kind !== "store")
      return { source: "reference", kind: ref.kind, name: ref.value };
    return keys
      ? {
          source: "store",
          value: await this.options.secrets.resolve(
            ref,
            this.options.environment,
          ),
        }
      : { source: "store" };
  }

  /** A stored value to compare with; undefined when it cannot be read. */
  private async resolve(ref: SecretReference): Promise<string | undefined> {
    try {
      return await this.options.secrets.resolve(ref, this.options.environment);
    } catch {
      return undefined;
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackupSecret(value: unknown): value is BackupSecret {
  if (!object(value)) return false;
  return value.source === "store"
    ? value.value === undefined ||
        (typeof value.value === "string" && value.value.length > 0)
    : value.source === "reference" &&
        ["env", "file", "keychain"].includes(value.kind as string) &&
        typeof value.name === "string" &&
        value.name.length > 0;
}

/** Validates a bundle's gateway features (they come from a file or a server). */
export function isBackupGatewayFeatures(
  value: unknown,
): value is BackupGatewayFeatures {
  if (!object(value) || !object(value.redaction)) return false;
  const { redaction } = value;
  if (
    typeof redaction.enabled !== "boolean" ||
    !Array.isArray(redaction.rules) ||
    redaction.rules.length > 64 ||
    !redaction.rules.every((rule) => redactionRuleProblem(rule) === undefined)
  )
    return false;
  const names = redaction.rules.map((rule) =>
    (rule as RedactionRule).name.toUpperCase(),
  );
  if (new Set(names).size !== names.length) return false;
  if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt))
    return false;
  if (
    value.vision !== undefined &&
    !(
      object(value.vision) &&
      typeof value.vision.model === "string" &&
      parseModelRef(value.vision.model) !== undefined
    )
  )
    return false;
  if (!Array.isArray(value.search) || value.search.length > 16) return false;
  const ids = new Set<string>();
  for (const item of value.search) {
    if (!object(item)) return false;
    if (item.key !== undefined && !isBackupSecret(item.key)) return false;
    const problem = searchBackendProblem({
      id: item.id,
      kind: item.kind,
      ...(item.baseUrl !== undefined ? { baseUrl: item.baseUrl } : {}),
      // Its shape is checked above; the backend only needs to have one.
      ...(item.key !== undefined
        ? { credential: { kind: "store", value: "carried" } }
        : {}),
    });
    if (problem || ids.has(item.id as string)) return false;
    ids.add(item.id as string);
    const allowed = ["id", "kind", "baseUrl", "key"];
    if (Object.keys(item).some((key) => !allowed.includes(key))) return false;
  }
  const allowed = ["updatedAt", "redaction", "vision", "search"];
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    Object.keys(redaction).every((key) => ["enabled", "rules"].includes(key))
  );
}

/** JSON with object keys sorted, for comparing settings. */
function sorted(value: unknown): string {
  const order = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(order)
      : object(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, order(item[key])]),
          )
        : item;
  return JSON.stringify(order(value));
}

/** The part as sync compares it: without the time it was changed. */
export function featuresView(
  features: BackupGatewayFeatures | undefined,
): unknown {
  if (!features) return { redaction: { enabled: true, rules: [] }, search: [] };
  const { updatedAt: _updatedAt, ...rest } = features;
  return rest;
}

/** Whether the part holds nothing but the defaults (redaction on, nothing else). */
export function emptyFeatures(
  features: BackupGatewayFeatures | undefined,
): boolean {
  return (
    !features ||
    (features.redaction.enabled &&
      features.redaction.rules.length === 0 &&
      features.vision === undefined &&
      features.search.length === 0)
  );
}

/**
 * `from` with the key values it lacks taken from the same backend in `to`
 * (by id, else by kind and address), so that a side carrying no values does
 * not take the other's away.
 */
export function withFeaturesValues(
  from: BackupGatewayFeatures,
  to: BackupGatewayFeatures | undefined,
): BackupGatewayFeatures {
  return {
    ...from,
    search: from.search.map((item) => {
      if (item.key?.source !== "store" || item.key.value !== undefined)
        return item;
      const other =
        to?.search.find((entry) => entry.id === item.id) ??
        to?.search.find((entry) => sameBackend(entry, item));
      return other?.key?.source === "store" && other.key.value !== undefined
        ? { ...item, key: { source: "store", value: other.key.value } }
        : item;
    }),
  };
}
