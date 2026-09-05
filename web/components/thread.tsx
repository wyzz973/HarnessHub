"use client";
import { createContext, memo, useContext } from "react";
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
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  Layers2,
  Loader2,
  ShieldCheck,
  Square,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
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
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import {
  Plan,
  PlanContent,
  PlanDescription,
  PlanFooter,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
import type {
  AgentEvent,
  Engine,
  Run,
  Workflow,
  Workspace,
} from "@/lib/contracts";
import { isTerminal } from "@/lib/contracts";
import { projectEvents } from "@/lib/presentation";
import { Status } from "./status";

interface ThreadContextValue {
  runs: Run[];
  events: Record<string, AgentEvent[]>;
  onDecide: (permissionId: string, optionId: string) => void;
  pendingAction: boolean;
  onInspect: (runId: string) => void;
}
const ThreadContext = createContext<ThreadContextValue>({
  runs: [],
  events: {},
  onDecide: () => {},
  pendingAction: false,
  onInspect: () => {},
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
  <MessagePrimitive.Root className="message-row enter">
    <div className="user-message">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);
const AssistantMessage = () => {
  const id = useAuiState((s) => s.message.id);
  const context = useContext(ThreadContext);
  const run = context.runs.find((r) => `assistant-${r.id}` === id);
  const projected = run
    ? projectEvents(run, context.events[run.id] ?? [])
    : undefined;
  return (
    <MessagePrimitive.Root className="message-row enter">
      <div className="assistant-label">
        <span className="grid size-6 place-items-center rounded-md border bg-muted">
          <Layers2 className="size-3" />
        </span>
        HarnessHub
        {run ? (
          <button
            className="ml-auto text-[11px] font-normal text-muted-foreground hover:text-primary"
            onClick={() => context.onInspect(run.id)}
          >
            执行详情 ↗
          </button>
        ) : null}
      </div>
      {projected?.reasoning ? (
        <Reasoning
          isStreaming={run ? !isTerminal(run.status) : false}
          defaultOpen={false}
        >
          <ReasoningTrigger
            getThinkingMessage={(streaming) =>
              streaming ? "正在思考" : "查看思考过程"
            }
          />
          <ReasoningContent>{projected.reasoning}</ReasoningContent>
        </Reasoning>
      ) : null}
      {projected?.tools.map((tool) => (
        <Tool
          key={tool.id}
          className="mb-3 rounded-lg border-border"
          defaultOpen={false}
        >
          <ToolHeader
            type="tool-execution"
            state={tool.state}
            title={tool.title.slice(0, 100)}
          />
          <ToolContent>
            <ToolInput input={tool.details} />
          </ToolContent>
        </Tool>
      ))}
      <MessagePrimitive.Parts components={{ Text: Markdown }} />
      {run && !run.output && !projected?.output && !isTerminal(run.status) ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {run.status === "waiting_permission"
            ? "等待工具授权后继续…"
            : "引擎正在处理任务…"}
        </div>
      ) : null}
      {projected?.sources.length ? (
        <Sources className="mt-5">
          <SourcesTrigger count={projected.sources.length}>
            参考来源 <span className="ml-1">{projected.sources.length}</span>
            <ChevronDown className="size-3" />
          </SourcesTrigger>
          <SourcesContent>
            {projected.sources.map((source) => (
              <Source href={source.url} title={source.title} key={source.url} />
            ))}
          </SourcesContent>
        </Sources>
      ) : null}
      {run?.error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-100 bg-red-50/60 p-3 text-xs leading-6 text-destructive"
        >
          {run.error.message}
          <span className="mt-1 block font-mono text-[10px]">
            {run.error.code}
          </span>
        </div>
      )}
      {run?.permissions
        ?.filter((permission) => permission.status === "pending")
        .map((permission) => (
          <div
            className="mt-4 rounded-xl border border-amber-200/70 bg-amber-50/40 p-4"
            key={permission.id}
          >
            <p className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck className="size-4 text-amber-700" />
              此操作需要你的授权
            </p>
            <p className="my-3 whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">
              {permission.prompt}
            </p>
            <div className="flex flex-wrap gap-2">
              {permission.options.map((option) => (
                <Button
                  key={option.id}
                  disabled={context.pendingAction}
                  variant={option.kind === "allow_once" ? "default" : "outline"}
                  size="sm"
                  onClick={() => context.onDecide(permission.id, option.id)}
                >
                  {option.kind === "allow_once" ? (
                    <Check className="size-3" />
                  ) : null}
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
      {run && isTerminal(run.status) ? (
        <div className="mt-4 flex items-center gap-3">
          <Status status={run.status} />
          {run.artifacts?.length ? (
            <button
              className="text-xs text-muted-foreground hover:text-primary"
              onClick={() => context.onInspect(run.id)}
            >
              {run.artifacts.length} 个产物可下载
            </button>
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

export function Welcome({
  suggest,
  enabledCount,
}: {
  suggest: (text: string) => void;
  enabledCount: number;
}) {
  const suggestions = [
    {
      icon: Code2,
      title: "构建一个功能",
      description: "从想法到可运行的代码",
      prompt:
        "帮我实现一个简洁的待办事项页面，支持新增、完成和筛选任务。先制定实现计划，再分步骤完成。",
    },
    {
      icon: FileCode2,
      title: "分析项目代码",
      description: "理解结构，找到改进方向",
      prompt:
        "分析当前工作区的项目结构，梳理模块之间的依赖，找出最值得优先改进的三个问题，并生成一份分析报告。",
    },
    {
      icon: WorkflowIcon,
      title: "让 Agent 协作",
      description: "拆解复杂任务，逐步交付",
      prompt:
        "分析当前工作区，生成项目使用说明和架构说明，最后检查两份文档是否与实际代码一致。将任务拆成有依赖关系的步骤。",
    },
  ];
  return (
    <div className="welcome enter">
      <div className="welcome-emblem">
        <Layers2 className="size-6" strokeWidth={1.5} />
      </div>
      <div className="mb-2 text-[11px] font-medium tracking-[.15em] text-muted-foreground">
        YOUR AGENTS, ONE WORKSPACE
      </div>
      <h1>把想法，交给你的 Agent。</h1>
      <p className="mt-3">
        描述目标，选择引擎，或者让我们为你制定计划。
        <br />
        从第一步到最终产物，每一次执行都清晰可见。
      </p>
      <div className="suggestion-grid">
        {suggestions.map((item) => (
          <button
            key={item.title}
            className="suggestion group"
            onClick={() => suggest(item.prompt)}
          >
            <item.icon
              className="mb-5 size-[18px] text-[#7b8b70]"
              strokeWidth={1.6}
            />
            <div className="flex items-center justify-between text-[12px] font-medium">
              {item.title}
              <ArrowUp className="size-3 rotate-45 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <p className="suggestion-description mt-1 text-[11px]!">
              {item.description}
            </p>
          </button>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="size-1.5 rounded-full bg-[#799574]" />
        {enabledCount} 个已启用引擎 · 任务与产物保存在本机
      </div>
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
    <Plan
      defaultOpen
      className="mb-8 gap-0 overflow-hidden rounded-xl border-[#dfe5d9] bg-[#fcfdf9] py-0"
    >
      <PlanHeader className="p-5">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <GitBranch className="size-4 text-[#6a825b]" />
            <span className="text-[11px] text-muted-foreground">执行计划</span>
            <Status status={workflow.status} />
          </div>
          <PlanTitle className="text-[15px] font-medium">
            {workflow.title ?? "正在拆解你的任务"}
          </PlanTitle>
          <PlanDescription className="mt-2 text-xs leading-6">
            {workflow.status === "planning"
              ? "规划引擎正在分析目标与任务依赖。"
              : `${workflow.steps.length} 个步骤 · ${completed} 个已完成 · ${workflow.workspaceId}`}
          </PlanDescription>
        </div>
        <PlanTrigger aria-label="展开或收起计划" />
      </PlanHeader>
      <PlanContent className="px-5 pb-1">
        {workflow.steps.map((step, index) => (
          <div
            key={step.id}
            className="relative flex gap-3 border-t border-[#e8ecdf] py-4"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full border bg-white text-[10px] text-muted-foreground">
              {step.status === "completed" ? (
                <Check className="size-3 text-[#5a7a49]" />
              ) : (
                String(index + 1).padStart(2, "0")
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{step.title}</span>
                {step.runId ? (
                  <button
                    className="ml-auto text-[10px] text-muted-foreground hover:text-primary"
                    onClick={() => inspect(step.runId!)}
                  >
                    查看执行 ↗
                  </button>
                ) : null}
              </div>
              <p className="mt-1.5 text-[11px] leading-6 text-muted-foreground">
                {step.selection.engineId} ·{" "}
                {step.selection.mode === "auto" ? "自动选择" : "指定引擎"}
              </p>
              <details className="mt-1 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">
                  任务说明
                  {step.dependsOn.length
                    ? ` · 依赖 ${step.dependsOn.join("、")}`
                    : ""}
                </summary>
                <p className="mt-2 whitespace-pre-wrap leading-6">
                  {step.instructions}
                </p>
                {step.outputs.length ? (
                  <p className="mt-2 font-mono">
                    产物：{step.outputs.map((output) => output.path).join("、")}
                  </p>
                ) : null}
              </details>
              {step.status !== "pending" ? (
                <div className="mt-2">
                  <Status status={step.status} />
                </div>
              ) : null}
              {step.error ? (
                <p className="mt-2 text-xs text-destructive">
                  {step.error.message}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </PlanContent>
      <PlanFooter className="gap-2 border-t border-[#e8ecdf] px-5 py-4">
        {workflow.status === "draft" ? (
          <>
            <Button size="sm" disabled={pendingAction} onClick={approve}>
              <Check className="size-3.5" />
              确认并执行
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pendingAction}
              onClick={cancel}
            >
              取消计划
            </Button>
            <span className="ml-auto hidden text-[10px] text-muted-foreground sm:block">
              确认后开始分配任务
            </span>
          </>
        ) : !isTerminal(workflow.status) ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pendingAction}
            onClick={cancel}
          >
            <Square className="size-3" />
            停止任务
          </Button>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {workflow.error?.message ?? "执行记录和产物已保留，可在右侧查看。"}
          </p>
        )}
      </PlanFooter>
    </Plan>
  );
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
}) {
  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer-surface">
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={
            workflowActive
              ? "当前任务完成后，可新建下一项任务"
              : mode === "auto"
                ? "描述你的目标，Agent 会先制定执行计划…"
                : "向 Agent 发送任务，或继续当前对话…"
          }
          aria-label="任务描述"
          minRows={2}
          maxRows={7}
          disabled={workflowActive}
          addAttachmentOnPaste={false}
          unstable_insertNewlineOnTouchEnter
        />
        <div className="composer-tools">
          <label className="flex items-center gap-0.5">
            <GitBranch className="ml-1 size-3.5 text-muted-foreground" />
            <select
              className="small-select"
              aria-label="执行模式"
              value={mode}
              disabled={sessionBound || running || workflowActive}
              onChange={(event) =>
                setMode(event.target.value === "auto" ? "auto" : "direct")
              }
            >
              <option value="auto">自动规划</option>
              <option value="direct">直接执行</option>
            </select>
          </label>
          <span className="mx-1 h-3 w-px bg-border" />
          <select
            className="small-select"
            value={engineId}
            aria-label="选择引擎"
            disabled={sessionBound || running || workflowActive}
            onChange={(event) => setEngineId(event.target.value)}
          >
            <option value="auto">自动选择引擎</option>
            {engines
              .filter(
                (engine) =>
                  engine.enabled || (sessionBound && engine.id === engineId),
              )
              .map((engine) => (
                <option value={engine.id} key={engine.id}>
                  {engine.id}
                </option>
              ))}
          </select>
          <div className="ml-auto">
            {running ? (
              <Button
                type="button"
                size="icon-sm"
                aria-label="停止执行"
                onClick={onStop}
                className="rounded-full"
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <ComposerPrimitive.Send asChild>
                <Button
                  size="icon-sm"
                  aria-label={mode === "auto" ? "生成计划" : "发送任务"}
                  className="rounded-full"
                  disabled={
                    workflowActive || !engines.some((engine) => engine.enabled)
                  }
                >
                  <ArrowUp className="size-4" />
                </Button>
              </ComposerPrimitive.Send>
            )}
          </div>
        </div>
      </ComposerPrimitive.Root>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-y-1 px-1 text-[10px] text-muted-foreground">
        <label className="flex min-w-0 items-center gap-1.5">
          <FolderOpen className="size-3" />
          <select
            className="max-w-[240px] bg-transparent text-[10px] outline-none"
            value={workspaceId}
            aria-label="工作区"
            disabled={sessionBound || running || workflowActive}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>
                {workspace.id}
              </option>
            ))}
          </select>
        </label>
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
      {mode === "direct" && !workflowActive ? (
        <details className="mt-2 px-1 text-[10px] text-muted-foreground">
          <summary className="w-fit cursor-pointer">需要保存文件产物？</summary>
          <label className="mt-2 block leading-6">
            完成后采集的相对路径（每行一个）
            <textarea
              aria-label="预期产物路径"
              className="mt-1 block w-full rounded-md border p-2 font-mono text-xs outline-none"
              rows={2}
              value={outputPaths}
              onChange={(event) => setOutputPaths(event.target.value)}
              placeholder="report.md"
              disabled={running}
            />
          </label>
        </details>
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
        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white shadow-sm"
        aria-label="滚动至最新消息"
      >
        <ArrowDown className="size-3.5" />
      </Button>
    </ThreadPrimitive.ScrollToBottom>
  );
}
