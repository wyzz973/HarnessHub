import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { CommandClass, ControlLaunch, ControlOptions, HarnessControl } from "../../src/contracts/control.js";
import { CONTEXT_EFFECTS, type EndpointLayer, type RelayCapabilities, type VendorKey, type VendorObservation } from "../../src/contracts/relay.js";
import type { HarnessSelection, PreparedSessionBinding, SelectionRequest, SessionBindingFactory, SessionConfiguration, SessionEvent } from "../../src/contracts/session.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { ClaudeControl, claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { CodexControl, codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { relayCapabilities } from "../../src/adapters/control/factory.js";
import { HermesControl, hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import type { HermesGatewayPreflight } from "../../src/adapters/control/hermes-gateway.js";
import { OpenClawControl, openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { OpenCodeControl, openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { nativeReading, relayEntries, type RelayCatalog } from "../../src/adapters/control/relay-classify.js";
import { dshModelKey, hermesModelKey, slashModelKey } from "../../src/adapters/control/relay-vendor.js";

// G069-D01, G069-D02: the declaration check (ADR-055 §8.1, INV-16): the six Drivers' static relay declarations, cell by cell, against the
// §8.1 table written out below as data. Plain cells are compared whole; the command and vendor cells, which are
// functions, are compared on the inputs their §8.1 text names. Changing any one cell of a declaration fails this test.
// `inferred` lists the cells §8.1 does not write as a value of the declaration's type: the value here is the most
// conservative one or the one the current code reads, and is kept for the probes (ADR-055 implementation notes, G069).

type Harness = "claude" | "codex" | "opencode" | "dsh" | "hermes" | "openclaw";
type Plain = Omit<RelayCapabilities, "commands" | "resolveVendor" | "normalizeModel" | "placement"> & { readonly commands: { readonly unlistedSlash: RelayCapabilities["commands"]["unlistedSlash"]; readonly hidden: readonly (readonly [string, string])[] };
  /** The placement's plain cells; its `measure` (a function, G072's C3) is checked by its own test below. */
  readonly placement: Omit<RelayCapabilities["placement"], "measure"> };
interface Cells {
  readonly plain: Plain;
  readonly normalizeModel: (model: string | null) => string;
  /** §8.1's command cell: an input, the catalog it is read with, and the reading (kind, name, effect, args, "relay" for acceptsRelay). */
  readonly classify: readonly (readonly [string, RelayCatalog | null, readonly (string | boolean)[]])[];
  /** §8.1's vendor cell: model, authentication kind, endpoint (host, layer, loopback) and the key. */
  readonly vendor: readonly (readonly [string | null, string | null, readonly [string, EndpointLayer, boolean] | null, VendorKey])[];
  readonly inferred: readonly string[];
}
const unprobed = { probed: false, fixedPrefix: null, hostPathRead: "none", sessionTools: null } as const;
const listed = (...names: readonly [string, "keep" | "none" | "compact" | "clear" | "rewind" | "unknown", boolean?][]): RelayCatalog => names.map(([name, effect, relay]) => ({ name, effect, ...(relay ? { acceptsRelay: true } : {}) }));
const ENDPOINT = ["api.deepseek.com", "user_config", false] as const;
/** The cells §8.1 writes for no Harness: inferred for all six. */
const COMMON = ["fixedPrefix", "hostPathRead", "sessionTools", "window"] as const;

/**
 * ADR-055 §8.1, row by row (relay-architecture.md, the table "七家逐家的组合与回退"; WorkBuddy is not connected).
 * `placement.pointersAfterUser` is true for all six: what each Driver's placement does (attachments, as blocks, items or Hub's
 * pointers, follow the user's words; the approval agent's B8 on db39cbd), §8.1 writing it only for Hermes; still to be probed.
 */
const TABLE: Readonly<Record<Harness, Cells>> = {
  claude: {
    plain: { ...unprobed, delivery: { live: "none", verify: "after_turn", successProvesRecorded: true, lateDelivery: false }, execution: "process",
      // unlistedSlash: §8.1 writes "executed"; the 2026-11-10 probe (relay-conformance.md F3) called the model with an unlisted word,
      // so it is "text" (G074-F3); the four the CLI does run unlisted are the hidden ones.
      commands: { unlistedSlash: "text", hidden: [["clear", "clear"], ["reset", "clear"], ["new", "clear"], ["remote-control", "none"]] },
      // title: §8.1 writes "set" (`_session/rename`); claude-agent-acp 0.99.1 routes it only for a JetBrains AIR client (G069 phase two).
      placement: { parts: "multiple", maxInput: null, pointersAfterUser: true }, window: "session_report", cacheTtl: "auth_dependent", compactionEvidence: "event", title: "none" },
    normalizeModel: slashModelKey,
    // G074-F1: the slash as the first character; the CLI strips nothing, so a space or U+3000 before it makes the input words.
    classify: [["/clear", null, ["command", "clear", "clear", ""]], ["  /clear", null, ["content"]], ["　/clear", null, ["content"]], ["/reset", null, ["command", "reset", "clear", ""]], ["/remote-control", null, ["command", "remote-control", "none", ""]],
      ["/Users/me/notes.md", null, ["content"]], ["/my-skill", listed(["compact", "compact"]), ["content"]], ["/my-skill", null, ["possible_command", "my-skill"]], ["/compact", listed(["compact", "compact"]), ["command", "compact", "compact", ""]],
      ["/review", listed(["review", "keep"]), ["command", "review", "keep", ""]]],
    vendor: [["claude-opus-5-5", "api_key", ENDPOINT, "gateway:api.deepseek.com"], [null, "bedrock", null, "aws-bedrock"], [null, "vertex", null, "google-vertex"],
      [null, "account", null, "anthropic"], [null, "api_key", null, "anthropic"], [null, "bedrock", ENDPOINT, "unknown:claude"]],
    inferred: [...COMMON, "delivery.lateDelivery", "placement.maxInput", "placement.pointersAfterUser", "title", "vendor.loopback", "vendor.signin", "vendor.backendWithEndpoint"],
  },
  codex: {
    plain: { ...unprobed, delivery: { live: "recorded_event", verify: "after_turn", successProvesRecorded: false, lateDelivery: false }, execution: "process",
      commands: { unlistedSlash: "text", hidden: [] }, placement: { parts: "single", maxInput: { unit: "chars", limit: 1_048_576 }, pointersAfterUser: true },
      window: "turn_report", cacheTtl: "30m", compactionEvidence: "event", title: "set" },
    normalizeModel: slashModelKey,
    classify: [["/compact", null, ["command", "compact", "compact", ""]], ["/export", null, ["command", "export", "none", ""]], [" /compact", null, ["content"]],
      ["/skill:review it", listed(["skill:review", "keep"]), ["command", "skill:review", "keep", "it", "relay"]], ["/review", listed(["skill:review", "keep"]), ["content"]]],
    vendor: [["openai/gpt-5.5", "chatgpt", ENDPOINT, "gateway:api.deepseek.com"], ["openai/gpt-5.5", "chatgpt", null, "openai"], ["azure/gpt-5.5", null, null, "gateway:azure"],
      ["ollama/gpt-oss:20b", null, ["localhost", "user_config", true], "provider:ollama"], ["corp/gpt-5.5", null, null, "provider:corp"], ["corp/gpt-5.5", null, ENDPOINT, "provider:corp"],
      ["azure/gpt-5.5", null, ENDPOINT, "gateway:azure"]],
    inferred: [...COMMON, "delivery.lateDelivery", "placement.pointersAfterUser", "commands.unlistedSlash", "vendor.provider", "vendor.loopback", "vendor.endpointProvider"],
  },
  opencode: {
    plain: { ...unprobed, delivery: { live: "none", verify: "none", successProvesRecorded: true, lateDelivery: true }, execution: "process",
      commands: { unlistedSlash: "text", hidden: [] }, placement: { parts: "multiple", maxInput: null, pointersAfterUser: true },
      window: "session_report", cacheTtl: "unknown", compactionEvidence: "event", title: "none" },
    normalizeModel: slashModelKey,
    classify: [["/compact", null, ["command", "compact", "compact", ""]], ["/review now", listed(["review", "unknown"]), ["command", "review", "keep", "now"]], ["/nope", listed(["review", "keep"]), ["content"]]],
    vendor: [["anthropic/claude-sonnet-4-5", null, ENDPOINT, "gateway:api.deepseek.com"], ["anthropic/claude-sonnet-4-5", null, null, "anthropic"], ["openai/gpt-5.5", null, null, "openai"],
      ["deepseek/deepseek-chat", null, null, "deepseek"], ["google/gemini-3-pro", null, null, "google"], ["opencode/grok-code", null, null, "provider:opencode-zen"],
      ["openrouter/anthropic/claude-sonnet-4-5", null, null, "router:openrouter"], ["ollama/qwen3:8b", null, ["127.0.0.1", "workspace_file", true], "local"], ["lmstudio/qwen3-coder", null, ["localhost", "user_config", true], "local"]],
    inferred: [...COMMON, "delivery.successProvesRecorded", "commands.unlistedSlash", "placement.maxInput", "placement.pointersAfterUser", "cacheTtl", "title", "vendor.loopback", "vendor.otherProvider"],
  },
  dsh: {
    plain: { ...unprobed, delivery: { live: "agent_output", verify: "none", successProvesRecorded: false, lateDelivery: false }, execution: "process",
      commands: { unlistedSlash: "text", hidden: [] }, placement: { parts: "multiple", maxInput: null, pointersAfterUser: true },
      window: "session_report", cacheTtl: "hours", compactionEvidence: "none", title: "none" },
    // normalizeModel: dsh reports its model as a JSON array text of the provider and the model; the key is the last item (G074-F8).
    normalizeModel: dshModelKey,
    classify: [["/clear", null, ["content"]], ["/compact", listed(["compact", "compact"]), ["content"]], ["　/clear", null, ["content"]]],
    vendor: [["deepseek-v4-flash", null, ["g069-relay.example", "workspace_file", false], "gateway:g069-relay.example"], ["deepseek-v4-flash", null, null, "deepseek"],
      ['["deepseek-official","deepseek-v4-flash"]', null, null, "deepseek"]],
    inferred: [...COMMON, "delivery.lateDelivery", "placement.maxInput", "placement.pointersAfterUser", "title", "vendor.loopback", "vendor.layers"],
  },
  hermes: {
    plain: { ...unprobed, delivery: { live: "none", verify: "on_next_open", successProvesRecorded: true, lateDelivery: false }, execution: "gateway",
      commands: { unlistedSlash: "executed", hidden: [["new", "clear"], ["clear", "clear"]] }, placement: { parts: "multiple", maxInput: null, pointersAfterUser: true },
      // title: §8.1 writes "set" (D3, `/title`); not used before a probe and its two preconditions (B10, G072).
      window: "session_report", cacheTtl: "unknown", compactionEvidence: "replay_marker", title: "none" },
    normalizeModel: hermesModelKey,
    classify: [["　/clear", null, ["command", "clear", "clear", ""]], ["/new", null, ["command", "new", "clear", ""]], ["/reset", null, ["command", "new", "clear", ""]],
      ["/compress", null, ["command", "compress", "compact", ""]], ["/compress --preview", null, ["command", "compress", "none", "--preview"]], ["/undo", null, ["command", "undo", "rewind", ""]],
      ["/retry", null, ["command", "retry", "rewind", ""]], ["/queue later", null, ["command", "queue", "keep", "later", "relay"]], ["/steer left", null, ["command", "steer", "keep", "left", "relay"]],
      ["/etc/hosts", null, ["content"]]],
    vendor: [["openrouter:anthropic/claude-sonnet-4-5", null, ENDPOINT, "gateway:api.deepseek.com"], ["openrouter:anthropic/claude-sonnet-4-5", null, null, "unknown:hermes"]],
    inferred: [...COMMON, "delivery.successProvesRecorded", "delivery.lateDelivery", "commands.hidden", "placement.maxInput", "cacheTtl", "vendor.noEndpoint"],
  },
  openclaw: {
    plain: { ...unprobed, delivery: { live: "none", verify: "after_turn", successProvesRecorded: false, lateDelivery: true }, execution: "gateway",
      commands: { unlistedSlash: "text", hidden: [] }, placement: { parts: "single", maxInput: { unit: "bytes", limit: 2_097_152 }, pointersAfterUser: true },
      window: "session_report", cacheTtl: "5m", compactionEvidence: "none", title: "none" },
    normalizeModel: slashModelKey,
    classify: (() => { const bridge = listed(["new", "clear"], ["reset", "clear"], ["compact", "compact"], ["stop", "none"], ["restart", "unknown"], ["bash", "unknown"]);
      return [["/new", bridge, ["command", "new", "clear", ""]], ["/reset soft", bridge, ["command", "reset", "compact", "soft"]], ["/reset", bridge, ["command", "reset", "clear", ""]],
        ["/compact", bridge, ["command", "compact", "compact", ""]], ["/stop", bridge, ["command", "stop", "none", ""]], ["/restart", bridge, ["command", "restart", "unknown", ""]],
        ["/bash ls", bridge, ["command", "bash", "unknown", "ls"]], ["/nope", bridge, ["content"]]] as const; })(),
    vendor: [["ollama/gpt-oss:120b-cloud", null, ["127.0.0.1", "user_config", true], "gateway:127.0.0.1"], ["ollama/qwen3:8b", null, ["127.0.0.1", "user_config", true], "local"],
      ["anthropic/claude-sonnet-4-5", null, ENDPOINT, "gateway:api.deepseek.com"], ["openrouter/x", null, null, "router:openrouter"]],
    inferred: [...COMMON, "commands.unlistedSlash", "compactionEvidence", "title", "placement.pointersAfterUser", "vendor.loopback", "vendor.otherProvider"],
  },
};
const DECLARED: Readonly<Record<Harness, RelayCapabilities>> = { claude: claudeRelayCapabilities, codex: codexRelayCapabilities, opencode: openCodeRelayCapabilities,
  dsh: dshRelayCapabilities, hermes: hermesRelayCapabilities, openclaw: openClawRelayCapabilities };
const KEYS = ["probed", "delivery", "execution", "commands", "placement", "window", "fixedPrefix", "cacheTtl", "compactionEvidence", "resolveVendor", "normalizeModel", "title", "hostPathRead", "sessionTools"].sort();

function plain(declared: RelayCapabilities): Plain {
  const { commands, resolveVendor: _vendor, normalizeModel: _model, placement: { measure: _measure, ...placement }, ...rest } = declared;
  return { ...rest, placement, commands: { unlistedSlash: commands.unlistedSlash, hidden: commands.hidden.map(entry => [entry.name, typeof entry.effect === "string" ? entry.effect : "byArgs"] as const) } };
}
function row(value: CommandClass): readonly (string | boolean)[] {
  return value.kind === "command" ? [value.kind, value.name, value.effect, value.args, ...(value.acceptsRelay ? ["relay"] : [])] : value.kind === "possible_command" ? [value.kind, value.name] : [value.kind];
}

test("G069-D01 each of the six declarations equals ADR-055 §8.1 cell by cell; probed is false for every one", () => {
  for (const harness of Object.keys(TABLE) as Harness[]) {
    const declared = DECLARED[harness], cells = TABLE[harness];
    assert.deepEqual(Object.keys(declared).sort(), KEYS, harness + ": every field of RelayCapabilities, nothing else");
    assert.deepEqual(plain(declared), cells.plain, harness + ": plain cells");
    assert.equal(declared.probed, false, harness + ": not probed (P2, P3, P6, P11 have not run on the latest release)");
    assert.equal(declared.normalizeModel, cells.normalizeModel, harness + ": model key");
    for (const [text, catalog, expected] of cells.classify) assert.deepEqual(row(declared.commands.classify(text, catalog, [])), expected, harness + " classify " + JSON.stringify(text));
    for (const [model, authKind, endpoint, expected] of cells.vendor) {
      const observed: VendorObservation = { model, modelKey: declared.normalizeModel(model), authKind, endpoint: endpoint === null ? null : { host: endpoint[0], layer: endpoint[1] }, loopback: endpoint?.[2] ?? false };
      assert.equal(declared.resolveVendor(observed), expected, harness + " vendor " + JSON.stringify([model, authKind, endpoint]));
    }
    assert.equal(new Set(cells.inferred).size, cells.inferred.length, harness + ": each inferred cell once");
  }
});

test("G069-D01 the inferred cells listed here are exactly the ones ADR-055's G069 notes list, Harness by Harness", async () => {
  const adr = await readFile(new URL("../../../docs/decisions/0055-relay-and-context-scheduling.md", import.meta.url), "utf8");
  const section = adr.slice(adr.indexOf("### G069（阶段一）"));
  assert.ok(section.length < adr.length, "the G069 notes exist");
  const listed = new Map<string, readonly string[]>();
  for (const match of section.matchAll(/^\| (claude|codex|opencode|dsh|hermes|openclaw) \| (.+) \|$/gmu)) listed.set(match[1]!, [...match[2]!.matchAll(/`([^`]+)`/gu)].map(token => token[1]!).sort());
  assert.deepEqual([...listed.keys()].sort(), Object.keys(TABLE).sort(), "one row per Harness");
  for (const [harness, cells] of Object.entries(TABLE)) assert.deepEqual(listed.get(harness), [...cells.inferred].sort(), harness);
});

test("G069-D02 the declarations are frozen module constants; each Driver's connections carry the one the factory returns for its harness and protocol, and other Drivers declare none", async () => {
  const freeze = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value), path + " is frozen");
    for (const [name, item] of Object.entries(value)) freeze(item, path + "." + name);
  };
  for (const [harness, declared] of Object.entries(DECLARED)) freeze(declared, harness);
  assert.throws(() => { (openClawRelayCapabilities.delivery as { lateDelivery: boolean }).lateDelivery = false; }, TypeError);
  const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1000, maxFrameBytes: 65536, maxDiagnosticBytes: 65536, closeGraceMs: 50 };
  const acp: ControlLaunch = { protocol: "acp-v1", executable: "/nonexistent/g069-acp", args: [], env: {} }, codex: ControlLaunch = { protocol: "codex-app-server", executable: "/nonexistent/g069-codex", args: [], env: {} };
  const attached: HermesGatewayPreflight = async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] });
  const controls: readonly [string, ControlLaunch["protocol"], HarnessControl, RelayCapabilities | null][] = [
    ["claude", "acp-v1", new ClaudeControl(acp, options), claudeRelayCapabilities],
    ["codex", "codex-app-server", new CodexControl(codex, options), codexRelayCapabilities],
    ["opencode", "acp-v1", new OpenCodeControl(acp, options), openCodeRelayCapabilities],
    ["hermes", "acp-v1", new HermesControl(acp, options, attached), hermesRelayCapabilities],
    ["openclaw", "acp-v1", new OpenClawControl(acp, options, async () => { throw new Error("no Gateway"); }), openClawRelayCapabilities],
    ["dsh", "acp-v1", new AcpControl(acp, options, dshRelayCapabilities), dshRelayCapabilities],
    // The generic driver for any other Harness declares nothing; neither do Pi and Cursor.
    ["gemini", "acp-v1", new AcpControl(acp, options), null],
  ];
  try {
    for (const [harness, protocol, control, expected] of controls) {
      assert.equal(relayCapabilities(harness, protocol), expected, harness + ": the factory's static declaration");
      assert.equal(control.relayCapabilities ?? null, expected, harness + ": the connection carries the same object");
    }
  } finally { for (const [, , control] of controls) await control.close(); }
  for (const [harness, protocol] of [["pi", "pi-rpc"], ["cursor", "acp-v1"], ["workbuddy", "acp-v1"], ["claude", "pi-rpc"]] as const) assert.equal(relayCapabilities(harness, protocol), null, harness);
  // An app-server is always the Codex driver, whatever the harness; an ACP control of Codex is the generic driver.
  assert.equal(relayCapabilities("codex", "acp-v1"), null);
  assert.equal(relayCapabilities("other", "codex-app-server"), codexRelayCapabilities);
});

/** A control of `harnessId` on the G069 peer, which announces `commands` as agents do: names and descriptions, no effects. */
function onPeer(t: TestContext, root: string, harnessId: "claude" | "opencode" | "hermes" | "openclaw" | "dsh" | "gemini", commands: readonly string[]): { readonly control: HarnessControl; readonly trace: string } {
  const trace = join(root, "trace-" + harnessId + ".ndjson");
  const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), OPENCLAW_CONFIG_PATH: join(root, "openclaw.json"), RELAY_TRACE: trace,
    RELAY_COMMANDS: JSON.stringify(commands.map(name => ({ name, description: "the " + name + " command" }))) };
  const launch: ControlLaunch = { protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/relay-control-peer.mjs")], env };
  const options: ControlOptions = { cwd: root, env, requestTimeoutMs: 3000, runTimeoutMs: 6000, maxFrameBytes: 1 << 20, maxDiagnosticBytes: 1 << 14, closeGraceMs: 150 };
  const gateway = async (method: string): Promise<unknown> => method === "agents.list" ? { defaultId: "main", agents: [{ id: "main" }] } : method === "models.list" ? { models: [] }
    : method === "sessions.list" ? { sessions: [] } : method === "sessions.get" || method === "chat.history" ? { messages: [] } : Promise.reject(new Error("unexpected OpenClaw method " + method));
  const control = harnessId === "claude" ? new ClaudeControl(launch, options) : harnessId === "opencode" ? new OpenCodeControl(launch, options)
    : harnessId === "hermes" ? new HermesControl(launch, options, async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] }))
    : harnessId === "openclaw" ? new OpenClawControl(launch, options, gateway) : new AcpControl(launch, options, harnessId === "dsh" ? dshRelayCapabilities : undefined);
  t.after(() => control.close().then(() => undefined));
  return { control, trace };
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("G069-D03 a catalog served from the native catalog cache reads as the one models() returned: Claude, OpenClaw, Hermes and OpenCode, commands announced without effects, Object-member names included", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "g069-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "openclaw.json"), "{}");
  const { NativeCatalogCache } = await import("../../src/web/native-catalog-cache.js");
  const announced = ["review", "status", "compact", "model", "think", "reset", "new", "my-command", "constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];
  const prefixes = ["", " ", "　"], bodies = [...announced.flatMap(name => ["/" + name, "/" + name + " now"]), "/reset soft", "/export", "/clear", "/nope", "hello"];
  const declared: Readonly<Record<string, RelayCapabilities>> = { claude: claudeRelayCapabilities, openclaw: openClawRelayCapabilities, hermes: hermesRelayCapabilities, opencode: openCodeRelayCapabilities };
  const cacheRoot = join(root, "data"); await mkdir(cacheRoot, { mode: 0o700 });
  const options = { assertOwner: () => {}, report: (problem: string) => { throw new Error("cache problem: " + problem); }, revision: digest("g069-build") };
  let compared = 0, differences = 0;
  for (const harnessId of ["claude", "openclaw", "hermes", "opencode"] as const) {
    const { control } = onPeer(t, root, harnessId, announced);
    await control.initialize(); await control.open(root);
    const native = await control.models!();
    // Every command models() returns carries an effect of the contract's, Object-member names included (no function, no object).
    for (const command of native.commands ?? []) assert.ok(typeof command.contextEffect === "string" && (CONTEXT_EFFECTS as readonly string[]).includes(command.contextEffect), harnessId + " " + command.name);
    const key = digest(harnessId), first = new NativeCatalogCache(cacheRoot, options);
    first.putCatalog({ key, fingerprint: key, harnessId, controlId: harnessId + "-native", catalog: native }); await first.close();
    const cached = new NativeCatalogCache(cacheRoot, options).catalog(key, key);
    assert.ok(cached !== null, harnessId + ": the catalog comes back from the file");
    assert.deepEqual(cached.commands, native.commands, harnessId + ": the commands keep their effects through the file");
    for (const prefix of prefixes) for (const body of bodies) {
      const text = prefix + body, runtime = control.classify!(text, native, []);
      assert.deepEqual(nativeReading(declared[harnessId]!.commands.classify(text, relayEntries(cached.commands ?? []), [])), runtime, harnessId + " " + JSON.stringify(text));
      // The invalid sample: the same catalog without its effects (what the cache kept before), read as the relay would.
      const stripped = (cached.commands ?? []).map(({ name, description }) => ({ name, description }));
      if (JSON.stringify(nativeReading(declared[harnessId]!.commands.classify(text, relayEntries(stripped), []))) !== JSON.stringify(runtime)) differences++;
      compared++;
    }
  }
  assert.equal(compared, 4 * prefixes.length * bodies.length);
  assert.ok(differences > 0, "without the effects the relay's reading differs from the Runtime's for some input");
  // A cached command's effect is one of the contract's: another value keeps the catalog out, in memory and in the file.
  const strict = new NativeCatalogCache(cacheRoot, options), key = digest("bogus");
  strict.putCatalog({ key, fingerprint: key, harnessId: "claude", controlId: "claude-native", catalog: { models: [], defaultModel: null, authentication: "ready", canSelect: false,
    commands: [{ name: "review", description: "r", contextEffect: "bogus" as never }] } });
  assert.equal(strict.catalog(key, key), null); await strict.close();
  const file = join(cacheRoot, "native-catalogs.json"), stored = JSON.parse(await readFile(file, "utf8")) as { catalogs: { catalog: { commands?: { contextEffect?: string }[] } }[] };
  stored.catalogs[0]!.catalog.commands![0]!.contextEffect = "bogus"; await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  const problems: string[] = [];
  new NativeCatalogCache(cacheRoot, { ...options, report: problem => { problems.push(problem); } });
  assert.equal(problems.length, 1); assert.match(problems[0]!, /not a catalog cache this version can read/u);
});

test("G069-D04 dsh on the generic driver reads every input as content through the Runtime (one reading with its declaration), while another Harness on the generic driver keeps the shared reading", { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "g069-runtime-")), workspace = join(root, "workspace"); await mkdir(workspace);
  const { SessionRuntime } = await import("../../src/contexts/session/application/runtime.js");
  const { SqliteSessionStore } = await import("../../src/infrastructure/session/sqlite-store.js");
  const store = new SqliteSessionStore(join(root, "data")), traces = new Map<string, string>();
  const factory: SessionBindingFactory = {
    async validate(request: SelectionRequest): Promise<HarnessSelection> { return { harnessId: request.harnessId, controlId: request.harnessId + "-native" }; },
    async prepare(selected: HarnessSelection, configuration: SessionConfiguration): Promise<PreparedSessionBinding> {
      const { control, trace } = onPeer(t, root, selected.harnessId as "dsh" | "gemini", ["clear", "compact"]); traces.set(selected.harnessId, trace);
      return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
    },
  };
  let next = 0;
  const app = new SessionRuntime(store, factory, { id: () => String(++next), now: () => new Date("2026-11-09T00:00:00Z"), publish: () => {}, fingerprint: value => digest(value) });
  t.after(async () => { try { await app.close(); } finally { store.close(); await rm(root, { recursive: true, force: true }); } });
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const results = new Map<string, { readonly command: boolean; readonly input: unknown; readonly prompts: readonly string[] }>();
  for (const harnessId of ["dsh", "gemini"]) {
    const session = await app.create(configuration, { harnessId }, "create-" + harnessId);
    const receipt = app.send(session.id, "/clear", "send-" + harnessId, []); await app.wait(session.id);
    const events: SessionEvent[] = [];
    for (let after = 0; ;) { const page = store.events(session.id, after, 100); if (!page.length) break; events.push(...page); after = page.at(-1)!.seq; }
    const prompts = (await readFile(traces.get(harnessId)!, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method?: string; params?: { prompt?: { text?: string }[] } })
      .flatMap(line => line.method === "session/prompt" ? [line.params?.prompt?.[0]?.text ?? ""] : []);
    results.set(harnessId, { command: events.some(row => row.type === "run.native_command" && row.data.runId === receipt.runId),
      input: events.find(row => row.type === "run.ended" && row.data.runId === receipt.runId)?.data.input, prompts });
  }
  // dsh: content, sent as typed, and its answer proves it recorded (E3 for content).
  assert.deepEqual(results.get("dsh"), { command: false, input: "recorded", prompts: ["/clear"] });
  // The invalid sample: the generic driver without a declaration reads the listed /clear as a command, whose answer proves nothing.
  assert.deepEqual(results.get("gemini"), { command: true, input: "unknown", prompts: ["/clear"] });
});
