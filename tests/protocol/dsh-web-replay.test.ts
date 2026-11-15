import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { ControlEvent, ControlOptions, ControlRun } from "../../src/contracts/control.js";
import { createNativeControl } from "../../src/adapters/control/factory.js";
import type { DshDriver } from "../../src/adapters/control/dsh-web/select.js";

/**
 * dsh 0.2.2-rc.1 on its Web host (`dsh --profile web`), replayed from real recordings (tests/fixtures/dsh-web, 2026-11-15, deepseek-v4-flash), and the
 * same driver going on with dsh's ACP when the installed dsh or its Web host cannot be used (tests/fixtures/dsh, the ACP recordings). Each test lays out
 * a stand-in `@deepseek-ai/dsh` package (its version, its generated Remote contracts, a `lib/bin.js` that plays the recording), so the driver's own
 * check of what is installed runs as it does on a real install. Re-record when dsh changes its Web host.
 */
interface Entry { readonly dir: "call" | "up" | "down"; readonly endpoint?: string; readonly args?: { readonly request?: { readonly mode?: string; readonly content?: readonly { readonly text?: string }[] } } }
const fixture = async (name: string): Promise<{ readonly entries: readonly Entry[] }> => JSON.parse(await readFile(resolve("tests/fixtures/dsh-web", name + ".json"), "utf8")) as { entries: Entry[] };
const prompts = (recorded: { readonly entries: readonly Entry[] }, mode: "queue" | "steer") => recorded.entries.filter(entry => entry.dir === "call" && entry.endpoint === "session/prompt" && entry.args?.request?.mode === mode).map(entry => entry.args!.request!.content![0]!.text!);
const WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/dsh-web-trial/workspace", ACP_WORKSPACE = "/Users/test/.cache/harnesshub-acceptance/dsh-trial/workspace";
const MODEL = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);

/** A stand-in dsh package of `version` whose bin plays the recording; the generated contracts are the installed 0.2.2-rc.1's lines (tests/fixtures/dsh-web/contracts). */
async function installed(t: { after: (fn: () => Promise<void>) => void }, version: string): Promise<{ readonly dir: string; readonly bin: string }> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-web-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "pkg");
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version, type: "module" }));
  for (const pkg of ["dsh-api-session-controller", "dsh-commands", "dsh-client-file-upload"]) {
    await mkdir(join(root, "node_modules", "@deepseek-ai", pkg, "lib"), { recursive: true });
    await copyFile(resolve("tests/fixtures/dsh-web/contracts", pkg + ".txt"), join(root, "node_modules", "@deepseek-ai", pkg, "lib", "typert.remote-client.d.ts"));
  }
  const bin = join(root, "lib", "bin.js");
  await copyFile(resolve("tests/fixtures/dsh-web/bin.mjs"), bin);
  await chmod(bin, 0o755);
  return { dir, bin };
}
async function driver(at: { readonly dir: string; readonly bin: string }, env: Readonly<Record<string, string>>, permission: ControlOptions["permission"] = "auto"): Promise<DshDriver> {
  const options: ControlOptions = { cwd: process.cwd(), env: { HOME: at.dir, PATH: dirname(process.execPath) + ":/usr/bin:/bin", TMPDIR: at.dir }, requestTimeoutMs: 5000, startupTimeoutMs: 10_000,
    runTimeoutMs: 20_000, maxFrameBytes: 8 * 1024 * 1024, maxDiagnosticBytes: 64 * 1024, closeGraceMs: 1500, permission, effort: "low" };
  return await createNativeControl("dsh", { protocol: "acp-v1", executable: at.bin, args: ["--profile", "acp"],
    env: { DSH_REPLAY_WEB_HOST: resolve("tests/fixtures/dsh-web/replay-host.mjs"), DSH_REPLAY_ACP_PEER: resolve("tests/fixtures/dsh/replay-peer.mjs"), DSH_HOME: join(at.dir, ".dsh"), ...env } }, options) as DshDriver;
}
async function turn(run: Promise<ControlRun>, events: ControlEvent[]) { return (await run).result; }
const texts = (events: readonly ControlEvent[]) => events.flatMap(event => event.type === "text" ? [event.text] : []).join("");

