// SPDX-License-Identifier: MIT
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
import { t } from "@/lib/i18n";

type ModelStatus = HarnessModelView["engines"][number];
interface CheckResult {
  engineId: string;
  checks: { name: string; status: string; message: string }[];
}

function availability(engine: Engine, status: ModelStatus | undefined) {
  if (status?.status === "unsupported")
    return {
      label: t("tasks.engines.noUnified"),
      tone: "warn",
      reason: status.reason,
    };
  if (!engine.enabled)
    return {
      label: t("tasks.engines.disabled"),
      tone: "",
      reason: status?.reason,
    };
  return { label: t("tasks.engines.available"), tone: "good", reason: undefined };
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
      setLocalError(t("tasks.engines.invalidJson"));
      return;
    }
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) {
      setLocalError(t("tasks.engines.needFields"));
      return;
    }
    setBusy("register");
    try {
      await api.register(parsed.data);
      await refresh();
      setDialogOpen(false);
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : t("tasks.engines.addFailed"),
      );
    } finally {
      setBusy(null);
    }
  }
  function configured(engine: Engine, enabled: boolean): Registration {
    if (!engine.command || engine.driver === "fake")
      throw new Error(t("tasks.engines.notEditable"));
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
            <h1 className="page-title">{t("tasks.engines.title")}</h1>
            <p className="page-lede">
              {t("tasks.engines.summary", {
                enabled: shown.filter((engine) => engine.enabled).length,
                total: shown.length,
              })}
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
                        <span className="tag brand">
                          {t("tasks.engines.default")}
                        </span>
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
                    {t("tasks.engines.test")}
                  </Button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("tasks.engines.more", {
                          engine: engineName(engine.id),
                        })}
                        disabled={!!busy}
                      >
                        <Ellipsis />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-48">
                      <MenuItem
                        icon={Star}
                        label={t("tasks.engines.setDefault")}
                        disabled={!engine.enabled || isDefault}
                        onSelect={() =>
                          void action(engine.id, () =>
                            api.setDefault(engine.id),
                          )
                        }
                      />
                      <MenuItem
                        icon={Stethoscope}
                        label={t("tasks.engines.check")}
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
                        label={t("tasks.engines.testModel")}
                        disabled={!engine.enabled}
                        onSelect={() =>
                          void action(`test:${engine.id}`, () =>
                            testModel(engine.id),
                          )
                        }
                      />
                      <MenuItem
                        icon={Settings2}
                        label={t("tasks.engines.configure")}
                        onSelect={() => setEditing(engine)}
                      />
                    </PopoverContent>
                  </Popover>
                  <Switch
                    checked={engine.enabled}
                    disabled={!!busy}
                    aria-label={t(
                      engine.enabled
                        ? "tasks.engines.disable"
                        : "tasks.engines.enable",
                      { engine: engineName(engine.id) },
                    )}
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
                    {t("tasks.engines.checking")}
                  </p>
                ) : null}
                {checked ? (
                  <div
                    role="status"
                    className="mt-3 ml-[50px] rounded-xl bg-muted px-3.5 py-3 text-[12.5px]"
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-medium">
                        {t("tasks.engines.checkTitle")}
                      </span>
                      <button
                        type="button"
                        className="text-subtle hover:text-foreground"
                        aria-label={t("tasks.engines.closeCheck")}
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
                {t("tasks.engines.empty")}
              </p>
              <p>{t("tasks.engines.emptyHint")}</p>
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
            {t("tasks.engines.advanced")}
          </summary>
          <div className="mt-4 space-y-4">
            <section
              className="panel overflow-hidden"
              aria-label={t("tasks.engines.discovery")}
            >
              <header className="flex items-center justify-between gap-3 px-5 py-3.5">
                <h2 className="section-title">
                  {t("tasks.engines.discovery")}
                </h2>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void discover()}
                    disabled={discovering}
                  >
                    <RefreshCw className={discovering ? "animate-spin" : ""} />
                    {t("tasks.engines.rescan")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === "reload"}
                    onClick={() => void action("reload", api.reload)}
                  >
                    {t("tasks.engines.reloadFile")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialogOpen(true)}
                  >
                    <Plus />
                    {t("tasks.engines.addManually")}
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
                        {t("tasks.engines.register")}
                      </Button>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="tag warn">
                            {t("tasks.engines.needsAdapter")}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-72">
                          {candidate.notes.join(" ") ||
                            t("tasks.engines.installAdapter")}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </li>
                ))}
                {!unregistered.length ? (
                  <li className="px-5 py-6 text-center text-[13px] text-muted-foreground">
                    {discovering || candidates === null
                      ? t("tasks.engines.scanning")
                      : t("tasks.engines.noneFound")}
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
              <DialogTitle>{t("tasks.engines.addTitle")}</DialogTitle>
              <DialogDescription>{t("tasks.engines.addLede")}</DialogDescription>
            </DialogHeader>
            <Textarea
              aria-label={t("tasks.engines.registration")}
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
                {t("common.cancel")}
              </Button>
              <Button
                disabled={busy === "register"}
                onClick={() => void submit()}
              >
                {busy === "register" ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {t("tasks.engines.add")}
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
