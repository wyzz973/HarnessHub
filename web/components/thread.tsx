"use client";
import { createContext, memo, useContext, useState } from "react";
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type TextMessagePartProps,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileSpreadsheet,
  FileText,
  FolderClosed,
  FolderOpen,
  FolderTree,
  GitBranch,
  Mail,
  PackagePlus,
  PanelRight,
  Presentation,
  ScrollText,
  Settings2,
  ShieldQuestion,
  Square,
  type LucideIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Sources,
  Source,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { api } from "@/lib/api";
import type {
  AgentEvent,
  Engine,
  Run,
  Workflow,
  Workspace,
} from "@/lib/contracts";
import { isTerminal } from "@/lib/contracts";
import { engineName, selectableEngines } from "@/lib/engines";
import { bytes, duration, projectEvents } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { EngineAvatar } from "./engine-avatar";
import { Status } from "./status";
import { ToolSteps } from "./tool-call-card";

interface ThreadContextValue {
  runs: Run[];
  events: Record<string, AgentEvent[]>;
  onDecide: (permissionId: string, optionId: string) => void;
  pendingAction: boolean;
  onInspect: (runId: string) => void;
  /** Opens the diagnostics log of the run's session. */
  onOpenLogs: (runId: string) => void;
  /** Engine that executes a run; undefined while its session is still loading. */
  engineOf: (run: Run) => string | undefined;
}
const ThreadContext = createContext<ThreadContextValue>({
  runs: [],
  events: {},
  onDecide: () => {},
  pendingAction: false,
  onInspect: () => {},
  onOpenLogs: () => {},
  engineOf: () => undefined,
});
export const RunThreadProvider = ThreadContext.Provider;

