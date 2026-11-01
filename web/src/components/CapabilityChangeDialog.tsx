import { CircleCheck, Download, Link2, Link2Off, Power, PowerOff, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityRestoreCheck, InstructionCheckOption } from "../../../src/contracts/capabilities.js";
import { ApiError, errorMessage, requestKey, type GatewayApi } from "../api.js";
import { cn } from "../lib/cn.js";
import { Dialog } from "../ui/overlay.js";
import { Fact, Notice, Spinner } from "../ui/primitives.js";
import { BrandIcon } from "./BrandIcon.js";

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
/** The frame of a block of changed lines, links or one file's changes (Capabilities board): radius 12 inside a hairline. */
const BLOCK = "overflow-hidden rounded-block bg-surface shadow-[inset_0_0_0_1px_var(--border)]";
/** The body and the footer of every capability dialog, so that they read as one family. */
export const DIALOG_BODY = "scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-3 text-ui-sm";
export const DIALOG_FOOT = "flex flex-wrap items-center justify-end gap-2 hairline-t px-5 py-3.5";
/** A labelled field of a capability dialog's form; the control keeps its own accessible name. */
export function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label className="flex flex-col gap-1.5"><span className="text-caption font-medium text-fg-2">{label}</span>{children}</label>;
}

/** The skill folders a change adds, replaces, removes or puts back, with what each holds and the files an update changes. */
function SkillPlans({ check }: { readonly check: CapabilityChangeCheck }) {
  if (!check.skills?.length) return null;
  return <ul className={cn("skill-plans m-0 flex list-none flex-col p-0", BLOCK)}>{check.skills.map(plan => <li key={plan.folder} className="flex flex-col gap-1 px-3 py-2.5 [&+&]:hairline-t">
    <span className="flex flex-wrap items-baseline gap-x-2"><strong className="font-medium">{PLAN_ACTION[plan.action]} {plan.name}</strong><code className="text-caption break-all text-fg-3">{plan.folder}</code></span>
    <span className="text-caption text-fg-2">{plan.files} 个文件 · {bytes(plan.bytes)}{plan.executables ? " · 含 " + plan.executables + " 个可执行文件" : ""}{plan.plugin ? " · 带插件清单" : ""}{plan.overwrites ? " · 覆盖本地改动 " + plan.overwrites + " 处" : ""}</span>
    {plan.changes.length ? <ul className="skill-file-changes diff m-0 flex max-h-[160px] list-none flex-col overflow-auto rounded-row bg-inset p-0 py-1">{plan.changes.map(change =>
      <li key={change.path} className={cn("diff-line [&>.s]:w-6", change.action === "add" ? "is-add text-green" : change.action === "remove" ? "is-remove text-red" : "text-amber")}>
        <span className="s" aria-hidden="true">{change.action === "add" ? "+ " : change.action === "remove" ? "− " : "~ "}</span>
        <span className="sr-only">{change.action === "add" ? "新增" : change.action === "remove" ? "删除" : "修改"}</span><code className="c text-fg">{change.path}</code></li>)}</ul> : null}
  </li>)}</ul>;
}

/**
 * A unified diff drawn the way the Capabilities board draws one: a row per line with its sign in a narrow column, added
 * lines on the diff green and removed ones on the diff red. The file headers are left out (the file is named above the
 * diff) and hunks are parted by a hairline. Every line keeps its exact text, sign included.
 */
