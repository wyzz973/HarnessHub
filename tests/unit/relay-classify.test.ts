import assert from "node:assert/strict";
import test from "node:test";
import type { ContentKind } from "../../src/contracts/content.js";
import { listedCommand, type CommandClass, type ContextEffect, type ControlLaunch, type ControlOptions, type HarnessControl, type NativeModelCatalog } from "../../src/contracts/control.js";
import { AcpControl, dshRelayCapabilities } from "../../src/adapters/control/acp.js";
import { ClaudeControl, claudeRelayCapabilities } from "../../src/adapters/control/claude.js";
import { CodexControl, codexRelayCapabilities } from "../../src/adapters/control/codex.js";
import { HermesControl, hermesRelayCapabilities } from "../../src/adapters/control/hermes.js";
import type { HermesGatewayPreflight } from "../../src/adapters/control/hermes-gateway.js";
import { OpenClawControl, openClawRelayCapabilities } from "../../src/adapters/control/openclaw.js";
import { OpenCodeControl, openCodeRelayCapabilities } from "../../src/adapters/control/opencode.js";
import { nativeReading, relayEntries, sharedClassify, type RelayCatalog, type RelayClassify } from "../../src/adapters/control/relay-classify.js";

// G069-C03 (ADR-055 §7.4, §8.1): each Driver's relay declaration reads an input as its native side parses it — leading
// half-width and full-width (U+3000) whitespace, names and aliases, paths, `unlistedSlash=text` — and every rule here has
// an input that it must not read that way. The same reading is the Driver's HarnessControl.classify (one source,
// relay-classify.ts). Nothing here starts a program: a control's classify reads its arguments only.

const options: ControlOptions = { cwd: process.cwd(), env: {}, requestTimeoutMs: 1000, runTimeoutMs: 1000, maxFrameBytes: 65536, maxDiagnosticBytes: 65536, closeGraceMs: 50 };
const acp: ControlLaunch = { protocol: "acp-v1", executable: "/nonexistent/g069-acp", args: [], env: {} };
const codexLaunch: ControlLaunch = { protocol: "codex-app-server", executable: "/nonexistent/g069-codex", args: [], env: {} };
const attached: HermesGatewayPreflight = async () => ({ kind: "attach", verdict: "A", explanation: "fixture gateway", evidence: [] });

type Reading = readonly (string | boolean)[];
/** A reading as a short row: kind, name, effect, args and, when the declaration says so, "relay". */
function row(value: CommandClass): Reading {
  return value.kind === "command" ? [value.kind, value.name, value.effect, value.args, ...(value.acceptsRelay ? ["relay"] : [])] : value.kind === "possible_command" ? [value.kind, value.name] : [value.kind];
}
const entries = (...commands: readonly [string, ContextEffect, boolean?][]): RelayCatalog => commands.map(([name, effect, relay]) => ({ name, effect, ...(relay ? { acceptsRelay: true } : {}) }));
interface Rule { readonly rule: string; readonly read: readonly [string, RelayCatalog | null, readonly ContentKind[], Reading][]; readonly not: readonly [string, RelayCatalog | null, readonly ContentKind[], Reading] }
function check(classify: RelayClassify, rules: readonly Rule[]): void {
  for (const { rule, read, not } of rules) {
    for (const [text, catalog, attachments, expected] of read) assert.deepEqual(row(classify(text, catalog, attachments)), expected, rule + ": " + JSON.stringify(text));
    // The invalid sample: an input the rule must not read the way it reads the samples above.
    const [text, catalog, attachments, expected] = not;
    assert.deepEqual(row(classify(text, catalog, attachments)), expected, rule + " (invalid sample): " + JSON.stringify(text));
    assert.notDeepEqual(row(classify(text, catalog, attachments)), read[0]![3], rule + " (invalid sample reads differently): " + JSON.stringify(text));
  }
}

