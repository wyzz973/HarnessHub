import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SubagentDefinitionView, SubagentInventoryView, SubagentTargetView, SubagentView } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Notice, Spinner } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { DIALOG_BODY, DIALOG_FOOT, Field, type ChangeRequest } from "./CapabilityChangeDialog.js";

const STATE_LABEL: Readonly<Record<SubagentTargetView["state"], string>> = { synced: "已写入", claimable: "一致", outdated: "待更新", different: "同名不同", changed: "被外部改动", removed: "被外部移除", absent: "未写入", unsupported: "—" };
/** Blue for written, amber for what waits for the user (stale or changed by someone else), grey for the rest (ADR-054 §1). */
const STATE_TONE: Readonly<Record<SubagentTargetView["state"], string>> = { synced: "text-accent-text", claimable: "text-fg-2", outdated: "text-amber", different: "text-fg-3", changed: "text-amber", removed: "text-amber", absent: "text-fg-3", unsupported: "text-fg-3" };

/** One subagent in one Harness: where it stands, and what HarnessHub can do there (each goes through a check shown first). */
function TargetCell({ api, agent, target, harnessName, onChange, onClaim }: { readonly api: GatewayApi; readonly agent: SubagentView; readonly target: SubagentTargetView; readonly harnessName: string;
  readonly onChange: (request: ChangeRequest) => void; readonly onClaim: (name: string, harnessId: string) => void }) {
  const sync = (overwrite: boolean, verb: string) => onChange({ title: verb + " " + agent.name + " 到 " + harnessName, verb, on: true, done: "已把 " + agent.name + " 写入 " + harnessName,
    load: () => api.checkSubagent("sync", agent.name, target.harnessId, overwrite) });
  const action = (label: string, run: () => void) => <button type="button" className="btn btn-ghost btn-sm -ml-2.5" onClick={run}>{label}</button>;
  return <span className="flex flex-col items-start gap-0.5" title={target.reason ?? undefined}>
    <span className={"text-caption " + STATE_TONE[target.state]}>{STATE_LABEL[target.state]}</span>
    {target.state === "absent" ? action("写入", () => sync(false, "写入"))
      : target.state === "outdated" ? action("更新", () => sync(false, "更新"))
      : target.state === "changed" || target.state === "removed" ? action("重新写入", () => sync(true, "重新写入"))
      : target.state === "claimable" ? action("认领", () => onClaim(agent.name, target.harnessId)) : null}
    {target.state === "synced" || target.state === "outdated" ? action("移除", () => onChange({ title: "从 " + harnessName + " 移除 " + agent.name, verb: "移除", on: false,
      done: "已从 " + harnessName + " 移除 " + agent.name, load: () => api.checkSubagent("remove", agent.name, target.harnessId, false) })) : null}
  </span>;
}

/** Making or changing a subagent of the list: its name, the one-line description each Harness routes by, and its prompt. Nothing else is kept. */
function SubagentDialog({ api, editing, onClose, onSaved }: { readonly api: GatewayApi; readonly editing: { readonly name: string | null; readonly definition: SubagentDefinitionView } | null; readonly onClose: () => void; readonly onSaved: (name: string) => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [prompt, setPrompt] = useState(""), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (editing === null) return; setName(editing.name ?? ""); setDescription(editing.definition.description); setPrompt(editing.definition.prompt); setFailure(null); setBusy(false); }, [editing]);
  const save = () => {
    if (editing === null) return;
    setBusy(true); setFailure(null);
    api.saveSubagent(editing.name ?? name.trim(), { description, prompt }, editing.name !== null).then(saved => { setBusy(false); onSaved(saved); }, error => { setBusy(false); setFailure(errorMessage(error)); });
  };
  return <Dialog open={editing !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={editing?.name ? "编辑 " + editing.name : "新建子 Agent"}
    description="只保存名字、说明和正文：子 Agent 用父会话的模型、工具和权限，HarnessHub 不写会放宽权限或拉起程序的设置。" className="subagent-dialog w-[min(640px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red">{failure}</Notice> : null}
      {editing?.name ? null : <Field label="名字（小写字母、数字和 -）"><input className="field" aria-label="子 Agent 名字" value={name} placeholder="code-checker" onChange={event => setName(event.target.value)}/></Field>}
      <Field label="说明（一行；各 Agent 按它决定什么时候交给这个子 Agent）"><input className="field" aria-label="子 Agent 说明" value={description} onChange={event => setDescription(event.target.value)}/></Field>
      <Field label="正文（子 Agent 的系统提示；家目录写成 ~）"><textarea className="field min-h-[160px] font-mono text-code" aria-label="子 Agent 正文" value={prompt} onChange={event => setPrompt(event.target.value)}/></Field>
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? <Spinner size={13} label=""/> : null}保存到清单</button>
    </div>
  </Dialog>;
}

