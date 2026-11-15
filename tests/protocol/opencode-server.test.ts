import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ControlEvent, ControlLaunch, ControlOptions, HarnessControl, NativeConversationId } from "../../src/contracts/control.js";
import { OpenCodeServerControl } from "../../src/adapters/control/opencode/control.js";
import { opencodeFlavor } from "../../src/adapters/flavors/opencode.js";

/**
 * The OpenCode driver against a recorded session of OpenCode 2.3.0's own server (tests/fixtures/opencode/replay-2.3.0.json, recorded 2026-11-15 with the
 * free deepseek-v4.1-flash-free at the "ask" level): a real process that prints its address, asks for the login and answers each request with the
 * recorded answer, its events released as the Driver makes the requests that came before them.
 */
const FIXTURE = resolve("tests/fixtures/opencode/replay-2.3.0.json"), FAKE = resolve("tests/fixtures/opencode/fake-serve.mjs");
interface Recorded { readonly session: string; readonly exchanges: readonly { readonly kind: string; readonly event?: { readonly type: string; readonly data?: Record<string, unknown> } }[] }

async function start(t: TestContext, env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-replay-")), trace = join(cwd, "trace.ndjson");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const launch: ControlLaunch = { protocol: "opencode-server", executable: process.execPath, args: [FAKE, FIXTURE], env: { FAKE_CWD: cwd, FAKE_TRACE: trace, ...env } };
  const options: ControlOptions = { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, requestTimeoutMs: 5000, startupTimeoutMs: 10000, maxFrameBytes: 64 << 20, maxDiagnosticBytes: 1 << 16,
    closeGraceMs: 1000, permission: "ask", flavor: opencodeFlavor };
  const control = new OpenCodeServerControl(launch, options);
  t.after(() => control.close().then(() => undefined, () => undefined));
  const sent = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { method: string; path: string; body?: Record<string, unknown> });
  return { control, cwd, sent };
}
async function turn(control: HarnessControl, id: NativeConversationId, text: string, on: (event: ControlEvent, control: HarnessControl) => void = () => {}) {
  const events: ControlEvent[] = [];
  const run = await control.startText(id, text, event => { events.push(event); on(event, control); });
  return { result: await run.result, events };
}
const said = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "text" ? [event.text] : []).join("");
const decide = (option: string) => (event: ControlEvent, control: HarnessControl) => { if (event.type === "permission_requested") void control.decidePermission!(event.id, option); };
const toolsOf = (events: readonly ControlEvent[]) => events.filter((event): event is Extract<ControlEvent, { type: "tool" }> => event.type === "tool");

