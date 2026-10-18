import { Power, PowerOff, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CapabilityChangeCheck, CapabilityChangeView, CapabilityRestoreCheck } from "../../../src/contracts/capabilities.js";
import { errorMessage, requestKey, type GatewayApi } from "../api.js";
import { Dialog } from "../ui/overlay.js";
import { Fact, Notice, Spinner } from "../ui/primitives.js";

/** A skill to turn off (`enabled` false) or on in one Harness; `via` is the copy Codex switches by its path. */
export interface SwitchRequest { readonly harnessId: string; readonly harnessName: string; readonly name: string; readonly enabled: boolean; readonly via: string | null }

const OWNER: Readonly<Record<CapabilityChangeCheck["current"], string>> = { harnesshub: "HarnessHub 之前写的", other: "不是 HarnessHub 写的", none: "还没有这项设置" };
function Diff({ text }: { readonly text: string }) {
  return <pre className="capability-diff m-0 max-h-[260px] overflow-auto rounded-md bg-subtle px-2.5 py-2 text-[11.5px] leading-[1.5]">{text.split("\n").map((line, index) =>
    <span key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "block text-green" : line.startsWith("-") && !line.startsWith("---") ? "block text-red" : "block"}>{line || " "}</span>)}</pre>;
}

/**
 * Confirms turning one skill off or on (ADR-045 §3–4): the file and the exact change, or the Harness's own command, are
 * shown first; nothing is written until the user confirms, and a confirmation is good once, for 15 minutes.
 */
export function SkillSwitchDialog({ api, request, onClose, onDone }: { readonly api: GatewayApi; readonly request: SwitchRequest | null; readonly onClose: () => void; readonly onDone: (view: CapabilityChangeView) => void }) {
  const [check, setCheck] = useState<CapabilityChangeCheck | null>(null), [failure, setFailure] = useState<string | null>(null), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    if (request === null) return;
    setWhole(false);
    let live = true; setCheck(null); setFailure(null);
    api.checkSkillSwitch(request.harnessId, request.name, request.enabled, request.via).then(value => { if (live) setCheck(value); }, error => { if (live) setFailure(errorMessage(error)); });
    return () => { live = false; };
  }, [api, request, attempt]);
  const verb = request?.enabled ? "启用" : "停用", rewrite = check?.rewrite ?? null;
  // What the Harness's own command changes besides the target, said in one line.
  const extras = rewrite === null ? [] : [rewrite.added.length ? "新增 " + rewrite.added.join("、") : null, rewrite.removed.length ? "删除 " + rewrite.removed.join("、") : null,
    rewrite.changed.length ? "改变 " + rewrite.changed.join("、") : null, rewrite.commentLines ? "丢失 " + rewrite.commentLines + " 行注释" : null].filter((item): item is string => item !== null);
  const confirm = () => {
    if (check === null) return;
    setBusy(true); setFailure(null);
    api.applyCapabilityChange(check.fingerprint, requestKey()).then(view => { setBusy(false); onDone(view); }, error => { setBusy(false); setCheck(null); setFailure(errorMessage(error)); });
  };
  return <Dialog open={request !== null} onOpenChange={open => { if (!open && !busy) onClose(); }} title={request ? `在 ${request.harnessName} 中${verb} ${request.name}` : "修改技能开关"}
    description={request?.via ?? undefined} className="skill-switch-dialog w-[min(600px,calc(100vw-32px))]">
    <div className="scroll-area flex max-h-[min(64dvh,560px)] flex-col gap-3 px-5 pt-3 pb-2">
      {failure ? <Notice tone="red" action={<button type="button" className="btn btn-sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13}/>重新检查</button>}>{failure}</Notice>
        : check === null ? <p className="m-0 flex items-center gap-2 text-[13px] text-fg-2"><Spinner size={14}/>正在读取 {request?.harnessName} 的配置并准备改动…</p>
        : <>
          {check.blocked ? <Notice tone="amber" className="switch-blocked">{check.blocked}</Notice> : null}
          <dl className="m-0 grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
            <Fact label="改动的文件"><code className="text-[12px] break-all">{check.file}</code></Fact>
            {check.command ? <Fact label="运行命令"><code className="text-[12px] break-all">{check.command}</code></Fact> : null}
            {check.blocked === null ? <Fact label="现在的设置">{OWNER[check.current]}</Fact> : null}
          </dl>
          {rewrite ? <div className="switch-rewrite flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2 text-[12.5px]">
            <span><code className="text-[12px]">{rewrite.target}</code>：{rewrite.before ?? "（没有）"} → {rewrite.after ?? "（没有）"}</span>
            <span className="text-fg-2">{extras.length ? request?.harnessName + " 的命令还会：" + extras.join("；") + "。" : "除这一项外不改其他设置。"}</span>
            {check.diff ? whole ? <><Diff text={check.diff}/><span className="text-[12px] text-fg-3">整份重写的差异接近全文：已按名字和形态打码，但没有特征的值仍可能显示。</span></>
              : <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setWhole(true)}>显示完整差异（已打码）</button> : null}
          </div>
            : check.diff ? <Diff text={check.diff}/> : null}
          {check.notes.map(note => <p key={note} className="switch-note m-0 text-[12.5px] text-fg-2">{note}</p>)}
          <p className="m-0 text-[12px] text-fg-3">只改这一项设置，文件的其他内容不变；写入前先备份原文件，可以在“修改与备份”里恢复。确认 15 分钟内有效。</p>
        </>}
    </div>
    <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
      <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-primary" disabled={check === null || check.blocked !== null || busy} onClick={confirm}>
        {busy ? <Spinner size={13}/> : request?.enabled ? <Power size={14}/> : <PowerOff size={14}/>}{verb}</button>
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
