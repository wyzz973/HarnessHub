import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { McpDefinitionView, McpInventoryView, McpServerView, McpTargetView } from "../../../src/contracts/capabilities.js";
import { errorMessage, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog } from "../ui/overlay.js";
import { Badge, Notice, Spinner } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";
import { DIALOG_BODY, DIALOG_FOOT, Field, type ChangeRequest } from "./CapabilityChangeDialog.js";

const STATE_LABEL: Readonly<Record<McpTargetView["state"], string>> = { synced: "已写入", claimable: "一致", outdated: "待更新", different: "同名不同", changed: "被外部改动", removed: "被外部移除", absent: "未写入", unsupported: "—" };
/** Blue for written, amber for what waits for the user (stale or changed by someone else), grey for the rest (ADR-054 §1). */
const STATE_TONE: Readonly<Record<McpTargetView["state"], string>> = { synced: "text-accent-text", claimable: "text-fg-2", outdated: "text-amber", different: "text-fg-3", changed: "text-amber", removed: "text-amber", absent: "text-fg-3", unsupported: "text-fg-3" };
function summary(definition: McpDefinitionView, command: string | null): string { return definition.transport === "stdio" ? command ?? "" : definition.transport.toUpperCase() + " · " + (definition.url ?? ""); }

/** One server in one Harness: where it stands, and the one thing HarnessHub can do there (each goes through a check shown first). */
function TargetCell({ api, server, target, harnessName, onChange, onClaim }: { readonly api: GatewayApi; readonly server: McpServerView; readonly target: McpTargetView; readonly harnessName: string;
  readonly onChange: (request: ChangeRequest) => void; readonly onClaim: (name: string, harnessId: string) => void }) {
  const sync = (overwrite: boolean, verb: string) => onChange({ title: verb + " " + server.name + " 到 " + harnessName, verb, on: true, done: "已把 " + server.name + " 写入 " + harnessName, load: () => api.checkMcpSync(server.name, target.harnessId, overwrite) });
  const action = (label: string, run: () => void) => <button type="button" className="btn btn-ghost btn-sm -ml-2.5" onClick={run}>{label}</button>;
  return <span className="flex flex-col items-start gap-0.5" title={target.reason ?? undefined}>
    <span className={"text-caption " + STATE_TONE[target.state]}>{STATE_LABEL[target.state]}</span>
    {target.state === "absent" ? action("写入", () => sync(false, "写入"))
      : target.state === "outdated" ? action("更新", () => sync(false, "更新"))
      : target.state === "changed" || target.state === "removed" ? action("重新写入", () => sync(true, "重新写入"))
      : target.state === "claimable" ? action("认领", () => onClaim(server.name, target.harnessId))
      : target.state === "synced" ? action("移除", () => onChange({ title: "从 " + harnessName + " 移除 " + server.name, verb: "移除", on: false,
        done: "已从 " + harnessName + " 移除 " + server.name, load: () => api.checkMcpRemove(server.name, target.harnessId) })) : null}
  </span>;
}