test("dsh Web host replay: text and thinking stream live with dsh's attempt as their item, todo_write is the plan, words given mid-turn are answered in it, /compact runs as dsh's command, a stop cancels", async t => {
  const at = await installed(t, "0.2.2-rc.1"), recorded = await fixture("turns"), [first, planned, counted, stopped] = prompts(recorded, "queue"), [steered] = prompts(recorded, "steer");
  const control = await driver(at, { DSH_REPLAY_FIXTURE: resolve("tests/fixtures/dsh-web/turns.json"), DSH_REPLAY_PATCH_COPY: join(at.dir, "overlay.yml") });
  try {
    const observed = await control.initialize();
    assert.equal(observed.protocol, "dsh-web"); assert.equal(observed.agentVersion, "0.2.2-rc.1"); assert.equal(control.route, "web");
    const id = await control.open(WORKSPACE, MODEL);
    assert.match(id, /^session-[0-9a-f-]{36}$/u, "the driver names the session it creates with the first prompt");
    const overlay = await readFile(join(at.dir, "overlay.yml"), "utf8");
    assert.match(overlay, /- id: config-editor\n {2}disabled: true/u, "nothing the process does writes the user's profile");
    assert.match(overlay, /model: "deepseek-v4-flash"\n {4}reasoningEffort: "low"/u, "a new session starts on the model and effort asked for");
    const catalog = await control.models();
    assert.equal(catalog.defaultModel, MODEL); assert.equal(catalog.flavor?.capabilities?.steer, "native"); assert.equal(catalog.flavor?.capabilities?.fork, "native");
    assert.deepEqual(catalog.commands?.map(command => [command.name, command.contextEffect]), [["compact", "compact"]]);

    let events: ControlEvent[] = [];
    assert.deepEqual(await turn(control.startText(id, first!, event => events.push(event)), events), { status: "completed", reason: "end_turn", input: "recorded" });
    assert.equal(events[0]?.type, "input_recorded", "dsh's durable user message is the evidence");
    assert.equal(texts(events), "菠萝");
    assert.ok(events.every(event => event.type !== "text" || event.item?.startsWith(id + ":")), "the live attempt is the text's item");
    assert.deepEqual((events.filter(event => event.type === "usage").at(-1) as Extract<ControlEvent, { type: "usage" }>).usage.turn, { input: 5684, output: 2, cachedInput: 8704, cacheWrite: 0, total: 14390 });

    events = [];
    assert.equal((await turn(control.startText(id, planned!, event => events.push(event)), events)).status, "completed");
    const plan = events.find(event => event.type === "plan");
    assert.ok(plan?.type === "plan"); assert.equal(plan.entries.length, 2); assert.equal(plan.entries[0]!.status, "in_progress");
    assert.ok(events.some(event => event.type === "tool" && event.title === "todo_write" && event.detail?.kind === "think" && event.status === "completed"));

    events = [];
    let steer: Promise<string> | null = null;
    const counting = control.startText(id, counted!, event => { events.push(event); if (steer === null && event.type === "text") steer = control.steer(id, steered!); });
    assert.equal((await turn(counting, events)).status, "completed");
    assert.equal(await steer, "taken");
    assert.match(texts(events), /插话收到$/u, "the words are answered in the same Turn, in the step after");
    assert.equal(await control.steer(id, "late"), "not_taken", "after the Turn nothing is sent");

    events = [];
    assert.deepEqual(await turn(control.startText(id, "/compact", event => events.push(event)), events), { status: "completed", reason: "command" });
    assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.type === "activity" ? event.kind + ":" + event.status : ""), ["compaction:running", "compaction:completed"]);

    events = [];
    let run: ControlRun | null = null;
    run = await control.startText(id, stopped!, event => { events.push(event); if (event.type === "text") void run!.requestStop(); });
    assert.deepEqual(await run.result, { status: "cancelled", reason: "cancelled", input: "recorded" });
    assert.deepEqual(await control.nativeConfig(), { model: MODEL, options: { reasoning_effort: "low" } });
  } finally { assert.equal((await control.close()).closed, true); }
});

