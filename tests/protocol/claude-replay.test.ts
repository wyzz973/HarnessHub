import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, HarnessControl } from "../../src/contracts/control.js";
import { createNativeControl } from "../../src/adapters/control/factory.js";
import { compatibility } from "../../src/adapters/control/claude/compat.js";

// The Claude Agent SDK driver against a recorded wire: a real session of Claude Code 2.1.325 through SDK 0.3.325 (2026-11-15, Haiku 5.5, level "ask"),
// replayed by tests/fixtures/claude/replay-claude.mjs in place of `claude`. The SDK itself runs as in the product; only the CLI is the recording. When
// Claude Code or the SDK changes what it says, the recording is made again (the trial notes say how).

const FIXTURE = resolve("tests/fixtures/claude/replay-claude.mjs"), WIRE = resolve("tests/fixtures/claude/approval-turn.ndjson");

async function control(t: test.TestContext): Promise<{ control: HarnessControl; trace: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "claude-replay-")); t.after(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, "trace.ndjson"), env = { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude"), REPLAY_FILE: WIRE, REPLAY_TRACE: trace };
  const made = await createNativeControl("claude", { protocol: "claude-agent-sdk", executable: FIXTURE, args: [], env: {} },
    { cwd: root, env, requestTimeoutMs: 10_000, startupTimeoutMs: 20_000, maxFrameBytes: 1 << 24, maxDiagnosticBytes: 1 << 14, closeGraceMs: 1500, permission: "ask" });
  t.after(() => made.close().then(() => undefined, () => undefined));
  return { control: made, trace, root };
}

test("Claude Agent SDK replay: an approved Write and a plain Turn on one kept process, with the approval, the tool, the text by message, usage, limits and recorded input", { timeout: 60_000 }, async t => {
  const { control: claude, trace } = await control(t);
  const observation = await claude.initialize();
  assert.equal(observation.protocol, "claude-agent-sdk");
  assert.equal(observation.agentVersion, "2.1.325");
  claude.enablePermissions!();
  const id = await claude.open(process.cwd(), "haiku");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "the Hub picks the session's identity, a version-8 UUID");

  const events: ControlEvent[] = [];
  const first = await claude.startText(id, "Use the Write tool to create the file record.txt containing the word ok. Do not use Bash.", event => {
    events.push(event);
    if (event.type === "permission_requested") void claude.decidePermission!(event.id, "allow");
  });
  assert.deepEqual(await first.result, { status: "completed", reason: "completed", input: "recorded" });
  const asked = events.find(event => event.type === "permission_requested");
  assert.ok(asked !== undefined && asked.type === "permission_requested");
  assert.equal(asked.toolKind, "edit");
  assert.equal(asked.note, true, "a refusal can carry the user's words");
  assert.deepEqual(asked.options.map(option => option.id), ["allow", "allow_session", "deny", "deny_stop"]);
  const tools = events.filter((event): event is Extract<ControlEvent, { type: "tool" }> => event.type === "tool");
  assert.equal(asked.forCall, tools[0]?.id, "the approval names its call");
  assert.deepEqual(tools.map(tool => [tool.status, tool.detail?.kind, tool.detail?.name]), [["in_progress", "edit", "Write"], ["completed", "edit", "Write"]]);
  assert.match(tools[1]!.detail?.diff ?? "", /^--- \/dev\/null\n\+\+\+ b\/.*record\.txt\n@@ /u, "the created file's diff from its structured output");
  assert.equal(events.filter(event => event.type === "input_recorded").length, 1);
  const items = new Set(events.flatMap(event => event.type === "text" && event.item !== undefined ? [event.item] : []));
  assert.ok(items.size >= 1 && [...items].every(item => item.startsWith("msg_")), "text carries Claude's own message ids");
  const usage = events.findLast(event => event.type === "usage");
  assert.ok(usage?.type === "usage" && (usage.usage.turn?.output ?? 0) > 0 && usage.usage.context?.size === 1_000_000);
  const limits = events.find(event => event.type === "limits");
  assert.ok(limits?.type === "limits" && limits.limits[0]?.id === "seven_day" && typeof limits.limits[0].resetsAt === "number");
  // The answer Claude Code was given: allowed once, its input as asked.
  const sent = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const answer = sent.find(line => line.type === "control_response") as { response: { response: { behavior: string } } } | undefined;
  assert.equal(answer?.response.response.behavior, "allow");
  assert.equal(sent.filter(line => line.type === "user").length, 1);

  const group = claude.processGroup!();
  const second: ControlEvent[] = [];
  const run = await claude.startText(id, "Reply with exactly: done", event => second.push(event));
  assert.deepEqual(await run.result, { status: "completed", reason: "completed", input: "recorded" });
  assert.equal(second.filter(event => event.type === "text").map(event => event.type === "text" ? event.text : "").join(""), "done");
  assert.equal(claude.processGroup!(), group, "the second Turn ran on the same process");
  assert.equal(await claude.steer!(id, "nothing runs"), "not_taken", "words with no Turn running are not taken");
  const evidence = await claude.close();
  assert.equal(evidence.protocolFailure, null);
});

test("Claude Agent SDK pairing: a Claude Code older than the SDK's runs with what it has, the rest turned off and said once; the paired one has everything", () => {
  const old = compatibility("2.1.280", "2.1.325", "0.3.325");
  assert.deepEqual([...old.off].sort(), ["lifecycle", "rollback", "steer"]);
  assert.match(old.diagnostic ?? "", /2\.1\.280.*2\.1\.325.*插话/u);
  assert.deepEqual([...compatibility("2.1.325", "2.1.325", "0.3.325").off], []);
  assert.equal(compatibility("2.1.325", "2.1.325", "0.3.325").diagnostic, null);
  assert.equal(compatibility(null, "2.1.325", null).off.size, 0, "a version not read turns nothing off");
});

test("Claude Agent SDK driver: the Hub's clear sends nothing and gives the session up; a session never prompted cannot be resumed; a relay Turn read as a command is refused", { timeout: 30_000 }, async t => {
  const { control: claude, root } = await control(t);
  await claude.initialize();
  const id = await claude.open(root);
  const cleared = await (await claude.startText(id, "/clear", () => {})).result;
  assert.deepEqual(cleared, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } });
  assert.equal(await claude.checkpoint!(), null);
  assert.equal(claude.processGroup!(), null, "nothing was started for it");
  const other = (await control(t)).control;
  await other.initialize();
  await assert.rejects(other.open(root, undefined, undefined, id), (error: unknown) => (error as { code?: string }).code === "NATIVE_SESSION_NOT_FOUND");
  const third = (await control(t)).control;
  await third.initialize();
  const opened = await third.open(root);
  const refused = await (await third.startText(opened, { user: "/clear", relay: { packetId: "relay-0123456789abcdefghjk" as never, body: "〔HarnessHub 交接单 relay-0123456789abcdefghjk〕", firstLine: false } }, () => {})).result;
  assert.deepEqual([refused.status, refused.input, refused.error?.code], ["failed", "not_recorded", "RELAY_PREPARE_FAILED"], "a command never carries a packet, the clear included");
  assert.equal(await third.checkpoint!(), opened, "nothing was given up");
  const fourth = (await control(t)).control;
  await fourth.initialize();
  const next = await fourth.open(root);
  const exported = await (await fourth.startText(next, "/remote-control", () => {})).result;
  assert.deepEqual([exported.status, exported.input, exported.error?.code], ["failed", "not_recorded", "NATIVE_COMMAND_UNAVAILABLE"]);
});
