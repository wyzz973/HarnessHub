import * as Popover from "@radix-ui/react-popover";
import { ArrowRight, ArrowUp, Paperclip, RefreshCw, SlidersHorizontal, Square, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import { protocolLabel } from "../api.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import { BrandMark, Spinner } from "./common.js";
import { SearchPicker } from "./SearchPicker.js";
import type { PickerOption } from "./SearchPicker.js";
import type { ChatProps } from "./ChatPage.js";
import { attachmentProblem, ComposerAttachments } from "./Attachments.js";
import { NativeExtensionsPanel } from "./NativeExtensions.js";

interface ComposerProps extends ChatProps {
  active: PublicRun | null;
  dirty: boolean;
  pending: boolean;
  problem: string | null;
  blocked: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function ChatComposer(props: ComposerProps) {
  const { draft, harnesses, providers, session, active, dirty, pending, problem, blocked, inputRef } = props;
  const sending = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const bytes = new TextEncoder().encode(props.messageDraft).byteLength;
  const harness = harnesses.find(row => row.id === draft.harnessId);
  const provider = providers.find(row => row.id === draft.providerId);
  const controls = harness?.controls.filter(control => control.available) ?? [];
  const selectedControl = harness?.controls.find(control => control.id === draft.controlId);
  const readonly = session?.status === "closed";
  const disabled = props.mutation !== null && props.mutation !== "switching" || props.loading || props.sessionError !== null || readonly;
  // Native catalogs declare what the agent or selected model accepts; a managed Provider leaves the decision to the Harness.
  const inputs = draft.providerId ? undefined : props.nativeModels?.models.find(model => model.id === (draft.model || props.nativeModels?.defaultModel))?.inputs ?? props.nativeModels?.inputs;
  const uploading = props.attachments.some(item => item.status === "uploading");
  const attachmentBlocked = props.attachments.some(item => item.status !== "ready" || attachmentProblem(item, inputs) !== null);
  const disableSend = disabled || props.mutation !== null || pending || blocked || active !== null || dirty || problem !== null || !draft.providerId && props.nativeModels?.authentication === "missing" || bytes > 64 * 1024 || !props.messageDraft.trim() || attachmentBlocked;
  const attach = (files: FileList | readonly File[] | null) => { if (files && files.length) props.onAttach([...files]); };
  const unknown = session?.runs.filter(run => run.status === "unknown") ?? [];
  const lastSwitch = session?.switches.at(-1);
  const selectionFailed = props.error !== null || lastSwitch?.status === "failed" && JSON.stringify(lastSwitch.requested) === JSON.stringify({ harnessId: draft.harnessId, controlId: draft.controlId,
    provider: draft.providerId && draft.providerRevision !== null ? { providerId: draft.providerId, revision: draft.providerRevision, model: draft.model } : null,
    ...(!draft.providerId && draft.model ? { nativeModel: draft.model } : {}) });
  const resourcesUnconfirmed = unknown.some(run => run.cleanup?.closed !== true);
  const outdated = provider !== undefined && draft.providerRevision !== null && provider.revision !== draft.providerRevision;
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [props.messageDraft, inputRef]);
  const send = async () => {
    if (disableSend || sending.current) return;
    sending.current = true;
    const message = props.messageDraft;
    try {
      await props.onSend(message);
    } catch {
      // The parent owns the request and its error; an unconfirmed send retains the draft.
    } finally {
      sending.current = false;
    }
  };
  const harnessOptions: PickerOption[] = harnesses.map(row => {
    const available = row.controls.some(control => control.available);
    return {
      value: row.id, label: row.name, icon: <BrandIcon brand={row.id} name={row.name}/>,
      group: available ? "已发现控制入口" : "更多 Harness",
      description: row.management.installedVersion ? `v${row.management.installedVersion}` : row.controls.filter(control => control.available).map(control => protocolLabel(control.protocol)).join(" / "),
      disabled: !available, reason: row.installed ? "已发现程序，控制入口尚未就绪" : "尚未安装，请在 Harnesses 中管理",
    };
  }).sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
  const providerOptions: PickerOption[] = [{ value: "", label: "Harness 原生连接", description: "由 Harness 提供模型连接，需要完成相应认证", icon: <BrandMark small/> }, ...providers.map(row => {
    const supported = !harness || harness.providerProtocols.includes(row.protocol);
    const missingKey = row.protocol === "gemini" && !row.hasCredential;
    return {
      value: row.id, label: row.name, icon: <BrandIcon brand={providerBrand(row.baseUrl)} name={row.name}/>, description: protocolLabel(row.protocol),
      disabled: !row.enabled || !supported || missingKey,
      reason: !row.enabled ? "已停用" : !supported ? "当前 Harness 暂不支持这个协议" : missingKey ? "缺少 Gemini API Key" : "",
    };
  })];
  const nativeDefault = props.nativeModels?.models.find(model => model.id === props.nativeModels?.defaultModel)?.name ?? props.nativeModels?.defaultModel;
  const modelOptions: PickerOption[] = provider ? provider.models.map(model => ({ value: model, label: model, group: provider.name })) : [
    { value: "", label: nativeDefault ? `${nativeDefault} · 本机默认` : props.nativeModelsLoading ? "读取本机模型…" : "跟随本机配置", description: "本机当前默认模型", group: "跟随 Harness" },
    ...(props.nativeModels?.models.map(model => ({ value: model.id, label: model.name, description: model.id, group: harness?.name ?? "本机模型" })) ?? []),
  ];
  if (provider && draft.model && !provider.models.includes(draft.model)) {
    modelOptions.unshift({ value: draft.model, label: draft.model, description: `固定配置 v${draft.providerRevision}`, group: "会话当前版本" });
  }
  if (!provider && draft.model && props.nativeModels && !props.nativeModels.models.some(model=>model.id===draft.model)) modelOptions.unshift({value:draft.model,label:draft.model+" · 不可用",disabled:true,reason:"当前本机目录未提供这个模型"});
  const nativeOptions = [...(props.nativeModels?.options ?? []), ...(props.nativeModels?.models.find(model => model.id === (draft.model || props.nativeModels?.defaultModel))?.options ?? [])];
  const thought = nativeOptions.find(option => option.category === "thought_level");
  const thinkingNames: Readonly<Record<string,string>> = {off:"关闭",minimal:"最少",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最大",ultra:"最高",adaptive:"自适应"};
  const nativeNames: Readonly<Record<string,string>> = {thought_level:"思考强度",fast_mode:"快速模式",verbose_level:"工具详情",reasoning_level:"思考输出",response_usage:"用量详情",elevated_level:"执行权限"};
  const changeOption = (id: string, value: string) => { const choices={...draft.nativeOptions}; if(value)choices[id]=value;else delete choices[id]; props.onDraft({...draft,nativeOptions:Object.fromEntries(Object.entries(choices).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0))}); };
  const optionPicker = (option: typeof nativeOptions[number], label: string) => <SearchPicker label={label} value={draft.nativeOptions[option.id] ?? ""} placeholder="跟随本机配置" options={[{value:"",label:`${thinkingNames[option.currentValue] ?? option.currentValue} · 本机默认`,group:"跟随 Harness"},...option.values.map(value=>({value:value.value,label:option.category==="thought_level" ? thinkingNames[value.value]??value.name : value.name,description:value.value,group:harness?.name??"原生选项"}))]} disabled={disabled || props.nativeModelsLoading} onChange={value=>changeOption(option.id,value)}/>;
  const onboarding = session === null && draft.harnessId === "";
  const noteDanger = bytes > 64 * 1024 || problem !== null && !onboarding;
  const note = bytes > 64 * 1024 ? "单条消息不能超过 64 KiB，请缩短内容。"
    : active?.cancelRequested ? "停止已受理，正在等待执行结束和资源清理。"
    : blocked && !readonly ? resourcesUnconfirmed ? "资源停止还未确认。你可以编辑草稿、查看历史；核实后再恢复执行。" : "选择可用的 Harness 后，检查连接并继续这次对话。"
    : pending ? active ? "当前回复结束后应用新选择，草稿已保留。" : "正在保存下一条消息的选择。"
    : dirty ? problem ?? (selectionFailed ? "所选连接未生效，可以重试切换或选择其他 Harness。" : "正在切换所选 Harness 或模型，草稿已保留。")
    : !draft.providerId && props.nativeModels?.authentication === "missing" ? "所选 Harness 的本机认证尚未就绪。请完成它的登录或 Gateway 连接配置，也可以切换其他 Harness。"
    : uploading ? "附件上传中，完成后即可发送。"
    : attachmentBlocked ? "有附件无法随这条消息发送，请移除标记的附件或切换到支持它的 Harness 或模型。"
    : props.attachments.length && !props.messageDraft.trim() ? "请写一句说明，再和附件一起发送。"
    : problem;

  return <div className="composer-wrap">
    <form className={`composer ${blocked ? "unavailable" : ""} ${dragging ? "is-dropping" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={event => { if (!readonly && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); if (!readonly) attach(event.dataTransfer.files); } }}>
      <label className="sr-only" htmlFor="message-input">发送消息</label>
      {props.attachments.length ? <ComposerAttachments items={props.attachments} inputs={inputs} disabled={props.mutation === "sending"} onRemove={props.onRemoveAttachment}/> : null}
      <textarea id="message-input" ref={inputRef} rows={1} value={props.messageDraft} disabled={readonly}
        aria-describedby={note ? "composer-notice" : "composer-keyboard-hint"}
        placeholder={readonly ? "对话已关闭，历史仍可查看" : blocked ? "先写下想继续的内容，恢复后发送…" : session ? "继续这次对话…" : "说说你想完成的事…"}
        onChange={event => props.onMessageDraft(event.target.value)} onPaste={event => {
          // Pasted screenshots and files become attachments; pasted text keeps its normal behavior.
          if (event.clipboardData.files.length) { event.preventDefault(); attach(event.clipboardData.files); }
        }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }}/>
      <div className="composer-toolbar">
        <button type="button" className="composer-attach" aria-label="添加附件" title="添加图片、音频或文件" disabled={readonly || props.attachments.length >= 8} onClick={() => picker.current?.click()}><Paperclip size={16}/></button>
        <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event => { attach(event.target.files); event.target.value = ""; }}/>
        <div className="composer-pickers" aria-label="下一次任务的执行选择">
          <div className="composer-chip harness-chip"><SearchPicker label="选择 Harness" value={draft.harnessId} placeholder="选择 Harness" options={harnessOptions} disabled={disabled} onChange={value => {
            if(value===draft.harnessId)return;
            const next = harnesses.find(row => row.id === value), previous=[...(session?.switches??[])].reverse().find(sw=>sw.status==="effective"&&sw.target?.harnessId===value)?.target??[...(session?.runs??[])].reverse().find(run=>run.selection.harnessId===value)?.selection;
            const control=previous && next?.controls.some(row=>row.id===previous.controlId&&row.available) ? previous.controlId : next?.controls.find(row => row.id === next.defaultControlId && row.available)?.id ?? next?.controls.find(row => row.available)?.id ?? "";
            props.onDraft({ ...draft, harnessId:value,controlId:control,model:draft.providerId?draft.model:previous?.nativeModel??"",nativeOptions:draft.providerId?{}:previous?.nativeOptions??{} });
          }}/></div>
          {props.providerManagement !== false || draft.providerId ? <div className="composer-chip provider-chip"><SearchPicker label="选择 Provider" value={draft.providerId} placeholder="选择 Provider" options={providerOptions} disabled={disabled} onChange={value => {
            const next = providers.find(row => row.id === value);
            props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "", nativeOptions: {} });
          }} footer={<button type="button" className="text-button" onClick={props.onProviders}>管理模型连接 <ArrowRight size={13}/></button>}/></div> : <span className="composer-chip provider-chip" title="沿用 Harness 本机模型配置和登录状态">本机配置</span>}
          <div className="composer-chip model-chip"><SearchPicker label="选择模型" value={draft.model} placeholder="选择模型" options={modelOptions} disabled={disabled || !provider && (!props.nativeModels?.canSelect)} onChange={value => { if(value===draft.model)return; const independent=Object.fromEntries(Object.entries(draft.nativeOptions).filter(([id])=>nativeOptions.some(option=>option.id===id&&option.category!=="thought_level"))); props.onDraft({ ...draft, model: value, nativeOptions: independent }); }}
            footer={!provider ? <button type="button" className="text-button" onClick={props.onRefreshModels}>刷新本机模型</button> : undefined}/></div>
          {thought ? <div className="composer-chip thinking-chip">{optionPicker(thought,"思考强度")}</div> : null}
          {props.nativeModels?.commands?.length ? <div className="composer-chip command-chip"><SearchPicker label="原生命令" value="" placeholder="命令" options={props.nativeModels.commands.map(command=>({value:command.name,label:"/"+command.name,description:command.description}))} disabled={disabled} onChange={value=>{props.onMessageDraft("/"+value+" "); inputRef.current?.focus();}}/></div> : null}
        </div>
        {!draft.providerId && draft.harnessId && props.onLoadExtensions ? <NativeExtensionsPanel key={draft.harnessId + ":" + draft.controlId} load={props.onLoadExtensions} disabled={disabled} onCommand={command => { props.onMessageDraft("/" + command + " "); inputRef.current?.focus(); }}/> : null}
        <Popover.Root><Popover.Trigger asChild><button type="button" className={`composer-settings-trigger ${outdated ? "has-update" : ""}`} aria-label="高级配置" title="控制入口与配置版本" disabled={disabled}><SlidersHorizontal size={15}/>{outdated ? <span className="settings-update-dot"/> : null}</button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="composer-settings-panel" side="top" align="end" sideOffset={12} collisionPadding={16}>
            <div className="composer-settings-heading"><h3>执行配置</h3><Popover.Close className="icon-button" aria-label="收起高级配置"><X size={15}/></Popover.Close></div>
            {nativeOptions.filter(option=>option!==thought).map(option=><div className="execution-setting native-setting" key={option.id}><span>{nativeNames[option.id]??option.name}</span>{optionPicker(option,nativeNames[option.id]??option.name)}</div>)}
            {controls.length > 1 ? <div className="advanced-control"><SearchPicker label="选择控制入口" value={draft.controlId} placeholder="控制入口" options={controls.map(control => ({ value: control.id, label: protocolLabel(control.protocol), description: control.id }))} disabled={disabled} onChange={value => props.onDraft({ ...draft, controlId: value, nativeOptions: {} })}/></div>
              : <div className="execution-setting"><span>控制入口</span><strong>{selectedControl ? protocolLabel(selectedControl.protocol) : "尚未选择"}</strong>{draft.controlId ? <code>{draft.controlId}</code> : null}</div>}
            {provider && draft.providerRevision !== null ? <div className="execution-setting"><span>Provider 配置</span><strong>{provider.name} · v{draft.providerRevision}</strong>{outdated ? <button type="button" className="revision-update" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>使用最新 v{provider.revision} <ArrowRight size={12}/></button> : <small>会话固定使用这个版本。</small>}</div>
              : <p className="settings-native-note">沿用本机已安装 Harness 的模型配置和登录状态。</p>}
            {!provider && session?.nativeStates?.some(state => state.harnessId === draft.harnessId && state.controlId === draft.controlId) ? <div className="execution-setting"><span>原生会话</span><strong>{session.nativeStates.find(state => state.harnessId === draft.harnessId && state.controlId === draft.controlId)?.status === "ready" ? "继续已有会话" : "状态待确认"}</strong><small>公共历史与旧原生记录保留；原生内部状态重新建立。</small><button type="button" className="text-button" disabled={disabled || dirty || pending || active !== null} onClick={props.onNativeBranch}>重新建立原生会话</button></div> : null}
            <p className="settings-help">选择后直接切换；当前回复继续使用原配置，下一次发送使用新选择。</p>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        {active ? <button type="button" className="send-button stop-button" aria-label="停止当前回复" title="停止当前回复" disabled={active.cancelRequested || props.mutation !== null} onClick={props.onCancel}>{props.mutation === "cancelling" || active.cancelRequested ? <Spinner label="正在停止"/> : <Square size={13} fill="currentColor"/>}</button>
          : <button type="submit" className="send-button" aria-label="发送消息" title="发送消息" disabled={disableSend}>{props.mutation === "sending" ? <Spinner/> : <ArrowUp size={19}/>}</button>}
      </div>
      {pending || dirty && !blocked ? <div className="composer-change" role="status">{selectionFailed && !pending ? <><span>{problem ?? "所选连接尚未生效"}</span><button type="button" className="text-button" onClick={props.onApply} disabled={props.mutation !== null || problem !== null}>重试切换</button></> : <><Spinner/><span>{problem ?? (active ? "当前回复结束后自动切换" : "正在保存选择")}</span></>}</div> : null}
      {blocked && !readonly ? <div className="composer-change" role="status"><span>恢复会检查连接，不会重跑旧任务</span><button type="button" className="apply-selection" onClick={props.onApply} disabled={disabled || pending || props.mutation !== null || problem !== null || resourcesUnconfirmed}><RefreshCw size={12}/>{unknown.length ? "确认保留未知结果并继续" : "检查连接并恢复对话"}</button></div> : null}
    </form>
    {note ? <p id="composer-notice" className={`composer-note ${noteDanger ? "error-text" : ""}`} role={problem || bytes > 64 * 1024 ? "status" : undefined}>{note}</p> : null}
    {!draft.providerId && props.nativeModelsError && !selectionFailed ? <p className="composer-note" role="status">{props.nativeModelsError} <button type="button" className="text-button" onClick={props.onRefreshModels}>刷新模型</button></p> : null}
    <span id="composer-keyboard-hint" className="sr-only">Enter 发送，Shift 加 Enter 换行。</span>
  </div>;
}