export function Diff({ text, className, bare = false }: { readonly text: string; readonly className?: string;
  /** Inside a file's block: no frame of its own, edge to edge. */ readonly bare?: boolean }) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let hunks = 0;
  return <div className={cn("capability-diff diff max-h-[260px] overflow-auto py-1.5", bare ? "-mx-3" : BLOCK, className)}>{lines.map((line, index) => {
    // Before the first hunk, "---" and "+++" name the file; after it they are removed or added lines like any other.
    if (line.startsWith("@@")) { hunks++; return hunks > 1 ? <div key={index} className="mx-3 my-1.5 hairline-t" aria-hidden="true"/> : null; }
    if (hunks === 0 && (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index "))) return null;
    const add = line.startsWith("+"), remove = line.startsWith("-");
    return <div key={index} className={cn("diff-line [&>.s]:w-6", add ? "is-add text-green" : remove ? "is-remove text-red" : null)}>
      <span className="s">{line.slice(0, 1)}</span><span className="c text-fg">{line.slice(1) || " "}</span>
    </div>;
  })}</div>;
}

/** The links a change creates or removes, as they will be written; a deletion's are grouped by who made them. */
function Links({ links, bare = false }: { readonly links: CapabilityChangeCheck["links"]; readonly bare?: boolean }) {
  const list = (items: CapabilityChangeCheck["links"]) => <ul className={cn("capability-links diff m-0 flex max-h-[220px] list-none flex-col overflow-auto p-0 py-1.5", bare ? "-mx-3" : BLOCK)}>{items.slice(0, 200).map(link =>
    <li key={link.action + link.path} className={cn("diff-line pr-3 [&>.s]:w-6", link.action === "create" ? "is-add text-green" : "is-remove text-red")}><span className="s" aria-hidden="true">{link.action === "create" ? "+ " : "− "}</span>
      <span className="sr-only">{link.action === "create" ? "新建" : "删除"}</span><span className="c text-fg"><code>{link.path}</code> → <code>{link.target}</code></span></li>)}
    {items.length > 200 ? <li className="px-3 text-fg-3">等共 {items.length} 个</li> : null}</ul>;
  if (!links.some(link => link.owner !== undefined)) return list(links);
  const ours = links.filter(link => link.owner === "harnesshub"), others = links.filter(link => link.owner !== "harnesshub");
  return <div className="flex flex-col gap-1.5">
    {ours.length ? <><span className="text-caption text-fg-2">HarnessHub 放置的链接（{ours.length}）</span>{list(ours)}</> : null}
    {others.length ? <><span className="text-caption text-fg-2">其他工具（多为 npx skills）建的链接（{others.length}）</span>{list(others)}</> : null}
  </div>;
}

/** What the Harness's own command changes besides the target, said in one line. */
function rewriteExtras(rewrite: NonNullable<CapabilityChangeCheck["rewrite"]>): readonly string[] {
  return [rewrite.added.length ? "新增 " + rewrite.added.join("、") : null, rewrite.removed.length ? "删除 " + rewrite.removed.join("、") : null,
    rewrite.changed.length ? "改变 " + rewrite.changed.join("、") : null, rewrite.commentLines ? "丢失 " + rewrite.commentLines + " 行注释" : null].filter((item): item is string => item !== null);
}
/**
 * What one check changes, the way the user should read it: a whole-file rewrite by the Harness's own command summarized
 * (its masked full diff only on request), otherwise the exact lines of the file, or the links it makes or removes.
 */
function ChangeBody({ check, bare = false }: { readonly check: CapabilityChangeCheck; readonly bare?: boolean }) {
  const [whole, setWhole] = useState<string | null>(null), rewrite = check.rewrite;
  if (rewrite) {
    const extras = rewriteExtras(rewrite);
    return <div className={cn("switch-rewrite flex flex-col gap-1.5 px-3 py-2.5", BLOCK)}>
      <span><code className="text-caption">{rewrite.target}</code>：{rewrite.before ?? "（没有）"} → {rewrite.after ?? "（没有）"}</span>
      <span className="text-fg-2">{extras.length ? "这条命令还会：" + extras.join("；") + "。" : "除这一项外不改其他设置。"}</span>
      {check.diff ? whole === check.fingerprint ? <><Diff text={check.diff}/><span className="text-caption text-fg-3">整份重写的差异接近全文：已按名字和形态打码，但没有特征的值仍可能显示。</span></>
        : <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setWhole(check.fingerprint)}>显示完整差异（已打码）</button> : null}
    </div>;
  }
  return check.diff ? <Diff text={check.diff} bare={bare}/> : check.links.length ? <Links links={check.links} bare={bare}/> : null;
}

