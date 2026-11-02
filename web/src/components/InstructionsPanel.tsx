import { ChevronRight, ClipboardCopy, Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { InstructionsView, InstructionTargetView } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Collapsible } from "../ui/motion.js";
import { Notice, Spinner } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import type { ChangeRequest } from "./CapabilityChangeDialog.js";

const STATE_LABEL: Readonly<Record<InstructionTargetView["state"], string>> = { synced: "已写入", outdated: "待更新", changed: "被外部改动", removed: "被外部移除", absent: "未写入", claimable: "一致",
  shadowed: "被遮蔽", elsewhere: "经其他文件生效", unreadable: "无法读取", unsupported: "不支持" };
/** Blue for written, amber for what waits for the user, grey for the rest (ADR-054 §1). */
const STATE_TONE: Readonly<Record<InstructionTargetView["state"], string>> = { synced: "text-accent-text", outdated: "text-amber", changed: "text-amber", removed: "text-amber", absent: "text-fg-3", claimable: "text-fg-2",
  shadowed: "text-amber", elsewhere: "text-fg-2", unreadable: "text-amber", unsupported: "text-fg-3" };
function utf8(text: string): number { return new TextEncoder().encode(text).length; }
function kib(bytes: number): string { return (bytes / 1024).toFixed(1) + " KiB"; }
/** The additions as saved, by Harness, for comparing with what is being edited. */
function savedAdditions(view: InstructionsView): Readonly<Record<string, string>> { return Object.fromEntries(view.additions.map(item => [item.harnessId, item.text])); }

/**
 * HarnessHub's instructions (ADR-045 §6, step 4): one shared text and each Harness's addition, written as a marked block
 * into the user-level instructions file each Harness reads. Saving changes no Harness file; each write and removal goes
 * through the usual confirmation, after the texts are saved.
 */
