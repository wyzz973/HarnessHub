// 原型，仅用于测量，不是实现。测量 2、3 与增量：256 Run / 约 8 MiB 合成会话上的投影 + 渲染耗时、确定性、各档字节与 token、
// S1 样例的实际大小、A→B→A 增量。所有输入都是合成数据。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseBudget, resolveRelayPolicy } from "../proto/budget.ts";
import type { RelayPolicy } from "../proto/budget.ts";
import { freshBinding, onDispatchWithPacket, onOwnRunRecorded, onSettled } from "../proto/delivery.ts";
import { V1_RULES } from "../proto/escape.ts";
import { buildPacket, checkIdentity } from "../proto/packet.ts";
import type { PacketOutcome } from "../proto/packet.ts";
import { createRedactor } from "../proto/redaction.ts";
import type { Redactor } from "../proto/redaction.ts";
import { estText, sha256hex, utf8 } from "../proto/text.ts";
import type { BindingRelayState, RelayPacketId, RunDigest, Tier } from "../proto/types.ts";
import { TIERS } from "../proto/types.ts";
import { buildSession, s1Session, s2Session, sessionOfSize, syntheticSecrets, TEST_KEY } from "./gen.ts";
import type { SynthSession } from "./gen.ts";
import { digestAll, now, summary, TARGETS, textsOf } from "./common.ts";
import type { Digested } from "./common.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DOC = join(ROOT, "..", "..", "docs", "proposals", "relay", "round3", "v1-architecture.md");
const INPUT = "继续把剩下的币种测试补完，别改已有的断言。";
const BIG = { runs: 256, seed: 1, harnesses: ["claude", "codex"], switchEvery: 4, replyBytes: 16000, inputBytes: 1000, thinkingBytes: 4000, toolsPerRun: 20, detail: "typical" as const, plantEvery: 23, failEvery: 9, planEvery: 5, approvalsEvery: 11, attachmentsEvery: 13 };

interface Fixture { readonly s: SynthSession; readonly dg: Digested; readonly redactor: Redactor; readonly policy: RelayPolicy }
export function bigFixture(): Fixture {
  const secrets = syntheticSecrets(12);
  const redactor = createRedactor(secrets, TEST_KEY);
  const s = sessionOfSize(8 * 1024 * 1024, { ...BIG, secrets });
  return { s, dg: digestAll(s, redactor, V1_RULES), redactor, policy: resolveRelayPolicy() };
}
function packetFor(f: Fixture, digests: readonly RunDigest[], tier: Tier, target = "dsh", binding?: BindingRelayState, input = INPUT, userWords: "bounded" | "literal" = "bounded"): PacketOutcome {
  const t = TARGETS[target]!;
  const b = chooseBudget(f.policy, t.spec, t.window, { currentInput: input, ...(tier === "standard" ? {} : { userTier: tier }) });
  if (b.kind !== "ok") throw new Error("budget blocked: " + b.reason);
  return buildPacket({ policy: f.policy, budget: b.budget, family: t.spec.family, target: { harnessId: t.spec.harnessId, controlId: t.spec.controlId, model: t.spec.model, vendor: t.vendor, parts: t.spec.placement.parts },
    binding: binding ?? freshBinding(t.spec.harnessId, t.spec.controlId), digests, digestSha: i => f.dg.sha[i]!, texts: textsOf(f.s), current: { input, index: digests.length },
    firstUserText: f.s.firstUserText, observation: f.s.observation, observationSeq: f.s.lastSeq, redactor: f.redactor, rules: V1_RULES, userWords });
}
function time(fn: () => void, n: number, warm: number): ReturnType<typeof summary> {
  for (let i = 0; i < warm; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = now(); fn(); xs.push(now() - t); }
  return summary(xs, 3);
}
function foldSummary(o: PacketOutcome): Record<string, number> {
  if (o.kind !== "packet") return {};
  const m: Record<string, number> = {};
  for (const f of o.manifest.fold) { const k = f.kind === "unit" ? f.grade : f.kind; m[k] = (m[k] ?? 0) + (f.kind === "range" ? f.units : 1); }
  return m;
}
/** 从 v1 文档里取出 §5.6 的样例全文（只读文件，用于和原型输出比大小）。 */
function docSample(marker: string): string | null {
  try {
    const lines = readFileSync(DOC, "utf8").split("\n");
    const at = lines.findIndex(l => l.startsWith(marker));
    if (at < 0) return null;
    const open = lines.findIndex((l, i) => i > at && l === "`````text");
    const close = lines.findIndex((l, i) => i > open && l === "`````");
    return lines.slice(open + 1, close).join("\n");
  } catch { return null; }
}

