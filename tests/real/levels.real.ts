import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { application as composeApplication } from "../../src/cli/session-application.js";
import { EFFORT_KEY, nativeLevels, PERMISSION_KEY, type HarnessFlavor } from "../../src/contracts/flavor.js";
import type { NativeOption } from "../../src/contracts/control.js";
import { PERMISSION_WORDS, EFFORT_WORDS } from "../../src/contracts/levels.js";
import { EFFORT_LEVELS, PERMISSION_LEVELS, type EffortLevel, type PermissionLevel } from "../../src/contracts/protocol.js";
import type { PublicRun, SessionEvent, SessionId } from "../../src/contracts/session.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";
import { oldShape } from "../fixtures/old-shape.js";

/**
 * Every permission level on every Harness, on the user's installed Harnesses (pnpm test:real:levels). For each Harness of HH_REAL_HARNESSES and
 * each level of HH_REAL_LEVELS (all five by default) a conversation is made through the Gateway's own HTTP API, the page's path, with a selection
 * that names the level by the Hub's key alone (hub_permission, and hub_effort when HH_REAL_EFFORT names one): the adapter has to carry it out by
 * its declaration. One message asks for a command and an edit of a file in a fresh workspace (a Harness of HH_REAL_READONLY_HARNESSES, OpenClaw by
 * default, whose tools act on its own workspace, runs a harmless command only). A request that reaches the user is allowed once, as a user would.
 * Then one conversation per pair of HH_REAL_SWITCHES (ask>auto by default) changes its level between two Turns, the page's way (a switch), and
 * the second Turn is judged by the new level.
 *
 * Judged per cell, against EXPECTED (what each declaration says it does): which kinds of request came to the user, whether the file changed,
 * whether the command ran (its output, a time stamp only the run can know, in the stored tool details), and that the Turn completed. Recorded
 * besides: what the Hub's policy answered, by kind. The evidence (HH_REAL_EVIDENCE, 0600) keeps kinds, states and sizes, never the conversation's
 * words; a Markdown table for the matrix is written next to it (<evidence>.md). The user's Harness configuration is snapshotted before each
 * Harness and compared after (./guard.ts).
 */
const harnesses = (process.env.HH_REAL_HARNESSES ?? "").split(",").map(value => value.trim()).filter(Boolean);
const levels = (process.env.HH_REAL_LEVELS ?? PERMISSION_LEVELS.join(",")).split(",").map(value => value.trim()).filter(Boolean) as PermissionLevel[];
const effort = process.env.HH_REAL_EFFORT?.trim() as EffortLevel | undefined;
const switches = (process.env.HH_REAL_SWITCHES ?? "ask>auto").split(",").map(value => value.trim()).filter(Boolean).map(pair => pair.split(">") as [PermissionLevel, PermissionLevel]);
const readOnlyHarnesses = new Set((process.env.HH_REAL_READONLY_HARNESSES ?? "openclaw").split(",").map(value => value.trim()).filter(Boolean));
const evidencePath = process.env.HH_REAL_EVIDENCE;
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const environment = captureNativeEnvironment();
const TERMINAL = new Set<PublicRun["status"]>(["completed", "failed", "cancelled", "unknown"]);

/** What a level should do on a Harness: the kinds of request the user is asked about, whether the file changes and the command runs (null: not judged). */
interface Expected { readonly asks: readonly ("edit" | "execute")[]; readonly file: boolean | null; readonly command: boolean | null; readonly note?: string }
const E = (asks: Expected["asks"], file: boolean | null, command: boolean | null, note?: string): Expected => ({ asks, file, command, ...(note === undefined ? {} : { note }) });
/**
 * Each declaration's own word for each level (src/adapters/flavors/<id>.ts), as the cells the suite judges. Under "plan" a command that writes
 * nothing is not judged: a Harness may read and run such a command while it plans (DeepSeek Harness's read-only sandbox and Hermes run it).
 */