/**
 * Confirms one change (ADR-045 §3–4): the file and the exact change, the Harness's own command, or the links it makes
 * or removes, are shown first; nothing is written until the user confirms, and a confirmation is good once, for 15 minutes.
 */
export function ChangeDialog({ api, request, onClose, onDone }: { readonly api: GatewayApi; readonly request: ChangeRequest | null; readonly onClose: () => void; readonly onDone: (view: CapabilityChangeView, title: string) => void }) {
  const [check, setCheck] = useState<CapabilityChangeCheck | null>(null), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  // What the user said to a blocked check belongs to that request; a new request starts from nothing said (one shared empty list, so it loads once).
  const [said, setSaid] = useState<{ readonly request: ChangeRequest | null; readonly options: readonly InstructionCheckOption[] }>({ request: null, options: NOTHING_SAID });
  const options = said.request === request ? said.options : NOTHING_SAID;
  useEffect(() => {
    if (request === null) return;
    let live = true; setCheck(null); setFailure(null);
    request.load(options).then(value => { if (live) setCheck(value); }, error => { if (live) setFailure(errorMessage(error)); });
    return () => { live = false; };
  }, [api, request, attempt, options]);
  const verb = request?.verb ?? "确认", pkg = check !== null && check.skills !== undefined;
  const confirm = () => {
    if (check === null) return;
    setBusy(true); setFailure(null);
    api.applyCapabilityChange(check.fingerprint, requestKey()).then(view => { setBusy(false); onDone(view, request?.done ?? "已完成"); }, error => { setBusy(false); setCheck(null); setFailure(errorMessage(error)); });
  };
  return <Dialog open={request !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={request?.title ?? "修改"} className="skill-switch-dialog w-[min(600px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-fg-2" role="status"><Spinner size={14} label=""/>正在读取配置并准备改动…</p>
        : <>
          {check.blocked ? <Notice tone="amber" className="switch-blocked" action={check.proceed ? <button type="button" className="btn btn-sm" onClick={() => setSaid({ request, options: [...options, check.proceed!.option] })}>{check.proceed.label}</button> : undefined}>{check.blocked}</Notice> : null}
          <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
            <Fact label={pkg || check.links.length || check.kind === "skill-link" || check.kind === "link-cleanup" || check.kind === "link-undo" ? "目录" : "改动的文件"}><code className="text-caption break-all">{check.file}</code></Fact>
            {check.command ? <Fact label="运行命令"><code className="text-caption break-all">{check.command}</code></Fact> : null}
            {check.source ? <Fact label="来源"><span className="break-all">{check.source.repository}{check.source.ref ? " · " + check.source.ref : ""} · <code className="text-caption">{check.source.commit.slice(0, 12)}</code></span></Fact> : null}
            {check.blocked === null ? <Fact label={pkg ? "来源记录" : "现在的设置"}>{(pkg ? SOURCE_OWNER : OWNER)[check.current]}</Fact> : null}
          </dl>
          <SkillPlans check={check}/>
          {check.lock ? <div className="flex flex-col gap-1.5"><span className="text-caption text-fg-2">npx skills 的 lock：<code className="text-caption">{check.lock.file}</code></span><Diff text={check.lock.diff}/></div> : null}
          {check.orphans?.length ? <div className="skill-orphans flex flex-col gap-0.5 text-caption text-fg-2"><span>留在原处的停用设置：</span>
            {check.orphans.map(orphan => <code key={orphan.harnessId + orphan.file} className="break-all">{orphan.harnessId} · {orphan.file}</code>)}</div> : null}
          <ChangeBody check={check}/>
          {check.notes.map(note => <p key={note} className="switch-note m-0 text-fg-2">{note}</p>)}
          <p className="m-0 text-caption text-fg-3">{pkg ? "被替换或删除的文件夹会先存快照；改动记在“修改与备份”里，可以撤销。" : check.links.length ? "只改列出的这些链接；改动会记在“修改与备份”里，可以撤销。"
            : check.kind === "instructions-sync" || check.kind === "instructions-remove" ? "只改 HarnessHub 的区块，区块外的内容不变；改动前先备份原文件，可以在“修改与备份”里恢复。" : "只改这一项设置，文件的其他内容不变；写入前先备份原文件，可以在“修改与备份”里恢复。"}确认 15 分钟内有效。</p>
        </>}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null || busy} onClick={confirm}>
        {busy ? <Spinner size={13} label=""/> : request?.icon === "add" ? <Download size={14}/> : request?.icon === "update" ? <RefreshCw size={14}/> : request?.icon === "delete" ? <Trash2 size={14}/> : request?.icon === "undo" ? <RotateCcw size={14}/>
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
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-fg-2" role="status"><Spinner size={14} label=""/>正在比对备份与现在的文件…</p>
        : <>
          {check.changedSince ? <Notice tone="amber" className="restore-changed">{check.notes[0]}</Notice> : null}
          <Diff text={check.diff}/>
          {check.notes.slice(check.changedSince ? 1 : 0).map(note => <p key={note} className="m-0 text-fg-2">{note}</p>)}
        </>}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || busy} onClick={confirm}>{busy ? <Spinner size={13} label=""/> : <RotateCcw size={14}/>}恢复</button>
    </div>
  </Dialog>;
}