const Markdown = memo(function Markdown({ text }: TextMessagePartProps) {
  return (
    <Streamdown className="markdown-content" mode="streaming">
      {text}
    </Streamdown>
  );
});
const UserMessage = () => (
  <MessagePrimitive.Root className="mb-7 animate-in duration-200 fade-in-0 slide-in-from-bottom-2">
    <div className="user-bubble">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

function permissionLabel(
  option: { label: string; kind: "allow_once" | "reject_once" },
  siblings: { kind: string }[],
) {
  const base = option.kind === "allow_once" ? "允许一次" : "拒绝";
  return siblings.filter((item) => item.kind === option.kind).length > 1
    ? `${base}（${option.label}）`
    : base;
}

const AssistantMessage = () => {
  const id = useAuiState((s) => s.message.id);
  const context = useContext(ThreadContext);
  const run = context.runs.find((r) => `assistant-${r.id}` === id);
  const projected = run
    ? projectEvents(run, context.events[run.id] ?? [])
    : undefined;
  const finished = run ? isTerminal(run.status) : true;
  const engineId = run ? context.engineOf(run) : undefined;
  const pending = run?.permissions?.filter(
    (permission) => permission.status === "pending",
  );
  return (
    <MessagePrimitive.Root className="group/message mb-9 animate-in duration-200 fade-in-0 slide-in-from-bottom-2">
      <div className="mb-3 flex h-7 items-center gap-2">
        <EngineAvatar id={engineId ?? "auto"} />
        <span className="text-[13.5px] font-medium">
          {engineId ? engineName(engineId) : "Agent"}
        </span>
        {run && !finished ? <Status status={run.status} /> : null}
        {run ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
                aria-label="执行详情"
                onClick={() => context.onInspect(run.id)}
              >
                <PanelRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>执行详情</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {projected?.reasoning ? (
        <Reasoning isStreaming={!finished} defaultOpen={false} className="mb-3">
          <ReasoningTrigger
            className="text-[13px]"
            getThinkingMessage={(streaming) =>
              streaming ? (
                <Shimmer as="span" duration={1.4}>
                  正在思考
                </Shimmer>
              ) : (
                <span>思考过程</span>
              )
            }
          />
          <ReasoningContent className="mt-2 border-l pl-4 text-[13.5px] leading-7">
            {projected.reasoning}
          </ReasoningContent>
        </Reasoning>
      ) : null}
      {projected ? (
        <ToolSteps tools={projected.tools} finished={finished} />
      ) : null}
      <MessagePrimitive.Parts components={{ Text: Markdown }} />
      {run &&
      !run.output &&
      !projected?.output &&
      !finished &&
      !pending?.length ? (
        <p className="py-1 text-[14px]">
          <Shimmer as="span" duration={1.6}>
            {run.status === "queued" ? "排队中" : "处理中"}
          </Shimmer>
        </p>
      ) : null}
      {projected?.sources.length ? (
        <Sources className="mt-4">
          <SourcesTrigger count={projected.sources.length}>
            来源 <span className="ml-1">{projected.sources.length}</span>
            <ChevronDown className="size-3" />
          </SourcesTrigger>
          <SourcesContent>
            {projected.sources.map((source) => (
              <Source href={source.url} title={source.title} key={source.url} />
            ))}
          </SourcesContent>
        </Sources>
      ) : null}
      {pending?.map((permission) => (
        <div
          key={permission.id}
          className="mt-4 rounded-2xl border border-warning/30 bg-warning-soft/60 p-4"
        >
          <p className="flex items-center gap-2 text-[13.5px] font-medium">
            <ShieldQuestion className="size-4 text-warning" />
            需要授权
          </p>
          <p className="mt-2 max-h-40 overflow-y-auto font-mono text-[12.5px] leading-6 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {permission.prompt}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {permission.options.map((option) => (
              <Button
                key={option.id}
                size="sm"
                disabled={context.pendingAction}
                variant={option.kind === "allow_once" ? "default" : "outline"}
                onClick={() => context.onDecide(permission.id, option.id)}
              >
                {option.kind === "allow_once" ? <Check /> : null}
                {permissionLabel(option, permission.options)}
              </Button>
            ))}
          </div>
        </div>
      ))}
      {run?.error ? (
        <div role="alert" className="callout error mt-4 items-start">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p>{run.error.message}</p>
            <p className="mt-0.5 font-mono text-[11.5px] opacity-75">
              {run.error.code}
            </p>
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => context.onOpenLogs(run.id)}
          >
            <ScrollText />
            查看日志
          </Button>
        </div>
      ) : null}
      {run?.artifacts?.length ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {run.artifacts.map((artifact) => (
            <a
              key={artifact.id}
              href={api.artifactUrl(artifact.id)}
              download={artifact.name}
              className="group/file flex items-center gap-3 rounded-xl border px-3 py-2.5 hover:border-border-strong hover:bg-muted"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground group-hover/file:bg-background">
                <FileText className="size-[18px]" strokeWidth={1.6} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">
                  {artifact.name}
                </span>
                <span className="block text-[12px] text-subtle">
                  {bytes(artifact.size)}
                </span>
              </span>
              <Download className="size-4 shrink-0 text-subtle opacity-0 group-hover/file:opacity-100" />
            </a>
          ))}
        </div>
      ) : null}
      {run && finished ? (
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-subtle">
          {run.status !== "completed" ? <Status status={run.status} /> : null}
          {run.finishedAt ? (
            <span className="tabular">
              {duration(run.finishedAt - (run.startedAt ?? run.createdAt))}
            </span>
          ) : null}
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
};
export function Messages() {
  return (
    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
  );
}

const suggestions: { icon: LucideIcon; label: string; prompt: string }[] = [
  {
    icon: FileText,
    label: "写周报 Word",
    prompt:
      "根据当前目录中的资料整理一份本周工作周报，包含本周完成、问题与下周计划，保存为“周报.docx”。",
  },
  {
    icon: FileSpreadsheet,
    label: "CSV 转 Excel",
    prompt:
      "把当前目录下的 CSV 文件整理成一个 Excel 工作簿：加粗表头、设置合适列宽、添加合计行，保存为 .xlsx。",
  },
  {
    icon: Presentation,
    label: "做汇报 PPT",
    prompt:
      "围绕当前目录中的资料制作一份 5 页左右的工作汇报演示文稿，保存为“工作汇报.pptx”。",
  },
  {
    icon: FolderTree,
    label: "整理文件",
    prompt:
      "按文件类型整理当前目录：创建分类文件夹并移动文件，完成后列出整理结果。",
  },
  {
    icon: Mail,
    label: "打开 Outlook",
    prompt: "请打开 Outlook 邮件客户端。",
  },
];
export function Greeting() {
  return (
    <h1 className="text-center text-[28px] leading-tight font-semibold tracking-[-0.015em] max-sm:text-[23px]">
      今天要完成什么任务？
    </h1>
  );
}
export function Suggestions({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {suggestions.map((item) => (
        <button
          key={item.label}
          type="button"
          className="suggestion-chip"
          onClick={() => onPick(item.prompt)}
        >
          <item.icon className="size-4 text-subtle" strokeWidth={1.7} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function WorkflowPlan({
  workflow,
  approve,
  cancel,
  pendingAction,
  inspect,
}: {
  workflow: Workflow;
  approve: () => void;
  cancel: () => void;
  pendingAction: boolean;
  inspect: (runId: string) => void;
}) {
  const completed = workflow.steps.filter(
    (step) => step.status === "completed",
  ).length;
  return (
    <section className="panel mb-8 overflow-hidden" aria-label="执行计划">
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        <GitBranch className="mt-1 size-4 shrink-0 text-subtle" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">
            {workflow.title ??
              (workflow.status === "planning" ? "正在制定计划" : "执行计划")}
          </h2>
          {workflow.steps.length ? (
            <p className="mt-0.5 text-[12.5px] text-subtle">
              {completed} / {workflow.steps.length} 步完成
            </p>
          ) : null}
        </div>
        <Status status={workflow.status} />
      </header>
      {workflow.steps.length ? (
        <ol className="border-t">
          {workflow.steps.map((step, index) => (
            <li
              key={step.id}
              className="flex gap-3 border-b px-5 py-3 last:border-b-0"
            >
              <span
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] text-subtle tabular",
                  step.status === "completed" &&
                    "border-transparent bg-success-soft text-success",
                )}
              >
                {step.status === "completed" ? (
                  <Check className="size-3" strokeWidth={2.4} />
                ) : (
                  index + 1
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium">
                    {step.title}
                  </span>
                  <span className="text-[12px] text-subtle">
                    {engineName(step.selection.engineId)}
                  </span>
                  {step.status !== "pending" && step.status !== "completed" ? (
                    <Status status={step.status} />
                  ) : null}
                  {step.runId ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      onClick={() => inspect(step.runId!)}
                    >
                      详情
                    </Button>
                  ) : null}
                </div>
                <details className="mt-1 text-[12.5px] text-muted-foreground">
                  <summary className="w-fit text-subtle hover:text-foreground">
                    说明
                    {step.dependsOn.length
                      ? `（依赖 ${step.dependsOn.join("、")}）`
                      : ""}
                  </summary>
                  <p className="mt-1.5 leading-6 whitespace-pre-wrap">
                    {step.instructions}
                  </p>
                  {step.outputs.length ? (
                    <p className="mt-1.5 font-mono text-[12px]">
                      {step.outputs.map((output) => output.path).join("、")}
                    </p>
                  ) : null}
                </details>
                {step.error ? (
                  <p className="mt-1.5 text-[12.5px] text-danger">
                    {step.error.message}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {workflow.status === "draft" || !isTerminal(workflow.status) ? (
        <footer className="flex items-center gap-2 border-t bg-muted/40 px-5 py-3">
          {workflow.status === "draft" ? (
            <>
              <Button size="sm" disabled={pendingAction} onClick={approve}>
                <Check />
                确认并执行
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pendingAction}
                onClick={cancel}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={pendingAction}
              onClick={cancel}
            >
              <Square className="size-3 fill-current" />
              停止
            </Button>
          )}
        </footer>
      ) : workflow.error ? (
        <footer className="border-t px-5 py-3 text-[12.5px] text-danger">
          {workflow.error.message}
        </footer>
      ) : null}
    </section>
  );
}

function workspaceLabel(workspace: Workspace | undefined, fallback: string) {
  if (!workspace) return fallback;
  const tail = workspace.path.split(/[\\/]/).filter(Boolean).at(-1);
  return workspace.id === "default" && tail ? tail : workspace.id;
}

export function Composer({
  mode,
  setMode,
  engineId,
  setEngineId,
  workspaceId,
  setWorkspaceId,
  engines,
  workspaces,
  running,
  workflowActive,
  sessionBound,
  onStop,
  outputPaths,
  setOutputPaths,
  fullAccess = false,
  sessionCwd,
  onManageEngines,
  autoFocus = false,
}: {
  mode: "auto" | "direct";
  setMode: (mode: "auto" | "direct") => void;
  engineId: string;
  setEngineId: (id: string) => void;
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  engines: Engine[];
  workspaces: Workspace[];
  running: boolean;
  workflowActive: boolean;
  sessionBound: boolean;
  onStop: () => void;
  outputPaths: string;
  setOutputPaths: (paths: string) => void;
  /** Gateway Full Access mode; planning then auto-approves tool requests and may be rejected. */
  fullAccess?: boolean;
  /** Directory of a bound Session whose workspace is not a registered one. */
  sessionCwd?: string;
  onManageEngines: () => void;
  autoFocus?: boolean;
}) {
  const [engineOpen, setEngineOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const choices = selectableEngines(
    engines,
    sessionBound ? engineId : undefined,
  );
  const locked = sessionBound || running || workflowActive;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const outputCount = outputPaths.split("\n").filter((line) => line.trim())
    .length;
  return (
    <div>
      <ComposerPrimitive.Root className="composer-surface">
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={
            workflowActive
              ? "计划任务进行中，可新建任务"
              : mode === "auto"
                ? "描述目标，先生成执行计划"
                : sessionBound
                  ? "继续对话"
                  : "描述你要完成的任务"
          }
          aria-label="任务描述"
          minRows={1}
          maxRows={8}
          autoFocus={autoFocus}
          disabled={workflowActive}
          addAttachmentOnPaste={false}
          unstable_insertNewlineOnTouchEnter
        />
        <div className="flex items-center gap-1">
          <Popover open={engineOpen} onOpenChange={setEngineOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="pill -ml-1.5"
                aria-label="选择引擎"
                disabled={locked}
              >
                <EngineAvatar id={engineId} size="xs" />
                <span className="truncate">
                  {engineId === "auto" ? "自动选择" : engineName(engineId)}
                </span>
                {locked ? null : (
                  <ChevronDown className="size-3.5 shrink-0 opacity-60" />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64" side="top">
              <div
                role="listbox"
                aria-label="引擎"
                className="max-h-[320px] overflow-y-auto"
              >
                {[{ id: "auto" }, ...choices].map((engine) => (
                  <button
                    key={engine.id}
                    type="button"
                    role="option"
                    aria-selected={engine.id === engineId}
                    className="flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] hover:bg-accent"
                    onClick={() => {
                      setEngineId(engine.id);
                      setEngineOpen(false);
                    }}
                  >
                    <EngineAvatar id={engine.id} />
                    <span className="min-w-0 flex-1 truncate">
                      {engine.id === "auto"
                        ? "自动选择"
                        : engineName(engine.id)}
                    </span>
                    {engine.id === engineId ? (
                      <Check className="size-4 text-brand" />
                    ) : null}
                  </button>
                ))}
              </div>
              <div className="mt-1 border-t pt-1">
                <PopoverClose asChild>
                  <button
                    type="button"
                    className="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={onManageEngines}
                  >
                    <Settings2 className="size-4" strokeWidth={1.7} />
                    管理引擎
                  </button>
                </PopoverClose>
              </div>
            </PopoverContent>
          </Popover>
          <Popover open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="pill"
                aria-label="工作目录"
                disabled={locked}
                title={sessionCwd ?? workspace?.path}
              >
                <FolderClosed className="size-[15px] shrink-0" strokeWidth={1.7} />
                <span className="truncate">
                  {workspaceLabel(
                    workspace,
                    sessionCwd?.split(/[\\/]/).filter(Boolean).at(-1) ??
                      (workspaceId || "工作目录"),
                  )}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80" side="top">
              <div role="listbox" aria-label="工作目录">
                {workspaces.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === workspaceId}
                    className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      setWorkspaceId(item.id);
                      setWorkspaceOpen(false);
                    }}
                  >
                    <FolderOpen
                      className="size-4 shrink-0 text-subtle"
                      strokeWidth={1.7}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px]">
                        {item.id}
                      </span>
                      <span
                        className="block truncate font-mono text-[11.5px] text-subtle"
                        title={item.path}
                      >
                        {item.path}
                      </span>
                    </span>
                    {item.id === workspaceId ? (
                      <Check className="size-4 shrink-0 text-brand" />
                    ) : null}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {mode === "direct" && !workflowActive ? (
            <Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="pill"
                      aria-label="完成后保存的文件"
                      disabled={running}
                    >
                      <PackagePlus
                        className="size-[15px] shrink-0"
                        strokeWidth={1.7}
                      />
                      {outputCount ? (
                        <span className="tabular">{outputCount}</span>
                      ) : null}
                    </button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>完成后保存的文件</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-80 p-4" side="top">
                <label className="field-label" htmlFor="output-paths">
                  完成后保存的文件
                </label>
                <textarea
                  id="output-paths"
                  aria-label="预期产物路径"
                  className="field font-mono text-[12.5px]"
                  rows={3}
                  value={outputPaths}
                  placeholder={"report.docx\noutput/data.xlsx"}
                  onChange={(event) => setOutputPaths(event.target.value)}
                />
                <p className="field-hint">
                  每行一个相对工作目录的路径，任务完成后可在结果中下载。
                </p>
              </PopoverContent>
            </Popover>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {sessionBound || workflowActive ? null : (
              <div className="segmented max-sm:hidden" role="group" aria-label="执行模式">
                <button
                  type="button"
                  aria-pressed={mode === "direct"}
                  disabled={running}
                  onClick={() => setMode("direct")}
                >
                  直接执行
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "auto"}
                  disabled={running}
                  onClick={() => setMode("auto")}
                >
                  先做计划
                </button>
              </div>
            )}
            {running ? (
              <button
                type="button"
                className="send-button"
                aria-label="停止执行"
                onClick={onStop}
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <ComposerPrimitive.Send asChild>
                <button
                  type="submit"
                  className="send-button"
                  aria-label={mode === "auto" ? "生成计划" : "发送任务"}
                  disabled={workflowActive || !choices.length}
                >
                  <ArrowUp className="size-[18px]" strokeWidth={2.2} />
                </button>
              </ComposerPrimitive.Send>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
      {mode === "auto" && fullAccess && !workflowActive && !sessionBound ? (
        <p className="mt-2 px-4 text-[12.5px] text-warning">
          完全访问模式下计划可能被拒绝，建议直接执行。
        </p>
      ) : null}
    </div>
  );
}
export function ScrollToBottom() {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <Button
        variant="outline"
        size="icon-sm"
        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-float disabled:invisible"
        aria-label="滚动到底部"
      >
        <ArrowDown />
      </Button>
    </ThreadPrimitive.ScrollToBottom>
  );
}