type Row = { kind: "variable" | "value"; key: string; variable: string; value: string; prefix: string };
const EMPTY: McpDefinitionView = { transport: "stdio", command: "", args: [], cwd: null, url: null, env: [], headers: [] };
/** Making or changing a server of the list: no value that looks like a credential is accepted, only the name of the variable it comes from. */
function ServerDialog({ api, editing, onClose, onSaved }: { readonly api: GatewayApi; readonly editing: { readonly name: string | null; readonly definition: McpDefinitionView } | null; readonly onClose: () => void; readonly onSaved: (name: string) => void }) {
  const [name, setName] = useState(""), [transport, setTransport] = useState<McpDefinitionView["transport"]>("stdio"), [command, setCommand] = useState(""), [args, setArgs] = useState(""), [cwd, setCwd] = useState(""), [url, setUrl] = useState("");
  const [env, setEnv] = useState<Row[]>([]), [headers, setHeaders] = useState<Row[]>([]), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (editing === null) return;
    const definition = editing.definition;
    setName(editing.name ?? ""); setTransport(definition.transport); setCommand(definition.command ?? ""); setArgs(definition.args.join("\n")); setCwd(definition.cwd ?? ""); setUrl(definition.url ?? ""); setFailure(null); setBusy(false);
    setEnv(definition.env.map(item => "variable" in item ? { kind: "variable", key: item.key, variable: item.variable, value: "", prefix: "" } : { kind: "value", key: item.key, variable: "", value: item.value, prefix: "" }));
    setHeaders(definition.headers.map(item => "variable" in item ? { kind: "variable", key: item.name, variable: item.variable, value: "", prefix: item.prefix } : { kind: "value", key: item.name, variable: "", value: item.value, prefix: "" }));
  }, [editing]);
  const save = () => {
    if (editing === null) return;
    const definition: McpDefinitionView = { transport, command: transport === "stdio" ? command.trim() : null, args: transport === "stdio" ? args.split("\n").map(line => line.trim()).filter(Boolean) : [], cwd: transport === "stdio" && cwd.trim() ? cwd.trim() : null,
      url: transport === "stdio" ? null : url.trim(), env: env.filter(row => row.key.trim()).map(row => row.kind === "variable" ? { key: row.key.trim(), variable: row.variable.trim() } : { key: row.key.trim(), value: row.value }),
      headers: headers.filter(row => row.key.trim()).map(row => row.kind === "variable" ? { name: row.key.trim(), variable: row.variable.trim(), prefix: row.prefix } : { name: row.key.trim(), value: row.value }) };
    setBusy(true); setFailure(null);
    api.saveMcpServer(editing.name ?? name.trim(), definition, editing.name !== null).then(saved => { setBusy(false); onSaved(saved); }, error => { setBusy(false); setFailure(errorMessage(error)); });
  };
  const rows = (label: string, items: Row[], set: (rows: Row[]) => void, headerRows: boolean) => <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"><legend className="mb-1.5 p-0 text-caption font-medium text-fg-2">{label}</legend>
    {items.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-1.5">
      <input className="field h-[30px] w-[150px]" aria-label={label + "的名字"} value={row.key} placeholder={headerRows ? "Authorization" : "LOG_LEVEL"} onChange={event => set(items.map((item, at) => at === index ? { ...item, key: event.target.value } : item))}/>
      <select className="field h-[30px] w-auto py-0" aria-label={label + "取值方式"} value={row.kind} onChange={event => set(items.map((item, at) => at === index ? { ...item, kind: event.target.value as Row["kind"] } : item))}>
        <option value="variable">取自环境变量</option><option value="value">字面值（不能是密钥）</option></select>
      {row.kind === "variable" ? <>{headerRows ? <input className="field h-[30px] w-[90px]" aria-label="前缀" placeholder="Bearer " value={row.prefix} onChange={event => set(items.map((item, at) => at === index ? { ...item, prefix: event.target.value } : item))}/> : null}
        <input className="field h-[30px] w-[150px]" aria-label="取值的变量" placeholder="MY_TOKEN" value={row.variable} onChange={event => set(items.map((item, at) => at === index ? { ...item, variable: event.target.value } : item))}/></>
        : <input className="field h-[30px] w-[180px]" aria-label="字面值" value={row.value} onChange={event => set(items.map((item, at) => at === index ? { ...item, value: event.target.value } : item))}/>}
      <button type="button" className="icon-btn icon-btn-sm" aria-label="删除这一行" onClick={() => set(items.filter((_, at) => at !== index))}><Trash2 size={14}/></button>
    </div>)}
    <button type="button" className="btn btn-ghost btn-sm -ml-2.5 self-start" onClick={() => set([...items, { kind: "variable", key: "", variable: "", value: "", prefix: headerRows ? "Bearer " : "" }])}><Plus size={13}/>添加</button></fieldset>;
  return <Dialog open={editing !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={editing?.name ? "编辑 " + editing.name : "新建 MCP 服务器"} description="只保存变量名与普通设置；密钥留在你的环境里，HarnessHub 不保存任何密钥值。" className="mcp-server-dialog w-[min(640px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red">{failure}</Notice> : null}
      {editing?.name ? null : <Field label="名称"><input className="field" aria-label="服务器名称" value={name} placeholder="filesystem" onChange={event => setName(event.target.value)}/></Field>}
      <Field label="传输方式"><select className="field" aria-label="传输方式" value={transport} onChange={event => setTransport(event.target.value as McpDefinitionView["transport"])}>
        <option value="stdio">本地程序（stdio）</option><option value="http">远程（HTTP）</option><option value="sse">远程（SSE）</option></select></Field>
      {transport === "stdio" ? <>
        <Field label="程序"><input className="field" aria-label="程序" value={command} placeholder="npx" onChange={event => setCommand(event.target.value)}/></Field>
        <Field label="参数（每行一个）"><textarea className="field min-h-[72px] font-mono text-code" aria-label="参数" value={args} onChange={event => setArgs(event.target.value)}/></Field>
        <Field label="工作目录（可选，绝对路径或 ~/ 开头）"><input className="field" aria-label="工作目录" value={cwd} onChange={event => setCwd(event.target.value)}/></Field>
        {rows("环境变量", env, setEnv, false)}
      </> : <>
        <Field label="地址（HTTPS）"><input className="field" aria-label="地址" value={url} placeholder="https://mcp.example.com/mcp" onChange={event => setUrl(event.target.value)}/></Field>
        {rows("请求头", headers, setHeaders, true)}
      </>}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? <Spinner size={13} label=""/> : null}保存到清单</button>
    </div>
  </Dialog>;
}

