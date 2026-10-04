// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Download, Link2, Loader2 } from "lucide-react";
import type {
  ImportApp,
  ImportItem,
  ImportPreview,
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
import { t } from "@/lib/i18n";
import { tr } from "@/lib/i18n-react";
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { Checkbox, ErrorCallout, FieldError } from "./model-plane-ui";

const statusTones: Readonly<Record<ImportItem["status"], string>> = {
  new: "good",
  exists: "",
  skipped: "warn",
};

const apps: readonly ImportApp[] = ["claude-code", "codex"];

function keyText(key: ImportItem["key"]): string {
  if (key.kind === "none") return t("providers.import.key.none");
  if (key.kind === "env")
    return t("providers.import.key.env", { name: key.variable });
  return key.last4
    ? t("providers.import.key.last4", { last4: key.last4 })
    : t("providers.import.key.some");
}

/** What one item of the preview would create, and where its requests would go. */
function ItemCard({
  item,
  checked,
  onChange,
}: {
  item: ImportItem;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const status = {
    label: t(`providers.import.status.${item.status}`),
    tone: statusTones[item.status],
  };
  const provider = item.provider;
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {item.status === "new" ? (
          <Checkbox checked={checked} onChange={onChange}>
            <span className="font-medium">{provider?.name ?? item.ref}</span>
          </Checkbox>
        ) : (
          <span className="px-2 font-medium">{provider?.name ?? item.ref}</span>
        )}
        <span className={`tag ${status.tone}`}>{status.label}</span>
        {item.reason ? (
          <span className="text-[12px] text-muted-foreground">
            {item.reason}
          </span>
        ) : null}
      </div>
      {provider ? (
        <dl className="px-2 text-[12.5px]">
          <div className="metric-row">
            <dt>ID</dt>
            <dd className="font-mono">{provider.id}</dd>
          </div>
          {provider.preset ? (
            <div className="metric-row">
              <dt>{t("providers.import.preset")}</dt>
              <dd className="font-mono">
                {provider.preset}
                {provider.region ? ` · ${provider.region}` : ""}
                {provider.plan ? ` · ${provider.plan}` : ""}
              </dd>
            </div>
          ) : null}
          <div className="metric-row">
            <dt>{t("providers.import.hosts")}</dt>
            <dd className="font-mono break-all">
              {item.hosts.join(t("providers.separator")) || "—"}
            </dd>
          </div>
          <div className="metric-row">
            <dt>Key</dt>
            <dd>{keyText(item.key)}</dd>
          </div>
          <div className="metric-row">
            <dt>{t("providers.models")}</dt>
            <dd>
              {provider.models.length
                ? t("providers.import.modelCount", {
                    n: provider.models.length,
                  })
                : t("providers.import.refresh")}
            </dd>
          </div>
          {provider.headers.length ? (
            <div className="metric-row">
              <dt>{t("providers.import.headers")}</dt>
              <dd className="font-mono">
                {provider.headers.join(t("providers.separator"))}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * Import providers from a `harnesshub://` or `magpie://` link, or from
 * Claude Code's or Codex's configuration: the daemon describes what it
 * would create (preview), and nothing is written until it is confirmed.
 */
export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    action().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setFailure(failureOf(reason));
      },
    );
  };
  const read = (input: { link: string } | { app: ImportApp }) =>
    run(async () => {
      const result = await modelPlane().imports.preview(input);
      setPreview(result);
      setChosen(
        new Set(
          result.items
            .filter((item) => item.status === "new")
            .map((item) => item.ref),
        ),
      );
    });
  const apply = () =>
    run(async () => {
      if (!preview) return;
      const result = await modelPlane().imports.apply(preview.previewId, [
        ...chosen,
      ]);
      const created = result.items.filter((item) => item.status === "created");
      const failed = result.items.filter((item) => item.status === "failed");
      if (created.length)
        notify.success(
          t("providers.import.imported", {
            names: created
              .map((item) => item.provider?.name ?? item.ref)
              .join(t("providers.separator")),
          }),
        );
      for (const item of failed)
        notify.error(
          new Error(
            t("providers.import.failedItem", {
              ref: item.ref,
              reason: item.reason ?? item.code ?? t("providers.import.failed"),
            }),
          ),
          t("providers.import.notImported"),
        );
      onImported();
      onClose();
    });
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t("providers.import.title")}</DialogTitle>
          <DialogDescription>{t("providers.import.lede")}</DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="min-w-0 space-y-3">
            {preview.file ? (
              <p className="text-[12.5px] text-muted-foreground">
                {tr("providers.import.readFrom", {
                  file: (
                    <span className="font-mono break-all">{preview.file}</span>
                  ),
                })}
              </p>
            ) : null}
            {preview.warnings.length ? (
              <ul className="callout warn block list-disc space-y-0.5 pl-8">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {preview.items.length ? (
              preview.items.map((item) => (
                <ItemCard
                  key={item.ref}
                  item={item}
                  checked={chosen.has(item.ref)}
                  onChange={(checked) =>
                    setChosen((current) => {
                      const next = new Set(current);
                      if (checked) next.add(item.ref);
                      else next.delete(item.ref);
                      return next;
                    })
                  }
                />
              ))
            ) : (
              <p className="callout neutral">{t("providers.import.nothing")}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <label className="field-label">
              {t("providers.import.link")}
              <textarea
                className="field min-h-[84px] font-mono text-[12.5px]"
                placeholder="harnesshub://import?preset=deepseek&key=…"
                value={link}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setLink(event.target.value)}
              />
              <span className="field-hint">
                {t("providers.import.linkHint")}
              </span>
              <FieldError failure={failure} pointer="/link" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !link.trim()}
                onClick={() => read({ link: link.trim() })}
              >
                <Link2 />
                {t("providers.import.previewLink")}
              </Button>
              {apps.map((app) => (
                <Button
                  key={app}
                  variant="outline"
                  disabled={busy}
                  onClick={() => read({ app })}
                >
                  <Download />
                  {t(`providers.import.app.${app}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
        <ErrorCallout failure={failure} />
        <DialogFooter>
          {preview ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setFailure(null);
                }}
              >
                {t("providers.import.back")}
              </Button>
              <Button disabled={busy || !chosen.size} onClick={apply}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {t("providers.import.apply", { n: chosen.size })}
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
