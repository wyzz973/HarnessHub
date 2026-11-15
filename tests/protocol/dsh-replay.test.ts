import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlOptions } from "../../src/contracts/control.js";
import { createNativeControl } from "../../src/adapters/control/factory.js";
import type { DshControl } from "../../src/adapters/control/dsh.js";

/**
 * dsh 0.2.2-rc.1 (`dsh --profile acp`) replayed from real recordings (tests/fixtures/dsh, 2026-11-15, deepseek-v4-flash): the driver's messages must be
 * the ones recorded, and what it makes of dsh's answers is checked. Re-record when dsh changes its ACP or its session log.
 */
interface Fixture { readonly session: string; readonly processes: readonly (readonly { readonly dir: string; readonly msg: Record<string, unknown> }[])[]; readonly log: readonly Record<string, unknown>[] }
const fixture = async (name: string): Promise<Fixture> => JSON.parse(await readFile(resolve("tests/fixtures/dsh", name + ".json"), "utf8")) as Fixture;
const WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/dsh-trial/workspace";

async function replay(name: string, index: number, home: string, permission?: ControlOptions["permission"]): Promise<DshControl> {
  const options: ControlOptions = { cwd: process.cwd(), env: { HOME: home }, requestTimeoutMs: 5000, runTimeoutMs: 20_000, maxFrameBytes: 8 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 500,
    ...(permission === undefined ? {} : { permission }) };
  return await createNativeControl("dsh", { protocol: "acp-v1", executable: process.execPath, args: [resolve("tests/fixtures/dsh/replay-peer.mjs"), resolve("tests/fixtures/dsh", name + ".json"), String(index)],
    env: { DSH_HOME: join(home, ".dsh") } }, options) as DshControl;
}
async function home(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-replay-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function promptOf(recorded: Fixture, process: number, nth = 0): string {
  const prompt = recorded.processes[process]!.filter(frame => frame.dir === "in" && frame.msg.method === "session/prompt")[nth]!.msg as { params: { prompt: { text: string }[] } };
  return prompt.params.prompt[0]!.text;
}
const texts = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "text" ? [event] : []);

test("dsh replay: a Turn's reply carries dsh's message id, its usage comes from the session log, and a new process resumes the session and counts only its own turn", async t => {
  const dir = await home(t), recorded = await fixture("turn-resume");
  const first = await replay("turn-resume", 0, dir, "auto");
  try {
    const observed = await first.initialize();
    assert.equal(observed.agentName, "deepseek-harness-acp");
    assert.equal(first.steering, false, "dsh's ACP takes one prompt at a time");
    const id = await first.open(WORKSPACE, undefined, { reasoning_effort: "low" });
    assert.equal(id, recorded.session);
    const events: ControlEvent[] = [], run = await first.startText(id, promptOf(recorded, 0), event => events.push(event));
    await assert.rejects(first.steer(id, "words"), (error: unknown) => (error as { code?: string }).code === "NATIVE_STEER_UNAVAILABLE");
    assert.deepEqual(await run.result, { status: "completed", reason: "end_turn", input: "recorded" });
    assert.deepEqual(texts(events).map(event => [event.text, event.item]), [["pineapple", "524d9b39-0986-4bbc-9149-69b4f6beac65"]]);
    assert.deepEqual(events.filter(event => event.type === "usage").at(-1), { type: "usage", usage: { turn: { input: 11006, output: 3, cachedInput: 0, cacheWrite: 0, total: 11009 } } });
  } finally { await first.close(); }
  const second = await replay("turn-resume", 1, dir, "auto");
  try {
    await second.initialize();
    assert.equal(await second.open(WORKSPACE, undefined, { reasoning_effort: "low" }, recorded.session), recorded.session);
    const events: ControlEvent[] = [], result = await (await second.startText(recorded.session as never, promptOf(recorded, 1), event => events.push(event))).result;
    assert.equal(result.status, "completed");
    assert.equal(texts(events)[0]?.item, "6c2e7c63-067f-4ebd-8203-5eecbbe1c150");
    // Only the turn this prompt added: the log already held the first one when the prompt was sent.
    assert.deepEqual(events.filter(event => event.type === "usage").at(-1), { type: "usage", usage: { turn: { input: 151, output: 3, cachedInput: 10880, cacheWrite: 0, total: 11034 } } });
  } finally { await second.close(); }
});

test("dsh replay: a turn whose model calls failed is refused as a prompt (0.2.2), and the log names it: failed with the Hub's words for dsh's error code, the input recorded", async t => {
  const dir = await home(t), recorded = await fixture("failure");
  const control = await replay("failure", 0, dir, "auto");
  try {
    await control.initialize();
    const id = await control.open(WORKSPACE, undefined, { reasoning_effort: "off" });
    const result = await (await control.startText(id, promptOf(recorded, 0), () => {})).result;
    assert.equal(result.status, "failed"); assert.equal(result.reason, "native_error"); assert.equal(result.input, "recorded");
    assert.equal(result.error?.code, "NATIVE_CONNECTION_FAILED");
    assert.doesNotMatch(result.error?.message ?? "", /DeepSeek Messages transport failed/u, "dsh's own text is not quoted");
  } finally { await control.close(); }
});

test("dsh replay: its permission request names only the call; the request is shown with the call's tool and command, and dsh's tools get their kinds", async t => {
  const dir = await home(t), recorded = await fixture("approval");
  const control = await replay("approval", 0, dir, "ask");
  try {
    await control.initialize(); control.enablePermissions();
    const id = await control.open(WORKSPACE, undefined, { reasoning_effort: "off" });
    const events: ControlEvent[] = [];
    const run = await control.startText(id, promptOf(recorded, 0), event => {
      events.push(event);
      if (event.type === "permission_requested") void control.decidePermission(event.id, "allow-once");
    });
    assert.equal((await run.result).status, "completed");
    const asked = events.find(event => event.type === "permission_requested");
    assert.ok(asked?.type === "permission_requested");
    assert.equal(asked.title, "bash"); assert.equal(asked.detail, "命令：echo approved > approval.txt"); assert.equal(asked.forCall, "call_00_IoHZv3tTgPjyr35zWcdC9122");
    assert.ok(events.every(event => event.type !== "tool" || event.detail?.kind === "execute"), "bash is dsh's shell");
  } finally { await control.close(); }
});

test("dsh replay: the file changes its write and edit tools made reach their calls from the log once the prompt answered; a stopped turn is cancelled, not failed", async t => {
  const dir = await home(t), recorded = await fixture("edit-stop");
  const control = await replay("edit-stop", 0, dir, "auto");
  try {
    await control.initialize();
    const id = await control.open(WORKSPACE, undefined, { reasoning_effort: "off" });
    const events: ControlEvent[] = [], result = await (await control.startText(id, promptOf(recorded, 0), event => events.push(event))).result;
    assert.equal(result.status, "completed");
    const diffs = new Map(events.flatMap(event => event.type === "tool" && event.detail?.diff !== undefined ? [[event.title, event.detail.diff] as const] : []));
    assert.match(diffs.get("write") ?? "", /\+first/u);
    assert.match(diffs.get("edit") ?? "", /-first[\s\S]*\+second/u);
    const stopped: ControlEvent[] = [];
    const run = await control.startText(id, promptOf(recorded, 0, 1), event => { stopped.push(event); if (event.type === "tool" && event.status === "in_progress") void run.requestStop(); });
    assert.deepEqual(await run.result, { status: "cancelled", reason: "cancelled", input: "recorded" });
  } finally { await control.close(); }
});