test("G069-C03 Hermes: lstrip() of Python whitespace (half-width, U+3000, U+00A0) before the registry's names and aliases; BOM, zero-width space, paths and images are text", () => {
  const classify = hermesRelayCapabilities.commands.classify, announced = entries(["skill-from-gateway", "keep"]);
  check(classify, [
    { rule: "leading Python whitespace is stripped", read: [[" /clear", null, [], ["command", "clear", "clear", ""]], ["　/clear", null, [], ["command", "clear", "clear", ""]],
      [" /clear", null, [], ["command", "clear", "clear", ""]], ["\t  /undo　2 ", null, [], ["command", "undo", "rewind", "2"]]],
      not: ["﻿/clear", null, [], ["content"]] },
    { rule: "U+200B is no Python whitespace either", read: [[" /clear", null, [], ["command", "clear", "clear", ""]]], not: ["​/clear", null, [], ["content"]] },
    { rule: "registry names and aliases in any case", read: [["/CLEAR", null, [], ["command", "clear", "clear", ""]], ["/reset", null, [], ["command", "new", "clear", ""]],
      ["/compact", null, [], ["command", "compress", "compact", ""]], ["/fork", null, [], ["command", "branch", "none", ""]], ["/V", null, [], ["command", "version", "none", ""]]],
      not: ["/rewind-2 now", announced, [], ["content"]] },
    { rule: "effects by arguments", read: [["/compress --preview", null, [], ["command", "compress", "none", "--preview"]], ["/compress keep --DRY-RUN", null, [], ["command", "compress", "none", "keep --DRY-RUN"]]],
      not: ["/compress focus on tests", null, [], ["command", "compress", "compact", "focus on tests"]] },
    { rule: "queue and steer submit their text (acceptsRelay)", read: [["/queue later", null, [], ["command", "queue", "keep", "later", "relay"]], ["/q later", null, [], ["command", "queue", "keep", "later", "relay"]],
      ["/s left", null, [], ["command", "steer", "keep", "left", "relay"]]], not: ["/undo 2", null, [], ["command", "undo", "rewind", "2"]] },
    { rule: "a path is text", read: [["/etc/hosts 这一行是什么意思", null, [], ["content"]], ["/tmp/x", null, [], ["content"]], ["/ clear", null, [], ["content"]], ["/", null, [], ["content"]]],
      not: ["/etc", null, [], ["possible_command", "etc"]] },
    { rule: "a word outside the registry is a command only when announced", read: [["/skill-from-gateway now", announced, [], ["command", "skill-from-gateway", "keep", "now"]],
      ["/skill-from-gateway", null, [], ["possible_command", "skill-from-gateway"]]], not: ["/thanks for that", announced, [], ["content"]] },
    { rule: "with an image the viewer runs no command", read: [["/clear", null, ["image"], ["content"]], ["/clear", null, ["file", "image"], ["content"]]],
      not: ["/clear", null, ["file"], ["command", "clear", "clear", ""]] },
  ]);
});

test("G069-C03 Claude Code: leading whitespace stripped, any command name runs listed or not (unlistedSlash executed), hidden /clear aliases; a slash path is content", () => {
  const classify = claudeRelayCapabilities.commands.classify, catalog = entries(["compact", "compact"], ["export", "none"], ["review", "keep"]);
  check(classify, [
    { rule: "leading whitespace, half-width and full-width", read: [["  /clear", null, [], ["command", "clear", "clear", ""]], ["　/clear", null, [], ["command", "clear", "clear", ""]],
      ["\n/reset", null, [], ["command", "reset", "clear", ""]]], not: ["​/clear", null, [], ["content"]] },
    { rule: "hidden commands", read: [["/new", null, [], ["command", "new", "clear", ""]], ["/remote-control now", catalog, [], ["command", "remote-control", "none", "now"]]],
      not: ["/newer", null, [], ["possible_command", "newer"]] },
    { rule: "a path is content", read: [["/Users/me/notes.md 看看这个", null, [], ["content"]], ["/etc/hosts", catalog, [], ["content"]]], not: ["/Users", null, [], ["possible_command", "Users"]] },
    { rule: "unlisted names run (unknown effect); listed ones have theirs", read: [["/my-command", catalog, [], ["command", "my-command", "unknown", ""]],
      ["/compact keep the plan", catalog, [], ["command", "compact", "compact", "keep the plan"]]], not: ["/review now", catalog, [], ["command", "review", "keep", "now"]] },
    { rule: "the Hub's /export only without attachments", read: [["/export", catalog, ["file"], ["command", "export", "unknown", ""]]], not: ["/export", catalog, [], ["command", "export", "none", ""]] },
  ]);
});

