import { Download, Link2, Link2Off, Power, PowerOff, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityRestoreCheck, InstructionCheckOption } from "../../../src/contracts/capabilities.js";
import { errorMessage, requestKey, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Fact, Notice, Spinner } from "../ui/primitives.js";

/** A skill to turn off (`enabled` false) or on in one Harness; `via` is the copy Codex switches by its path. */
export interface SwitchRequest { readonly harnessId: string; readonly harnessName: string; readonly name: string; readonly enabled: boolean; readonly via: string | null }
/**
 * One change to confirm: its title, the word on its button, how to prepare its check (with what the user has said to a
 * blocked check so far), and the message once it is done. `on` picks the button's icon: turning something on (true), off
 * (false), or a change of links (null).
 */
export interface ChangeRequest { readonly title: string; readonly verb: string; readonly on: boolean | null; readonly done: string; readonly load: (options: readonly InstructionCheckOption[]) => Promise<CapabilityChangeCheck>;
  /** The button's icon for a change of skill folders. */ readonly icon?: "add" | "update" | "delete" | "undo" }

const NOTHING_SAID: readonly InstructionCheckOption[] = [];
const OWNER: Readonly<Record<CapabilityChangeCheck["current"], string>> = { harnesshub: "HarnessHub 之前写的", other: "不是 HarnessHub 写的", none: "还没有这项设置" };
const SOURCE_OWNER: Readonly<Record<CapabilityChangeCheck["current"], string>> = { harnesshub: "HarnessHub 安装的", other: "npx skills 的 lock 里有记录", none: "没有来源记录" };
const PLAN_ACTION: Readonly<Record<NonNullable<CapabilityChangeCheck["skills"]>[number]["action"], string>> = { add: "新增", update: "更新", delete: "删除", restore: "放回" };
function bytes(value: number): string { return value < 1024 ? value + " B" : value < 1024 * 1024 ? (value / 1024).toFixed(1) + " KB" : (value / 1024 / 1024).toFixed(1) + " MB"; }
/** The skill folders a change adds, replaces, removes or puts back, with what each holds and the files an update changes. */
function SkillPlans({ check }: { readonly check: CapabilityChangeCheck }) {
  if (!check.skills?.length) return null;
  return <ul className="skill-plans m-0 flex list-none flex-col gap-1.5 p-0">{check.skills.map(plan => <li key={plan.folder} className="flex flex-col gap-1 rounded-lg border border-line px-3 py-2 text-[12.5px]">
    <span className="flex flex-wrap items-baseline gap-x-2"><strong className="font-medium">{PLAN_ACTION[plan.action]} {plan.name}</strong><code className="text-[11.5px] break-all text-fg-2">{plan.folder}</code></span>
    <span className="text-fg-2">{plan.files} 个文件 · {bytes(plan.bytes)}{plan.executables ? " · 含 " + plan.executables + " 个可执行文件" : ""}{plan.plugin ? " · 带插件清单" : ""}{plan.overwrites ? " · 覆盖本地改动 " + plan.overwrites + " 处" : ""}</span>
    {plan.changes.length ? <ul className="skill-file-changes m-0 flex max-h-[160px] list-none flex-col gap-0.5 overflow-auto rounded-md bg-subtle px-2.5 py-1.5 text-[11.5px]">{plan.changes.map(change =>
      <li key={change.path} className={change.action === "add" ? "text-green" : change.action === "remove" ? "text-red" : "text-amber"}><span aria-hidden="true">{change.action === "add" ? "+ " : change.action === "remove" ? "− " : "~ "}</span>
        <span className="sr-only">{change.action === "add" ? "新增" : change.action === "remove" ? "删除" : "修改"}</span><code>{change.path}</code></li>)}</ul> : null}
  </li>)}</ul>;
}
function Diff({ text }: { readonly text: string }) {
  return <pre className="capability-diff m-0 max-h-[260px] overflow-auto rounded-md bg-subtle px-2.5 py-2 text-[11.5px] leading-[1.5]">{text.split("\n").map((line, index) =>
    <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "block text-green" : line.startsWith("-") && !line.startsWith("---") ? "block text-red" : "block"}>{line || " "}</span>)}</pre>;
}

