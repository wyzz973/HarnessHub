// SPDX-License-Identifier: MIT
import { useCallback, useRef, useState } from "react";
import {
  CloudUpload,
  Download,
  FileUp,
  Loader2,
  Pencil,
  Power,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type {
  Agent,
  BackupEnvelope,
  RestoreSummary,
  SyncStatus,
} from "@harnesshub/sdk/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  backupFileName,
  featureSections,
  libraryChanged,
  readBackupFile,
  restoreAgentAction,
  restoreFeatures,
  syncFormOf,
  syncPartName,
  syncSettings,
  type SyncForm,
} from "@/lib/backup";
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { installedLibraryAgents } from "@/lib/library";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { navigate } from "@/lib/router";
import { notify } from "@/lib/toast";
import { LibrarySync } from "./library-sync";
import {
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorCallout,
  LoadError,
  LocalTime,
  PageHeader,
  Row,
  useLoaded,
} from "./model-plane-ui";

/** The daemon reads at most 64 MiB of a restore request. */
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

function PassphraseFields({
  passphrase,
  confirm,
  onPassphrase,
  onConfirm,
  label,
  optional,
}: {
  passphrase: string;
  confirm: string;
  onPassphrase: (value: string) => void;
  onConfirm: (value: string) => void;
  label?: string;
  optional?: string;
}) {
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="field-label">
        {label ?? t("backup.passphrase")}
        <input
          className="field"
          type="password"
          value={passphrase}
          autoComplete="new-password"
          placeholder={optional}
          onChange={(event) => onPassphrase(event.target.value)}
        />
      </label>
      <label className="field-label">
        {t("backup.passphraseAgain")}
        <input
          className="field"
          type="password"
          value={confirm}
          autoComplete="new-password"
          aria-invalid={mismatch}
          onChange={(event) => onConfirm(event.target.value)}
        />
        {mismatch ? (
          <span role="alert" className="field-hint block text-danger">
            {t("backup.passphraseMismatch")}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** Download a sealed backup; the passphrase is typed twice and dropped after. */
function BackupCard() {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keys, setKeys] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const ready = passphrase.length > 0 && passphrase === confirm;
  const download = () => {
    setBusy(true);
    setFailure(null);
    modelPlane()
      .backup.create({ passphrase, keys })
      .then(
        (envelope) => {
          setBusy(false);
          setPassphrase("");
          setConfirm("");
          const url = URL.createObjectURL(
            new Blob([`${JSON.stringify(envelope)}\n`], {
              type: "application/json",
            }),
          );
          const link = document.createElement("a");
          link.href = url;
          link.download = backupFileName(new Date());
          document.body.append(link);
          link.click();
          link.remove();
          // Some browsers read the blob after the click returns.
          window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          notify.success(
            t("backup.backup.downloaded", { file: link.download }),
          );
        },
        (reason: unknown) => {
          setBusy(false);
          setFailure(failureOf(reason));
        },
      );
  };
  return (
    <Card title={t("backup.backup.title")} lede={t("backup.backup.lede")}>
      <PassphraseFields
        passphrase={passphrase}
        confirm={confirm}
        onPassphrase={setPassphrase}
        onConfirm={setConfirm}
      />
      <Checkbox checked={keys} onChange={setKeys}>
        {t("backup.backup.keys")}
      </Checkbox>
      <p className="field-hint">
        {keys
          ? t("backup.backup.hintWithKeys")
          : t("backup.backup.hintWithoutKeys")}
      </p>
      <ErrorCallout failure={failure} />
      <div className="flex justify-end">
        <Button disabled={busy || !ready} onClick={download}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          {t("backup.backup.download")}
        </Button>
      </div>
    </Card>
  );
}

function Names({ items, tone }: { items: string[]; tone?: string }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {items.map((item) => (
        <span key={item} className={`tag ${tone ?? ""} font-mono`}>
          {item}
        </span>
      ))}
    </span>
  );
}

/** Gateway features › {section}, as the summary and the sync status name it. */
function featuresPage(section: "redaction" | "search"): string {
  return `${t("settings.tab.features")} › ${t(
    section === "redaction"
      ? "settings.redaction.title"
      : "settings.search.title",
  )}`;
}

/** Outbound redaction turned off by a restore or a sync: a security change, shown prominently. */
function RedactionOffWarning({
  children,
  action,
}: {
  children: React.ReactNode;
  action: boolean;
}) {
  return (
    <div role="alert" className="callout warn items-start">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-medium">{children}</span>
      {action ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            navigate("features", { search: featureSections.redaction })
          }
        >
          {t("backup.restore.openRedaction")}
        </Button>
      ) : null}
    </div>
  );
}

