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
    // Without text they only answer their usage: nothing is submitted, so no packet can go (G069 fix batch, B4b).
    { rule: "a bare queue or steer submits nothing", read: [["/queue", null, [], ["command", "queue", "keep", ""]], ["/steer　", null, [], ["command", "steer", "keep", ""]]],
      not: ["/queue x", null, [], ["command", "queue", "keep", "x", "relay"]] },
    { rule: "a path is text", read: [["/etc/hosts 这一行是什么意思", null, [], ["content"]], ["/tmp/x", null, [], ["content"]], ["/ clear", null, [], ["content"]], ["/", null, [], ["content"]]],
      not: ["/etc", null, [], ["possible_command", "etc"]] },
    { rule: "a word outside the registry is a command only when announced", read: [["/skill-from-gateway now", announced, [], ["command", "skill-from-gateway", "keep", "now"]],
      ["/skill-from-gateway", null, [], ["possible_command", "skill-from-gateway"]]], not: ["/thanks for that", announced, [], ["content"]] },
    { rule: "with an image the viewer runs no command", read: [["/clear", null, ["image"], ["content"]], ["/clear", null, ["file", "image"], ["content"]]],
      not: ["/clear", null, ["file"], ["command", "clear", "clear", ""]] },
  ]);
});

test("G069-C03 Claude Code: a command only with the slash as the first character (the CLI strips nothing), a word outside the catalog is words (unlistedSlash text) except the hidden /clear aliases; a slash path is content", () => {
  const classify = claudeRelayCapabilities.commands.classify, catalog = entries(["compact", "compact"], ["export", "none"], ["review", "keep"]);
  check(classify, [
    // G074-F1 (probe record 2026-11-10, Claude Code 2.1.316 behind claude-agent-acp 0.99.1): the CLI ran no command for " /context"
    // or "　/context" but called the model with the text, so nothing before the slash is stripped. The driver abandons the native
    // session for a /clear it reads, so a misread would lose the user's context.
    { rule: "leading whitespace makes the whole input words: half-width, full-width, tab, line break", read: [[" /clear", null, [], ["content"]], ["  /clear", null, [], ["content"]], ["　/clear", null, [], ["content"]],
      ["\t/clear", null, [], ["content"]], ["\n/reset", null, [], ["content"]], ["\r\n/new", null, [], ["content"]], [" /compact", catalog, [], ["content"]], ["　/remote-control", null, [], ["content"]]],
      not: ["/clear", null, [], ["command", "clear", "clear", ""]] },
    // The four whitespace kinds the brief names (and two mixes) against /clear, /reset, /new and /compact: all words, none a command.
    { rule: "every whitespace kind before every clear alias and /compact is words", read: [" ", "  ", "　", "\t", "\n", "\r\n", " \t　", "\u00a0"].flatMap(space => ["/clear", "/reset", "/new", "/compact"]
      .map((word): [string, RelayCatalog, readonly ContentKind[], Reading] => [space + word, catalog, [], ["content"]])), not: ["/compact", catalog, [], ["command", "compact", "compact", ""]] },
    // A zero-width space or a byte-order mark is no slash either (the old trimStart() stripped the mark, and ran the clear).
    { rule: "a zero-width space or a byte-order mark first is words", read: [["\u200b/clear", null, [], ["content"]], ["\ufeff/clear", null, [], ["content"]]], not: ["/clear", null, [], ["command", "clear", "clear", ""]] },
    { rule: "with the slash first, trailing whitespace and arguments belong to the command", read: [["/clear", null, [], ["command", "clear", "clear", ""]], ["/clear   ", null, [], ["command", "clear", "clear", ""]],
      ["/clear foo", null, [], ["command", "clear", "clear", "foo"]], ["/reset\n", null, [], ["command", "reset", "clear", ""]], ["/new\tnow ", null, [], ["command", "new", "clear", "now"]]],
      not: [" /clear foo", null, [], ["content"]] },
    { rule: "hidden commands", read: [["/new", null, [], ["command", "new", "clear", ""]], ["/remote-control now", catalog, [], ["command", "remote-control", "none", "now"]]],
      not: ["/newer", null, [], ["possible_command", "newer"]] },
    { rule: "a path is content", read: [["/Users/me/notes.md 看看这个", null, [], ["content"]], ["/etc/hosts", catalog, [], ["content"]]], not: ["/Users", null, [], ["possible_command", "Users"]] },
    // G074-F3 (probe record 2026-11-10): "/zzprobe-unlisted hello" called the model, so a word the catalog does not list is words
    // (unlistedSlash text); the commands the CLI runs although the adapter lists none are the hidden ones above. Without a
    // catalog a slash word may still be a command the catalog lists (possible_command), so it carries no packet yet (B9).
    { rule: "a word outside the catalog is words; a listed one has its effect", read: [["/my-command", catalog, [], ["content"]], ["/zzprobe-unlisted hello", catalog, [], ["content"]],
      ["/compact keep the plan", catalog, [], ["command", "compact", "compact", "keep the plan"]]], not: ["/review now", catalog, [], ["command", "review", "keep", "now"]] },
    { rule: "without a catalog a slash word is a possible command, a hidden one is a command", read: [["/my-command", null, [], ["possible_command", "my-command"]], ["/clear", null, [], ["command", "clear", "clear", ""]]],
      not: ["/my-command", catalog, [], ["content"]] },
    // The CLI looks for a command only in the last block, an attachment's when there is one (G069 fix batch, review I6).
    { rule: "with an image or a file every input is content", read: [["/export", catalog, ["file"], ["content"]], ["/clear", null, ["image"], ["content"]], ["/remote-control", catalog, ["file", "image"], ["content"]],
      ["/clear", null, ["audio", "file"], ["content"]], ["/clear", null, ["image", "audio"], ["content"]]],
      not: ["/export", catalog, [], ["command", "export", "none", ""]] },
    // claude-agent-acp drops audio blocks (0.99.1 promptToClaude, acp-agent.js:10384-10386), so the words are the last block
    // again (G069 second review, minor 2).
    { rule: "audio alone leaves the input as it reads without attachments", read: [["/clear", null, ["audio"], ["command", "clear", "clear", ""]], ["/export", catalog, ["audio", "audio"], ["command", "export", "none", ""]],
      ["/review", null, ["audio"], ["possible_command", "review"]]], not: ["/clear", null, ["audio", "image"], ["content"]] },
  ]);
  // The declaration says what the reading does: a word outside the catalog is text, and the four the CLI runs unlisted are hidden.
  assert.equal(claudeRelayCapabilities.commands.unlistedSlash, "text");
  assert.deepEqual(claudeRelayCapabilities.commands.hidden.map(entry => [entry.name, entry.effect]), [["clear", "clear"], ["reset", "clear"], ["new", "clear"], ["remote-control", "none"]]);
});