export async function run(): Promise<Record<string, unknown>> {
  const f = bigFixture();
  const out: Record<string, unknown> = { session: { runs: f.s.sources.length, snapshotMiB: Number((f.s.snapshotBytes / 1048576).toFixed(2)), digestRowsKiB: Math.round(f.dg.json.reduce((a, j) => a + utf8(j), 0) / 1024), digestRowMaxBytes: Math.max(...f.dg.json.map(utf8)) } };
  // ---- 测量 2：投影 + 渲染耗时（标准档、完整档），两种输入：摘要已在内存；每次从 256 行 JSON 解析 ----
  const timing: Record<string, unknown> = {};
  for (const tier of ["standard", "full"] as const) {
    timing[tier] = {
      inMemory: time(() => { packetFor(f, f.dg.digests, tier); }, 300, 30),
      parseRows: time(() => { packetFor(f, f.dg.json.map(j => JSON.parse(j) as RunDigest), tier); }, 300, 30),
    };
  }
  timing.parseRowsOnly = time(() => { for (const j of f.dg.json) JSON.parse(j); }, 300, 30);
  out.timing = timing;
  // ---- 确定性：同一输入渲染 100 次（每次从 JSON 重新解析摘要），再跨 3 个子进程（不同 TZ / LANG）各渲染一次 ----
  const det: Record<string, unknown> = {};
  for (const tier of ["standard", "full"] as const) {
    const shas = new Set<string>(), ids = new Set<string>();
    for (let i = 0; i < 100; i++) { const o = packetFor(f, f.dg.json.map(j => JSON.parse(j) as RunDigest), tier); if (o.kind === "packet") { shas.add(sha256hex(o.body)); ids.add(o.manifest.id); } }
    det[tier] = { renders: 100, distinctSha256: shas.size, distinctIds: ids.size, sha256: [...shas][0] };
  }
  const child = [{ TZ: "UTC", LANG: "C", LC_ALL: "C" }, { TZ: "Asia/Shanghai", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" }, { TZ: "America/Los_Angeles", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }].map(env => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--once"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 120000 });
    return { env: env.TZ + "/" + env.LANG, sha256: r.stdout.trim(), status: r.status };
  });
  det.crossProcess = { children: child, allEqualInProcess: child.every(c => c.sha256 === (det.standard as { sha256: string }).sha256) };
  out.determinism = det;
  // ---- 测量 3：各档字节与 token（256 Run 会话），并核对省略账目恒等式 ----
  const tiers: Record<string, unknown> = {};
  for (const tier of TIERS) {
    const o = packetFor(f, f.dg.digests, tier);
    if (o.kind !== "packet") { tiers[tier] = { outcome: o.kind, ...(o.kind === "blocked" ? { reason: o.reason, mustHaveTokens: o.mustHaveTokens, cap: o.cap } : {}) }; continue; }
    tiers[tier] = { cap: o.stats.capTokens, bytes: o.manifest.body.bytes, estTokens: o.manifest.body.estTokens, estTokensAnthropic: estText(o.body, "anthropic"), estTokensOpenAI: estText(o.body, "openai"), untrustedTokens: o.manifest.body.untrustedTokens,
      untrustedCap: f.policy.untrustedCap[tier], withinCap: o.manifest.body.estTokens <= o.stats.capTokens, mustHaveTokens: o.stats.mustHaveTokens, fold: foldSummary(o), goalsMessages: o.stats.goalsMessages, identityErrors: checkIdentity(o.manifest, 256), complete: o.manifest.complete };
    if (tier === "standard" || tier === "goal") writeSample("big-256-" + tier + ".txt", o.body);
  }
  const literal = packetFor(f, f.dg.digests, "standard", "dsh", undefined, INPUT, "literal");
  tiers.standardLiteralUserWords = literal.kind === "blocked" ? { outcome: "blocked", reason: literal.reason, mustHaveTokens: literal.mustHaveTokens, cap: literal.cap } : { outcome: literal.kind };
  out.tiers = tiers;
  // ---- S1：v1 §5.6 的样例场景，原型实际渲染 vs 文档样例全文 ----
  const s1 = s1Session();
  const red1 = createRedactor(syntheticSecrets(12), TEST_KEY);
  const f1: Fixture = { s: s1, dg: digestAll(s1, red1, V1_RULES), redactor: red1, policy: f.policy };
  const s1Input = "把失败的测试修好，别改测试的预期值。";
  const o1 = packetFor(f1, f1.dg.digests, "standard", "codex", undefined, s1Input);
  const doc1 = docSample("**S1：");
  if (o1.kind === "packet") {
    const turnText = typeof o1.turn === "string" ? o1.turn : o1.turn.relay.body + "\n" + o1.turn.user;
    writeSample("s1-packet.txt", turnText);
    out.s1 = { prototype: { bytes: utf8(turnText), estTokensOpenAI: estText(turnText, "openai"), estTokensAnthropic: estText(turnText, "anthropic"), bodyBytes: o1.manifest.body.bytes, bodyEstTokens: o1.manifest.body.estTokens, untrustedTokens: o1.manifest.body.untrustedTokens, complete: o1.manifest.complete, omissions: o1.manifest.omissions.map(x => x.category + ":" + x.count), identityErrors: checkIdentity(o1.manifest, 2), renderMs: time(() => { packetFor(f1, f1.dg.digests, "standard", "codex", undefined, s1Input); }, 200, 20) },
      docSample: doc1 === null ? null : { bytes: utf8(doc1), estTokensOpenAI: estText(doc1, "openai"), estTokensAnthropic: estText(doc1, "anthropic") },
      docClaims: { narratedHistoryTokens: 1650, untrustedTokens: 900, cardTokens: 1700, source: "v1 §5.6 与 §12.1（推算）" } };
  }
  // ---- A→B→A 增量 ----
  out.delta = deltaBench(f.policy);
  return out;
}