test("G069-C03 Codex: exactly /export, /compact and a listed /skill: (which takes relay content); no lstrip, every other slash input is text (unlistedSlash text)", () => {
  const classify = codexRelayCapabilities.commands.classify, catalog = entries(["compact", "compact"], ["export", "none"], ["skill:review", "keep"]);
  check(classify, [
    { rule: "the thread operations, exactly", read: [["/compact", null, [], ["command", "compact", "compact", ""]], ["/export  ", null, [], ["command", "export", "none", ""]]],
      not: [" /compact", null, [], ["content"]] },
    { rule: "no full-width lstrip either", read: [["/compact", catalog, [], ["command", "compact", "compact", ""]]], not: ["　/compact", catalog, [], ["content"]] },
    { rule: "with attachments the operations are text", read: [["/compact", null, ["file"], ["content"]], ["/export", null, ["image"], ["content"]]], not: ["/compact", null, [], ["command", "compact", "compact", ""]] },
    { rule: "a listed skill submits its text", read: [["/skill:review the diff", catalog, [], ["command", "skill:review", "keep", "the diff", "relay"]], ["/skill:review it", catalog, ["image"], ["command", "skill:review", "keep", "it", "relay"]]],
      not: ["/skill:other", catalog, [], ["content"]] },
    { rule: "an unlisted slash word is text", read: [["/review", catalog, [], ["content"]], ["/compact now", catalog, [], ["content"]]], not: ["/skill:review", null, [], ["possible_command", "skill:review"]] },
  ]);
});

test("G069-C03 OpenCode: trimmed, /compact and listed commands (keep for an unknown effect); any other slash input is text (unlistedSlash text)", () => {
  const classify = openCodeRelayCapabilities.commands.classify, catalog = entries(["review", "unknown"], ["init", "none"]);
  check(classify, [
    { rule: "trimmed, half-width and full-width", read: [["  /compact  ", null, [], ["command", "compact", "compact", ""]], ["　/compact", null, [], ["command", "compact", "compact", ""]]],
      not: ["/ compact", null, [], ["content"]] },
    { rule: "a listed command; unknown effect keeps", read: [["/review now", catalog, [], ["command", "review", "keep", "now"]], ["\t/init  x ", catalog, [], ["command", "init", "none", "x"]]],
      not: ["/nope", catalog, [], ["content"]] },
    { rule: "with or without attachments", read: [["/compact", null, ["image", "file"], ["command", "compact", "compact", ""]]], not: ["compact", null, [], ["content"]] },
  ]);
});

test("G069-C03 OpenClaw: the bridge's listed commands with effects by arguments; unlisted, indented or path inputs are prompts (unlistedSlash text)", () => {
  const classify = openClawRelayCapabilities.commands.classify, bridge = entries(["new", "clear"], ["reset", "clear"], ["think", "none"], ["status", "unknown"]);
  check(classify, [
    { rule: "listed commands, effects by arguments", read: [["/reset soft", bridge, [], ["command", "reset", "compact", "soft"]], ["/new", bridge, [], ["command", "new", "clear", ""]],
      ["/think high", bridge, [], ["command", "think", "none", "high"]]], not: ["/reset", bridge, [], ["command", "reset", "clear", ""]] },
    { rule: "unlisted is a prompt", read: [["/nope", bridge, [], ["content"]], ["/Users/me/a.md", bridge, [], ["content"]]], not: ["/nope", null, [], ["possible_command", "nope"]] },
    { rule: "no leading-whitespace strip", read: [["/new", bridge, [], ["command", "new", "clear", ""]]], not: [" /new", bridge, [], ["content"]] },
  ]);
});

test("G069-C03 DeepSeek Harness: unlistedSlash=text and no commands, so every input is content, whatever a catalog lists", () => {
  const classify = dshRelayCapabilities.commands.classify, listing = entries(["clear", "clear"], ["compact", "compact"]);
  assert.equal(dshRelayCapabilities.commands.unlistedSlash, "text");
  for (const text of ["/clear", "　/clear", " /compact", "/compact", "/skill:x", "/Users/me", "hello", ""]) for (const catalog of [null, [], listing] as const)
    assert.deepEqual(classify(text, catalog, []), { kind: "content" }, JSON.stringify(text));
  // The invalid sample: the shared reading, which dsh does not have, reads a listed slash word as a command.
  assert.deepEqual(row(sharedClassify("/clear", listing, [])), ["command", "clear", "clear", ""]);
});