test("G069-C03 Codex: exactly /export, /compact, the Hub's clear alone and a listed /skill: (which takes relay content); no lstrip, every other slash input is text (unlistedSlash text)", () => {
  const classify = codexRelayCapabilities.commands.classify, catalog = entries(["compact", "compact"], ["export", "none"], ["skill:review", "keep"]);
  check(classify, [
    { rule: "the thread operations, exactly", read: [["/compact", null, [], ["command", "compact", "compact", ""]], ["/export  ", null, [], ["command", "export", "none", ""]]],
      not: [" /compact", null, [], ["content"]] },
    { rule: "no full-width lstrip either", read: [["/compact", catalog, [], ["command", "compact", "compact", ""]]], not: ["　/compact", catalog, [], ["content"]] },
    { rule: "with attachments the operations are text", read: [["/compact", null, ["file"], ["content"]], ["/export", null, ["image"], ["content"]]], not: ["/compact", null, [], ["command", "compact", "compact", ""]] },
    { rule: "a listed skill submits its text", read: [["/skill:review the diff", catalog, [], ["command", "skill:review", "keep", "the diff", "relay"]], ["/skill:review it", catalog, ["image"], ["command", "skill:review", "keep", "it", "relay"]]],
      not: ["/skill:other", catalog, [], ["content"]] },
    { rule: "an unlisted slash word is text", read: [["/review", catalog, [], ["content"]], ["/compact now", catalog, [], ["content"]]], not: ["/skill:review", null, [], ["possible_command", "skill:review"]] },
    // Codex's app-server has no clear: the Hub's is exactly /clear, /new or /reset, nothing before, after or with it.
    { rule: "the Hub's clear, exactly", read: [["/clear", null, [], ["command", "clear", "clear", ""]], ["/new", catalog, [], ["command", "new", "clear", ""]], ["/reset  ", null, [], ["command", "reset", "clear", ""]],
      ["/clear\n", null, [], ["command", "clear", "clear", ""]]], not: ["/clear now", null, [], ["content"]] },
    { rule: "no leading whitespace and no word that only starts like one", read: [[" /clear", null, [], ["content"]], ["　/new", null, [], ["content"]], ["/cleared", null, [], ["content"]], ["clear", null, [], ["content"]]],
      not: ["/clear", null, [], ["command", "clear", "clear", ""]] },
    { rule: "with an attachment the Hub's clear is text: it would drop the attachment", read: [["/clear", null, ["file"], ["content"]], ["/new", null, ["image"], ["content"]], ["/reset", null, ["audio"], ["content"]]],
      not: ["/clear", null, [], ["command", "clear", "clear", ""]] },
  ]);
});

