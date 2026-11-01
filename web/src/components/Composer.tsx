import { ArrowLeftRight, AtSign, ListPlus, Paperclip, Plus, RefreshCw, ShieldCheck, SlidersHorizontal, SquareSlash, TriangleAlert } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { PublicRun } from "../../../src/contracts/session.js";
import type { HarnessReadinessView, HarnessView } from "../../../src/contracts/web.js";
import { failureMessage, protocolLabel } from "../api.js";
import { cn } from "../lib/cn.js";
import { ago } from "../lib/format.js";
import { Menu, Popover, PopHead } from "../ui/overlay.js";
import { motionStyle, SendStopIcon, usePresence, useReducedMotion } from "../ui/motion.js";
import { Kbd, LogoMark, Spinner, Tip } from "../ui/primitives.js";
import { ApprovalDock, type PermissionRequestView } from "./Approval.js";
import { attachmentProblem, ComposerAttachments } from "./Attachments.js";
import { BrandIcon, providerBrand } from "./BrandIcon.js";
import type { ChatProps } from "./ChatPage.js";
import { NativeExtensionsPanel } from "./NativeExtensions.js";
import { NativeSessionsPanel } from "./NativeSessions.js";
import { SearchPicker, type PickerOption } from "./SearchPicker.js";

/** An approval that waits in the composer's place (ADR-054 §5), with what the dock needs to decide it. */
export interface DockedApproval {
  readonly request: PermissionRequestView;
  readonly harness: string;
  /** How many approvals of the conversation wait, this one included. */
  readonly waiting: number;
  /** The program's own approval rule, by its name, when its configuration reports one. */
  readonly policy?: string | undefined;
  readonly onDecision: (option: string, keyboard: boolean) => void;
}
interface ComposerProps extends ChatProps {
  readonly active: PublicRun | null;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly problem: string | null;
  readonly blocked: boolean;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
  readonly onSendDraft: (text: string) => Promise<void>;
  /** The oldest approval of the conversation still waiting; while there is one, it takes the composer's place. */
  readonly approval: DockedApproval | null;
  /** Rows between the notices and the composer: the held message and the plan bar. */
  readonly above?: ReactNode;
  /** The line under the composer: round, steps, time and the usage the Gateway reported. */
  readonly below?: ReactNode;
  /** The Agent list of the merged picker, which ⌘J opens. */
  readonly agentPickerOpen: boolean;
  readonly onAgentPickerOpen: (open: boolean) => void;
  /** ↑ in an empty composer: takes the held message back, or the last sent message as a draft. */
  readonly onEditLast?: (() => void) | undefined;
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
      value: row.id, label: row.name, icon: <BrandIcon brand={row.id} name={row.name} size={26}/>,
      group: available ? "本机可用" : "更多 Harness",
      // The version is a fact of the installation; nothing is said about it (ADR-053).
      description: [version ? `v${version}` : row.controls.filter(item => item.available).map(item => protocolLabel(item.protocol)).join(" / "),
        available && seen?.startupMs !== undefined ? "启动约 " + approximately(seen.startupMs) : ""].filter(Boolean).join(" · "),
      ...(status ? { status } : {}),
      disabled: !available, reason: row.installed ? "已发现程序，控制入口尚未就绪" : "尚未安装，可在“我的 Agent”中查看安装方式",
    };
  }).sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
}

/** One clickable part of the merged picker: the hovered part takes the hover fill inside the chip's lighter one. */
const SEGMENT = "h-[30px] max-w-none rounded-row px-1.5 outline-offset-[-2px] hover:bg-hover data-[popup-open]:bg-hover";
/** The small blue pill of a native option inside the merged picker (the thinking level, or the mode). */
function Pill({ children }: { readonly children: ReactNode }) {
  return <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-[7px] text-[11px] leading-4 font-medium whitespace-nowrap text-accent-text">{children}</span>;
}

/**
 * The message box of design language 2.0 (Main and Conversation boards): radius 28 with the three-layer shadow, blue when
 * focused; attachments and the approval rule at the bottom left, the merged picker (Agent · connection · model · thinking ·
 * mode, each opening its own list) and the send key at the bottom right. While a reply runs the send key turns into the
 * stop key and back (Motion board #16, #17); the next message can be written and held. While an approval waits, the same
 * box turns into it (#20: its height in 300 ms, the amber ring in 200 ms, the contents cross-fade; back in 200 ms) and the
 * draft waits under it. Typing / opens the native commands, @ adds a file, ↑ in an empty box edits the last message.
 */
