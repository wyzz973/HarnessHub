"use client";
import { useState } from "react";
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  ListTree,
  Loader2,
  Search,
  SquareTerminal,
  Trash,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import {
  toolKindNames,
  toolStatusNames,
  type ToolCallView,
} from "@/lib/presentation";

const kindIcons: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  think: Brain,
};
/** Steps beyond this count collapse into one summary row once the run has finished. */
const COLLAPSE_AFTER = 8;

/** One tool call: a single quiet row, details on demand, raw engine payload last. */
function ToolStep({ tool }: { tool: ToolCallView }) {
  const KindIcon = (tool.kind && kindIcons[tool.kind]) || Wrench;
  const active = tool.status === "running" || tool.status === "pending";
  // Some engines title a file operation with its path; the kind then reads better as the title.
  const kindName = tool.kind ? toolKindNames[tool.kind] : undefined;
  const pathTitle =
    kindName !== undefined && /^[^\s]*[\\/][^\s]*$/.test(tool.title);
  const title = pathTitle ? kindName : tool.title;
  const preview = pathTitle
    ? tool.title
    : (tool.input[0]?.value ?? tool.inputText ?? tool.locations[0] ?? "");
  return (
    <Collapsible data-status={tool.status}>
      <CollapsibleTrigger className="step-row group">
        <KindIcon
          className={cn(
            "size-[15px] shrink-0",
            tool.status === "failed" ? "text-danger" : "text-subtle",
          )}
          strokeWidth={1.8}
          aria-hidden
        />
        <span
          className={cn(
            "max-w-[46%] shrink-0 truncate font-medium text-foreground",
            tool.status === "failed" && "text-danger",
          )}
        >
          {active ? (
            <Shimmer as="span" duration={1.6}>
              {title}
            </Shimmer>
          ) : (
            title
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-subtle"
          title={preview}
        >
          {preview}
        </span>
        <span className="sr-only">{toolStatusNames[tool.status]}</span>
        {active ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-info"
            aria-hidden
          />
        ) : tool.status === "failed" ? (
          <X className="size-3.5 shrink-0 text-danger" aria-hidden />
        ) : tool.status === "completed" ? (
          <Check className="size-3.5 shrink-0 text-success" aria-hidden />
        ) : null}
        <ChevronRight
          className="size-3.5 shrink-0 text-subtle transition-transform duration-150 group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="step-body">
          {tool.input.length || tool.inputText ? (
            <div>
              <p className="step-label">参数</p>
              {tool.inputText ? (
                <pre className="step-pre">{tool.inputText}</pre>
              ) : (
                <dl className="grid gap-1 font-mono text-[12px]">
                  {tool.input.map((entry) => (
                    <div
                      key={entry.label}
                      className="grid grid-cols-[minmax(64px,max-content)_minmax(0,1fr)] gap-3"
                    >
                      <dt className="text-subtle">{entry.label}</dt>
                      <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {entry.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {tool.inputMore ? (
                <p className="mt-1 text-[12px] text-subtle">
                  另有 {tool.inputMore} 个参数
                </p>
              ) : null}
            </div>
          ) : null}
          {tool.locations.length ? (
            <div>
              <p className="step-label">文件</p>
              <p className="font-mono text-[12px] break-all text-muted-foreground">
                {tool.locations.join("\n")}
              </p>
            </div>
          ) : null}
          <div>
            <p className="step-label">
              输出{tool.outputTruncated ? "（已截断）" : ""}
            </p>
            {tool.output ? (
              <pre
                className={cn(
                  "step-pre",
                  tool.status === "failed" && "text-danger",
                )}
              >
                {tool.output}
              </pre>
            ) : (
              <p className="text-[12.5px] text-subtle">
                {active ? "等待返回…" : "无输出"}
              </p>
            )}
          </div>
          <details>
            <summary className="w-fit text-[12px] text-subtle hover:text-foreground">
              原始数据
            </summary>
            <pre className="step-pre mt-2 max-h-72">
              {JSON.stringify(tool.raw, null, 2)}
            </pre>
          </details>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The tool calls of one run. While the run is active every step is visible; a finished
 * run with many steps folds into a summary that expands on demand.
 */
export function ToolSteps({
  tools,
  finished,
}: {
  tools: ToolCallView[];
  finished: boolean;
}) {
  const foldable = finished && tools.length > COLLAPSE_AFTER;
  const [expanded, setExpanded] = useState(false);
  if (!tools.length) return null;
  const failures = tools.filter((tool) => tool.status === "failed").length;
  if (foldable && !expanded)
    return (
      <button
        type="button"
        className="step-row mb-3"
        onClick={() => setExpanded(true)}
      >
        <ListTree className="size-[15px] shrink-0 text-subtle" aria-hidden />
        <span className="font-medium text-foreground">
          执行了 {tools.length} 个步骤
        </span>
        {failures ? (
          <span className="text-danger">{failures} 个失败</span>
        ) : null}
        <span className="flex-1" />
        <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden />
      </button>
    );
  return (
    <div className="step-list mb-3">
      {tools.map((tool) => (
        <ToolStep key={tool.id} tool={tool} />
      ))}
    </div>
  );
}
