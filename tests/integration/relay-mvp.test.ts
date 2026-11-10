import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl, type NativeCommand } from "../../src/contracts/control.js";
import { DirectorySessionBindingFactory, prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { SqliteWorkspaceLeaseProvider } from "../../src/infrastructure/session/workspace-lease.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type PublicRun, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionEvent, type SessionId, type SessionRuntimeOptions } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { RELAY_POLICY_VERSION } from "../../src/contexts/session/domain/relay/budget.js";
import type { RelayRecord } from "../../src/contexts/session/domain/relay/packet.js";
import { SqliteSessionStore } from "../../src/infrastructure/session/sqlite-store.js";
import { askWhenUnsure } from "../fixtures/relay-settings.js";
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
  // These cases are the delivery rules of the strict design (the user is asked where the policy would settle it); the policy's own are relay-permissive.test.ts's.
  askWhenUnsure(store);
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
      // A Driver without a placement of its own flattens what it is handed (singleText, G068 phase two).
      startText: async (_id, turn, output) => {
        const text = singleText(turn);
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
    // The record's sha256 is of the renderer's text (packet, LF, the words); a Driver flattening the TurnText puts a blank line between.
    assert.equal(relay.sha256, createHash("sha256").update(readRelayPrompt(prompt).body + "\n" + run.input, "utf8").digest("hex"), "the sha256 of the packet and the words as rendered");
    assert.ok(prompt.endsWith("〕\n\n" + run.input), "the Driver's default placement: the packet, a blank line and the words");
    assert.deepEqual(relay.sources, { runs: 2, fromRunId: sources[0].id, throughRunId: sources[1].id, origin: false });
    assert.equal(relay.firstLine, true); assert.ok(relay.tokens > 0 && relay.tokens <= relay.budget.cap);
    assert.ok(!JSON.stringify(data).includes(run.input) && !JSON.stringify(data).includes(sources[0].input), "no text of the packet in the event");
  }
  // The snapshot keeps no text of a packet: only its identity in the Run's and the binding's relay state (Session v13, G068 phase two).
  const snapshot = JSON.stringify(app.read(session.id));
  assert.ok(!snapshot.includes("这段对话前面的部分不在你的上下文里") && !snapshot.includes("policyVersion"));
  assert.equal(app.read(session.id).runs.find(row => row.id === b3.id)?.relay?.packetId, readRelayPrompt(fake.to("bravo")[0]!).packetId);
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

// Review of e0cf7de: the Session's known secrets (M1) and details that cannot be read (m7).

test("G070-MVP M1: the Session's known secrets through the real binding factory: what each carried Harness's configuration references and its catalog controls' credentials, with the Gateway's own", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-secrets-"))), home = join(root, "home"), workspace = join(root, "workspace"), manifest = join(root, "catalog.json");
  const closing: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closing) await close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(home, ".config", "opencode"), { recursive: true }); await mkdir(join(home, ".codex"), { recursive: true }); await mkdir(workspace);
  // OpenCode and Codex reference credentials by names that hold no credential word (the design's CORP_LLM); a custom catalog
  // control carries one in its env.
  await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ provider: { corp: { options: { apiKey: "{env:CORP_LLM}", baseURL: "https://{env:CORP_LLM_HOST}/v1" } } } }));
  await writeFile(join(home, ".codex", "config.toml"), '[model_providers.corp]\nname = "corp"\nenv_key = "CORP_GATEWAY"\n');
  const source = { repository: "fixture", revision: "relay", upstreamId: "relay", url: "https://example.invalid/relay" };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [{ id: "corp-agent", name: "Corp Agent", aliases: [], binaryNames: [], configHints: [], controls: [{ id: "corp-agent-acp", protocol: "acp-v1",
    executableNames: ["corp-agent"], args: [], env: { CORP_AGENT_API_KEY: "manifest-control-key-5h2k9q", CORP_AGENT_REGION: "cn-north-1" }, package: null, distribution: null, requiredExecutables: [], source }] }] }));
  const environment = captureNativeEnvironment({ HOME: home, PATH: "/usr/bin:/bin", CORP_LLM: "corp-llm-synthetic-7d1q4x", CORP_LLM_HOST: "llm.corp.example", CORP_GATEWAY: "corp-gateway-synthetic-3m8z",
    UNRELATED_VALUE: "unrelated-synthetic-value", GATEWAY_API_TOKEN: "gateway-own-token-9x2" });
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true });
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "locks")), () => {}, "any", undefined, undefined, environment);
  closing.push(() => factory.close());
  const secrets = await factory.relaySecrets(configuration, ["claude", "opencode", "codex", "corp-agent"]);
  for (const value of ["corp-llm-synthetic-7d1q4x", "corp-gateway-synthetic-3m8z", "manifest-control-key-5h2k9q", "gateway-own-token-9x2"]) assert.ok(secrets.includes(value), value);
  for (const value of ["llm.corp.example", "cn-north-1", "unrelated-synthetic-value", home, "/usr/bin:/bin"]) assert.ok(!secrets.includes(value), "no secret: " + value);
  // Invalid sample: the target alone (Claude Code, which references none of them) misses what the others reference and hold.
  const alone = await factory.relaySecrets(configuration, ["claude"]);
  for (const value of ["corp-llm-synthetic-7d1q4x", "corp-gateway-synthetic-3m8z", "manifest-control-key-5h2k9q"]) assert.ok(!alone.includes(value), value);
  assert.ok(alone.includes("gateway-own-token-9x2"), "the Gateway's own environment counts for every Harness");
});