/** The links a change creates or removes, as they will be written; a deletion's are grouped by who made them. */
function Links({ links }: { readonly links: CapabilityChangeCheck["links"] }) {
  const list = (items: CapabilityChangeCheck["links"]) => <ul className="capability-links m-0 flex max-h-[220px] list-none flex-col gap-0.5 overflow-auto rounded-md bg-subtle p-0 px-2.5 py-2 text-[11.5px]">{items.slice(0, 200).map(link =>
    <li key={link.action + link.path} className={link.action === "create" ? "text-green" : "text-red"}><span aria-hidden="true">{link.action === "create" ? "+ " : "− "}</span>
      <span className="sr-only">{link.action === "create" ? "新建" : "删除"}</span><code>{link.path}</code> → <code>{link.target}</code></li>)}
    {items.length > 200 ? <li className="text-fg-3">等共 {items.length} 个</li> : null}</ul>;
  if (!links.some(link => link.owner !== undefined)) return list(links);
  const ours = links.filter(link => link.owner === "harnesshub"), others = links.filter(link => link.owner !== "harnesshub");
  return <div className="flex flex-col gap-1.5">
    {ours.length ? <><span className="text-[12px] text-fg-2">HarnessHub 放置的链接（{ours.length}）</span>{list(ours)}</> : null}
    {others.length ? <><span className="text-[12px] text-fg-2">其他工具（多为 npx skills）建的链接（{others.length}）</span>{list(others)}</> : null}
  </div>;
}

/**
 * Confirms one change (ADR-045 §3–4): the file and the exact change, the Harness's own command, or the links it makes
 * or removes, are shown first; nothing is written until the user confirms, and a confirmation is good once, for 15 minutes.
 */
export function ChangeDialog({ api, request, onClose, onDone }: { readonly api: GatewayApi; readonly request: ChangeRequest | null; readonly onClose: () => void; readonly onDone: (view: CapabilityChangeView, title: string) => void }) {
  const [check, setCheck] = useState<CapabilityChangeCheck | null>(null), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  // What the user said to a blocked check belongs to that request; a new request starts from nothing said (one shared empty list, so it loads once).
  const [said, setSaid] = useState<{ readonly request: ChangeRequest | null; readonly options: readonly InstructionCheckOption[] }>({ request: null, options: NOTHING_SAID });
  const [whole, setWhole] = useState(false), options = said.request === request ? said.options : NOTHING_SAID;
  useEffect(() => {
    if (request === null) return;
    setWhole(false);
    let live = true; setCheck(null); setFailure(null);
    request.load(options).then(value => { if (live) setCheck(value); }, error => { if (live) setFailure(errorMessage(error)); });
    return () => { live = false; };
  }, [api, request, attempt, options]);
  const verb = request?.verb ?? "确认", rewrite = check?.rewrite ?? null, pkg = check !== null && check.skills !== undefined;
  // What the Harness's own command changes besides the target, said in one line.
  const extras = rewrite === null ? [] : [rewrite.added.length ? "新增 " + rewrite.added.join("、") : null, rewrite.removed.length ? "删除 " + rewrite.removed.join("、") : null,
    rewrite.changed.length ? "改变 " + rewrite.changed.join("、") : null, rewrite.commentLines ? "丢失 " + rewrite.commentLines + " 行注释" : null].filter((item): item is string => item !== null);
  const confirm = () => {
    if (check === null) return;
    setBusy(true); setFailure(null);
    api.applyCapabilityChange(check.fingerprint, requestKey()).then(view => { setBusy(false); onDone(view, request?.done ?? "已完成"); }, error => { setBusy(false); setCheck(null); setFailure(errorMessage(error)); });
  };
  return <Dialog open={request !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={request?.title ?? "修改"} className="skill-switch-dialog w-[min(600px,calc(100vw-32px))]">
    <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-2">
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14}/>正在读取配置并准备改动…</p>
        : <>
          {check.blocked ? <Notice tone="amber" className="switch-blocked" action={check.proceed ? <button type="button" className="btn btn-sm" onClick={() => setSaid({ request, options: [...options, check.proceed!.option] })}>{check.proceed.label}</button> : undefined}>{check.blocked}</Notice> : null}
          <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
            <Fact label={pkg || check.links.length || check.kind === "skill-link" || check.kind === "link-cleanup" || check.kind === "link-undo" ? "目录" : "改动的文件"}><code className="text-[12px] break-all">{check.file}</code></Fact>
            {check.command ? <Fact label="运行命令"><code className="text-[12px] break-all">{check.command}</code></Fact> : null}
            {check.source ? <Fact label="来源"><span className="break-all">{check.source.repository}{check.source.ref ? " · " + check.source.ref : ""} · <code className="text-[12px]">{check.source.commit.slice(0, 12)}</code></span></Fact> : null}
            {check.blocked === null ? <Fact label={pkg ? "来源记录" : "现在的设置"}>{(pkg ? SOURCE_OWNER : OWNER)[check.current]}</Fact> : null}
          </dl>
          <SkillPlans check={check}/>
          {check.lock ? <div className="flex flex-col gap-1"><span className="text-[12px] text-fg-2">npx skills 的 lock：<code className="text-[11.5px]">{check.lock.file}</code></span><Diff text={check.lock.diff}/></div> : null}
          {check.orphans?.length ? <div className="skill-orphans flex flex-col gap-0.5 text-[12px] text-fg-2"><span>留在原处的停用设置：</span>
            {check.orphans.map(orphan => <code key={orphan.harnessId + orphan.file} className="text-[11.5px] break-all">{orphan.harnessId} · {orphan.file}</code>)}</div> : null}
          {rewrite ? <div className="switch-rewrite flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2 text-[12.5px]">
            <span><code className="text-[12px]">{rewrite.target}</code>：{rewrite.before ?? "（没有）"} → {rewrite.after ?? "（没有）"}</span>
            <span className="text-fg-2">{extras.length ? "这条命令还会：" + extras.join("；") + "。" : "除这一项外不改其他设置。"}</span>
            {check.diff ? whole ? <><Diff text={check.diff}/><span className="text-[12px] text-fg-3">整份重写的差异接近全文：已按名字和形态打码，但没有特征的值仍可能显示。</span></>
              : <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setWhole(true)}>显示完整差异（已打码）</button> : null}
          </div>
            : check.diff ? <Diff text={check.diff}/> : check.links.length ? <Links links={check.links}/> : null}
          {check.notes.map(note => <p key={note} className="switch-note m-0 text-[12.5px] text-fg-2">{note}</p>)}
          <p className="m-0 text-[12px] text-fg-3">{pkg ? "被替换或删除的文件夹会先存快照；改动记在“修改与备份”里，可以撤销。" : check.links.length ? "只改列出的这些链接；改动会记在“修改与备份”里，可以撤销。"
            : check.kind === "instructions-sync" || check.kind === "instructions-remove" ? "只改 HarnessHub 的区块，区块外的内容不变；改动前先备份原文件，可以在“修改与备份”里恢复。" : "只改这一项设置，文件的其他内容不变；写入前先备份原文件，可以在“修改与备份”里恢复。"}确认 15 分钟内有效。</p>
        </>}
    </div>
    <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null || busy} onClick={confirm}>
        {busy ? <Spinner size={13}/> : request?.icon === "add" ? <Download size={14}/> : request?.icon === "update" ? <RefreshCw size={14}/> : request?.icon === "delete" ? <Trash2 size={14}/> : request?.icon === "undo" ? <RotateCcw size={14}/>
          : request?.on === true ? <Power size={14}/> : request?.on === false ? <PowerOff size={14}/> : check?.links.some(link => link.action === "create") ? <Link2 size={14}/> : <Link2Off size={14}/>}{verb}</button>
    </div>
  </Dialog>;
}