/** Where one prepared check stands: being read, ready to show, or not available, with why. */
export type CheckState = { readonly state: "loading" } | { readonly state: "ready"; readonly check: CapabilityChangeCheck } | { readonly state: "failed"; readonly message: string };
/**
 * One change the matrix collected (Capabilities board): what it does ("启用 beta"), for which Agent, how to prepare its
 * check again, and the check prepared for it so far. The page owns the checks; the dialogs show and apply them.
 */
export interface WriteItem { readonly id: string; readonly title: string; readonly harnessId: string; readonly harnessName: string; readonly load: () => Promise<CapabilityChangeCheck>; readonly check: CheckState }
/** One change a batch wrote: the item it came from and what the Gateway did. */
export interface Written { readonly id: string; readonly title: string; readonly harnessId: string; readonly harnessName: string; readonly view: CapabilityChangeView }

/** The files a batch would change: the file of each check that can be written, once each. */
export function filesOf(items: readonly WriteItem[]): readonly string[] {
  return [...new Set(items.flatMap(item => item.check.state === "ready" && item.check.check.blocked === null ? [item.check.check.file] : []))];
}
/** The changed lines of a diff, without file headers, hunk headers or context: what a change does to the file. */
function changedLines(diff: string | null): string {
  if (diff === null) return "";
  let hunks = 0;
  return diff.split("\n").filter(line => {
    if (line.startsWith("@@")) { hunks++; return false; }
    return hunks > 0 && (line.startsWith("+") || line.startsWith("-"));
  }).join("\n");
}
/**
 * Whether a check prepared again after an earlier change of the same batch wrote its file makes the very change the user
 * confirmed: the same target, the same changed lines (only the context around them moved), command, rewrite and links.
 */