/** FakeHarnesses whose factory also answers relaySecrets as the Gateway's does: by the Harnesses a packet carries. */
class SecretHarnesses extends FakeHarnesses {
  readonly asked: (readonly string[])[] = [];
  /** What the next answers reject with, as a factory that cannot read a configuration would; null answers. */
  failure: Error | null = null;
  constructor(reply: (harnessId: string, text: string) => string, private readonly referenced: Readonly<Record<string, readonly string[]>>, commands: readonly NativeCommand[] = []) { super(reply, [], commands); }
  async relaySecrets(_configuration: SessionConfiguration, harnessIds: readonly string[]): Promise<readonly string[]> {
    this.asked.push([...harnessIds]);
    if (this.failure !== null) throw this.failure;
    return harnessIds.flatMap(id => this.referenced[id] ?? []);
  }
}

test("G070-MVP M1: the Runtime redacts with the known secrets of every Harness its packet carries, and asks for them only when a packet goes", async t => {
  const ALPHA = "alpha-only-referenced-value-6f2k8w", reply = (harnessId: string, text: string) => harnessId === "alpha" ? "我用 " + ALPHA + " 调用了内部服务：" + text : "ok";
  for (const answers of [true, false]) {
    const f = await world(t), fake = answers ? new SecretHarnesses(reply, { alpha: [ALPHA] }) : new FakeHarnesses(reply);
    const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
    await sent(app, session.id, "调用内部服务", "a1"); await sent(app, session.id, "再调一次", "a2");
    if (fake instanceof SecretHarnesses) assert.deepEqual(fake.asked, [], "a single Harness's Turns send no packet and read nothing for one");
    await switched(app, session.id, "bravo", "to-b");
    await sent(app, session.id, "接着做", "b1"); await sent(app, session.id, "再来", "b2");
    const packet = readRelayPrompt(fake.to("bravo")[0]!);
    assert.equal(packet.kind, "packet"); assert.equal(fake.to("bravo")[1], "再来");
    if (fake instanceof SecretHarnesses) {
      assert.deepEqual(fake.asked, [["alpha", "bravo"]], "once, for the target and the Harness whose turns it carries");
      assert.ok(!packet.body.includes(ALPHA)); assert.match(packet.body, /〔已脱敏 · 已知凭据〕/u);
    } else assert.ok(packet.body.includes(ALPHA), "invalid sample: with the target binding's own secrets alone, alpha's value leaves");
  }
});