test("G069-C03 a relay catalog's effect may depend on the arguments, and a listed command may take relay content; the native reading leaves acceptsRelay out", () => {
  const byArgs = [{ name: "reset", effect: { byArgs: (args: string) => (args.split(/\s+/u)[0] === "soft" ? "compact" : "clear") as ContextEffect } }, { name: "ask", effect: "keep" as const, acceptsRelay: true }];
  assert.deepEqual(row(sharedClassify("/reset soft", byArgs, [])), ["command", "reset", "compact", "soft"]);
  assert.deepEqual(row(sharedClassify("/reset", byArgs, [])), ["command", "reset", "clear", ""]);
  assert.deepEqual(row(sharedClassify("/ask now", byArgs, [])), ["command", "ask", "keep", "now", "relay"]);
  assert.deepEqual(nativeReading(sharedClassify("/ask now", byArgs, [])), { kind: "command", name: "ask", args: "now", effect: "keep" });
  // Invalid sample: without acceptsRelay a command keeps no such mark.
  assert.deepEqual(row(sharedClassify("/reset", byArgs, [])).includes("relay"), false);
});

test("G069-C03 one source: each Driver's HarnessControl.classify equals its relay declaration's reading over the same commands, acceptsRelay aside", async () => {
  // The declaration reads Claude Code's catalog as if the Hub offered its own `/export` (models() decides that per
  // connection); a connection whose Claude lists an export of its own reads `/export` with attachments by its entry.
  const offering = new ClaudeControl(acp, options), own = new ClaudeControl(acp, options);
  (offering as unknown as { hubExport: boolean }).hubExport = true;
  const exported: NativeModelCatalog = { models: [], defaultModel: null, authentication: "ready", canSelect: false, commands: [{ name: "export", description: "export", contextEffect: "none" }] };
  assert.deepEqual(offering.classify("/export", exported, ["file"]), { kind: "command", name: "export", args: "", effect: "unknown" });
  assert.deepEqual(own.classify("/export", exported, ["file"]), { kind: "command", name: "export", args: "", effect: "none" });
  await own.close();
  const drivers: readonly [string, HarnessControl, RelayClassify][] = [
    ["claude", offering, claudeRelayCapabilities.commands.classify],
    ["codex", new CodexControl(codexLaunch, options), codexRelayCapabilities.commands.classify],
    ["opencode", new OpenCodeControl(acp, options), openCodeRelayCapabilities.commands.classify],
    ["hermes", new HermesControl(acp, options, attached), hermesRelayCapabilities.commands.classify],
    ["openclaw", new OpenClawControl(acp, options, async () => { throw new Error("no Gateway"); }), openClawRelayCapabilities.commands.classify],
  ];
  const listing = (...commands: readonly [string, ContextEffect][]): NativeModelCatalog => ({ models: [], defaultModel: null, authentication: "ready", canSelect: false, commands: commands.map(([name, contextEffect]) => ({ name, description: name, contextEffect })) });
  // Catalogs whose commands declare their effects, as every Driver's models() hands them on, and none at all.
  const catalogs: readonly (NativeModelCatalog | null)[] = [null, listing(), listing(["compact", "compact"], ["review", "keep"], ["export", "none"], ["skill:review", "keep"], ["reset", "clear"], ["new", "clear"], ["think", "none"], ["my-command", "unknown"], ["skill-from-gateway", "keep"])];
  const prefixes = ["", " ", "　", " ", "﻿", "\t"], bodies = ["/clear", "/compact", "/compact keep", "/compress --preview", "/export", "/skill:review it", "/reset soft", "/reset", "/new", "/think high",
    "/remote-control x", "/Users/me/a.md", "/etc/hosts", "/", "/ x", "/q later", "/steer y", "/undo 2", "/thanks", "/review now", "/my-command", "/skill-from-gateway go", "hello", ""];
  let compared = 0;
  try {
    for (const [name, control, declared] of drivers) for (const catalog of catalogs) for (const attachments of [[], ["file"], ["image"]] as const) for (const prefix of prefixes) for (const body of bodies) {
      const text = prefix + body, relay = catalog === null ? null : relayEntries(catalog.commands ?? []);
      assert.deepEqual(control.classify!(text, catalog, attachments), nativeReading(declared(text, relay, attachments)), name + " " + JSON.stringify(text) + " " + attachments.join(","));
      compared++;
    }
    // dsh runs on the generic driver, which reads with the declaration the factory hands it (always content), with or
    // without a catalog and whatever the catalog lists; the generic driver without one keeps the shared reading.
    const dsh = new AcpControl(acp, options, dshRelayCapabilities), generic = new AcpControl(acp, options);
    for (const catalog of catalogs) for (const attachments of [[], ["file"], ["image"]] as const) for (const prefix of prefixes) for (const body of bodies) {
      const text = prefix + body;
      assert.deepEqual(dsh.classify(text, catalog, attachments), nativeReading(dshRelayCapabilities.commands.classify(text, catalog === null ? null : relayEntries(catalog.commands ?? []), attachments)), "dsh " + JSON.stringify(text));
      assert.deepEqual(dsh.classify(text, catalog, attachments), { kind: "content" });
      assert.deepEqual(generic.classify(text, catalog, attachments), listedCommand(text, catalog), "generic " + JSON.stringify(text));
      compared++;
    }
    // The invalid samples: the shared reading of a listed /clear and of /x without a catalog, which dsh no longer has.
    assert.deepEqual(generic.classify("/clear", listing(["clear", "clear"])), { kind: "command", name: "clear", args: "", effect: "clear" });
    assert.deepEqual(generic.classify("/x", null), { kind: "possible_command", name: "x" });
    assert.deepEqual(dsh.classify("/clear", listing(["clear", "clear"])), { kind: "content" }); assert.deepEqual(dsh.classify("/x", null), { kind: "content" });
    await dsh.close(); await generic.close();
  } finally { for (const [, control] of drivers) await control.close(); }
  assert.equal(compared, 6 * 3 * 3 * prefixes.length * bodies.length);
});

