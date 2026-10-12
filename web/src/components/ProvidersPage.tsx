import { ChevronRight, Eye, EyeOff, KeyRound, Link2, Pencil, Plus, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderProtocol, ProviderView, ProviderWriteInput } from "../../../src/contracts/provider.js";
import { protocolLabel, PROVIDER_PROTOCOLS } from "../api.js";
import { cn } from "../lib/cn.js";
import { Badge, EmptyState, Notice, Spinner } from "../ui/primitives.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import { Card, PageShell } from "./PageShell.js";

export interface ProviderProbeState { revision: number; status: "checking" | "reachable" | "failed"; models: readonly string[]; message: string | null }
interface ProvidersProps {
  providers: readonly ProviderView[]; editor: ProviderView | "new" | null; saving: boolean; probes: Readonly<Record<string, ProviderProbeState>>;
  error: string | null; onEdit: (provider: ProviderView | "new") => void; onBack: () => void; onSave: (input: ProviderWriteInput, provider?: ProviderView) => Promise<void>;
  onProbe: (provider: ProviderView) => void; onDirty: (dirty: boolean) => void; onDismissError: () => void; onMenu: () => void;
  sidebarHidden: boolean; onExpandSidebar: () => void; onChat: () => void;
}
function endpointLabel(url: string): string { try { const value = new URL(url); return value.host + (value.pathname === "/" ? "" : value.pathname); } catch { return url; } }

