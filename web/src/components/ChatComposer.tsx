import * as Popover from "@radix-ui/react-popover";
import { ArrowRight, ArrowUp, RefreshCw, SlidersHorizontal, Square, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import { protocolLabel } from "../api.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import { BrandMark, Spinner } from "./common.js";
import { SearchPicker } from "./SearchPicker.js";
import type { PickerOption } from "./SearchPicker.js";
import type { ChatProps } from "./ChatPage.js";

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
  const bytes = new TextEncoder().encode(props.messageDraft).byteLength;
  const harness = harnesses.find(row => row.id === draft.harnessId);
  const provider = providers.find(row => row.id === draft.providerId);
  const controls = harness?.controls.filter(control => control.available) ?? [];
  const selectedControl = harness?.controls.find(control => control.id === draft.controlId);
  const readonly = session?.status === "closed";
  const disabled = props.mutation !== null || props.loading || props.sessionError !== null || pending || readonly;
  const disableSend = disabled || blocked || active !== null || dirty || problem !== null || bytes > 64 * 1024 || !props.messageDraft.trim();
  const unknown = session?.runs.filter(run => run.status === "unknown") ?? [];
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
  const modelOptions: PickerOption[] = provider ? provider.models.map(model => ({ value: model, label: model, group: provider.name })) : [{ value: "", label: "跟随 Harness 配置", description: "由执行者自身配置决定" }];
  if (provider && draft.model && !provider.models.includes(draft.model)) {
    modelOptions.unshift({ value: draft.model, label: draft.model, description: `固定配置 v${draft.providerRevision}`, group: "会话当前版本" });
  }
  const onboarding = session === null && draft.harnessId === "";
  const noteDanger = bytes > 64 * 1024 || problem !== null && !onboarding;
  const note = bytes > 64 * 1024 ? "单条消息不能超过 64 KiB，请缩短内容。"
    : active?.cancelRequested ? "停止已受理，正在等待执行结束和资源清理。"
    : blocked && !readonly ? resourcesUnconfirmed ? "资源停止还未确认。你可以编辑草稿、查看历史；核实后再恢复执行。" : "选择可用的 Harness 后，检查连接并继续这次对话。"
    : pending ? active ? "当前回复结束后应用新选择，草稿已保留。" : "正在连接并验证新选择，草稿已保留。"
    : dirty ? problem ?? "应用选择后，继续这次对话。"
    : problem;

  return <div className="composer-wrap">
    <form className={`composer ${blocked ? "unavailable" : ""}`} onSubmit={event => { event.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor="message-input">发送消息</label>
      <textarea id="message-input" ref={inputRef} rows={1} value={props.messageDraft} disabled={readonly}
        aria-describedby={note ? "composer-notice" : "composer-keyboard-hint"}
        placeholder={readonly ? "对话已关闭，历史仍可查看" : blocked ? "先写下想继续的内容，恢复后发送…" : session ? "继续这次对话…" : "说说你想完成的事…"}
        onChange={event => props.onMessageDraft(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            void send();
          }
        }}/>
      <div className="composer-toolbar">
        <div className="composer-pickers" aria-label="下一次任务的执行选择">
          <div className="composer-chip harness-chip"><SearchPicker label="选择 Harness" value={draft.harnessId} placeholder="选择 Harness" options={harnessOptions} disabled={disabled} onChange={value => {
            const next = harnesses.find(row => row.id === value);
            props.onDraft({ ...draft, harnessId: value, controlId: next?.controls.find(row => row.id === next.defaultControlId && row.available)?.id ?? next?.controls.find(row => row.available)?.id ?? "" });
          }}/></div>
          <div className="composer-chip provider-chip"><SearchPicker label="选择 Provider" value={draft.providerId} placeholder="选择 Provider" options={providerOptions} disabled={disabled} onChange={value => {
            const next = providers.find(row => row.id === value);
            props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "" });
          }} footer={<button type="button" className="text-button" onClick={props.onProviders}>管理模型连接 <ArrowRight size={13}/></button>}/></div>
          <div className="composer-chip model-chip"><SearchPicker label="选择模型" value={draft.model} placeholder="选择模型" options={modelOptions} disabled={disabled || !provider} onChange={value => props.onDraft({ ...draft, model: value })}/></div>
        </div>
        <Popover.Root><Popover.Trigger asChild><button type="button" className={`composer-settings-trigger ${outdated ? "has-update" : ""}`} aria-label="高级配置" title="控制入口与配置版本" disabled={disabled}><SlidersHorizontal size={15}/>{outdated ? <span className="settings-update-dot"/> : null}</button></Popover.Trigger>
          <Popover.Portal><Popover.Content className="composer-settings-panel" side="top" align="end" sideOffset={12} collisionPadding={16}>
            <div className="composer-settings-heading"><h3>执行配置</h3><Popover.Close className="icon-button" aria-label="收起高级配置"><X size={15}/></Popover.Close></div>
            {controls.length > 1 ? <div className="advanced-control"><SearchPicker label="选择控制入口" value={draft.controlId} placeholder="控制入口" options={controls.map(control => ({ value: control.id, label: protocolLabel(control.protocol), description: control.id }))} disabled={disabled} onChange={value => props.onDraft({ ...draft, controlId: value })}/></div>
              : <div className="execution-setting"><span>控制入口</span><strong>{selectedControl ? protocolLabel(selectedControl.protocol) : "尚未选择"}</strong>{draft.controlId ? <code>{draft.controlId}</code> : null}</div>}
            {provider && draft.providerRevision !== null ? <div className="execution-setting"><span>Provider 配置</span><strong>{provider.name} · v{draft.providerRevision}</strong>{outdated ? <button type="button" className="revision-update" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>使用最新 v{provider.revision} <ArrowRight size={12}/></button> : <small>会话固定使用这个版本。</small>}</div>
              : <p className="settings-native-note">使用 Harness 的原生模型连接。安装完成后仍可能需要单独配置或认证。</p>}
            <p className="settings-help">更改选择后，请先应用。正在执行的任务继续使用原配置。</p>
          </Popover.Content></Popover.Portal>
        </Popover.Root>
        {active ? <button type="button" className="send-button stop-button" aria-label="停止当前回复" title="停止当前回复" disabled={active.cancelRequested || props.mutation !== null} onClick={props.onCancel}>{props.mutation === "cancelling" || active.cancelRequested ? <Spinner label="正在停止"/> : <Square size={13} fill="currentColor"/>}</button>
          : <button type="submit" className="send-button" aria-label="发送消息" title="发送消息" disabled={disableSend}>{props.mutation === "sending" ? <Spinner/> : <ArrowUp size={19}/>}</button>}
      </div>
      {dirty || pending || blocked && !readonly ? <div className="composer-change" role="status">{pending ? <><Spinner/><span>{active ? "当前回复结束后生效" : "正在验证新选择"}</span></> : <><span>{blocked ? "恢复会检查连接，不会重跑旧任务" : "执行选择尚未应用"}</span><button type="button" className="apply-selection" onClick={props.onApply} disabled={disabled || problem !== null || resourcesUnconfirmed}>{props.mutation === "switching" ? <Spinner/> : <RefreshCw size={12}/>} {blocked ? unknown.length ? "确认保留未知结果并继续" : "检查连接并恢复对话" : "应用选择"}</button></>}</div> : null}
    </form>
    {note ? <p id="composer-notice" className={`composer-note ${noteDanger ? "error-text" : ""}`} role={problem || bytes > 64 * 1024 ? "status" : undefined}>{note}</p> : null}
    <span id="composer-keyboard-hint" className="sr-only">Enter 发送，Shift 加 Enter 换行。</span>
  </div>;
}