function sameChange(confirmed: CapabilityChangeCheck, fresh: CapabilityChangeCheck): boolean {
  return fresh.blocked === null && confirmed.kind === fresh.kind && confirmed.harnessId === fresh.harnessId && confirmed.name === fresh.name && confirmed.enabled === fresh.enabled
    && confirmed.file === fresh.file && confirmed.command === fresh.command && changedLines(confirmed.diff) === changedLines(fresh.diff)
    && JSON.stringify(confirmed.rewrite) === JSON.stringify(fresh.rewrite) && JSON.stringify(confirmed.links) === JSON.stringify(fresh.links);
}
/** The head of one file's block: the Agent's mark and name, and the file (Capabilities board). */
function FileHead({ harnessId, harnessName, file, children }: { readonly harnessId: string; readonly harnessName: string; readonly file: string | null; readonly children?: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-2 hairline-b px-3 py-2 text-caption">
    <BrandIcon brand={harnessId} name={harnessName} size={20}/><span className="flex-none font-semibold">{harnessName}</span>
    {file ? <code className="min-w-0 trunc text-fg-3" title={file}>{file}</code> : null}<span className="flex-1"/>{children}
  </div>;
}
/** What happened to one item while writing: written, being written, shown again changed, or failed with the reason. */
type Progress = { readonly state: "written"; readonly view: CapabilityChangeView } | { readonly state: "writing" } | { readonly state: "changed"; readonly reason: string } | { readonly state: "failed"; readonly message: string };

/**
 * Previews and writes what the matrix collected (Capabilities board, ADR-045 §3): every file with the exact lines each
 * change makes, the Harness's command or the links where there are any, and why a change cannot be written. Nothing is
 * written before "写入"; then the changes are written one at a time, each with its own confirmed check. A check that an
 * earlier change of this batch made stale (the same file) is prepared again and written only if it makes the very same
 * change. Otherwise, and when the file changed elsewhere or the confirmation expired, the new change is shown and writing
 * stops until the user confirms again. Closing reports whatever was written.
 */
export function WriteDialog({ api, open, items, onCheck, onClose }: {
  readonly api: GatewayApi; readonly open: boolean; readonly items: readonly WriteItem[];
  /** A check prepared again while writing, for the page's selection to keep. */
  readonly onCheck: (id: string, state: CheckState) => void;
  /** Closed: once everything writable is written (`complete`), or by the user, with whatever was written until then. */
  readonly onClose: (written: readonly Written[], complete: boolean) => void;
}) {
  const [progress, setProgress] = useState<ReadonlyMap<string, Progress>>(new Map()), [busy, setBusy] = useState(false);
  // One command id per confirmed check: sending the same check again (after a lost answer) returns its first result.
  const keys = useRef(new Map<string, string>());
  useEffect(() => { if (open) { setProgress(new Map()); setBusy(false); keys.current = new Map(); } }, [open]);
  const written = (from: ReadonlyMap<string, Progress>): readonly Written[] => items.flatMap(item => { const step = from.get(item.id);
    return step?.state === "written" ? [{ id: item.id, title: item.title, harnessId: item.harnessId, harnessName: item.harnessName, view: step.view }] : []; });
  // One block per file, in the order the files first appear; an item without a check yet has its own block. Changes are written in that order.
  const groups: (readonly WriteItem[])[] = [], byKey = new Map<string, WriteItem[]>();
  for (const item of items) {
    const key = item.check.state === "ready" ? item.harnessId + "\u0000" + item.check.check.file : "item\u0000" + item.id, group = byKey.get(key);
    if (group) group.push(item); else { const fresh = [item]; byKey.set(key, fresh); groups.push(fresh); }
  }
  const pending = groups.flat().filter(item => item.check.state === "ready" && item.check.check.blocked === null && progress.get(item.id)?.state !== "written");
  const loading = items.some(item => item.check.state === "loading"), files = filesOf(items.filter(item => progress.get(item.id)?.state !== "written"));
  const wroteAny = [...progress.values()].some(value => value.state === "written");
  const apply = (check: CapabilityChangeCheck) => {
    const key = keys.current.get(check.fingerprint) ?? requestKey(); keys.current.set(check.fingerprint, key);
    return api.applyCapabilityChange(check.fingerprint, key);
  };
  const write = async () => {
    setBusy(true);
    const steps = new Map(progress), touched = new Set([...steps.values()].flatMap(value => value.state === "written" ? [value.view.file] : []));
    const step = (id: string, value: Progress) => { steps.set(id, value); setProgress(new Map(steps)); };
    let stopped = false;
    for (const item of pending) {
      if (item.check.state !== "ready") continue;
      const check = item.check.check;
      step(item.id, { state: "writing" });
      try {
        const view = await apply(check);
        step(item.id, { state: "written", view }); touched.add(check.file);
        if (view.status === "failed") { stopped = true; break; }
      } catch (error) {
        const code = error instanceof ApiError ? error.code : null;
        if (code !== "CAPABILITY_TARGET_CHANGED" && code !== "CAPABILITY_CHECK_EXPIRED") { step(item.id, { state: "failed", message: errorMessage(error) }); stopped = true; break; }
        // The file is no longer as it was read, or the confirmation ran out: prepare this change again against the file as it is now.
        let fresh: CapabilityChangeCheck;
        try { fresh = await item.load(); } catch (failure) { step(item.id, { state: "failed", message: errorMessage(failure) }); stopped = true; break; }
        onCheck(item.id, { state: "ready", check: fresh });
        if (code === "CAPABILITY_TARGET_CHANGED" && touched.has(check.file) && sameChange(check, fresh)) {
          try { const view = await apply(fresh); step(item.id, { state: "written", view }); if (view.status === "failed") { stopped = true; break; } continue; }
          catch (failure) { step(item.id, { state: "failed", message: errorMessage(failure) }); stopped = true; break; }
        }
        step(item.id, { state: "changed", reason: code === "CAPABILITY_CHECK_EXPIRED" ? "确认已过期，已重新检查：这是现在的改动，请再看一遍。" : touched.has(check.file)
          ? "写入前一项后，这一项的改动变成了下面这样，请再看一遍。" : "文件在预览之后被改过，已重新检查：这是现在的改动，请再看一遍。" });
        stopped = true; break;
      }
    }
    setBusy(false);
    if (!stopped && items.every(item => item.check.state !== "ready" || item.check.check.blocked !== null || steps.get(item.id)?.state === "written")) onClose(written(steps), true);
  };
  return <Dialog open={open} onOpenChange={next => { if (!next && !busy) onClose(written(progress), false); }} title={loading ? "正在准备改动" : "写入 " + files.length + " 个文件"}
    description="只改下面这些行；写完可以撤销。" className="capability-write-dialog w-[min(560px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {groups.map(group => {
        const first = group[0]!, check = first.check.state === "ready" ? first.check.check : null;
        const notes = [...new Set(group.flatMap(item => item.check.state === "ready" ? item.check.check.notes : []))];
        return <section key={group.map(item => item.id).join("|")} className={cn("capability-write-file", BLOCK)} aria-label={first.harnessName + (check ? " · " + check.file : "")}>
          <FileHead harnessId={first.harnessId} harnessName={first.harnessName} file={check?.file ?? null}/>
          <div className="flex flex-col gap-3 px-3 py-2.5">
            {group.map(item => {
              const step = progress.get(item.id), ready = item.check.state === "ready" ? item.check.check : null;
              return <div key={item.id} className="capability-write-item flex flex-col gap-1.5" data-state={step?.state ?? item.check.state}>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-caption">
                  <span className="min-w-0 font-medium">{item.title}</span>
                  {ready && ready.blocked === null && ready.current !== "none" ? <span className="text-fg-3">现在的设置：{OWNER[ready.current]}</span> : null}
                  <span className="flex-1"/>
                  {step?.state === "written" ? step.view.status === "applied" ? <span className="flex flex-none items-center gap-1 text-accent-text"><CircleCheck size={13}/>已写入</span> : <span className="flex-none text-red">没有完成</span>
                    : step?.state === "writing" ? <Spinner size={13} label="正在写入"/> : null}
                </div>
                {item.check.state === "loading" ? <p className="m-0 flex items-center gap-2 text-fg-2"><Spinner size={13} label=""/>正在读取配置并准备改动…</p>
                  : item.check.state === "failed" ? <Notice tone="red" action={<button type="button" className="btn btn-sm" disabled={busy} onClick={() => { onCheck(item.id, { state: "loading" });
                    item.load().then(value => onCheck(item.id, { state: "ready", check: value }), error => onCheck(item.id, { state: "failed", message: errorMessage(error) })); }}><RefreshCw size={13}/>重新检查</button>}>{item.check.message}</Notice>
                  : ready ? <>
                    {step?.state === "changed" ? <Notice tone="amber" className="write-changed">{step.reason}</Notice> : null}
                    {step?.state === "failed" ? <Notice tone="red">{step.message}</Notice> : null}
                    {step?.state === "written" && step.view.error ? <Notice tone="red">{step.view.error.message}</Notice> : null}
                    {ready.blocked ? <Notice tone="amber" className="switch-blocked">{ready.blocked}</Notice> : null}
                    {ready.command ? <code className="text-caption break-all text-fg-2">{ready.command}</code> : null}
                    {ready.blocked === null ? <ChangeBody check={ready} bare/> : null}
                  </> : null}
              </div>;
            })}
            {notes.length ? <ul className="m-0 flex list-none flex-col gap-1 p-0 text-caption text-fg-2">{notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
          </div>
        </section>;
      })}
      <p className="m-0 text-caption text-fg-3">只改列出的这些行与链接，文件的其他内容不变；写入前先备份原文件。确认 15 分钟内有效。</p>
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={() => onClose(written(progress), false)}>{wroteAny ? "关闭" : "取消"}</button>
      <button type="button" className="btn btn-primary" disabled={busy || loading || pending.length === 0} onClick={() => void write()}>
        {busy ? <Spinner size={13} label=""/> : null}{busy ? "正在写入" : progress.size ? "继续写入" : "写入"}</button>
    </div>
  </Dialog>;
}