/**
 * HarnessHub's subagent list (ADR-045 §7, step 5): one place for subagents, written into Claude Code, Codex, Gemini and
 * OpenCode each in its own format. Each write and removal goes through the usual confirmation; editing the list itself
 * changes no Harness file.
 */
export function SubagentsPanel({ api, harness, reload, onChange, onNotice }: { readonly api: GatewayApi; readonly harness: string | null; readonly reload: number; readonly onChange: (request: ChangeRequest) => void;
  readonly onNotice: (text: string, failed: boolean) => void }) {
  const [view, setView] = useState<SubagentInventoryView | null>(null), [problem, setProblem] = useState<string | null>(null), [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<{ readonly name: string | null; readonly definition: SubagentDefinitionView } | null>(null);
  useEffect(() => { const controller = new AbortController(); api.subagents(controller.signal).then(next => { setView(next); setProblem(null); }, error => { if (!controller.signal.aborted) setProblem(errorMessage(error)); }); return () => controller.abort(); }, [api, reload, tick]);
  const columns = useMemo(() => view?.harnesses.filter(item => item.writable && (harness === null || item.harnessId === harness)) ?? [], [view, harness]);
  const skipped = useMemo(() => view?.harnesses.filter(item => !item.writable && (harness === null || item.harnessId === harness)) ?? [], [view, harness]);
  const claim = (name: string, harnessId: string) => api.claimSubagent(name, [harnessId]).then(() => { onNotice("已认领 " + name + "：文件由 HarnessHub 管理，没有改动。", false); setTick(value => value + 1); }, error => onNotice(errorMessage(error), true));
  const remove = (name: string) => api.removeSubagent(name).then(() => { onNotice("已从清单删除 " + name + "。各 Agent 的文件没有改动。", false); setTick(value => value + 1); }, error => onNotice(errorMessage(error), true));
  return <section className="subagent-inventory card px-4 py-3.5 text-ui-sm" aria-label="统一子 Agent">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 max-w-reading flex-col gap-0.5"><h3 className="m-0 text-ui font-semibold">统一子 Agent</h3>
        <span className="text-caption text-fg-3">HarnessHub 保存一份子 Agent 清单（名字、说明、正文），按各 Agent 自己的格式写成它们用户级目录里的文件。</span></div>
      <button type="button" className="btn btn-sm" onClick={() => setEditing({ name: null, definition: { description: "", prompt: "" } })}><Plus size={13}/>新建子 Agent</button>
    </div>
    {problem ? <Notice tone="red" className="mt-3">{problem}</Notice> : null}
    {view === null ? problem ? null : <p className="m-0 mt-3 flex items-center gap-2 text-fg-2" role="status"><Spinner size={13} label=""/>正在读取清单</p>
      : view.subagents.length === 0 ? <p className="m-0 mt-3 text-fg-3">清单是空的。新建一个子 Agent，再逐个写入各 Agent。</p>
      : <div className="mt-3 overflow-x-auto"><table className="subagents w-full border-collapse text-left">
        <thead><tr className="hairline-b"><th scope="col" className="min-w-[220px] py-2 pr-3 text-caption font-normal text-fg-3">子 Agent</th>
          {columns.map(item => <th key={item.harnessId} scope="col" className="min-w-[96px] px-2 py-2 text-caption font-normal text-fg-2">
            <span className="flex items-center gap-1.5"><BrandIcon brand={item.harnessId} name={item.name} size={16}/><span className="trunc">{item.name}</span></span></th>)}</tr></thead>
        <tbody>{view.subagents.map(agent => <tr key={agent.name} className="align-top [&+&]:hairline-t">
          <th scope="row" className="py-2.5 pr-3 font-normal"><span className="flex flex-col gap-1"><strong className="font-medium">{agent.name}</strong>
            <span className="text-fg-2">{agent.definition.description}</span>
            <span className="-ml-2.5 flex gap-0.5"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ name: agent.name, definition: agent.definition })}><Pencil size={12}/>编辑</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(agent.name)}><Trash2 size={12}/>从清单删除</button></span></span></th>
          {columns.map(item => { const target = agent.targets.find(entry => entry.harnessId === item.harnessId); return <td key={item.harnessId} className="px-2 py-2.5">{target ? <TargetCell api={api} agent={agent} target={target} harnessName={item.name} onChange={onChange} onClaim={(name, harnessId) => void claim(name, harnessId)}/> : null}</td>; })}
        </tr>)}</tbody></table></div>}
    {skipped.length ? <ul className="m-0 mt-3 flex list-none flex-col gap-0.5 p-0 text-caption text-fg-3">{skipped.map(item => <li key={item.harnessId}>{item.name}：{item.reason}</li>)}</ul> : null}
    <SubagentDialog api={api} editing={editing} onClose={() => setEditing(null)} onSaved={name => { setEditing(null); onNotice("已保存 " + name + " 到清单。要写入各 Agent，请在表格里逐个确认。", false); setTick(value => value + 1); }}/>
  </section>;
}
