"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Blocks,
  FolderInput,
  Link2,
  Link2Off,
  Loader2,
  RefreshCw,
  SlidersHorizontal,
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
import { api, remoteOf, UnsupportedFeatureError, type Remote } from "@/lib/api";
import type {
  Engine,
  ToolPackApply,
  ToolPackEngineResult,
  ToolPackRecord,
} from "@/lib/contracts";
import { dateLabel } from "@/lib/presentation";
import { pathExamples, useWindowsPaths } from "@/lib/platform";
import {
  applyRows,
  boundEngineIds,
  toolPackKinds,
  toolPackStatusNames,
} from "@/lib/tool-packs";
import { cn } from "@/lib/utils";

interface Outcome {
  title: string;
  ok?: boolean;
  counts?: { skills?: number; mcp?: number; cli?: number };
  rows: ToolPackEngineResult[];
  warnings: string[];
}
type ImportKind = (typeof toolPackKinds)[number]["id"];
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
function outcomeOf(title: string, result: ToolPackApply | undefined): Outcome {
  return {
    title,
    ...(result?.ok === undefined ? {} : { ok: result.ok }),
    rows: applyRows(result),
    warnings: [
      ...(result?.warnings ?? []),
      ...applyRows(result).flatMap((row) =>
        (row.warnings ?? []).map((warning) => `${row.engineId}：${warning}`),
      ),
    ],
  };
}
function failure(reason: unknown, feature: string) {
  return reason instanceof UnsupportedFeatureError
    ? `当前 Gateway 不支持${feature}，请升级到包含 ADR 0013 工具包接口的版本。`
    : reason instanceof Error
      ? reason.message
      : `${feature}失败`;
}
/**
 * Tool and plugin management. Import, apply and unbind go through the Gateway, which verifies
 * files and re-registers engines; new sessions use the result, existing sessions keep their revision.
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
  const [source, setSource] = useState("");
  const [kind, setKind] = useState<ImportKind>("auto");
  const [packageId, setPackageId] = useState("");
  const [packageVersion, setPackageVersion] = useState("");
  const [applyAll, setApplyAll] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [managing, setManaging] = useState<ToolPackRecord | null>(null);
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
  const realEngines = engines.filter((engine) => engine.driver !== "fake");
  async function run(key: string, work: () => Promise<Outcome>) {
    setBusy(key);
    setError(null);
    try {
      setOutcome(await work());
    } catch (reason) {
      setError(
        failure(
          reason,
          key === "import"
            ? "导入工具包"
            : key.startsWith("unbind")
              ? "解除绑定"
              : "应用工具包",
        ),
      );
    } finally {
      setBusy(null);
      await Promise.allSettled([load(), refreshEngines()]);
    }
  }
  function importPack() {
    const path = source.trim();
    if (!absolutePath.test(path)) {
      setError(`请填写本机绝对路径，例如 ${examples.toolPack}`);
      return;
    }
    void run("import", async () => {
      const result = await api.importToolPack({
        source: path,
        kind,
        ...(packageId.trim() ? { id: packageId.trim() } : {}),
        ...(packageVersion.trim() ? { version: packageVersion.trim() } : {}),
        ...(applyAll ? { applyTo: "all" as const } : {}),
      });
      const applied = outcomeOf(
        `已导入 ${result.package.id}@${result.package.version}`,
        result.apply,
      );
      return {
        ...applied,
        ...(result.ok === undefined ? {} : { ok: result.ok }),
        ...(result.counts ? { counts: result.counts } : {}),
        warnings: [...(result.warnings ?? []), ...applied.warnings],
      };
    });
  }
  function apply(pack: ToolPackRecord, engineIds: "all" | string[]) {
    void run(`apply:${pack.id}@${pack.version}`, async () =>
      outcomeOf(
        `${pack.id}@${pack.version} 应用到${engineIds === "all" ? "全部引擎" : engineIds.join("、")}`,
        await api.applyToolPack({
          package: { id: pack.id, version: pack.version },
          engineIds,
        }),
      ),
    );
  }
  function unbind(pack: ToolPackRecord, engineIds: "all" | string[]) {
    if (
      engineIds === "all" &&
      !window.confirm(
        `从全部引擎解除 ${pack.id}@${pack.version}？新会话将不再加载该工具包，已有会话不受影响。`,
      )
    )
      return;
    void run(`unbind:${pack.id}@${pack.version}`, async () =>
      outcomeOf(
        `${pack.id}@${pack.version} 已从${engineIds === "all" ? "全部引擎" : engineIds.join("、")}解除`,
        await api.unbindToolPack(pack.id, pack.version, engineIds),
      ),
    );
  }
  function manage(pack: ToolPackRecord) {
    setManaging(pack);
    setSelected(boundEngineIds(pack, list, engines));
  }
  return (
    <div className="page-body enter">
      <div className="mx-auto max-w-[1040px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wider text-muted-foreground">
              <Blocks className="size-3.5" />
              TOOLS & PLUGINS
            </div>
            <h1 className="page-heading">
              工具与插件，一次导入，所有引擎可用。
            </h1>
            <p className="mt-3 max-w-[640px] text-[13px] leading-6 text-muted-foreground">
              导入本机的 Skills 目录、MCP 配置或 CLI
              清单，校验文件后应用到引擎。只影响新会话，已有会话保持原版本。
            </p>
          </div>
          <Button
            className="mt-6"
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => {
              setError(null);
              void Promise.allSettled([load(), refreshEngines()]);
            }}
          >
            <RefreshCw />
            刷新
          </Button>
        </div>
        <section className="panel mt-8" aria-label="导入工具包">
          <h2 className="panel-title flex items-center gap-2">
            <FolderInput className="size-4 text-muted-foreground" />
            从本机路径导入
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
            <label className="form-label">
              路径（Gateway 所在机器）
              <input
                className="form-input font-mono"
                value={source}
                placeholder={examples.toolPack}
                autoComplete="off"
                onChange={(event) => {
                  setSource(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <label className="form-label">
              类型
              <select
                className="form-input"
                value={kind}
                onChange={(event) => setKind(event.target.value as ImportKind)}
              >
                {toolPackKinds.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              指定包 ID 与版本（可选）
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="form-label">
                包 ID
                <input
                  className="form-input font-mono"
                  value={packageId}
                  placeholder="留空由服务端生成"
                  onChange={(event) => setPackageId(event.target.value)}
                />
              </label>
              <label className="form-label">
                版本
                <input
                  className="form-input font-mono"
                  value={packageVersion}
                  placeholder="留空由服务端生成"
                  onChange={(event) => setPackageVersion(event.target.value)}
                />
              </label>
            </div>
          </details>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={applyAll}
                onChange={(event) => setApplyAll(event.target.checked)}
              />
              导入后安装到全部引擎
            </label>
            <Button
              size="sm"
              className="ml-auto"
              disabled={!!busy}
              onClick={importPack}
            >
              {busy === "import" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <FolderInput />
              )}
              导入
            </Button>
          </div>
          <p className="form-hint mt-3">
            自动识别：含 SKILL.md 的目录作为 Skills，含 mcpServers 的 JSON 作为
            MCP，CLI 清单生成白名单命令工具。服务端生成清单与
            sha256，不下载依赖、不运行安装脚本。
          </p>
        </section>
        {error ? (
          <div className="notice error mt-4" role="alert">
            {error}
          </div>
        ) : null}
        {outcome ? (
          <section
            className="panel mt-4"
            role="status"
            aria-label="最近一次操作结果"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="panel-title">{outcome.title}</h2>
              {outcome.ok === false ? (
                <span className="status-badge error">部分失败</span>
              ) : outcome.ok ? (
                <span className="status-badge">完成</span>
              ) : null}
              <Button
                className="ml-auto"
                size="xs"
                variant="ghost"
                onClick={() => setOutcome(null)}
              >
                关闭
              </Button>
            </div>
            {outcome.counts ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Skills {outcome.counts.skills ?? 0} · MCP{" "}
                {outcome.counts.mcp ?? 0} · CLI {outcome.counts.cli ?? 0}
              </p>
            ) : null}
            {outcome.rows.length ? (
              <table className="data-table mt-3">
                <thead>
                  <tr>
                    <th>引擎</th>
                    <th>结果</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {outcome.rows.map((row) => (
                    <tr key={row.engineId}>
                      <td className="font-medium">{row.engineId}</td>
                      <td>
                        <span
                          className={cn(
                            "status-badge",
                            row.status === "failed" && "error",
                            row.status === "skipped" && "warning",
                          )}
                        >
                          {toolPackStatusNames[row.status] ?? row.status}
                        </span>
                      </td>
                      <td className="text-xs leading-6 text-muted-foreground">
                        {row.reason ?? ""}
                        {row.capabilities ? (
                          <span className="block">
                            Skills {row.capabilities.skills?.length ?? 0} · MCP{" "}
                            {row.capabilities.mcp?.length ?? 0} · CLI{" "}
                            {row.capabilities.cli?.length ?? 0}
                          </span>
                        ) : null}
                        {row.revision ? (
                          <span className="block font-mono text-[10px]">
                            版本 {row.revision.slice(0, 12)}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                没有逐引擎结果。
              </p>
            )}
            {outcome.warnings.length ? (
              <ul className="notice warn mt-3 block list-disc space-y-1 pl-8">
                {outcome.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        <div className="mt-9 mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">已安装的工具包</h2>
          <span className="text-[10px] text-muted-foreground">
            绑定关系来自各引擎当前配置
          </span>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          {packages.state === "loading" ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ) : packages.state === "unsupported" ? (
            <p className="empty-note">当前 Gateway 不支持工具包接口。</p>
          ) : packages.state === "error" ? (
            <p className="empty-note text-destructive">
              读取失败：{packages.message}
            </p>
          ) : list.length ? (
            <table className="data-table min-w-[680px]">
              <thead>
                <tr>
                  <th>工具包</th>
                  <th>已绑定引擎</th>
                  <th>安装时间</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((pack) => {
                  const key = `${pack.id}@${pack.version}`;
                  const bound = boundEngineIds(pack, list, engines);
                  return (
                    <tr key={key}>
                      <td>
                        <p className="font-medium">
                          {pack.displayName ?? pack.id}
                        </p>
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                          {pack.id}@{pack.version} · {pack.digest.slice(0, 12)}
                        </p>
                      </td>
                      <td>
                        {bound.length ? (
                          <div className="flex max-w-[260px] flex-wrap gap-1">
                            {bound.map((id) => (
                              <span
                                key={id}
                                className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
                                {id}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">
                            未绑定
                          </span>
                        )}
                      </td>
                      <td className="text-[11px] text-muted-foreground">
                        {pack.installedAt
                          ? dateLabel(pack.installedAt)
                          : "未提供"}
                      </td>
                      <td>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() => apply(pack, "all")}
                          >
                            {busy === `apply:${key}` ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Link2 className="size-3" />
                            )}
                            应用到全部
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() => manage(pack)}
                          >
                            <SlidersHorizontal className="size-3" />
                            选择引擎
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy || !bound.length}
                            onClick={() => unbind(pack, "all")}
                          >
                            {busy === `unbind:${key}` ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Link2Off className="size-3" />
                            )}
                            解除绑定
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="empty-note">
              还没有安装工具包。从上方输入本机路径导入。
            </p>
          )}
        </div>
        <p className="mt-4 text-[11px] leading-6 text-muted-foreground">
          工作目录相关的参数在绑定时写为会话工作目录占位符，运行时替换为当前会话目录（比赛中即评测方传入的
          directory）。工具包代码的网络与文件权限由运行环境决定，本功能不提供沙箱。
        </p>
        <Dialog
          open={!!managing}
          onOpenChange={(open) => {
            if (!open) setManaging(null);
          }}
        >
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>
                选择引擎 · {managing?.id}@{managing?.version}
              </DialogTitle>
              <DialogDescription>
                勾选引擎后应用或解除。不支持的引擎会被跳过并说明原因。
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[50vh] space-y-1 overflow-y-auto">
              {realEngines.map((engine) => {
                const bound =
                  managing &&
                  boundEngineIds(managing, list, [engine]).length > 0;
                return (
                  <label
                    key={engine.id}
                    className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(engine.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, engine.id]
                            : current.filter((id) => id !== engine.id),
                        )
                      }
                    />
                    <span className="font-medium">{engine.id}</span>
                    {!engine.enabled ? (
                      <span className="text-[10px] text-muted-foreground">
                        已停用
                      </span>
                    ) : null}
                    {bound ? (
                      <span className="ml-auto status-badge">已绑定</span>
                    ) : null}
                  </label>
                );
              })}
              {!realEngines.length ? (
                <p className="py-4 text-xs text-muted-foreground">
                  没有可配置的真实引擎。
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
                <Link2Off />
                从所选引擎解除
              </Button>
              <Button
                disabled={!!busy || !selected.length}
                onClick={() => {
                  if (managing) apply(managing, selected);
                  setManaging(null);
                }}
              >
                <Link2 />
                应用到所选引擎
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