test("G070-MVP m7: a stored detail whose bytes cannot be read (no permission, a link, a directory) is not read: readText answers null and the Turn goes on with the tool's title", async t => {
  const tools = (harnessId: string): readonly ControlEvent[] => harnessId !== "alpha" ? [] : [
    { type: "tool", id: "edit-1", title: "Edit file", status: "completed", detail: { kind: "edit", diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+x\n", locations: ["src/a.ts"] } }];
  const f = await world(t), fake = new FakeHarnesses(undefined, [], [], tools), app = f.runtime(fake, { content: f.content }), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  await sent(app, session.id, "改一下 a.ts", "a1");
  const ref = app.read(session.id).runs[0]!.tools?.[0]?.detail;
  assert.ok(ref !== undefined, "the detail was stored");
  const blob = f.content.read(ref.id).path, aside = blob + ".aside", mode = (await stat(blob)).mode & 0o777;
  assert.notEqual(await f.content.readText(ref, 256 * 1024), null, "readable as stored");
  const spoiled: readonly (readonly [string, () => Promise<void>, () => Promise<void>])[] = [
    ["no permission (EACCES)", () => chmod(blob, 0o000), () => chmod(blob, mode)],
    ["a link (ELOOP)", async () => { await rename(blob, aside); await symlink(aside, blob); }, async () => { await rm(blob); await rename(aside, blob); }],
    ["a directory (EISDIR)", async () => { await rename(blob, aside); await mkdir(blob); }, async () => { await rm(blob, { recursive: true }); await rename(aside, blob); }],
  ];
  for (const [label, spoil, restore] of spoiled) {
    await spoil();
    try { assert.equal(await f.content.readText(ref, 256 * 1024), null, label); } finally { await restore(); }
  }
  assert.notEqual(await f.content.readText(ref, 256 * 1024), null, "readable again");
  // Through the Runtime: the Turn that would quote it goes on and lists the tool by its title.
  await chmod(blob, 0o000);
  try {
    await switched(app, session.id, "bravo", "to-b");
    const run = await sent(app, session.id, "看看改了什么", "b1"), prompt = fake.to("bravo")[0]!;
    assert.equal(run.status, "completed");
    assert.match(prompt, /^- 修改 `Edit file`。$/mu); assert.match(prompt, /^- 工具详情没有读取：1 个工具调用只按标题列出。$/mu);
  } finally { await chmod(blob, mode); }
});

// Review of ffc0796: a configuration the relay cannot read fails only the Turn that would carry a packet (N3).

test("G070-MVP N3: a configuration the real factory cannot read is named in RELAY_PREPARE_FAILED (the Harness, the file, why), never with a value; fixed, it is read again", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-unreadable-"))), home = join(root, "home"), workspace = join(root, "workspace"), file = join(home, ".config", "opencode", "opencode.json");
  const closing: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of closing) await close(); await chmod(file, 0o600).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(home, ".config", "opencode"), { recursive: true }); await mkdir(workspace);
  const good = JSON.stringify({ provider: { corp: { options: { apiKey: "{env:CORP_LLM}" } } } });
  const environment = captureNativeEnvironment({ HOME: home, PATH: "/usr/bin:/bin", CORP_LLM: "corp-llm-synthetic-7d1q4x" });
  const configuration = await prepareConfiguration({ workspace, pathOnly: true });
  const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "locks")), () => {}, "any", undefined, undefined, environment);
  closing.push(() => factory.close());
  const spoiled: readonly (readonly [string, () => Promise<void>, string])[] = [
    ["a directory", () => mkdir(file), "不是普通文件"],
    ["over 2 MiB", () => writeFile(file, good + " ".repeat(2 * 1024 * 1024)), "超过 2 MiB"],
    ["no permission", async () => { await writeFile(file, good); await chmod(file, 0o000); }, "没有读取权限"],
  ];
  for (const [label, spoil, why] of spoiled) {
    await chmod(file, 0o600).catch(() => {}); await rm(file, { recursive: true, force: true }); await spoil();
    await assert.rejects(factory.relaySecrets(configuration, ["claude", "opencode"]), (error: unknown) => {
      assert.ok(error instanceof SessionError && error.code === "RELAY_PREPARE_FAILED", label + ": " + String(error));
      assert.ok(error.message.startsWith("没能准备交接单：读不到 OpenCode 的配置文件 " + file + "（" + why + "）。"), label + ": " + error.message);
      assert.ok(error.message.endsWith("修好或缩小这个文件后再发；也可以只发这条消息，不带交接单。"), label);
      assert.ok(!error.message.includes("corp-llm-synthetic-7d1q4x") && error.message.length <= 512, label);
      return true;
    });
  }
  await chmod(file, 0o600); await writeFile(file, good);
  assert.ok((await factory.relaySecrets(configuration, ["claude", "opencode"])).includes("corp-llm-synthetic-7d1q4x"), "fixed, it is read again");
});

