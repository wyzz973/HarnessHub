// 原型，仅用于测量，不是实现。v1 §5.2 叙述化规则 relay/1 的单元渲染：G1 照录、G2 精简、G3 单行、区间行。
// 摘要（digest.ts）用同一套函数算尺寸，交接单（packet.ts）用它出正文，两边字节一致。
import { block, inline } from "./escape.ts";
import type { EscapeRules } from "./escape.ts";
import { add, headChars, measure, tailChars, utf8, ZERO } from "./text.ts";
import type { Language, RunDigest, Size } from "./types.ts";

export const DISPLAY: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", dsh: "DeepSeek Harness", hermes: "Hermes Agent", openclaw: "OpenClaw", workbuddy: "WorkBuddy" };
export function displayName(harnessId: string): string { return DISPLAY[harnessId] ?? harnessId; }
export function turn(index: number): number { return index + 1; }

/** 与 src/contracts/session.ts:344–351 的 cancelledLabel 相同的文案。 */
function cancelledLabel(d: RunDigest): string {
  switch (d.error?.code) {
    case "RUN_TIMEOUT": return "已取消（执行预算用尽）";
    case "WAIT_EXPIRED": return "已取消（等待你的决定超时）";
    case "OWNER_ENDED": return "已取消（服务重启，这条消息没有发出）";
  }
  return "已取消";
}
export function resultLabel(d: RunDigest, lang: Language, rules: EscapeRules): string {
  const code = d.error === null ? "" : inline(d.error.code, rules, lang, 64);
  if (lang === "zh") {
    switch (d.status) { case "completed": return "完成"; case "failed": return "失败（" + code + "）"; case "cancelled": return cancelledLabel(d); case "unknown": return "结果未核实"; default: return d.status; }
  }
  switch (d.status) { case "completed": return "completed"; case "failed": return "failed (" + code + ")"; case "cancelled": return "cancelled"; case "unknown": return "result not verified"; default: return d.status; }
}
const span = (raw: string, rules: EscapeRules, lang: Language, max = 400): string => "`" + inline(raw, rules, lang, max) + "`";
export function bytesLabel(n: number): string { return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
function counts(a: number | null, r: number | null): string {
  const parts: string[] = [];
  if (a !== null && a > 0) parts.push("+" + a);
  if (r !== null && r > 0) parts.push("−" + r);
  return parts.length === 0 ? "" : "（" + parts.join(" ") + "）";
}
function countsEn(a: number | null, r: number | null): string {
  const parts: string[] = [];
  if (a !== null && a > 0) parts.push("+" + a);
  if (r !== null && r > 0) parts.push("−" + r);
  return parts.length === 0 ? "" : " (" + parts.join(" ") + ")";
}
export function elision(lang: Language, omitted: number): string { return lang === "zh" ? "…（中间省略 " + omitted + " 字）…" : "… (" + omitted + " characters omitted) …"; }
/** 头尾截断，中间插一行省略说明（在块内）。 */
export function headTail(text: string, max: number, head: number, tail: number, lang: Language): string {
  if (text.length <= max) return text;
  const h = headChars(text, head), t = tailChars(text, tail);
  return h + "\n" + elision(lang, text.length - h.length - t.length) + "\n" + t;
}
/** G2 的回复：首段与末段各 ≤600 字（段 = 空行分隔）。 */
export function firstLastParagraphs(text: string, lang: Language): string {
  const paras = text.split(/\n\s*\n/);
  const first = headChars(paras[0] ?? "", 600);
  if (paras.length === 1) return text.length <= 1200 ? text : first + "\n" + elision(lang, text.length - 1200) + "\n" + tailChars(text, 600);
  const last = tailChars(paras[paras.length - 1]!, 600);
  const omitted = Math.max(0, text.length - first.length - last.length);
  return omitted === 0 ? first + "\n\n" + last : first + "\n" + elision(lang, omitted) + "\n" + last;
}

export interface UnitTexts {
  /** 已规范化、已脱敏、已按等级截断的用户原话；null 表示该轮原话已在 §2，单元里不重复。 */
  readonly user: string | null;
  /** 已规范化、已脱敏、已截断的回复；null 表示没有回复。 */
  readonly reply: string | null;
}
export interface Rendered { readonly text: string; readonly untrusted: Size; readonly listedTools: number; readonly shownOutputs: number }

/** 单元（G1 / G2）。block 内容在这里 neutralize + 围栏；不可信部分的尺寸单独累计。 */
export function renderUnit(d: RunDigest, grade: "verbatim" | "compact", texts: UnitTexts, lang: Language, rules: EscapeRules): Rendered {
  const out: string[] = [];
  let untrusted = ZERO, listedTools = 0, shownOutputs = 0;
  const name = displayName(d.by.harnessId), zh = lang === "zh";
  const model = d.by.model === null ? "" : (zh ? "（" + span(d.by.model, rules, lang, 120) + "）" : " (" + span(d.by.model, rules, lang, 120) + ")");
  out.push((zh ? "### 第 " + turn(d.index) + " 轮 · " : "### Turn " + turn(d.index) + " · ") + name + model + (zh && model !== "" ? "· " : " · ") + resultLabel(d, lang, rules) + "\n");
  if (texts.user !== null) out.push((zh ? "用户原话：\n" : "The user's words:\n") + block(texts.user, rules, lang) + "\n");
  if (d.user.attachments.length > 0) out.push((zh ? "附件：" : "Attachments: ") + d.user.attachments.slice(0, 8).map(a => span(a.name, rules, lang, 200) + (zh ? "（" : " (") + inline(a.mediaType, rules, lang, 80) + (zh ? "，" : ", ") + bytesLabel(a.bytes) + (zh ? "）" : ")")).join(zh ? "、" : ", ") + (zh ? "。\n" : ".\n"));
  const track = (s: string): string => { untrusted = add(untrusted, measure(s)); return s; };
  if (grade === "verbatim") {
    if (d.narrated.length > 0) out.push(zh ? name + " 的操作（按发生顺序）：\n" : name + "'s actions, in order:\n");
    else if (d.tools.total === 0) out.push(zh ? name + " 这一轮没有调用工具。\n" : name + " used no tools in this turn.\n");
    for (const item of d.narrated) {
      if (item.kind === "execute") {
        const c = d.commands[item.command]!;
        listedTools++;
        const cmd = track(span(c.text, rules, lang));
        const exit = c.exitCode === null ? (zh ? "未报告退出码" : "no exit code reported") : (zh ? "退出码 " + c.exitCode : "exit code " + c.exitCode);
        out.push("- " + (zh ? "执行 " : "Ran ") + cmd + " → " + exit + (zh ? "。" : "."));
        if (c.tail !== null && c.tail !== "") { out.push(zh ? "输出末尾：\n" : " Output tail:\n"); out.push(track(block(c.tail, rules, lang, "  ")) + "\n"); shownOutputs++; }
        else out.push("\n");
        continue;
      }
      const more = item.more > 0 ? (zh ? " 等 " + (item.items.length + item.more) + " 项" : " and " + item.more + " more") : "";
      listedTools += item.items.length;
      if (item.kind === "read") out.push("- " + (zh ? "读取 " : "Read ") + item.items.map(p => track(span(p, rules, lang))).join(zh ? "、" : ", ") + more + (zh ? "。\n" : ".\n"));
      else if (item.kind === "search") out.push("- " + (zh ? "搜索 " : "Searched ") + item.items.map(p => track(span(p, rules, lang))).join(zh ? "、" : ", ") + more + (item.matches === null ? "" : zh ? "：" + item.matches + " 处匹配" : ": " + item.matches + " matches") + (zh ? "。\n" : ".\n"));
      else if (item.kind === "edit") {
        const groups: string[] = []; let op: string | null = null, members: string[] = [];
        const opWord = (o: string): string => zh ? ({ create: "新建", delete: "删除", move: "移动", edit: "修改", unknown: "改动" } as Record<string, string>)[o]! : ({ create: "Created", delete: "Deleted", move: "Moved", edit: "Edited", unknown: "Changed" } as Record<string, string>)[o]!;
        for (const e of item.items) {
          if (e.op !== op) { if (op !== null) groups.push(opWord(op) + " " + members.join(zh ? "、" : ", ")); op = e.op; members = []; }
          members.push(track(span(e.path, rules, lang)) + (zh ? counts(e.added, e.removed) : countsEn(e.added, e.removed)));
        }
        if (op !== null) groups.push(opWord(op) + " " + members.join(zh ? "、" : ", "));
        out.push("- " + groups.join(zh ? "；" : "; ") + more + (zh ? "。\n" : ".\n"));
      } else if (item.kind === "fetch") out.push("- " + (zh ? "获取 " : "Fetched ") + item.items.map(f => track(span(f.name, rules, lang, 200)) + (zh ? "（" + bytesLabel(f.bytes) + "）" : " (" + bytesLabel(f.bytes) + ")")).join(zh ? "、" : ", ") + more + (zh ? "，正文未附。\n" : "; content not included.\n"));
      else out.push("- " + (item.kind === "subagent" ? (zh ? "子 Agent：" : "Sub-agent: ") : (zh ? "其他操作：" : "Other: ")) + item.items.map(t => track(span(t, rules, lang, 200))).join(zh ? "、" : ", ") + more + (zh ? "。\n" : ".\n"));
    }
    if (d.detailsMissing) out.push(zh ? "（这一轮的工具详情没有完整记录，上面的操作不完整。）\n" : "(Tool details for this turn were not fully recorded; the list above is incomplete.)\n");
  } else {
    // G2：操作压成三行（文件 ≤12 个、命令 ≤8 条、其余计数）。
    const files = d.files.slice(0, 12);
    if (files.length > 0) out.push("- " + (zh ? "文件：" : "Files: ") + files.map(f => track(span(f.path, rules, lang)) + (zh ? counts(f.added, f.removed) : countsEn(f.added, f.removed))).join(zh ? "、" : ", ") + (d.files.length > 12 ? (zh ? "（共 " + d.files.length + " 个）" : " (" + d.files.length + " in all)") : "") + "\n");
    const cmds = d.commands.slice(0, 8);
    if (cmds.length > 0) out.push("- " + (zh ? "命令：" : "Commands: ") + cmds.map(c => track(span(c.text, rules, lang, 200)) + " → " + (c.exitCode ?? "?")).join(zh ? "；" : "; ") + (d.tools.execTotal > cmds.length ? (zh ? "（共 " + d.tools.execTotal + " 条，" + d.tools.execFailed + " 条失败）" : " (" + d.tools.execTotal + " in all, " + d.tools.execFailed + " failed)") : "") + "\n");
    listedTools += files.length + cmds.length;
    const others = Object.entries(d.tools.byKind).filter(([k]) => k !== "execute" && k !== "edit" && k !== "think").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (others.length > 0) out.push("- " + (zh ? "其他：" : "Other: ") + others.map(([k, n]) => (zh ? (({ read: "读取", search: "搜索", fetch: "获取", subagent: "子 Agent", think: "思考", other: "其他" } as Record<string, string>)[k] ?? k) + " " + n + " 次" : k + " ×" + n)).join(zh ? "、" : ", ") + "\n");
  }
  if (d.plan !== null && grade === "verbatim") out.push((zh ? "计划（本轮结束时）：已完成 " + d.plan.completed + " 项" : "Plan at the end of this turn: " + d.plan.completed + " done") + (d.plan.openItems.length > 0 ? (zh ? "；未完成：" : "; open: ") + d.plan.openItems.map(p => track(span(p, rules, lang, 200))).join(zh ? "；" : "; ") : "") + (zh ? "。\n" : ".\n"));
  const act = d.activities;
  if (grade === "verbatim" && act.compaction + act.subagents + act.background > 0) {
    const parts = zh ? [act.compaction ? "压缩 " + act.compaction + " 次" : "", act.subagents ? "子 Agent " + act.subagents + " 个" : "", act.background ? "后台任务 " + act.background + " 个" : ""] : [act.compaction ? act.compaction + " compaction(s)" : "", act.subagents ? act.subagents + " sub-agent(s)" : "", act.background ? act.background + " background task(s)" : ""];
    out.push((zh ? "活动：" : "Activity: ") + parts.filter(Boolean).join(zh ? "、" : ", ") + (zh ? "。\n" : ".\n"));
  }
  if (grade === "verbatim" && d.outputs.length > 0) out.push((zh ? "产物：" : "Outputs: ") + d.outputs.slice(0, 8).map(o => span(o.name, rules, lang, 200) + (zh ? "（" : " (") + inline(o.mediaType, rules, lang, 80) + (zh ? "，" : ", ") + bytesLabel(o.bytes) + (zh ? "）" : ")")).join(zh ? "、" : ", ") + (zh ? "，只列名称。\n" : "; names only.\n"));
  if (texts.reply !== null) {
    out.push(grade === "verbatim" ? (zh ? name + " 的回复：\n" : name + "'s reply:\n") : (zh ? name + " 的回复（首段与末段）：\n" : name + "'s reply (first and last paragraphs):\n"));
    out.push(track(block(texts.reply, rules, lang)) + "\n");
  }
  return { text: out.join(""), untrusted, listedTools, shownOutputs };
}

/** 中文的“ · ”在全角右括号之后写作“· ”（与 v1 §5.2 的 G3 例句一致）；只看可信的结构片段，不改不可信内容。 */
function dot(prev: string, zh: boolean): string { return zh && (prev.endsWith("）") || prev.endsWith("」")) ? "· " : " · "; }
/** G3 单行（≤400 B）：用户原话前 120 字压到放得下为止。 */
export function renderLine(d: RunDigest, lang: Language, rules: EscapeRules): string {
  const zh = lang === "zh", name = displayName(d.by.harnessId);
  const model = d.by.model === null ? "" : (zh ? "（" + span(d.by.model, rules, lang, 80) + "）" : " (" + span(d.by.model, rules, lang, 80) + ")");
  const tail: string[] = [];
  if (d.files.length > 0) tail.push(zh ? "改 " + d.files.length + " 个文件" : d.files.length + " files changed");
  if (d.tools.execTotal > 0) tail.push(zh ? "执行 " + d.tools.execTotal + " 条命令" + (d.tools.execFailed > 0 ? "（" + d.tools.execFailed + " 条失败）" : "") : d.tools.execTotal + " commands" + (d.tools.execFailed > 0 ? " (" + d.tools.execFailed + " failed)" : ""));
  const label = resultLabel(d, lang, rules);
  const head = (zh ? "- 第 " + turn(d.index) + " 轮 · " : "- Turn " + turn(d.index) + " · ") + name + model + (zh && model !== "" ? "· " : " · ") + label;
  const restSep = (prev: string): string => tail.length === 0 ? "" : dot(prev, zh) + tail.join(" · ");
  const base = utf8(head) + utf8(restSep("`")) + utf8(zh ? " · 用户：``" : " · user: ``");
  let n = d.user.head.length;
  let user = n === 0 ? "" : span(d.user.head, rules, lang, n);
  while (n > 0 && base + utf8(user) - 2 > 400) { n = Math.floor(n * 0.75); user = n === 0 ? "" : span(d.user.head, rules, lang, n); }
  const withUser = user === "" ? head : head + dot(label, zh) + (zh ? "用户：" : "user: ") + user;
  return withUser + restSep(user === "" ? label : "`") + "\n";
}

/** 区间行（≤600 B）：执行者分布、失败轮数、改动文件（最多列 5 个）、命令数。 */
export function renderRange(ds: readonly RunDigest[], lang: Language, rules: EscapeRules): string {
  const zh = lang === "zh";
  const by = new Map<string, number>(); let failed = 0, exec = 0, execFailed = 0;
  const files: string[] = []; const seen = new Set<string>();
  for (const d of ds) {
    by.set(d.by.harnessId, (by.get(d.by.harnessId) ?? 0) + 1);
    if (d.status === "failed" || d.status === "cancelled" || d.status === "unknown") failed++;
    exec += d.tools.execTotal; execFailed += d.tools.execFailed;
    for (const f of d.files) if (!seen.has(f.path)) { seen.add(f.path); files.push(f.path); }
  }
  const who = [...by.entries()].map(([h, n]) => displayName(h) + (zh ? " " + n + " 轮" : " " + n)).join(zh ? "、" : ", ");
  const first = turn(ds[0]!.index), last = turn(ds[ds.length - 1]!.index);
  const head = (zh ? "- 第 " + first + "–" + last + " 轮（" + who + (failed > 0 ? "；失败或未完成 " + failed + " 轮" : "") + "）" : "- Turns " + first + "–" + last + " (" + who + (failed > 0 ? "; " + failed + " failed or unfinished" : "") + ")");
  const cmdSep = (prev: string): string => exec > 0 ? dot(prev, zh) + (zh ? "执行 " + exec + " 条命令" + (execFailed > 0 ? "（" + execFailed + " 条失败）" : "") : exec + " commands" + (execFailed > 0 ? " (" + execFailed + " failed)" : "")) : "";
  for (let k = Math.min(5, files.length); k >= 0; k--) {
    const list = files.slice(0, k).map(p => span(p, rules, lang, 120)).join(zh ? "、" : ", ");
    const f = files.length === 0 ? "" : zh ? dot(head, zh) + "改动 " + files.length + " 个文件" + (k > 0 ? "（" + list + (files.length > k ? " 等" : "") + "）" : "") : " · " + files.length + " files changed" + (k > 0 ? " (" + list + (files.length > k ? ", …" : "") + ")" : "");
    const line = head + f + cmdSep(f === "" ? head : f) + "\n";
    if (utf8(line) <= 600 || k === 0) return line;
  }
  return head + cmdSep(head) + "\n";
}