/** Search backends brought in without a key, with the way to add one. */
function SearchNeedKey({
  names,
  text,
}: {
  names: string[];
  text: React.ReactNode;
}) {
  return (
    <div className="callout info items-center">
      <span className="min-w-0 flex-1">
        {text} <Names items={names} tone="warn" />
      </span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => navigate("features", { search: featureSections.search })}
      >
        {t("backup.restore.openSearch")}
      </Button>
    </div>
  );
}

/** Each part's label and its names (added, replaced, …), with nothing for empty parts. */
function Changes({
  parts,
}: {
  parts: Array<{ label: string; items: string[]; tone?: string }>;
}) {
  const shown = parts.filter((part) => part.items.length);
  if (!shown.length)
    return <span className="text-subtle">{t("backup.restore.noChanges")}</span>;
  return (
    <span className="flex flex-col gap-1.5">
      {shown.map((part) => (
        <span key={part.label} className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] text-muted-foreground">
            {part.label}
          </span>
          <Names items={part.items} tone={part.tone} />
        </span>
      ))}
    </span>
  );
}

/**
 * What a restore does (`done` false: the dry run) or did: records added and
 * replaced, what needs a key or a secret again, the agents re-wired and
 * the client keys to issue again.
 */
function RestoreSummaryView({
  summary,
  done,
  names,
}: {
  summary: RestoreSummary;
  done: boolean;
  names: ReadonlyMap<string, string>;
}) {
  const library = summary.library;
  const features = summary.gatewayFeatures
    ? restoreFeatures(summary.gatewayFeatures)
    : undefined;
  return (
    <div className="space-y-3 rounded-xl border p-4">
      {summary.gatewayFeatures?.redaction.turnsOff ? (
        <RedactionOffWarning action={done}>
          {done
            ? t("backup.restore.turnsOffDone")
            : t("backup.restore.turnsOffPreview")}
        </RedactionOffWarning>
      ) : null}
      <p className="text-[13px]">
        {tr(
          summary.keys
            ? "backup.restore.madeWithKeys"
            : "backup.restore.madeWithoutKeys",
          {
            time: <LocalTime value={summary.createdAt} />,
            app: <span className="font-mono">{summary.app}</span>,
          },
        )}
      </p>
      <dl className="text-[13px]">
        <Row label="Provider">
          <Changes
            parts={[
              {
                label: t("backup.restore.added"),
                items: summary.providers.added,
              },
              {
                label: t("backup.restore.replaced"),
                items: summary.providers.replaced,
              },
              {
                label: t("backup.restore.needKey"),
                items: summary.providers.needKey,
                tone: "warn",
              },
              {
                label: t("backup.restore.signInAgain"),
                items: summary.providers.signInAgain,
                tone: "warn",
              },
              {
                label: t("backup.restore.signedInHere"),
                items: summary.providers.signedInHere,
              },
            ]}
          />
        </Row>
        <Row label={t("backup.restore.groups")}>
          <Changes
            parts={[
              { label: t("backup.restore.added"), items: summary.groups.added },
              {
                label: t("backup.restore.replaced"),
                items: summary.groups.replaced,
              },
              {
                label: t("backup.restore.groupsSkipped"),
                items: summary.groups.skipped,
                tone: "warn",
              },
            ]}
          />
        </Row>
        <Row label={t("backup.restore.overrides")}>
          {t("backup.restore.overrideCount", { count: summary.overrides })}
        </Row>
        <Row label="Profile">
          <Changes
            parts={[
              {
                label: t("backup.restore.added"),
                items: summary.profiles.added,
              },
              {
                label: t("backup.restore.replaced"),
                items: summary.profiles.replaced,
              },
            ]}
          />
        </Row>
        <Row label="Library">
          {library ? (
            <Changes
              parts={[
                {
                  label: t("backup.restore.addedInstructions"),
                  items: library.instructions.added,
                },
                {
                  label: t("backup.restore.replacedInstructions"),
                  items: library.instructions.replaced,
                },
                {
                  label: t("backup.restore.addedMcp"),
                  items: library.mcp.added,
                },
                {
                  label: t("backup.restore.replacedMcp"),
                  items: library.mcp.replaced,
                },
                {
                  label: t("backup.restore.needSecret"),
                  items: library.mcp.needSecret,
                  tone: "warn",
                },
                {
                  label: t("backup.restore.addedSkills"),
                  items: library.skills.added,
                },
                {
                  label: t("backup.restore.replacedSkills"),
                  items: library.skills.replaced,
                },
                {
                  label: t("backup.restore.incomplete"),
                  items: library.skills.incomplete,
                  tone: "warn",
                },
                {
                  label: t("backup.restore.refused"),
                  items: library.refused.map(
                    (item) => `${item.kind}:${item.name}`,
                  ),
                  tone: "error",
                },
              ]}
            />
          ) : (
            <span className="text-subtle">
              {t("backup.restore.libraryLeftOut")}
            </span>
          )}
        </Row>
        <Row label={t("backup.restore.features")}>
          {features ? (
            <span className="flex flex-col gap-1.5">
              <span>
                <span
                  className={
                    features.redaction.tone
                      ? `tag ${features.redaction.tone}`
                      : undefined
                  }
                >
                  {features.redaction.label}
                </span>
              </span>
              <span className="text-[12.5px]">{features.vision.label}</span>
              {features.vision.unresolved ? (
                <span className="text-[12.5px] text-warning">
                  {features.vision.unresolved}
                </span>
              ) : null}
              {features.parts.some((part) => part.items.length) ? (
                <Changes parts={features.parts} />
              ) : null}
            </span>
          ) : (
            <span className="text-subtle">
              {t("backup.restore.featuresLeftOut")}
            </span>
          )}
        </Row>
        <Row label={t("backup.restore.share")}>
          {t(`backup.restore.share.${summary.gatewayShare.action}`)}
          {summary.gatewayShare.error ? (
            <span className="block text-danger">
              {summary.gatewayShare.error}
            </span>
          ) : null}
        </Row>
        {summary.catalog?.differs ? (
          <Row label={t("backup.restore.catalog")}>
            {t("backup.restore.catalogDiffers")}
          </Row>
        ) : null}
      </dl>
      {library?.refused.length ? (
        <ul className="callout error block list-disc space-y-0.5 pl-8">
          {library.refused.map((item) => (
            <li key={`${item.kind}:${item.name}`}>
              <span className="font-mono">
                {item.kind}:{item.name}
              </span>{" "}
              {item.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.gatewayFeatures?.search.needKey.length ? (
        <SearchNeedKey
          names={summary.gatewayFeatures.search.needKey}
          text={t("backup.restore.searchNeedKeyHint", {
            page: featuresPage("search"),
          })}
        />
      ) : null}
      {summary.agents.length ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="data-table min-w-[560px]">
            <thead>
              <tr>
                <th>Agent</th>
                <th>{t("backup.restore.model")}</th>
                <th>
                  {done
                    ? t("backup.restore.result")
                    : t("backup.restore.planned")}
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.agents.map((agent) => {
                const action = restoreAgentAction(agent.action);
                return (
                  <tr key={agent.agent}>
                    <td>{names.get(agent.agent) ?? agent.agent}</td>
                    <td className="font-mono text-[12.5px]">
                      {agent.model ?? t("backup.restore.ownSignIn")}
                    </td>
                    <td>
                      {agent.outcome === "failed" ? (
                        <span className="tag error" title={agent.error}>
                          {t("backup.restore.wireFailed")}
                        </span>
                      ) : agent.outcome === "wired" ? (
                        <span className="tag good">
                          {t("backup.restore.rewired")}
                        </span>
                      ) : (
                        <span className={`tag ${action.tone}`}>
                          {action.label}
                        </span>
                      )}
                      {agent.error ? (
                        <span className="mt-1 block text-[12px] text-danger">
                          {agent.error}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {summary.clientKeys.length ? (
        <div className="callout info items-center">
          <span className="min-w-0 flex-1">
            {t("backup.restore.clientKeys")}
            <Names items={summary.clientKeys.map((key) => key.name)} />
          </span>
          {done ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => navigate("keys")}
            >
              {t("backup.restore.issue")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type RestorePhase =
  | { step: "idle" }
  | { step: "busy"; dryRun: boolean }
  | { step: "preview"; summary: RestoreSummary }
  | { step: "done"; summary: RestoreSummary };

/**
 * Restore a backup file: preview first (`dryRun`), then restore exactly
 * with the same choices. A restore that brought Library items in offers
 * to sync them into the agents installed here.
 */
function RestoreCard() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{
    name: string;
    envelope: BackupEnvelope;
  } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [agents, setAgents] = useState(true);
  const [library, setLibrary] = useState(true);
  const [phase, setPhase] = useState<RestorePhase>({ step: "idle" });
  const [failure, setFailure] = useState<Failure | null>(null);
  const [agentList, setAgentList] = useState<Agent[] | null>(null);
  const reset = () => {
    setPhase({ step: "idle" });
    setFailure(null);
  };
  const choose = (chosen: File | undefined) => {
    reset();
    setFile(null);
    setFileError(null);
    if (!chosen) return;
    if (chosen.size > MAX_BACKUP_BYTES) {
      setFileError(t("backup.file.tooLarge"));
      return;
    }
    chosen.text().then(
      (text) => {
        try {
          setFile({ name: chosen.name, envelope: readBackupFile(text) });
        } catch (error) {
          setFileError(error instanceof Error ? error.message : String(error));
        }
      },
      () => setFileError(t("backup.file.readFailed")),
    );
  };
  const run = (dryRun: boolean) => {
    if (!file) return;
    setPhase({ step: "busy", dryRun });
    setFailure(null);
    const client = modelPlane();
    client.backup
      .restore({
        backup: file.envelope,
        passphrase,
        agents,
        library,
        dryRun,
      })
      .then(
        async (summary) => {
          // Names, and the agents a Library sync goes to.
          setAgentList(
            await client.agents.list().then(
              (page) => page.items,
              () => [],
            ),
          );
          if (dryRun) {
            setPhase({ step: "preview", summary });
            return;
          }
          setPassphrase("");
          setPhase({ step: "done", summary });
          notify.success(t("backup.restore.restored"));
        },
        (reason: unknown) => {
          setPhase({ step: "idle" });
          setFailure(failureOf(reason));
        },
      );
  };
  const busy = phase.step === "busy";
  const names = new Map(
    (agentList ?? []).map((agent) => [agent.id, agent.name]),
  );
  const syncTo = agentList ? installedLibraryAgents(agentList) : [];
  return (
    <Card title={t("backup.restore.title")} lede={t("backup.restore.lede")}>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInput}
          type="file"
          accept=".harnesshub-backup,.json,application/json"
          className="sr-only"
          aria-label={t("backup.restore.chooseFile")}
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <FileUp />
          {t("backup.restore.chooseFile")}
        </Button>
        <span className="min-w-0 truncate font-mono text-[12.5px] text-muted-foreground">
          {file ? file.name : t("backup.restore.noFile")}
        </span>
      </div>
      {fileError ? (
        <p role="alert" className="callout error">
          {fileError}
        </p>
      ) : null}
      <label className="field-label">
        {t("backup.passphrase")}
        <input
          className="field"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(event) => {
            setPassphrase(event.target.value);
            if (phase.step === "preview") reset();
          }}
        />
      </label>
      <div className="grid gap-x-2 sm:grid-cols-2">
        <Checkbox
          checked={agents}
          disabled={busy}
          onChange={(checked) => {
            setAgents(checked);
            if (phase.step === "preview") reset();
          }}
        >
          {t("backup.restore.agents")}
        </Checkbox>
        <Checkbox
          checked={library}
          disabled={busy}
          onChange={(checked) => {
            setLibrary(checked);
            if (phase.step === "preview") reset();
          }}
        >
          {t("backup.restore.library")}
        </Checkbox>
      </div>
      <ErrorCallout failure={failure} />
      {phase.step === "preview" ? (
        <>
          <RestoreSummaryView
            summary={phase.summary}
            done={false}
            names={names}
          />
          {phase.summary.library ? (
            <p className="text-[12.5px] text-muted-foreground">
              {t("backup.restore.libraryNote")}
            </p>
          ) : null}
        </>
      ) : null}
      {phase.step === "done" ? (
        <RestoreSummaryView summary={phase.summary} done names={names} />
      ) : null}
      {phase.step === "done" && libraryChanged(phase.summary) && agentList ? (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="section-title">{t("backup.restore.syncTitle")}</h3>
          {syncTo.length ? (
            <LibrarySync agents={agentList} initial={syncTo} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              {t("backup.restore.noLibraryAgents")}
            </p>
          )}
        </section>
      ) : null}
      {phase.step !== "done" ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy || !file || !passphrase}
            onClick={() => run(true)}
          >
            {busy && phase.dryRun ? <Loader2 className="animate-spin" /> : null}
            {t("backup.restore.preview")}
          </Button>
          <Button
            disabled={busy || phase.step !== "preview"}
            onClick={() => run(false)}
          >
            {busy && !phase.dryRun ? (
              <Loader2 className="animate-spin" />
            ) : null}
            {t("backup.restore.restore")}
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setFile(null);
              if (fileInput.current) fileInput.current.value = "";
              setAgentList(null);
              reset();
            }}
          >
            {t("backup.restore.done")}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Turn sync on or change it; saving syncs once, as `hh sync … on` does. */
function SyncDialog({
  status,
  onClose,
  onStatus,
}: {
  status: SyncStatus;
  onClose: () => void;
  onStatus: (status: SyncStatus) => void;
}) {
  const [form, setForm] = useState<SyncForm>(() => syncFormOf(status));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof SyncForm>(key: K, value: SyncForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Another kind is another target: its address and credentials start empty.
  const switchKind = (kind: SyncForm["kind"]) =>
    setForm((current) => ({
      ...syncFormOf(kind === status.kind ? status : undefined),
      kind,
      passphrase: current.passphrase,
      confirm: current.confirm,
      keys: current.keys,
      agents: current.agents,
    }));
  const s3 = form.kind === "s3";
  const save = () => {
    const result = syncSettings(
      form,
      saved ? { ...status, enabled: true } : status,
    );
    if ("error" in result) {
      setFailure({ message: result.error, fields: {}, references: [] });
      return;
    }
    setBusy(true);
    setFailure(null);
    const client = modelPlane();
    client.sync.configure(result.settings).then(
      (configured) => {
        // The secrets were sent once; the daemon keeps them from now on.
        setForm((current) => ({
          ...current,
          secret: "",
          passphrase: "",
          confirm: "",
        }));
        setSaved(true);
        onStatus(configured);
        client.sync.now().then(
          (synced) => {
            setBusy(false);
            onStatus(synced);
            notify.success(t("backup.syncDialog.done"));
            onClose();
          },
          (reason: unknown) => {
            setBusy(false);
            const problem = failureOf(reason);
            setFailure({
              ...problem,
              message: t("backup.syncDialog.firstFailed", {
                message: problem.message,
              }),
            });
          },
        );
      },
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  const enabled = status.enabled || saved;
  // The daemon keeps the stored secret only while the target is the same.
  const sameTarget =
    status.enabled &&
    form.kind === status.kind &&
    form.url.trim() === status.url;
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {status.enabled
              ? t("backup.syncDialog.edit")
              : t("backup.syncDialog.on")}
          </DialogTitle>
          <DialogDescription>
            {t("backup.syncDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div
          className="segmented"
          role="tablist"
          aria-label={t("backup.syncDialog.kind")}
        >
          {(["webdav", "s3"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={form.kind === kind}
              disabled={busy}
              onClick={() => switchKind(kind)}
            >
              {kind === "webdav" ? "WebDAV" : t("backup.syncDialog.s3")}
            </button>
          ))}
        </div>
        <label className="field-label">
          {s3
            ? t("backup.syncDialog.bucket")
            : t("backup.syncDialog.directory")}
          <input
            className="field font-mono text-[13px]"
            value={form.url}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              s3
                ? "s3://bucket/prefix"
                : "https://dav.example.com/remote.php/dav/files/me"
            }
            onChange={(event) => set("url", event.target.value)}
          />
          <span className="field-hint block">
            {t("backup.syncDialog.copyHint")}
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="field-label">
            {s3 ? "Access Key ID" : t("backup.sync.user")}
            <input
              className="field font-mono text-[13px]"
              value={form.user}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("user", event.target.value)}
            />
          </label>
          <label className="field-label">
            {s3 ? "Secret Access Key" : t("backup.syncDialog.password")}
            <input
              className="field font-mono text-[13px]"
              type="password"
              value={form.secret}
              autoComplete="new-password"
              placeholder={sameTarget ? t("backup.keepStored") : undefined}
              onChange={(event) => set("secret", event.target.value)}
            />
          </label>
        </div>
        {s3 ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="field-label sm:col-span-3">
              Endpoint
              <input
                className="field font-mono text-[13px]"
                value={form.endpoint}
                autoComplete="off"
                spellCheck={false}
                placeholder={t("backup.syncDialog.endpointPlaceholder")}
                onChange={(event) => set("endpoint", event.target.value)}
              />
            </label>
            <label className="field-label">
              {t("backup.syncDialog.region")}
              <input
                className="field font-mono text-[13px]"
                value={form.region}
                autoComplete="off"
                spellCheck={false}
                placeholder="us-east-1"
                onChange={(event) => set("region", event.target.value)}
              />
            </label>
            <label className="field-label sm:col-span-2">
              {t("backup.syncDialog.addressing")}
              <select
                className="field"
                value={form.pathStyle}
                onChange={(event) =>
                  set("pathStyle", event.target.value as SyncForm["pathStyle"])
                }
              >
                <option value="auto">{t("backup.syncDialog.auto")}</option>
                <option value="yes">{t("backup.syncDialog.pathStyle")}</option>
                <option value="no">{t("backup.syncDialog.virtualHost")}</option>
              </select>
            </label>
          </div>
        ) : null}
        <PassphraseFields
          passphrase={form.passphrase}
          confirm={form.confirm}
          onPassphrase={(value) => set("passphrase", value)}
          onConfirm={(value) => set("confirm", value)}
          optional={enabled ? t("backup.keepStored") : undefined}
        />
        <p className="callout warn">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{t("backup.syncDialog.warning")}</span>
        </p>
        <div className="grid gap-x-2 sm:grid-cols-2">
          <Checkbox
            checked={form.keys}
            onChange={(value) => set("keys", value)}
          >
            {t("backup.syncDialog.keys")}
          </Checkbox>
          <Checkbox
            checked={form.agents}
            onChange={(value) => set("agents", value)}
          >
            {t("backup.syncDialog.agents")}
          </Checkbox>
        </div>
        <ErrorCallout failure={failure} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {saved ? t("common.close") : t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : <CloudUpload />}
            {t("backup.syncDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SyncCard({
  status,
  onStatus,
}: {
  status: SyncStatus;
  onStatus: (status: SyncStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncNow = () => {
    setSyncing(true);
    const client = modelPlane();
    client.sync.now().then(
      (synced) => {
        setSyncing(false);
        onStatus(synced);
        notify.success(t("backup.sync.synced"));
      },
      (reason: unknown) => {
        setSyncing(false);
        notify.error(reason, t("backup.sync.failed"));
        void client.sync.status().then(onStatus, () => undefined);
      },
    );
  };
  const notice = status.notice;
  return (
    <Card
      title={t("backup.sync.title")}
      lede={t("backup.sync.lede")}
      aside={
        status.enabled ? (
          <span className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={syncNow}
            >
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("backup.sync.now")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil />
              {t("backup.sync.edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDisabling(true)}
            >
              <Power />
              {t("backup.sync.off")}
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setEditing(true)}>
            <CloudUpload />
            {t("backup.sync.on")}
          </Button>
        )
      }
    >
      {status.enabled ? (
        <>
          <dl className="text-[13px]">
            <Row label={t("backup.sync.target")}>
              <span className="tag">
                {status.kind === "s3" ? "S3" : "WebDAV"}
              </span>{" "}
              <span className="font-mono text-[12.5px] break-all">
                {status.url}
              </span>
            </Row>
            {status.user ? (
              <Row
                label={
                  status.kind === "s3" ? "Access Key ID" : t("backup.sync.user")
                }
              >
                <span className="font-mono text-[12.5px]">{status.user}</span>
              </Row>
            ) : null}
            {status.kind === "s3" && (status.endpoint || status.region) ? (
              <Row label="Endpoint">
                <span className="font-mono text-[12.5px] break-all">
                  {status.endpoint ?? "AWS"}
                  {status.region ? ` · ${status.region}` : ""}
                  {status.pathStyle !== undefined
                    ? ` · ${status.pathStyle ? t("backup.sync.pathStyle") : t("backup.sync.virtualHost")}`
                    : ""}
                </span>
              </Row>
            ) : null}
            <Row label={t("backup.sync.contentLabel")}>
              {t("backup.sync.content", {
                parts: status.agents
                  ? t("backup.sync.partsWithAgents")
                  : t("backup.sync.partsWithoutAgents"),
                keys: status.keys
                  ? t("backup.sync.withKeys")
                  : t("backup.sync.withoutKeys"),
              })}
            </Row>
            <Row label={t("backup.sync.last")}>
              <LocalTime value={status.lastSyncAt} />
            </Row>
            <Row label={t("backup.sync.next")}>
              <LocalTime value={status.nextSyncAt} />
            </Row>
          </dl>
          {status.lastError ? (
            <p role="alert" className="callout error">
              {t("backup.sync.lastError", { error: status.lastError })}
            </p>
          ) : null}
          {notice &&
          (notice.here.length || notice.there.length || notice.kept?.length) ? (
            <div className="callout warn block space-y-1">
              <p>
                {tr("backup.sync.noticeAt", {
                  time: <LocalTime value={notice.at} />,
                })}
              </p>
              <ul className="list-disc pl-5">
                {notice.here.length ? (
                  <li>
                    {t("backup.sync.noticeHere", {
                      parts: notice.here
                        .map(syncPartName)
                        .join(t("backup.listSeparator")),
                    })}
                  </li>
                ) : null}
                {notice.there.length ? (
                  <li>
                    {t("backup.sync.noticeThere", {
                      parts: notice.there
                        .map(syncPartName)
                        .join(t("backup.listSeparator")),
                    })}
                  </li>
                ) : null}
                {notice.kept?.length ? (
                  <li>
                    {tr("backup.sync.noticeKept", {
                      names: (
                        <span className="font-mono">
                          {notice.kept.join(t("backup.listSeparator"))}
                        </span>
                      ),
                    })}
                  </li>
                ) : null}
              </ul>
              {notice.saved ? (
                <p>
                  {tr("backup.sync.noticeSaved", {
                    path: (
                      <span className="font-mono break-all">
                        {notice.saved}
                      </span>
                    ),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}
          {notice?.redactionOff ? (
            <RedactionOffWarning action>
              {tr("backup.sync.redactionOff", {
                time: <LocalTime value={notice.at} />,
              })}
            </RedactionOffWarning>
          ) : null}
          {notice?.needKey?.length ? (
            <SearchNeedKey
              names={notice.needKey}
              text={t("backup.sync.needKey", { page: featuresPage("search") })}
            />
          ) : null}
          {status.warnings?.length ? (
            <ul className="callout warn block list-disc pl-8">
              {status.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("backup.sync.disabled")}
        </p>
      )}
      {editing ? (
        <SyncDialog
          status={status}
          onClose={() => setEditing(false)}
          onStatus={onStatus}
        />
      ) : null}
      <ConfirmDialog
        open={disabling}
        title={t("backup.sync.offTitle")}
        description={t("backup.sync.offBody")}
        action={t("backup.sync.offTitle")}
        onClose={() => setDisabling(false)}
        onConfirm={async () => {
          onStatus(await modelPlane().sync.disable());
          notify.success(t("backup.sync.turnedOff"));
        }}
      />
    </Card>
  );
}

/** Backup, restore and sync (docs/backup-sync.md), the second tab of the settings. */
export function BackupPage({ tabs }: { tabs: React.ReactNode }) {
  const load = useCallback(() => modelPlane().sync.status(), []);
  const [data, reload] = useLoaded(load);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  return (
    <div className="page-body">
      <div className="page-column max-w-[880px]">
        {tabs}
        <PageHeader title={t("backup.title")} lede={t("backup.lede")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.refresh")}
            onClick={() => {
              setStatus(null);
              reload();
            }}
          >
            <RefreshCw />
          </Button>
        </PageHeader>
        <div className="mt-6 space-y-4">
          <BackupCard />
          <RestoreCard />
          {data.state === "loading" ? (
            <div
              className="panel space-y-3 p-5"
              role="status"
              aria-label={t("common.loading")}
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : data.state === "error" ? (
            <LoadError message={data.message} retry={reload} />
          ) : (
            <SyncCard status={status ?? data.value} onStatus={setStatus} />
          )}
        </div>
      </div>
    </div>
  );
}
