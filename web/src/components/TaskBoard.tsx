import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BoardKind, TaskBoard } from "../../../src/contracts/session.js";
import { errorMessage } from "../api.js";
import { cn } from "../lib/cn.js";

/** Reads and writes the board of the task a conversation belongs to. */
export interface TaskBoardAccess {
  readonly load: (signal: AbortSignal) => Promise<TaskBoard>;
  readonly write: (change: { readonly kind: BoardKind; readonly text: string } | { readonly forget: string }) => Promise<TaskBoard>;
}
const KINDS: readonly { readonly kind: BoardKind; readonly label: string }[] = [{ kind: "goal", label: "目标" }, { kind: "constraint", label: "约束" }, { kind: "decision", label: "决定" }, { kind: "note", label: "备注" }];

/**
 * The task's board (2026-11-13): what every Harness working on the task goes by — its goal, the constraints, the decisions — written by you and by the Harnesses, and
 * given to each of them before your words whenever it changed. Here it is read, an entry is taken off, and a constraint is added. `stamp` changes when the conversation
 * moved on (a Turn began or ended), which is when a Harness may have written on it.
 */
export function TaskBoardSection({ access, stamp, name }: { readonly access: TaskBoardAccess; readonly stamp: string; readonly name: (harnessId: string) => string }) {
  const [board, setBoard] = useState<TaskBoard | null>(null), [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    const controller = new AbortController(), mine = ++latest.current;
    access.load(controller.signal).then(value => { if (!controller.signal.aborted && mine === latest.current) setBoard(value); }, () => { /* what is shown stays */ });
    return () => controller.abort();
  }, [access, stamp]);
  const change = (value: Parameters<TaskBoardAccess["write"]>[0], after?: () => void) => {
    if (busy) return;
    setBusy(true); setProblem(null); latest.current++;
    access.write(value).then(next => { setBoard(next); after?.(); }, (failure: unknown) => setProblem(errorMessage(failure))).finally(() => setBusy(false));
  };
  const add = () => { const text = draft.trim(); if (text !== "") change({ kind: "constraint", text }, () => setDraft("")); };
  const entries = board?.entries ?? [];
  return <section className="task-board flex flex-col gap-2.5" aria-label="任务板">
    <h3 className="m-0 text-caption font-normal text-fg-3">任务板</h3>
    {KINDS.map(({ kind, label }) => { const rows = entries.filter(entry => entry.kind === kind); return rows.length === 0 ? null : <div key={kind} className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2.5">
      <span className="pt-px text-caption leading-5 text-fg-3">{label}</span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{rows.map(entry => <li key={entry.id} className="group/entry flex min-w-0 items-start gap-1.5 text-ui-sm leading-5">
        <span className="flex min-w-0 flex-1 flex-col"><span className="break-words">{entry.text}</span>{entry.by === "user" ? null : <span className="text-caption text-fg-3">{name(entry.by)} 记</span>}</span>
        <button type="button" disabled={busy} onClick={() => change({ forget: entry.id })} aria-label={"从任务板去掉：" + entry.text} title="去掉"
          className={cn("icon-btn -my-0.5 size-6 flex-none text-fg-3 opacity-0 transition-opacity duration-120 ease-standard group-hover/entry:opacity-100 focus-visible:opacity-100")}><X size={13} strokeWidth={2}/></button>
      </li>)}</ul>
    </div>; })}
    <input className="field h-8 text-ui-sm" value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} placeholder="加一条所有 Harness 都要遵守的要求" aria-label="加一条所有 Harness 都要遵守的要求"
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }}/>
    {problem ? <p className="m-0 text-caption text-red" role="alert">{problem}</p> : null}
  </section>;
}
