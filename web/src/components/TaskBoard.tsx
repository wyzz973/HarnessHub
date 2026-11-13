import { Check, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardEntry, BoardKind, TaskBoard } from "../../../src/contracts/session.js";
import type { TaskMemberView } from "../../../src/contracts/web.js";
import { errorMessage, type TaskSnapshot } from "../api.js";
import { cn } from "../lib/cn.js";
import { oneLine } from "../lib/protocol/work.js";
import { StatusDot } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";

export type { TaskSnapshot };
/** Reads the task a conversation belongs to and writes its board. */
export interface TaskBoardAccess {
  readonly load: (signal: AbortSignal) => Promise<TaskSnapshot>;
  readonly write: (change: { readonly kind: BoardKind; readonly text: string } | { readonly forget: string }) => Promise<TaskBoard>;
}
const KINDS: Readonly<Record<BoardKind, string>> = { goal: "目标", constraint: "约束", decision: "决定", note: "备注" };
const ORDER: readonly BoardKind[] = ["goal", "constraint", "decision", "note"];

/**
 * The task as the details panel reads it (2026-11-13): read when the conversation moved on (`stamp`: a Turn began or ended, which is when a Harness may have written on the
 * board or handed work on), and written by the user. What is shown stays while a read is on its way, and through one that failed.
 */
export function useTask(access: TaskBoardAccess | undefined, stamp: string): {
  readonly task: TaskSnapshot | null; readonly busy: boolean; readonly problem: string | null;
  readonly change: (value: Parameters<TaskBoardAccess["write"]>[0], after?: () => void) => void;
} {
  const [task, setTask] = useState<TaskSnapshot | null>(null), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (access === undefined) { setTask(null); return; }
    const controller = new AbortController(), mine = ++latest.current;
    access.load(controller.signal).then(value => { if (!controller.signal.aborted && mine === latest.current) setTask(value); }, () => { /* what is shown stays */ });
    return () => controller.abort();
  }, [access, stamp]);
  const change = useCallback((value: Parameters<TaskBoardAccess["write"]>[0], after?: () => void) => {
    if (access === undefined || busy) return;
    setBusy(true); setProblem(null); latest.current++;
    access.write(value).then(board => { setTask(current => ({ board, members: current?.members ?? [] })); after?.(); }, (failure: unknown) => setProblem(errorMessage(failure))).finally(() => setBusy(false));
  }, [access, busy]);
  return { task, busy, problem, change };
}

/**
 * Who works on the task: the conversation it began in and every one that was handed a part of it, each with its Harness, what it was asked, how its latest Turn
 * stands and how many files it changed. The conversation the panel belongs to is marked; any other opens when chosen.
 */
export function TaskRoster({ members, current, onOpen }: { readonly members: readonly TaskMemberView[]; readonly current: string; readonly onOpen?: ((id: string) => void) | undefined }) {
  return <ul className="task-roster m-0 flex list-none flex-col gap-px p-0" aria-label="这件任务里的对话">{members.map(member => {
    const self = member.sessionId === current;
    const facts = [member.harness, member.turns > 0 ? member.turns + " 轮" : null, member.files.length > 0 ? "改了 " + member.files.length + " 个文件" : null].filter(Boolean).join(" · ");
    const body = <>
      <BrandIcon brand={member.harnessId} name={member.harness} size={18} className="mt-px"/>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="trunc text-ui-sm text-fg">{oneLine(member.task) || member.harness}</span>
        <span className="trunc text-caption text-fg-3">{facts}</span>
      </span>
      <span className="mt-[3px] flex flex-none items-center text-caption">{member.status === "running" ? <StatusDot tone="run" label="进行中"/>
        : member.status === "failed" ? <span className="text-red">失败</span> : member.status === "unknown" ? <span className="text-amber">结果未知</span>
        : member.status === "cancelled" ? <span className="text-fg-3">已停止</span> : member.status === "completed" ? <Check size={13} strokeWidth={2} className="text-fg-3" role="img" aria-label="已完成"/> : null}</span>
    </>;
    return <li key={member.sessionId} className="relative flex min-w-0" style={member.depth > 0 ? { paddingLeft: Math.min(member.depth, 4) * 18 } : undefined}>
      {member.depth > 0 ? <span aria-hidden="true" className="pointer-events-none absolute top-0 h-[17px] w-[9px] rounded-bl-[5px] border-b border-l border-line-strong" style={{ left: (Math.min(member.depth, 4) - 1) * 18 + 9 }}/> : null}
      {self || onOpen === undefined
        ? <div className={cn("flex w-full min-w-0 items-start gap-2 rounded-row px-2 py-1.5", self && "bg-subtle")} {...(self ? { "aria-current": "true" as const } : {})}>{body}</div>
        : <button type="button" className="row flex w-full min-w-0 items-start gap-2 border-none bg-transparent px-2 py-1.5 text-left hover:bg-subtle" onClick={() => onOpen(member.sessionId)} title="打开这段对话">{body}</button>}
    </li>;
  })}</ul>;
}

