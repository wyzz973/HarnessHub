// 原型，仅用于测量，不是实现。依次跑全部测量，写 spikes/relay/results.json，并在终端打印摘要表。
// 用法：node spikes/relay/bench/run-all.ts            （临时库与临时仓库建在 os.tmpdir()；可用 RELAY_SPIKE_TMP 指定）
//       node spikes/relay/bench/run-all.ts --skip-git  （不跑测量 7）
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { machineInfo } from "./common.ts";
import * as budget from "./bench-budget.ts";
import * as digest from "./bench-digest.ts";
import * as render from "./bench-render.ts";
import * as fuzz from "./fuzz-escape.ts";
import * as redact from "./bench-redact.ts";
import * as sqlite from "./bench-sqlite.ts";
import * as git from "./bench-git.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
type Row = { readonly id: string; readonly name: string; readonly value: string; readonly target: string; readonly pass: boolean; readonly basis: string };
const fmt = (n: number, d = 2): string => n.toFixed(d);
const big = (n: number): string => n.toLocaleString("en-US");

const started = new Date().toISOString();
const t0 = Date.now();
const log = (s: string): void => { process.stderr.write("[" + ((Date.now() - t0) / 1000).toFixed(1) + "s] " + s + "\n"); };
log("budget"); const B = budget.run();
log("digest"); const D = digest.run();
log("render"); const R = await render.run() as any;
log("fuzz"); const F = fuzz.run() as any;
log("redact"); const X = redact.run() as any;
log("sqlite"); const S = sqlite.run() as any;
const G = process.argv.includes("--skip-git") ? null : (log("git"), await git.run() as any);
log("done");