/** Listing servers the Harnesses already have; an identical entry can be recorded as HarnessHub's at the same time. No Harness file changes. */
function ImportDialog({ api, view, open, onClose, onImported }: { readonly api: GatewayApi; readonly view: McpInventoryView; readonly open: boolean; readonly onClose: () => void; readonly onImported: (count: number) => void }) {
  const [chosen, setChosen] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map()), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) { setChosen(new Map()); setFailure(null); setBusy(false); } }, [open]);
  const name = (id: string) => view.harnesses.find(harness => harness.harnessId === id)?.name ?? id;
  const run = async () => {
    setBusy(true); setFailure(null);
    try { for (const [id, claim] of chosen) await api.importMcpServer(id, [...claim]); setBusy(false); onImported(chosen.size); }
    catch (error) { setBusy(false); setFailure(errorMessage(error)); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }} title="从现有配置导入 MCP 服务器" description="收进 HarnessHub 的清单；勾选“认领”的 Harness 里那一项会记为 HarnessHub 管理的。不改任何配置文件。" className="mcp-import-dialog w-[min(680px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red">{failure}</Notice> : null}
      {view.candidates.length === 0 ? <p className="m-0 text-fg-3">各 Harness 的用户级配置里没有 MCP 服务器。</p>
        : <ul className="mcp-candidates m-0 flex list-none flex-col overflow-hidden rounded-block p-0 shadow-[inset_0_0_0_1px_var(--border)]">{view.candidates.map(candidate => {
        const selectable = candidate.definition !== null && candidate.state === "new", claims = chosen.get(candidate.id);
        return <li key={candidate.id} className="flex items-start gap-2.5 px-3 py-2.5 [&+&]:hairline-t">
          <input type="checkbox" className="mt-[3px] size-3.5 flex-none accent-accent" aria-label={"导入 " + candidate.name} disabled={!selectable} checked={claims !== undefined}
            onChange={() => setChosen(current => { const next = new Map(current); if (next.has(candidate.id)) next.delete(candidate.id); else next.set(candidate.id, new Set(candidate.foundIn.map(found => found.harnessId))); return next; })}/>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5"><strong className="font-medium">{candidate.name}</strong>
              <Badge tone={candidate.problem ? "neutral" : candidate.state === "new" ? "accent" : "neutral"}>{candidate.problem ? "不能导入" : candidate.state === "new" ? "可导入" : candidate.state === "listed" ? "已在清单" : "清单里的定义不同"}</Badge>
              {candidate.definition ? <code className="min-w-0 text-caption break-all text-fg-2">{summary(candidate.definition, candidate.definition.command === null ? null : [candidate.definition.command, ...candidate.definition.args].join(" "))}</code> : null}</span>
            <span className="text-caption text-fg-3">在 {candidate.foundIn.map(found => name(found.harnessId)).join("、")}</span>
            {candidate.problem ? <span className="text-caption text-fg-2">{candidate.problem}</span> : null}
            {claims !== undefined ? <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">{candidate.foundIn.map(found => <label key={found.harnessId} className="flex items-center gap-1.5 text-caption text-fg-2">
              <input type="checkbox" className="size-3.5 accent-accent" checked={claims.has(found.harnessId)} onChange={() => setChosen(current => { const next = new Map(current), set = new Set(next.get(candidate.id) ?? []); if (set.has(found.harnessId)) set.delete(found.harnessId); else set.add(found.harnessId); next.set(candidate.id, set); return next; })}/>
              认领 {name(found.harnessId)} 里的这一项</label>)}</span> : null}
          </span></li>;
      })}</ul>}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={() => void run()}>{busy ? <Spinner size={13} label=""/> : <Download size={14}/>}导入所选（{chosen.size}）</button>
    </div>
  </Dialog>;
}

/**
 * HarnessHub's MCP list (ADR-045 §5): one place for the servers, written into each Harness the way it writes them. Each
 * write and removal goes through the usual confirmation; editing the list itself changes no Harness file.
 */
