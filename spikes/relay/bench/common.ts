// 原型，仅用于测量，不是实现。基准共用：摘要批量抽取、正文访问、目标规格、分位数与机器信息。
import { execFileSync } from "node:child_process";
import os from "node:os";
import { digestRun } from "../proto/digest.ts";
import type { EscapeRules } from "../proto/escape.ts";
import type { BindingWindow, TargetSpec } from "../proto/budget.ts";
import type { RunTexts } from "../proto/packet.ts";
import type { Redactor } from "../proto/redaction.ts";
import { canonicalJson, sha256hex } from "../proto/text.ts";
import type { Cumulative, RunDigest } from "../proto/types.ts";
import type { SynthSession } from "./gen.ts";

export interface Digested { readonly digests: RunDigest[]; readonly json: string[]; readonly sha: string[] }
/** 按 run.ended 的顺序逐条抽取（前缀和接上一条），并算出 relay_digests 行的 JSON 与 sha256。 */
export function digestAll(s: SynthSession, redactor: Redactor, rules: EscapeRules): Digested {
  const digests: RunDigest[] = [], json: string[] = [], sha: string[] = [];
  let prev: Cumulative | null = null;
  for (const src of s.sources) {
    const d = digestRun(src, { redactor, rules, policyVersion: "relay/1", previous: prev });
    prev = d.cumulative; digests.push(d);
    const j = canonicalJson(d); json.push(j); sha.push(sha256hex(j));
  }
  return { digests, json, sha };
}
export function textsOf(s: SynthSession): RunTexts {
  return { user: i => s.userTexts[i]!, reply: i => s.replyTexts[i] ?? null };
}
/** 合成的目标规格（窗口与输入上限：Codex 1,048,576 字符为 v1 §8.1 的文档常量；其余窗口是本原型的假设）。 */
export const TARGETS: Readonly<Record<string, { readonly spec: TargetSpec; readonly window: BindingWindow; readonly vendor: string }>> = {
  codex: { spec: { harnessId: "codex", controlId: "codex-app", model: "gpt-6.1-sol", family: "openai", documentedWindow: null, placement: { parts: "single", maxInput: { unit: "chars", limit: 1048576 } } }, window: { contextSize: 400000, contextUsed: null, observedWindow: null }, vendor: "openai" },
  claude: { spec: { harnessId: "claude", controlId: "claude-acp", model: "claude-opus-5-5", family: "anthropic", documentedWindow: null, placement: { parts: "multiple", maxInput: null } }, window: { contextSize: 200000, contextUsed: 60000, observedWindow: null }, vendor: "anthropic" },
  dsh: { spec: { harnessId: "dsh", controlId: "dsh-acp", model: "deepseek-v4-flash", family: "deepseek", documentedWindow: 1000000, placement: { parts: "multiple", maxInput: null } }, window: { contextSize: null, contextUsed: null, observedWindow: null }, vendor: "deepseek" },
  opencode: { spec: { harnessId: "opencode", controlId: "opencode-acp", model: null, family: "unknown", documentedWindow: null, placement: { parts: "multiple", maxInput: null } }, window: { contextSize: null, contextUsed: null, observedWindow: null }, vendor: "unknown:opencode" },
};

export function pct(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))]!;
}
export function summary(xs: readonly number[], digits = 3): { n: number; p50: number; p95: number; max: number; mean: number } {
  if (xs.length === 0) throw new Error("summary of an empty sample");
  const r = (v: number): number => Number(v.toFixed(digits));
  return { n: xs.length, p50: r(pct(xs, 0.5)), p95: r(pct(xs, 0.95)), max: r(Math.max(...xs)), mean: r(xs.reduce((a, b) => a + b, 0) / xs.length) };
}
export const now = (): number => Number(process.hrtime.bigint()) / 1e6;

export function machineInfo(): Record<string, unknown> {
  const sh = (cmd: string, args: string[]): string | null => { try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 }).trim(); } catch { return null; } };
  return {
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, osRelease: os.release(),
    macos: sh("sw_vers", ["-productVersion"]), cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]), logicalCpus: os.cpus().length,
    perfCores: sh("sysctl", ["-n", "hw.perflevel0.physicalcpu"]), effCores: sh("sysctl", ["-n", "hw.perflevel1.physicalcpu"]),
    memoryGiB: Math.round(os.totalmem() / 2 ** 30), git: sh("git", ["--version"]), sqlite: null as string | null,
  };
}
