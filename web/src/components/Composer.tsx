import { ArrowUp, ListPlus, Paperclip, RefreshCw, SlidersHorizontal, Square } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView } from "../../../src/contracts/web.js";
import { failureMessage, protocolLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { ago } from "../lib/format.js";
import { Popover, PopHead } from "../ui/overlay.js";
import { Spinner, Switch, Tip } from "../ui/primitives.js";
import { attachmentProblem, ComposerAttachments } from "./Attachments.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import type { ChatProps } from "./ChatPage.js";
import { NativeExtensionsPanel } from "./NativeExtensions.js";
import { NativeSessionsPanel } from "./NativeSessions.js";
import { SearchPicker, type PickerOption } from "./SearchPicker.js";
import { LogoMark } from "../ui/primitives.js";

interface ComposerProps extends ChatProps {
  readonly active: PublicRun | null;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly problem: string | null;
  readonly blocked: boolean;
  readonly inputRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onSendDraft: (text: string) => Promise<void>;
}

/** Products whose own documentation names the command that sets up a missing sign-in or provider. */
const SETUP_COMMANDS: Readonly<Record<string, string>> = { hermes: "hermes model" };
/**
 * How a Harness decides on approvals when its interface does not report it. A session the Hub opens through dsh's ACP entry
 * runs dsh's default preset for new sessions (`permission.defaultPreset`, derived at runtime when unset); its entry neither
 * reports the preset nor runs /permission, which only switches the dsh session it is typed in. So the Hub states the rule.
 */
const APPROVAL_NOTES: Readonly<Record<string, string>> = {
  dsh: "由 dsh 自己为新会话设定的默认权限预设决定（workspace-write 超出工作区时请求审批；danger-full-access 不请求审批）。要改变 HarnessHub 会话的预设，请在 dsh 自己的设置中修改默认预设；HarnessHub 不读取、不修改它的设置。",
};
export const THINKING_NAMES: Readonly<Record<string, string>> = { off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "最高", adaptive: "自适应" };
export const OPTION_NAMES: Readonly<Record<string, string>> = { thought_level: "思考强度", fast_mode: "快速模式", verbose_level: "工具详情", reasoning_level: "思考输出", response_usage: "用量详情", elevated_level: "执行权限", collaboration_mode: "协作模式" };
function approximately(ms: number): string { return Math.max(1, Math.round(ms / 1000)) + " 秒"; }
/** The readiness badge of one Harness entry, from its latest catalog read; nothing when it has not been read. */
export function readinessStatus(harness: HarnessView, readiness: HarnessReadinessView | undefined): PickerOption["status"] {
  if (readiness === undefined || readiness.checkedAt === null) return undefined;
  const when = ago(readiness.checkedAt);
  switch (readiness.state) {
    case "ready": return { tone: "success", label: "已就绪", title: when + "读取过本机模型" + (readiness.signedIn ? "，已登录" : "；登录与额度在发送时由它自己核实") };
    case "signed_out": return { tone: "warning", label: SETUP_COMMANDS[harness.id] ? "需要配置" : "需要登录", title: when + "检查时，它需要先在本机完成登录或配置" + (SETUP_COMMANDS[harness.id] ? "（终端运行 " + SETUP_COMMANDS[harness.id] + "）" : "") };
    case "failed": return { tone: "danger", label: "读取失败", title: when + "读取本机模型失败：" + failureMessage({ code: readiness.failureCode ?? "", message: "原因未知，可以刷新本机模型重试。" }) };
    case "unchecked": return undefined;
  }
}
/** The Harness picker's rows: available entries first, each with its version, readiness and usual startup. */
export function harnessOptions(harnesses: readonly HarnessView[], readiness: readonly HarnessReadinessView[] | undefined, current: { readonly harnessId: string; readonly controlId: string }): PickerOption[] {
  return harnesses.map(row => {
    const available = row.controls.some(control => control.available);
    // The entry this Harness would run through: the chosen one for the current Harness, otherwise its default.
    const control = row.id === current.harnessId && current.controlId ? current.controlId : row.controls.find(item => item.id === row.defaultControlId && item.available)?.id ?? row.controls.find(item => item.available)?.id;
    const seen = control === undefined ? undefined : readiness?.find(item => item.harnessId === row.id && item.controlId === control);
    const version = row.management.programVersion ?? row.management.installedVersion;
    const status = available ? readinessStatus(row, seen) : undefined;
    return {
      value: row.id, label: row.name, icon: <BrandIcon brand={row.id} name={row.name} size={20}/>,
      group: available ? "本机可用" : "更多 Harness",
      // A version HarnessHub has not run for real is said, never blocked (ADR-038).
      description: [version ? `v${version}${row.management.verification?.state === "unverified" ? " · 未经验证的版本" : ""}` : row.controls.filter(item => item.available).map(item => protocolLabel(item.protocol)).join(" / "),
        available && seen?.startupMs !== undefined ? "启动约 " + approximately(seen.startupMs) : ""].filter(Boolean).join(" · "),
      ...(status ? { status } : {}),
      disabled: !available, reason: row.installed ? "已发现程序，控制入口尚未就绪" : "尚未安装，可在“我的 Agent”中查看安装方式",
    };
  }).sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
}

export function Composer(props: ComposerProps) {
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
  const sendBlocked = disabled || props.mutation !== null || pending || blocked || dirty || problem !== null || !draft.providerId && props.nativeModels?.authentication === "missing" || bytes > 64 * 1024 || !props.messageDraft.trim() || attachmentBlocked;
  const disableSend = sendBlocked || active !== null;
  // While a reply runs, the next message can be written and held by this page until the Turn ends (ADR-042).
  const canQueue = active !== null && !active.cancelRequested && props.queued === null && props.onQueue !== undefined && !readonly && !blocked && props.messageDraft.trim() !== "" && bytes <= 64 * 1024 && !attachmentBlocked;
  const attach = (files: FileList | readonly File[] | null) => { if (files && files.length) props.onAttach([...files]); };
  const unknown = session?.runs.filter(run => run.status === "unknown") ?? [];
  const lastSwitch = session?.switches.at(-1);
  const selectionFailed = props.error !== null || lastSwitch?.status === "failed" && JSON.stringify(lastSwitch.requested) === JSON.stringify({ harnessId: draft.harnessId, controlId: draft.controlId,
    provider: draft.providerId && draft.providerRevision !== null ? { providerId: draft.providerId, revision: draft.providerRevision, model: draft.model } : null,
    ...(!draft.providerId && draft.model ? { nativeModel: draft.model } : {}) });
  const resourcesUnconfirmed = unknown.some(run => run.cleanup?.closed !== true);
  const outdated = provider !== undefined && draft.providerRevision !== null && provider.revision !== draft.providerRevision;
  // The input grows with its text up to a limit; a change of its width (the layout around it changed) measures it again.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    const resize = () => { element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 240)}px`; };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; resize(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.messageDraft, inputRef]);
  const send = async () => {
    if (canQueue) { props.onQueue!(); return; }
    if (disableSend || sending.current) return;
    sending.current = true;
    try { await props.onSendDraft(props.messageDraft); }
    catch { /* The parent owns the request and its error; an unconfirmed send retains the draft. */ }
    finally { sending.current = false; }
  };
  const harnessChoices = harnessOptions(harnesses, props.readiness, draft);
  const providerOptions: PickerOption[] = [{ value: "", label: "Harness 原生连接", description: "由 Harness 提供模型连接，需要完成相应认证", icon: <LogoMark size={18}/> }, ...providers.map(row => {
    const supported = !harness || harness.providerProtocols.includes(row.protocol);
    const missingKey = row.protocol === "gemini" && !row.hasCredential;
    return { value: row.id, label: row.name, icon: <BrandIcon brand={providerBrand(row.baseUrl)} name={row.name} size={18}/>, description: protocolLabel(row.protocol),
      disabled: !row.enabled || !supported || missingKey, reason: !row.enabled ? "已停用" : !supported ? "当前 Harness 暂不支持这个协议" : missingKey ? "缺少 Gemini API Key" : "" };
  })];
  const nativeDefault = props.nativeModels?.models.find(model => model.id === props.nativeModels?.defaultModel)?.name ?? props.nativeModels?.defaultModel;
  // What this browser last sent with the Harness, shown as such while a new conversation starts with it.
  const recalled = !provider && !session?.runs.some(run => run.selection.harnessId === draft.harnessId) ? props.rememberedChoice?.(draft.harnessId) ?? null : null;
  const lastUsed = (value: string, recalledValue: string | undefined) => recalled !== null && recalledValue !== undefined && value === recalledValue ? "上次使用" : undefined;
  const modelOptions: PickerOption[] = provider ? provider.models.map(model => ({ value: model, label: model, group: provider.name })) : [
    { value: "", label: nativeDefault ? `${nativeDefault} · 本机默认` : props.nativeModelsLoading ? "读取本机模型…" : "跟随本机配置", short: nativeDefault ?? (props.nativeModelsLoading ? "读取模型…" : "本机默认模型"), description: "本机当前默认模型", group: "跟随 Harness" },
    ...(props.nativeModels?.models.map(model => ({ value: model.id, label: model.name, description: lastUsed(model.id, recalled?.nativeModel) ?? model.id, group: harness?.name ?? "本机模型" })) ?? []),
  ];
  if (provider && draft.model && !provider.models.includes(draft.model)) modelOptions.unshift({ value: draft.model, label: draft.model, description: `固定配置 v${draft.providerRevision}`, group: "会话当前版本" });
  if (!provider && draft.model && props.nativeModels && !props.nativeModels.models.some(model => model.id === draft.model)) modelOptions.unshift({ value: draft.model, label: draft.model + " · 不可用", disabled: true, reason: "当前本机目录未提供这个模型" });
  const nativeOptions = [...(props.nativeModels?.options ?? []), ...(props.nativeModels?.models.find(model => model.id === (draft.model || props.nativeModels?.defaultModel))?.options ?? [])];
  const thought = nativeOptions.find(option => option.category === "thought_level");
  const mode = nativeOptions.find(option => option.category === "mode");
  const changeOption = (id: string, value: string) => { const choices = { ...draft.nativeOptions }; if (value) choices[id] = value; else delete choices[id]; props.onDraft({ ...draft, nativeOptions: Object.fromEntries(Object.entries(choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }); };
  const valueName = (option: typeof nativeOptions[number], value: string) => (option.category === "thought_level" ? THINKING_NAMES[value] : undefined) ?? option.values.find(row => row.value === value)?.name ?? value;
  const optionPicker = (option: typeof nativeOptions[number], label: string, extra?: { readonly prefix?: string; readonly className?: string }) => <SearchPicker label={label} value={draft.nativeOptions[option.id] ?? ""} placeholder="跟随本机配置" {...extra}
    options={[{ value: "", label: `${valueName(option, option.currentValue)} · 本机默认`, ...(extra?.prefix ? { short: valueName(option, option.currentValue) } : {}), group: "跟随 Harness" }, ...option.values.map(value => ({ value: value.value, label: option.category === "thought_level" ? THINKING_NAMES[value.value] ?? value.name : value.name, description: lastUsed(value.value, recalled?.nativeOptions?.[option.id]) ?? value.value, group: harness?.name ?? "原生选项" }))]}
    disabled={disabled || props.nativeModelsLoading} onChange={value => changeOption(option.id, value)}/>;
  // The native session's own values, as it reported them after its last Turn (ADR-028).
  const nativeState = provider ? undefined : session?.nativeStates?.find(state => state.harnessId === draft.harnessId && state.controlId === draft.controlId);
  const describeNative = (model: string | undefined, options: Readonly<Record<string, string>> | undefined) => [
    ...(model ? ["模型 " + (props.nativeModels?.models.find(row => row.id === model)?.name ?? model)] : []),
    ...Object.entries(options ?? {}).filter(([id]) => nativeOptions.some(row => row.id === id)).map(([id, value]) => (OPTION_NAMES[id] ?? nativeOptions.find(row => row.id === id)?.name ?? id) + " " + valueName(nativeOptions.find(row => row.id === id)!, value)),
  ].join("、");
  const carried = !dirty && !pending && !blocked && nativeState?.carried ? describeNative(nativeState.carried.model, nativeState.carried.options) : "";
  const onboarding = session === null && draft.harnessId === "";
  const noteDanger = bytes > 64 * 1024 || problem !== null && !onboarding;
  const note = bytes > 64 * 1024 ? "单条消息不能超过 64 KiB，请缩短内容。"
    : active?.cancelRequested ? "停止已受理，正在等待执行结束和资源清理。"
    : blocked && !readonly ? resourcesUnconfirmed ? "资源停止还未确认。你可以编辑草稿、查看历史；核实后再恢复执行。" : "选择可用的 Harness 后，检查连接并继续这次对话。"
    : pending ? active ? "当前回复结束后应用新选择，草稿已保留。" : "正在保存下一条消息的选择。"
    : dirty ? problem ?? (selectionFailed ? "所选连接未生效，可以重试切换或选择其他 Harness。" : "正在切换所选 Harness 或模型，草稿已保留。")
    : !draft.providerId && props.nativeModels?.authentication === "missing" ? SETUP_COMMANDS[draft.harnessId]
      ? `${harness?.name ?? "所选 Harness"} 的本机认证尚未就绪：它还没有可用的模型提供方。请在终端运行 ${SETUP_COMMANDS[draft.harnessId]} 完成配置，然后刷新本机模型；也可以切换其他 Harness。`
      : "所选 Harness 的本机认证尚未就绪。请在它自己的程序中完成登录或 Gateway 连接配置，然后刷新本机模型；也可以切换其他 Harness。"
    : uploading ? "附件上传中，完成后即可发送。"
    : attachmentBlocked ? "有附件无法随这条消息发送，请移除标记的附件或切换到支持它的 Harness 或模型。"
    : props.attachments.length && !props.messageDraft.trim() ? "请写一句说明，再和附件一起发送。"
    // Codex's collaboration mode stays with its thread: plan mode answers with a plan, and following the native configuration
    // does not leave it (ADR-034).
    : !draft.providerId && draft.nativeOptions.collaboration_mode === "plan" ? `计划模式：${harness?.name ?? "Harness"} 先给出方案。要让它执行，在高级配置里把协作模式改为“默认”后再发送。`
    // The previous service ended without closing this conversation's kept process; what this one found at start is said
    // here until the conversation's next Turn (ADR-030).
    : session?.retention?.lost ? session.retention.lost.outcome === "unconfirmed"
      ? "服务上次异常退出，无法确认这个对话保留的后台进程已经结束，工作区保持隔离。请检查并结束相关进程。"
      : `服务上次异常退出，这个对话保留的后台进程${session.retention.lost.outcome === "terminated" ? "已被清理" : "已随之结束"}（没有恢复）。下一条消息会重新启动原程序，并恢复原生会话。${session.retention.outside ? `原程序的后台任务可能仍在运行（${session.retention.outside.count} 个进程）。` : ""}`
    // An upgrade of this Harness closed the conversation's kept process; said until its next Turn (ADR-043).
    : session?.retention?.upgraded ? `升级 ${harnesses.find(row => row.id === session.retention!.upgraded!.harnessId)?.name ?? session.retention.upgraded.harnessId} 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序，并恢复原生会话。`
    // Processes the closed program had moved out of its own group are left alone; the conversation hears of them once.
    : session?.retention?.outside ? `原程序的后台任务可能仍在运行（${session.retention.outside.count} 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。`
    : !draft.providerId && draft.nativeOptions.collaboration_mode === undefined && nativeState?.observed?.options.collaboration_mode === "plan" ? `这个 ${harness?.name ?? "Harness"} 线程仍为计划模式：跟随本机配置不会改回，在高级配置里把协作模式改为“默认”即可退出。`
    : active && props.queued === null && props.messageDraft.trim() ? "回复进行中：按 Enter 先暂存这条消息，本轮正常结束后自动发出。"
    : problem;
  const context = props.contextUsage ?? null;
  const placeholder = readonly ? "对话已关闭，历史仍可查看" : blocked ? "先写下想继续的内容，恢复后发送…" : active ? "回复进行中，可以先写下一条…" : session ? "继续这次对话…" : "说说你想完成的事…";

  return <div className="composer-wrap flex flex-col gap-2">
    <form className={cn("composer relative flex flex-col gap-2 rounded-[14px] border bg-surface py-2.5 pr-2.5 pl-3.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong focus-within:shadow-md",
      blocked ? "border-dashed border-line-strong" : "border-line-strong", dragging && "is-dropping border-accent ring-2 ring-accent-soft")} onSubmit={event => { event.preventDefault(); void send(); }}
      onDragOver={event => { if (!readonly && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); if (!readonly) attach(event.dataTransfer.files); } }}>
      <label className="sr-only" htmlFor="message-input">发送消息</label>
      {props.attachments.length ? <ComposerAttachments items={props.attachments} inputs={inputs} disabled={props.mutation === "sending"} onRemove={props.onRemoveAttachment}/> : null}
      <textarea id="message-input" ref={inputRef} rows={1} value={props.messageDraft} disabled={readonly} placeholder={placeholder}
        aria-describedby={note ? "composer-notice" : "composer-keyboard-hint"}
        className="min-h-[26px] w-full resize-none border-none sm:min-h-[44px] bg-transparent px-0 py-0.5 text-[14px] leading-[1.55] text-fg outline-none placeholder:text-fg-3 disabled:opacity-60"
        onChange={event => props.onMessageDraft(event.target.value)} onPaste={event => {
          // Pasted screenshots and files become attachments; pasted text keeps its normal behavior.
          if (event.clipboardData.files.length) { event.preventDefault(); attach(event.clipboardData.files); }
        }} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          else if (event.key === "Escape" && active && !active.cancelRequested && !event.nativeEvent.isComposing && props.mutation === null) { event.preventDefault(); props.onCancel(); }
        }}/>
      <div className="flex items-end gap-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5" role="group" aria-label="下一次任务的执行选择">
        <Tip label="添加图片、音频或文件"><button type="button" className="icon-btn mr-1 h-[30px] w-[30px] border border-line" aria-label="添加附件" disabled={readonly || props.attachments.length >= 8} onClick={() => picker.current?.click()}><Paperclip size={15}/></button></Tip>
        <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event => { attach(event.target.files); event.target.value = ""; }}/>
          <SearchPicker label="选择 Harness" value={draft.harnessId} placeholder="选择 Harness" options={harnessChoices} disabled={disabled} wide onChange={value => {
            if (value === draft.harnessId) return;
            const next = harnesses.find(row => row.id === value), previous = [...(session?.switches ?? [])].reverse().find(change => change.status === "effective" && change.target?.harnessId === value)?.target ?? [...(session?.runs ?? [])].reverse().find(run => run.selection.harnessId === value)?.selection ?? props.rememberedChoice?.(value) ?? undefined;
            const control = previous && next?.controls.some(row => row.id === previous.controlId && row.available) ? previous.controlId : next?.controls.find(row => row.id === next.defaultControlId && row.available)?.id ?? next?.controls.find(row => row.available)?.id ?? "";
            props.onDraft({ ...draft, harnessId: value, controlId: control, model: draft.providerId ? draft.model : previous?.nativeModel ?? "", nativeOptions: draft.providerId ? {} : previous?.nativeOptions ?? {} });
          }}/>
          {props.providerManagement !== false || draft.providerId ? <SearchPicker label="选择 Provider" value={draft.providerId} placeholder="选择 Provider" options={providerOptions} disabled={disabled} onChange={value => {
            const next = providers.find(row => row.id === value);
            props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "", nativeOptions: {} });
          }} footer={<button type="button" className="link-btn text-[12px]" onClick={props.onProviders}>管理模型连接</button>}/> : null}
          {draft.harnessId ? <SearchPicker label="选择模型" value={draft.model} placeholder="选择模型" options={modelOptions} disabled={disabled || !provider && !props.nativeModels?.canSelect} onChange={value => {
            if (value === draft.model) return;
            const independent = Object.fromEntries(Object.entries(draft.nativeOptions).filter(([id]) => nativeOptions.some(option => option.id === id && option.category !== "thought_level")));
            props.onDraft({ ...draft, model: value, nativeOptions: independent });
          }} footer={!provider ? <><span>{props.nativeModelsLoading ? "正在读取本机模型…" : "列表来自本机安装"}</span><button type="button" className="link-btn text-[12px]" onClick={props.onRefreshModels}>刷新本机模型</button></> : undefined}/> : null}
          {thought ? optionPicker(thought, "思考强度", { prefix: "思考" }) : null}
          {mode ? optionPicker(mode, OPTION_NAMES[mode.id] ?? mode.name, { prefix: "模式" }) : null}
          {props.nativeModels?.commands?.length ? <SearchPicker label="原生命令" value="" placeholder="/" wide className="mono px-2.5" options={props.nativeModels.commands.map(command => ({ value: command.name, label: "/" + command.name, description: command.description }))} disabled={disabled}
            onChange={value => { props.onMessageDraft("/" + value + " "); inputRef.current?.focus(); }}/> : null}
        </div>
        {context !== null ? <Tip label={`上下文已用 ${context}%（最近一轮由原程序报告）`}><span className="flex items-center gap-1.5 px-1.5 text-[12px] text-fg-3" aria-label={`上下文已用 ${context}%`} role="img">
          <svg width="16" height="16" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" strokeWidth="4"/><circle cx="18" cy="18" r="14" fill="none" stroke={context >= 85 ? "var(--red)" : "var(--text-2)"} strokeWidth="4" strokeDasharray={`${(Math.min(100, context) / 100 * 88).toFixed(1)} 88`} strokeLinecap="round" transform="rotate(-90 18 18)"/></svg>{context}%</span></Tip> : null}
        {active ? <>
          {canQueue ? <Tip label="本轮结束后发送（Enter）"><button type="button" className="icon-btn h-8 w-8 border border-line" aria-label="本轮结束后发送" onClick={() => props.onQueue?.()}><ListPlus size={15}/></button></Tip> : null}
          <Tip label="停止（Esc）"><button type="button" className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border-none bg-fg text-surface disabled:opacity-50" aria-label="停止当前回复" disabled={active.cancelRequested || props.mutation !== null} onClick={props.onCancel}>
            {props.mutation === "cancelling" || active.cancelRequested ? <Spinner label="正在停止" size={14} className="text-surface"/> : <Square size={11} fill="currentColor"/>}</button></Tip>
        </> : <Tip label="发送（Enter）"><button type="submit" className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border-none bg-fg text-surface transition-opacity duration-150 disabled:bg-line-strong disabled:text-surface" aria-label="发送消息" disabled={disableSend}>
          {props.mutation === "sending" ? <Spinner size={14} className="text-surface"/> : <ArrowUp size={17}/>}</button></Tip>}
      </div>
    </form>
    {pending || dirty && !blocked ? <Strip>{selectionFailed && !pending ? <><span className="text-red">{problem ?? "所选连接尚未生效"}</span><button type="button" className="link-btn" onClick={props.onApply} disabled={props.mutation !== null || problem !== null}>重试切换</button></> : <><Spinner size={13}/><span>{problem ?? (active ? "当前回复结束后自动切换" : "正在保存选择")}</span></>}</Strip> : null}
    {carried && !readonly ? <Strip className="native-carried"><span>原生命令已改为 {carried}；下一回合沿用，不改回所选。</span><button type="button" className="link-btn" onClick={props.onApply} disabled={disabled || props.mutation !== null}>改用所选设置</button></Strip> : null}
    {blocked && !readonly ? <Strip><span>恢复会检查连接，不会重跑旧任务</span><button type="button" className="btn btn-sm" onClick={props.onApply} disabled={disabled || pending || props.mutation !== null || problem !== null || resourcesUnconfirmed}><RefreshCw size={12}/>{unknown.length ? "确认保留未知结果并继续" : "检查连接并恢复对话"}</button></Strip> : null}
    {note ? <p id="composer-notice" className={cn("composer-note m-0 px-1 text-[12.5px]", noteDanger ? "text-red" : "text-fg-2")} role={problem || bytes > 64 * 1024 ? "status" : undefined}>{note}</p> : null}
    {!draft.providerId && props.nativeModelsError && !selectionFailed ? <p className="composer-note m-0 px-1 text-[12.5px] text-fg-2" role="status">{props.nativeModelsError} <button type="button" className="link-btn" onClick={props.onRefreshModels}>刷新模型</button></p> : null}
    <div className="flex min-h-7 items-center gap-2 px-1">
      <p id="composer-keyboard-hint" className="m-0 hidden min-w-0 flex-1 gap-3.5 text-[11.5px] text-fg-3 sm:flex"><span>Enter 发送</span><span>Shift+Enter 换行</span>{props.nativeModels?.commands?.length ? <span>/ 原生命令</span> : null}{active ? <span>Esc 停止</span> : null}</p>
      <span className="flex-1 sm:hidden"/>
      <div className="flex flex-none items-center gap-0.5" role="group" aria-label="原生会话与配置">
        {!draft.providerId && draft.harnessId && props.onLoadNativeSessions && props.onImportNative && props.onOpenSession ? <NativeSessionsPanel key={"sessions:" + draft.harnessId + ":" + draft.controlId} load={props.onLoadNativeSessions}
          disabled={disabled || props.mutation !== null} onImport={props.onImportNative} onOpen={props.onOpenSession}/> : null}
        {!draft.providerId && draft.harnessId && props.onLoadExtensions ? <NativeExtensionsPanel key={draft.harnessId + ":" + draft.controlId} load={props.onLoadExtensions} disabled={disabled} onCommand={command => { props.onMessageDraft("/" + command + " "); inputRef.current?.focus(); }}/> : null}
        {draft.harnessId ? <AdvancedSettings {...props} controls={controls} selectedControl={selectedControl} outdated={outdated} disabled={disabled} nativeOptions={nativeOptions.filter(option => option !== thought && option !== mode)} optionPicker={optionPicker} nativeState={nativeState} describeNative={describeNative}/> : null}
      </div>
    </div>
  </div>;
}
function Strip({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn("composer-change flex flex-wrap items-center gap-2 px-1 text-[12.5px] text-fg-2", className)} role="status">{children}</div>;
}