test("G069-C03 OpenCode: trimmed, /compact, the Hub's clear alone and listed commands (keep for an unknown effect); any other slash input is text (unlistedSlash text)", () => {
  const classify = openCodeRelayCapabilities.commands.classify, catalog = entries(["review", "unknown"], ["init", "none"]);
  check(classify, [
    // OpenCode's ACP has no clear: the Hub's is /clear, /new or /reset alone, trimmed as its commands are, even over a listed command
    // of the same name; with arguments or an attachment it is not one.
    { rule: "the Hub's clear, trimmed", read: [["/clear", null, [], ["command", "clear", "clear", ""]], ["  /new  ", catalog, [], ["command", "new", "clear", ""]], ["\t　/reset", null, [], ["command", "reset", "clear", ""]],
      ["/new", entries(["new", "keep"]), [], ["command", "new", "clear", ""]]], not: ["/new now", entries(["new", "keep"]), [], ["command", "new", "keep", "now"]] },
    { rule: "with arguments or an attachment it is not the Hub's clear", read: [["/clear now", catalog, [], ["content"]], ["/reset the plan", null, [], ["possible_command", "reset"]], ["/clear", null, ["file"], ["possible_command", "clear"]],
      ["/new", entries(["new", "keep"]), ["image"], ["command", "new", "keep", ""]]], not: ["/clear", catalog, [], ["command", "clear", "clear", ""]] },
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
    // The Hub's clear words are commands whatever the catalog lists, or none yet: the Driver gives the session up before the bridge could be asked.
    // `/clear` is not one of the bridge's commands; `/reset soft` stays its own (it keeps the transcript).
    { rule: "the Hub's clear words need no catalog", read: [["/new", null, [], ["command", "new", "clear", ""]], ["/reset", [], [], ["command", "reset", "clear", ""]], ["/clear", bridge, [], ["command", "clear", "clear", ""]],
      ["/clear", null, [], ["command", "clear", "clear", ""]], ["/reset soft", null, [], ["command", "reset", "compact", "soft"]]], not: ["/nope", null, [], ["possible_command", "nope"]] },
  ]);
});

