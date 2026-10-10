import { ArrowLeft, ChevronRight, Eye, EyeOff, KeyRound, Link2, Pencil, Plus, Search, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderProtocol, ProviderView, ProviderWriteInput } from "../../../src/contracts/provider.js";
import { protocolLabel, PROVIDER_PROTOCOLS } from "../api.js";
import { EmptyState, endpointLabel, ErrorNotice, Spinner, StatusBadge } from "./common.js";
import { MobileMenu } from "./Sidebar.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";

export interface ProviderProbeState { revision: number; status: "checking" | "reachable" | "failed"; models: readonly string[]; message: string | null }
interface ProvidersProps {
  providers: readonly ProviderView[]; editor: ProviderView | "new" | null; saving: boolean; probes: Readonly<Record<string, ProviderProbeState>>;
  error: string | null; onEdit: (provider: ProviderView | "new") => void; onBack: () => void; onSave: (input: ProviderWriteInput, provider?: ProviderView) => Promise<void>;
  onProbe: (provider: ProviderView) => void; onDirty: (dirty: boolean) => void; onDismissError: () => void; onMenu: () => void;
}
export function ProvidersPage(props: ProvidersProps) {
  const [query, setQuery] = useState("");
  const providers = props.providers.filter(provider => `${provider.name} ${provider.baseUrl} ${provider.models.join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (props.editor !== null) return <ProviderEditor key={props.editor === "new" ? "new" : props.editor.id} {...props} current={props.editor === "new" ? undefined : props.editor}/>;
  return <section className="management-page" aria-labelledby="providers-title"><header className="management-header"><MobileMenu onClick={props.onMenu}/><div className="page-breadcrumb"><SlidersHorizontal size={18}/><span>工作空间</span><ChevronRight size={14}/><strong>Providers</strong></div><button className="button primary" onClick={() => props.onEdit("new")}><Plus size={16} aria-hidden="true"/>添加 Provider</button></header>
    <div className="management-body"><div className="management-title-row"><div><h1 id="providers-title">模型连接</h1><p>一个连接，一组模型。在兼容的 Harness 中独立选择。</p></div><span className="content-count">{props.providers.length} 个 Provider</span></div>
      {props.error ? <ErrorNotice message={props.error} onDismiss={props.onDismissError}/> : null}
      {props.providers.length === 0 ? <EmptyState icon={<SlidersHorizontal size={28}/>} title="连接你的第一个模型服务" action={<button className="button primary" onClick={() => props.onEdit("new")}><Plus size={16}/>添加 Provider</button>}>填写服务地址和密钥，再添加要使用的模型。连接保存在本机，不修改 Harness 的全局配置。</EmptyState> : <><div className="list-toolbar"><label className="search-field"><Search size={15} aria-hidden="true"/><input aria-label="搜索 Providers" placeholder="搜索名称、地址或模型" value={query} onChange={event => setQuery(event.target.value)}/></label><span>{props.providers.length} 个连接</span></div>
        <div className="provider-list">{providers.length === 0 ? <div className="no-search-results">没有匹配的 Provider。<button className="text-button" onClick={() => setQuery("")}>清除搜索</button></div> : providers.map(provider => {
          const probe = props.probes[provider.id];
          const currentProbe = probe?.revision === provider.revision ? probe : undefined;
          return <article className={`provider-row ${!provider.enabled ? "disabled-provider" : ""}`} key={provider.id}><div className="provider-avatar" aria-hidden="true"><BrandIcon brand={providerBrand(provider.baseUrl)} name={provider.name} size={30}/></div><div className="provider-main"><div className="provider-title"><h2>{provider.name}</h2>{!provider.enabled ? <StatusBadge>已停用</StatusBadge> : null}<span className="revision-label">v{provider.revision}</span></div><div className="provider-address">{endpointLabel(provider.baseUrl)}</div><div className="provider-detail"><span>{protocolLabel(provider.protocol)}</span><span>{provider.models.length} 个模型</span><span><KeyRound size={12} aria-hidden="true"/>{provider.hasCredential ? "已配置密钥" : "未配置密钥"}</span></div><div className="provider-model-preview">{provider.models.slice(0, 3).map(model => <span key={model}>{model}</span>)}{provider.models.length > 3 ? <small>+{provider.models.length - 3}</small> : null}</div></div>
            <div className="provider-row-actions"><button className="button subtle test-button" disabled={currentProbe?.status === "checking"} onClick={() => props.onProbe(provider)} aria-label={`测试 ${provider.name} 的模型目录`}>{currentProbe?.status === "checking" ? <Spinner/> : <Link2 size={14} aria-hidden="true"/>}测试连接</button><button className="icon-button" title="编辑 Provider" aria-label={`编辑 ${provider.name}`} onClick={() => props.onEdit(provider)}><Pencil size={16}/></button></div>
            {currentProbe ? <div className={`provider-probe ${currentProbe.status}`} role="status">{currentProbe.status === "checking" ? "正在读取模型目录…" : currentProbe.status === "failed" ? currentProbe.message : <details><summary><ShieldCheck size={13} aria-hidden="true"/>模型目录可达 · 返回 {currentProbe.models.length} 个模型 <ChevronRight size={13}/></summary><p>这项测试验证模型目录接口，实际对话仍需在会话中验证。</p><div className="model-tags">{currentProbe.models.map(model => <span key={model}>{model}</span>)}</div></details>}</div> : null}
          </article>;
        })}</div><div className="management-footnote"><ShieldCheck size={15} aria-hidden="true"/><span>密钥仅保存在本机。对话固定引用 Provider 的配置版本，编辑不会改写已有调用。</span></div></>}
    </div>
  </section>;
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
  return <section className="management-page editor-page" aria-labelledby="editor-title"><header className="management-header"><MobileMenu onClick={props.onMenu}/><button className="icon-button back-button" onClick={props.onBack} aria-label="返回 Provider 列表"><ArrowLeft size={20}/></button><div className="page-breadcrumb editor-breadcrumb"><span>Providers</span><ChevronRight size={14} aria-hidden="true"/><h1 id="editor-title">{current ? "编辑连接" : "添加连接"}</h1></div><span className="editor-header-status">{dirty ? "未保存" : current ? `配置 v${current.revision}` : "新的 Provider"}</span></header>
    <div className="management-body editor-body"><div className="editor-intro"><h2>{current?.name ?? "配置你的模型服务"}</h2><p>填写连接信息和模型 ID，配置在本机保存。</p></div>
      {!current ? <div className="provider-presets"><button type="button" className={protocol === "openai-responses" && baseUrl === "https://api.openai.com/v1" ? "selected" : ""} onClick={() => { setProtocol("openai-responses"); setBaseUrl("https://api.openai.com/v1"); }}><BrandIcon brand="openai" name="OpenAI" size={22}/><span>OpenAI</span></button><button type="button" className={protocol === "gemini" ? "selected" : ""} onClick={() => { setProtocol("gemini"); setBaseUrl("https://generativelanguage.googleapis.com"); }}><BrandIcon brand="gemini" name="Gemini" size={23}/><span>Gemini</span></button><button type="button" onClick={() => { setProtocol("openai-responses"); setBaseUrl(""); }}><SlidersHorizontal size={20}/><span>自定义连接</span></button></div> : null}
      {validation || props.error ? <ErrorNotice message={validation ?? props.error ?? ""} onDismiss={() => { setValidation(null); props.onDismissError(); }}/>: null}
      <form className="provider-form" id="provider-editor-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={props.saving}><legend>连接信息</legend><div className="form-grid"><label className="form-field"><span>名称</span><input aria-label="名称" autoFocus value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的模型服务" required maxLength={128}/></label><label className="form-field"><span>API 协议</span><select aria-label="API 协议" value={protocol} onChange={event => { const value = PROVIDER_PROTOCOLS.find(item => item === event.target.value); if (value) setProtocol(value); }}>{PROVIDER_PROTOCOLS.map(value => <option key={value} value={value}>{protocolLabel(value)}</option>)}</select></label>
          <label className="form-field full-width"><span>Base URL</span><input aria-label="Base URL" aria-describedby="provider-url-hint" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={protocol === "gemini" ? "https://generativelanguage.googleapis.com" : "https://your-api.example/v1"} required autoComplete="off" spellCheck={false}/><small id="provider-url-hint">{protocol === "gemini" ? "填写服务根地址，例如 https://generativelanguage.googleapis.com，不添加 /v1beta 或 /models。" : "填写模型服务提供的 API 地址，常见格式以 /v1 结尾，也可使用本机服务。"}</small></label>
          <label className="form-field full-width"><span>API Key <em>{protocol === "gemini" ? "必填" : "可选"}</em></span><div className="password-field"><input aria-label="API Key" aria-describedby="provider-key-hint" type={showKey ? "text" : "password"} value={apiKey} onChange={event => setApiKey(event.target.value)} required={protocol === "gemini" && !current?.hasCredential} placeholder={current?.hasCredential ? "已保存密钥，留空保留" : protocol === "gemini" ? "填入 Gemini API Key" : "填入密钥；无认证的本地服务可留空"} autoComplete="new-password" spellCheck={false}/><button type="button" className="icon-button" onClick={() => setShowKey(value => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div><small id="provider-key-hint">{current?.hasCredential ? "不会读取或显示已有密钥。填写新值会替换密钥，留空保留。" : protocol === "gemini" ? "Gemini 受管连接需要密钥；密钥仅保存在本机，不写入浏览器存储。" : "密钥仅写入本机连接配置，不保存在浏览器中。"}</small></label>
        </div></fieldset>
        <fieldset disabled={props.saving}><legend>可用模型</legend><div className="models-field-header"><p>使用服务提供的模型 ID，每行一个。</p>{current ? <button type="button" className="button subtle" disabled={dirty || currentProbe?.status === "checking"} onClick={() => props.onProbe(current)} title={dirty ? "先保存修改，再读取这个连接的模型目录" : undefined}>{currentProbe?.status === "checking" ? <Spinner/> : <Link2 size={14}/>}读取模型目录</button> : null}</div>
          {currentProbe?.status === "reachable" ? <div className="editor-probe" role="status"><span>模型目录可达，返回 {currentProbe.models.length} 个 ID。</span><button type="button" className="text-button" disabled={currentProbe.models.length === 0} onClick={() => setModelsText(currentProbe.models.join("\n"))}>填入返回的模型</button></div> : currentProbe?.status === "failed" ? <ErrorNotice message={currentProbe.message ?? "无法读取模型目录"}/> : null}
          <label className="form-field"><span className="sr-only">模型 ID 列表</span><textarea aria-label="模型 ID 列表" className="models-textarea" value={modelsText} onChange={event => setModelsText(event.target.value)} placeholder={"model-id-1\nmodel-id-2"} rows={4} required spellCheck={false}/></label><label className="form-field default-model-field"><span>默认模型</span><select aria-label="默认模型" value={defaultModel} onChange={event => setDefaultModel(event.target.value)} required><option value="">选择默认模型</option>{defaultModel && !models.includes(defaultModel) ? <option value={defaultModel}>{defaultModel} · 不在列表中</option> : null}{models.map(model => <option value={model} key={model}>{model}</option>)}</select></label>
        </fieldset>
        <label className="enabled-toggle"><span className={`toggle-track ${enabled ? "on" : ""}`}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={props.saving} aria-label="启用这个 Provider"/><span/></span><div><strong>启用这个 Provider</strong><small>允许在新的会话选择中使用。已固定版本的执行保持原配置。</small></div></label>
      </form>
    </div>
    <footer className="editor-footer"><span><ShieldCheck size={15}/>密钥保存在本机，已有配置不会回显。</span><button type="button" className="button secondary" onClick={props.onBack} disabled={props.saving}>取消</button><button type="submit" form="provider-editor-form" className="button primary" disabled={props.saving}>{props.saving ? <Spinner/> : <Plus size={15}/>} {current ? "保存修改" : "添加 Provider"}</button></footer>
  </section>;
}
