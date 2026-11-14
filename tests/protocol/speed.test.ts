import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlOptions, NativeOption } from "../../src/contracts/control.js";
import { CodexControl } from "../../src/adapters/control/codex.js";
import { ClaudeControl } from "../../src/adapters/control/claude.js";
import { codexFlavor } from "../../src/adapters/flavors/codex.js";
import { claudeFlavor } from "../../src/adapters/flavors/claude.js";
import { flavorOf } from "../../src/adapters/flavors/index.js";
import { levelOptions, nativeLevels, selectedLevels } from "../../src/contracts/flavor.js";
import { ControlError } from "../../src/infrastructure/control/json-rpc-process.js";

/*
 * The speed choice (2026-11-14, `hub_speed`: standard | fast, T3 Code's Standard | Fast): how each declaration reads it off a catalog, and what each Driver sends
 * its program for it. Codex: the thread's `serviceTier` on thread/start and thread/resume (app-server 0.166.0); Claude Code: claude-agent-acp's `fast` session option.
 */
const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1500, maxFrameBytes: 65536, maxDiagnosticBytes: 1024, closeGraceMs: 150 };
const peer = resolve("tests/fixtures/control-peer.mjs");
type Sent = { readonly method?: string; readonly params?: Record<string, unknown> };
const sent = async (trace: string, method: string): Promise<Record<string, unknown>[]> =>
  (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Sent).filter(row => row.method === method).map(row => row.params ?? {});

const tier = (current: string, more: readonly { value: string; name: string }[] = []): NativeOption =>
  ({ id: "service_tier", name: "速度", category: "speed", currentValue: current, values: [{ value: "default", name: "标准" }, { value: "priority", name: "Fast · 2x speed, increased usage" }, ...more] });
const fast = (current: string): NativeOption => ({ id: "fast", name: "Fast mode", category: "model_config", currentValue: current, values: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] });

test("the speed is read off a model's catalog by the declaration: standard and each faster tier, only where the model has one; standard is given as nothing where the Harness runs it anyway", () => {
  // Codex: standard is "default", priority is fast, a further tier keeps its own name; the user's own tier is the configuration's.
  const levels = nativeLevels(codexFlavor, [tier("default")]);
  assert.deepEqual(levels.speed, [{ level: "standard", options: { service_tier: "default" } }, { level: "fast", options: { service_tier: "priority" }, note: "Fast · 2x speed, increased usage" }]);
  assert.equal(levels.speedOwn, "standard");
  assert.deepEqual(nativeLevels(codexFlavor, [tier("priority", [{ value: "ultrafast", name: "ultrafast" }])]).speed.map(entry => entry.level), ["standard", "fast", "ultrafast"]);
  assert.equal(nativeLevels(codexFlavor, [tier("priority")]).speedOwn, "fast");
  // A new thread is given the tier only where it differs from what it runs on its own; a restored one is given it named (its thread may keep an earlier tier).
  assert.deepEqual(levelOptions(codexFlavor, [tier("default")], undefined, { speed: "fast" }), { service_tier: "priority" });
  assert.equal(levelOptions(codexFlavor, [tier("default")], undefined, { speed: "standard" }), undefined, "standard on a Codex that runs standard: nothing");
  assert.deepEqual(levelOptions(codexFlavor, [tier("default")], undefined, { speed: "standard" }, true), { service_tier: "default" });
  assert.deepEqual(levelOptions(codexFlavor, [tier("priority")], undefined, { speed: "standard" }), { service_tier: "default" }, "the user's configuration runs fast: standard is named");
  assert.equal(levelOptions(codexFlavor, [tier("priority")], undefined, { speed: "fast" }), undefined, "fast where the configuration runs fast: nothing");
  // The level wins over a native value of the same option, by giving nothing when nothing is needed.
  assert.deepEqual(levelOptions(codexFlavor, [tier("default")], { service_tier: "priority" }, { speed: "standard" }), {});
  // A model without a faster tier offers no speed, and a chosen one gives it nothing.
  const none = nativeLevels(codexFlavor, []);
  assert.deepEqual([none.speed, none.speedOwn, none.speedMissing], [[], undefined, "这个模型没有更快的档"]);
  assert.equal(levelOptions(codexFlavor, [], undefined, { speed: "fast" }), undefined);
  assert.deepEqual(nativeLevels(codexFlavor, [{ ...tier("default"), values: [{ value: "default", name: "标准" }] }]).speed, [], "standard alone is no choice");
  // Claude Code: the fast option's "off" is standard, "on" fast.
  assert.deepEqual(nativeLevels(claudeFlavor, [fast("off")]).speed, [{ level: "standard", options: { fast: "off" } }, { level: "fast", options: { fast: "on" } }]);
  assert.deepEqual(levelOptions(claudeFlavor, [fast("off")], undefined, { speed: "fast" }), { fast: "on" });
  assert.deepEqual(levelOptions(claudeFlavor, [fast("on")], undefined, { speed: "standard" }), { fast: "off" });
  // A Harness whose declaration names no speed is offered none, whatever its catalog holds.
  assert.equal(flavorOf("opencode").speed, undefined);
  assert.deepEqual([nativeLevels(flavorOf("opencode"), [fast("off")]).speed, nativeLevels(flavorOf("opencode"), [fast("off")]).speedMissing], [[], "这一家没有速度可选"]);
  // The selection names the speed by the Hub's key, beside the other levels; a value that is no name is not read.
  assert.deepEqual(selectedLevels({ hub_effort: "high", hub_speed: "fast", reasoning_effort: "low" }), { effort: "high", speed: "fast" });
  assert.deepEqual(selectedLevels({ hub_speed: "fast now!" }), {});
});

