"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleX,
  Cpu,
  Ellipsis,
  FlaskConical,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Stethoscope,
  Terminal,
  Trophy,
  X,
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
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { EngineConfigurationDialog } from "./engine-configuration-dialog";
import { EngineAvatar } from "./engine-avatar";
import { api } from "@/lib/api";
import {
  registrationSchema,
  type Candidate,
  type Engine,
  type HarnessModelView,
  type Registration,
  type RuntimeInfo,
} from "@/lib/contracts";
import { engineName, visibleEngines } from "@/lib/engines";
import { cn } from "@/lib/utils";

type ModelStatus = HarnessModelView["engines"][number];
interface CheckResult {
  engineId: string;
  checks: { name: string; status: string; message: string }[];
}

function availability(engine: Engine, status: ModelStatus | undefined) {
  if (status?.status === "unsupported")
    return { label: "不支持统一模型", tone: "warn", reason: status.reason };
  if (!engine.enabled)
    return { label: "已停用", tone: "", reason: status?.reason };
  return { label: "可用", tone: "good", reason: undefined };
}

export function EnginePage({
  engines,
  defaultEngine,
  refresh,
  report,
  testModel,
  runtime,
  unifiedModel,
}: {
  engines: Engine[];
  defaultEngine: string;
  refresh: () => Promise<void>;
  report: (error: unknown) => void;
  testModel: (engineId: string) => Promise<void>;
  /** Present when `/v1/runtime/info` is available. */
  runtime?: RuntimeInfo;
  unifiedModel?: HarnessModelView;
}) {
  const competitionEngine = runtime?.competition
    ? runtime.competitionEngine
    : undefined;
  const modelStatus = new Map(
    (unifiedModel?.configured ? unifiedModel.engines : []).map((status) => [
      status.engineId,
      status,
    ]),
  );
  const shown = visibleEngines(engines);
  const [discovering, setDiscovering] = useState(false);
  const discoveryRequest = useRef<AbortController | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editing, setEditing] = useState<Engine | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
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
  // Discovery scans the machine; it only runs while the advanced section is open.
  useEffect(() => {
    if (!advancedOpen) return;
    void discover();
    return () => {
      discoveryRequest.current?.abort();
      discoveryRequest.current = null;
    };
  }, [advancedOpen, discover]);
  async function submit() {
    setLocalError(null);
    let input: unknown;
    try {
      input = JSON.parse(registration);
    } catch {
      setLocalError("不是有效的 JSON。");
      return;
    }
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) {
      setLocalError("需要 id、driver（acp 或 cli）和 command 数组。");
      return;
    }
    setBusy("register");
    try {
      await api.register(parsed.data);
      await refresh();
      setDialogOpen(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "添加失败");
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
  const unregistered = (candidates ?? []).filter(
    (candidate) => !engines.some((engine) => engine.id === candidate.id),
  );
  return (
    <div className="page-body">
      <div className="page-column">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="page-title">引擎</h1>
            <p className="page-lede">
              {shown.filter((engine) => engine.enabled).length} 个可用，共{" "}
              {shown.length} 个。
            </p>
          </div>
        </div>
        <ul className="panel mt-6 divide-y overflow-hidden">
          {shown.map((engine) => {
            const state = availability(engine, modelStatus.get(engine.id));
            const isDefault = engine.id === defaultEngine;
            const checked =
              checkResult?.engineId === engine.id ? checkResult : undefined;
            return (
              <li key={engine.id} className="px-5 py-4">
                <div className="flex items-center gap-3.5">
                  <EngineAvatar
                    id={engine.id}
                    size="md"
                    className={cn(!engine.enabled && "opacity-50")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[14.5px] font-semibold">
                        {engineName(engine.id)}
                      </span>
                      {isDefault ? (
                        <span className="tag brand">默认</span>
                      ) : null}
                      {engine.id === competitionEngine ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="tag info">
                              <Trophy className="size-3" />
                              比赛
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>比赛接口固定使用此引擎</TooltipContent>
                        </Tooltip>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-subtle">
                      {engine.driver.toUpperCase()}
                      {engine.model ? ` · ${engine.model}` : ""}
                      <span className="font-mono">
                        {" "}
                        · {engine.revision.slice(0, 8)}
                      </span>
                    </p>
                  </div>
                  <span className={cn("tag shrink-0 max-sm:hidden", state.tone)}>
                    {state.label}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="max-md:hidden"
                    disabled={!!busy || !engine.enabled}
                    onClick={() =>
                      void action(`test:${engine.id}`, () =>
                        testModel(engine.id),
                      )
                    }
                  >
                    {busy === `test:${engine.id}` ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <FlaskConical />
                    )}
                    测试
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`${engineName(engine.id)} 的更多操作`}
                        disabled={!!busy}
                      >
                        <Ellipsis />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-48">
                      <MenuItem
                        icon={Star}
                        label="设为默认"
                        disabled={!engine.enabled || isDefault}
                        onSelect={() =>
                          void action(engine.id, () =>
                            api.setDefault(engine.id),
                          )
                        }
                      />
                      <MenuItem
                        icon={Stethoscope}
                        label="检查连接"
                        onSelect={() =>
                          void action(`check:${engine.id}`, async () =>
                            setCheckResult(
                              await api.testEngineConfiguration(engine.id),
                            ),
                          )
                        }
                      />
                      <MenuItem
                        icon={FlaskConical}
                        label="测试模型"
                        disabled={!engine.enabled}
                        onSelect={() =>
                          void action(`test:${engine.id}`, () =>
                            testModel(engine.id),
                          )
                        }
                      />
                      <MenuItem
                        icon={Settings2}
                        label="配置"
                        onSelect={() => setEditing(engine)}
                      />
                    </PopoverContent>
                  </Popover>
                  <Switch
                    checked={engine.enabled}
                    disabled={!!busy}
                    aria-label={`${engine.enabled ? "停用" : "启用"} ${engineName(engine.id)}`}
                    onCheckedChange={(enabled) =>
                      void action(engine.id, () =>
                        api.replace(configured(engine, enabled)),
                      )
                    }
                  />
                </div>
                {state.reason ? (
                  <p className="mt-2 pl-[50px] text-[12.5px] leading-5 text-muted-foreground">
                    {state.reason}
                  </p>
                ) : null}
                {busy === `check:${engine.id}` ? (
                  <p className="mt-2 flex items-center gap-2 pl-[50px] text-[12.5px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在检查
                  </p>
                ) : null}
                {checked ? (
                  <div
                    role="status"
                    className="mt-3 ml-[50px] rounded-xl bg-muted px-3.5 py-3 text-[12.5px]"
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-medium">连接检查</span>
                      <button
                        type="button"
                        className="text-subtle hover:text-foreground"
                        aria-label="关闭检查结果"
                        onClick={() => setCheckResult(null)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <ul className="space-y-1">
                      {checked.checks.map((check, index) => (
                        <li key={index} className="flex gap-2">
                          {check.status === "passed" ? (
                            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                          ) : (
                            <CircleX className="mt-0.5 size-3.5 shrink-0 text-danger" />
                          )}
                          <span
                            className={cn(
                              "min-w-0 [overflow-wrap:anywhere]",
                              check.status !== "passed" && "text-danger",
                            )}
                          >
                            {check.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
          {!shown.length ? (
            <li className="empty-state py-14">
              <span className="mb-2 grid size-11 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Cpu className="size-5" strokeWidth={1.7} />
              </span>
              <p className="text-[14px] font-medium text-foreground">
                还没有引擎
              </p>
              <p>在“高级”中登记本机已安装的引擎。</p>
            </li>
          ) : null}
        </ul>
        <details
          className="group mt-6"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary className="flex w-fit items-center gap-1.5 text-[13.5px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90" />
            高级
          </summary>
          <div className="mt-4 space-y-4">
            <section className="panel overflow-hidden" aria-label="本机发现">
              <header className="flex items-center justify-between gap-3 px-5 py-3.5">
                <h2 className="section-title">本机发现</h2>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void discover()}
                    disabled={discovering}
                  >
                    <RefreshCw className={discovering ? "animate-spin" : ""} />
                    重新扫描
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === "reload"}
                    onClick={() => void action("reload", api.reload)}
                  >
                    重载配置文件
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialogOpen(true)}
                  >
                    <Plus />
                    手动添加
                  </Button>
                </div>
              </header>
              <ul className="divide-y border-t">
                {unregistered.map((candidate) => (
                  <li
                    key={`${candidate.id}-${candidate.executable}`}
                    className="flex items-center gap-3 px-5 py-3"
                  >
                    <Terminal className="size-4 shrink-0 text-subtle" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium">
                        {candidate.name}
                      </p>
                      <p
                        className="truncate font-mono text-[12px] text-subtle"
                        title={candidate.executable}
                      >
                        {candidate.executable}
                      </p>
                    </div>
                    {candidate.registration ? (
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
                          <Check />
                        )}
                        登记
                      </Button>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="tag warn">需要适配器</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-72">
                          {candidate.notes.join(" ") ||
                            "需要先安装对应的 ACP 适配器"}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </li>
                ))}
                {!unregistered.length ? (
                  <li className="px-5 py-6 text-center text-[13px] text-muted-foreground">
                    {discovering || candidates === null
                      ? "正在扫描"
                      : "没有发现未登记的引擎"}
                  </li>
                ) : null}
              </ul>
            </section>
          </div>
        </details>
        {editing ? (
          <EngineConfigurationDialog
            engine={editing}
            {...(unifiedModel ? { unifiedModel } : {})}
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
              <DialogTitle>手动添加引擎</DialogTitle>
              <DialogDescription>
                ACP 或命令行引擎的启动配置。
              </DialogDescription>
            </DialogHeader>
            <Textarea
              aria-label="引擎配置（JSON）"
              value={registration}
              onChange={(event) => setRegistration(event.target.value)}
              className="min-h-[240px] font-mono text-[12.5px] leading-6"
              spellCheck={false}
            />
            {localError ? (
              <p role="alert" className="callout error">
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
                ) : null}
                添加
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
function MenuItem({
  icon: Icon,
  label,
  disabled,
  onSelect,
}: {
  icon: typeof Star;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <PopoverClose asChild>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] hover:bg-accent disabled:pointer-events-none disabled:opacity-45"
        disabled={disabled}
        onClick={onSelect}
      >
        <Icon className="size-4 text-muted-foreground" strokeWidth={1.7} />
        {label}
      </button>
    </PopoverClose>
  );
}
