import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application } from "../../src/cli/session-application.js";
import { verify } from "../../src/contexts/session/domain/conversation-verify.js";
import type { HeldItem, TurnItems } from "../../src/contracts/conversation.js";
import type { PermissionRequest, PublicRun, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
/** A development manifest (HH_REAL_MANIFEST) names non-official entries, which only the development policy reads (ADR-044). */
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;

/*
 * Original-installation acceptance of a conversation kept as rows (ADR-057): the user's installed Harness says something, runs two commands and sums up, and
 * the Turn the Hub committed must hold what happened in the order it happened, whole, with nothing left open. The order is checked against the events (an item's
 * place in the Turn must follow the order of the commits that made the items), not against what the model was asked to do, which it may not follow. The data root
 * is then closed and opened again (a restart): the Turn must read back as it was. A second Turn edits a file with the Harness's own approval answered once; a
 * third asks for another edit and the approval, if the Harness asks for one, is refused: the file must be as it was and the refusal must be on record.
 *
 * Evidence keeps types, states and sizes, never a word of the conversation, a path or an environment value.
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const evidencePath = process.env.HH_REAL_EVIDENCE;
const environment = captureNativeEnvironment();
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);
const OPEN = new Set(["pending", "running", "waiting"]);
const ACTIONS = new Set(["command", "file_read", "file_change", "search", "web", "mcp_tool", "tool", "subagent"]);
type App = ReturnType<typeof application>;
async function closeApp(app: App): Promise<void> {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
}
const standing = (option: { readonly id: string; readonly name: string }): boolean => /\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name);
/** A one-time allow, never a standing rule: the approval must not outlive this workspace. */
function allowOnce(request: PermissionRequest): string | null {
  return request.options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !standing(option))?.id ?? null;
}
/** A one-time refusal. */
function refuseOnce(request: PermissionRequest): string | null {
  return request.options.find(option => /^(deny|reject|decline|refuse|no|cancel|abort|stop)/iu.test(option.id) && !standing(option))?.id ?? null;
}
async function settle(app: App, id: SessionId, answer: (request: PermissionRequest) => string | null, asked: Record<string, unknown>[], deadline: number): Promise<PublicRun> {
  for (;;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided)) {
      const option = answer(request);
      asked.push({ options: request.options.map(item => item.id), chosen: option });
      if (option === null) throw new Error("no fitting one-time option among the native approval options");
      await app.runtime.decidePermission(id, request.id, option, "decide-" + randomUUID());
    }
    const run = app.runtime.read(id).runs.at(-1)!;
    if (TERMINAL.has(run.status)) { await app.runtime.wait(id); return app.runtime.read(id).runs.at(-1)!; }
    if (Date.now() > deadline) throw new Error("the native turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
const textOf = (item: HeldItem): string => item.text.join("");
/** What the evidence says of an item: its kind, its state and how much it holds; never what it holds. */
function shape(item: HeldItem): Record<string, unknown> {
  const fields = item.fields as unknown as Record<string, unknown>, decision = fields.decision as { readonly role?: string; readonly by?: string } | undefined;
  return { seq: item.seq, type: item.type, status: item.status, createdSeq: item.createdSeq, textBytes: item.textBytes, ...(typeof fields.phase === "string" ? { phase: fields.phase } : {}),
    ...(typeof fields.exitCode === "number" ? { exitCode: fields.exitCode } : {}), ...(decision === undefined ? {} : { decision: { role: decision.role ?? null, by: decision.by ?? null } }),
    ...((fields.native as { readonly clipped?: readonly string[] } | undefined)?.clipped === undefined ? {} : { clipped: (fields.native as { readonly clipped: readonly string[] }).clipped }) };
}
/** Every content id an item's own JSON names (a stored detail, an attachment, an artifact): what the collector must be told to keep. */
function contentIds(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) contentIds(entry, found);
  else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.sha256 === "string" && typeof record.bytes === "number") found.add(record.id);
    for (const entry of Object.values(record)) contentIds(entry, found);
  }
  return found;
}
/** The Turn at `ordinal`, every item whole. */
function turn(app: App, id: SessionId, ordinal: number): TurnItems {
  const read = app.store.turnAt(id, ordinal, { inlineBytes: Infinity });
  assert.ok(read, "the Turn is in the tables");
  return read;
}
/** The checks every finished Turn must pass, whatever the model did. */
function turnChecks(app: App, id: SessionId, read: TurnItems, reply: string): Record<string, boolean> {
  const items = read.items, answers = items.filter(item => item.type === "assistant_message");
  const made = items.filter(item => item.createdSeq !== null).map(item => item.createdSeq!);
  const references = app.store.contentReferences();
  return {
    userFirst: items[0]?.type === "user_message" && textOf(items[0]).length > 0,
    placesIncrease: items.every((item, index) => index === 0 || item.seq > items[index - 1]!.seq),
    // The order of the Turn is the order of the commits that made its items: an item made by a later commit never stands before one made by an earlier commit.
    orderFollowsCommits: made.length === items.length && made.every((seq, index) => index === 0 || seq >= made[index - 1]!),
    nothingLeftOpen: items.every(item => !OPEN.has(item.status)),
    // The words of the answer are all there: the segments in order are the reply the old shape gives for the same Turn.
    replyWhole: answers.map(textOf).join("") === reply && reply.length > 0,
    referencesKept: [...contentIds(items.map(item => item.fields))].every(content => references.has(content)),
    verified: verify(app.store.get(id), app.store).length === 0,
  };
}