/** One file or set of links to put back: a backup to restore, a change of links to undo, or nothing to do, with why. */
type UndoStep = { readonly id: string; readonly harnessId: string; readonly harnessName: string; readonly file: string; readonly changes: number }
  & ({ readonly kind: "restore"; readonly backupId: string } | { readonly kind: "links"; readonly changeId: string } | { readonly kind: "none"; readonly reason: string });
type UndoCheck = { readonly state: "loading" } | { readonly state: "restore"; readonly check: CapabilityRestoreCheck } | { readonly state: "links"; readonly check: CapabilityChangeCheck } | { readonly state: "failed"; readonly message: string };
/**
 * How to undo a batch: each file it edited goes back to the backup taken before the batch's first change to it (which
 * undoes its later changes there too), and each change of links is undone through its own check. A file the batch
 * created has no backup to go back to; it is named, with why, and left as it is.
 */
function undoSteps(written: readonly Written[]): readonly UndoStep[] {
  const steps: UndoStep[] = [], edited = new Map<string, number>();
  for (const item of written) {
    const view = item.view, base = { harnessId: item.harnessId, harnessName: item.harnessName, file: view.file };
    if (view.links?.length) { steps.push({ ...base, id: "links:" + view.id, kind: "links", changeId: view.id, changes: 1 }); continue; }
    const at = edited.get(view.file);
    if (at !== undefined) { const known = steps[at]!; steps[at] = { ...known, changes: known.changes + 1 }; continue; }
    edited.set(view.file, steps.length);
    steps.push(view.backupId ? { ...base, id: "restore:" + view.file, kind: "restore", backupId: view.backupId, changes: 1 }
      : { ...base, id: "none:" + view.file, kind: "none", changes: 1, reason: view.status === "applied" ? "写入之前没有这个文件，没有可以恢复的备份；HarnessHub 不删除它。" : "这一处没有写入，不用撤销。" });
  }
  return steps;
}
/**
 * Undoes what one batch wrote (the Capabilities board's "撤销"), shown first like any change: each file's restore with
 * the lines it changes back, each change of links with the links it removes or puts back. Nothing is written before
 * "撤销"; each step is sent with its own confirmed check, and a failure stops the rest, reporting what was undone.
 */