test("OpenCode server replay: the session's rules, an approval, a refusal with words that the model goes on from, a steer of the same turn, a compaction and a rollback", { timeout: 60000 }, async t => {
  const recorded = JSON.parse(await readFile(FIXTURE, "utf8")) as Recorded;
  const { control, cwd, sent } = await start(t);
  const observed = await control.initialize();
  assert.deepEqual([observed.protocol, observed.agentVersion, observed.capabilities.featuresOff], ["opencode-server", "2.3.0", undefined], "every feature the driver relies on is in 2.3.0's document");
  control.enablePermissions();
  assert.equal(control.steering, true);
  const catalog = await control.models();
  assert.ok(catalog.models.some(model => model.id === "opencode/deepseek-v4.1-flash-free" && model.options?.[0]?.id === "effort"), "the model's variants are its thinking option");
  assert.deepEqual(catalog.options?.[0]?.values.map(value => value.value), ["build", "plan"]);
  assert.ok(catalog.commands?.some(command => command.name === "compact" && command.contextEffect === "compact"));
  const id = await control.open(cwd, "opencode/deepseek-v4.1-flash-free");
  assert.equal(id, recorded.session);
  const created = (await sent()).find(line => line.method === "POST" && line.path === "/api/session")!;
  assert.deepEqual(created.body?.permissions, [{ action: "edit", resource: "*", effect: "ask" }, { action: "shell", resource: "*", effect: "ask" }, { action: "external_directory", resource: "*", effect: "ask" },
    { action: "webfetch", resource: "*", effect: "ask" }, { action: "websearch", resource: "*", effect: "ask" }], "the level is the session's own ruleset");
  assert.deepEqual(created.body?.metadata, { harnesshub: "1" });

  // An approval: asked with its call, answered once; the command ran, the model answered.
  const approved = await turn(control, id, "Use the shell tool to run `echo replay-ok`. Then reply with exactly DONE.", decide("once"));
  assert.deepEqual(approved.result, { status: "completed", reason: "completed", input: "recorded" });
  const asked = approved.events.find(event => event.type === "permission_requested") as Extract<ControlEvent, { type: "permission_requested" }>;
  assert.deepEqual([asked.title, asked.options.map(option => option.id), asked.toolKind, typeof asked.forCall], ["echo replay-ok", ["once", "session", "reject", "stop"], "execute", "string"]);
  assert.ok(approved.events.findIndex(event => event.type === "input_recorded") < approved.events.findIndex(event => event.type === "text"), "the input is recorded before the answer");
  const ran = toolsOf(approved.events).filter(event => event.id === asked.forCall).at(-1)!;
  assert.deepEqual([ran.status, ran.detail?.kind, ran.detail?.output?.trim()], ["completed", "execute", "replay-ok"]);
  assert.equal(said(approved.events), "DONE");
  assert.ok(approved.events.every(event => event.type !== "text" || typeof event.item === "string" && event.item.startsWith("msg_")), "text carries OpenCode's message and block");
  const usage = approved.events.filter(event => event.type === "usage").at(-1) as Extract<ControlEvent, { type: "usage" }>;
  assert.equal(usage.usage.requests?.length, 2, "one request per model call");
  assert.equal(usage.usage.context?.size, 200000);

  // A refusal goes with words: the model is told why and answers, the turn completes.
  const declined = await turn(control, id, "Use the shell tool to run `echo replay-no > replay-no.txt`. If you are not allowed, reply with exactly NOT-ALLOWED.", decide("reject"));
  assert.deepEqual(declined.result, { status: "completed", reason: "completed", input: "recorded" });
  assert.equal(said(declined.events), "NOT-ALLOWED");
  const reply = (await sent()).filter(line => /\/permission\/per_[^/]+\/reply$/u.test(line.path)).at(-1)!;
  assert.equal(reply.body?.decision, "reject"); assert.ok(typeof reply.body?.message === "string" && reply.body.message.length > 0, "a refusal with a message lets the model go on");
  assert.equal(toolsOf(declined.events).at(-1)?.status, "cancelled");

  // A steer: taken into the turn that runs, delivered at its next step; the turn ends after it.
  let steered: Promise<string> | null = null;
  const steer = await turn(control, id, "Use the shell tool to run `sleep 4 && echo first`, then reply with a one-line summary.", (event, owner) => {
    if (event.type === "permission_requested") void owner.decidePermission!(event.id, "once");
    if (event.type === "tool" && event.status === "in_progress" && event.title.startsWith("sleep") && steered === null) steered = owner.steer!(id, "End your summary with the word BANANA.");
  });
  assert.equal(await steered, "taken");
  assert.deepEqual(steer.result, { status: "completed", reason: "completed", input: "recorded" });
  assert.match(said(steer.events), /BANANA$/u);
  assert.equal((await sent()).filter(line => line.path.endsWith("/prompt") && line.body?.delivery === "steer").length, 1);

  // The Hub's /compact is OpenCode's compaction, under the Turn's own identity.
  const compacted = await turn(control, id, "/compact");
  assert.equal(compacted.result.status, "completed");
  assert.deepEqual(compacted.events.filter(event => event.type === "activity").map(event => (event as { status: string }).status), ["running", "completed"]);
  const compaction = (await sent()).find(line => line.path.endsWith("/compact"))!;
  assert.match(String(compaction.body?.id), /^msg_hub_compact_/u);

  // Rollback: the last turn (the compaction) is taken out of the history, files left alone.
  await control.rollback!(id, 1);
  const stage = (await sent()).find(line => line.path.endsWith("/revert/stage"))!;
  assert.deepEqual(stage.body, { messageID: compaction.body?.id, files: false });
  assert.ok((await sent()).some(line => line.path.endsWith("/revert/commit")));
  const closed = await control.close();
  assert.deepEqual([closed.closed, closed.exitCode, closed.protocolFailure], [true, 0, null]);
});