export function Composer(props: ComposerProps) {
  const { draft, harnesses, providers, session, active, dirty, pending, problem, blocked, inputRef, approval } = props;
  const sending = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const dockLayer = useRef<HTMLDivElement>(null);
  const listId = useId();
  const reduced = useReducedMotion();
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
  const canAttach = !readonly && props.attachments.length < 8;
  const unknown = session?.runs.filter(run => run.status === "unknown") ?? [];
  const lastSwitch = session?.switches.at(-1);
  const selectionFailed = props.error !== null || lastSwitch?.status === "failed" && JSON.stringify(lastSwitch.requested) === JSON.stringify({ harnessId: draft.harnessId, controlId: draft.controlId,
    provider: draft.providerId && draft.providerRevision !== null ? { providerId: draft.providerId, revision: draft.providerRevision, model: draft.model } : null,
    ...(!draft.providerId && draft.model ? { nativeModel: draft.model } : {}) });
  const resourcesUnconfirmed = unknown.some(run => run.cleanup?.closed !== true);
  const outdated = provider !== undefined && draft.providerRevision !== null && provider.revision !== draft.providerRevision;
  const docked = approval !== null;

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

  // #20: the box keeps its height while one layer replaces the other, then moves to the new one (300 ms out to the dock,
  // 200 ms back). Reduced motion and decisions taken from the keyboard swap at once.
  const settledHeight = useRef<number | null>(null), morphing = useRef(false), instant = useRef(false);
  useLayoutEffect(() => {
    const node = box.current; if (!node) return;
    const observer = new ResizeObserver(() => { if (!morphing.current) settledHeight.current = node.offsetHeight; });
    observer.observe(node); settledHeight.current = node.offsetHeight;
    return () => observer.disconnect();
  }, []);
  const firstDock = useRef(true), closedAtOnce = useRef(false);
  useLayoutEffect(() => {
    const node = box.current, from = settledHeight.current;
    if (firstDock.current) { firstDock.current = false; return; }
    if (!node || from === null) return;
    const to = node.offsetHeight, skip = reduced || instant.current;
    closedAtOnce.current = !docked && instant.current; instant.current = false;
    // Focus that was in the dock (or fell to the page when it closed) goes back to the message.
    if (!docked) { const focused = document.activeElement; if (focused === null || focused === document.body || dockLayer.current?.contains(focused)) inputRef.current?.focus({ preventScroll: true }); }
    if (skip || Math.abs(from - to) < 1) { settledHeight.current = to; return; }
    morphing.current = true;
    const duration = docked ? 300 : 200;
    node.style.height = from + "px"; node.style.overflow = "hidden";
    void node.offsetHeight;
    node.style.transition = `height ${duration}ms var(--ease-out)`; node.style.height = to + "px";
    const done = () => { node.style.height = ""; node.style.overflow = ""; node.style.transition = ""; morphing.current = false; settledHeight.current = node.offsetHeight; };
    const timer = setTimeout(done, duration + 40);
    return () => { clearTimeout(timer); done(); };
  }, [docked]);
  const dockPresence = usePresence(docked, 300, 200);
  const shownApproval = useRef<DockedApproval | null>(null);
  if (approval) shownApproval.current = approval;
  // A decision from the keyboard closes the dock at once (Motion board #37): no leaving layer is drawn.
  const dockShown = approval ?? (dockPresence === "closing" && !instant.current && !closedAtOnce.current ? shownApproval.current : null);
  // Who should hold the focus when a request takes the dock: it takes it from the composer (and for a moment treats keys
  // as meant for the message being typed), or keeps it when the previous request had it. Read before `inert` moves it.
  const form = useRef<HTMLFormElement>(null), dockFocus = useRef<{ readonly id: string | null; readonly mode: "guarded" | "plain" | null }>({ id: null, mode: null });
  if ((approval?.request.id ?? null) !== dockFocus.current.id) {
    const focused = document.activeElement, previous = dockFocus.current.id;
    dockFocus.current = { id: approval?.request.id ?? null, mode: approval === null ? null
      : previous === null ? form.current?.contains(focused) ? "guarded" : null
      : dockLayer.current?.contains(focused) || focused === document.body ? "plain" : null };
  }

  const send = async () => {
    if (canQueue) { props.onQueue!(); return; }
    if (disableSend || sending.current) return;
    sending.current = true;
    try { await props.onSendDraft(props.messageDraft); }
    catch { /* The parent owns the request and its error; an unconfirmed send retains the draft. */ }
    finally { sending.current = false; }
  };
  // The picker offers what the user can start with (ADR-050); the current choice is never among the hidden ones.
  const harnessChoices = harnessOptions(harnesses.filter(row => !props.hiddenHarnesses.has(row.id)), props.readiness, draft);
  const providerOptions: PickerOption[] = [{ value: "", label: "Harness 原生连接", short: "原生连接", description: "由 Harness 提供模型连接，需要完成相应认证", icon: <LogoMark size={18}/> }, ...providers.map(row => {
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
  // Native options belong to the Harness's own connection: a managed Provider's model takes none of them.
  const nativeOptions = draft.providerId ? [] : [...(props.nativeModels?.options ?? []), ...(props.nativeModels?.models.find(model => model.id === (draft.model || props.nativeModels?.defaultModel))?.options ?? [])];
  const thought = nativeOptions.find(option => option.category === "thought_level");
  // The merged picker shows one pill, as the boards do: the thinking level, or the mode where there is no thinking level
  // (OpenCode's Build). With both, the mode is among the execution settings.
  const mode = nativeOptions.find(option => option.category === "mode");
  const modeInChip = mode !== undefined && thought === undefined;
  // The program's own approval rule (Codex's approval policy) sits at the bottom left; its sandbox and the rest stay in the settings.
  const permission = nativeOptions.find(option => option.category === "permission");
  const changeOption = (id: string, value: string) => { const choices = { ...draft.nativeOptions }; if (value) choices[id] = value; else delete choices[id]; props.onDraft({ ...draft, nativeOptions: Object.fromEntries(Object.entries(choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }); };
  const valueName = (option: typeof nativeOptions[number], value: string) => (option.category === "thought_level" ? THINKING_NAMES[value] : undefined) ?? option.values.find(row => row.value === value)?.name ?? value;
  const optionChoices = (option: typeof nativeOptions[number], short: boolean): PickerOption[] => [{ value: "", label: `${valueName(option, option.currentValue)} · 本机默认`, ...(short ? { short: valueName(option, option.currentValue) } : {}), group: "跟随 Harness" },
    ...option.values.map(value => ({ value: value.value, label: option.category === "thought_level" ? THINKING_NAMES[value.value] ?? value.name : value.name, description: lastUsed(value.value, recalled?.nativeOptions?.[option.id]) ?? value.value, group: harness?.name ?? "原生选项" }))];
  const optionPicker = (option: typeof nativeOptions[number], label: string, extra?: { readonly prefix?: string; readonly className?: string }) => <SearchPicker label={label} value={draft.nativeOptions[option.id] ?? ""} placeholder="跟随本机配置" {...extra}
    options={optionChoices(option, extra?.prefix !== undefined)} disabled={disabled || props.nativeModelsLoading} onChange={value => changeOption(option.id, value)}/>;
  // The native session's own values, as it reported them after its last Turn (ADR-028).
  const nativeState = provider ? undefined : session?.nativeStates?.find(state => state.harnessId === draft.harnessId && state.controlId === draft.controlId);
  const describeNative = (model: string | undefined, options: Readonly<Record<string, string>> | undefined) => [
    ...(model ? ["模型 " + (props.nativeModels?.models.find(row => row.id === model)?.name ?? model)] : []),
    ...Object.entries(options ?? {}).filter(([id]) => nativeOptions.some(row => row.id === id)).map(([id, value]) => (OPTION_NAMES[id] ?? nativeOptions.find(row => row.id === id)?.name ?? id) + " " + valueName(nativeOptions.find(row => row.id === id)!, value)),
  ].join("、");
  const carried = !dirty && !pending && !blocked && nativeState?.carried ? describeNative(nativeState.carried.model, nativeState.carried.options) : "";
  const onboarding = session === null && draft.harnessId === "";
  const authMissing = !draft.providerId && props.nativeModels?.authentication === "missing";
  const noteDanger = bytes > 64 * 1024 || problem !== null && !onboarding;
  const note = bytes > 64 * 1024 ? "单条消息不能超过 64 KiB，请缩短内容。"
    : active?.cancelRequested ? "停止已受理，正在等待执行结束和资源清理。"
    : blocked && !readonly ? resourcesUnconfirmed ? "资源停止还未确认。你可以编辑草稿、查看历史；核实后再恢复执行。" : "选择可用的 Harness 后，检查连接并继续这次对话。"
    : pending ? active ? "当前回复结束后应用新选择，草稿已保留。" : "正在保存下一条消息的选择。"
    : dirty ? problem ?? (selectionFailed ? "所选连接未生效，可以重试切换或选择其他 Harness。" : "正在切换所选 Harness 或模型，草稿已保留。")
    : authMissing ? SETUP_COMMANDS[draft.harnessId]
      ? `${harness?.name ?? "所选 Harness"} 的本机认证尚未就绪：它还没有可用的模型提供方。请在终端运行 ${SETUP_COMMANDS[draft.harnessId]} 完成配置，然后刷新本机模型；也可以切换其他 Harness。`
      : "所选 Harness 的本机认证尚未就绪。请在它自己的程序中完成登录或 Gateway 连接配置，然后刷新本机模型；也可以切换其他 Harness。"
    : uploading ? "附件上传中，完成后即可发送。"
    : attachmentBlocked ? "有附件无法随这条消息发送，请移除标记的附件或切换到支持它的 Harness 或模型。"
    : props.attachments.length && !props.messageDraft.trim() ? "请写一句说明，再和附件一起发送。"
    // Codex's collaboration mode stays with its thread: plan mode answers with a plan, and following the native configuration
    // does not leave it (ADR-034).
    : !draft.providerId && draft.nativeOptions.collaboration_mode === "plan" ? `计划模式：${harness?.name ?? "Harness"} 先给出方案。要让它执行，把协作模式改为“默认”后再发送。`
    // The previous service ended without closing this conversation's kept process; what this one found at start is said
    // here until the conversation's next Turn (ADR-030).
    : session?.retention?.lost ? session.retention.lost.outcome === "unconfirmed"
      ? "服务上次异常退出，无法确认这个对话保留的后台进程已经结束，工作区保持隔离。请检查并结束相关进程。"
      : `服务上次异常退出，这个对话保留的后台进程${session.retention.lost.outcome === "terminated" ? "已被清理" : "已随之结束"}（没有恢复）。下一条消息会重新启动原程序，并恢复原生会话。${session.retention.outside ? `原程序的后台任务可能仍在运行（${session.retention.outside.count} 个进程）。` : ""}`
    // An upgrade of this Harness closed the conversation's kept process; said until its next Turn (ADR-043).
    : session?.retention?.upgraded ? `升级 ${harnesses.find(row => row.id === session.retention!.upgraded!.harnessId)?.name ?? session.retention.upgraded.harnessId} 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序，并恢复原生会话。`
    // Processes the closed program had moved out of its own group are left alone; the conversation hears of them once.
    : session?.retention?.outside ? `原程序的后台任务可能仍在运行（${session.retention.outside.count} 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。`
    : !draft.providerId && draft.nativeOptions.collaboration_mode === undefined && nativeState?.observed?.options.collaboration_mode === "plan" ? `这个 ${harness?.name ?? "Harness"} 线程仍为计划模式：跟随本机配置不会改回，把协作模式改为“默认”即可退出。`
    : active && props.queued === null && props.messageDraft.trim() ? "回复进行中：按 Enter 先暂存这条消息，本轮正常结束后自动发出。"
    : problem;
  // The pending or failed switch speaks for itself in its own strip, and the blocked conversation in its notice; before any
  // Agent is chosen, the merged picker's "选择 Harness" already says what is missing.
  const noteShown = note !== null && !(pending || dirty && !blocked) && !(blocked && !readonly) && !(onboarding && note === problem) && !docked;
  // While a switch is saved or waits for the reply to end, its strip is what the message is described by.
  const stripNotice = (pending || dirty && !blocked) && !blocked && !(selectionFailed && !pending) && problem === null;

  // / at the start of the message lists the program's own commands; @ at the start of a word adds a file.
  const commands = props.nativeModels?.commands ?? [];
  const slashQuery = /^\/(\S*)$/u.exec(props.messageDraft)?.[1];
  const [slashClosedAt, setSlashClosedAt] = useState<string | null>(null);
  const slashMatches = slashQuery === undefined ? [] : commands.filter(command => command.name.toLocaleLowerCase().includes(slashQuery.toLocaleLowerCase())).slice(0, 50);
  const slashOpen = slashQuery !== undefined && commands.length > 0 && slashClosedAt !== props.messageDraft && !docked && !disabled;
  const [slashActive, setSlashActive] = useState(0);
  const slashIndex = Math.min(slashActive, Math.max(0, slashMatches.length - 1));
  useEffect(() => { setSlashActive(0); }, [slashQuery]);
  const chooseCommand = (name: string) => { props.onMessageDraft("/" + name + " "); setSlashClosedAt(null); inputRef.current?.focus(); };
  const [mention, setMention] = useState<number | null>(null);
  const mentionOpen = mention !== null && props.messageDraft[mention] === "@" && canAttach && !docked;
  const chooseFile = (at: number | null) => {
    if (at !== null && props.messageDraft[at] === "@") props.onMessageDraft(value => value[at] === "@" ? value.slice(0, at) + value.slice(at + 1) : value);
    setMention(null); picker.current?.click();
  };

  const takeOver = harness ? session && session.selection.harnessId !== draft.harnessId ? `由 ${harness.name} 接手` : "改用新的模型与设置" : "改用新的选择";
  const placeholder = readonly ? "对话已关闭，历史仍可查看" : blocked ? "先写下想继续的内容，恢复后发送…" : active ? "回复进行中，可以先写下一条…" : session ? "继续这段对话…"
    : harness ? `让 ${harness.name} 做什么？${commands.length ? "用 / 调原生命令，" : ""}@ 引用文件` : "说说你想完成的事…";
  const thinkingShown = thought ? valueName(thought, draft.nativeOptions[thought.id] ?? thought.currentValue) : null;
  const modeShown = mode ? valueName(mode, draft.nativeOptions[mode.id] ?? mode.currentValue) : null;
  const showProvider = props.providerManagement !== false || draft.providerId !== "";
  const segments = ["agent", ...(showProvider ? ["provider"] : []), ...(draft.harnessId ? ["model"] : []), ...(thought ? ["thought"] : []), ...(modeInChip ? ["mode"] : [])];
  const last = segments.at(-1);
  const pickAgent = (value: string) => {
    if (value === draft.harnessId) return;
    const next = harnesses.find(row => row.id === value), previous = [...(session?.switches ?? [])].reverse().find(change => change.status === "effective" && change.target?.harnessId === value)?.target ?? [...(session?.runs ?? [])].reverse().find(run => run.selection.harnessId === value)?.selection ?? props.rememberedChoice?.(value) ?? undefined;
    const control = previous && next?.controls.some(row => row.id === previous.controlId && row.available) ? previous.controlId : next?.controls.find(row => row.id === next.defaultControlId && row.available)?.id ?? next?.controls.find(row => row.available)?.id ?? "";
    props.onDraft({ ...draft, harnessId: value, controlId: control, model: draft.providerId ? draft.model : previous?.nativeModel ?? "", nativeOptions: draft.providerId ? {} : previous?.nativeOptions ?? {} });
  };

  return <div className="composer-wrap flex flex-col gap-2">
    {/* Notices above the box: what waits, what is unavailable and why, with at most two ways forward (Interaction board). */}
    {pending || dirty && !blocked ? <div className="composer-change motion-fade-in flex flex-wrap items-center gap-2" role="status">
      {selectionFailed && !pending ? <><span className="text-ui-sm text-red">{problem ?? "所选连接尚未生效"}</span><button type="button" className="btn btn-sm" onClick={props.onApply} disabled={props.mutation !== null || problem !== null}>重试切换</button></>
        : problem !== null ? <ComposerNotice>{problem}</ComposerNotice>
        : active ? <span className="inline-flex h-[30px] items-center gap-2 rounded-control bg-accent-soft px-2.5 text-caption text-accent-text"><ArrowLeftRight size={14} aria-hidden="true"/><span id={stripNotice ? "composer-notice" : undefined}>本轮结束后{takeOver}</span></span>
        : <span className="inline-flex h-[30px] items-center gap-2 px-1 text-caption text-fg-2"><Spinner size={13} label=""/><span id={stripNotice ? "composer-notice" : undefined}>正在保存选择</span></span>}
    </div> : null}
    {carried && !readonly && !docked ? <div className="composer-change native-carried motion-fade-in flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-caption text-fg-2" role="status"><span>原生命令已改为 {carried}；下一回合沿用，不改回所选。</span><button type="button" className="link-btn" onClick={props.onApply} disabled={disabled || props.mutation !== null}>改用所选设置</button></div> : null}
    {blocked && !readonly ? <ComposerNotice title="执行已暂停，对话历史和草稿仍保留。" action={<button type="button" className="btn btn-sm" onClick={props.onApply} disabled={disabled || pending || props.mutation !== null || problem !== null || resourcesUnconfirmed}><RefreshCw size={12}/>{unknown.length ? "确认保留未知结果并继续" : "检查连接并恢复对话"}</button>}>
      <p id="composer-notice" className="m-0" role="status">{unknown.length ? "上一轮结果未知，不会自动重发。" : ""}{note}</p></ComposerNotice> : null}
    {noteShown ? noteDanger || authMissing ? <ComposerNotice action={authMissing || problem !== null ? <>
        {authMissing ? <button type="button" className="btn btn-sm" onClick={props.onRefreshModels}>刷新本机模型</button> : <button type="button" className="btn btn-sm" onClick={props.onHarnesses}>查看原因</button>}
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => props.onAgentPickerOpen(true)}>换一个 Agent</button></> : undefined}>
        <p id="composer-notice" className="composer-note m-0" role="status">{note}</p></ComposerNotice>
      : <p id="composer-notice" className="composer-note motion-fade-in m-0 px-1 text-caption text-fg-2">{note}</p> : null}
    {!draft.providerId && props.nativeModelsError && !selectionFailed && !docked ? <p className="composer-note m-0 px-1 text-caption text-fg-2" role="status">{props.nativeModelsError} <button type="button" className="link-btn" onClick={props.onRefreshModels}>刷新模型</button></p> : null}
    {props.above}
    <div className="relative">
      {slashOpen ? <div className="surface-pop motion-fade-in absolute bottom-[calc(100%+8px)] left-0 z-20 flex max-h-[min(320px,50vh)] w-[min(400px,100%)] flex-col overflow-hidden" style={motionStyle({ duration: 120 })}>
        <div className="px-3.5 pt-2.5 pb-1 text-caption text-fg-3">{harness?.name ?? "Agent"} 的原生命令</div>
        <div className="scroll-area min-h-0 p-[5px]" id={listId} role="listbox" aria-label="原生命令">
          {slashMatches.length ? slashMatches.map((command, index) => <button key={command.name} type="button" role="option" id={`${listId}-${index}`} aria-selected={index === slashIndex} tabIndex={-1}
            onPointerMove={() => setSlashActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => chooseCommand(command.name)}
            className={cn("flex w-full items-baseline gap-2.5 rounded-[9px] border-none bg-transparent px-2.5 py-[7px] text-left", index === slashIndex && "bg-subtle")}>
            <span className="mono flex-none text-ui-sm font-medium">/{command.name}</span><span className="min-w-0 truncate text-caption text-fg-3">{command.description}</span>
          </button>) : <p className="m-0 px-3 py-4 text-center text-ui-sm text-fg-3">没有匹配的命令</p>}
        </div>
        <div className="px-3.5 py-2 text-caption text-fg-3 hairline-t">↑ ↓ 选择 · Enter 填入 · Esc 关闭</div>
      </div> : null}
      {mentionOpen ? <div className="surface-pop motion-fade-in absolute bottom-[calc(100%+8px)] left-0 z-20 flex w-[min(360px,100%)] flex-col overflow-hidden" style={motionStyle({ duration: 120 })}>
        <div role="listbox" aria-label="引用文件" id={listId} className="p-[5px]">
          <button type="button" role="option" id={`${listId}-file`} aria-selected="true" tabIndex={-1} onMouseDown={event => event.preventDefault()} onClick={() => chooseFile(mention)}
            className="flex w-full items-center gap-2.5 rounded-[9px] border-none bg-subtle px-2.5 py-2 text-left"><Paperclip size={15} className="flex-none text-fg-2" aria-hidden="true"/>
            <span className="flex min-w-0 flex-col"><span className="text-ui-sm font-medium">从这台电脑选择文件…</span><span className="text-caption text-fg-3">作为附件随这条消息发出；HarnessHub 不浏览工作区目录</span></span></button>
        </div>
        <div className="px-3.5 py-2 text-caption text-fg-3 hairline-t">Enter 选择 · Esc 保留 @ 作为文字</div>
      </div> : null}
      <div ref={box} className={cn("composer-box relative rounded-composer bg-surface transition-[box-shadow] duration-200 ease-standard",
        docked ? "shadow-[0_0_0_1.5px_var(--amber-dot),0_0_0_5px_var(--amber-soft),var(--sh-composer)]"
          : dragging ? "shadow-focus" : "shadow-composer has-[.composer:focus-within]:shadow-focus")}>
        <form ref={form} className={cn("composer flex flex-col rounded-composer pt-4 pr-2.5 pb-2.5 pl-5 ease-standard", session ? "gap-2.5" : "gap-3",
          docked ? "invisible pointer-events-none absolute inset-x-0 bottom-0 -translate-y-1 opacity-0 transition-[opacity,translate,visibility] duration-100"
            : "visible translate-y-0 opacity-100 transition-[opacity,translate] delay-100 duration-100", dragging && "is-dropping")}
          aria-label={session ? "继续对话" : "新对话"} aria-hidden={docked || undefined} inert={docked}
          onSubmit={event => { event.preventDefault(); void send(); }}
          onDragOver={event => { if (!readonly && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); if (!readonly) attach(event.dataTransfer.files); } }}>
          <label className="sr-only" htmlFor="message-input">发送消息</label>
          {props.attachments.length ? <ComposerAttachments items={props.attachments} inputs={inputs} disabled={props.mutation === "sending"} onRemove={props.onRemoveAttachment}/> : null}
          <textarea id="message-input" ref={inputRef} rows={session ? 1 : 2} value={props.messageDraft} disabled={readonly} placeholder={placeholder}
            aria-describedby={noteShown || blocked && !readonly || stripNotice ? "composer-notice composer-keyboard-hint" : "composer-keyboard-hint"} aria-autocomplete={commands.length ? "list" : undefined}
            aria-controls={slashOpen || mentionOpen ? listId : undefined} aria-activedescendant={slashOpen && slashMatches.length ? `${listId}-${slashIndex}` : mentionOpen ? `${listId}-file` : undefined}
            className={cn("w-full resize-none border-none bg-transparent p-0 text-[15px] leading-6 text-fg outline-none placeholder:text-placeholder disabled:opacity-60", session ? "min-h-6" : "min-h-12")}
            onChange={event => {
              const value = event.target.value, caret = event.target.selectionStart;
              // "@" typed at the start of a word offers a file; anywhere else it stays text.
              setMention(value.length === props.messageDraft.length + 1 && /(?:^|\s)@$/u.test(value.slice(0, caret)) ? caret - 1 : null);
              props.onMessageDraft(value);
            }}
            onPaste={event => {
              // Pasted screenshots and files become attachments; pasted text keeps its normal behavior.
              if (event.clipboardData.files.length) { event.preventDefault(); attach(event.clipboardData.files); }
            }} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
              if (slashOpen) {
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashMatches.length) { event.preventDefault(); setSlashActive((slashIndex + (event.key === "ArrowDown" ? 1 : -1) + slashMatches.length) % slashMatches.length); return; }
                if ((event.key === "Enter" && !event.shiftKey || event.key === "Tab" && plain) && slashMatches[slashIndex]) { event.preventDefault(); chooseCommand(slashMatches[slashIndex]!.name); return; }
                if (event.key === "Escape") { event.preventDefault(); setSlashClosedAt(props.messageDraft); return; }
              }
              if (mentionOpen) {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); chooseFile(mention); return; }
                if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
              }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
              else if (event.key === "Escape" && active && !active.cancelRequested && props.mutation === null) { event.preventDefault(); props.onCancel(); }
              else if (event.key === "ArrowUp" && plain && props.messageDraft === "" && props.onEditLast) { event.preventDefault(); props.onEditLast(); }
            }}
            onBlur={() => setMention(null)}/>
          <p id="composer-keyboard-hint" className="sr-only">Enter 发送，Shift+Enter 换行{commands.length ? "，/ 原生命令" : ""}，@ 添加文件，输入框为空时 ↑ 编辑上一条{active ? "，Esc 或 ⌘. 停止当前回复" : ""}</p>
          <input ref={picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={event => { attach(event.target.files); event.target.value = ""; }}/>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
            <div className="-ml-2 flex flex-none items-center gap-0.5" role="group" aria-label="附件、权限与原生会话">
              <Menu side="top" align="start" trigger={<button type="button" className="press mr-0.5 flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border-none bg-subtle text-fg-2 transition-colors duration-120 ease-standard hover:bg-hover hover:text-fg disabled:opacity-45"
                aria-label="添加文件或上下文" disabled={readonly}><Plus size={16} strokeWidth={1.9}/></button>} items={[
                { label: "添加文件或图片…", icon: <Paperclip size={15}/>, hint: "@", disabled: !canAttach, onSelect: () => picker.current?.click() },
                ...(commands.length ? [{ label: "原生命令", icon: <SquareSlash size={15}/>, hint: "/", disabled: disabled, onSelect: () => { setSlashClosedAt(null); props.onMessageDraft("/"); setTimeout(() => inputRef.current?.focus(), 0); } }] : []),
              ]} footer={props.attachments.length >= 8 ? "每条消息最多 8 个附件" : undefined}/>
              {permission ? <SearchPicker label={OPTION_NAMES[permission.id] ?? permission.name} value={draft.nativeOptions[permission.id] ?? ""} placeholder="跟随本机配置" options={optionChoices(permission, true)}
                disabled={disabled || props.nativeModelsLoading} onChange={value => changeOption(permission.id, value)} chevron className="gap-[5px] text-fg-2"
                trigger={selected => <><ShieldCheck size={15} className="flex-none" aria-hidden="true"/><span className="hidden max-w-[140px] truncate sm:inline">{selected?.short ?? selected?.label ?? valueName(permission, permission.currentValue)}</span></>}/> : null}
              {!draft.providerId && draft.harnessId && props.onLoadNativeSessions && props.onImportNative && props.onOpenSession ? <NativeSessionsPanel key={"sessions:" + draft.harnessId + ":" + draft.controlId} load={props.onLoadNativeSessions}
                disabled={disabled || props.mutation !== null} onImport={props.onImportNative} onOpen={props.onOpenSession}/> : null}
              {!draft.providerId && draft.harnessId && props.onLoadExtensions ? <NativeExtensionsPanel key={draft.harnessId + ":" + draft.controlId} load={props.onLoadExtensions} disabled={disabled} onCommand={command => { props.onMessageDraft("/" + command + " "); inputRef.current?.focus(); }}/> : null}
              {draft.harnessId ? <AdvancedSettings {...props} controls={controls} selectedControl={selectedControl} outdated={outdated} disabled={disabled} nativeOptions={nativeOptions.filter(option => option !== thought && !(option === mode && modeInChip) && option !== permission)} optionPicker={optionPicker} nativeState={nativeState} describeNative={describeNative}/> : null}
            </div>
            <div className="ml-auto flex max-w-full min-w-0 items-center gap-1">
              <div className="agent-chip flex h-[34px] max-w-full min-w-0 items-center overflow-x-auto rounded-[12px] p-0.5 transition-colors duration-120 ease-standard [scrollbar-width:none] hover:bg-subtle has-[[data-popup-open]]:bg-subtle [&::-webkit-scrollbar]:hidden [&>*]:flex-none"
                role="group" aria-label="由谁来做：Agent、模型与思考强度">
                <SearchPicker label="选择 Harness" value={draft.harnessId} placeholder="选择 Harness" options={harnessChoices} disabled={disabled} wide size="lg" align="end" chevron={last === "agent"}
                  title={<span className="flex items-center gap-1">由谁来做 · <Kbd>⌘</Kbd><Kbd>J</Kbd></span>} open={props.agentPickerOpen} onOpenChange={props.onAgentPickerOpen} className={cn(SEGMENT, "gap-[7px] pl-1")}
                  footer={<span>↑ ↓ 选择 · Enter 确认 · 模型和思考强度在旁边的按钮里换</span>}
                  trigger={selected => selected && harness ? <><BrandIcon brand={harness.id} name={harness.name} size={22}/><span className="max-w-[150px] truncate font-medium text-fg">{selected.label}</span></>
                    : <span className="text-fg-2">选择 Harness</span>} onChange={pickAgent}/>
                {showProvider ? <SearchPicker label="选择 Provider" value={draft.providerId} placeholder="选择 Provider" options={providerOptions} disabled={disabled} align="end" chevron={last === "provider"} className={cn(SEGMENT, "gap-1.5")}
                  trigger={selected => <>{selected?.icon ? <span className="flex flex-none items-center">{selected.icon}</span> : null}<span className="max-w-[140px] truncate text-fg-2">{selected?.short ?? selected?.label ?? "选择 Provider"}</span></>}
                  onChange={value => { const next = providers.find(row => row.id === value); props.onDraft({ ...draft, providerId: next?.id ?? "", providerRevision: next?.revision ?? null, model: next?.defaultModel ?? "", nativeOptions: {} }); }}
                  footer={<button type="button" className="link-btn text-caption" onClick={props.onProviders}>管理模型连接</button>}/> : null}
                {draft.harnessId ? <SearchPicker label="选择模型" value={draft.model} placeholder="选择模型" options={modelOptions} disabled={disabled || !provider && !props.nativeModels?.canSelect} align="end" chevron={last === "model"} className={SEGMENT}
                  trigger={selected => <span className="max-w-[160px] truncate text-fg-3">{selected?.short ?? selected?.label ?? "选择模型"}</span>}
                  onChange={value => {
                    if (value === draft.model) return;
                    const independent = Object.fromEntries(Object.entries(draft.nativeOptions).filter(([id]) => nativeOptions.some(option => option.id === id && option.category !== "thought_level")));
                    props.onDraft({ ...draft, model: value, nativeOptions: independent });
                  }} footer={!provider ? <><span>{props.nativeModelsLoading ? "正在读取本机模型…" : "列表来自本机安装"}</span><button type="button" className="link-btn text-caption" onClick={props.onRefreshModels}>刷新本机模型</button></> : undefined}/> : null}
                {thought ? <SearchPicker label="思考强度" value={draft.nativeOptions[thought.id] ?? ""} placeholder="跟随本机配置" options={optionChoices(thought, true)} disabled={disabled || props.nativeModelsLoading} align="end" chevron={last === "thought"}
                  className={cn(SEGMENT, "px-1")} trigger={() => <Pill>思考 {thinkingShown}</Pill>} onChange={value => changeOption(thought.id, value)}/> : null}
                {mode && modeInChip ? <SearchPicker label={OPTION_NAMES[mode.id] ?? mode.name} value={draft.nativeOptions[mode.id] ?? ""} placeholder="跟随本机配置" options={optionChoices(mode, true)} disabled={disabled || props.nativeModelsLoading} align="end" chevron={last === "mode"}
                  className={cn(SEGMENT, "px-1")} trigger={() => <Pill>{modeShown}</Pill>} onChange={value => changeOption(mode.id, value)}/> : null}
              </div>
              {canQueue ? <Tip label="本轮结束后发送（Enter）"><button type="button" className="press flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border-none bg-subtle text-fg-2 transition-colors duration-120 ease-standard hover:bg-hover hover:text-fg"
                aria-label="本轮结束后发送" onClick={() => props.onQueue?.()}><ListPlus size={16}/></button></Tip> : null}
              <Tip label={active ? "停止当前回复（⌘.）" : "发送（Enter）"}><button type={active ? "button" : "submit"} aria-label={active ? "停止当前回复" : "发送消息"}
                className={cn("press ml-0.5 flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full border-none transition-[background-color,opacity] duration-200 ease-standard disabled:cursor-default",
                  active ? "bg-fg text-app disabled:opacity-45" : "bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-35")}
                disabled={active ? active.cancelRequested || props.mutation !== null : disableSend} onClick={active ? props.onCancel : undefined}>
                {/* One glyph throughout, so the arrow turns into the square and back (#16, #17); sending and stopping only dim the key. */}
                <SendStopIcon stop={active !== null}/>
              </button></Tip>
            </div>
          </div>
        </form>
        {dockShown ? <div ref={dockLayer} className={cn("ease-standard", docked ? "motion-enter relative" : "pointer-events-none absolute inset-x-0 top-0 opacity-0 transition-opacity duration-100")}
          style={docked ? motionStyle({ delay: 80, shift: 4 }) : undefined} aria-hidden={!docked || undefined} inert={!docked}>
          <ApprovalDock key={dockShown.request.id} request={dockShown.request} harness={dockShown.harness} waiting={dockShown.waiting} policy={dockShown.policy} busy={props.mutation !== null}
            focus={approval !== null && dockFocus.current.id === approval.request.id ? dockFocus.current.mode : null}
            onDecision={(option, keyboard) => { if (keyboard) instant.current = true; dockShown.onDecision(option, keyboard); }}
            {...(active ? { onStop: props.onCancel, stopDisabled: active.cancelRequested || props.mutation !== null } : {})}/>
        </div> : null}
      </div>
    </div>
    {props.below}
  </div>;
}
/** A notice above the composer (Interaction board, "Agent 暂时不可用"): amber because it waits for the user, with at most two ways forward. */
function ComposerNotice({ title, children, action }: { readonly title?: ReactNode; readonly children: ReactNode; readonly action?: ReactNode }) {
  return <div className="composer-notice motion-fade-in flex items-start gap-2.5 rounded-block bg-amber-soft px-3 py-2.5 text-ui-sm text-fg">
    <TriangleAlert size={16} className="mt-0.5 flex-none text-amber" aria-hidden="true"/>
    <div className="min-w-0 flex-1">{title ? <strong className="block font-semibold text-amber">{title}</strong> : null}<div className={title ? "mt-0.5 text-fg-2" : undefined}>{children}</div>
      {action ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{action}</div> : null}</div>
  </div>;
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
  const row = "execution-setting flex flex-col gap-1.5 px-3.5 py-3 hairline-b last:border-b-0";
  const heading = "text-caption font-medium text-fg-3";
  return <Popover label="执行配置" side="top" align="start" className="composer-settings-panel w-[380px] max-w-[calc(100vw-24px)]"
    trigger={<button type="button" className="icon-btn relative text-fg-3" aria-label="高级配置" title="控制入口、原生选项与后台进程" disabled={disabled}><SlidersHorizontal size={16}/>{outdated ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-amber-dot"/> : null}</button>}>
    <PopHead title="执行配置" closeLabel="收起高级配置"/>
    {props.nativeOptions.map(option => <div className={cn(row, "native-setting")} key={option.id}><span className={heading}>{OPTION_NAMES[option.id] ?? option.name}</span><div className="-ml-2">{props.optionPicker(option, OPTION_NAMES[option.id] ?? option.name)}</div></div>)}
    {!provider && APPROVAL_NOTES[draft.harnessId] ? <div className={row}><span className={heading}>审批</span><small className="text-ui-sm text-fg-2">{APPROVAL_NOTES[draft.harnessId]}</small></div> : null}
    {controls.length > 1 ? <div className={row}><span className={heading}>控制入口</span><div className="-ml-2"><SearchPicker label="选择控制入口" value={draft.controlId} placeholder="控制入口" options={controls.map(control => ({ value: control.id, label: protocolLabel(control.protocol), description: control.id }))} disabled={disabled} onChange={value => props.onDraft({ ...draft, controlId: value, nativeOptions: {} })}/></div></div>
      : <div className={row}><span className={heading}>控制入口</span><span className="flex items-center gap-2 text-ui-sm"><strong className="font-medium">{selectedControl ? protocolLabel(selectedControl.protocol) : "尚未选择"}</strong>{draft.controlId ? <code className="text-caption text-fg-3">{draft.controlId}</code> : null}</span></div>}
    {provider && draft.providerRevision !== null ? <div className={row}><span className={heading}>Provider 配置</span><strong className="text-ui-sm font-medium">{provider.name} · v{draft.providerRevision}</strong>
      {outdated ? <button type="button" className="btn btn-sm self-start" disabled={disabled} onClick={() => props.onDraft({ ...draft, providerRevision: provider.revision, model: provider.models.includes(draft.model) ? draft.model : provider.defaultModel })}>使用最新 v{provider.revision}</button> : <small className="text-caption text-fg-3">会话固定使用这个版本。</small>}</div>
      : <p className="m-0 px-3.5 py-3 text-ui-sm text-fg-2 hairline-b">沿用本机已安装 Harness 的模型配置和登录状态。</p>}
    {!provider && props.onRetention ? <div className={cn(row, "kept-setting")}><span className={heading}>后台任务</span>
      <label className="flex items-center gap-2 text-ui-sm font-medium"><input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={session ? session.retention?.enabled === true : props.retainNew === true} disabled={disabled || props.mutation !== null} onChange={event => props.onRetention!(event.target.checked)}/>保持原生进程</label>
      <small className="text-caption text-fg-2">开启后，回合结束时不关闭原程序：它在后台运行的任务可以继续，下一条消息也不必重新启动它。空闲 30 分钟后结束，同时最多保留 4 个。</small>
      {session?.retention?.process ? <><small className="native-observed text-caption text-accent-text">原生进程保留中 · 后台活动 {session.retention.process.backgroundUpdates} 条 · {Math.max(1, Math.round((session.retention.process.idleEndsAt - Date.now()) / 60000))} 分钟后结束</small>
        <button type="button" className="btn btn-sm self-start" disabled={props.mutation !== null} onClick={props.onEndProcess}>结束后台进程</button></> : null}</div> : null}
    {nativeState ? <div className={row}><span className={heading}>原生会话</span><strong className="text-ui-sm font-medium">{nativeState.status === "ready" ? "继续已有会话" : "状态待确认"}</strong>
      {nativeState.observed ? <small className="native-observed text-caption text-fg-2">原生当前：{props.describeNative(nativeState.observed.model ?? undefined, nativeState.observed.options) || "未报告"}</small> : null}
      <small className="text-caption text-fg-3">公共历史与旧原生记录保留；原生内部状态重新建立。</small>
      <button type="button" className="btn btn-sm self-start" disabled={disabled || props.dirty || props.pending || props.active !== null} onClick={props.onNativeBranch}>重新建立原生会话</button>
      {nativeState.status === "ready" && session && props.onShowResume ? <button type="button" className="link-btn self-start text-ui-sm" onClick={props.onShowResume}>在原程序中继续的方式…</button> : null}</div> : null}
    <p className="m-0 bg-subtle px-3.5 py-2.5 text-caption text-fg-3">选择后直接切换；当前回复继续使用原配置，下一次发送使用新选择。</p>
  </Popover>;
}
