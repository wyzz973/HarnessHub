// Public snapshots for the relay packet's tests (ADR-055 §5.6): the S1 handoff (Claude Code did two turns, five files, one
// failing test; the user switches to Codex) and its A→B→A delta, in Chinese and English, and a long conversation of up to
// 256 Turns near the 8 MiB Session limit. Synthetic data only.
import type { RelayToolDetail } from "../../src/contexts/session/domain/relay/narration.js";
import { commandId, messageId, runId, sessionId, type NativeSessionBinding, type PublicRun, type PublicTool, type RunStatus, type SessionSnapshot } from "../../src/contracts/session.js";

export const NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex", dsh: "DeepSeek Harness", opencode: "OpenCode" };
export const names = (harnessId: string): string | null => NAMES[harnessId] ?? null;

export interface RunSpec {
  readonly input: string;
  readonly harnessId: string;
  readonly model?: string;
  readonly status?: RunStatus;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly reply?: string;
  readonly tools?: readonly PublicTool[];
  readonly thinking?: boolean;
  readonly plan?: PublicRun["plan"];
  readonly attachments?: PublicRun["attachments"];
  readonly usage?: PublicRun["usage"];
}
export interface Scenario {
  readonly state: SessionSnapshot;
  readonly current: PublicRun;
  readonly sources: readonly PublicRun[];
  readonly details: ReadonlyMap<string, RelayToolDetail>;
}
/** A snapshot whose last spec is the current (preparing) Run and the others are finished, dispatched Runs before it. */
export function conversation(specs: readonly RunSpec[], bindings: readonly NativeSessionBinding[] = [], details: Readonly<Record<string, RelayToolDetail>> = {}): Scenario {
  const runs = specs.map((spec, index): PublicRun => {
    const last = index === specs.length - 1, status = last ? "preparing" : spec.status ?? "completed";
    return { id: runId("run-" + (index + 1)), commandId: commandId("send-" + (index + 1)), input: spec.input, userMessageId: messageId("message-user-" + (index + 1)),
      assistantMessageId: messageId("message-reply-" + (index + 1)), selection: { harnessId: spec.harnessId, controlId: spec.harnessId + "-acp", ...(spec.model === undefined ? {} : { nativeModel: spec.model }) },
      epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [], backend: last ? null : { status: status === "failed" ? "failed" : "completed", reason: "fixture" },
      cleanup: null, error: spec.error ?? null, stopRequested: false, awaitingSwitchId: null, ...(spec.tools === undefined ? {} : { tools: spec.tools }), ...(spec.thinking ? { thinking: "private reasoning" } : {}),
      ...(spec.plan === undefined ? {} : { plan: spec.plan }), ...(spec.attachments === undefined ? {} : { attachments: spec.attachments }), ...(spec.usage === undefined ? {} : { usage: spec.usage }),
      timing: last ? { acceptedAt: 1000 } : { acceptedAt: index * 10, dispatchedAt: index * 10 + 1, endedAt: index * 10 + 2 } };
  });
  const current = runs.at(-1)!;
  const state: SessionSnapshot = { schemaVersion: 12, id: sessionId("session-relay"), version: 7, lastSeq: specs.length * 10, epoch: 1, status: "open",
    configuration: { workspace: "/tmp/relay-fixture", manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    selection: current.selection, activeRunId: current.id, pendingSwitchId: null, runs,
    messages: runs.flatMap((run, index) => [{ id: run.userMessageId, runId: run.id, role: "user" as const, text: run.input, seq: index * 10 + 1, status: run.status },
      ...(specs[index]!.reply === undefined ? [] : [{ id: run.assistantMessageId, runId: run.id, role: "assistant" as const, text: specs[index]!.reply!, seq: index * 10 + 5, status: run.status }])]),
    switches: [], commands: [], ...(bindings.length ? { nativeBindings: bindings } : {}) };
  return { state, current, sources: runs.slice(0, -1), details: new Map(Object.entries(details)) };
}
export function tool(id: string, title: string, kind: string, extra: Partial<PublicTool> = {}): PublicTool { return { id, title, status: "completed", kind, ...extra }; }
const lines = (count: number, mark: string) => mark.repeat(count);
function diff(path: string, created: boolean, added: number, removed: number): string {
  return (created ? "--- /dev/null\n" : "--- a/" + path + "\n") + "+++ b/" + path + "\n@@ -1 +1 @@\n" + lines(added, "+line\n") + lines(removed, "-line\n");
}

/** The S1 facts with words in `language`: the same tools, files, failure and replies (ADR-055 §5.6 S1 and its A→B→A delta). */
function s1Words(language: "zh" | "en") {
  return language === "zh" ? {
    first: "给发票导出加上按币种汇总，CSV 末尾输出每个币种的合计，并补上测试。", second: "日元不要有小数，四舍五入到整数。", current: "把失败的测试修好，别改测试的预期值。",
    reply1: "按币种汇总已经加上：新增 src/export/summary.ts 负责按 currency 累加，csv.ts 在末尾输出每个币种的合计行，types.ts 增加 CurrencyTotal，tests/export.test.ts 覆盖了两种币种混合的情况，README 补了说明。npm test 全部通过。",
    reply2: "JPY 已经设为 0 位小数，但 `rounds JPY totals without decimals` 仍然失败：合计先用浮点数累加、最后才 toFixed(0)，1234.5 累加后变成 1234.4999…，四舍五入得到 1234。可以改成按最小货币单位的整数累加再格式化。我先停在这里，没有改测试。",
    third: "把失败的测试修好，别改测试的预期值。", fourth: "再跑一遍全部测试。", back: "再把 README 里的示例更新一下。",
    reply3: "已经改成按最小货币单位的整数累加，测试的预期值没有动。", reply4: "全部 18 个测试通过。summary.ts 现在按最小货币单位的整数累加，JPY 的合计不再出现 0.5 的舍入误差。",
  } : {
    first: "Add per-currency totals to the invoice export: print each currency's total at the end of the CSV, and add tests.", second: "No decimals for JPY; round to whole numbers.",
    current: "Fix the failing test, and don't change the test's expected values.",
    reply1: "Per-currency totals are in: the new src/export/summary.ts sums by currency, csv.ts prints one total row per currency at the end, types.ts adds CurrencyTotal, tests/export.test.ts covers two mixed currencies, and the README explains it. npm test passes.",
    reply2: "JPY now has 0 decimals, but `rounds JPY totals without decimals` still fails: the totals are summed as floats and only rounded by toFixed(0) at the end, so 1234.5 sums to 1234.4999… and rounds to 1234. Summing integers in the smallest currency unit would fix it. I stopped here and did not touch the tests.",
    third: "Fix the failing test, and don't change the test's expected values.", fourth: "Run the whole test suite again.", back: "Now update the examples in the README.",
    reply3: "The totals are now summed as integers in the smallest currency unit; the test's expected values are unchanged.", reply4: "All 18 tests pass. summary.ts now sums integers in the smallest currency unit, so JPY totals no longer round 0.5 the wrong way.",
  };
}
const S1_FAILURE = " FAIL  tests/export.test.ts > currency summary > rounds JPY totals without decimals\nAssertionError: expected '1234' to be '1235'\n ❯ tests/export.test.ts:48:31\n Test Files  1 failed | 3 passed (4)\n      Tests  1 failed | 17 passed (18)\n";
const S1_DETAILS: Readonly<Record<string, RelayToolDetail>> = {
  "run-1/r1": { locations: ["src/export/csv.ts"] }, "run-1/r2": { locations: ["src/types.ts"] }, "run-1/r3": { locations: ["tests/export.test.ts"] }, "run-1/r4": { locations: ["README.md"] },
  "run-1/s1": { input: "writeCsv" },
  "run-1/e1": { locations: ["src/export/summary.ts"], diff: diff("src/export/summary.ts", true, 58, 0) }, "run-1/e2": { locations: ["src/export/csv.ts"], diff: diff("src/export/csv.ts", false, 14, 2) },
  "run-1/e3": { locations: ["src/types.ts"], diff: diff("src/types.ts", false, 6, 0) }, "run-1/e4": { locations: ["tests/export.test.ts"], diff: diff("tests/export.test.ts", true, 64, 0) },
  "run-1/e5": { locations: ["README.md"], diff: diff("README.md", false, 9, 0) },
  "run-1/x1": { input: "npm test", output: "\n Test Files  4 passed (4)\n      Tests  17 passed (17)\n" },
  "run-2/e6": { locations: ["src/export/summary.ts"], diff: diff("src/export/summary.ts", false, 4, 1) }, "run-2/e7": { locations: ["tests/export.test.ts"], diff: diff("tests/export.test.ts", false, 7, 0) },
  "run-2/x2": { input: "npm test", output: S1_FAILURE },
};
function s1Runs(language: "zh" | "en"): RunSpec[] {
  const words = s1Words(language);
  return [
    { input: words.first, harnessId: "claude", model: "claude-opus-5-5", thinking: true, reply: words.reply1, tools: [
      tool("r1", "Read src/export/csv.ts", "read"), tool("r2", "Read src/types.ts", "read"), tool("r3", "Read tests/export.test.ts", "read"), tool("r4", "Read README.md", "read"),
      tool("s1", "grep writeCsv", "search"), tool("e1", "Write src/export/summary.ts", "edit"), tool("e2", "Edit `src/export/csv.ts`", "edit"), tool("e3", "Edit `src/types.ts`", "edit"),
      tool("e4", "Write tests/export.test.ts", "edit"), tool("e5", "Edit `README.md`", "edit"), tool("x1", "`npm test`", "execute", { exitCode: 0 })] },
    { input: words.second, harnessId: "claude", model: "claude-opus-5-5", thinking: true, reply: words.reply2, tools: [
      tool("e6", "Edit `src/export/summary.ts`", "edit"), tool("e7", "Edit `tests/export.test.ts`", "edit"), tool("x2", "`npm test`", "execute", { exitCode: 1, status: "failed" })] },
  ];
}
/** S1: Claude Code's two turns, handed to Codex with the user's next words (the binding Codex would resume does not exist). */
export function s1(language: "zh" | "en"): Scenario {
  return conversation([...s1Runs(language), { input: s1Words(language).current, harnessId: "codex", model: "gpt-6.1-sol" }],
    [{ harnessId: "claude", controlId: "claude-acp", checkpoint: "private-claude", throughRunId: runId("run-2"), status: "ready" }], S1_DETAILS);
}
/** S1's A→B→A: DeepSeek Harness did turns 3 and 4, and the user goes back to Claude Code, whose native session holds turns 1–2. */
export function s1Delta(language: "zh" | "en"): Scenario {
  const words = s1Words(language);
  return conversation([...s1Runs(language),
    { input: words.third, harnessId: "dsh", model: "deepseek-v4-flash", reply: words.reply3, tools: [tool("d1", "Read src/export/summary.ts", "read"), tool("d2", "Read tests/export.test.ts", "read"),
      tool("d3", "Read src/export/csv.ts", "read"), tool("d4", "Edit src/export/summary.ts", "edit"), tool("d5", "npm test", "execute", { exitCode: 0 })] },
    { input: words.fourth, harnessId: "dsh", model: "deepseek-v4-flash", reply: words.reply4, tools: [tool("d6", "npm test", "execute", { exitCode: 0 })] },
    { input: words.back, harnessId: "claude", model: "claude-opus-5-5" }],
  [{ harnessId: "claude", controlId: "claude-acp", checkpoint: "private-claude", throughRunId: runId("run-2"), status: "ready" }, { harnessId: "dsh", controlId: "dsh-acp", checkpoint: "private-dsh", throughRunId: runId("run-4"), status: "ready" }],
  S1_DETAILS);
}

/**
 * `count` finished Turns before the current one, alternating Codex and Claude Code, each with an input of `input` bytes, a
 * reply of `reply` bytes and `tools` tools; every 17th failed. With 255 Turns of 27 KiB replies the snapshot is near 8 MiB.
 */
export function longConversation(count: number, profile: { readonly input: number; readonly reply: number; readonly tools: number }, current: string, harnessId = "dsh", window?: number): Scenario {
  // The target reported its context window on an earlier Turn of its own (the first one), when `window` is given.
  const line = "const total = items.reduce((sum, item) => sum + item.amount, 0);\n";
  const specs: RunSpec[] = Array.from({ length: count }, (_, index) => ({
    input: ("Step " + index + ": " + "keep the totals exact and the tests green. ").repeat(Math.ceil(profile.input / 48)).slice(0, profile.input),
    harnessId: index === 0 && window !== undefined ? harnessId : index % 3 === 0 ? "codex" : "claude", status: index % 17 === 5 ? "failed" as const : "completed" as const,
    ...(index === 0 && window !== undefined ? { usage: { context: { used: 1000, size: window } } } : {}),
    error: index % 17 === 5 ? { code: "TOOL_FAILED", message: "the command exited with 1" } : null,
    reply: "```ts\n" + line.repeat(Math.ceil(profile.reply / line.length)).slice(0, profile.reply) + "\n```",
    tools: Array.from({ length: profile.tools }, (_, number) => number % 4 === 0 ? tool("t" + number, "npm test -- --grep step-" + index, "execute", { exitCode: number % 8 === 0 ? 0 : 1 })
      : tool("t" + number, "Read src/module-" + number + ".ts", "read")),
  }));
  return conversation([...specs, { input: current, harnessId }]);
}