test("OpenCode server replay: a stream cut in the middle of an answer is followed again, and the session's messages fill what was missed, each piece of text once", { timeout: 60000 }, async t => {
  const recorded = JSON.parse(await readFile(FIXTURE, "utf8")) as Recorded;
  // Cut right after the first piece of the steered turn's answer: the rest of it, the steer's delivery and the turn's end are lost.
  const cut = recorded.exchanges.findIndex(entry => entry.event?.type === "session.text.delta" && String(entry.event.data?.delta ?? "").startsWith("Command `sleep"));
  assert.ok(cut > 0);
  const { control, cwd, sent } = await start(t, { FAKE_DROP_AT: String(cut) });
  await control.initialize(); control.enablePermissions();
  const id = await control.open(cwd, "opencode/deepseek-v4.1-flash-free");
  await turn(control, id, "Use the shell tool to run `echo replay-ok`. Then reply with exactly DONE.", decide("once"));
  await turn(control, id, "Use the shell tool to run `echo replay-no > replay-no.txt`. If you are not allowed, reply with exactly NOT-ALLOWED.", decide("reject"));
  let steered: Promise<string> | null = null;
  const steer = await turn(control, id, "Use the shell tool to run `sleep 4 && echo first`, then reply with a one-line summary.", (event, owner) => {
    if (event.type === "permission_requested") void owner.decidePermission!(event.id, "once");
    if (event.type === "tool" && event.status === "in_progress" && event.title.startsWith("sleep") && steered === null) steered = owner.steer!(id, "End your summary with the word BANANA.");
  });
  assert.equal(await steered, "taken");
  assert.deepEqual(steer.result, { status: "completed", reason: "completed", input: "recorded" }, "the turn's end is read from its idle record");
  assert.equal(said(steer.events), "Command `sleep 4 && echo first` ran successfully and printed \"first\" after the 4-second delay. BANANA", "nothing said twice, nothing missed");
  assert.ok(steer.events.some(event => event.type === "diagnostic" && event.message.includes("连上")), "the Turn says the stream was followed again");
  assert.equal(toolsOf(steer.events).filter(event => event.title.startsWith("sleep")).at(-1)?.status, "completed");
  const usage = steer.events.filter(event => event.type === "usage").at(-1) as Extract<ControlEvent, { type: "usage" }>;
  assert.equal(usage.usage.requests?.length, 2, "the lost call's usage comes from its message");
  assert.equal((await sent()).filter(line => line.path === "/api/event").length, 2);
  assert.equal(control.healthy!(), true);
});

test("OpenCode server: a prompt OpenCode refused before taking it in is not recorded; the Hub's clear sends nothing and gives the session up", { timeout: 30000 }, async t => {
  const { control, cwd } = await start(t);
  await control.initialize();
  const id = await control.open(cwd, "opencode/deepseek-v4.1-flash-free");
  const cleared = await turn(control, id, "  /new ");
  assert.deepEqual(cleared.result, { status: "completed", reason: "cleared", input: "not_recorded", native: { cleared: true } });
  assert.equal(await control.checkpoint!(), null);
  assert.ok(cleared.events.some(event => event.type === "diagnostic" && event.message.includes("OpenCode")));
  // A second connection: a prompt the replay has no answer for is refused (404, as OpenCode's own refusals are 4xx): nothing reached the history.
  const other = await start(t);
  await other.control.initialize();
  const session = await other.control.open(other.cwd, "opencode/deepseek-v4.1-flash-free");
  const run = await other.control.startText(session, "/review", () => {});
  const result = await run.result;
  assert.deepEqual([result.status, result.input], ["failed", "not_recorded"]);
});