const EXPECTED: Readonly<Record<string, Readonly<Record<PermissionLevel, Expected>>>> = {
  claude: { plan: E([], false, null), ask: E(["edit", "execute"], true, true), auto_edit: E(["execute"], true, true), auto: E([], true, true), full: E([], true, true) },
  codex: { plan: E([], false, null), ask: E(["edit", "execute"], true, true), auto_edit: E(["execute"], true, true), auto: E([], true, true), full: E([], true, true) },
  opencode: { plan: E([], false, false), ask: E(["edit", "execute"], true, true), auto_edit: E(["execute"], true, true), auto: E([], true, true), full: E([], true, true) },
  dsh: { plan: E([], false, null), ask: E(["edit"], true, true, "命令不写文件就不问"), auto_edit: E([], true, true, "命令不写文件就不问"), auto: E([], true, true), full: E([], true, true) },
  // `sh -c` is among Hermes's dangerous patterns (tools/approval.py), so its command asks; an ordinary command (`date`) does not (run 2026-11-13).
  hermes: { plan: E([], false, null), ask: E(["edit", "execute"], true, true, "sh -c 算危险命令"), auto_edit: E(["execute"], true, true, "sh -c 算危险命令"), auto: E([], true, true), full: E([], true, true) },
  openclaw: { plan: E([], null, false), ask: E(["execute"], null, true), auto_edit: E(["execute"], null, true), auto: E([], null, true), full: E([], null, true) },
};

/** What a level changed between Turns does where the declaration says it differs from a conversation that starts at it (DeepSeek Harness keeps its first sandbox). */
const EXPECTED_SWITCHED: Readonly<Record<string, Readonly<Record<string, Expected>>>> = {
  dsh: { "auto>ask": E([], true, true, "沙箱仍是建立时的 workspace-write：工作区内的写入不再来问") },
};
type Kind = "read" | "edit" | "execute" | "network" | "tool" | "other";
interface Cell {
  readonly harnessId: string; readonly level: PermissionLevel; readonly step: "level" | "switched"; readonly from?: PermissionLevel;
  readonly status: PublicRun["status"] | "error"; readonly error?: string;
  /** Kinds of the requests that came to the user (each allowed once), and the Hub's policy answers by kind. */
  readonly asked: readonly Kind[]; readonly policy: readonly { readonly kind: Kind; readonly answer: string }[];
  readonly fileEdited: boolean | null; readonly commandRan: boolean; readonly tools: readonly { readonly kind: string | null; readonly status: string }[];
  readonly replyBytes: number; readonly observed: Readonly<Record<string, string>> | null; readonly effortWanted?: Readonly<Record<string, string>>; readonly checks: Readonly<Record<string, boolean>>; readonly pass: boolean;
}
function record(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
/** A one-time allow, never a standing rule: the approval must not outlive this workspace. */
function allowOnce(options: readonly { readonly id: string; readonly name: string }[]): string | null {
  return options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name))?.id ?? null;
}
const TASK = (marker: string, from: string, to: string) => "这是一次权限档位验收，只在当前工作目录内操作：\n1. 用命令行工具照原样运行 `sh -c 'date +" + marker + "-%s'`。\n2. 用你的文件编辑工具（不要用 shell 命令）把 notes.txt 里的 " + from + " 改成 " + to + "。\n"
  + "需要权限时按你平常的方式申请；申请被拒绝后不要再试，也不要换别的办法，跳过那一步。完成后用一句话回复，带上命令的输出（如果有）。";
const READ_ONLY_TASK = (marker: string) => "这是一次只读的权限档位验收：用你的命令执行工具照原样运行 `sh -c 'date +" + marker + "-%s'`，不要做其他任何操作。需要权限时按你平常的方式申请，被拒绝后不要再试。然后只回复命令输出。";