test("dsh Web host replay: a write its read-only preset refused asks to leave the sandbox, shown with the change it makes, and is allowed once; its question tool asks the user", async t => {
  const at = await installed(t, "0.2.2-rc.1"), recorded = await fixture("approval"), [write, ask] = prompts(recorded, "queue");
  const control = await driver(at, { DSH_REPLAY_FIXTURE: resolve("tests/fixtures/dsh-web/approval.json") }, "ask");
  try {
    await control.initialize(); control.enablePermissions();
    const id = await control.open(WORKSPACE, MODEL);
    await control.models();
    let events: ControlEvent[] = [];
    const result = await turn(control.startText(id, write!, event => { events.push(event); if (event.type === "permission_requested") void control.decidePermission(event.id, "allow-once"); }), events);
    assert.equal(result.status, "completed");
    const asked = events.find(event => event.type === "permission_requested");
    assert.ok(asked?.type === "permission_requested");
    assert.equal(asked.title, "write"); assert.equal(asked.toolKind, "edit"); assert.ok(asked.forCall);
    assert.match(asked.detail ?? "", /\+hello[\s\S]*原因：/u);
    assert.deepEqual(asked.options.map(option => option.id), ["allow-once", "reject"]);
    // The file was there with the same words: dsh reports an update with no change (`meta.diffs` empty), so the call has no diff.
    assert.ok(events.some(event => event.type === "tool" && event.id === asked.forCall && event.status === "completed" && event.detail?.kind === "edit"), "the allowed write ran");

    events = [];
    const answered = await turn(control.startText(id, ask!, event => { events.push(event); if (event.type === "permission_requested") void control.decidePermission(event.id, "answer-1"); }), events);
    assert.equal(answered.status, "completed");
    const question = events.find(event => event.type === "permission_requested");
    assert.ok(question?.type === "permission_requested" && question.kind === "question");
    assert.deepEqual(question.options.slice(0, 2).map(option => option.name), ["A", "B"]);
    assert.match(texts(events), /B/u);
  } finally { await control.close(); }
});

test("dsh: a dsh older than the Web host the driver was made for goes on with its ACP, says so once, and its catalog declares ACP's capabilities", async t => {
  const at = await installed(t, "0.2.1-rc.5");
  const control = await driver(at, { DSH_REPLAY_ACP_FIXTURE: resolve("tests/fixtures/dsh/turn-resume.json"), DSH_REPLAY_ACP_INDEX: "0" });
  try {
    const observed = await control.initialize();
    assert.equal(observed.protocol, "acp-v1"); assert.equal(observed.agentName, "deepseek-harness-acp"); assert.equal(control.route, "acp");
    assert.equal(control.steering, false);
    const id = await control.open(ACP_WORKSPACE, undefined, { reasoning_effort: "low" });
    const recorded = JSON.parse(await readFile(resolve("tests/fixtures/dsh/turn-resume.json"), "utf8")) as { processes: { dir: string; msg: { method?: string; params?: { prompt: { text: string }[] } } }[][] };
    const prompt = recorded.processes[0]!.find(frame => frame.dir === "in" && frame.msg.method === "session/prompt")!.msg.params!.prompt[0]!.text;
    const events: ControlEvent[] = [], result = await (await control.startText(id, prompt, event => events.push(event))).result;
    assert.equal(result.status, "completed");
    const said = events.find(event => event.type === "diagnostic");
    assert.ok(said?.type === "diagnostic"); assert.match(said.message, /0\.2\.1-rc\.5/u); assert.match(said.message, /ACP/u);
    assert.equal(events.filter(event => event.type === "diagnostic").length, 1);
    await assert.rejects(control.steer(id, "words"), (error: unknown) => (error as { code?: string }).code === "NATIVE_STEER_UNAVAILABLE");
    await assert.rejects(control.setTitle(id, "title"), (error: unknown) => (error as { code?: string }).code === "NATIVE_TITLE_UNAVAILABLE");
  } finally { await control.close(); }
});

test("dsh: a Web host that does not start goes on with ACP before anything was sent, and the Turn runs there", async t => {
  const at = await installed(t, "0.2.2-rc.1");
  const control = await driver(at, { DSH_REPLAY_WEB_EXIT: "1", DSH_REPLAY_ACP_FIXTURE: resolve("tests/fixtures/dsh/turn-resume.json"), DSH_REPLAY_ACP_INDEX: "0" });
  try {
    assert.equal((await control.initialize()).protocol, "dsh-web", "what is installed is fine");
    const id = await control.open(ACP_WORKSPACE, undefined, { reasoning_effort: "low" });
    assert.equal(control.route, "acp");
    const recorded = JSON.parse(await readFile(resolve("tests/fixtures/dsh/turn-resume.json"), "utf8")) as { session: string; processes: { dir: string; msg: { method?: string; params?: { prompt: { text: string }[] } } }[][] };
    assert.equal(id, recorded.session);
    const prompt = recorded.processes[0]!.find(frame => frame.dir === "in" && frame.msg.method === "session/prompt")!.msg.params!.prompt[0]!.text;
    const events: ControlEvent[] = [], result = await (await control.startText(id, prompt, event => events.push(event))).result;
    assert.equal(result.status, "completed");
    assert.match((events.find(event => event.type === "diagnostic") as { message: string }).message, /没启动起来就退出了/u);
    assert.equal((await control.models()).flavor?.capabilities?.steer, "none");
  } finally { await control.close(); }
});