test("Codex: the catalog lists a model's service tiers as its speed, and the thread is given `serviceTier` for the speed chosen only where it differs from what it runs on its own", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-codex-speed-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const codex = (env: Record<string, string>, speed?: string) => new CodexControl({ protocol: "codex-app-server", executable: process.execPath, args: [peer, "codex-app-server", "speed"], env },
    { ...options, flavor: codexFlavor, ...(speed === undefined ? {} : { speed }) });
  // The catalog: model a has a faster tier (and the user's configuration runs it), model b has none.
  const reader = codex({ FIXTURE_SERVICE_TIER: "priority" });
  try {
    await reader.initialize();
    const models = (await reader.models()).models, a = models.find(row => row.id === "native-model-a")!, b = models.find(row => row.id === "native-model-b")!;
    assert.deepEqual(a.options?.find(option => option.id === "service_tier"), { id: "service_tier", name: "速度", category: "speed", currentValue: "priority",
      values: [{ value: "default", name: "标准" }, { value: "priority", name: "Fast · 2x speed, increased usage" }] });
    assert.equal(b.options?.some(option => option.id === "service_tier") ?? false, false);
    assert.deepEqual([nativeLevels(codexFlavor, a.options ?? []).speed.map(entry => entry.level), nativeLevels(codexFlavor, a.options ?? []).speedOwn], [["standard", "fast"], "fast"]);
  } finally { await reader.close(); }
  // What thread/start and thread/resume are given, case by case.
  const cases: readonly { readonly name: string; readonly env: Record<string, string>; readonly speed: string; readonly model?: string; readonly checkpoint?: string; readonly expected: string | undefined }[] = [
    { name: "standard where the configuration runs fast", env: { FIXTURE_SERVICE_TIER: "priority" }, speed: "standard", expected: "default" },
    { name: "fast where the configuration runs fast", env: { FIXTURE_SERVICE_TIER: "priority" }, speed: "fast", expected: undefined },
    { name: "fast where the configuration names none", env: {}, speed: "fast", expected: "priority" },
    { name: "standard where the configuration names none", env: {}, speed: "standard", expected: undefined },
    { name: "standard on a restored thread an earlier turn ran fast", env: { FIXTURE_THREAD_TIER: "priority" }, speed: "standard", checkpoint: "thread-fixture", expected: "default" },
    { name: "fast on a model without a faster tier", env: {}, speed: "fast", model: "native-model-b", expected: undefined },
  ];
  for (const item of cases) {
    const trace = join(directory, item.name.replace(/\W+/gu, "-")), driver = codex({ ...item.env, FIXTURE_TRACE: trace }, item.speed);
    try {
      await driver.initialize();
      const id = await driver.open(process.cwd(), item.model, undefined, item.checkpoint);
      const opened = (await sent(trace, item.checkpoint === undefined ? "thread/start" : "thread/resume"))[0]!;
      assert.equal(opened.serviceTier, item.expected, item.name);
      if (item.checkpoint === undefined && item.model === undefined) {
        // The thread keeps it for its turns: a Turn sends no tier of its own.
        assert.equal((await (await driver.startText(id, "hello", () => {})).result).status, "completed", item.name);
        assert.equal(Object.hasOwn((await sent(trace, "turn/start"))[0]!, "serviceTier"), false, item.name);
      }
    } finally { await driver.close(); }
  }
  // A thread that reports another tier than the one asked for fails to open (Codex reports a tier it does not know as none); a native value the model lacks is refused.
  const ignored = codex({ FIXTURE_TIER_REPORT: "none" }, "fast");
  try { await ignored.initialize(); await assert.rejects(ignored.open(process.cwd()), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_OPTION_MISMATCH"); }
  finally { await ignored.close(); }
  const unknown = codex({});
  try { await unknown.initialize(); await assert.rejects(unknown.open(process.cwd(), undefined, { service_tier: "ultrafast" }), (error: unknown) => error instanceof ControlError && error.code === "NATIVE_OPTION_UNAVAILABLE"); }
  finally { await unknown.close(); }
});

test("Claude Code: the speed is claude-agent-acp's `fast` session option, set only on a model that has it and only where it differs from what the session runs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-speed-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const claude = (env: Record<string, string>, speed?: string) => new ClaudeControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", "claude-fast"], env },
    { ...options, flavor: claudeFlavor, ...(speed === undefined ? {} : { speed }) });
  const fastSet = async (trace: string) => (await sent(trace, "session/set_config_option")).filter(params => params.configId === "fast").map(params => params.value);
  const cases: readonly { readonly name: string; readonly env: Record<string, string>; readonly speed: string; readonly model?: string; readonly checkpoint?: string; readonly expected: readonly unknown[]; readonly runs?: string }[] = [
    { name: "fast on a model that has it", env: {}, speed: "fast", expected: ["on"], runs: "on" },
    { name: "standard where the session runs standard", env: {}, speed: "standard", expected: [], runs: "off" },
    { name: "standard where the user's settings run fast", env: { FIXTURE_FAST: "on" }, speed: "standard", expected: ["off"], runs: "off" },
    { name: "fast on a model without fast mode", env: {}, speed: "fast", model: "haiku", expected: [] },
    { name: "fast on a restored session", env: {}, speed: "fast", checkpoint: "session-fixture", expected: ["on"], runs: "on" },
  ];
  for (const item of cases) {
    const trace = join(directory, item.name.replace(/\W+/gu, "-")), driver = claude({ ...item.env, FIXTURE_TRACE: trace }, item.speed);
    try {
      await driver.initialize();
      await driver.open(process.cwd(), item.model, undefined, item.checkpoint);
      assert.deepEqual(await fastSet(trace), item.expected, item.name);
      const catalog = await driver.models();
      assert.equal(catalog.options?.find(option => option.id === "fast")?.currentValue, item.runs, item.name);
      // What the catalog offers for the model the session runs: the speed only where the model has fast mode.
      assert.deepEqual(nativeLevels(claudeFlavor, catalog.options ?? []).speed.map(entry => entry.level), item.model === "haiku" ? [] : ["standard", "fast"], item.name);
    } finally { await driver.close(); }
  }
});
