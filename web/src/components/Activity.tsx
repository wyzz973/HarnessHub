import { Check, Circle, Download, Info, Link, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ContentRef } from "../../../src/contracts/content.js";
import type { PlanStep } from "../../../src/contracts/protocol.js";
import type { PublicOutput } from "../../../src/contracts/session.js";
import { contentUrl, errorMessage, type ToolDetailView } from "../api.js";
import { cn } from "../lib/cn.js";
import { bytes } from "../lib/format.js";
import { knownToolDetail, parseUnifiedDiff, readToolDetail, type DiffFile } from "../lib/turn.js";
import { Spinner } from "../ui/primitives.js";

export type ToolDetailLoader = (content: ContentRef) => Promise<ToolDetailView>;

/**
 * A stored tool detail, read when `enabled` (a step opened, or an edit whose line counts are shown) and shared with every
 * other view of it on the page. A failed read is reported and asked again only by a later view.
 */
export function useToolDetail(content: ContentRef | undefined, load: ToolDetailLoader | undefined, enabled: boolean): { readonly detail: ToolDetailView | null; readonly problem: string | null; readonly loading: boolean } {
  const id = content?.id ?? null, known = id === null ? undefined : knownToolDetail(id);
  const [result, setResult] = useState<{ readonly id: string; readonly detail: ToolDetailView | null; readonly problem: string | null } | null>(null);
  useEffect(() => {
    if (!enabled || !content || !load || knownToolDetail(content.id) !== undefined) return;
    let current = true;
    readToolDetail(content, load).then(detail => { if (current) setResult({ id: content.id, detail, problem: null }); },
      (error: unknown) => { if (current) setResult({ id: content.id, detail: null, problem: errorMessage(error) }); });
    return () => { current = false; };
    // The content is identified by its id: a new reference object for the same id reads nothing again.
  }, [id, enabled, load]);
  const own = result !== null && result.id === id ? result : null;
  const detail = known ?? own?.detail ?? null, problem = detail ? null : own?.problem ?? null;
  return { detail, problem, loading: enabled && id !== null && load !== undefined && detail === null && problem === null };
}

/** The lines of one file of a diff: numbers, signs and text, with the file's header lines unless `headers` is false. */
export function DiffLines({ file, headers = true }: { readonly file: DiffFile; readonly headers?: boolean }) {
  return <>{file.lines.map((line, row) => line.kind === "file" || line.kind === "meta"
    ? headers || line.kind === "meta" ? <div key={row} className="diff-line is-file"><span className="n"/><span className="s"/><span className="c">{line.text}</span></div> : null
    : line.kind === "hunk" ? <div key={row} className="diff-line is-hunk"><span className="n">⋯</span><span className="s"/><span className="c">{line.text}</span></div>
    : <div key={row} className={cn("diff-line", line.kind === "add" ? "is-add" : line.kind === "remove" ? "is-remove" : "")}>
      <span className="n">{line.kind === "remove" ? line.oldNo : line.newNo}</span><span className="s">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</span><span className="c">{line.text}</span>
    </div>)}</>;
}
/** Unified diff with line numbers and roles; the text stays exact for copying. Only green marks added lines (ADR-054 §1). */
export function DiffView({ text, fallback = "改动", className }: { readonly text: string; readonly fallback?: string; readonly className?: string }) {
  const files = parseUnifiedDiff(text, fallback);
  return <div className={cn("native-diff diff py-1.5", className)}>{files.map((file, index) => <div key={index}><DiffLines file={file}/></div>)}</div>;
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-1"><h5 className="m-0 text-caption font-medium text-fg-3">{title}</h5>{children}</section>;
}
/**
 * The third layer of the process: what the program sent and got back for one action, as it reported it, read from the stored detail
 * when it is opened. `native` is the program's own name for the action, which belongs here as a small line and never in the action's
 * own line; `fallback` names the file of a diff that carries no header.
 */
export function StoredDetail({ content, fallback, load, native }: { readonly content: ContentRef | undefined; readonly fallback: string; readonly load: ToolDetailLoader | undefined; readonly native?: string | undefined }) {
  const { detail, problem, loading } = useToolDetail(content, load, true);
  const pre = "m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-fg";
  const names = [...new Set([native, detail?.name, detail?.kind].filter(Boolean))].join(" · ");
  return <div className="native-tool-detail mt-0.5 mb-2 ml-[30px] flex min-w-0 flex-col gap-2.5 rounded-block bg-inset px-3 py-2.5 text-ui-sm">
    {loading ? <p className="m-0 flex items-center gap-1.5 text-fg-3"><Spinner size={12} label=""/>读取工具详情…</p> : null}
    {problem ? <p className="m-0 text-red" role="status">{problem}</p> : null}
    {detail ? <>
      {names ? <p className="m-0 text-caption text-fg-3">{names}</p> : null}
      {detail.input ? <Section title="输入"><pre className={pre}>{detail.input}</pre></Section> : null}
      {detail.diff ? <Section title="改动"><DiffView text={detail.diff} fallback={detail.locations?.[0] ?? fallback} className="max-h-96 overflow-auto rounded-row bg-app shadow-hairline"/></Section> : null}
      {detail.output ? <Section title="输出"><pre className={pre}>{detail.output}</pre></Section> : null}
      {detail.locations?.length ? <Section title="位置"><ul className="m-0 list-none p-0">{detail.locations.map(path => <li key={path} className="min-w-0 break-all font-mono text-code text-fg-2">{path}</li>)}</ul></Section> : null}
      {detail.truncated ? <p className="m-0 text-caption text-fg-3">内容较长，已按预算截取显示。</p> : null}
      {!detail.input && !detail.output && !detail.diff && !detail.locations?.length ? <p className="m-0 text-fg-3">这个工具没有返回可显示的输入或输出。</p> : null}
    </> : null}
  </div>;
}
/**
 * The task list a Harness reported (Conversation board): finished steps checked and struck through, the one in progress in blue, the rest
 * open. `owner` names whose list it is.
 */
