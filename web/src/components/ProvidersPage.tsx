import { ChevronRight, Eye, EyeOff, KeyRound, Link2, Pencil, Plus, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ProviderProtocol, ProviderView, ProviderWriteInput } from "../../../src/contracts/provider.js";
import { protocolLabel, PROVIDER_PROTOCOLS } from "../api.js";
import { cn } from "../lib/cn.js";
import { Badge, EmptyState, Notice, Spinner, Tip } from "../ui/primitives.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import { PageShell } from "./PageShell.js";

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
  const add = <button type="button" className="btn btn-primary" onClick={() => props.onEdit("new")}><Plus size={15} aria-hidden="true"/>添加 Provider</button>;
  // With no connection yet the empty place offers the one way forward; the head offers it once there is a list.
  return <PageShell title="模型连接" titleId="providers-title" onMenu={props.onMenu} sidebarHidden={props.sidebarHidden} onExpandSidebar={props.onExpandSidebar} onBack={props.onChat}
    description="连接只存在本机，不改 Harness 自己的配置。" {...(props.providers.length ? { actions: add } : {})}>
    {props.error ? <Notice tone="red" onDismiss={props.onDismissError}>{props.error}</Notice> : null}
    {props.providers.length === 0 ? <EmptyState icon={<SlidersHorizontal size={22}/>} title="连接你的第一个模型服务" action={add}>填写服务地址和密钥，再添加要使用的模型。</EmptyState> : <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex h-[34px] min-w-[min(220px,100%)] flex-1 items-center gap-2 rounded-control bg-surface px-2.5 text-fg-3 shadow-[inset_0_0_0_1px_var(--border-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]">
          <Search size={15} aria-hidden="true"/><input className="min-w-0 flex-1 border-none bg-transparent text-ui-sm text-fg outline-none" type="search" aria-label="搜索 Providers" placeholder="搜索名称、地址或模型" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <span className="text-ui-sm text-fg-3">{props.providers.length} 个连接</span></div>
      <div className="flex flex-col gap-3">{providers.length === 0 ? <p className="m-0 text-ui-sm text-fg-2">没有匹配的 Provider。<button type="button" className="link-btn" onClick={() => setQuery("")}>清除搜索</button></p> : providers.map(provider => {
        const probe = props.probes[provider.id], currentProbe = probe?.revision === provider.revision ? probe : undefined;
        return <article key={provider.id} className={cn("card flex flex-col gap-3 p-4", !provider.enabled && "opacity-70")} aria-labelledby={"provider-" + provider.id}>
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5"><BrandIcon brand={providerBrand(provider.baseUrl)} name={provider.name} size={32}/>
            <div className="min-w-[min(180px,100%)] flex-1"><div className="flex flex-wrap items-center gap-2"><h2 id={"provider-" + provider.id} className="m-0 text-ui font-semibold">{provider.name}</h2>{!provider.enabled ? <Badge>已停用</Badge> : null}<span className="text-caption text-fg-3">配置版本 {provider.revision}</span></div>
              <div className="mono mt-0.5 trunc text-caption text-fg-2">{endpointLabel(provider.baseUrl)}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-caption text-fg-3"><span>{protocolLabel(provider.protocol)}</span><span>{provider.models.length} 个模型</span><span className="inline-flex items-center gap-1"><KeyRound size={12} aria-hidden="true"/>{provider.hasCredential ? "已配置密钥" : "未配置密钥"}</span></div></div>
            <div className="flex flex-none items-center gap-1"><button type="button" className="btn btn-sm" disabled={currentProbe?.status === "checking"} onClick={() => props.onProbe(provider)} aria-label={`测试 ${provider.name} 的模型目录`}>{currentProbe?.status === "checking" ? <Spinner size={13} label=""/> : <Link2 size={13} aria-hidden="true"/>}测试连接</button>
              <Tip label="编辑"><button type="button" className="icon-btn" aria-label={`编辑 ${provider.name}`} onClick={() => props.onEdit(provider)}><Pencil size={15}/></button></Tip></div></div>
          {currentProbe ? <div className="text-ui-sm" role="status">{currentProbe.status === "checking" ? <span className="text-fg-3">正在读取模型目录…</span> : currentProbe.status === "failed" ? <span className="text-red">{currentProbe.message}</span>
            : <details className="group"><summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-accent-text [&::-webkit-details-marker]:hidden"><ShieldCheck size={13} aria-hidden="true"/>模型目录可达 · 返回 {currentProbe.models.length} 个模型 <ChevronRight size={13} className="motion-rotate group-open:rotate-90" aria-hidden="true"/></summary>
              <p className="m-0 my-1.5 text-fg-3">只测了模型目录。</p><div className="flex flex-wrap gap-1.5">{currentProbe.models.map(model => <Badge key={model} className="mono font-normal">{model}</Badge>)}</div></details>}</div> : null}
        </article>;
      })}</div>
      <p className="m-0 flex items-center gap-2 text-ui-sm text-fg-3"><ShieldCheck size={14} aria-hidden="true"/>密钥只存在本机。</p>
    </>}
  </PageShell>;
}
/** A group of the editor's fields: a card with its visible heading; the fieldset gives assistive technology the same name. */
function FieldGroup({ title, disabled, children }: { readonly title: string; readonly disabled: boolean; readonly children: ReactNode }) {
  return <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0"><legend className="sr-only">{title}</legend>
    <div className="card flex flex-col gap-4 p-4"><h2 className="m-0 text-ui font-semibold" aria-hidden="true">{title}</h2>{children}</div></fieldset>;
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
  const field = "flex min-w-0 flex-col gap-1.5";
  return <PageShell title={current ? "编辑连接" : "添加连接"} titleId="editor-title" onMenu={props.onMenu} sidebarHidden={props.sidebarHidden} onExpandSidebar={props.onExpandSidebar} onBack={props.onBack} backLabel="返回 Provider 列表"
    description={current ? `修改「${current.name}」的地址、密钥和模型。已有对话仍按原来的配置版本调用。` : "填写连接信息和模型 ID，配置保存在本机。"}
    actions={<><span className="hidden text-caption text-fg-3 sm:inline">{dirty ? "未保存" : current ? `配置版本 ${current.revision}` : "新的 Provider"}</span><button type="button" className="btn" onClick={props.onBack} disabled={props.saving}>取消</button>
      <button type="submit" form="provider-editor-form" className="btn btn-primary" disabled={props.saving}>{props.saving ? <Spinner size={13} label="" className="text-on-accent"/> : <Plus size={14} aria-hidden="true"/>}{current ? "保存修改" : "添加 Provider"}</button></>}>
    {!current ? <div className="flex flex-wrap gap-2" role="group" aria-label="常用服务">{[{ label: "OpenAI", icon: <BrandIcon brand="openai" name="OpenAI" size={20}/>, pick: () => { setProtocol("openai-responses"); setBaseUrl("https://api.openai.com/v1"); }, on: protocol === "openai-responses" && baseUrl === "https://api.openai.com/v1" },
      { label: "Gemini", icon: <BrandIcon brand="gemini" name="Gemini" size={20}/>, pick: () => { setProtocol("gemini"); setBaseUrl("https://generativelanguage.googleapis.com"); }, on: protocol === "gemini" },
      { label: "自定义连接", icon: <SlidersHorizontal size={18} className="text-fg-2" aria-hidden="true"/>, pick: () => { setProtocol("openai-responses"); setBaseUrl(""); }, on: false }].map(preset =>
      <button key={preset.label} type="button" onClick={preset.pick} aria-pressed={preset.on} data-selected={preset.on ? "true" : undefined} className="card card-interactive press flex h-11 items-center gap-2 px-3.5 text-ui-sm font-medium text-fg">{preset.icon}{preset.label}</button>)}</div> : null}
    {validation || props.error ? <Notice tone="red" onDismiss={() => { setValidation(null); props.onDismissError(); }}>{validation ?? props.error ?? ""}</Notice> : null}
    <form className="flex flex-col gap-4" id="provider-editor-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FieldGroup title="连接信息" disabled={props.saving}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className={field}><span className="label m-0">名称</span><input className="field" aria-label="名称" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的模型服务" required maxLength={128}/></label>
          <label className={field}><span className="label m-0">API 协议</span><select className="field" aria-label="API 协议" value={protocol} onChange={event => { const value = PROVIDER_PROTOCOLS.find(item => item === event.target.value); if (value) setProtocol(value); }}>{PROVIDER_PROTOCOLS.map(value => <option key={value} value={value}>{protocolLabel(value)}</option>)}</select></label>
        </div>
        <label className={field}><span className="label m-0">Base URL</span><input className="field mono" aria-label="Base URL" aria-describedby="provider-url-hint" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={protocol === "gemini" ? "https://generativelanguage.googleapis.com" : "https://your-api.example/v1"} required autoComplete="off" spellCheck={false}/>
          <small id="provider-url-hint" className="text-caption text-fg-3">{protocol === "gemini" ? "服务根地址，如 https://generativelanguage.googleapis.com" : "API 地址，常以 /v1 结尾"}</small></label>
        <label className={field}><span className="label m-0">API Key <em className="font-normal not-italic text-fg-3">{protocol === "gemini" ? "必填" : "可选"}</em></span>
          <span className="flex items-center gap-1"><input className="field mono" aria-label="API Key" aria-describedby="provider-key-hint" type={showKey ? "text" : "password"} value={apiKey} onChange={event => setApiKey(event.target.value)} required={protocol === "gemini" && !current?.hasCredential} placeholder={current?.hasCredential ? "已保存密钥，留空保留" : protocol === "gemini" ? "填入 Gemini API Key" : "填入密钥；无认证的本地服务可留空"} autoComplete="new-password" spellCheck={false}/>
            <button type="button" className="icon-btn" onClick={() => setShowKey(value => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"} aria-pressed={showKey}>{showKey ? <EyeOff size={16}/> : <Eye size={16}/>}</button></span>
          <small id="provider-key-hint" className="text-caption text-fg-3">{current?.hasCredential ? "不会读取或显示已有密钥。填写新值会替换密钥，留空保留。" : protocol === "gemini" ? "需要密钥，只存在本机。" : "密钥只写入本机连接配置，不保存在浏览器里。"}</small></label>
      </FieldGroup>
      <FieldGroup title="可用模型" disabled={props.saving}>
        <div className="-mt-2 flex flex-wrap items-center justify-between gap-2"><p className="m-0 text-ui-sm text-fg-2">每行一个模型 ID。</p>{current ? <button type="button" className="btn btn-sm" disabled={dirty || currentProbe?.status === "checking"} onClick={() => props.onProbe(current)} title={dirty ? "先保存修改，再读取这个连接的模型目录" : undefined}>{currentProbe?.status === "checking" ? <Spinner size={13} label=""/> : <Link2 size={13} aria-hidden="true"/>}读取模型目录</button> : null}</div>
        {currentProbe?.status === "reachable" ? <div className="flex flex-wrap items-center gap-2 text-ui-sm text-fg-2" role="status"><span>模型目录可达，返回 {currentProbe.models.length} 个 ID。</span><button type="button" className="link-btn" disabled={currentProbe.models.length === 0} onClick={() => setModelsText(currentProbe.models.join("\n"))}>填入返回的模型</button></div> : currentProbe?.status === "failed" ? <Notice tone="red">{currentProbe.message ?? "无法读取模型目录"}</Notice> : null}
        <label className={field}><span className="sr-only">模型 ID 列表</span><textarea className="field mono" aria-label="模型 ID 列表" value={modelsText} onChange={event => setModelsText(event.target.value)} placeholder={"model-id-1\nmodel-id-2"} rows={4} required spellCheck={false}/></label>
        <label className={cn(field, "sm:max-w-sm")}><span className="label m-0">默认模型</span><select className="field" aria-label="默认模型" value={defaultModel} onChange={event => setDefaultModel(event.target.value)} required><option value="">选择默认模型</option>{defaultModel && !models.includes(defaultModel) ? <option value={defaultModel}>{defaultModel} · 不在列表中</option> : null}{models.map(model => <option value={model} key={model}>{model}</option>)}</select></label>
      </FieldGroup>
      <label className="card flex cursor-pointer items-start gap-3 p-4"><input type="checkbox" className="mt-0.5 h-4 w-4 flex-none accent-[var(--accent)]" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={props.saving} aria-label="启用这个 Provider"/>
        <span className="min-w-0"><strong className="block text-ui font-medium">启用这个 Provider</strong><small className="text-ui-sm text-fg-2">允许在新的会话选择中使用。已固定版本的执行保持原配置。</small></span></label>
    </form>
    <p className="m-0 flex items-center gap-2 text-ui-sm text-fg-3"><ShieldCheck size={14} aria-hidden="true"/>密钥保存在本机，已有配置不会回显。</p>
  </PageShell>;
}
