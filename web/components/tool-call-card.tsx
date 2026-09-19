"use client";
import {
  ArrowRightLeft,
  Brain,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  FilePen,
  FileText,
  Globe,
  Loader2,
  Search,
  SquareTerminal,
  Trash,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  toolKindNames,
  toolStatusNames,
  type ToolCallView,
  type ToolStatus,
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
const statusIcons: Record<ToolStatus, LucideIcon> = {
  pending: CircleDashed,
  running: Loader2,
  completed: CircleCheck,
  failed: CircleX,
  unknown: CircleDashed,
};
/** One tool call: readable summary first, the engine's raw payload only on demand. */
export function ToolCallCard({ tool }: { tool: ToolCallView }) {
  const KindIcon = (tool.kind && kindIcons[tool.kind]) || Wrench;
  const StatusIcon = statusIcons[tool.status];
  const preview =
    tool.input[0]?.value ?? tool.inputText ?? tool.locations[0] ?? "";
  return (
    <Collapsible className="tool-card" data-status={tool.status}>
      <CollapsibleTrigger className="tool-card-header group">
        <KindIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 shrink-0 truncate font-medium">
          {tool.title}
        </span>
        {tool.kind && toolKindNames[tool.kind] ? (
          <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">
            {toolKindNames[tool.kind]}
          </span>
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted-foreground"
          title={preview}
        >
          {preview}
        </span>
        <span className={cn("tool-status", tool.status)}>
          <StatusIcon
            className={cn(
              "size-3",
              tool.status === "running" && "animate-spin",
            )}
            aria-hidden
          />
          {toolStatusNames[tool.status]}
        </span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="tool-card-body">
        {tool.input.length || tool.inputText ? (
          <div>
            <p className="tool-card-label">参数</p>
            {tool.inputText ? (
              <pre className="tool-card-pre">{tool.inputText}</pre>
            ) : (
              <dl className="tool-card-args">
                {tool.input.map((entry) => (
                  <div key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {tool.inputMore ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                另有 {tool.inputMore} 个参数，见原始数据
              </p>
            ) : null}
          </div>
        ) : null}
        {tool.locations.length ? (
          <div>
            <p className="tool-card-label">涉及文件</p>
            <p className="font-mono text-[11px] break-all text-muted-foreground">
              {tool.locations.join("、")}
            </p>
          </div>
        ) : null}
        <div>
          <p className="tool-card-label">
            输出{tool.outputTruncated ? "（已截断）" : ""}
          </p>
          {tool.output ? (
            <pre
              className={cn(
                "tool-card-pre",
                tool.status === "failed" && "text-destructive",
              )}
            >
              {tool.output}
            </pre>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {tool.status === "running" || tool.status === "pending"
                ? "等待工具返回结果…"
                : "引擎未提供输出内容"}
            </p>
          )}
        </div>
        <details className="tool-card-raw">
          <summary>原始数据（JSON）</summary>
          <pre className="tool-card-pre mt-2 max-h-72">
            {JSON.stringify(tool.raw, null, 2)}
          </pre>
        </details>
      </CollapsibleContent>
    </Collapsible>
  );
}