test("G070-MVP N3: secrets are read only for a Turn that builds a packet; when they cannot be read that Turn alone fails with RELAY_PREPARE_FAILED, undispatched, and the next one carries what is still owed", async t => {
  const f = await world(t), fake = new SecretHarnesses(harnessId => "reply from " + harnessId, {}, [{ name: "review", description: "review", contextEffect: "keep" }]);
  const app = f.runtime(fake), session = await app.create(f.configuration, { harnessId: "alpha" }, "create");
  const a1 = await sent(app, session.id, "first on alpha", "a1");
  await switched(app, session.id, "bravo", "to-b");
  // A command owing history goes as typed and reads nothing for a packet, so a configuration it cannot read never fails it.
  fake.failure = new Error("must not be asked");
  const command = await sent(app, session.id, "/review the change", "b1");
  assert.equal(command.status, "completed"); assert.deepEqual(fake.asked, []); assert.deepEqual(fake.to("bravo"), ["/review the change"]);
  const positions = () => JSON.stringify(app.read(session.id).nativeBindings ?? []), before = positions();
  // The factory names what it cannot read: that Turn fails with it, is never dispatched, and moves no position.
  fake.failure = new SessionError("RELAY_PREPARE_FAILED", "没能准备交接单：读不到 Alpha Harness 的配置文件 /tmp/alpha.json（超过 2 MiB）。修好或缩小这个文件后再发；也可以只发这条消息，不带交接单。");
  const failed = await sent(app, session.id, "now continue", "b2");
  assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "RELAY_PREPARE_FAILED"); assert.match(failed.error?.message ?? "", /Alpha Harness 的配置文件 \/tmp\/alpha\.json（超过 2 MiB）/u);
  assert.deepEqual(fake.to("bravo"), ["/review the change"], "not dispatched"); assert.deepEqual(failed.sourceRunIds, []); assert.equal(positions(), before, "no native position moved");
  // A failure the factory did not name is the relay's as well, never the target Harness's.
  fake.failure = Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
  const again = await sent(app, session.id, "now continue", "b3");
  assert.equal(again.error?.code, "RELAY_PREPARE_FAILED"); assert.match(again.error?.message ?? "", /^没能准备交接单：.*也可以只发这条消息，不带交接单。$/u);
  assert.ok(!(again.error?.message ?? "").includes("EIO") && !(again.error?.message ?? "").includes("Harness operation failed"));
  // Fixed: the next content input carries the packet with what is still owed, and the Runtime runs on.
  fake.failure = null;
  const carried = await sent(app, session.id, "now continue", "b4"), packet = readRelayPrompt(fake.to("bravo")[1]!);
  assert.equal(carried.status, "completed"); assert.equal(packet.kind, "packet"); assert.equal(packet.history[0]!.user.text, a1.input); assert.ok(carried.sourceRunIds.includes(a1.id));
  assert.deepEqual(fake.asked, [["alpha", "bravo"], ["alpha", "bravo"], ["alpha", "bravo"]]);
});
