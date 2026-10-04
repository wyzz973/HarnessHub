// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import {
  Blocks,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { api, remoteOf, UnsupportedFeatureError, type Remote } from "@/lib/api";
import type {
  Engine,
  ToolPackApply,
  ToolPackEngineResult,
  ToolPackRecord,
} from "@/lib/contracts";
import { engineName, visibleEngines } from "@/lib/engines";
import { pathExamples, useWindowsPaths } from "@/lib/platform";
import {
  applyRows,
  boundEngineIds,
  toolPackKindName,
  toolPackKinds,
  toolPackStatusName,
} from "@/lib/tool-packs";
import { cn } from "@/lib/utils";
import { EngineAvatar } from "./engine-avatar";
import { t } from "@/lib/i18n";

interface Outcome {
  title: string;
  ok?: boolean;
  counts?: { skills?: number; mcp?: number; cli?: number };
  rows: ToolPackEngineResult[];
  warnings: string[];
}
type ImportKind = (typeof toolPackKinds)[number];
type AddTab = "path" | "mcp";
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const mcpExample = `{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["server.mjs"]
    }
  }
}`;
/** Frequent Gateway reasons in the console's language; anything else is shown verbatim. */
function reasonName(reason: string): string {
  return reason === "Engine is disabled"
    ? t("tasks.tools.reason.engineDisabled")
    : reason;
}
function outcomeOf(title: string, result: ToolPackApply | undefined): Outcome {
  return {
    title,
    ...(result?.ok === undefined ? {} : { ok: result.ok }),
    rows: applyRows(result),
    warnings: [
      ...(result?.warnings ?? []),
      ...applyRows(result).flatMap((row) =>
        (row.warnings ?? []).map(
          (warning) =>
            t("tasks.tools.engineWarning", {
              engine: engineName(row.engineId),
              warning,
            }),
        ),
      ),
    ],
  };
}
type Feature = "add" | "apply" | "unbind";
function failure(reason: unknown, feature: Feature) {
  if (reason instanceof UnsupportedFeatureError)
    return t(`tasks.tools.unsupported.${feature}`);
  if (!(reason instanceof Error)) return t(`tasks.tools.failed.${feature}`);
  // A Gateway without the pasted-MCP contract still requires `source`.
  if (/required property 'source'|must have required property/.test(reason.message))
    return t("tasks.tools.pasteUnsupported");
  return reason.message;
}
function packSlug(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 2 && slug.length <= 64 ? slug : undefined;
}
/** Parses pasted MCP JSON; returns the configuration or a message in the console's language. */
function parseMcp(
  text: string,
): { value: { mcpServers: Record<string, unknown> } } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: t("tasks.tools.invalidJson") };
  }
  const servers =
    typeof parsed === "object" && parsed !== null && "mcpServers" in parsed
      ? (parsed as { mcpServers: unknown }).mcpServers
      : undefined;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { error: t("tasks.tools.needServers") };
  const entries = Object.entries(servers as Record<string, unknown>);
  if (!entries.length) return { error: t("tasks.tools.noServers") };
  for (const [name, server] of entries) {
    const item =
      typeof server === "object" && server !== null
        ? (server as Record<string, unknown>)
        : {};
    if (typeof item.command !== "string" && typeof item.url !== "string")
      return { error: t("tasks.tools.needCommand", { name }) };
  }
  return { value: { mcpServers: servers as Record<string, unknown> } };
}