/** Confirms restoring one backup: what it changes now, and whether someone changed the file after HarnessHub did. */
export function RestoreDialog({ api, backupId, onClose, onDone }: { readonly api: GatewayApi; readonly backupId: string | null; readonly onClose: () => void; readonly onDone: (view: CapabilityChangeView) => void }) {
  const [check, setCheck] = useState<CapabilityRestoreCheck | null>(null), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (backupId === null) return;
    let live = true; setCheck(null); setFailure(null);
    api.checkRestore(backupId).then(value => { if (live) setCheck(value); }, error => { if (live) setFailure(errorMessage(error)); });
    return () => { live = false; };
  }, [api, backupId, attempt]);
  const confirm = () => {
    if (check === null) return;
    setBusy(true); setFailure(null);
    api.restoreBackup(check.fingerprint, requestKey()).then(view => { setBusy(false); onDone(view); }, error => { setBusy(false); setCheck(null); setFailure(errorMessage(error)); });
  };
  return <Dialog open={backupId !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title="恢复修改前的文件" description={check?.file} className="restore-dialog w-[min(600px,calc(100vw-32px))]">
    <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-2">
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14}/>正在比对备份与现在的文件…</p>
        : <>
          {check.changedSince ? <Notice tone="amber" className="restore-changed">{check.notes[0]}</Notice> : null}
          <Diff text={check.diff}/>
          {check.notes.slice(check.changedSince ? 1 : 0).map(note => <p key={note} className="m-0 text-[12.5px] text-fg-2">{note}</p>)}
        </>}
    </div>
    <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || busy} onClick={confirm}>{busy ? <Spinner size={13}/> : <RotateCcw size={14}/>}恢复</button>
    </div>
  </Dialog>;
}