test("G069-C03 DeepSeek Harness: unlistedSlash=text and no commands but the Hub's clear alone, so every other input is content, whatever a catalog lists", () => {
  const classify = dshRelayCapabilities.commands.classify, listing = entries(["clear", "keep"], ["compact", "compact"]);
  assert.equal(dshRelayCapabilities.commands.unlistedSlash, "text");
  for (const text of ["　/clear", " /compact", "/compact", "/skill:x", "/Users/me", "hello", "", "/clear now", "/newer", "clear"]) for (const catalog of [null, [], listing] as const)
    assert.deepEqual(classify(text, catalog, []), { kind: "content" }, JSON.stringify(text));
  // The Hub's clear is /clear, /new or /reset alone, whatever a catalog lists (it lists /clear as a command that keeps the history), and not with an attachment.
  for (const [text, name] of [["/clear", "clear"], ["/new", "new"], ["/reset ", "reset"]] as const) for (const catalog of [null, [], listing] as const) {
    assert.deepEqual(row(classify(text, catalog, [])), ["command", name, "clear", ""], JSON.stringify(text));
    assert.deepEqual(classify(text, catalog, ["file"]), { kind: "content" }, JSON.stringify(text) + " with a file");
  }
  // The invalid sample: the shared reading, which dsh does not have, reads a listed slash word as a command with the effect the catalog gives it.
  assert.deepEqual(row(sharedClassify("/clear", listing, [])), ["command", "clear", "keep", ""]);
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
  // Whether the Hub offers its own `/export` (models() decides that per connection) no longer changes any reading: with
  // attachments every input is content for Claude Code, without them its catalog's entry is read either way.
  const offering = new ClaudeControl(acp, options), own = new ClaudeControl(acp, options);
  (offering as unknown as { hubExport: boolean }).hubExport = true;
  const exported: NativeModelCatalog = { models: [], defaultModel: null, authentication: "ready", canSelect: false, commands: [{ name: "export", description: "export", contextEffect: "none" }] };
  for (const control of [offering, own]) {
    assert.deepEqual(control.classify("/export", exported, ["file"]), { kind: "content" });
    assert.deepEqual(control.classify("/export", exported, []), { kind: "command", name: "export", args: "", effect: "none" });
  }
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
    // dsh runs on the generic driver, which reads with the declaration the factory hands it (content, but for the Hub's clear alone),
    // with or without a catalog and whatever the catalog lists; the generic driver without one keeps the shared reading.
    const dsh = new AcpControl(acp, options, dshRelayCapabilities), generic = new AcpControl(acp, options);
    const dshReads = (text: string, attachments: readonly ContentKind[]): CommandClass => attachments.length === 0 && /^\/(clear|reset|new)\s*$/u.test(text) ? { kind: "command", name: text.trim().slice(1), args: "", effect: "clear" } : { kind: "content" };
    for (const catalog of catalogs) for (const attachments of [[], ["file"], ["image"]] as const) for (const prefix of prefixes) for (const body of bodies) {
      const text = prefix + body;
      assert.deepEqual(dsh.classify(text, catalog, attachments), nativeReading(dshRelayCapabilities.commands.classify(text, catalog === null ? null : relayEntries(catalog.commands ?? []), attachments)), "dsh " + JSON.stringify(text));
      assert.deepEqual(dsh.classify(text, catalog, attachments), dshReads(text, attachments), "dsh " + JSON.stringify(text));
      assert.deepEqual(generic.classify(text, catalog, attachments), listedCommand(text, catalog), "generic " + JSON.stringify(text));
      compared++;
    }
    // The invalid samples: the shared reading of a listed /compact and of /x without a catalog, which dsh no longer has.
    assert.deepEqual(generic.classify("/compact", listing(["compact", "compact"])), { kind: "command", name: "compact", args: "", effect: "compact" });
    assert.deepEqual(generic.classify("/x", null), { kind: "possible_command", name: "x" });
    assert.deepEqual(dsh.classify("/compact", listing(["compact", "compact"])), { kind: "content" }); assert.deepEqual(dsh.classify("/x", null), { kind: "content" });
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