const rows: Row[] = [];
const typical = D.profiles.filter(p => p.profile === "typical");
const worstTypicalP95 = Math.max(...typical.map(p => p.ms.p95));
const maxP = D.profiles.find(p => p.profile === "max")!, cjkP = D.profiles.find(p => p.profile === "typical-cjk")!, pathP = D.profiles.find(p => p.profile === "pathological-fields")!;
const maxBytes = Math.max(...D.profiles.map(p => p.bytes.max));
rows.push({ id: "1a", name: "RunDigest 抽取耗时 p50/p95（典型，0–128 个工具，取各档中最大的 p95）", value: fmt(Math.max(...typical.map(p => p.ms.p50)), 3) + " / " + fmt(worstTypicalP95, 3) + " ms", target: "p95 ≤ 2 ms CPU（v1 §11.1）", pass: worstTypicalP95 <= 2, basis: "实测" });
rows.push({ id: "1b", name: "RunDigest 抽取耗时 p50/p95（最坏：128 工具，输入 16 KiB / 输出 64 KiB / 差异 64 KiB，回复 1 MiB，中文）", value: fmt(maxP.ms.p50, 3) + " / " + fmt(maxP.ms.p95, 3) + " ms", target: "p95 ≤ 2 ms CPU", pass: maxP.ms.p95 <= 2, basis: "实测" });
rows.push({ id: "1c", name: "RunDigest 抽取耗时 p50/p95（病态：所有有上限的字段都用中文填满）", value: fmt(pathP.ms.p50, 3) + " / " + fmt(pathP.ms.p95, 3) + " ms", target: "p95 ≤ 2 ms CPU", pass: pathP.ms.p95 <= 2, basis: "实测" });
rows.push({ id: "1d", name: "RunDigest 记录字节（典型 128 工具 p95 / 全部剖面最大）", value: big(typical.find(p => p.tools === 128)!.bytes.p95) + " B / " + big(maxBytes) + " B", target: "≤ 64 KiB（65,536 B）", pass: maxBytes <= 65536, basis: "实测" });
rows.push({ id: "1e", name: "v1 §4 逐字段上限之和（全中文，未收紧）", value: big(D.fieldCapBound.total!) + " B", target: "≤ 64 KiB 需要最后一步收紧", pass: D.fieldCapBound.total! <= 65536, basis: "推算" });
for (const tier of ["standard", "full"] as const) {
  const m = R.timing[tier];
  rows.push({ id: "2-" + tier + "-mem", name: (tier === "standard" ? "标准档" : "完整档") + "投影 + 渲染 p50/p95（256 Run，快照 " + R.session.snapshotMiB + " MiB；摘要已在内存）", value: fmt(m.inMemory.p50) + " / " + fmt(m.inMemory.p95) + " ms", target: "p50 ≤ 5 ms，p95 ≤ 25 ms（v1 §11.1）", pass: m.inMemory.p50 <= 5 && m.inMemory.p95 <= 25, basis: "实测" });
  rows.push({ id: "2-" + tier + "-parse", name: (tier === "standard" ? "标准档" : "完整档") + "投影 + 渲染 p50/p95（含解析 256 行摘要 JSON，共 " + R.session.digestRowsKiB + " KiB）", value: fmt(m.parseRows.p50) + " / " + fmt(m.parseRows.p95) + " ms", target: "p50 ≤ 5 ms，p95 ≤ 25 ms", pass: m.parseRows.p50 <= 5 && m.parseRows.p95 <= 25, basis: "实测" });
}
rows.push({ id: "2-det", name: "同一输入渲染 100 次的 sha256 个数（标准档 / 完整档；另 3 个子进程、不同 TZ 与 LANG）", value: R.determinism.standard.distinctSha256 + " / " + R.determinism.full.distinctSha256 + "；子进程 " + R.determinism.crossProcess.children.filter((c: any) => c.sha256 === R.determinism.standard.sha256).length + "/3 相同", target: "1（v1 §11.1 硬性）", pass: R.determinism.standard.distinctSha256 === 1 && R.determinism.full.distinctSha256 === 1 && R.determinism.crossProcess.allEqualInProcess, basis: "实测" });
for (const tier of ["goal", "brief", "standard", "fidelity", "full"]) {
  const t = R.tiers[tier];
  if (t.outcome !== undefined) { rows.push({ id: "3-" + tier, name: "各档交接单（" + tier + "，256 Run）", value: t.outcome + "（" + (t.reason ?? "") + "）", target: "放得下、≤ 档上限", pass: false, basis: "实测" }); continue; }
  rows.push({ id: "3-" + tier, name: "交接单大小 · " + tier + " 档（256 Run，目标 dsh，est/1 系数 1.0；括号内为 Anthropic 系数 1.3）", value: big(t.bytes) + " B · " + big(t.estTokens) + " token（" + big(t.estTokensAnthropic) + "）· 不可信 " + big(t.untrustedTokens), target: "≤ " + big(t.cap) + " token，不可信 ≤ " + big(t.untrustedCap) + "；省略账目恒等式成立", pass: t.withinCap && t.untrustedTokens <= t.untrustedCap && t.identityErrors.length === 0, basis: "实测（token 为 est/1 估算）" });
}
rows.push({ id: "3-literal", name: "按 v1 §6.3 字面（fresh 目标的“上次送达以来的用户消息”= 全部 255 条）算必含块", value: big(R.tiers.standardLiteralUserWords.mustHaveTokens) + " token → " + R.tiers.standardLiteralUserWords.outcome, target: "≤ 8,000（标准档）；§0 称长历史只分层不失败", pass: R.tiers.standardLiteralUserWords.outcome !== "blocked", basis: "实测（est/1）" });
const s1 = R.s1;
rows.push({ id: "3-s1", name: "S1 样例实际大小（原型渲染，单 text：正文 + 换行 + 原话）", value: big(s1.prototype.bytes) + " B · " + big(s1.prototype.estTokensOpenAI) + " token（OpenAI 系数）/ " + big(s1.prototype.estTokensAnthropic) + "（Anthropic）· 不可信 " + s1.prototype.untrustedTokens + " · complete=" + s1.prototype.complete, target: "complete=true，且与 §12.1 卡片估算约 1.7k token 相差 ≤20%（v1 §5.6 另称叙述化历史约 1,650、不可信约 900，均为推算；文档样例全文 " + big(s1.docSample.bytes) + " B / " + big(s1.docSample.estTokensOpenAI) + " token）", pass: s1.prototype.complete && Math.abs(s1.prototype.estTokensOpenAI - 1700) / 1700 <= 0.2, basis: "实测（est/1）；文档数为推算" });
const fv1 = F.v1, fx = F.extended;
rows.push({ id: "4-core", name: "转义模糊测试（10,000 例，v1 规则）：核心性质违例的用例数", value: fv1.casesWithCoreViolation + " / " + big(fv1.packets) + " 个交接单（另 " + fv1.raw + " 例零注入原样发送）；检查了 " + big(fv1.counts.fences) + " 个围栏、" + big(fv1.counts.regions) + " 个记录区、" + big(fv1.counts.spans) + " 个行内代码、" + big(fv1.counts.sentinels) + " 个哨兵", target: "0：开闭定界符各恰好一个，不可信字节都在槽位内（J4 M6）", pass: fv1.casesWithCoreViolation === 0 && fv1.threw === 0, basis: "实测" });
rows.push({ id: "4-mut", name: "检查器的变异对照（故意弄坏 5 条转义规则，各 1,000 例）", value: Object.entries(F.mutations).map(([k, v]: [string, any]) => k + " " + v.casesWithCoreViolation + "/" + v.packets).join("；"), target: "每个变异都被检出（>0）", pass: Object.values(F.mutations).every((v: any) => v.casesWithCoreViolation > 0), basis: "实测" });
rows.push({ id: "4-ext-v1", name: "扩展性质在 v1 规则下（不可见字符全集、增量/英文框架标记、大小写与全角定界符变体）", value: big(fv1.casesWithExtendedViolation) + " / " + big(fv1.packets) + "（不可见 " + big(fv1.violations.extended.invisible_ext ?? 0) + "、伪造标记 " + big(fv1.violations.extended.forged_marker_line_ext ?? 0) + "、定界符变体 " + big(fv1.violations.extended.lookalike_delimiter ?? 0) + "）", target: "0（原型建议，不是 v1 条款）", pass: false, basis: "实测" });
rows.push({ id: "4-ext-x", name: "扩展规则下的扩展性质（只剩首行逐字前缀的影响）", value: big(fx.casesWithExtendedViolation) + " / " + big(fx.packets) + "（首行反引号奇数 " + (fx.violations.extended.first_line_odd_backticks ?? 0) + "、首行开出代码围栏 " + (fx.violations.extended.first_line_opens_fence ?? 0) + "）；核心违例 " + fx.casesWithCoreViolation, target: "0（原型建议）", pass: fx.casesWithExtendedViolation === 0, basis: "实测" });
const tp = X.throughput;
rows.push({ id: "5-tp", name: "精确匹配脱敏吞吐（1 MiB、50 个秘密 = " + tp["regex/raw"].patterns + " 个模式；regex 引擎；原文视图 / 骨架视图 / 骨架 + 形状规则）", value: tp["regex/raw"].msPerMiB.p50 + " / " + tp["regex/skeleton"].msPerMiB.p50 + " / " + tp["regex/skeleton+shapes"].msPerMiB.p50 + " ms/MiB（p50）；" + tp["regex/raw"].MiBps + " MiB/s", target: "v1 §11.1 引 P3 本机约 10 ms/MiB；扫描上限 2 MiB", pass: tp["regex/skeleton+shapes"].msPerMiB.p95 <= 10, basis: "实测" });
const fxr = X.fixture;
rows.push({ id: "5-fx", name: "已知秘密夹具漏检数（" + fxr["regex/skeleton+shapes"].cases + " 例 × 12 种引擎/视图/形状组合；原值、JSON 转义、URL 编码 × 10 种上下文 + 重叠）", value: String(Object.values(fxr).reduce((a: number, v: any) => a + v.missed, 0)), target: "0（J4 M1）", pass: Object.values(fxr).every((v: any) => v.missed === 0), basis: "实测" });
rows.push({ id: "5-hash", name: "输出中出现秘密原值的未加盐 sha256 的个数", value: String(X.unsaltedHashHits), target: "0（INV-29）", pass: X.unsaltedHashHits === 0, basis: "实测" });
const s8 = S.snapshot8MiB, s1m = S.snapshot1MiB;
rows.push({ id: "6-inc", name: "run.ended 事务里追加 relay_digests 行的提交耗时增量（成对差 p50 / p95；8 MiB 快照 · 1 MiB 快照）", value: fmt(s8.pairedIncrementMs.p50, 3) + " / " + fmt(s8.pairedIncrementMs.p95, 3) + " ms · " + fmt(s1m.pairedIncrementMs.p50, 3) + " / " + fmt(s1m.pairedIncrementMs.p95, 3) + " ms（基线提交 " + fmt(s8.commitWithoutDigestMs.p50) + " ms / " + fmt(s1m.commitWithoutDigestMs.p50) + " ms）", target: "额外提交 0；摘要写入 p95 ≤ 2 ms（v1 §11.1）", pass: s8.pairedIncrementMs.p95 <= 2 && s1m.pairedIncrementMs.p95 <= 2, basis: "实测（node:sqlite " + S.sqliteVersion + "，WAL + synchronous=FULL）" });
rows.push({ id: "6-append", name: "只追加一行摘要的独立提交 p50 / p95（与 R6“账本式追加”同口径）", value: fmt(s8.appendOnlyCommitMs.p50, 3) + " / " + fmt(s8.appendOnlyCommitMs.p95, 3) + " ms；WAL " + big(s8.appendOnlyWalBytes?.p50 ?? 0) + " B/次", target: "R6 实测 0.06 / 0.75 ms（参考）", pass: s8.appendOnlyCommitMs.p95 <= 2, basis: "实测" });
rows.push({ id: "6-read", name: "从 relay_digests 读 256 行并解析 p50 / p95", value: fmt(s8.read256DigestsAndParseMs.p50) + " / " + fmt(s8.read256DigestsAndParseMs.p95) + " ms", target: "（无单列目标；计入渲染预算时见 2-*-parse）", pass: s8.read256DigestsAndParseMs.p95 <= 25, basis: "实测" });
if (G !== null) {
  const ob = G.timings.observation;
  rows.push({ id: "7-obs", name: "工作区观测（status 与 diff 并行）p50 / p95，本工作区 " + G.worktree.trackedFiles + " 个跟踪文件", value: fmt(ob.p50) + " / " + fmt(ob.p95) + " ms（status " + fmt(G.timings.status.p50) + "，diff " + fmt(G.timings.diff.p50) + "）；超 250 ms " + ob.timeoutsAt250ms + " 次", target: "3k 文件 p95 ≤ 60 ms，硬上限 250 ms（v1 §11.1）", pass: ob.p95 <= 60 && ob.timeoutsAt250ms === 0, basis: "实测（本工作区不足 3k 文件）" });
  const sp = G.safetyProbe as Record<string, number>;
  const ran = Object.entries(sp).filter(([k, v]) => v > 0 && !k.includes("对照"));
  rows.push({ id: "7-exec", name: "观测命令在合成仓库里是否会执行仓库配置的外部程序（clean 过滤器 / fsmonitor / 钩子）", value: ran.map(([k, v]) => k.replace(/ →.*$/, "") + "：" + v + " 次").join("；"), target: "0 次（v1 §10.6：观测子进程不得在别处执行代码）", pass: ran.length === 0, basis: "实测（git " + String(machineInfo().git) + "）" });
}
rows.push({ id: "b-invalid", name: "预算解析器：无效配置明确失败", value: B.rejected.filter((r: any) => r.rejected).length + " / " + B.rejected.length, target: "全部拒绝（AGENTS.md：无效配置明确失败）", pass: B.allRejected, basis: "实测" });
const d2 = R.delta.s2;
rows.push({ id: "d-s2", name: "A→B→A 增量（S2：dsh 做 2 轮后回 Claude Code）：带基准交接单 / 无基准（原型补全约定）", value: big(d2.baseFromDoc.estTokens) + " / " + big(d2.baseNull.estTokens) + " token（Anthropic 系数）；渲染 p95 " + fmt(d2.baseFromDoc.renderMs.p95, 3) + " ms；之后一条原样发送：" + d2.baseNull.nextTurn.kind, target: "v1 §5.6 约 520 token（推算）；文档样例全文 " + big(d2.docSample.estTokensAnthropic) + " token（Anthropic）；增量 ≤ 1,500", pass: d2.baseFromDoc.estTokens <= 1500 && d2.baseNull.estTokens <= 1500 && d2.baseNull.nextTurn.identical === true, basis: "实测（est/1）" });
const a128 = R.delta.awayScaling.away128;
rows.push({ id: "d-away", name: "离开期间 128 轮的增量", value: big(a128.estTokens ?? 0) + " token（上限 " + (a128.cap ?? "?") + "）；逐字用户原话 " + (a128.userWordsShown ?? 0) + " 条、只计数 " + (a128.userWordsOmitted ?? 0) + " 条", target: "J3 M8：上次送达以来的用户消息不得省略；DELTA_USER_CAP 4,000", pass: (a128.userWordsOmitted ?? 1) === 0, basis: "实测（est/1）" });

const results = {
  meta: { title: "HarnessHub Relay v1 原型测量（spikes/relay）", disclaimer: "原型，仅用于测量，不是实现。全部输入为合成数据。", startedAt: started, wallSeconds: Number(((Date.now() - t0) / 1000).toFixed(1)), machine: { ...machineInfo(), sqlite: S.sqliteVersion },
    baseline: { branch: "cc/relay-design", base: "07a0825", design: "docs/proposals/relay/round3/v1-architecture.md" }, command: "node spikes/relay/bench/run-all.ts" },
  measurements: rows,
  raw: { budget: B, digest: D, render: R, fuzz: F, redact: X, sqlite: S, git: G },
};
writeFileSync(join(HERE, "..", "results.json"), JSON.stringify(results, null, 2) + "\n");
for (const r of rows) process.stdout.write((r.pass ? "PASS " : "FAIL ") + r.id.padEnd(16) + r.name + "\n      " + r.value + "\n      目标：" + r.target + "\n");