function Counts({
  counts,
}: {
  counts: { skills?: number; mcp?: number; cli?: number } | undefined;
}) {
  if (!counts) return null;
  const items = [
    { label: "Skill", value: counts.skills ?? 0 },
    { label: "MCP", value: counts.mcp ?? 0 },
    { label: "CLI", value: counts.cli ?? 0 },
  ].filter((item) => item.value > 0);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item.label} className="tag">
          {item.label}
          <span className="tabular font-medium text-foreground">
            {item.value}
          </span>
        </span>
      ))}
    </div>
  );
}
function ResultRows({ outcome }: { outcome: Outcome }) {
  return (
    <div>
      {outcome.counts ? (
        <div className="mb-3">
          <Counts counts={outcome.counts} />
        </div>
      ) : null}
      {outcome.rows.length ? (
        <ul className="max-h-[46vh] divide-y overflow-y-auto rounded-xl border">
          {outcome.rows.map((row) => (
            <li key={row.engineId} className="flex items-start gap-3 px-3 py-2.5">
              <EngineAvatar id={row.engineId} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px]">{engineName(row.engineId)}</p>
                {row.reason ? (
                  <p className="mt-0.5 text-[12px] leading-5 text-subtle">
                    {reasonName(row.reason)}
                  </p>
                ) : null}
              </div>
              <span
                className={cn(
                  "tag shrink-0",
                  row.status === "applied" && "good",
                  row.status === "failed" && "error",
                  row.status === "skipped" && "warn",
                )}
              >
                {toolPackStatusName(row.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {t("tasks.tools.noEngineAffected")}
        </p>
      )}
      {outcome.warnings.length ? (
        <ul className="callout warn mt-3 block list-disc space-y-1 pl-8">
          {outcome.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Tool management. Import, apply and unbind go through the Gateway, which verifies files
 * and re-registers engines; new sessions use the result, existing sessions keep theirs.
 */
export function ToolPacksPage({
  engines,
  refreshEngines,
}: {
  engines: Engine[];
  refreshEngines: () => Promise<void>;
}) {
  const examples = pathExamples(useWindowsPaths());
  const [packages, setPackages] = useState<Remote<ToolPackRecord[]>>({
    state: "loading",
  });
  const [adding, setAdding] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>("path");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState<ImportKind>("auto");
  const [packageId, setPackageId] = useState("");
  const [packageVersion, setPackageVersion] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpText, setMcpText] = useState("");
  const [applyAll, setApplyAll] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [managing, setManaging] = useState<ToolPackRecord | null>(null);
  const [removing, setRemoving] = useState<ToolPackRecord | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const [result] = await Promise.allSettled([
      api.toolPacks(signal).then((value) => value.packages),
    ]);
    if (!signal?.aborted) setPackages(remoteOf(result));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const list = packages.state === "ready" ? packages.value : [];
  const realEngines = visibleEngines(engines);
  const bound = (pack: ToolPackRecord) =>
    (pack.engines ?? boundEngineIds(pack, list, engines)).filter(
      (id) => id !== "fake",
    );
  async function run(
    key: string,
    feature: Feature,
    work: () => Promise<Outcome>,
  ) {
    setBusy(key);
    setError(null);
    try {
      setOutcome(await work());
      return true;
    } catch (reason) {
      setError(failure(reason, feature));
      return false;
    } finally {
      setBusy(null);
      await Promise.allSettled([load(), refreshEngines()]);
    }
  }
  function openAdd() {
    setError(null);
    setOutcome(null);
    setAdding(true);
  }
  async function install() {
    const target = applyAll ? { applyTo: "all" as const, replace: true } : {};
    let input: Parameters<typeof api.importToolPack>[0];
    if (addTab === "path") {
      const path = source.trim();
      if (!absolutePath.test(path)) {
        setError(t("tasks.tools.needPath", { example: examples.toolPack }));
        return;
      }
      input = {
        source: path,
        kind,
        ...(packageId.trim() ? { id: packageId.trim() } : {}),
        ...(packageVersion.trim() ? { version: packageVersion.trim() } : {}),
        ...target,
      };
    } else {
      const parsed = parseMcp(mcpText);
      if ("error" in parsed) {
        setError(parsed.error);
        return;
      }
      const name = mcpName.trim();
      const id = packSlug(name);
      input = {
        mcp: parsed.value,
        ...(id ? { id } : {}),
        ...(name ? { displayName: name } : {}),
        ...target,
      };
    }
    const ok = await run("import", "add", async () => {
      const result = await api.importToolPack(input);
      const applied = outcomeOf(
        t("tasks.tools.added", {
          name: result.displayName ?? result.package.id,
        }),
        result.apply,
      );
      return {
        ...applied,
        ...(result.ok === undefined ? {} : { ok: result.ok }),
        ...(result.counts ? { counts: result.counts } : {}),
        warnings: [...(result.warnings ?? []), ...applied.warnings],
      };
    });
    if (ok) {
      setSource("");
      setMcpText("");
      setMcpName("");
    }
  }
  function apply(pack: ToolPackRecord, engineIds: "all" | string[]) {
    void run(`apply:${pack.id}@${pack.version}`, "apply", async () =>
      outcomeOf(
        t("tasks.tools.applied", { name: pack.displayName ?? pack.id }),
        await api.applyToolPack({
          package: { id: pack.id, version: pack.version },
          engineIds,
        }),
      ),
    );
  }
  function unbind(pack: ToolPackRecord, engineIds: "all" | string[]) {
    void run(`unbind:${pack.id}@${pack.version}`, "unbind", async () =>
      outcomeOf(
        t("tasks.tools.removed", { name: pack.displayName ?? pack.id }),
        await api.unbindToolPack(pack.id, pack.version, engineIds),
      ),
    );
  }
  function manage(pack: ToolPackRecord) {
    setManaging(pack);
    setSelected(bound(pack));
  }
  return (
    <div className="page-body">
      <div className="page-column">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">{t("tasks.tools.title")}</h1>
            <p className="page-lede">{t("tasks.tools.lede")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("common.refresh")}
              disabled={!!busy}
              onClick={() => {
                setError(null);
                void Promise.allSettled([load(), refreshEngines()]);
              }}
            >
              <RefreshCw />
            </Button>
            <Button size="sm" onClick={openAdd}>
              <Plus />
              {t("tasks.tools.add")}
            </Button>
          </div>
        </div>
        {error && !adding ? (
          <div className="callout error mt-5" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        ) : null}
        <div className="mt-6">
          {packages.state === "loading" ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="panel space-y-3 p-5">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          ) : packages.state === "unsupported" ? (
            <p className="empty-state">{t("tasks.tools.unsupportedPage")}</p>
          ) : packages.state === "error" ? (
            <p className="empty-state text-danger">
              {t("common.loadFailed", { message: packages.message })}
            </p>
          ) : list.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((pack) => {
                const key = `${pack.id}@${pack.version}`;
                const engineIds = bound(pack);
                return (
                  <article key={key} className="panel flex flex-col p-5">
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
                        <Blocks className="size-5" strokeWidth={1.7} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="truncate text-[15px] font-semibold">
                            {pack.displayName ?? pack.id}
                          </h2>
                          {pack.problem ? (
                            <span
                              className="tag warn shrink-0"
                              title={pack.problem.message}
                            >
                              <TriangleAlert className="size-3" />
                              {t("tasks.tools.unreadable")}
                            </span>
                          ) : null}
                        </div>
                        <p
                          className="mt-0.5 truncate font-mono text-[12px] text-subtle"
                          title={`${key} · ${pack.digest}`}
                        >
                          {key}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex min-h-[22px] items-center justify-between gap-3">
                      <Counts counts={pack.counts} />
                      {engineIds.length ? (
                        <div
                          className="ml-auto flex items-center"
                          title={engineIds
                            .map(engineName)
                            .join(t("tasks.separator"))}
                        >
                          {engineIds.slice(0, 6).map((id) => (
                            <EngineAvatar
                              key={id}
                              id={id}
                              className="-ml-1.5 ring-2 ring-card first:ml-0"
                            />
                          ))}
                          {engineIds.length > 6 ? (
                            <span className="ml-1.5 text-[12px] text-subtle tabular">
                              +{engineIds.length - 6}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="ml-auto text-[12.5px] text-subtle">
                          {t("tasks.tools.notApplied")}
                        </span>
                      )}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => apply(pack, "all")}
                      >
                        {busy === `apply:${key}` ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        {t("tasks.tools.applyAll")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => manage(pack)}
                      >
                        {t("tasks.tools.chooseEngines")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        disabled={!!busy || !engineIds.length}
                        onClick={() => setRemoving(pack)}
                      >
                        {busy === `unbind:${key}` ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        {t("tasks.tools.remove")}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="panel empty-state py-16">
              <span className="mb-2 grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Blocks className="size-5" strokeWidth={1.7} />
              </span>
              <p className="text-[14px] font-medium text-foreground">
                {t("tasks.tools.empty")}
              </p>
              <p>{t("tasks.tools.emptyHint")}</p>
              <Button size="sm" className="mt-3" onClick={openAdd}>
                <Plus />
                {t("tasks.tools.add")}
              </Button>
            </div>
          )}
        </div>
        <Dialog
          open={adding}
          onOpenChange={(open) => {
            if (!open && busy !== "import") {
              setAdding(false);
              setOutcome(null);
              setError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>
                {outcome ? outcome.title : t("tasks.tools.add")}
              </DialogTitle>
              {outcome ? null : (
                <DialogDescription>
                  {t("tasks.tools.localOnly")}
                </DialogDescription>
              )}
            </DialogHeader>
            {outcome ? (
              <>
                <ResultRows outcome={outcome} />
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setOutcome(null)}
                  >
                    {t("tasks.tools.addMore")}
                  </Button>
                  <Button
                    onClick={() => {
                      setAdding(false);
                      setOutcome(null);
                    }}
                  >
                    {t("tasks.tools.done")}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <div
                  className="segmented w-fit"
                  role="tablist"
                  aria-label={t("tasks.tools.method")}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addTab === "path"}
                    onClick={() => {
                      setAddTab("path");
                      setError(null);
                    }}
                  >
                    {t("tasks.tools.localPath")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addTab === "mcp"}
                    onClick={() => {
                      setAddTab("mcp");
                      setError(null);
                    }}
                  >
                    {t("tasks.tools.pasteMcp")}
                  </button>
                </div>
                {addTab === "path" ? (
                  <div className="space-y-3">
                    <label className="field-label">
                      {t("tasks.tools.path")}
                      <input
                        className="field font-mono text-[13px]"
                        value={source}
                        placeholder={examples.toolPack}
                        autoComplete="off"
                        spellCheck={false}
                        autoFocus
                        onChange={(event) => {
                          setSource(event.target.value);
                          setError(null);
                        }}
                      />
                      <span className="field-hint block">
                        {t("tasks.tools.pathHint")}
                      </span>
                    </label>
                    <details className="group text-[13px]">
                      <summary className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
                        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90" />
                        {t("tasks.tools.moreOptions")}
                      </summary>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <label className="field-label">
                          {t("tasks.tools.kind")}
                          <select
                            className="field"
                            value={kind}
                            onChange={(event) =>
                              setKind(event.target.value as ImportKind)
                            }
                          >
                            {toolPackKinds.map((item) => (
                              <option key={item} value={item}>
                                {toolPackKindName(item)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field-label">
                          {t("tasks.tools.packageId")}
                          <input
                            className="field font-mono text-[13px]"
                            value={packageId}
                            placeholder={t("tasks.tools.generated")}
                            onChange={(event) =>
                              setPackageId(event.target.value)
                            }
                          />
                        </label>
                        <label className="field-label">
                          {t("tasks.tools.version")}
                          <input
                            className="field font-mono text-[13px]"
                            value={packageVersion}
                            placeholder={t("tasks.tools.generated")}
                            onChange={(event) =>
                              setPackageVersion(event.target.value)
                            }
                          />
                        </label>
                      </div>
                    </details>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <label className="field-label">
                      {t("tasks.tools.nameOptional")}
                      <input
                        className="field"
                        value={mcpName}
                        placeholder="my-mcp"
                        autoComplete="off"
                        onChange={(event) => setMcpName(event.target.value)}
                      />
                    </label>
                    <label className="field-label">
                      {t("tasks.tools.mcpConfig")}
                      <textarea
                        className="field font-mono text-[12.5px]"
                        rows={9}
                        value={mcpText}
                        placeholder={mcpExample}
                        spellCheck={false}
                        autoFocus
                        onChange={(event) => {
                          setMcpText(event.target.value);
                          setError(null);
                        }}
                      />
                    </label>
                  </div>
                )}
                {error ? (
                  <p role="alert" className="callout error">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="items-center sm:justify-between">
                  <label className="flex items-center gap-2.5 text-[13.5px]">
                    <Switch
                      checked={applyAll}
                      onCheckedChange={setApplyAll}
                      aria-label={t("tasks.tools.installAll")}
                    />
                    {t("tasks.tools.installAll")}
                  </label>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy === "import"}
                      onClick={() => setAdding(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      disabled={busy === "import"}
                      onClick={() => void install()}
                    >
                      {busy === "import" ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      {t("tasks.tools.addButton")}
                    </Button>
                  </div>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!outcome && !adding}
          onOpenChange={(open) => {
            if (!open) setOutcome(null);
          }}
        >
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{outcome?.title}</DialogTitle>
              <DialogDescription>{t("tasks.tools.newTasksOnly")}</DialogDescription>
            </DialogHeader>
            {outcome ? <ResultRows outcome={outcome} /> : null}
            <DialogFooter>
              <Button onClick={() => setOutcome(null)}>
                <Check />
                {t("tasks.tools.done")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!managing}
          onOpenChange={(open) => {
            if (!open) setManaging(null);
          }}
        >
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle>{t("tasks.tools.chooseEngines")}</DialogTitle>
              <DialogDescription>
                {managing?.displayName ?? managing?.id}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] space-y-0.5 overflow-y-auto">
              {realEngines.map((engine) => (
                <label
                  key={engine.id}
                  className="flex h-11 items-center gap-3 rounded-[10px] px-2.5 text-[13.5px] hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-(--primary)"
                    checked={selected.includes(engine.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, engine.id]
                          : current.filter((id) => id !== engine.id),
                      )
                    }
                  />
                  <EngineAvatar id={engine.id} />
                  <span className="flex-1">{engineName(engine.id)}</span>
                  {!engine.enabled ? (
                    <span className="text-[12px] text-subtle">
                      {t("tasks.tools.disabled")}
                    </span>
                  ) : null}
                </label>
              ))}
              {!realEngines.length ? (
                <p className="py-4 text-[13px] text-muted-foreground">
                  {t("tasks.tools.noEngines")}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={!!busy || !selected.length}
                onClick={() => {
                  if (managing) unbind(managing, selected);
                  setManaging(null);
                }}
              >
                {t("tasks.tools.removeSelected")}
              </Button>
              <Button
                disabled={!!busy || !selected.length}
                onClick={() => {
                  if (managing) apply(managing, selected);
                  setManaging(null);
                }}
              >
                {t("tasks.tools.applySelected")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
        >
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>
                {t("tasks.tools.removeTitle", {
                  name: removing?.displayName ?? removing?.id ?? "",
                })}
              </DialogTitle>
              <DialogDescription>
                {t("tasks.tools.removeHint")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (removing) unbind(removing, "all");
                  setRemoving(null);
                }}
              >
                {t("tasks.tools.remove")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