export function InstructionsPanel({ api, harness, reload, onChange, onNotice }: { readonly api: GatewayApi; readonly harness: string | null; readonly reload: number; readonly onChange: (request: ChangeRequest) => void;
  readonly onNotice: (text: string, failed: boolean) => void }) {
  const [view, setView] = useState<InstructionsView | null>(null), [problem, setProblem] = useState<string | null>(null), [tick, setTick] = useState(0);
  const [shared, setShared] = useState(""), [additions, setAdditions] = useState<Readonly<Record<string, string>>>({}), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api.instructions(controller.signal).then(next => { setView(next); setProblem(null); if (!edited) { setShared(next.shared.text); setAdditions(savedAdditions(next)); } }, error => { if (!controller.signal.aborted) setProblem(errorMessage(error)); });
    return () => controller.abort();
  // Reloading the states keeps the texts being edited: `edited` is read, not watched.
  }, [api, reload, tick]);
  const writable = useMemo(() => view?.targets.filter(target => target.state !== "unsupported") ?? [], [view]);
  const rows = useMemo(() => view?.targets.filter(target => harness === null || target.harnessId === harness) ?? [], [view, harness]);
  const saved = view === null ? null : savedAdditions(view);
  const dirty = view !== null && saved !== null && (shared !== view.shared.text || [...new Set([...Object.keys(additions), ...Object.keys(saved)])].some(id => (additions[id] ?? "").trim() !== (saved[id] ?? "").trim()));
  const limit = view?.limitBytes ?? 16 * 1024, over = utf8(shared) > limit || Object.values(additions).some(text => utf8(text) > limit);
  const written = Object.values(additions).filter(text => text.trim()).length;
  const save = () => {
    setBusy(true);
    api.saveInstructions(shared, Object.fromEntries(Object.entries(additions).filter(([, text]) => text.trim() !== ""))).then(next => {
      setBusy(false); setEdited(false); setView(next); setShared(next.shared.text); setAdditions(savedAdditions(next));
      onNotice("已保存指令。要写进各 Harness，请在下面逐个确认。", false);
    }, error => { setBusy(false); onNotice(errorMessage(error), true); });
  };
  const discard = () => { if (view === null) return; setEdited(false); setShared(view.shared.text); setAdditions(savedAdditions(view)); };
  const sync = (target: InstructionTargetView, verb: string) => onChange({ title: verb + "指令：" + target.name, verb, on: true, done: "已把指令写入 " + target.name,
    load: options => api.checkInstructions("sync", target.harnessId, options) });
  const remove = (target: InstructionTargetView) => onChange({ title: "移除指令区块：" + target.name, verb: "移除", on: false, done: "已从 " + target.name + " 移除指令区块",
    load: options => api.checkInstructions("remove", target.harnessId, options) });
  const claim = (target: InstructionTargetView) => api.claimInstructions(target.harnessId).then(() => { onNotice("已认领 " + target.name + " 的指令区块：它由 HarnessHub 管理，文件没有改动。", false); setTick(value => value + 1); },
    error => onNotice(errorMessage(error), true));
  const copy = () => navigator.clipboard.writeText(shared).then(() => onNotice("已复制共享指令，可以粘贴到 Cursor 设置的 Rules → User Rules。", false), error => onNotice(errorMessage(error), true));
  const actions = (target: InstructionTargetView) => {
    const button = (label: string, run: () => void) => <button key={label} type="button" className="btn btn-ghost btn-sm" disabled={dirty} title={dirty ? "先保存指令" : undefined} onClick={run}>{label}</button>;
    switch (target.state) {
      case "absent": return [button("写入", () => sync(target, "写入"))];
      case "elsewhere": return [button("改为新建 " + target.name + " 自己的文件（之后不再回退）", () => sync(target, "新建"))];
      case "outdated": return [button("更新", () => sync(target, "更新")), button("移除", () => remove(target))];
      case "changed": return [button("重新写入", () => sync(target, "重新写入")), button("移除", () => remove(target))];
      case "removed": return [button("重新写入", () => sync(target, "重新写入"))];
      case "synced": case "shadowed": return [button("移除", () => remove(target))];
      case "claimable": return [<button key="claim" type="button" className="btn btn-ghost btn-sm" onClick={() => void claim(target)}>认领</button>];
      case "unsupported": return target.harnessId === "cursor" && shared.trim() !== "" ? [<button key="copy" type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}><ClipboardCopy size={12}/>复制共享指令</button>] : [];
      case "unreadable": return [];
    }
  };
  return <section className="instructions-panel card px-4 py-3.5 text-ui-sm" aria-label="统一指令">
    <div className="flex min-w-0 max-w-reading flex-col gap-0.5"><h3 className="m-0 text-ui font-semibold">统一指令</h3>
      <span className="text-caption text-fg-3">HarnessHub 保存一份共享指令和每个 Harness 的追加文本，以带标记的区块写进各家的用户级指令文件；区块外的内容不动。</span></div>
    {problem ? <Notice tone="red" className="mt-3">{problem}</Notice> : null}
    {view === null ? problem ? null : <p className="m-0 mt-3 flex items-center gap-2 text-fg-2" role="status"><Spinner size={13} label=""/>正在读取指令</p> : <>
      <label className="mt-3 flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-2 text-caption"><span className="font-medium text-fg-2">共享指令</span><span className={utf8(shared) > limit ? "text-red" : "text-fg-3"}>{kib(utf8(shared))} / {kib(limit)}</span></span>
        <textarea className="field min-h-[132px] font-mono text-code" aria-label="共享指令" aria-describedby="instructions-hint" value={shared} placeholder="例如：回复使用中文；提交信息写清改了什么、为什么。"
          onChange={event => { setEdited(true); setShared(event.target.value); }}/>
        <span id="instructions-hint" className="text-caption text-fg-3">家目录请写成 ~（例如 ~/projects），不要写完整路径；不要写密钥。各 Harness 会把这段文字当作你的长期指令。</span>
      </label>
      <button type="button" className="btn btn-ghost btn-sm mt-2 -ml-2.5 self-start" aria-expanded={open} aria-controls="instruction-additions" onClick={() => setOpen(value => !value)}>
        <ChevronRight size={13} aria-hidden="true" className={open ? "motion-rotate rotate-90" : "motion-rotate"}/>每个 Harness 的追加文本{written ? "（" + written + "）" : ""}</button>
      <Collapsible open={open} id="instruction-additions"><div className="instruction-additions flex flex-col gap-3 pt-1.5 pb-1">{writable.map(target => <label key={target.harnessId} className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-2 text-caption"><span className="font-medium text-fg-2">{target.name}</span><span className="text-fg-3">接在共享指令后面，只写进 {target.name}</span></span>
        <textarea className="field min-h-[56px] font-mono text-code" aria-label={target.name + " 的追加文本"} value={additions[target.harnessId] ?? ""}
          onChange={event => { setEdited(true); setAdditions(current => ({ ...current, [target.harnessId]: event.target.value })); }}/>
      </label>)}</div></Collapsible>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy || over} onClick={save}>{busy ? <Spinner size={12} label=""/> : <Save size={13}/>}保存</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!dirty || busy} onClick={discard}><Undo2 size={13}/>放弃修改</button>
        {dirty ? <span className="text-caption text-amber">有未保存的修改；写入各 Harness 前请先保存。</span> : view.shared.updatedAt ? <span className="text-caption text-fg-3">保存于 {new Date(view.shared.updatedAt).toLocaleString()}</span> : null}
      </div>
      <div className="mt-4 overflow-x-auto"><table className="instruction-targets w-full border-collapse text-left">
        <thead><tr className="hairline-b text-caption text-fg-3"><th scope="col" className="py-2 pr-3 font-normal">Harness</th><th scope="col" className="px-2 py-2 font-normal">文件</th>
          <th scope="col" className="px-2 py-2 font-normal">状态</th><th scope="col" className="px-2 py-2 font-normal">什么时候生效</th><th scope="col" className="px-2 py-2 font-normal">操作</th></tr></thead>
        <tbody>{rows.map(target => <tr key={target.harnessId} className="align-top [&+&]:hairline-t" data-harness={target.harnessId}>
          <th scope="row" className="py-2.5 pr-3 font-medium"><span className="flex items-center gap-2 whitespace-nowrap"><BrandIcon brand={target.harnessId} name={target.name} size={16}/>{target.name}</span></th>
          <td className="min-w-[180px] px-2 py-2.5">{target.file ? <code className="text-caption break-all">{target.file}</code> : <span className="text-fg-3">—</span>}</td>
          <td className="px-2 py-2.5"><span className="flex min-w-[120px] flex-col gap-0.5"><span className={"text-caption " + STATE_TONE[target.state]}>{STATE_LABEL[target.state]}</span>
            {target.reason ? <span className="text-caption text-fg-3">{target.reason}</span> : null}
            {target.cautions.map(caution => <span key={caution} className="text-caption text-amber">{caution}</span>)}</span></td>
          <td className="min-w-[160px] px-2 py-2.5 text-caption text-fg-2">{target.effect ?? "—"}</td>
          <td className="px-2 py-2"><span className="-ml-2.5 flex flex-wrap gap-0.5">{actions(target)}</span></td>
        </tr>)}</tbody></table></div>
    </>}
  </section>;
}