export function UndoDialog({ api, written, onClose, onDone }: { readonly api: GatewayApi; readonly written: readonly Written[] | null; readonly onClose: () => void; readonly onDone: (views: readonly CapabilityChangeView[]) => void }) {
  const [checks, setChecks] = useState<ReadonlyMap<string, UndoCheck>>(new Map()), [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const [steps, setSteps] = useState<readonly UndoStep[]>([]);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    if (written === null) return;
    const plan = undoSteps(written); let live = true;
    setSteps(plan); setFailure(null); setChecks(new Map(plan.filter(step => step.kind !== "none").map(step => [step.id, { state: "loading" } as const])));
    const set = (id: string, value: UndoCheck) => { if (live) setChecks(current => new Map(current).set(id, value)); };
    for (const step of plan) {
      if (step.kind === "restore") api.checkRestore(step.backupId).then(check => set(step.id, { state: "restore", check }), error => set(step.id, { state: "failed", message: errorMessage(error) }));
      if (step.kind === "links") api.checkUndo(step.changeId).then(check => set(step.id, { state: "links", check }), error => set(step.id, { state: "failed", message: errorMessage(error) }));
    }
    return () => { live = false; };
  }, [api, written, attempt]);
  const ready = steps.flatMap(step => { const check = checks.get(step.id); return check?.state === "restore" || (check?.state === "links" && check.check.blocked === null) ? [check] : []; });
  const loading = [...checks.values()].some(check => check.state === "loading");
  const confirm = async () => {
    setBusy(true); setFailure(null);
    const views: CapabilityChangeView[] = [];
    for (const check of ready) {
      const fingerprint = check.check.fingerprint, key = keys.current.get(fingerprint) ?? requestKey(); keys.current.set(fingerprint, key);
      try { views.push(check.state === "restore" ? await api.restoreBackup(fingerprint, key) : await api.applyCapabilityChange(fingerprint, key)); }
      catch (error) { setFailure(errorMessage(error)); setBusy(false); if (views.length) onDone(views); return; }
    }
    setBusy(false); onDone(views);
  };
  const files = new Set(steps.filter(step => step.kind !== "none").map(step => step.file)).size;
  return <Dialog open={written !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={"撤销写入的 " + files + " 个文件"} description="改回写入之前的样子；下面是会改回的内容。"
    className="capability-undo-dialog w-[min(560px,calc(100vw-32px))]">
    <div className={DIALOG_BODY}>
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice> : null}
      {steps.map(step => {
        const check = checks.get(step.id);
        return <section key={step.id} className={cn("capability-undo-file", BLOCK)} aria-label={step.harnessName + " · " + step.file}>
          <FileHead harnessId={step.harnessId} harnessName={step.harnessName} file={step.file}>{step.kind === "restore" && step.changes > 1 ? <span className="flex-none text-fg-3">这次改了 {step.changes} 处</span> : null}</FileHead>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            {step.kind === "none" ? <p className="m-0 text-fg-2">{step.reason}</p>
              : check === undefined || check.state === "loading" ? <p className="m-0 flex items-center gap-2 text-fg-2"><Spinner size={13} label=""/>正在比对备份与现在的文件…</p>
              : check.state === "failed" ? <Notice tone="red">{check.message}</Notice>
              : check.state === "restore" ? <>
                {check.check.changedSince ? step.changes > 1 ? <p className="restore-changed m-0 text-caption text-fg-2">{check.check.notes[0]}这次写入自己就改了它 {step.changes} 处，下面列出了全部会改回的行。</p>
                  : <Notice tone="amber" className="restore-changed">{check.check.notes[0]}</Notice> : null}
                <Diff text={check.check.diff} bare/>
                {check.check.notes.slice(check.check.changedSince ? 1 : 0).map(note => <p key={note} className="m-0 text-caption text-fg-2">{note}</p>)}
              </> : <>
                {check.check.blocked ? <Notice tone="amber" className="switch-blocked">{check.check.blocked}</Notice> : <ChangeBody check={check.check} bare/>}
                {check.check.notes.map(note => <p key={note} className="m-0 text-caption text-fg-2">{note}</p>)}
              </>}
          </div>
        </section>;
      })}
    </div>
    <div className={DIALOG_FOOT}>
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={busy || loading || ready.length === 0} onClick={() => void confirm()}>{busy ? <Spinner size={13} label=""/> : <RotateCcw size={14}/>}撤销</button>
    </div>
  </Dialog>;
}