type NativeOption = NonNullable<import("../../../src/contracts/control.js").NativeModelCatalog["options"]>[number];
/** Execution settings that are not in the composer row: further native options, the control entry, the kept process and the native session. */
function AdvancedSettings(props: ComposerProps & {
  readonly controls: readonly HarnessView["controls"][number][]; readonly selectedControl: HarnessView["controls"][number] | undefined; readonly outdated: boolean; readonly disabled: boolean;
  readonly nativeOptions: readonly NativeOption[]; readonly optionPicker: (option: NativeOption, label: string) => ReactNode;
  readonly nativeState: NonNullable<NonNullable<ComposerProps["session"]>["nativeStates"]>[number] | undefined; readonly describeNative: (model: string | undefined, options: Readonly<Record<string, string>> | undefined) => string;
}) {
  const { draft, providers, session, controls, selectedControl, outdated, disabled, nativeState } = props;
  const provider = providers.find(row => row.id === draft.providerId);
  const row = "execution-setting flex flex-col gap-1.5 border-b border-line px-3.5 py-3 last:border-b-0";
  return <Popover label="执行配置" side="top" align="end" className="composer-settings-panel w-[380px] max-w-[calc(100vw-24px)]"
    trigger={<button type="button" className="icon-btn relative" aria-label="高级配置" title="控制入口、原生选项与后台进程" disabled={disabled}><SlidersHorizontal size={16}/>{outdated ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-amber-dot"/> : null}</button>}>
    <PopHead title="执行配置" closeLabel="收起高级配置"/>
    {props.nativeOptions.map(option => <div className={cn(row, "native-setting")} key={option.id}><span className="text-[12px] font-medium text-fg-3">{OPTION_NAMES[option.id] ?? option.name}</span><div className="-ml-2">{props.optionPicker(option, OPTION_NAMES[option.id] ?? option.name)}</div></div>)}
    {!provider && APPROVAL_NOTES[draft.harnessId] ? <div className={row}><span className="text-[12px] font-medium text-fg-3">审批</span><small className="text-[12.5px] text-fg-2">{APPROVAL_NOTES[draft.harnessId]}</small></div> : null}
    {controls.length > 1 ? <div className={row}><span className="text-[12px] font-medium text-fg-3">控制入口</span><div className="-ml-2"><SearchPicker label="选择控制入口" value={draft.controlId} placeholder="控制入口" options={controls.map(control => ({ value: control.id, label: protocolLabel(control.protocol), description: control.id }))} disabled={disabled} onChange={value => props.onDraft({ ...draft, controlId: value, nativeOptions: {} })}/></div></div>
      : <div className={row}><span className="text-[12px] font-medium text-fg-3">控制入口</span><span className="flex items-center gap-2 text-[13px]"><strong className="font-medium">{selectedControl ? protocolLabel(selectedControl.protocol) : "尚未选择"}</strong>{draft.controlId ? <code className="text-[12px] text-fg-3">{draft.controlId}</code> : null}</span></div>}
    {provider && draft.providerRevision !== null ? <div className={row}><span className="text-[12px] font-medium text-fg-3">Provider 配置</span><strong className="text-[13px] font-medium">{provider.name} · v{draft.providerRevision}</strong>
      {outdated ? <button type="button" className="btn btn-sm self-start" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>使用最新 v{provider.revision}</button> : <small className="text-[12px] text-fg-3">会话固定使用这个版本。</small>}</div>
      : <p className="m-0 border-b border-line px-3.5 py-3 text-[12.5px] text-fg-2">沿用本机已安装 Harness 的模型配置和登录状态。</p>}
    {!provider && props.onRetention ? <div className={cn(row, "kept-setting")}><span className="text-[12px] font-medium text-fg-3">后台任务</span>
      <label className="flex items-center gap-2 text-[13px] font-medium"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={session ? session.retention?.enabled === true : props.retainNew === true} disabled={disabled || props.mutation !== null} onChange={event => props.onRetention!(event.target.checked)}/>保持原生进程</label>
      <small className="text-[12px] text-fg-2">开启后，回合结束时不关闭原程序：它在后台运行的任务可以继续，下一条消息也不必重新启动它。空闲 30 分钟后结束，同时最多保留 4 个。</small>
      {session?.retention?.process ? <><small className="native-observed text-[12px] text-accent-text">原生进程保留中 · 后台活动 {session.retention.process.backgroundUpdates} 条 · {Math.max(1, Math.round((session.retention.process.idleEndsAt - Date.now()) / 60000))} 分钟后结束</small>
        <button type="button" className="btn btn-sm self-start" disabled={props.mutation !== null} onClick={props.onEndProcess}>结束后台进程</button></> : null}</div> : null}
    {nativeState ? <div className={row}><span className="text-[12px] font-medium text-fg-3">原生会话</span><strong className="text-[13px] font-medium">{nativeState.status === "ready" ? "继续已有会话" : "状态待确认"}</strong>
      {nativeState.observed ? <small className="native-observed text-[12px] text-fg-2">原生当前：{props.describeNative(nativeState.observed.model ?? undefined, nativeState.observed.options) || "未报告"}</small> : null}
      <small className="text-[12px] text-fg-3">公共历史与旧原生记录保留；原生内部状态重新建立。</small>
      <button type="button" className="btn btn-sm self-start" disabled={disabled || props.dirty || props.pending || props.active !== null} onClick={props.onNativeBranch}>重新建立原生会话</button>
      {nativeState.status === "ready" && session && props.onShowResume ? <button type="button" className="link-btn self-start text-[12.5px]" onClick={props.onShowResume}>在原程序中继续的方式…</button> : null}</div> : null}
    <p className="m-0 bg-subtle px-3.5 py-2.5 text-[12px] text-fg-3">选择后直接切换；当前回复继续使用原配置，下一次发送使用新选择。</p>
  </Popover>;
}
