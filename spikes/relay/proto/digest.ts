// 原型，仅用于测量，不是实现。每个已终结 Run 一条 RunDigest（v1 §4、§6.4）：在 run.ended 事务里由内存中的
// execution.details 算出，先按全部上限截断再写（≤64 KiB）。不调用模型、不读内容存储、不做 I/O。
import { normalize } from "./escape.ts";
import type { EscapeRules } from "./escape.ts";
import { firstLastParagraphs, headTail, renderLine, renderUnit } from "./narration.ts";
import type { Redactor } from "./redaction.ts";
import { headBytes, headChars, measure, sha256hex, tailBytes, tailChars, utf8, ZERO } from "./text.ts";
import type {
  Cumulative, DigestCommand, DigestFailure, DigestFile, EditOp, NarratedItem, NativeToolDetailLite, PolicyVersion, PublicToolLite, RunDigest, RunSource, Size,
} from "./types.ts";

export const LIMITS = {
  digestBytes: 65536, narrated: 40, narratedChars: 400, perItem: 8, commands: 16, commandChars: 400, failures: 3, failureTail: 1200, failureLines: 20,
  successTailBytes: 300, successLines: 3, files: 64, pathChars: 256, planItems: 20, planChars: 200, approvals: 16, titleChars: 200, outputs: 16,
  replyTail: 600, userHead: 120, errorChars: 400, diffBudget: 256 * 1024, replyInput: 1024 * 1024, sizeCap: 256 * 1024, window: 8192, maxRunTools: 128,
} as const;
const VERIFY = /\b(?:test|tests|pytest|jest|vitest|mocha|go test|cargo (?:test|check|clippy)|tsc|lint|eslint|ruff|mypy|make check|build)\b/i;
const IRREVERSIBLE = /\b(?:git push|npm publish|pnpm publish|yarn publish|deploy|migrate|terraform apply|kubectl apply|rm -rf|drop table|helm upgrade)\b/i;
const CREDENTIAL_PATH = /(?:^|\/)\.env(?:\.[^/]*)?$|\.pem$|(?:^|\/)id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$|\.key$|credentials|\.p12$/i;

type Category = "read" | "edit" | "search" | "execute" | "fetch" | "subagent" | "think" | "other";
function classify(t: PublicToolLite, d: NativeToolDetailLite | undefined): Category {
  const k = (d?.kind ?? t.kind ?? "").toLowerCase();
  switch (k) {
    case "read": return "read"; case "edit": case "delete": case "move": return "edit"; case "search": return "search"; case "execute": return "execute";
    case "fetch": case "mcp": return "fetch"; case "subagent": case "task": return "subagent"; case "think": return "think"; default: return "other";
  }
}
/** 从工具输入取字段：≤4 KiB 的 JSON 才整体解析；更长的只在前 4 KiB 里按键名找字符串值（原型取舍：输入可达 16 KiB，整段解析不必要）。 */
function jsonField(input: string | undefined, keys: readonly string[]): string | null {
  if (input === undefined || input.length === 0 || input.charCodeAt(0) !== 123) return null;
  if (input.length > 4096) {
    const head = input.slice(0, 4096);
    for (const k of keys) { const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(head); if (m !== null) { try { return JSON.parse('"' + m[1] + '"') as string; } catch { return m[1]!; } } }
    return null;
  }
  try {
    const v: unknown = JSON.parse(input);
    if (v === null || typeof v !== "object") return null;
    for (const k of keys) { const x = (v as Record<string, unknown>)[k]; if (typeof x === "string" && x !== "") return x; if (Array.isArray(x) && x.every(i => typeof i === "string")) return x.join(" "); }
  } catch { /* 输入不是 JSON：按标题处理 */ }
  return null;
}
function diffPath(diff: string | undefined): string | null {
  if (diff === undefined) return null;
  const m = /^\+\+\+ (?:b\/)?(.+)$/m.exec(diff.slice(0, 4096));
  return m === null || m[1] === "/dev/null" ? (/^--- (?:a\/)?(.+)$/m.exec(diff.slice(0, 4096))?.[1] ?? null) : m[1]!;
}
/** +/− 行数与操作（新建 / 删除 / 移动）；超过本 Run 的差异预算时行数记 null。 */
function diffStats(diff: string, budget: { left: number }): { added: number | null; removed: number | null; op: EditOp } {
  const head = diff.slice(0, 4096);
  const op: EditOp = /^--- \/dev\/null|^new file mode/m.test(head) ? "create" : /^\+\+\+ \/dev\/null|^deleted file mode/m.test(head) ? "delete" : /^rename from /m.test(head) ? "move" : "edit";
  if (diff.length > budget.left) { budget.left = 0; return { added: null, removed: null, op }; }
  budget.left -= diff.length;
  // 按行扫描（indexOf 找换行，只看行首两个字符），比逐字符循环快；跳过 "+++ " 与 "--- " 文件头。
  let added = 0, removed = 0;
  for (let start = 0; start < diff.length;) {
    const c = diff.charCodeAt(start);
    if (c === 43) { if (!diff.startsWith("+++ ", start)) added++; }
    else if (c === 45) { if (!diff.startsWith("--- ", start)) removed++; }
    const nl = diff.indexOf("\n", start);
    if (nl < 0) break;
    start = nl + 1;
  }
  return { added, removed, op };
}
function countLines(s: string): number {
  let n = 0, start = 0;
  for (let i = s.indexOf("\n"); ; i = s.indexOf("\n", start)) {
    const end = i < 0 ? s.length : i;
    if (end > start && s.slice(start, end).trim() !== "") n++;
    if (i < 0) return n;
    start = i + 1;
  }
}
function lastLines(s: string, n: number): string {
  let end = s.length; while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  let i = end;
  for (let k = 0; k < n; k++) { const j = i > 0 ? s.lastIndexOf("\n", i - 1) : -1; if (j < 0) return s.slice(0, end); i = j; }
  return s.slice(i + 1, end);
}
function sentenceTail(s: string, n: number): string {
  if (s.length <= n) return s;
  const t = tailChars(s, n);
  const m = /[。！？.!?\n]\s*/u.exec(t);
  return m !== null && m.index < n / 2 ? t.slice(m.index + m[0].length) : "…" + t;
}