export function PlanView({ steps, explanation, owner, compact: small = false }: { readonly steps: readonly PlanStep[]; readonly explanation?: string | undefined; readonly owner?: string; readonly compact?: boolean }) {
  const done = steps.filter(step => step.status === "completed").length;
  return <section className={cn("native-plan flex flex-col", small ? "gap-2" : "gap-2.5")} aria-label="计划">
    <p className="m-0 text-caption text-fg-3">{owner ? owner + " 维护的计划" : "计划"} · {done} / {steps.length} 完成</p>
    {explanation ? <p className="m-0 text-ui-sm text-fg-2">{explanation}</p> : null}
    <ol className={cn("m-0 flex list-none flex-col p-0", small ? "gap-2" : "gap-2.5")}>{steps.map((step, index) => <li key={index} className="flex items-start gap-2 text-ui-sm">
      <span role="img" aria-label={step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待办"} className={cn("mt-[2.5px] flex flex-none", step.status === "completed" ? "text-fg-3" : step.status === "in_progress" ? "text-run" : "text-placeholder")}>
        {step.status === "completed" ? <Check size={15} strokeWidth={1.9} aria-hidden="true"/> : <Circle size={15} strokeWidth={1.9} aria-hidden="true"/>}
      </span>
      <span className={cn("min-w-0 flex-1", step.status === "completed" ? "text-fg-3 line-through decoration-line-strong" : step.status === "in_progress" ? "font-medium text-fg" : "text-fg-2")}>{step.text}</span>
    </li>)}</ol>
  </section>;
}
/**
 * What the program announced during the Turn. Its warnings stay neutral (amber means only "waiting for you"); errors are red.
 */
export interface Announcement { readonly severity: "info" | "warning" | "error"; readonly title: string; readonly detail?: string }
export function NoticeList({ notices }: { notices: readonly Announcement[] }) {
  return <div className="flex flex-col gap-1.5">{notices.map((notice, index) => <div key={index} role={notice.severity === "error" ? "alert" : "status"}
    className={cn("native-notice flex items-start gap-2.5 rounded-block px-3 py-2.5 text-ui-sm", notice.severity === "error" ? "bg-red-soft" : "bg-surface shadow-hairline")}>
    {notice.severity === "info" ? <Info size={16} className="mt-0.5 flex-none text-fg-3" aria-hidden="true"/> : <TriangleAlert size={16} className={cn("mt-0.5 flex-none", notice.severity === "error" ? "text-red" : "text-fg-2")} aria-hidden="true"/>}
    <div className="min-w-0"><strong className={cn("font-semibold", notice.severity === "error" && "text-red-on-tint")}>{notice.title}</strong>{notice.detail ? <p className="m-0 mt-0.5 break-words text-fg-2">{notice.detail}</p> : null}</div>
  </div>)}</div>;
}
/** Files, images and links the program produced; an image is shown, files are downloaded, links open elsewhere. */
export function OutputList({ outputs }: { outputs: readonly PublicOutput[] }) {
  const chip = "press inline-flex max-w-full items-center gap-1.5 rounded-control bg-surface px-2.5 py-1.5 text-ui-sm text-fg no-underline shadow-hairline hover:bg-subtle hover:no-underline";
  return <div className="flex flex-wrap gap-2">{outputs.map((output, index) => output.kind === "link"
    ? <a key={index} className={chip} href={output.uri} target="_blank" rel="noopener noreferrer"><Link size={14} className="text-fg-3" aria-hidden="true"/><span className="trunc">{output.title ?? output.name}</span></a>
    : output.content.kind === "image"
      ? <a key={index} className="block overflow-hidden rounded-block shadow-hairline" href={contentUrl(output.content)} target="_blank" rel="noopener noreferrer" title={output.content.name}><img className="block max-h-64 max-w-full" src={contentUrl(output.content)} alt={output.content.name} loading="lazy"/></a>
      : <a key={index} className={chip} href={contentUrl(output.content, true)} download={output.content.name}><Download size={14} className="text-fg-3" aria-hidden="true"/><span className="trunc">{output.content.name}</span><small className="text-caption text-fg-3">{bytes(output.content.bytes)}</small></a>)}</div>;
}