function deltaBench(policy: RelayPolicy): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  // S2：S1 的 Claude 两轮 → dsh 两轮 → 回 Claude。A 的绑定按原型补的规则在自己的回合后为 synced（见 delivery.ts）。
  const s2 = s2Session();
  const red = createRedactor(syntheticSecrets(12), TEST_KEY);
  const f2: Fixture = { s: s2, dg: digestAll(s2, red, V1_RULES), redactor: red, policy };
  const input = "再把 README 里的示例更新一下。";
  const A0 = onOwnRunRecorded(freshBinding("claude", "claude-acp"), s2.sources[0]!.run.userSeq - 1, true);
  const variants: Record<string, BindingRelayState> = {
    baseNull: A0,
    // 文档样例的假设：A 之前收到过交接单 relay-7q2m…（按 §7.2 它其实收不到，见 README F4）。
    baseFromDoc: { ...A0, sync: { kind: "synced", mark: { ...(A0.sync.kind === "synced" ? A0.sync.mark : { throughSeq: 0, chain: "" as never, evidence: "E3" as const, basis: "evidence" as const }), lastPacketId: "relay-7q2m4x9kf3b8wz1hda5c" as RelayPacketId } } },
  };
  const docDelta = docSample("**A→B→A 增量");
  const s2res: Record<string, unknown> = { docSample: docDelta === null ? null : { bytes: utf8(docDelta), estTokensAnthropic: estText(docDelta, "anthropic"), estTokensOpenAI: estText(docDelta, "openai") }, docClaimTokens: 520 };
  for (const [name, A] of Object.entries(variants)) {
    const o = packetFor(f2, f2.dg.digests, "standard", "claude", A, input);
    if (o.kind !== "packet") { s2res[name] = { outcome: o.kind }; continue; }
    if (name === "baseNull") writeSample("aba-delta-base-null.txt", o.body);
    if (name === "baseFromDoc") writeSample("aba-delta-with-base.txt", o.body);
    s2res[name] = { kind: o.manifest.kind, bytes: o.manifest.body.bytes, estTokens: o.manifest.body.estTokens, cap: o.stats.capTokens, untrustedTokens: o.manifest.body.untrustedTokens, identityErrors: checkIdentity(o.manifest, 2), renderMs: time(() => { packetFor(f2, f2.dg.digests, "standard", "claude", A, input); }, 200, 20) };
    // 送达后：下一条内容输入 need = ∅ → 原样发送（零注入）。
    const after = onSettled(onDispatchWithPacket(A, o.manifest), "recorded", "E3");
    const next = packetFor(f2, f2.dg.digests, "standard", "claude", after, "下一条");
    (s2res[name] as Record<string, unknown>).nextTurn = next.kind === "raw" ? { kind: "raw", identical: next.turn === "下一条" } : { kind: next.kind };
  }
  res.s2 = s2res;
  // 离开期间做了 N 轮：A=claude 两轮，B=dsh N 轮。
  const scale: Record<string, unknown> = {};
  for (const away of [2, 8, 32, 128]) {
    const s = buildSession({ runs: 2 + away, seed: 40 + away, harnesses: ["claude", "dsh"], switchEvery: 1, replyBytes: [400, 6000], inputBytes: [20, 400], thinkingBytes: 0, toolsPerRun: [2, 12], detail: "typical", failEvery: 7 });
    // switchEvery=1 会交替执行者；这里改写成 A 两轮、其后全是 B。
    const sources = s.sources.map((src, i) => { const h = i < 2 ? "claude" : "dsh"; return { ...src, run: { ...src.run, selection: { harnessId: h, controlId: h + "-acp" } }, executedOn: { harnessId: h, controlId: h + "-acp", nativeEpoch: 1 }, model: h === "claude" ? "claude-opus-5-5" : "deepseek-v4-flash" }; });
    const ss: SynthSession = { ...s, sources };
    const r = createRedactor(syntheticSecrets(12), TEST_KEY);
    const fx: Fixture = { s: ss, dg: digestAll(ss, r, V1_RULES), redactor: r, policy };
    const A = onOwnRunRecorded(freshBinding("claude", "claude-acp"), sources[0]!.run.userSeq - 1, true);
    const o = packetFor(fx, fx.dg.digests, "standard", "claude", A, input);
    scale["away" + away] = o.kind !== "packet" ? { outcome: o.kind, ...(o.kind === "blocked" ? { reason: o.reason, mustHaveTokens: o.mustHaveTokens, cap: o.cap } : {}) }
      : { bytes: o.manifest.body.bytes, estTokens: o.manifest.body.estTokens, cap: o.stats.capTokens, userWordsShown: o.stats.goalsMessages, userWordsOmitted: o.stats.goalsOmitted, identityErrors: checkIdentity(o.manifest, away), renderMs: time(() => { packetFor(fx, fx.dg.digests, "standard", "claude", A, input); }, 100, 10) };
  }
  res.awayScaling = scale;
  return res;
}
function writeSample(name: string, body: string): void {
  mkdirSync(join(ROOT, "samples"), { recursive: true });
  writeFileSync(join(ROOT, "samples", name), body.endsWith("\n") ? body : body + "\n");
}

if (import.meta.main) {
  if (process.argv.includes("--once")) {
    const f = bigFixture();
    const o = packetFor(f, f.dg.json.map(j => JSON.parse(j) as RunDigest), "standard");
    process.stdout.write(o.kind === "packet" ? sha256hex(o.body) : "blocked");
  } else console.log(JSON.stringify(await run(), null, 2));
}