test("an installed Harness's Turn is kept as items in the order they happened, whole, and reads back after a restart", { timeout: 30 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES to the installed Harness identities under acceptance");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path"); guardTargets(harnesses);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-native-items-")));
  const results: Record<string, unknown>[] = [], failures: string[] = [];
  let header: EvidenceHeader | null = null;
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment);
      const data = join(root, harnessId + "-data"), workspace = join(root, harnessId + "-workspace"), notes = join(workspace, "notes.txt");
      await mkdir(workspace);
      await writeFile(notes, "alpha\nbravo\ncharlie\n");
      const optionsText = process.env["HH_REAL_OPTIONS_" + harnessId.toUpperCase()], nativeOptions = optionsText === undefined ? undefined : JSON.parse(optionsText) as Record<string, string>;
      const configuration = await prepareConfiguration({ workspace, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
      const proof: Record<string, unknown> = { harnessId, startedAt: new Date().toISOString() };
      const open = (): App => application(data, () => {}, { installations: realInstallations, workspaceLockRoot: join(root, "locks") });
      const fail = (checks: Record<string, boolean>, label: string): void => { for (const [name, passed] of Object.entries(checks)) if (!passed) failures.push(harnessId + ": " + label + " " + name); };
      const replyOf = (app: App, id: SessionId, run: PublicRun): string => app.runtime.read(id).messages.find(row => row.id === run.assistantMessageId)?.text ?? "";
      let app = open();
      try {
        header ??= await evidenceHeader(app, harnesses, { configuration });
        const requested = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const created = await app.runtime.create(configuration, { harnessId, ...(requested === undefined ? {} : { nativeModel: requested }), ...(nativeOptions === undefined ? {} : { nativeOptions }) }, "create-" + randomUUID());
        const id = created.id;

        // Turn 1: say, act twice, sum up.
        const askedFirst: Record<string, unknown>[] = [];
        app.runtime.send(id, "这是一次条目顺序验收，只在当前工作目录内操作。严格按顺序做，一次只调用一个工具，不要并行：\n1. 先用一句话说明你接下来要做什么（这句话要在任何工具调用之前说出来）。\n2. 用命令行工具运行 `cat notes.txt`。\n3. 再用命令行工具运行 `ls`。\n4. 最后用一两句话总结 notes.txt 里有哪几行。", "send-" + randomUUID());
        const first = await settle(app, id, allowOnce, askedFirst, Date.now() + 8 * 60 * 1000);
        const firstTurn = turn(app, id, 0), firstItems = firstTurn.items;
        const actions = firstItems.filter(item => ACTIONS.has(item.type)), answers = firstItems.filter(item => item.type === "assistant_message" && textOf(item).length > 0);
        const firstChecks = {
          completed: first.status === "completed",
          ...turnChecks(app, id, firstTurn, replyOf(app, id, first)),
          acted: actions.length >= 2 && actions.every(item => item.status === "completed"),
          // The summary was said after the work: an answer segment stands after the last action.
          answeredAfterActing: actions.length > 0 && answers.some(item => item.seq > actions.at(-1)!.seq),
        };
        // What the model was asked for and may not have done: said only in the evidence.
        proof.first = { status: first.status, error: first.error, items: firstItems.map(shape), saidBeforeActing: actions.length > 0 && answers.some(item => item.seq < actions[0]!.seq), approvals: askedFirst, checks: firstChecks };
        fail(firstChecks, "turn 1");

        // A restart: the data root is closed and opened again, and the Turn reads back as it was.
        await closeApp(app);
        app = open();
        const again = turn(app, id, 0);
        const restartChecks = { sameItems: JSON.stringify(again.items) === JSON.stringify(firstItems), sameRun: JSON.stringify(again.run) === JSON.stringify(firstTurn.run), verified: verify(app.store.get(id), app.store).length === 0 };
        proof.restart = { checks: restartChecks };
        fail(restartChecks, "restart");

        // Turn 2: an edit, the Harness's own approval answered once.
        const askedSecond: Record<string, unknown>[] = [];
        app.runtime.send(id, "用你的文件编辑工具（不要用 shell 命令）把 notes.txt 里的 bravo 改成 delta，改完只回复 done。", "send-" + randomUUID());
        const second = await settle(app, id, allowOnce, askedSecond, Date.now() + 8 * 60 * 1000);
        const secondTurn = turn(app, id, 1), approvals = secondTurn.items.filter(item => item.type === "approval");
        const edited = (await readFile(notes, "utf8")).split("\n")[1] ?? "";
        const secondChecks = {
          completed: second.status === "completed",
          ...turnChecks(app, id, secondTurn, replyOf(app, id, second)),
          fileEdited: edited === "delta",
          changeKept: secondTurn.items.some(item => ACTIONS.has(item.type) && item.status === "completed"),
          // Each approval asked is an item, with who decided and how.
          approvalsOnRecord: approvals.length === askedSecond.length && approvals.every(item => (item.fields as unknown as { readonly decision?: { readonly by?: string } }).decision?.by === "user"),
        };
        proof.second = { status: second.status, error: second.error, items: secondTurn.items.map(shape), approvals: askedSecond, checks: secondChecks };
        fail(secondChecks, "turn 2");

        // Turn 3: another edit, refused if the Harness asks. A Harness that does not ask edits the file, which is said and is no failure of the Hub's.
        const askedThird: Record<string, unknown>[] = [];
        app.runtime.send(id, "用你的文件编辑工具（不要用 shell 命令）把 notes.txt 里的 charlie 改成 echo。如果这次修改没有被批准，不要用别的办法绕过，直接回复“未修改”。", "send-" + randomUUID());
        const third = await settle(app, id, refuseOnce, askedThird, Date.now() + 8 * 60 * 1000);
        const thirdTurn = turn(app, id, 2), refusals = thirdTurn.items.filter(item => item.type === "approval");
        const last = (await readFile(notes, "utf8")).split("\n")[2] ?? "";
        const thirdChecks = {
          settled: TERMINAL.has(third.status),
          nothingLeftOpen: thirdTurn.items.every(item => !OPEN.has(item.status)),
          verified: verify(app.store.get(id), app.store).length === 0,
          ...(askedThird.length === 0 ? {} : {
            fileUntouched: last === "charlie",
            refusalsOnRecord: refusals.length === askedThird.length && refusals.every(item => { const decision = (item.fields as unknown as { readonly decision?: { readonly by?: string; readonly role?: string } }).decision; return decision?.by === "user" && decision.role !== "allow"; }),
          }),
        };
        proof.third = { status: third.status, error: third.error, asked: askedThird.length > 0, fileLine: last === "charlie" ? "as it was" : last === "echo" ? "edited" : "other", items: thirdTurn.items.map(shape), approvals: askedThird, checks: thirdChecks };
        fail(thirdChecks, "turn 3");

        // Turn 4: a command with a long output (about 350 KiB as the shell writes it). How much of it a Harness reports is the Harness's own matter and is only said in
        // the evidence; what it reports must be kept whole, readable, and not marked as unsaved.
        const askedFourth: Record<string, unknown>[] = [];
        app.runtime.send(id, "用命令行工具运行 `seq 1 60000`，然后只回复输出的最后一行。", "send-" + randomUUID());
        const fourth = await settle(app, id, allowOnce, askedFourth, Date.now() + 8 * 60 * 1000);
        const fourthTurn = turn(app, id, 3), commands = fourthTurn.items.filter(item => ACTIONS.has(item.type));
        const kept = commands.flatMap(item => [...contentIds(item.fields)]).map(content => { try { return app.content.read(content).ref.bytes; } catch { return -1; } });
        const fourthChecks = {
          completed: fourth.status === "completed",
          ...turnChecks(app, id, fourthTurn, replyOf(app, id, fourth)),
          acted: commands.length > 0 && commands.every(item => item.status === "completed"),
          detailsReadable: kept.length > 0 && kept.every(bytes => bytes >= 0),
          nothingUnsaved: commands.every(item => !((item.fields as unknown as { readonly native?: { readonly clipped?: readonly string[] } }).native?.clipped ?? []).includes("detail:not_saved")),
        };
        proof.fourth = { status: fourth.status, error: fourth.error, items: fourthTurn.items.map(shape), detailBytes: kept, approvals: askedFourth, checks: fourthChecks };
        fail(fourthChecks, "turn 4");
      } catch (error) {
        proof.failure = { code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : "ASSERTION", message: error instanceof Error ? error.message.slice(0, 512) : "failed" };
        failures.push(harnessId + ": " + (proof.failure as { code: string }).code);
      } finally {
        await closeApp(app);
        const guard: GuardCheck = await recheck(before, environment);
        proof.guard = guard;
        if (!guard.unchanged) failures.push(harnessId + ": " + describeGuard(guard));
        proof.finishedAt = new Date().toISOString();
        results.push(proof);
        await writeFile(evidencePath, JSON.stringify({ header, results }, null, 2) + "\n", { mode: 0o600 });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "the acceptance of a Turn kept as items failed");
});