test("every permission level is carried out on every Harness by its declaration", { timeout: 6 * 60 * 60 * 1000 }, async () => {
  assert.ok(harnesses.length, "set HH_REAL_HARNESSES to the installed Harness identities under acceptance");
  assert.ok(evidencePath, "set HH_REAL_EVIDENCE to an ignored evidence file path"); guardTargets(harnesses);
  for (const level of [...levels, ...switches.flat()]) assert.ok((PERMISSION_LEVELS as readonly string[]).includes(level), "unknown permission level " + level);
  if (effort !== undefined) assert.ok((EFFORT_LEVELS as readonly string[]).includes(effort), "unknown effort level " + effort);
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-levels-")));
  const cells: Cell[] = [], failures: string[] = [], guards: Record<string, GuardCheck> = {};
  let header: EvidenceHeader | null = null;
  const save = async () => {
    await writeFile(evidencePath, JSON.stringify({ header, effort: effort ?? null, cells, guards }, null, 2) + "\n", { mode: 0o600 });
    await writeFile(evidencePath + ".md", markdown(cells), { mode: 0o600 });
  };
  try {
    for (const harnessId of harnesses) {
      const before = await snapshot([harnessId], environment), base = join(root, harnessId);
      await mkdir(join(base, "first"), { recursive: true });
      let app: ReturnType<typeof composeApplication> | undefined, server: WebServer | undefined;
      try {
        const configuration = await prepareConfiguration({ workspace: join(base, "first"), ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
        server = await startWebServer({ root: join(base, "data"), configuration, port: 0, installations: realInstallations, workspaceLockRoot: join(base, "locks"),
          application: (data, publish) => (app = composeApplication(data, publish, { installations: realInstallations, workspaceLockRoot: join(base, "locks") })) });
        header ??= await evidenceHeader(app!, harnesses, { configuration });
        const api = await login(server);
        const model = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
        const selection = (level: PermissionLevel) => ({ harnessId, ...(model === undefined ? {} : { nativeModel: model }),
          nativeOptions: { [PERMISSION_KEY]: level, ...(effort === undefined ? {} : { [EFFORT_KEY]: effort }) } });
        const readOnly = readOnlyHarnesses.has(harnessId);
        // With an effort level: the native value the declaration makes it on the catalog the page reads (the model's options), which the session must report running.
        let effortWanted: Readonly<Record<string, string>> | null = null;
        if (effort !== undefined) {
          const catalog = await api.get(`/harnesses/${harnessId}/models?` + new URLSearchParams({ workspace: join(base, "first"), ...(model === undefined ? {} : { nativeModel: model }) }));
          const models = Array.isArray(catalog.models) ? catalog.models as { id: string; options?: NativeOption[] }[] : [];
          const running = model ?? (typeof catalog.defaultModel === "string" ? catalog.defaultModel : undefined);
          const options = [...(Array.isArray(catalog.options) ? catalog.options as NativeOption[] : []), ...(models.find(row => row.id === running)?.options ?? [])];
          effortWanted = nativeLevels(catalog.flavor as HarnessFlavor, options).effort.find(entry => entry.level === effort)?.options ?? {};
        }
        // A cell that fails to run is recorded with its conversation's last Turn, and the next cell goes on.
        const attempt = async (level: PermissionLevel, step: Cell["step"], from: PermissionLevel | undefined, body: (holder: { id?: SessionId }) => Promise<Cell>) => {
          const holder: { id?: SessionId } = {};
          let cell: Cell;
          try { cell = await body(holder); }
          catch (error) {
            let last: PublicRun | undefined;
            try { if (holder.id !== undefined) last = oldShape(app!.runtime, holder.id).runs.at(-1); } catch { /* unreadable */ }
            cell = { harnessId, level, step, ...(from === undefined ? {} : { from }), status: "error", error: (error instanceof Error ? error.message.slice(0, 200) : "failed") + (last === undefined ? "" : " [last Turn " + last.status + (last.error == null ? "" : " " + last.error.code) + "]"),
              asked: [], policy: [], fileEdited: null, commandRan: false, tools: [], replyBytes: 0, observed: null, checks: {}, pass: false };
          }
          cells.push(cell); if (!cell.pass) failures.push(harnessId + " " + (from === undefined ? "" : from + ">") + level + ": " + (cell.error ?? failed(cell))); await save();
        };
        // One conversation per level.
        for (const level of levels) await attempt(level, "level", undefined, async holder => {
          const workspace = await freshWorkspace(base, level);
          const id = holder.id = await api.create(workspace, selection(level));
          return turn(app!, api, id, workspace, harnessId, level, "level", readOnly ? READ_ONLY_TASK("HH-LEVEL-CMD") : TASK("HH-LEVEL-CMD", "bravo", "delta"), "HH-LEVEL-CMD", readOnly ? null : [1, "delta"], effortWanted);
        });
        // A level changed between two Turns of one conversation: the second Turn runs at the new level.
        for (const [from, to] of switches) await attempt(to, "switched", from, async holder => {
          const workspace = await freshWorkspace(base, from + "-" + to);
          const id = holder.id = await api.create(workspace, selection(from));
          const first = await turn(app!, api, id, workspace, harnessId, from, "level", readOnly ? READ_ONLY_TASK("HH-LEVEL-CMD") : TASK("HH-LEVEL-CMD", "bravo", "delta"), "HH-LEVEL-CMD", readOnly ? null : [1, "delta"], effortWanted);
          await api.post(`/sessions/${id}/switches`, { selection: selection(to), commandId: "switch-" + randomUUID() });
          return turn(app!, api, id, workspace, harnessId, to, "switched", readOnly ? READ_ONLY_TASK("HH-LEVEL-CMD2") : TASK("HH-LEVEL-CMD2", "charlie", "foxtrot"), "HH-LEVEL-CMD2", readOnly ? null : [2, "foxtrot"], effortWanted, from, first);
        });
      } catch (error) {
        cells.push({ harnessId, level: levels[0]!, step: "level", status: "error", error: error instanceof Error ? error.message.slice(0, 300) : "failed", asked: [], policy: [], fileEdited: null, commandRan: false, tools: [], replyBytes: 0, observed: null, checks: {}, pass: false });
        failures.push(harnessId + ": " + (error instanceof Error ? error.message.slice(0, 200) : "failed"));
      } finally {
        try { await server?.close(); } catch (error) { failures.push(harnessId + ": server close " + String(error).slice(0, 120)); }
        const guard = await recheck(before, environment); guards[harnessId] = guard;
        if (!guard.unchanged) failures.push(harnessId + ": " + describeGuard(guard));
        await save();
      }
    }
  } finally { if (process.env.HH_REAL_KEEP !== "1") await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(failures, [], "levels acceptance failed");
});

async function freshWorkspace(base: string, name: string): Promise<string> {
  const workspace = join(base, "ws-" + name);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "alpha\nbravo\ncharlie\n");
  return realpath(workspace);
}
interface Api { create(workspace: string, selection: unknown): Promise<SessionId>; post(path: string, input: unknown): Promise<Record<string, unknown>>; get(path: string): Promise<Record<string, unknown>> }
/** Logs in to the Gateway as the page does (the bootstrap token of its start link), and speaks its HTTP API. */
async function login(server: WebServer): Promise<Api> {
  const start = new URL(server.url), origin = start.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(start.hash.slice(1)).get("token") }) });
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String(record(await boot.json()).csrfToken);
  const post = async (path: string, input: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(origin + "/api/v1" + path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(input) });
    const text = await response.text();
    if (!response.ok) throw new Error("POST " + path.replace(/session-[\w-]+/u, ":id").replace(/permission-[\w-]+/u, ":permission") + " " + response.status + " " + text.slice(0, 200));
    return record(JSON.parse(text));
  };
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(origin + "/api/v1" + path, { headers: { Cookie: cookie, Origin: origin } });
    const text = await response.text();
    if (!response.ok) throw new Error("GET " + path.split("?")[0] + " " + response.status + " " + text.slice(0, 200));
    return record(JSON.parse(text));
  };
  return { post, get, create: async (workspace, selection) => record((await post("/sessions", { workspace, selection, commandId: "create-" + randomUUID() })).head).id as SessionId };
}
/** Sends one message, answers what reaches the user once (allow once), waits for the Turn to settle, and judges it. */
async function turn(app: ReturnType<typeof composeApplication>, api: Api, id: SessionId, workspace: string, harnessId: string, level: PermissionLevel, step: Cell["step"], text: string, marker: string,
  edit: readonly [number, string] | null, effortWanted: Readonly<Record<string, string>> | null, from?: PermissionLevel, previous?: Cell): Promise<Cell> {
  const runsBefore = oldShape(app.runtime, id).runs.length, afterSeq = lastSeq(app, id), started = Math.floor(Date.now() / 1000);
  await api.post(`/sessions/${id}/messages`, { text, commandId: "send-" + randomUUID() });
  const deadline = Date.now() + 10 * 60 * 1000, answered = new Set<string>();
  let run: PublicRun | undefined;
  for (;;) {
    for (const request of app.runtime.permissionRequests(id).filter(item => !item.decided && !answered.has(item.id))) {
      answered.add(request.id);
      const option = allowOnce(request.options);
      if (option === null) throw new Error("no one-time allow among the request's options");
      try { await api.post(`/sessions/${id}/permissions/${request.id}`, { optionId: option, commandId: "allow-" + randomUUID() }); }
      catch (error) { if (!/40[49]/u.test(String(error))) throw error; /* the Hub's policy answered it meanwhile */ }
    }
    const runs = oldShape(app.runtime, id).runs;
    run = runs.length > runsBefore ? runs.at(-1) : undefined;
    if (run !== undefined && TERMINAL.has(run.status)) { await app.runtime.wait(id); run = oldShape(app.runtime, id).runs.at(-1)!; break; }
    if (Date.now() > deadline) throw new Error("the Turn did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const ended = Math.ceil(Date.now() / 1000) + 60;
  const events = eventsAfter(app, id, afterSeq).filter(row => row.data.runId === undefined || row.data.runId === run!.id);
  const requested = new Map(events.filter(row => row.type === "permission.requested").map(row => [String(row.data.permissionId), String(row.data.kind ?? "other") as Kind]));
  const decided = events.filter(row => row.type === "permission.decided");
  const policy = decided.filter(row => row.data.by === "policy").map(row => ({ kind: String(row.data.kind ?? requested.get(String(row.data.permissionId)) ?? "other") as Kind, answer: String(row.data.answer ?? "?") }));
  const byPolicy = new Set(decided.filter(row => row.data.by === "policy").map(row => String(row.data.permissionId)));
  const asked = [...requested.entries()].filter(([permission]) => !byPolicy.has(permission)).map(([, kind]) => kind);
  const tools = run.tools ?? [];
  // The command ran when its output (a time stamp of this Turn's own time) is in a stored tool detail.
  const pattern = new RegExp(marker + "-(\\d{10})", "u");
  let commandRan = false;
  for (const tool of tools) {
    if (tool.detail === undefined) continue;
    const parsed = record(JSON.parse(await readFile(app.content.read(tool.detail.id).path, "utf8")));
    const stamp = typeof parsed.output === "string" ? pattern.exec(parsed.output)?.[1] : undefined;
    if (stamp !== undefined && Number(stamp) >= started - 60 && Number(stamp) <= ended) commandRan = true;
  }
  const lines = (await readFile(join(workspace, "notes.txt"), "utf8")).split("\n");
  const fileEdited = edit === null ? null : lines[edit[0]] === edit[1];
  const state = oldShape(app.runtime, id), reply = state.messages.find(row => row.id === run!.assistantMessageId)?.text ?? "";
  const binding = app.store.get(id).nativeBindings?.find(item => item.harnessId === harnessId && item.status !== "archived");
  const expected = (from === undefined ? undefined : EXPECTED_SWITCHED[harnessId]?.[from + ">" + level]) ?? EXPECTED[harnessId]?.[level];
  const checks: Record<string, boolean> = { completed: run.status === "completed" };
  if (expected !== undefined) {
    checks.asks = sameSet(asked.filter(kind => kind === "edit" || kind === "execute"), expected.asks) && asked.every(kind => kind === "edit" || kind === "execute");
    if (expected.file !== null && fileEdited !== null) checks.file = fileEdited === expected.file;
    if (expected.command !== null) checks.command = commandRan === expected.command;
  }
  if (previous !== undefined) checks.firstTurn = previous.status === "completed";
  // The thinking value the session reports running is the one the effort level comes to (judged where the Harness reports it).
  const observed = binding?.observed?.options ?? null;
  if (effortWanted !== null) for (const [option, value] of Object.entries(effortWanted)) if (observed?.[option] !== undefined) checks.effort = observed[option] === value;
  return { harnessId, level, step, ...(from === undefined ? {} : { from }), status: run.status, ...(run.error == null ? {} : { error: String(run.error.code) }),
    asked, policy, fileEdited, commandRan, tools: tools.map(tool => ({ kind: tool.kind ?? null, status: tool.status })), replyBytes: Buffer.byteLength(reply),
    observed, ...(effortWanted === null ? {} : { effortWanted }), checks, pass: Object.values(checks).every(Boolean) };
}
function lastSeq(app: ReturnType<typeof composeApplication>, id: SessionId): number { const rows = eventsAfter(app, id, 0); return rows.at(-1)?.seq ?? 0; }
function eventsAfter(app: ReturnType<typeof composeApplication>, id: SessionId, after: number): SessionEvent[] {
  const rows: SessionEvent[] = [];
  for (let at = after; ;) { const page = app.store.events(id, at, 200); if (!page.length) break; rows.push(...page); at = page.at(-1)!.seq; }
  return rows;
}
function sameSet(left: readonly string[], right: readonly string[]): boolean { const a = new Set(left), b = new Set(right); return a.size === b.size && [...a].every(item => b.has(item)); }
function failed(cell: Cell): string { return Object.entries(cell.checks).filter(([, passed]) => !passed).map(([name]) => name).join(",") + (cell.error ? " (" + cell.error + ")" : ""); }

const KIND_WORDS: Readonly<Record<string, string>> = { edit: "改文件", execute: "命令", read: "读", network: "联网", tool: "工具", other: "其他" };
const NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", dsh: "DeepSeek Harness", hermes: "Hermes", openclaw: "OpenClaw" };
/** One cell for the matrix: pass or not, then what was asked, what the Hub answered, and what happened. */
function words(cell: Cell): string {
  if (cell.status === "error") return "✗ 出错";
  const asked = cell.asked.length === 0 ? "没问" : "问了" + [...new Set(cell.asked)].map(kind => KIND_WORDS[kind] ?? kind).join("、");
  const policy = cell.policy.length === 0 ? "" : "；Hub " + [...new Set(cell.policy.map(row => (row.answer === "allow" ? "允许" : row.answer === "deny" ? "拒绝" : row.answer) + KIND_WORDS[row.kind]))].join("、");
  const file = cell.fileEdited === null ? "" : cell.fileEdited ? "；改了文件" : "；没改文件";
  return (cell.pass ? "✓ " : "✗ ") + asked + policy + file + (cell.commandRan ? "；命令跑了" : "；命令没跑") + (cell.status === "completed" ? "" : "；回合" + cell.status) + (cell.pass ? "" : "（不符：" + failed(cell) + "）");
}
function markdown(cells: readonly Cell[]): string {
  const ids = [...new Set(cells.map(cell => cell.harnessId))];
  const head = "| 档位 | " + ids.map(id => NAMES[id] ?? id).join(" | ") + " |\n|---|" + ids.map(() => "---|").join("") + "\n";
  const rows = [...new Set(cells.filter(cell => cell.step === "level").map(cell => cell.level))].map(level =>
    "| " + PERMISSION_WORDS[level] + " | " + ids.map(id => { const cell = cells.find(row => row.harnessId === id && row.step === "level" && row.level === level); return cell === undefined ? "—" : words(cell); }).join(" | ") + " |");
  const switched = [...new Set(cells.filter(cell => cell.step === "switched").map(cell => cell.from + ">" + cell.level))].map(pair => {
    const [from, to] = pair.split(">") as [PermissionLevel, PermissionLevel];
    return "| 中途 " + PERMISSION_WORDS[from] + "→" + PERMISSION_WORDS[to] + " | " + ids.map(id => { const cell = cells.find(row => row.harnessId === id && row.step === "switched" && row.from === from && row.level === to); return cell === undefined ? "—" : words(cell); }).join(" | ") + " |";
  });
  return head + [...rows, ...switched].join("\n") + "\n" + (effort === undefined ? "" : "\n思考档：每个对话都带「" + EFFORT_WORDS[effort] + "」。\n");
}
