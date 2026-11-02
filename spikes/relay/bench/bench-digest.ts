// 原型，仅用于测量，不是实现。测量 1：每个 Run 的派生记录（RunDigest）抽取耗时与记录字节数。
// 输入是内存中的合成 Run（0–128 个工具，带计划、产物、附件、审批），与 run.ended 事务里能拿到的东西相同（runtime.ts:1139–1140）。
import { digestRun, LIMITS } from "../proto/digest.ts";
import { V1_RULES } from "../proto/escape.ts";
import { createRedactor } from "../proto/redaction.ts";
import { canonicalJson, utf8 } from "../proto/text.ts";
import { buildSession, cjkText, syntheticSecrets, TEST_KEY } from "./gen.ts";
import type { NativeToolDetailLite, PublicToolLite, RunSource } from "../proto/types.ts";
import type { GenParams } from "./gen.ts";
import { now, summary } from "./common.ts";

export interface DigestProfileResult { readonly profile: string; readonly tools: number; readonly runs: number; readonly ms: ReturnType<typeof summary>; readonly bytes: ReturnType<typeof summary>; readonly over64KiB: number; readonly sizeCappedReplies: number }

function profile(name: string, tools: number, runs: number, base: Partial<GenParams>, chunk: number): DigestProfileResult {
  const secrets = syntheticSecrets(12);
  const redactor = createRedactor(secrets, TEST_KEY);
  const times: number[] = [], bytes: number[] = [];
  let over = 0, capped = 0;
  const ctx = { redactor, rules: V1_RULES, policyVersion: "relay/1" as const, previous: null };
  // 预热：同一套代码路径先跑 30 条，不计入。
  const warm = buildSession({ runs: 30, seed: 999, harnesses: ["claude"], switchEvery: 1000, replyBytes: [500, 12000], inputBytes: [20, 1500], thinkingBytes: 2000, toolsPerRun: tools, detail: "typical", secrets, plantEvery: 7, failEvery: 6, planEvery: 2, approvalsEvery: 3, attachmentsEvery: 4 });
  for (const src of warm.sources) digestRun(src, ctx);
  for (let done = 0; done < runs; done += chunk) {
    const s = buildSession({ runs: Math.min(chunk, runs - done), seed: 1000 + done, harnesses: ["claude", "codex"], switchEvery: 3, replyBytes: [500, 12000], inputBytes: [20, 1500], thinkingBytes: 2000, toolsPerRun: tools, detail: "typical", secrets, plantEvery: 7, failEvery: 6, planEvery: 2, approvalsEvery: 3, attachmentsEvery: 4, ...base });
    for (const src of s.sources) {
      const t = now();
      const d = digestRun(src, ctx);
      times.push(now() - t);
      const b = utf8(canonicalJson(d));
      bytes.push(b); if (b > LIMITS.digestBytes) over++;
      if (!d.verbatimSized) capped++;
    }
  }
  return { profile: name, tools, runs: times.length, ms: summary(times, 4), bytes: summary(bytes, 0), over64KiB: over, sizeCappedReplies: capped };
}

/**
 * 病态字段：每个有上限的字段都填满中文（3 B/字）——64 个 256 字的路径、16 条 400 字的命令（全部失败、尾部 1,200 字）、
 * 20 条 200 字的计划、16 条审批与附件与产物的长名字。按 v1 §4 的逐字段上限，未收紧时约 180 KB，必须靠最后的 ≤64 KiB 收紧。
 */