export interface DigestContext { readonly redactor: Redactor; readonly rules: EscapeRules; readonly policyVersion: PolicyVersion; readonly previous: Cumulative | null }

/** 抽取一条 RunDigest。所有不可信摘录先规范化、再脱敏、再截断（截断在脱敏之后，避免切开秘密）。 */
export function digestRun(src: RunSource, ctx: DigestContext): RunDigest {
  let redactions = 0;
  const red = (s: string): string => { if (s === "") return s; const r = ctx.redactor.redact(s); redactions += r.count; return r.text; };
  /** 只脱敏需要的窗口：取尾部 n 字之前多留 8 KiB 余量，切开的秘密不会落进最终摘录。 */
  const redTail = (raw: string, cls: "exec_output" | "text"): string => red(normalize(raw.length > LIMITS.window ? raw.slice(raw.length - LIMITS.window) : raw, cls, ctx.rules));
  const redHead = (raw: string, n: number): string => headChars(red(normalize(raw.length > n + LIMITS.window ? raw.slice(0, n + LIMITS.window) : raw, "text", ctx.rules)), n);
  const clip = (raw: string, n: number): string => { const s = redHead(raw, n + 1); return s.length > n ? headChars(s, n) + "…" : s; };
  const run = src.run, tools = run.tools ?? [];
  const byKind: Record<string, number> = {};
  let failed = 0, withOutput = 0, withDiff = 0, external = 0, execTotal = 0, execFailed = 0;
  const narrated: NarratedItem[] = [], commands: DigestCommand[] = [], failures: DigestFailure[] = [];
  const files = new Map<string, { op: EditOp; added: number | null; removed: number | null }>();
  const budget = { left: LIMITS.diffBudget };
  let narratedMore = 0;
  let group: { kind: Category; items: unknown[]; more: number; chars: number; matches: number | null } | null = null;
  const flush = (): void => {
    if (group === null) return;
    if (narrated.length >= LIMITS.narrated) { narratedMore += group.items.length + group.more; group = null; return; }
    const g = group; group = null;
    if (g.kind === "search") narrated.push({ kind: "search", items: g.items as string[], more: g.more, matches: g.matches });
    else if (g.kind === "edit") narrated.push({ kind: "edit", items: g.items as { op: EditOp; path: string; added: number | null; removed: number | null }[], more: g.more });
    else if (g.kind === "fetch") narrated.push({ kind: "fetch", items: g.items as { name: string; bytes: number }[], more: g.more });
    else narrated.push({ kind: g.kind === "read" ? "read" : g.kind === "subagent" ? "subagent" : "other", items: g.items as string[], more: g.more });
  };
  const addToGroup = (kind: Category, item: unknown, chars: number, matches: number | null): void => {
    if (group !== null && group.kind !== kind) flush();
    if (group === null) group = { kind, items: [], more: 0, chars: 0, matches: null };
    if (group.items.length < LIMITS.perItem && group.chars + chars <= LIMITS.narratedChars) { group.items.push(item); group.chars += chars; }
    else group.more++;
    if (matches !== null) group.matches = (group.matches ?? 0) + matches;
  };
  for (const t of tools) {
    const d = src.details.get(t.id), cat = classify(t, d);
    byKind[cat] = (byKind[cat] ?? 0) + 1;
    const exitCode = d?.exitCode ?? t.exitCode ?? null;
    const isFailed = t.status === "failed" || (exitCode !== null && exitCode !== 0);
    if (isFailed) failed++;
    if (d?.output !== undefined && d.output !== "") withOutput++;
    if (d?.diff !== undefined && d.diff !== "") withDiff++;
    if (cat === "think") continue;
    if (cat === "execute") {
      flush();
      execTotal++; if (isFailed) execFailed++;
      const text = clip(jsonField(d?.input, ["command", "cmd", "script"]) ?? t.title, LIMITS.commandChars);
      let tail: string | null = null;
      if (d?.output !== undefined && d.output !== "") {
        const w = redTail(d.output, "exec_output");
        tail = isFailed ? tailChars(lastLines(w, LIMITS.failureLines), LIMITS.failureTail) : tailBytes(lastLines(w, LIMITS.successLines), LIMITS.successTailBytes);
      }
      const command: DigestCommand = { text, exitCode, verification: VERIFY.test(text), irreversible: IRREVERSIBLE.test(text), failed: isFailed, tail };
      if (commands.length < LIMITS.commands) {
        commands.push(command);
        if (narrated.length < LIMITS.narrated) narrated.push({ kind: "execute", command: commands.length - 1 }); else narratedMore++;
      } else narratedMore++;
      if (isFailed && tail !== null) { failures.push({ title: clip(t.title, LIMITS.titleChars), command: text, exitCode, tail }); if (failures.length > LIMITS.failures) failures.shift(); }
      continue;
    }
    if (cat === "edit") {
      const raw = d?.locations?.[0] ?? diffPath(d?.diff) ?? jsonField(d?.input, ["file_path", "path", "filePath"]) ?? t.title;
      const path = clip(raw, LIMITS.pathChars);
      const st = d?.diff !== undefined && d.diff !== "" ? diffStats(d.diff, budget) : { added: null, removed: null, op: ((d?.kind ?? t.kind) === "delete" ? "delete" : (d?.kind ?? t.kind) === "move" ? "move" : "unknown") as EditOp };
      const prior = files.get(path);
      if (prior === undefined) { if (files.size < LIMITS.files) files.set(path, { ...st }); }
      else files.set(path, { op: prior.op === "create" && st.op !== "delete" ? "create" : st.op, added: prior.added === null || st.added === null ? null : prior.added + st.added, removed: prior.removed === null || st.removed === null ? null : prior.removed + st.removed });
      addToGroup("edit", { op: st.op, path, added: st.added, removed: st.removed }, path.length + 12, null);
      continue;
    }
    if (cat === "read") { const p = clip(d?.locations?.[0] ?? jsonField(d?.input, ["file_path", "path", "filePath"]) ?? t.title, LIMITS.pathChars); addToGroup("read", p, p.length + 3, null); continue; }
    if (cat === "search") {
      const p = clip(jsonField(d?.input, ["pattern", "query", "regex"]) ?? t.title, LIMITS.titleChars);
      let matches: number | null = null;
      if (d?.output !== undefined) matches = countLines(d.output.length > 65536 ? d.output.slice(0, 65536) : d.output);
      addToGroup("search", p, p.length + 3, matches); continue;
    }
    if (cat === "fetch") { external++; const n = clip(jsonField(d?.input, ["url", "uri", "server", "tool"]) ?? t.title, LIMITS.titleChars); addToGroup("fetch", { name: n, bytes: d?.output === undefined ? 0 : utf8(d.output) }, n.length + 8, null); continue; }
    const title = clip(t.title, LIMITS.titleChars);
    addToGroup(cat, title, title.length + 3, null);
  }
  flush();
  const replyRaw = src.replyText ?? "";
  const reply = { chars: replyRaw.length, tail: replyRaw === "" ? "" : sentenceTail(redTail(replyRaw, "text"), LIMITS.replyTail), present: src.replyText !== null && src.replyText !== "" };
  const plan = run.plan === undefined ? null : (() => {
    const open = run.plan!.entries.filter(e => e.status !== "completed");
    return { completed: run.plan!.entries.length - open.length, open: open.length, openItems: open.slice(0, LIMITS.planItems).map(e => clip(e.content, LIMITS.planChars)) };
  })();
  const acts = run.activities ?? [];
  const fileList: DigestFile[] = [...files.entries()].map(([path, f]) => ({ path, op: f.op, added: f.added, removed: f.removed, credentialPath: CREDENTIAL_PATH.test(path) }));
  const userNorm = normalize(src.userText.length > LIMITS.replyInput ? src.userText.slice(0, LIMITS.replyInput) : src.userText, "text", ctx.rules);
  const prev = ctx.previous;
  const attachments = (run.attachments ?? []).slice(0, LIMITS.outputs).map(a => ({ name: clip(a.name, LIMITS.titleChars), mediaType: headChars(a.mediaType, 80), bytes: a.bytes }));
  const base = {
    runId: run.id, index: run.index, seq: run.endSeq, userSeq: run.userSeq, policyVersion: ctx.policyVersion,
    executedOn: src.executedOn, by: { harnessId: run.selection.harnessId, model: src.model === null ? null : headChars(src.model, 120) }, status: run.status, dispatched: src.dispatched,
    error: run.error === null ? null : { code: headChars(run.error.code, 64), message: clip(run.error.message, LIMITS.errorChars) },
    sent: { sha256: src.sentSha256, packetId: src.packetId },
    user: { chars: src.userText.length, sha256: sha256hex(src.userText), attachments, head: redHead(src.userText, LIMITS.userHead) },
    reply,
    tools: { total: tools.length, failed, byKind, capped: tools.length >= LIMITS.maxRunTools, withOutput, withDiff, external, execTotal, execFailed, listed: 0 },
    narrated, commands, failures, files: fileList, plan,
    approvals: src.approvals.slice(0, LIMITS.approvals).map(a => ({ title: clip(a.title, LIMITS.titleChars), outcome: a.outcome, kind: a.kind })),
    activities: { compaction: acts.filter(a => a.kind === "compaction").length, subagents: acts.filter(a => a.kind === "subagent").length, background: acts.filter(a => a.kind === "task").length },
    outputs: (run.outputs ?? []).slice(0, LIMITS.outputs).map(o => ({ name: clip(o.name, LIMITS.titleChars), mediaType: headChars(o.mediaType, 80), bytes: o.bytes })),
    thinking: run.thinking !== undefined && run.thinking !== "",
    detailsMissing: tools.length >= LIMITS.maxRunTools || tools.some(t => !src.details.has(t.id)),
    cumulative: {
      runs: (prev?.runs ?? 0) + 1, toolCalls: (prev?.toolCalls ?? 0) + tools.length, replyChars: (prev?.replyChars ?? 0) + replyRaw.length, userChars: (prev?.userChars ?? 0) + src.userText.length,
      failures: (prev?.failures ?? 0) + (run.status === "failed" ? 1 : 0), toolOutputs: (prev?.toolOutputs ?? 0) + withOutput, diffs: (prev?.diffs ?? 0) + withDiff,
      externalOutputs: (prev?.externalOutputs ?? 0) + external, thinking: (prev?.thinking ?? 0) + (run.thinking ? 1 : 0), attachments: (prev?.attachments ?? 0) + (run.attachments?.length ?? 0),
      approvals: (prev?.approvals ?? 0) + src.approvals.length, replies: (prev?.replies ?? 0) + (reply.present ? 1 : 0),
    },
    redactions: 0,
  };
  // 尺寸：按未脱敏、已规范化的回复算（不扫描整段回复的秘密），上限 256 KiB；超过时 G1 整份不可能放下。
  const replyForSize = replyRaw.length > LIMITS.sizeCap ? null : normalize(replyRaw, "text", ctx.rules);
  // G2 只要首段与末段各 ≤600 字：头尾各取 8 KiB 窗口就够（更长的段反正会被截到 600 字）。
  const replyForCompact = replyRaw.length <= 16384 ? (replyForSize ?? normalize(replyRaw, "text", ctx.rules)) : normalize(replyRaw.slice(0, 8192) + "\n\n" + replyRaw.slice(-8192), "text", ctx.rules);
  const texts: SizeTexts = { reply: replyForSize, compact: replyRaw === "" ? null : replyForCompact, user: userNorm };
  // 先按字节上限收紧（尺寸字段是定长数字，留 1 KiB 余量），再只算一次尺寸。
  const unsized: RunDigest = { ...base, size: { zh: emptySizes(), en: emptySizes() }, untrusted: emptySizes(), userSize: { block: ZERO, compactBlock: ZERO }, verbatimSized: replyForSize !== null, redactions };
  return finishSizes(bound(unsized), texts, ctx.rules);
}
function emptySizes(): Record<"verbatim" | "compact" | "line", Size> { return { verbatim: ZERO, compact: ZERO, line: ZERO }; }
interface SizeTexts { readonly reply: string | null; readonly compact: string | null; readonly user: string }
function finishSizes(d: RunDigest, t: SizeTexts, rules: EscapeRules): RunDigest {
  const sizes = { zh: emptySizes(), en: emptySizes() };
  let untrusted = emptySizes(), listed = 0;
  const user = t.user;
  for (const lang of ["zh", "en"] as const) {
    const r = t.reply === null || t.reply === "" ? null : t.reply;
    const v = renderUnit(d, "verbatim", { user: null, reply: r }, lang, rules);
    const c = renderUnit(d, "compact", { user: null, reply: t.compact === null ? null : firstLastParagraphs(t.compact, lang) }, lang, rules);
    sizes[lang] = { verbatim: t.reply === null && d.reply.present ? { ascii: 1e9, cjk: 0, other: 0 } : measure(v.text), compact: measure(c.text), line: measure(renderLine(d, lang, rules)) };
    if (lang === "zh") { untrusted = { verbatim: v.untrusted, compact: c.untrusted, line: ZERO }; listed = v.listedTools; }
  }
  const userBlock = measure("用户原话：\n```text\n" + headTail(user, 4000, 3000, 800, "zh") + "\n```\n");
  const userCompact = measure("用户原话：\n```text\n" + headTail(user, 4000, 2500, 1000, "zh") + "\n```\n");
  return { ...d, size: sizes, untrusted, userSize: { block: userBlock, compactBlock: userCompact }, tools: { ...d.tools, listed } };
}
/** ≤64 KiB：按确定的顺序逐步收紧，直到序列化后放得下；收紧后重算尺寸。 */
function bound(d: RunDigest): RunDigest {
  let cur = d;
  for (let step = 0; utf8(JSON.stringify(cur)) > LIMITS.digestBytes - 1024 && step < 6; step++) {
    const half = (s: string, n: number): string => s.length > n ? headChars(s, n) + "…" : s;
    const k = [200, 100, 60, 30, 16, 8][step]!;
    cur = ({
      ...cur,
      narrated: cur.narrated.slice(0, Math.max(4, LIMITS.narrated >> (step + 1))).map(n => n.kind === "execute" ? n : n.kind === "edit" ? { ...n, items: n.items.map(e => ({ ...e, path: half(e.path, k) })) } : n.kind === "fetch" ? { ...n, items: n.items.map(f => ({ ...f, name: half(f.name, k) })) } : { ...n, items: n.items.map(s => half(s, k)) }),
      commands: cur.commands.map(c => ({ ...c, text: half(c.text, k), tail: c.tail === null ? null : headBytes(c.tail, k * 2) })),
      failures: cur.failures.map(f => ({ ...f, title: half(f.title, k), command: f.command === null ? null : half(f.command, k), tail: tailChars(f.tail, k * 3) })),
      files: cur.files.slice(0, Math.max(8, LIMITS.files >> (step + 1))).map(f => ({ ...f, path: half(f.path, k) })),
      plan: cur.plan === null ? null : { ...cur.plan, openItems: cur.plan.openItems.slice(0, Math.max(3, LIMITS.planItems >> (step + 1))).map(p => half(p, k)) },
      approvals: cur.approvals.slice(0, 4).map(a => ({ ...a, title: half(a.title, k) })),
      outputs: cur.outputs.slice(0, 4).map(o => ({ ...o, name: half(o.name, k) })),
      user: { ...cur.user, attachments: cur.user.attachments.slice(0, 4).map(a => ({ ...a, name: half(a.name, k) })) },
      reply: { ...cur.reply, tail: tailChars(cur.reply.tail, Math.max(60, k * 2)) },
    });
  }
  return cur;
}