/** Unified model connections (deferred product area; shown only where the Gateway enables Provider management). */
export function ProvidersPage(props: ProvidersProps) {
  const [query, setQuery] = useState("");
  const providers = props.providers.filter(provider => `${provider.name} ${provider.baseUrl} ${provider.models.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (props.editor !== null) return <ProviderEditor key={props.editor === "new" ? "new" : props.editor.id} {...props} current={props.editor === "new" ? undefined : props.editor}/>;
  return <PageShell title="模型连接" titleId="providers-title" onMenu={props.onMenu} sidebarHidden={props.sidebarHidden} onExpandSidebar={props.onExpandSidebar} onBack={props.onChat}
    description="一个连接，一组模型。在兼容的 Harness 中独立选择。" actions={<button className="btn btn-primary" onClick={() => props.onEdit("new")}><Plus size={15} aria-hidden="true"/>添加 Provider</button>}>
    {props.error ? <Notice tone="red" onDismiss={props.onDismissError}>{props.error}</Notice> : null}
    {props.providers.length === 0 ? <EmptyState icon={<SlidersHorizontal size={22}/>} title="连接你的第一个模型服务" action={<button className="btn btn-primary" onClick={() => props.onEdit("new")}><Plus size={15}/>添加 Provider</button>}>填写服务地址和密钥，再添加要使用的模型。连接保存在本机，不修改 Harness 的全局配置。</EmptyState> : <>
      <div className="flex items-center gap-3"><label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3"><Search size={15} className="text-fg-3" aria-hidden="true"/><input className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] outline-none" aria-label="搜索 Providers" placeholder="搜索名称、地址或模型" value={query} onChange={event => setQuery(event.target.value)}/></label><span className="text-[12.5px] text-fg-3">{props.providers.length} 个连接</span></div>
      <div className="flex flex-col gap-2.5">{providers.length === 0 ? <p className="m-0 text-[13px] text-fg-2">没有匹配的 Provider。<button className="link-btn" onClick={() => setQuery("")}>清除搜索</button></p> : providers.map(provider => {
        const probe = props.probes[provider.id], currentProbe = probe?.revision === provider.revision ? probe : undefined;
        return <Card key={provider.id} className={cn("flex flex-col gap-3 p-4", !provider.enabled && "opacity-70")}>
          <div className="flex items-start gap-3"><BrandIcon brand={providerBrand(provider.baseUrl)} name={provider.name} size={30}/>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="m-0 text-[14px] font-semibold">{provider.name}</h2>{!provider.enabled ? <Badge>已停用</Badge> : null}<span className="text-[12px] text-fg-3">v{provider.revision}</span></div>
              <div className="mono mt-0.5 truncate text-[12px] text-fg-2">{endpointLabel(provider.baseUrl)}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-3"><span>{protocolLabel(provider.protocol)}</span><span>{provider.models.length} 个模型</span><span className="inline-flex items-center gap-1"><KeyRound size={12} aria-hidden="true"/>{provider.hasCredential ? "已配置密钥" : "未配置密钥"}</span></div></div>
            <div className="flex flex-none items-center gap-1"><button className="btn btn-sm" disabled={currentProbe?.status === "checking"} onClick={() => props.onProbe(provider)} aria-label={`测试 ${provider.name} 的模型目录`}>{currentProbe?.status === "checking" ? <Spinner size={13}/> : <Link2 size={13} aria-hidden="true"/>}测试连接</button>
              <button className="icon-btn" aria-label={`编辑 ${provider.name}`} onClick={() => props.onEdit(provider)}><Pencil size={15}/></button></div></div>
          {currentProbe ? <div className="text-[12.5px]" role="status">{currentProbe.status === "checking" ? <span className="text-fg-3">正在读取模型目录…</span> : currentProbe.status === "failed" ? <span className="text-red">{currentProbe.message}</span>
            : <details><summary className="inline-flex cursor-pointer items-center gap-1.5 text-green"><ShieldCheck size={13} aria-hidden="true"/>模型目录可达 · 返回 {currentProbe.models.length} 个模型 <ChevronRight size={13}/></summary><p className="m-0 my-1.5 text-fg-3">这项测试验证模型目录接口，实际对话仍需在会话中验证。</p><div className="flex flex-wrap gap-1.5">{currentProbe.models.map(model => <span key={model} className="badge mono">{model}</span>)}</div></details>}</div> : null}
        </Card>;
      })}</div>
      <p className="m-0 flex items-center gap-2 text-[12.5px] text-fg-3"><ShieldCheck size={14} aria-hidden="true"/>密钥仅保存在本机。对话固定引用 Provider 的配置版本，编辑不会改写已有调用。</p>
    </>}
  </PageShell>;
}
function ProviderEditor(props: ProvidersProps & { current: ProviderView | undefined }) {
  const { current } = props;
  const [name, setName] = useState(current?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(current?.protocol ?? "openai-responses");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState(current?.models.join("\n") ?? "");
  const [defaultModel, setDefaultModel] = useState(current?.defaultModel ?? "");
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [showKey, setShowKey] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const models = [...new Set(modelsText.split(/[\n,]/u).map(value => value.trim()).filter(Boolean))];
  const dirty = Boolean(apiKey) || name !== (current?.name ?? "") || protocol !== (current?.protocol ?? "openai-responses") || baseUrl !== (current?.baseUrl ?? "") || modelsText !== (current?.models.join("\n") ?? "") || defaultModel !== (current?.defaultModel ?? "") || enabled !== (current?.enabled ?? true);
  const probe = current ? props.probes[current.id] : undefined;
  const currentProbe = probe?.revision === current?.revision ? probe : undefined;
  useEffect(() => { props.onDirty(dirty); return () => props.onDirty(false); }, [dirty, props.onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const save = async () => {
    setValidation(null);
    if (!name.trim()) { setValidation("请为这个连接填写名称。"); return; }
    try { const url = new URL(baseUrl); if (!["http:", "https:"].includes(url.protocol)) throw new Error(); }
    catch { setValidation("请填写完整的 http:// 或 https:// 服务地址。"); return; }
    if (!models.length) { setValidation("至少添加一个模型 ID。"); return; }
    if (protocol === "gemini" && !current?.hasCredential && !apiKey) { setValidation("Gemini 连接必须填写 API Key。"); return; }
    if (!models.includes(defaultModel.trim())) { setValidation("默认模型必须是模型列表中的一个 ID。"); return; }
    try { await props.onSave({ name: name.trim(), protocol, baseUrl: baseUrl.trim(), models, defaultModel: defaultModel.trim(), enabled, ...(apiKey ? { apiKey } : {}) }, current); setApiKey(""); }
    catch { /* Parent displays the request error and preserves unsaved fields. */ }
  };
  const field = "flex flex-col gap-1.5";
  return <PageShell title={current ? "编辑连接" : "添加连接"} titleId="editor-title" onMenu={props.onMenu} sidebarHidden={props.sidebarHidden} onExpandSidebar={props.onExpandSidebar} onBack={props.onBack} backLabel="返回 Provider 列表"
    actions={<><span className="hidden text-[12px] text-fg-3 sm:inline">{dirty ? "未保存" : current ? `配置 v${current.revision}` : "新的 Provider"}</span><button type="button" className="btn" onClick={props.onBack} disabled={props.saving}>取消</button>
      <button type="submit" form="provider-editor-form" className="btn btn-primary" disabled={props.saving}>{props.saving ? <Spinner size={13}/> : <Plus size={14}/>} {current ? "保存修改" : "添加 Provider"}</button></>}>
    <div><h2 className="m-0 text-[17px] font-semibold">{current?.name ?? "配置你的模型服务"}</h2><p className="m-0 mt-1 text-[13px] text-fg-2">填写连接信息和模型 ID，配置在本机保存。</p></div>
    {!current ? <div className="flex flex-wrap gap-2">{[{ label: "OpenAI", icon: <BrandIcon brand="openai" name="OpenAI" size={20}/>, pick: () => { setProtocol("openai-responses"); setBaseUrl("https://api.openai.com/v1"); }, on: protocol === "openai-responses" && baseUrl === "https://api.openai.com/v1" },
      { label: "Gemini", icon: <BrandIcon brand="gemini" name="Gemini" size={20}/>, pick: () => { setProtocol("gemini"); setBaseUrl("https://generativelanguage.googleapis.com"); }, on: protocol === "gemini" },
      { label: "自定义连接", icon: <SlidersHorizontal size={18}/>, pick: () => { setProtocol("openai-responses"); setBaseUrl(""); }, on: false }].map(preset =>
      <button key={preset.label} type="button" onClick={preset.pick} className={cn("flex h-11 items-center gap-2 rounded-xl border bg-surface px-3.5 text-[13px] font-medium shadow-sm hover:bg-hover", preset.on ? "border-accent ring-2 ring-accent-soft" : "border-line")}>{preset.icon}{preset.label}</button>)}</div> : null}
    {validation || props.error ? <Notice tone="red" onDismiss={() => { setValidation(null); props.onDismissError(); }}>{validation ?? props.error ?? ""}</Notice> : null}
    <form className="flex flex-col gap-5" id="provider-editor-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={props.saving} className="m-0 flex flex-col gap-4 rounded-xl border border-line bg-surface p-4"><legend className="px-1 text-[13px] font-semibold">连接信息</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={field}><span className="label m-0">名称</span><input className="field" aria-label="名称" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的模型服务" required maxLength={128}/></label>
          <label className={field}><span className="label m-0">API 协议</span><select className="field" aria-label="API 协议" value={protocol} onChange={event => { const value = PROVIDER_PROTOCOLS.find(item => item === event.target.value); if (value) setProtocol(value); }}>{PROVIDER_PROTOCOLS.map(value => <option key={value} value={value}>{protocolLabel(value)}</option>)}</select></label>
        </div>
        <label className={field}><span className="label m-0">Base URL</span><input className="field mono" aria-label="Base URL" aria-describedby="provider-url-hint" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={protocol === "gemini" ? "https://generativelanguage.googleapis.com" : "https://your-api.example/v1"} required autoComplete="off" spellCheck={false}/>
          <small id="provider-url-hint" className="text-[12px] text-fg-3">{protocol === "gemini" ? "填写服务根地址，例如 https://generativelanguage.googleapis.com，不添加 /v1beta 或 /models。" : "填写模型服务提供的 API 地址，常见格式以 /v1 结尾，也可使用本机服务。"}</small></label>
        <label className={field}><span className="label m-0">API Key <em className="not-italic text-fg-3">{protocol === "gemini" ? "必填" : "可选"}</em></span>
          <div className="flex items-center gap-1"><input className="field mono" aria-label="API Key" aria-describedby="provider-key-hint" type={showKey ? "text" : "password"} value={apiKey} onChange={event => setApiKey(event.target.value)} required={protocol === "gemini" && !current?.hasCredential} placeholder={current?.hasCredential ? "已保存密钥，留空保留" : protocol === "gemini" ? "填入 Gemini API Key" : "填入密钥；无认证的本地服务可留空"} autoComplete="new-password" spellCheck={false}/>
            <button type="button" className="icon-btn" onClick={() => setShowKey(value => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div>
          <small id="provider-key-hint" className="text-[12px] text-fg-3">{current?.hasCredential ? "不会读取或显示已有密钥。填写新值会替换密钥，留空保留。" : protocol === "gemini" ? "Gemini 受管连接需要密钥；密钥仅保存在本机，不写入浏览器存储。" : "密钥仅写入本机连接配置，不保存在浏览器中。"}</small></label>
      </fieldset>
      <fieldset disabled={props.saving} className="m-0 flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"><legend className="px-1 text-[13px] font-semibold">可用模型</legend>
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="m-0 text-[12.5px] text-fg-2">使用服务提供的模型 ID，每行一个。</p>{current ? <button type="button" className="btn btn-sm" disabled={dirty || currentProbe?.status === "checking"} onClick={() => props.onProbe(current)} title={dirty ? "先保存修改，再读取这个连接的模型目录" : undefined}>{currentProbe?.status === "checking" ? <Spinner size={13}/> : <Link2 size={13}/>}读取模型目录</button> : null}</div>
        {currentProbe?.status === "reachable" ? <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2" role="status"><span>模型目录可达，返回 {currentProbe.models.length} 个 ID。</span><button type="button" className="link-btn" disabled={currentProbe.models.length === 0} onClick={() => setModelsText(currentProbe.models.join("\n"))}>填入返回的模型</button></div> : currentProbe?.status === "failed" ? <Notice tone="red">{currentProbe.message ?? "无法读取模型目录"}</Notice> : null}
        <label className={field}><span className="sr-only">模型 ID 列表</span><textarea className="field mono" aria-label="模型 ID 列表" value={modelsText} onChange={event => setModelsText(event.target.value)} placeholder={"model-id-1\nmodel-id-2"} rows={4} required spellCheck={false}/></label>
        <label className={cn(field, "sm:max-w-sm")}><span className="label m-0">默认模型</span><select className="field" aria-label="默认模型" value={defaultModel} onChange={event => setDefaultModel(event.target.value)} required><option value="">选择默认模型</option>{defaultModel && !models.includes(defaultModel) ? <option value={defaultModel}>{defaultModel} · 不在列表中</option> : null}{models.map(model => <option value={model} key={model}>{model}</option>)}</select></label>
      </fieldset>
      <label className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={props.saving} aria-label="启用这个 Provider"/>
        <div><strong className="block text-[13.5px] font-medium">启用这个 Provider</strong><small className="text-[12.5px] text-fg-2">允许在新的会话选择中使用。已固定版本的执行保持原配置。</small></div></label>
    </form>
    <p className="m-0 flex items-center gap-2 text-[12.5px] text-fg-3"><ShieldCheck size={14}/>密钥保存在本机，已有配置不会回显。</p>
  </PageShell>;
}