function pathological(k: number): RunSource {
  const tools: PublicToolLite[] = [], details = new Map<string, NativeToolDetailLite>();
  for (let i = 0; i < 128; i++) {
    const id = "p" + k + "_" + i;
    if (i < 64) { const path = cjkText(256, i + k); tools.push({ id, title: "edit", status: "completed", kind: "edit" }); details.set(id, { kind: "edit", input: JSON.stringify({ file_path: path }), diff: "--- a/x\n+++ b/x\n+1", locations: [path] }); }
    else if (i < 80) { tools.push({ id, title: "run", status: "failed", kind: "execute", exitCode: 1 }); details.set(id, { kind: "execute", input: JSON.stringify({ command: cjkText(400, i) }), output: cjkText(3000, i), exitCode: 1 }); }
    else { const path = cjkText(256, i * 3 + k); tools.push({ id, title: cjkText(200, i), status: "completed", kind: "read" }); details.set(id, { kind: "read", input: JSON.stringify({ file_path: path }), output: "x", locations: [path] }); }
  }
  const long = (n: number, seed: number): string => cjkText(n, seed);
  return { run: { id: "run-patho-" + k, index: k, input: long(5000, 1), selection: { harnessId: "claude", controlId: "claude-acp" }, status: "failed", cancelRequested: false, error: { code: "REMOTE_ERROR", message: long(2000, 2) },
      tools, plan: { entries: Array.from({ length: 64 }, (_, j) => ({ content: long(4096, j), status: "pending" as const })) }, activities: [], outputs: Array.from({ length: 16 }, (_, j) => ({ name: long(300, j), mediaType: "text/plain", bytes: 1 })),
      attachments: Array.from({ length: 16 }, (_, j) => ({ name: long(300, j + 9), mediaType: "text/plain", bytes: 1 })), userSeq: 1, endSeq: 30 },
    userText: long(5000, 1), replyText: long(20000, 3), details, approvals: Array.from({ length: 16 }, (_, j) => ({ title: long(300, j + 20), outcome: "approved" as const, kind: "approval" as const })),
    executedOn: { harnessId: "claude", controlId: "claude-acp", nativeEpoch: 1 }, dispatched: true, sentSha256: "0", packetId: null, model: long(200, 5) };
}
function pathologicalProfile(): DigestProfileResult {
  const redactor = createRedactor(syntheticSecrets(12), TEST_KEY);
  const ctx = { redactor, rules: V1_RULES, policyVersion: "relay/1" as const, previous: null };
  for (let i = 0; i < 5; i++) digestRun(pathological(100 + i), ctx);
  const times: number[] = [], bytes: number[] = []; let over = 0;
  for (let k = 0; k < 30; k++) { const src = pathological(k); const t = now(); const d = digestRun(src, ctx); times.push(now() - t); const b = utf8(canonicalJson(d)); bytes.push(b); if (b > LIMITS.digestBytes) over++; }
  return { profile: "pathological-fields", tools: 128, runs: times.length, ms: summary(times, 4), bytes: summary(bytes, 0), over64KiB: over, sizeCappedReplies: 0 };
}

export function run(): { profiles: DigestProfileResult[]; notes: string[]; fieldCapBound: Record<string, number> } {
  const profiles: DigestProfileResult[] = [];
  for (const tools of [0, 1, 4, 16, 32, 64, 128]) profiles.push(profile("typical", tools, 300, {}, 50));
  // 最坏情况：128 个工具，每个输入 16 KiB、输出 64 KiB、差异 64 KiB（contracts/control.ts 的 TOOL_*_BYTES 上限），
  // 偏中文文本（3 B/字），回复 1 MiB（v1 §11.1 的抽取输入上限），计划 64 条 × 约 1,300 字。
  profiles.push(profile("max", 128, 100, { detail: "max", cjk: true, replyBytes: 1024 * 1024, inputBytes: 6000, planEvery: 1, approvalsEvery: 1, attachmentsEvery: 1 }, 2));
  // 中文为主的典型会话（字段上限按“字”计，字节会变大）。
  profiles.push(profile("typical-cjk", 64, 200, { cjk: true }, 50));
  profiles.push(pathologicalProfile());
  // v1 §4 逐字段上限之和（全中文、3 B/字，不含 JSON 结构开销）：推算值，说明最后一步收紧是必需的。
  const L = LIMITS, cjk = 3;
  const fieldCapBound = { narrated: L.narrated * L.narratedChars * cjk, commands: L.commands * (L.commandChars * cjk + L.successTailBytes), failures: L.failures * (L.titleChars + L.commandChars + L.failureTail) * cjk,
    files: L.files * L.pathChars * cjk, plan: L.planItems * L.planChars * cjk, approvals: L.approvals * L.titleChars * cjk, outputsAndAttachments: 2 * L.outputs * L.titleChars * cjk, replyTail: L.replyTail * cjk, userHead: L.userHead * cjk, error: L.errorChars * cjk, total: 0 };
  fieldCapBound.total = Object.entries(fieldCapBound).reduce((a, [k, v]) => k === "total" ? a : a + v, 0);
  return { fieldCapBound, profiles, notes: ["耗时是单线程墙钟（process.hrtime），每条摘要单独计时；包含规范化、窗口脱敏（12 个已知秘密 + 形状规则）、截断、两种语言 × 三个等级的尺寸计算与 ≤64 KiB 收紧。", "字节数是规范化 JSON（键排序）的 UTF-8 长度，即 relay_digests.digest_json 的大小。"] };
}

if (import.meta.main) console.log(JSON.stringify(run(), null, 2));
