// 原型，仅用于测量，不是实现。合成会话生成器：text() 复制自第一轮 R6 的 bench/gen.mjs（会话 scratchpad，2026-11-02），
// 其余（工具详情、计划、审批、失败、工作区观测、已知秘密、S1 与 A→B→A 场景）为本原型新增。全部是合成数据，不含任何用户数据。
import { createHash } from "node:crypto";
import { mulberry32, sha256hex } from "../proto/text.ts";
import type { KnownSecret } from "../proto/redaction.ts";
import type { ApprovalLite, NativeToolDetailLite, ObservedFile, PlanEntry, PublicRunLite, PublicToolLite, RunSource, RunStatus, WorkspaceObservation } from "../proto/types.ts";

const ZH = "我们需要先确认工作区里的改动，然后运行测试并修复失败的用例。接力系统要保留决定、待办和文件差异，不能丢失任何事实。";
const EN = "The handoff packet keeps goals, decisions, file changes and open todos; it must stay deterministic so prompt caches stay warm. ";
const CODE = "```ts\nexport function add(a: number, b: number): number {\n  return a + b; // \"quoted\" \\ backslash\n}\n```\n";
/** R6 gen.mjs 的 text()：中英文与代码混排，含多字节字符与 JSON 转义。输出与 R6 相同；实现改为先按段拼够再一次截断（R6 的写法在 MiB 级是平方复杂度）。 */
export function text(bytes: number, seed = 0): string {
  const parts = [ZH, EN, CODE];
  const chunks: string[] = []; let total = 0, i = seed;
  while (total < bytes) { const part = parts[i % 3]!; chunks.push(part); total += Buffer.byteLength(part); i++; }
  let out = chunks.join("");
  if (total > bytes) { const buf = Buffer.from(out); let end = bytes; while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; out = buf.subarray(0, end).toString("utf8"); }
  return out;
}
/** 偏中文的变体（最坏情况：每字 3 字节）。 */
export function cjkText(chars: number, seed = 0): string {
  const s = ZH + "，" + ZH.split("").reverse().join("");
  const start = seed % s.length, rot = s.slice(start) + s.slice(0, start);
  return rot.repeat(Math.ceil(chars / rot.length)).slice(0, chars);
}
export const TEST_KEY = createHash("sha256").update("relay-spike-test-key (synthetic, not an installation key)").digest();

