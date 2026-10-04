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
import { failureOf, modelPlane, type Failure } from "@/lib/model-plane";
import { notify } from "@/lib/toast";
import { Checkbox, ErrorCallout, FieldError } from "./model-plane-ui";

const statusText: Record<
  ImportItem["status"],
  { label: string; tone: string }
> = {
  new: { label: "将创建", tone: "good" },
  exists: { label: "已存在", tone: "" },
  skipped: { label: "跳过", tone: "warn" },
};

const apps: Array<{ id: ImportApp; label: string }> = [
  { id: "claude-code", label: "从 Claude Code 导入" },
  { id: "codex", label: "从 Codex 导入" },
];

function keyText(key: ImportItem["key"]): string {
  if (key.kind === "none") return "没有 Key";
  if (key.kind === "env") return `环境变量 ${key.variable}`;
  return key.last4 ? `Key …${key.last4}` : "带 Key";
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
  const status = statusText[item.status];
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
              <dt>预设</dt>
              <dd className="font-mono">
                {provider.preset}
                {provider.region ? ` · ${provider.region}` : ""}
                {provider.plan ? ` · ${provider.plan}` : ""}
              </dd>
            </div>
          ) : null}
          <div className="metric-row">
            <dt>请求发往</dt>
            <dd className="font-mono break-all">
              {item.hosts.join("、") || "—"}
            </dd>
          </div>
          <div className="metric-row">
            <dt>Key</dt>
            <dd>{keyText(item.key)}</dd>
          </div>
          <div className="metric-row">
            <dt>模型</dt>
            <dd>
              {provider.models.length
                ? `${provider.models.length} 个`
                : "从上游刷新"}
            </dd>
          </div>
          {provider.headers.length ? (
            <div className="metric-row">
              <dt>请求头</dt>
              <dd className="font-mono">{provider.headers.join("、")}</dd>
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
          `已导入 ${created.map((item) => item.provider?.name ?? item.ref).join("、")}`,
        );
      for (const item of failed)
        notify.error(
          new Error(`${item.ref}：${item.reason ?? item.code ?? "失败"}`),
          "没有导入",
        );
      onImported();
      onClose();
    });
  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>导入 provider</DialogTitle>
          <DialogDescription>
            粘贴 harnesshub:// 或 magpie:// 导入链接，或者读取本机 Claude
            Code、Codex 的配置。先预览将创建的 provider
            与请求的去向，确认后才写入。
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <div className="min-w-0 space-y-3">
            {preview.file ? (
              <p className="text-[12.5px] text-muted-foreground">
                读取自{" "}
                <span className="font-mono break-all">{preview.file}</span>
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
              <p className="callout neutral">没有可以导入的 provider。</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <label className="field-label">
              导入链接
              <textarea
                className="field min-h-[84px] font-mono text-[12.5px]"
                placeholder="harnesshub://import?preset=deepseek&key=…"
                value={link}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setLink(event.target.value)}
              />
              <span className="field-hint">
                链接中的 Key
                只发送给本机守护进程，存入秘密存储；预览中只显示末四位。
              </span>
              <FieldError failure={failure} pointer="/link" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || !link.trim()}
                onClick={() => read({ link: link.trim() })}
              >
                <Link2 />
                预览链接
              </Button>
              {apps.map((app) => (
                <Button
                  key={app.id}
                  variant="outline"
                  disabled={busy}
                  onClick={() => read({ app: app.id })}
                >
                  <Download />
                  {app.label}
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
                返回
              </Button>
              <Button disabled={busy || !chosen.size} onClick={apply}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                导入 {chosen.size} 个
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
