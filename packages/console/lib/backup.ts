// SPDX-License-Identifier: MIT
/**
 * Backup, restore and sync helpers of the settings page (docs/backup-sync.md).
 * Passphrases and target secrets live only in form state: they go to the
 * daemon in one request and are never stored by the page.
 */
import type {
  BackupEnvelope,
  RestoreSummary,
  SyncSettings,
  SyncStatus,
} from "@harnesshub/sdk/client";
import { t } from "./i18n";

/** `harnesshub-2026-10-04.harnesshub-backup`, by the local date. */
export function backupFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `harnesshub-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.harnesshub-backup`;
}

/**
 * The envelope in a chosen file. Only the JSON and its format are checked
 * here; the daemon opens and checks everything else when it restores.
 */
export function readBackupFile(text: string): BackupEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(t("backup.file.notJson"));
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { format?: unknown }).format !== "harnesshub-backup"
  )
    throw new Error(t("backup.file.noFormat"));
  return value as BackupEnvelope;
}

const restoreAgentTones: Record<
  RestoreSummary["agents"][number]["action"],
  "good" | "neutral" | "warn"
> = {
  wire: "good",
  unchanged: "neutral",
  "skip-disabled": "neutral",
  "skip-not-installed": "warn",
  "skip-unknown": "warn",
  "skip-unavailable": "warn",
};

/** What a restore does with an agent, as a label and a tone. */
export function restoreAgentAction(
  action: RestoreSummary["agents"][number]["action"],
): { label: string; tone: "good" | "neutral" | "warn" } {
  return {
    label: t(`backup.agentAction.${action}`),
    tone: restoreAgentTones[action],
  };
}

/** Whether a restore brought Library items in that agents' files may need. */
export function libraryChanged(summary: RestoreSummary): boolean {
  const library = summary.library;
  if (!library) return false;
  return [library.instructions, library.mcp, library.skills].some(
    (part) => part.added.length + part.replaced.length + part.removed.length,
  );
}

/** One line of a restore summary's part: a label and the names it lists. */
export interface SummaryPart {
  label: string;
  items: string[];
  tone?: "warn" | "error";
}

/**
 * A restore's gateway features (`summary.gatewayFeatures`) as the summary
 * shows them: outbound redaction's state, a warning when the backup turns
 * it off; rules and search backends by change, those needing a key as a
 * warning; and the vision model, with why it is not here when it is not.
 */
export function restoreFeatures(
  features: NonNullable<RestoreSummary["gatewayFeatures"]>,
): {
  redaction: { label: string; tone: "good" | "warn" | "" };
  parts: SummaryPart[];
  vision: { label: string; unresolved?: string };
} {
  const { redaction, rules, search, vision } = features;
  return {
    redaction: redaction.turnsOff
      ? { label: t("backup.restore.redactionTurnsOff"), tone: "warn" }
      : redaction.turnsOn
        ? { label: t("backup.restore.redactionTurnsOn"), tone: "good" }
        : {
            label: redaction.enabled
              ? t("backup.restore.redactionOn")
              : t("backup.restore.redactionOff"),
            tone: "",
          },
    parts: [
      { label: t("backup.restore.addedRules"), items: rules.added },
      { label: t("backup.restore.replacedRules"), items: rules.replaced },
      { label: t("backup.restore.removedRules"), items: rules.removed },
      { label: t("backup.restore.addedSearch"), items: search.added },
      { label: t("backup.restore.replacedSearch"), items: search.replaced },
      { label: t("backup.restore.removedSearch"), items: search.removed },
      {
        label: t("backup.restore.searchNeedKey"),
        items: search.needKey,
        tone: "warn",
      },
    ],
    vision: vision
      ? {
          label: vision.changed
            ? t("backup.restore.visionChanged", { model: vision.model })
            : t("backup.restore.visionSame", { model: vision.model }),
          ...(vision.unresolved !== undefined
            ? {
                unresolved: t("backup.restore.visionUnresolved", {
                  reason: vision.unresolved,
                }),
              }
            : {}),
        }
      : { label: t("backup.restore.visionKept") },
  };
}

/** Where the restore summary and the sync status send people to add search keys or turn redaction back on. */
export const featureSections = {
  redaction: "?section=redaction",
  search: "?section=search",
} as const;

/** The editable sync settings; secrets start empty and are sent once. */
export interface SyncForm {
  kind: "webdav" | "s3";
  url: string;
  user: string;
  /** The WebDAV password or the S3 secret access key; empty keeps the stored one. */
  secret: string;
  /** Empty keeps the stored one. */
  passphrase: string;
  confirm: string;
  endpoint: string;
  region: string;
  pathStyle: "auto" | "yes" | "no";
  keys: boolean;
  agents: boolean;
}

export function syncFormOf(status: SyncStatus | undefined): SyncForm {
  const enabled = status?.enabled === true;
  return {
    kind: (enabled && status.kind) || "webdav",
    url: (enabled && status.url) || "",
    user: (enabled && status.user) || "",
    secret: "",
    passphrase: "",
    confirm: "",
    endpoint: (enabled && status.endpoint) || "",
    region: (enabled && status.region) || "",
    pathStyle:
      enabled && status.pathStyle !== undefined
        ? status.pathStyle
          ? "yes"
          : "no"
        : "auto",
    keys: enabled ? status.keys !== false : true,
    agents: enabled ? status.agents !== false : true,
  };
}

/**
 * The `PUT /sync` body, or the reason the form cannot be sent. Turning
 * sync on needs a passphrase, typed twice; once it is on, empty secrets
 * keep the stored ones (the daemon keeps a target's secret only while the
 * target is the same).
 */
export function syncSettings(
  form: SyncForm,
  status: SyncStatus | undefined,
): { settings: SyncSettings } | { error: string } {
  const url = form.url.trim();
  if (!url)
    return {
      error:
        form.kind === "webdav"
          ? t("backup.syncDialog.needWebdav")
          : t("backup.syncDialog.needBucket"),
    };
  if (form.kind === "s3" && !form.user.trim())
    return { error: t("backup.syncDialog.needAccessKey") };
  if (!status?.enabled && !form.passphrase)
    return { error: t("backup.syncDialog.needPassphrase") };
  if (form.passphrase !== form.confirm)
    return { error: t("backup.passphraseMismatch") };
  const s3 = form.kind === "s3";
  return {
    settings: {
      kind: form.kind,
      url,
      ...(form.user.trim() ? { user: form.user.trim() } : {}),
      ...(form.secret ? { secret: form.secret } : {}),
      ...(form.passphrase ? { passphrase: form.passphrase } : {}),
      ...(s3 && form.endpoint.trim() ? { endpoint: form.endpoint.trim() } : {}),
      ...(s3 && form.region.trim() ? { region: form.region.trim() } : {}),
      ...(s3 && form.pathStyle !== "auto"
        ? { pathStyle: form.pathStyle === "yes" }
        : {}),
      keys: form.keys,
      agents: form.agents,
    },
  };
}

/** The name of one part of the synced settings. */
export function syncPartName(
  part: NonNullable<SyncStatus["notice"]>["here"][number],
): string {
  return t(`backup.sync.part.${part}`);
}