test("G069-C03 a command named after an Object member (constructor, toString, valueOf, hasOwnProperty, __proto__) gets a declared effect, never a function or an object", async () => {
  const members = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];
  const undeclared: NativeModelCatalog = { models: [], defaultModel: null, authentication: "ready", canSelect: false, commands: [...members, "status"].map(name => ({ name, description: name })) };
  const claude = new ClaudeControl(acp, options), openclaw = new OpenClawControl(acp, options, async () => { throw new Error("no Gateway"); });
  try {
    for (const name of members) {
      // Claude Code: a listed command without a declared effect enters the context like a message (keep).
      assert.deepEqual(claude.classify("/" + name, undeclared), { kind: "command", name, args: "", effect: "keep" }, "claude " + name);
      assert.deepEqual(row(claudeRelayCapabilities.commands.classify("/" + name, [{ name, effect: "keep" }], [])), ["command", name, "keep", ""]);
      // OpenClaw: not one of its own commands, so the catalog's (unknown when it declares none).
      assert.deepEqual(openclaw.classify("/" + name, undeclared), { kind: "command", name, args: "", effect: "unknown" }, "openclaw " + name);
    }
    // The invalid samples: the names that are entries of the tables keep their entries' effects.
    assert.deepEqual(claude.classify("/status", undeclared), { kind: "command", name: "status", args: "", effect: "none" });
    assert.deepEqual(row(openClawRelayCapabilities.commands.classify("/reset soft", [{ name: "reset", effect: "unknown" }], [])), ["command", "reset", "compact", "soft"]);
  } finally { await claude.close(); await openclaw.close(); }
});

// The default the relay catalog gives a command that declares no effect: its effect is unknown, never one a reader would
// guess. The Drivers' models() fill the effects in before a catalog reaches the cache, so this default is not reachable
// through them today; the assertion keeps it what the ADR says it is (G069 review, second round).
test("G069-C03 a command that declares no effect is an unknown one in the relay catalog", () => {
  assert.deepEqual(relayEntries([{ name: "plain", description: "no effect declared" }, { name: "wipe", description: "declares one", contextEffect: "clear" }]),
    [{ name: "plain", effect: "unknown" }, { name: "wipe", effect: "clear" }]);
  assert.deepEqual(relayEntries([]), []);
});
