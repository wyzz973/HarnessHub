"use client";
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
  toolPackKinds,
  toolPackStatusNames,
} from "@/lib/tool-packs";
import { cn } from "@/lib/utils";
import { EngineAvatar } from "./engine-avatar";

interface Outcome {
  title: string;
  ok?: boolean;
  counts?: { skills?: number; mcp?: number; cli?: number };
  rows: ToolPackEngineResult[];
  warnings: string[];
}
type ImportKind = (typeof toolPackKinds)[number]["id"];
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
const reasonNames: Record<string, string> = {
  "Engine is disabled": "引擎已停用",
};
function outcomeOf(title: string, result: ToolPackApply | undefined): Outcome {
  return {
    title,
    ...(result?.ok === undefined ? {} : { ok: result.ok }),
    rows: applyRows(result),
    warnings: [
      ...(result?.warnings ?? []),
      ...applyRows(result).flatMap((row) =>
        (row.warnings ?? []).map(
          (warning) => `${engineName(row.engineId)}：${warning}`,
        ),
      ),
    ],
  };
}
function failure(reason: unknown, feature: string) {
  if (reason instanceof UnsupportedFeatureError)
    return `当前服务版本不支持${feature}，请升级。`;
  if (!(reason instanceof Error)) return `${feature}失败`;
  // A Gateway without the pasted-MCP contract still requires `source`.
  if (/required property 'source'|must have required property/.test(reason.message))
    return "当前服务版本不支持粘贴配置，请把配置保存为 mcp.json 后用本机路径添加。";
  return reason.message;
}
function packSlug(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length >= 2 && slug.length <= 64 ? slug : undefined;
}
/** Parses pasted MCP JSON; returns the configuration or a message in Chinese. */
function parseMcp(
  text: string,
): { value: { mcpServers: Record<string, unknown> } } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "不是有效的 JSON，请检查括号、引号和逗号。" };
  }
  const servers =
    typeof parsed === "object" && parsed !== null && "mcpServers" in parsed
      ? (parsed as { mcpServers: unknown }).mcpServers
      : undefined;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    return { error: '需要包含 "mcpServers" 对象。' };
  const entries = Object.entries(servers as Record<string, unknown>);
  if (!entries.length) return { error: "mcpServers 里还没有服务。" };
  for (const [name, server] of entries) {
    const item =
      typeof server === "object" && server !== null
        ? (server as Record<string, unknown>)
        : {};
    if (typeof item.command !== "string" && typeof item.url !== "string")
      return { error: `服务 ${name} 需要 command 或 url。` };
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
                    {reasonNames[row.reason] ?? row.reason}
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
                {toolPackStatusNames[row.status] ?? row.status}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">没有引擎受影响。</p>
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
  async function run(key: string, feature: string, work: () => Promise<Outcome>) {
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
        setError(`请填写本机绝对路径，例如 ${examples.toolPack}`);
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
    const ok = await run("import", "添加工具", async () => {
      const result = await api.importToolPack(input);
      const applied = outcomeOf(
        `已添加 ${result.displayName ?? result.package.id}`,
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
    void run(`apply:${pack.id}@${pack.version}`, "应用工具", async () =>
      outcomeOf(
        `${pack.displayName ?? pack.id} 已应用`,
        await api.applyToolPack({
          package: { id: pack.id, version: pack.version },
          engineIds,
        }),
      ),
    );
  }
  function unbind(pack: ToolPackRecord, engineIds: "all" | string[]) {
    void run(`unbind:${pack.id}@${pack.version}`, "解除工具", async () =>
      outcomeOf(
        `${pack.displayName ?? pack.id} 已解除`,
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
            <h1 className="page-title">工具</h1>
            <p className="page-lede">
              Skill、MCP 服务和命令行工具，添加后所有引擎都能使用。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="刷新"
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
              添加工具
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
            <p className="empty-state">当前服务版本不支持工具管理。</p>
          ) : packages.state === "error" ? (
            <p className="empty-state text-danger">
              读取失败：{packages.message}
            </p>
          ) : list.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((pack) => {
                const key = `${pack.id}@${pack.version}`;
                const engineIds = bound(pack);
                const preinstalled =
                  pack.preinstalled === true || pack.id === "office-suite";
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
                          {preinstalled ? (
                            <span className="tag brand shrink-0">预装</span>
                          ) : null}
                          {pack.problem ? (
                            <span
                              className="tag warn shrink-0"
                              title={pack.problem.message}
                            >
                              <TriangleAlert className="size-3" />
                              无法读取
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
                          title={engineIds.map(engineName).join("、")}
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
                          未应用到引擎
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
                        应用到全部引擎
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        onClick={() => manage(pack)}
                      >
                        选择引擎
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
                        解除
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
                还没有工具
              </p>
              <p>添加 Skill 目录、MCP 配置或命令行工具。</p>
              <Button size="sm" className="mt-3" onClick={openAdd}>
                <Plus />
                添加工具
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
              <DialogTitle>{outcome ? outcome.title : "添加工具"}</DialogTitle>
              {outcome ? null : (
                <DialogDescription>
                  文件留在本机，不会下载或运行安装脚本。
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
                    继续添加
                  </Button>
                  <Button
                    onClick={() => {
                      setAdding(false);
                      setOutcome(null);
                    }}
                  >
                    完成
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <div className="segmented w-fit" role="tablist" aria-label="添加方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={addTab === "path"}
                    onClick={() => {
                      setAddTab("path");
                      setError(null);
                    }}
                  >
                    本机路径
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
                    粘贴 MCP 配置
                  </button>
                </div>
                {addTab === "path" ? (
                  <div className="space-y-3">
                    <label className="field-label">
                      路径
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
                        Skill 目录、mcp.json、cli.json 或工具包目录。
                      </span>
                    </label>
                    <details className="group text-[13px]">
                      <summary className="flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground">
                        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90" />
                        更多选项
                      </summary>
                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <label className="field-label">
                          类型
                          <select
                            className="field"
                            value={kind}
                            onChange={(event) =>
                              setKind(event.target.value as ImportKind)
                            }
                          >
                            {toolPackKinds.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field-label">
                          名称 ID
                          <input
                            className="field font-mono text-[13px]"
                            value={packageId}
                            placeholder="自动生成"
                            onChange={(event) =>
                              setPackageId(event.target.value)
                            }
                          />
                        </label>
                        <label className="field-label">
                          版本
                          <input
                            className="field font-mono text-[13px]"
                            value={packageVersion}
                            placeholder="自动生成"
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
                      名称（可选）
                      <input
                        className="field"
                        value={mcpName}
                        placeholder="my-mcp"
                        autoComplete="off"
                        onChange={(event) => setMcpName(event.target.value)}
                      />
                    </label>
                    <label className="field-label">
                      MCP 配置
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
                      aria-label="安装到全部引擎"
                    />
                    安装到全部引擎
                  </label>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={busy === "import"}
                      onClick={() => setAdding(false)}
                    >
                      取消
                    </Button>
                    <Button
                      disabled={busy === "import"}
                      onClick={() => void install()}
                    >
                      {busy === "import" ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      添加
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
              <DialogDescription>新任务生效，进行中的任务不受影响。</DialogDescription>
            </DialogHeader>
            {outcome ? <ResultRows outcome={outcome} /> : null}
            <DialogFooter>
              <Button onClick={() => setOutcome(null)}>
                <Check />
                完成
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
              <DialogTitle>选择引擎</DialogTitle>
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
                    <span className="text-[12px] text-subtle">已停用</span>
                  ) : null}
                </label>
              ))}
              {!realEngines.length ? (
                <p className="py-4 text-[13px] text-muted-foreground">
                  还没有引擎
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
                从所选引擎解除
              </Button>
              <Button
                disabled={!!busy || !selected.length}
                onClick={() => {
                  if (managing) apply(managing, selected);
                  setManaging(null);
                }}
              >
                应用到所选引擎
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
                解除 {removing?.displayName ?? removing?.id}？
              </DialogTitle>
              <DialogDescription>
                新任务将不再加载这个工具，可以随时重新应用。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (removing) unbind(removing, "all");
                  setRemoving(null);
                }}
              >
                解除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