/** 12 个合成的“已知秘密”（形状仿常见环境变量；值由确定性伪随机生成，不是任何真实凭据）。 */
export function syntheticSecrets(count = 12, seed = 7): KnownSecret[] {
  const r = mulberry32(seed);
  const pick = (alphabet: string, n: number): string => { let s = ""; for (let i = 0; i < n; i++) s += alphabet[Math.floor(r() * alphabet.length)]; return s; };
  const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", ALNUM = B64U.slice(0, 62), HEX = "0123456789abcdef";
  const makers: ((i: number) => KnownSecret)[] = [
    i => ({ name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-" + pick(B64U, 93) + "AA", label: "Anthropic 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "OPENAI_API_KEY", value: "sk-proj-" + pick(B64U, 48), label: "OpenAI 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "GITHUB_TOKEN", value: "ghp_" + pick(ALNUM, 36), label: "GitHub 令牌" + (i > 11 ? i : "") }),
    i => ({ name: "AWS_SECRET_ACCESS_KEY", value: pick(B64, 40), label: "AWS 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-" + pick(B64U, 80), label: "Claude 令牌" + (i > 11 ? i : "") }),
    i => ({ name: "DEEPSEEK_API_KEY", value: "sk-" + pick(HEX, 32), label: "DeepSeek 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "DB_PASSWORD", value: "p@ss\"w0rd\\/&?=%+ é" + pick(ALNUM, 6), label: "密码" + (i > 11 ? i : "") }),
    i => ({ name: "SERVICE_PRIVATE_KEY", value: "-----BEGIN PRIVATE KEY-----\n" + pick(B64, 64) + "\n" + pick(B64, 64) + "\n-----END PRIVATE KEY-----", label: "私钥" + (i > 11 ? i : "") }),
    i => ({ name: "SLACK_BOT_TOKEN", value: "xoxb-" + pick("0123456789", 12) + "-" + pick(ALNUM, 24), label: "Slack 令牌" + (i > 11 ? i : "") }),
    i => ({ name: "GOOGLE_API_KEY", value: "AIza" + pick(B64U, 35), label: "Google 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "OPENROUTER_API_KEY", value: "sk-or-v1-" + pick(HEX, 64), label: "OpenRouter 密钥" + (i > 11 ? i : "") }),
    i => ({ name: "APP_SESSION_SECRET", value: pick(ALNUM, 24) + "~" + pick(ALNUM, 8), label: "会话密钥" + (i > 11 ? i : "") }),
  ];
  return Array.from({ length: count }, (_, i) => makers[i % makers.length]!(i));
}

export interface GenParams {
  readonly runs: number; readonly seed: number;
  readonly harnesses: readonly string[]; readonly switchEvery: number;
  readonly models?: Readonly<Record<string, string>>;
  readonly replyBytes: number | readonly [number, number]; readonly inputBytes: number | readonly [number, number]; readonly thinkingBytes: number;
  readonly toolsPerRun: number | readonly [number, number];
  readonly detail: "typical" | "max";
  readonly secrets?: readonly KnownSecret[]; readonly plantEvery?: number;
  readonly failEvery?: number; readonly planEvery?: number; readonly approvalsEvery?: number; readonly attachmentsEvery?: number;
  readonly cjk?: boolean; readonly seqPerRun?: number;
}
export interface SynthSession {
  readonly sources: RunSource[]; readonly snapshotBytes: number; readonly firstUserText: string; readonly observation: WorkspaceObservation;
  readonly userTexts: string[]; readonly replyTexts: (string | null)[]; readonly lastSeq: number;
}
const MODELS: Readonly<Record<string, string>> = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol", dsh: "deepseek-v4-flash", opencode: "glm-5", hermes: "deepseek-v4-pro", openclaw: "gpt-5.5" };

export function buildSession(p: GenParams): SynthSession {
  const r = mulberry32(p.seed);
  const range = (v: number | readonly [number, number]): number => typeof v === "number" ? v : Math.round(Math.exp(Math.log(v[0]) + r() * (Math.log(v[1]) - Math.log(v[0]))));
  const body = (bytes: number, seed: number): string => p.cjk ? cjkText(Math.ceil(bytes / 3), seed) : text(bytes, seed);
  const sources: RunSource[] = [], userTexts: string[] = [], replyTexts: (string | null)[] = [];
  const publicRuns: unknown[] = [], messages: unknown[] = [];
  let seq = 1;
  const seqPerRun = p.seqPerRun ?? 30;
  const edited: string[] = [];
  for (let i = 0; i < p.runs; i++) {
    const harness = p.harnesses[Math.floor(i / p.switchEvery) % p.harnesses.length]!;
    const model = (p.models ?? MODELS)[harness] ?? null;
    const input = (i === 0 ? "请给发票导出加上按币种汇总，并补测试。" : "") + body(range(p.inputBytes), i);
    const reply = body(range(p.replyBytes), i + 2);
    const n = range(p.toolsPerRun);
    const tools: PublicToolLite[] = [], details = new Map<string, NativeToolDetailLite>();
    const kinds = ["read", "read", "search", "edit", "execute", "read", "edit", "execute", "fetch", "think", "subagent", "edit"];
    let failedHere = false;
    for (let k = 0; k < n; k++) {
      const id = "call_" + i + "_" + k, kind = kinds[Math.floor(r() * kinds.length)]!;
      const path = "src/mod" + (i % 17) + "/file" + ((i * 7 + k) % 23) + ".ts";
      const max = p.detail === "max";
      let d: NativeToolDetailLite, title = "", status = "completed", exitCode: number | undefined;
      const outBytes = (lo: number, hi: number): number => max ? 64 * 1024 : range([lo, hi]);
      if (kind === "read") { title = "Read " + path; d = { kind, name: "Read", input: JSON.stringify({ file_path: path }) + (max ? " ".repeat(16000) : ""), output: body(outBytes(1024, 16384), k), locations: [path] }; }
      else if (kind === "search") { title = "Grep writeCsv"; d = { kind, name: "Grep", input: JSON.stringify({ pattern: "writeCsv" + k }), output: Array.from({ length: max ? 900 : 1 + Math.floor(r() * 40) }, (_, j) => "src/mod" + j + "/a.ts:" + (j + 3) + ": writeCsv(rows)").join("\n") }; }
      else if (kind === "edit") {
        title = "Edit " + path; edited.push(path);
        const added = 1 + Math.floor(r() * (max ? 900 : 40)), removed = Math.floor(r() * (max ? 600 : 12));
        const lines = ["--- a/" + path, "+++ b/" + path, "@@ -1," + removed + " +1," + added + " @@"];
        for (let j = 0; j < removed; j++) lines.push("-  const old" + j + " = compute(" + j + ");");
        for (let j = 0; j < added; j++) lines.push("+  const next" + j + " = compute(" + j + ", currency);");
        let diff = lines.join("\n");
        if (max) diff = (diff + "\n" + "+".repeat(80) + "\n").repeat(Math.ceil(65536 / diff.length)).slice(0, 65536);
        d = { kind, name: "Edit", input: JSON.stringify({ file_path: path, old_string: body(max ? 7000 : 120, k), new_string: body(max ? 8000 : 160, k + 1) }), diff, locations: [path] };
      } else if (kind === "execute") {
        const fail = p.failEvery !== undefined && (i * 13 + k) % p.failEvery === 0;
        failedHere ||= fail;
        exitCode = fail ? 1 : 0; status = fail ? "failed" : "completed";
        title = "Run `npm test -- --grep case" + k + "`";
        const secretLine = p.secrets && p.plantEvery && (i + k) % p.plantEvery === 0 ? "\nexport TOKEN=" + p.secrets[(i + k) % p.secrets.length]!.value + "\n" : "";
        const linesN = max ? 1400 : 20 + Math.floor(r() * 120);
        const out = Array.from({ length: linesN }, (_, j) => j % 9 === 0 ? " ✓ tests/export.test.ts > case " + j + " (" + (j % 7) + " ms)" : "   at compute (src/mod" + (j % 5) + "/x.ts:" + j + ":" + (j % 30) + ")").join("\n") + secretLine
          + (fail ? "\n FAIL  tests/export.test.ts > currency summary > rounds JPY totals\nAssertionError: expected '1234' to be '1235'\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 17 passed (18)" : "\n Test Files  4 passed (4)\n      Tests  17 passed (17)");
        d = { kind, name: "Bash", input: JSON.stringify({ command: "npm test -- --grep case" + k }), output: max ? out.slice(0, 65536) : out, exitCode };
      } else if (kind === "fetch") { title = "Fetch docs"; d = { kind, name: "WebFetch", input: JSON.stringify({ url: "https://example.invalid/docs/" + k }), output: body(outBytes(2048, 32768), k) }; }
      else if (kind === "think") { title = "Think"; d = { kind, name: "think" }; }
      else { title = "Task: review currency rounding " + k; d = { kind: "subagent", name: "Task", input: JSON.stringify({ description: "review " + k }) }; }
      tools.push({ id, title, status, kind: d.kind!, ...(d.name === undefined ? {} : { name: d.name }), ...(exitCode === undefined ? {} : { exitCode }) });
      details.set(id, d);
    }
    const status: RunStatus = failedHere && (i % 5 === 0) ? "failed" : (i % 97 === 50 ? "unknown" : "completed");
    const plan: PlanEntry[] | undefined = p.planEvery && i % p.planEvery === 0
      ? Array.from({ length: p.detail === "max" ? 64 : 3 + (i % 6) }, (_, j) => ({ content: (p.detail === "max" ? cjkText(1300, j) : "补充币种汇总的第 " + (j + 1) + " 项测试"), status: (j < 2 ? "completed" : j === 2 ? "in_progress" : "pending") as PlanEntry["status"] }))
      : undefined;
    const approvals: ApprovalLite[] = p.approvalsEvery && i % p.approvalsEvery === 0 ? [{ title: "运行 `pnpm db:migrate`", outcome: i % 2 === 0 ? "approved" : "denied", kind: "approval" }] : [];
    const attachments = p.attachmentsEvery && i % p.attachmentsEvery === 0 ? [{ name: "invoice-" + i + ".csv", mediaType: "text/csv", bytes: 12000 + i }] : undefined;
    const userSeq = seq, endSeq = seq + seqPerRun - 1; seq += seqPerRun;
    const run: PublicRunLite = {
      id: "run-" + sha256hex("run" + p.seed + ":" + i).slice(0, 32), index: i, input, selection: { harnessId: harness, controlId: harness + "-acp", ...(model === null ? {} : { nativeModel: model }) },
      status, cancelRequested: false, error: status === "failed" ? { code: "REMOTE_ERROR", message: "Harness reported: npm test exited with code 1 after 3 retries" } : status === "unknown" ? { code: "OWNER_ENDED", message: "the conversation owner ended before the result was known" } : null,
      ...(p.thinkingBytes > 0 ? { thinking: body(p.thinkingBytes, i + 1) } : {}), tools, ...(plan === undefined ? {} : { plan: { entries: plan } }),
      activities: i % 31 === 7 ? [{ id: "a" + i, kind: "compaction", title: "compacted", status: "completed" }] : [],
      outputs: i % 41 === 3 ? [{ name: "summary-" + i + ".md", mediaType: "text/markdown", bytes: 2048 }] : [],
      ...(attachments === undefined ? {} : { attachments }), userSeq, endSeq,
    };
    userTexts.push(input); replyTexts.push(reply);
    sources.push({ run, userText: input, replyText: reply, details, approvals, executedOn: { harnessId: harness, controlId: harness + "-acp", nativeEpoch: 1 }, dispatched: true, sentSha256: sha256hex(input), packetId: null, model });
    // 公共快照里的 Run 与消息（形状同 R6 gen.mjs：工具只带摘要与 ContentRef），用于计算“会话约 8 MiB”。
    publicRuns.push({ ...run, commandId: "send-" + i, userMessageId: "message-u" + i, assistantMessageId: "message-a" + i, epoch: 1, contextThroughSeq: userSeq - 1, sourceRunIds: [],
      backend: { status: "completed", reason: "end_turn" }, cleanup: { closed: true, exitCode: 0, signal: null, protocolFailure: null }, stopRequested: false, awaitingSwitchId: null,
      tools: tools.map(t => ({ ...t, detail: { id: "content-" + sha256hex(t.id).slice(0, 32), name: "tool-" + t.id + ".json", mediaType: "application/json", kind: "file", bytes: 4096, sha256: sha256hex(t.id) } })),
      usage: { turn: { input: 52000 + i * 900, output: 1800, cachedInput: 48000 + i * 850, cacheWrite: 3000, total: 53800 + i * 900 }, context: { used: 52000 + i * 900, size: 400000 } } });
    messages.push({ id: "message-u" + i, runId: run.id, role: "user", text: input, seq: userSeq, status: "completed" });
    messages.push({ id: "message-a" + i, runId: run.id, role: "assistant", text: reply, seq: userSeq + 1, status: "completed" });
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 12, runs: publicRuns, messages }));
  const uniq = [...new Set(edited.slice(-40))];
  const files: ObservedFile[] = [...uniq.map((path, j) => ({ path, change: (j % 5 === 0 ? "added" : "modified") as ObservedFile["change"], added: 3 + j, removed: j % 4, credentialPath: false })),
    { path: "notes/scratch.md", change: "untracked", added: null, removed: null, credentialPath: false }, { path: ".env.local", change: "modified", added: 1, removed: 1, credentialPath: true }];
  const observation: WorkspaceObservation = { kind: "git", status: "complete", branch: "feature/currency-summary", head: "3f9e2c1a7b5d4e6f8091a2b3c4d5e6f708192a3b", fingerprint: sha256hex(JSON.stringify(files)), durationMs: 18, files };
  return { sources, snapshotBytes, firstUserText: userTexts[0] ?? "", observation, userTexts, replyTexts, lastSeq: seq };
}

/** 调整回复大小，使公共快照接近 targetBytes（同 R6 的 sessionOfSize）。 */
export function sessionOfSize(target: number, base: GenParams): SynthSession {
  let scale = 1, s = buildSession(base);
  for (let i = 0; i < 8; i++) {
    if (Math.abs(s.snapshotBytes - target) / target < 0.02) return s;
    scale *= target / s.snapshotBytes;
    const rb = typeof base.replyBytes === "number" ? Math.round(base.replyBytes * scale) : [Math.round(base.replyBytes[0] * scale), Math.round(base.replyBytes[1] * scale)] as const;
    s = buildSession({ ...base, replyBytes: rb });
  }
  return s;
}

// ---------- S1：v1 §5.6 的样例场景（Claude Code 做 2 轮、改 5 个文件、1 处测试失败，切到 Codex） ----------
export function s1Session(): SynthSession {
  const sel = { harnessId: "claude", controlId: "claude-acp", nativeModel: "claude-opus-5-5" };
  const exec = (out: string, code: number): NativeToolDetailLite => ({ kind: "execute", name: "Bash", input: JSON.stringify({ command: "npm test" }), output: out, exitCode: code });
  const edit = (path: string, added: number, removed: number, create: boolean): NativeToolDetailLite => {
    const lines = [create ? "--- /dev/null" : "--- a/" + path, "+++ b/" + path, "@@ -1 +1 @@"];
    for (let j = 0; j < removed; j++) lines.push("-old line " + j);
    for (let j = 0; j < added; j++) lines.push("+new line " + j);
    return { kind: "edit", name: "Edit", input: JSON.stringify({ file_path: path }), diff: lines.join("\n"), locations: [path] };
  };
  const read = (path: string): NativeToolDetailLite => ({ kind: "read", name: "Read", input: JSON.stringify({ file_path: path }), output: "// " + path + "\n" + text(1800, path.length), locations: [path] });
  const t1: [string, NativeToolDetailLite][] = [
    ["Read src/export/csv.ts", read("src/export/csv.ts")], ["Read src/types.ts", read("src/types.ts")], ["Read tests/export.test.ts", read("tests/export.test.ts")], ["Read README.md", read("README.md")],
    ["Grep writeCsv", { kind: "search", name: "Grep", input: JSON.stringify({ pattern: "writeCsv" }), output: "src/export/csv.ts:12\nsrc/export/csv.ts:40\ntests/export.test.ts:8" }],
    ["Write src/export/summary.ts", edit("src/export/summary.ts", 58, 0, true)], ["Edit src/export/csv.ts", edit("src/export/csv.ts", 14, 2, false)], ["Edit src/types.ts", edit("src/types.ts", 6, 0, false)],
    ["Write tests/export.test.ts", edit("tests/export.test.ts", 64, 0, true)], ["Edit README.md", edit("README.md", 9, 0, false)],
    ["Run npm test", exec(" RUN  v3.2.4 /workspace\n ✓ tests/export.test.ts (6 tests) 12ms\n Test Files  4 passed (4)\n      Tests  17 passed (17)", 0)],
  ];
  const t2: [string, NativeToolDetailLite][] = [
    ["Edit src/export/summary.ts", edit("src/export/summary.ts", 4, 1, false)], ["Edit tests/export.test.ts", edit("tests/export.test.ts", 7, 0, false)],
    ["Run npm test", exec(" RUN  v3.2.4 /workspace\n FAIL  tests/export.test.ts > currency summary > rounds JPY totals without decimals\nAssertionError: expected '1234' to be '1235'\n ❯ tests/export.test.ts:48:31\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 17 passed (18)", 1)],
  ];
  const users = ["给发票导出加上按币种汇总，CSV 末尾输出每个币种的合计，并补上测试。", "日元不要有小数，四舍五入到整数。"];
  const replies = [
    "按币种汇总已经加上：新增 src/export/summary.ts 负责按 currency 累加，csv.ts 在末尾输出每个币种的合计行，types.ts 增加 CurrencyTotal，tests/export.test.ts 覆盖了两种币种混合的情况，README 补了说明。npm test 全部通过。",
    "JPY 已经设为 0 位小数，但 `rounds JPY totals without decimals` 仍然失败：合计先用浮点数累加、最后才 toFixed(0)，1234.5 累加后变成 1234.4999…，四舍五入得到 1234。可以改成按最小货币单位的整数累加再格式化。我先停在这里，没有改测试。",
  ];
  const sources: RunSource[] = [];
  [t1, t2].forEach((ts, i) => {
    const details = new Map<string, NativeToolDetailLite>(), tools: PublicToolLite[] = [];
    ts.forEach(([title, d], k) => { const id = "toolu_s1_" + i + "_" + k; details.set(id, d); tools.push({ id, title, status: d.exitCode === 1 ? "failed" : "completed", kind: d.kind!, ...(d.exitCode === undefined ? {} : { exitCode: d.exitCode }) }); });
    const run: PublicRunLite = { id: "run-s1-" + i, index: i, input: users[i]!, selection: sel, status: "completed", cancelRequested: false, error: null, thinking: "（合成的思考过程）", tools, userSeq: 1 + i * 40, endSeq: 40 + i * 40 };
    sources.push({ run, userText: users[i]!, replyText: replies[i]!, details, approvals: [], executedOn: { harnessId: "claude", controlId: "claude-acp", nativeEpoch: 1 }, dispatched: true, sentSha256: sha256hex(users[i]!), packetId: null, model: "claude-opus-5-5" });
  });
  const files: ObservedFile[] = [
    { path: "src/export/summary.ts", change: "added", added: 62, removed: null, credentialPath: false }, { path: "src/export/csv.ts", change: "modified", added: 14, removed: 2, credentialPath: false },
    { path: "src/types.ts", change: "modified", added: 6, removed: null, credentialPath: false }, { path: "tests/export.test.ts", change: "added", added: 71, removed: null, credentialPath: false },
    { path: "README.md", change: "modified", added: 9, removed: null, credentialPath: false },
  ];
  const observation: WorkspaceObservation = { kind: "git", status: "complete", branch: "feature/currency-summary", head: "3f9e2c1", fingerprint: sha256hex(JSON.stringify(files)), durationMs: 17, files };
  return { sources, snapshotBytes: 0, firstUserText: users[0]!, observation, userTexts: users, replyTexts: replies, lastSeq: 80 };
}

// ---------- S2：v1 §5.6 的 A→B→A 场景（S1 的两轮 Claude Code 之后，dsh 做第 3、4 轮，再切回 Claude Code） ----------
export function s2Session(): SynthSession {
  const s1 = s1Session();
  const sel = { harnessId: "dsh", controlId: "dsh-acp", nativeModel: "deepseek-v4-flash" };
  const users = ["把失败的测试修好，别改测试的预期值。", "再跑一遍全部测试。"];
  const replies = [
    "我把 summary.ts 的累加改成按最小货币单位（JPY 为 1，其余为 100）的整数累加，最后再格式化输出；测试文件没有改动。".repeat(5),
    "全部 18 个测试通过。summary.ts 现在按最小货币单位的整数累加，JPY 的合计不再出现 0.5 的舍入误差。",
  ];
  const edit = (path: string, added: number, removed: number): NativeToolDetailLite => {
    const lines = ["--- a/" + path, "+++ b/" + path, "@@ -1 +1 @@"];
    for (let j = 0; j < removed; j++) lines.push("-old " + j);
    for (let j = 0; j < added; j++) lines.push("+new " + j);
    return { kind: "edit", name: "edit_file", input: JSON.stringify({ path }), diff: lines.join("\n"), locations: [path] };
  };
  const exec = (out: string): NativeToolDetailLite => ({ kind: "execute", name: "shell", input: JSON.stringify({ command: "npm test" }), output: out, exitCode: 0 });
  const tools3: [string, NativeToolDetailLite][] = [["read summary.ts", { kind: "read", name: "read_file", input: JSON.stringify({ path: "src/export/summary.ts" }), output: text(2000, 3), locations: ["src/export/summary.ts"] }],
    ["read test", { kind: "read", name: "read_file", input: JSON.stringify({ path: "tests/export.test.ts" }), output: text(2000, 4), locations: ["tests/export.test.ts"] }],
    ["edit summary.ts", edit("src/export/summary.ts", 9, 4)], ["npm test", exec(" Test Files  4 passed (4)\n      Tests  18 passed (18)")]];
  const tools4: [string, NativeToolDetailLite][] = [["read csv.ts", { kind: "read", name: "read_file", input: JSON.stringify({ path: "src/export/csv.ts" }), output: text(1500, 5), locations: ["src/export/csv.ts"] }], ["npm test", exec(" ✓ tests/export.test.ts (7 tests) 11ms\n Test Files  4 passed (4)\n      Tests  18 passed (18)")]];
  const sources = [...s1.sources];
  [tools3, tools4].forEach((ts, k) => {
    const i = 2 + k, details = new Map<string, NativeToolDetailLite>(), tools: PublicToolLite[] = [];
    ts.forEach(([title, d], j) => { const id = "call_s2_" + i + "_" + j; details.set(id, d); tools.push({ id, title, status: "completed", kind: d.kind!, ...(d.exitCode === undefined ? {} : { exitCode: d.exitCode }) }); });
    const run: PublicRunLite = { id: "run-s2-" + i, index: i, input: users[k]!, selection: sel, status: "completed", cancelRequested: false, error: null, tools, userSeq: 1 + i * 40, endSeq: 40 + i * 40 };
    sources.push({ run, userText: users[k]!, replyText: replies[k]!, details, approvals: [], executedOn: { harnessId: "dsh", controlId: "dsh-acp", nativeEpoch: 1 }, dispatched: true, sentSha256: sha256hex(users[k]!), packetId: null, model: "deepseek-v4-flash" });
  });
  const files: ObservedFile[] = s1.observation.kind === "git" ? s1.observation.files.map(f => f.path === "src/export/summary.ts" ? { ...f, added: 67, removed: 4 } : f) : [];
  const observation: WorkspaceObservation = { kind: "git", status: "complete", branch: "feature/currency-summary", head: "3f9e2c1", fingerprint: sha256hex(JSON.stringify(files)), durationMs: 16, files };
  return { sources, snapshotBytes: 0, firstUserText: s1.firstUserText, observation, userTexts: [...s1.userTexts, ...users], replyTexts: [...s1.replyTexts, ...replies], lastSeq: 160 };
}