/**
 * The task's board: what every Harness working on the task goes by — its goal, the constraints, the decisions — written by you and by the Harnesses, and given to each
 * of them before your words whenever it changed. Each entry says who wrote it; one is taken off from its row.
 */
export function BoardEntries({ entries, busy, onForget, name }: { readonly entries: readonly BoardEntry[]; readonly busy: boolean; readonly onForget: (id: string) => void; readonly name: (harnessId: string) => string }) {
  if (entries.length === 0) return null;
  const ordered = ORDER.flatMap(kind => entries.filter(entry => entry.kind === kind));
  return <ul className="task-board m-0 flex list-none flex-col p-0" aria-label="任务板">{ordered.map(entry => <li key={entry.id} className="group/entry flex min-w-0 items-start gap-2 py-[5px] text-ui-sm leading-5">
    <span className="mt-0.5 flex-none rounded-tag bg-subtle px-1.5 text-[11px] leading-4 text-fg-2">{KINDS[entry.kind]}</span>
    <span className="flex min-w-0 flex-1 flex-col"><span className="break-words">{entry.text}</span>{entry.by === "user" ? null : <span className="text-caption text-fg-3">{name(entry.by)} 记的{entry.from === undefined ? "" : "，依据第 " + (entry.from.ordinal + 1) + " 轮你说的话"}</span>}</span>
    <button type="button" disabled={busy} onClick={() => onForget(entry.id)} aria-label={"从任务板去掉：" + entry.text} title="去掉"
      className="icon-btn -my-0.5 size-6 flex-none text-fg-3 opacity-0 transition-opacity duration-120 ease-standard group-hover/entry:opacity-100 focus-visible:opacity-100"><X size={13} strokeWidth={2}/></button>
  </li>)}</ul>;
}

/** Adds a constraint to the board: one line, sent with Enter; Escape, or leaving it empty, puts it away. */
export function BoardAdd({ busy, onAdd, onClose, autoFocus = false }: { readonly busy: boolean; readonly onAdd: (text: string, done: () => void) => void; readonly onClose?: (() => void) | undefined; readonly autoFocus?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => { const text = draft.trim(); if (text !== "") onAdd(text, () => setDraft("")); };
  return <div className="relative flex items-center">
    <Plus size={13} strokeWidth={2} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-fg-3"/>
    <input className="field h-8 pl-7 text-ui-sm" value={draft} disabled={busy} autoFocus={autoFocus} onChange={event => setDraft(event.target.value)} placeholder="加一条所有 Harness 都要遵守的要求" aria-label="加一条所有 Harness 都要遵守的要求"
      onBlur={() => { if (draft.trim() === "") onClose?.(); }}
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } else if (event.key === "Escape") { event.stopPropagation(); setDraft(""); onClose?.(); } }}/>
  </div>;
}
