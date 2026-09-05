"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CirclePlus,
  Cpu,
  FolderSearch,
  Loader2,
  Plug,
  RefreshCw,
  Terminal,
  Zap,
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
import { Textarea } from "@/components/ui/textarea";
import { EngineConfigurationDialog } from "./engine-configuration-dialog";
import { api } from "@/lib/api";
import {
  registrationSchema,
  type Candidate,
  type Engine,
  type Registration,
} from "@/lib/contracts";

export function EnginePage({
  engines,
  defaultEngine,
  refresh,
  report,
  testModel,
}: {
  engines: Engine[];
  defaultEngine: string;
  refresh: () => Promise<void>;
  report: (error: unknown) => void;
  testModel: (engineId: string) => Promise<void>;
}) {
  const [discovering, setDiscovering] = useState(true);
  const discoveryRequest = useRef<AbortController | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [editing, setEditing] = useState<Engine | null>(null);
  const [checkResult, setCheckResult] = useState<{
    engineId: string;
    checks: { name: string; status: string; message: string }[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [registration, setRegistration] = useState(
    '{\n  "id": "my-agent",\n  "driver": "acp",\n  "command": ["my-agent", "acp"],\n  "enabled": true,\n  "maxConcurrency": 1\n}',
  );
  const [localError, setLocalError] = useState<string | null>(null);
  async function action(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      await work();
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }
  const discover = useCallback(async () => {
    discoveryRequest.current?.abort();
    const controller = new AbortController();
    discoveryRequest.current = controller;
    setDiscovering(true);
    try {
      const response = await api.discovery(controller.signal);
      if (!controller.signal.aborted) setCandidates(response.candidates);
    } catch (error) {
      if (!controller.signal.aborted) report(error);
    } finally {
      if (!controller.signal.aborted) {
        discoveryRequest.current = null;
        setDiscovering(false);
      }
    }
  }, [report]);
  useEffect(() => {
    void discover();
    const scanWhenVisible = () => {
      if (document.visibilityState === "visible" && !discoveryRequest.current)
        void discover();
    };
    const interval = window.setInterval(scanWhenVisible, 60_000);
    document.addEventListener("visibilitychange", scanWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", scanWhenVisible);
      discoveryRequest.current?.abort();
      discoveryRequest.current = null;
    };
  }, [discover]);
  async function submit() {
    setLocalError(null);
    let input: unknown;
    try {
      input = JSON.parse(registration);
    } catch {
      setLocalError("请输入有效的 JSON 配置。");
      return;
    }
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) {
      setLocalError(
        "配置需要有效的 id、driver（acp / cli）和 command 参数数组。",
      );
      return;
    }
    setBusy("register");
    try {
      await api.register(parsed.data);
      await refresh();
      setDialogOpen(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "注册失败");
    } finally {
      setBusy(null);
    }
  }
  function configured(engine: Engine, enabled: boolean): Registration {
    if (!engine.command || engine.driver === "fake")
      throw new Error("该引擎不支持在控制台修改");
    return {
      id: engine.id,
      driver: engine.driver,
      command: engine.command,
      enabled,
      maxConcurrency: engine.maxConcurrency,
      ...(engine.model ? { model: engine.model } : {}),
      ...(engine.configuration ? { configuration: engine.configuration } : {}),
      ...(engine.credentialEnv ? { credentialEnv: engine.credentialEnv } : {}),
      ...(engine.cli ? { cli: engine.cli } : {}),
      ...(engine.acp ? { acp: engine.acp } : {}),
    };
  }
  return (
    <div className="page-body enter">
      <div className="mx-auto max-w-[1040px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wider text-muted-foreground">
              <Plug className="size-3.5" />
              ENGINE REGISTRY
            </div>
            <h1 className="page-heading">你的引擎，各司其职。</h1>
            <p className="mt-3 text-[13px] leading-6 text-muted-foreground">
              连接本机 Agent，为每项任务选择合适的执行方式。
            </p>
          </div>
          <div className="flex gap-2 pt-6">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void discover()}
              disabled={discovering}
            >
              <FolderSearch className={discovering ? "animate-pulse" : ""} />
              {discovering ? "扫描中" : "重新扫描"}
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <CirclePlus />
              添加引擎
            </Button>
          </div>
        </div>
        <div className="stats-grid mb-8">
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">已注册</p>
            <p className="mt-2 text-2xl font-medium tabular">
              {engines.length}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                个引擎
              </span>
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">已启用</p>
            <p className="mt-2 text-2xl font-medium tabular text-[#52714a]">
              {engines.filter((e) => e.enabled).length}
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">默认引擎</p>
            <p
              className="mt-3 truncate text-base font-medium"
              title={defaultEngine}
            >
              {defaultEngine || "未设置"}
            </p>
          </div>
          <div className="stat-cell">
            <p className="text-[11px] text-muted-foreground">配置更新</p>
            <p className="mt-3 flex items-center gap-2 text-sm">
              <span className="size-1.5 rounded-full bg-[#709663]" />
              运行中生效
            </p>
          </div>
        </div>
        {candidates ? (
          <section className="mb-8 rounded-xl border bg-[#fafcf6] p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium">
                本机发现{" "}
                <span className="ml-2 text-xs text-muted-foreground">
                  {candidates.length}
                </span>
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCandidates(null)}
              >
                收起
              </Button>
            </div>
            <p className="mb-4 text-xs leading-6 text-muted-foreground">
              自动检测本机安装，每分钟刷新。检测到安装不代表已经登录或模型可用；登记后可在任务中选择。
            </p>
            <div className="space-y-2">
              {candidates.map((candidate) => {
                const exists = engines.some(
                  (engine) => engine.id === candidate.id,
                );
                return (
                  <div
                    key={`${candidate.id}-${candidate.executable}`}
                    className="flex items-center gap-3 rounded-lg border bg-white px-4 py-3"
                  >
                    <Terminal className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium">{candidate.name}</p>
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                        title={candidate.executable}
                      >
                        {candidate.executable}
                      </p>
                      {candidate.notes.length ? (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {candidate.notes.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                    {exists ? (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <Check className="size-3" />
                        已注册
                      </span>
                    ) : candidate.registration ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() =>
                          void action(candidate.id, () =>
                            api.register(candidate.registration!),
                          )
                        }
                      >
                        {busy === candidate.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArrowRight />
                        )}
                        登记
                      </Button>
                    ) : (
                      <span className="status-badge warning">需要适配器</span>
                    )}
                  </div>
                );
              })}
              {!candidates.length ? (
                <p className="empty-note">
                  未发现引擎。你可以通过配置手动添加。
                </p>
              ) : null}
            </div>
          </section>
        ) : null}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">引擎目录</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy === "reload"}
            onClick={() => void action("reload", api.reload)}
          >
            <RefreshCw className="size-3.5" />
            重载配置
          </Button>
        </div>
        {checkResult ? (
          <div role="status" className="mb-4 rounded-lg border p-4 text-xs">
            <p className="mb-2 font-medium">
              {checkResult.engineId} · 配置与协议检查
            </p>
            {checkResult.checks.map((check, index) => (
              <p
                key={index}
                className={
                  check.status === "passed"
                    ? "text-[#52714a]"
                    : "text-destructive"
                }
              >
                {check.status === "passed" ? "通过" : "未通过"}：{check.message}
              </p>
            ))}
            <p className="mt-2 text-muted-foreground">
              此检查不调用模型，不代表 API Key 或模型权限已验证。
            </p>
          </div>
        ) : null}
        <div className="overflow-x-auto rounded-xl border">
          <table className="data-table min-w-[630px]">
            <thead>
              <tr>
                <th>引擎</th>
                <th>模型 / 协议</th>
                <th>能力声明</th>
                <th>并发</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((engine) => (
                <tr key={engine.id}>
                  <td>
                    <div className="flex items-start gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-[#f7f9f3]">
                        <Cpu className="size-4 text-[#728164]" />
                      </span>
                      <div>
                        <span className="font-medium">{engine.id}</span>
                        {engine.id === defaultEngine ? (
                          <span className="ml-2 rounded bg-[#eef3e8] px-1.5 py-0.5 text-[9px] text-[#738365]">
                            默认
                          </span>
                        ) : null}
                        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span
                            className={`size-1.5 rounded-full ${engine.enabled ? "bg-[#7d9c6b]" : "bg-[#b4bcb0]"}`}
                          />
                          {engine.enabled ? "已启用" : "已停用"}{" "}
                          <span className="font-mono">
                            · {engine.revision.slice(0, 8)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <p className="max-w-[200px] truncate" title={engine.model}>
                      {engine.model ?? "引擎默认模型"}
                    </p>
                    <p className="mt-1.5 text-[10px] uppercase text-muted-foreground">
                      {engine.driver}
                    </p>
                  </td>
                  <td>
                    <div className="flex max-w-[150px] flex-wrap gap-1">
                      {engine.capabilities.configured.permissions ? (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          权限
                        </span>
                      ) : null}
                      {engine.capabilities.configured.resume ? (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          恢复
                        </span>
                      ) : null}
                      {engine.capabilities.configured.images ? (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          图片
                        </span>
                      ) : null}
                      {!Object.values(engine.capabilities.configured).some(
                        Boolean,
                      ) ? (
                        <span className="text-[10px] text-muted-foreground">
                          基础执行
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="tabular">{engine.maxConcurrency}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      {engine.driver !== "fake" ? (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() => setEditing(engine)}
                          >
                            配置
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            onClick={() =>
                              void action(engine.id, async () =>
                                setCheckResult(
                                  await api.testEngineConfiguration(engine.id),
                                ),
                              )
                            }
                          >
                            检查连接
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy || !engine.enabled}
                            title="会使用当前引擎配置发送简短模型请求，并打开正式任务记录"
                            onClick={() =>
                              void action(engine.id, () => testModel(engine.id))
                            }
                          >
                            测试模型
                          </Button>
                        </>
                      ) : null}
                      {engine.enabled && engine.id !== defaultEngine ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() =>
                            void action(engine.id, () =>
                              api.setDefault(engine.id),
                            )
                          }
                        >
                          <Zap className="size-3" />
                          设为默认
                        </Button>
                      ) : null}
                      {engine.driver !== "fake" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          onClick={() =>
                            void action(engine.id, () =>
                              api.replace(configured(engine, !engine.enabled)),
                            )
                          }
                        >
                          {busy === engine.id ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : null}
                          {engine.enabled ? "停用" : "启用"}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!engines.length ? (
            <p className="empty-note">尚未连接引擎。从发现本机引擎开始。</p>
          ) : null}
        </div>
        <p className="mt-4 text-[11px] leading-6 text-muted-foreground">
          配置变更只影响新会话。正在执行的任务继续使用已固定的引擎版本。
        </p>
        {editing ? (
          <EngineConfigurationDialog
            engine={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setCheckResult(null);
              return refresh();
            }}
          />
        ) : null}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-[540px]">
            <DialogHeader>
              <DialogTitle>添加引擎</DialogTitle>
              <DialogDescription>
                使用 ACP 或通用 CLI 配置。凭证请引用环境变量或现有登录状态。
              </DialogDescription>
            </DialogHeader>
            <label
              className="text-xs font-medium"
              htmlFor="engine-registration"
            >
              引擎配置（JSON）
            </label>
            <Textarea
              id="engine-registration"
              value={registration}
              onChange={(event) => setRegistration(event.target.value)}
              className="min-h-[260px] font-mono text-xs leading-6"
              spellCheck={false}
            />
            {localError ? (
              <p role="alert" className="text-xs text-destructive">
                {localError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                取消
              </Button>
              <Button
                disabled={busy === "register"}
                onClick={() => void submit()}
              >
                {busy === "register" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <CirclePlus />
                )}
                注册引擎
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
