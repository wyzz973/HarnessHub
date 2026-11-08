import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl, type NativeCommand } from "../../src/contracts/control.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionRuntimeOptions } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { RELAY_POLICY_VERSION } from "../../src/contexts/session/domain/relay/budget.js";
import type { RelayRecord } from "../../src/contexts/session/domain/relay/packet.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { readRelayPrompt } from "../fixtures/relay-packet.js";

// G070 MVP through the formal Runtime and a real SqliteSessionStore (ADR-055 §5, §7.6 on Session v12): the packet a Turn
// sends, what run.context_prepared records of it, zero injection, the A→B→A delta and known secrets. Harnesses are
// in-process fakes in a temporary directory; nothing here runs a Harness.

const clean: CleanupEvidence = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
const SECRET = "corp-llm-token/0123456789+abcdef";
interface World { readonly store: SqliteSessionStore; readonly content: LocalContentStore; readonly configuration: SessionConfiguration; runtime(factory: SessionBindingFactory, options?: Partial<SessionRuntimeOptions>): SessionRuntime }
async function world(t: test.TestContext): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "relay-mvp-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const store = new SqliteSessionStore(join(root, "data")), content = new LocalContentStore(join(root, "data"), () => store.assertOwner()), runtimes: SessionRuntime[] = [];
  t.after(async () => {
    for (const app of runtimes) await app.close();
    try { store.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  let next = 0;
  return { store, content, configuration: { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true },
    runtime(factory, options = {}) {
      const app = new SessionRuntime(store, factory, { id: () => String(++next), now: () => new Date("2026-11-09T00:00:00Z"), publish: () => {},
        fingerprint: value => createHash("sha256").update(value).digest("hex"), harnessName: id => ({ alpha: "Alpha Harness", bravo: "Bravo Harness" })[id] ?? null, ...options });
      runtimes.push(app); return app;
    } };
}
function events(store: SqliteSessionStore, id: SessionId): readonly SessionEvent[] {
  const all: SessionEvent[] = [];
  for (let after = 0; ;) { const page = store.events(id, after, 100); if (!page.length) return all; all.push(...page); after = page.at(-1)!.seq; }
}
function prepared(store: SqliteSessionStore, id: SessionId, run: string): Readonly<Record<string, unknown>> {
  const found = events(store, id).find(row => row.type === "run.context_prepared" && row.data.runId === run);
  assert.ok(found, "run.context_prepared of " + run); return found.data;
}
async function sent(app: SessionRuntime, id: SessionId, text: string, key: string, relay?: { readonly attach: "none" }): Promise<PublicRun> {
  const receipt = app.send(id, text, key, [], relay); await app.wait(id);
  return app.read(id).runs.find(row => row.id === receipt.runId)!;
}
async function switched(app: SessionRuntime, id: SessionId, harnessId: string, key: string): Promise<void> {
  app.switch(id, { harnessId }, key); await app.wait(id); assert.equal(app.read(id).selection.harnessId, harnessId);
}

/**
 * Fake Harnesses alpha and bravo with resumable native sessions: each prompt is recorded with the Harness it reached; a
 * reply quotes `reply(text)`; the prepared binding holds `secrets`, as the Gateway's binding factory computes them.
 */
class FakeHarnesses implements SessionBindingFactory {
  readonly prompts: { readonly harnessId: string; readonly text: string }[] = [];
  constructor(private readonly reply: (harnessId: string, text: string) => string = harnessId => "reply from " + harnessId, private readonly secrets: readonly string[] = [], private readonly commands: readonly NativeCommand[] = [],
    private readonly tools: (harnessId: string, turn: number) => readonly ControlEvent[] = (_harnessId, turn) => [{ type: "tool", id: "tool-" + turn, title: "npm test", status: "completed", detail: { kind: "execute", exitCode: 0 } }]) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha" && request.harnessId !== "bravo") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
    const harnessId = selected.harnessId; let opened = false;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId("native-" + harnessId); },
      checkpoint: async () => opened ? "private-native-" + harnessId : null,
      models: async () => ({ models: [{ id: "model-a", name: "A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: this.commands }),
      startText: async (_id, text, output) => {
        this.prompts.push({ harnessId, text });
        for (const event of this.tools(harnessId, this.prompts.length)) output(event);
        output({ type: "text", text: this.reply(harnessId, readRelayPrompt(text).currentInput.text) });
        return { result: Promise.resolve<BackendResult>({ status: "completed", reason: "fake", input: "recorded" }), requestStop: async () => ({ requested: true }) };
      },
      close: async () => clean,
    };
    return { control, workspace: configuration.workspace, secrets: this.secrets, assertOwned: () => {}, close: () => control.close() };
  }
  to(harnessId: string): readonly string[] { return this.prompts.filter(row => row.harnessId === harnessId).map(row => row.text); }
}

test("G070-MVP a single-Harness conversation is never injected: every input, the first one too, reaches it exactly as typed", async t => {
  const f = await world(t), fake = new FakeHarnesses(), app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const inputs = ["first question", "第二个问题", "/not-a-command with words", "```\ncode first\n```", "〔HarnessHub 交接单 relay-aaaaaaaaaaaaaaaaaaaa〕"];
  for (const [index, text] of inputs.entries()) await sent(app, session.id, text, "s" + index);
  assert.deepEqual(fake.to("alpha"), inputs);
  const state = app.read(session.id);
  assert.ok(state.runs.every(run => run.sourceRunIds.length === 0));
  assert.ok(events(f.store, session.id).filter(row => row.type === "run.context_prepared").every(row => !("relay" in row.data)), "no packet was rendered");
});

test("G070-MVP A→B→A through the Runtime: bravo gets a packet of alpha's turns; back on alpha only bravo's turns go, as a delta; run.context_prepared records each without its text", async t => {
  const f = await world(t), fake = new FakeHarnesses(), app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const a1 = await sent(app, session.id, "把发票导出加上按币种汇总", "a1"), a2 = await sent(app, session.id, "日元不要有小数", "a2");
  await switched(app, session.id, "bravo", "to-b");
  const b3 = await sent(app, session.id, "把失败的测试修好，别改测试的预期值。", "b3"), b4 = await sent(app, session.id, "再跑一遍全部测试。", "b4");
  await switched(app, session.id, "alpha", "to-a");
  const a5 = await sent(app, session.id, "再把 README 里的示例更新一下。", "a5"), a6 = await sent(app, session.id, "好的", "a6");
  // bravo's first input: a full packet of alpha's two turns, then its own words exactly as typed; its second goes as typed.
  const toBravo = readRelayPrompt(fake.to("bravo")[0]!);
  assert.equal(toBravo.kind, "packet"); assert.deepEqual(toBravo.history.map(row => row.user.text), [a1.input, a2.input]); assert.equal(toBravo.currentInput.text, b3.input);
  assert.match(fake.to("bravo")[0]!, /^把失败的测试修好，别改测试的预期值。\n〔HarnessHub 交接单 relay-[0-9a-z]{20}〕\n这段对话前面的部分不在你的上下文里：另一个 Harness（Alpha Harness）在同一个工作区里/u);
  assert.equal(fake.to("bravo")[1], b4.input);
  // Back on alpha, whose native session holds turns 1–2: only bravo's turns 3–4, as a delta, and never again what alpha did.
  const toAlpha = readRelayPrompt(fake.to("alpha")[2]!);
  assert.equal(toAlpha.kind, "delta"); assert.deepEqual(toAlpha.history.map(row => [row.turn, row.user.text]), [[3, b3.input], [4, b4.input]]); assert.equal(toAlpha.currentInput.text, a5.input);
  assert.ok(!fake.to("alpha")[2]!.includes(a1.input) && !fake.to("alpha")[2]!.includes(a2.input));
  assert.match(fake.to("alpha")[2]!, /^你（Alpha Harness）在第 2 轮之后离开，这段对话随后由 Bravo Harness 做了 2 轮。$/mu);
  assert.equal(fake.to("alpha")[3], a6.input, "once carried, nothing is owed");
  assert.deepEqual(a5.sourceRunIds, [b3.id, b4.id]);
  // What run.context_prepared keeps: the policy, the packet's ID and the sha256 of the text sent, the facts carried, the fold.
  for (const [run, prompt, kind, sources] of [[b3, fake.to("bravo")[0]!, "packet", [a1, a2]], [a5, fake.to("alpha")[2]!, "delta", [b3, b4]]] as const) {
    const data = prepared(f.store, session.id, run.id), relay = data.relay as RelayRecord;
    assert.equal(relay.policyVersion, RELAY_POLICY_VERSION); assert.equal(relay.kind, kind); assert.equal(relay.packetId, readRelayPrompt(prompt).packetId);
    assert.equal(relay.sha256, createHash("sha256").update(prompt, "utf8").digest("hex"), "the sha256 of exactly what was sent");
    assert.deepEqual(relay.sources, { runs: 2, fromRunId: sources[0].id, throughRunId: sources[1].id, origin: false });
    assert.equal(relay.firstLine, true); assert.ok(relay.tokens > 0 && relay.tokens <= relay.budget.cap);
    assert.ok(!JSON.stringify(data).includes(run.input) && !JSON.stringify(data).includes(sources[0].input), "no text of the packet in the event");
  }
  // The snapshot grew no field: the packet lives only in what was sent and in the event's record.
  const snapshot = JSON.stringify(app.read(session.id));
  assert.ok(!/relay-[0-9a-z]{20}/u.test(snapshot) && !snapshot.includes("packetId") && !snapshot.includes("policyVersion"));
});

test("G070-MVP the binding's known secrets never leave in a packet, in any of their three spellings; the user's current words still go as typed", async t => {
  const f = await world(t), spellings = [SECRET, JSON.stringify(SECRET).slice(1, -1), encodeURIComponent(SECRET)];
  const fake = new FakeHarnesses((harnessId, text) => harnessId === "alpha" ? "我用了 " + spellings.join(" 和 ") + " 调用服务：" + text : "ok", [SECRET]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  await sent(app, session.id, "用环境里的令牌调用服务", "a1");
  await switched(app, session.id, "bravo", "to-b");
  const words = "接着做，令牌是 " + SECRET;
  const run = await sent(app, session.id, words, "b1"), prompt = fake.to("bravo")[0]!, packet = readRelayPrompt(prompt);
  for (const spelling of spellings) assert.ok(!packet.body.includes(spelling), spelling);
  assert.match(packet.body, /〔已脱敏 · 已知凭据〕/u);
  assert.ok(prompt.endsWith("\n" + words), "the current words are never redacted (D4)");
  assert.match(prompt, /^〔HarnessHub 交接单 /u, "but they no longer open the packet, since they hold a secret");
  const relay = prepared(f.store, session.id, run.id).relay as RelayRecord;
  assert.equal(relay.firstLine, false); assert.ok(relay.redactions >= 3);
  // The relay's own records never hold it (the public facts that quote it verbatim are the user's words and the reply).
  for (const row of events(f.store, session.id).filter(row => row.type === "run.context_prepared")) for (const spelling of spellings) assert.ok(!JSON.stringify(row.data).includes(spelling));
});

test("G070-MVP a command owing facts still goes exactly as typed, and the facts go with the next content input; sent alone, they stay owed", async t => {
  const f = await world(t), fake = new FakeHarnesses(undefined, [], [{ name: "review", description: "review", contextEffect: "keep" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const a1 = await sent(app, session.id, "first on alpha", "a1");
  await switched(app, session.id, "bravo", "to-b");
  await sent(app, session.id, "/review the change", "b1"); await sent(app, session.id, "only this", "b2", { attach: "none" });
  assert.deepEqual(fake.to("bravo"), ["/review the change", "only this"]);
  const b3 = await sent(app, session.id, "now continue", "b3"), packet = readRelayPrompt(fake.to("bravo")[2]!);
  assert.equal(packet.kind, "packet"); assert.equal(packet.history[0]!.user.text, a1.input); assert.equal(packet.currentInput.text, b3.input);
  assert.ok(b3.sourceRunIds.includes(a1.id));
});

test("G070-MVP stored tool details are read back for the packet: the command and its failing output's end, the edited file with its counts; without a store that reads back, titles only and the ledger says so", async t => {
  const failure = " FAIL  tests/export.test.ts > rounds JPY totals\nAssertionError: expected '1234' to be '1235'\n Tests  1 failed | 17 passed (18)\n";
  const tools = (harnessId: string): readonly ControlEvent[] => harnessId !== "alpha" ? [] : [
    { type: "tool", id: "edit-1", title: "Edit file", status: "completed", detail: { kind: "edit", diff: "--- a/src/export/summary.ts\n+++ b/src/export/summary.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n", locations: ["src/export/summary.ts:3"] } },
    { type: "tool", id: "test-1", title: "Terminal", status: "failed", detail: { kind: "execute", input: "npm test -- --run", output: "noise\n".repeat(40) + failure, exitCode: 1 } },
  ];
  for (const readable of [true, false]) {
    const f = await world(t), fake = new FakeHarnesses(undefined, [], [], tools);
    const app = f.runtime(fake, readable ? { content: f.content } : {}), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
    await sent(app, session.id, "修复按币种汇总", "a1");
    await switched(app, session.id, "bravo", "to-b");
    await sent(app, session.id, "看看哪里失败了", "b1");
    const prompt = fake.to("bravo")[0]!;
    if (readable) {
      assert.match(prompt, /^- 修改 `src\/export\/summary\.ts`（\+2 −1）。$/mu, "the path and counts come from the stored diff");
      assert.match(prompt, /^- 执行 `npm test -- --run` → 退出码 1。输出末尾：$/mu, "the command comes from the stored input, not the title");
      assert.ok(prompt.includes("  AssertionError: expected '1234' to be '1235'"), "the failing output's end is quoted");
      assert.equal(prompt.split("\n").filter(line => line === "  noise").length, 20 - 3, "only its last 20 lines: 17 of the 40 noise lines and the 3 of the failure");
      assert.match(prompt, /^\| `src\/export\/summary\.ts` \| 修改 \| \+2 −1 \| 第 1 轮 \|$/mu);
      assert.ok(!prompt.includes("工具详情没有读取"));
    } else {
      assert.match(prompt, /^- 修改 `Edit file`。$/mu); assert.match(prompt, /^- 执行 `Terminal` → 退出码 1。$/mu);
      assert.match(prompt, /^- 工具详情没有读取：2 个工具调用只按标题列出。$/mu);
      assert.match(prompt, /^- 交接时没有观测工作区；文件改动以工作区为准。$/mu);
    }
  }
});