export function McpInventoryPanel({ api, harness, reload, onChange, onNotice }: { readonly api: GatewayApi; readonly harness: string | null; readonly reload: number; readonly onChange: (request: ChangeRequest) => void;
  readonly onNotice: (text: string, failed: boolean) => void }) {
  const [view, setView] = useState<McpInventoryView | null>(null), [problem, setProblem] = useState<string | null>(null), [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<{ readonly name: string | null; readonly definition: McpDefinitionView } | null>(null), [tick, setTick] = useState(0);
  useEffect(() => { const controller = new AbortController(); api.mcpInventory(controller.signal).then(next => { setView(next); setProblem(null); }, error => { if (!controller.signal.aborted) setProblem(errorMessage(error)); }); return () => controller.abort(); }, [api, reload, tick]);
  const columns = useMemo(() => view?.harnesses.filter(item => harness === null || item.harnessId === harness) ?? [], [view, harness]);
  const fresh = view?.candidates.filter(item => item.state === "new" && item.definition !== null).length ?? 0;
  const claim = (name: string, harnessId: string) => api.claimMcpServer(name, [harnessId]).then(() => { onNotice("已认领 " + name + "：它在这个 Harness 里由 HarnessHub 管理，文件没有改动。", false); setTick(value => value + 1); }, error => onNotice(errorMessage(error), true));
  const remove = (name: string) => api.removeMcpServer(name).then(() => { onNotice("已从清单删除 " + name + "。各 Harness 的配置没有改动。", false); setTick(value => value + 1); }, error => onNotice(errorMessage(error), true));
  return <section className="mcp-inventory card px-4 py-3.5 text-ui-sm" aria-label="MCP 统一清单">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 max-w-reading flex-col gap-0.5"><h3 className="m-0 text-ui font-semibold">MCP 统一清单</h3>
        <span className="text-caption text-fg-3">HarnessHub 保存一份服务器清单（不保存任何密钥值），按各 Harness 自己的写法写入它们的用户级配置。</span></div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-sm" disabled={view === null} onClick={() => setImporting(true)}><Download size={13}/>从现有配置导入{fresh ? "（" + fresh + "）" : ""}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ name: null, definition: EMPTY })}><Plus size={13}/>新建服务器</button>
      </div>
    </div>
    {problem ? <Notice tone="red" className="mt-3">{problem}</Notice> : null}
    {view === null ? problem ? null : <p className="m-0 mt-3 flex items-center gap-2 text-fg-2" role="status"><Spinner size={13} label=""/>正在读取清单</p>
      : view.servers.length === 0 ? <p className="m-0 mt-3 text-fg-3">清单是空的。可以从各 Harness 现有的配置导入，或新建一个。</p>
      : <div className="mt-3 overflow-x-auto"><table className="mcp-servers w-full border-collapse text-left">
        <thead><tr className="hairline-b"><th scope="col" className="min-w-[220px] py-2 pr-3 text-caption font-normal text-fg-3">服务器</th>
          {columns.map(item => <th key={item.harnessId} scope="col" className="min-w-[96px] px-2 py-2 text-caption font-normal text-fg-2" title={item.reason ?? undefined}>
            <span className="flex items-center gap-1.5"><BrandIcon brand={item.harnessId} name={item.name} size={16}/><span className="trunc">{item.name}</span></span></th>)}</tr></thead>
        <tbody>{view.servers.map(server => <tr key={server.name} className={cn("align-top [&+&]:hairline-t")}>
          <th scope="row" className="py-2.5 pr-3 font-normal"><span className="flex flex-col gap-1"><strong className="font-medium">{server.name}</strong>
            <code className="text-caption break-all text-fg-2">{summary(server.definition, server.command)}</code>
            {server.variables.length ? <span className="flex flex-wrap gap-1">{server.variables.map(variable => <Badge key={variable.name} tone={variable.set ? "accent" : "amber"} title={variable.set ? "HarnessHub 的环境里已设置" : "HarnessHub 的环境里未设置"}>{variable.name}{variable.set ? "" : " 未设置"}</Badge>)}</span> : null}
            <span className="-ml-2.5 flex gap-0.5"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ name: server.name, definition: server.definition })}><Pencil size={12}/>编辑</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void remove(server.name)}><Trash2 size={12}/>从清单删除</button></span></span></th>
          {columns.map(item => { const target = server.targets.find(entry => entry.harnessId === item.harnessId); return <td key={item.harnessId} className="px-2 py-2.5">{target ? <TargetCell api={api} server={server} target={target} harnessName={item.name} onChange={onChange} onClaim={(name, harnessId) => void claim(name, harnessId)}/> : null}</td>; })}
        </tr>)}</tbody></table></div>}
    {view ? <ImportDialog api={api} view={view} open={importing} onClose={() => setImporting(false)} onImported={count => { setImporting(false); onNotice("已导入 " + count + " 个服务器。各 Harness 的配置没有改动。", false); setTick(value => value + 1); }}/> : null}
    <ServerDialog api={api} editing={editing} onClose={() => setEditing(null)} onSaved={name => { setEditing(null); onNotice("已保存 " + name + " 到清单。要写入各 Harness，请在表格里逐个确认。", false); setTick(value => value + 1); }}/>
  </section>;
}
