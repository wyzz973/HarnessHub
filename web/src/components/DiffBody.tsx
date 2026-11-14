import { MessageSquarePlus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import type { DiffFile, DiffLine } from "../lib/turn.js";

/** What the reader says about some lines of a file's diff: where they are, what they say, and the remark. It goes into the message box, before the next message. */
export interface DiffRemark { readonly path: string; readonly from: number; readonly to: number; readonly side: "old" | "new"; readonly quoted: string; readonly remark: string }

/** The two sides of a diff, row by row: an unchanged line on both, a run of removed lines beside the added lines that took its place, the longer run going on alone. */
type Pair = { readonly kind: "pair"; readonly left: DiffLine | null; readonly right: DiffLine | null; readonly at: number } | { readonly kind: "hunk"; readonly line: DiffLine; readonly at: number };
export function sideBySide(lines: readonly DiffLine[]): readonly Pair[] {
  const rows: Pair[] = [];
  let removed: { line: DiffLine; at: number }[] = [], added: { line: DiffLine; at: number }[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) rows.push({ kind: "pair", left: removed[index]?.line ?? null, right: added[index]?.line ?? null, at: (added[index] ?? removed[index])!.at });
    removed = []; added = [];
  };
  lines.forEach((line, at) => {
    if (line.kind === "remove") { if (added.length > 0) flush(); removed.push({ line, at }); return; }
    if (line.kind === "add") { added.push({ line, at }); return; }
    flush();
    if (line.kind === "context") rows.push({ kind: "pair", left: line, right: line, at });
    else if (line.kind === "hunk") rows.push({ kind: "hunk", line, at });
  });
  flush();
  return rows;
}

/**
 * One file's diff in the Changes page (2026-11-14, after the diff panel of T3 Code): its lines one under the other or its two sides beside each other, long lines
 * folded or scrolled, and a remark on a line or a run of lines. A line's number starts a remark; ⇧ and another number make it a run. The remark is written under the
 * last line of the run and is put into the message box with the lines it is about, so it goes to the Harness with the next message and the reader sees what will be sent.
 */
export function DiffBody({ file, wrap, split, onRemark }: { readonly file: DiffFile; readonly wrap: boolean; readonly split: boolean; readonly onRemark?: ((remark: DiffRemark) => void) | undefined }) {
  // The run a remark is being written on, by the places of its lines in `file.lines`.
  const [run, setRun] = useState<{ readonly from: number; readonly to: number } | null>(null), [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const pairs = useMemo(() => split ? sideBySide(file.lines) : [], [split, file.lines]);
  const remarkable = (line: DiffLine): boolean => onRemark !== undefined && (line.kind === "add" || line.kind === "remove" || line.kind === "context");
  const choose = (at: number, extend: boolean) => {
    setRun(current => extend && current !== null ? { from: Math.min(current.from, at), to: Math.max(current.to, at) } : { from: at, to: at });
    requestAnimationFrame(() => box.current?.focus());
  };
  const put = () => {
    if (run === null || onRemark === undefined || draft.trim() === "") return;
    const lines = file.lines.slice(run.from, run.to + 1).filter(line => line.kind === "add" || line.kind === "remove" || line.kind === "context");
    const side = lines.every(line => line.kind === "remove") ? "old" as const : "new" as const, numbers = lines.map(line => side === "old" ? line.oldNo : line.newNo ?? line.oldNo).filter((value): value is number => value !== undefined);
    onRemark({ path: file.path, side, from: Math.min(...numbers), to: Math.max(...numbers), quoted: lines.map(line => (line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ") + line.text).join("\n"), remark: draft.trim() });
    setRun(null); setDraft("");
  };
  const chosen = (at: number): boolean => run !== null && at >= run.from && at <= run.to;
  const number = (line: DiffLine, at: number, value: number | undefined) => remarkable(line)
    ? <button type="button" className="n diff-number" aria-label={"对第 " + (value ?? "") + " 行写评语"} title="写评语（按住 ⇧ 再点一行可选一段）" onClick={event => choose(at, event.shiftKey)}>
      <span aria-hidden="true">{value}</span><MessageSquarePlus size={12} strokeWidth={2} aria-hidden="true"/></button>
    : <span className="n">{value}</span>;
  const remark = (at: number) => run !== null && run.to === at ? <div className="diff-remark" role="group" aria-label="评语">
    <textarea ref={box} className="field min-h-[58px] w-full resize-y px-2 py-1.5 font-sans text-ui-sm leading-5" value={draft} placeholder={run.from === run.to ? "对这一行说点什么" : "对这 " + (run.to - run.from + 1) + " 行说点什么"} aria-label="评语"
      onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); put(); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRun(null); setDraft(""); } }}/>
    <div className="mt-1.5 flex items-center justify-end gap-1.5 font-sans"><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRun(null); setDraft(""); }}>取消</button>
      <button type="button" className="btn btn-primary btn-sm" disabled={draft.trim() === ""} onClick={put}>放进输入框</button></div>
  </div> : null;
  if (split) return <div className={cn("native-diff diff diff-split py-1.5", wrap && "is-wrapped")} role="group" aria-label="差异（并排）">{pairs.map((row, index) => row.kind === "hunk"
    ? <div key={index} className="diff-line is-hunk"><span className="n">⋯</span><span className="s"/><span className="c">{row.line.text}</span></div>
    : <div key={index} className="contents"><div className={cn("diff-pair", chosen(row.at) && "is-chosen")}>
      <div className={cn("diff-line diff-side", row.left === null ? "is-blank" : row.left.kind === "remove" ? "is-remove" : "")}>{row.left === null ? <span className="n"/> : number(row.left, row.at, row.left.oldNo)}<span className="c">{row.left?.text ?? ""}</span></div>
      <div className={cn("diff-line diff-side", row.right === null ? "is-blank" : row.right.kind === "add" ? "is-add" : "")}>{row.right === null ? <span className="n"/> : number(row.right, row.at, row.right.newNo)}<span className="c">{row.right?.text ?? ""}</span></div>
    </div>{remark(row.at)}</div>)}</div>;
  return <div className={cn("native-diff diff py-1.5", wrap && "is-wrapped")} role="group" aria-label="差异">{file.lines.map((line, at) => line.kind === "file" ? null
    : line.kind === "meta" ? <div key={at} className="diff-line is-file"><span className="n"/><span className="s"/><span className="c">{line.text}</span></div>
    : line.kind === "hunk" ? <div key={at} className="diff-line is-hunk"><span className="n">⋯</span><span className="s"/><span className="c">{line.text}</span></div>
    : <div key={at} className="contents"><div className={cn("diff-line", line.kind === "add" ? "is-add" : line.kind === "remove" ? "is-remove" : "", chosen(at) && "is-chosen")}>
      {number(line, at, line.kind === "remove" ? line.oldNo : line.newNo)}<span className="s">{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}</span><span className="c">{line.text}</span>
    </div>{remark(at)}</div>)}</div>;
}
