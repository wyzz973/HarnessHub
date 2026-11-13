import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { application as composeApplication } from "../../src/cli/session-application.js";
import { RESEAT_AT } from "../../src/contexts/session/application/runtime.js";
import { PERMISSION_KEY } from "../../src/contracts/flavor.js";
import { WORK_TYPES, type ProtocolItem } from "../../src/contracts/protocol.js";
import type { SessionId } from "../../src/contracts/session.js";
import { TABLE_COMMAND_DIR, TABLE_PROGRESS_TOOLS, inRecord } from "../../src/contracts/table.js";
import type { HarnessView, ItemView, RunItemsPageView, SessionListView, SessionSummary, SessionViewV14 } from "../../src/contracts/web.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { captureNativeEnvironment } from "../../src/infrastructure/session/native-environment.js";
import { MemoryTableGrants } from "../../src/infrastructure/session/table-grants.js";
import { TableMount } from "../../src/infrastructure/table/mount.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { describeGuard, evidenceHeader, guardTargets, recheck, snapshot, type EvidenceHeader, type GuardCheck } from "./guard.js";

/**
 * The delegation ruler (pnpm test:real:delegation; docs/verification/delegation-ruler.md): whether what one Harness knows reaches another when
 * they work together by delegation, measured on the user's installed Harnesses through the Gateway's own HTTP API (the page's path) on a Gateway
 * of its own (a free port, its data, its context table and its tool command in a temporary directory away from the workspaces). Each scenario runs
 * in a fresh workspace and is judged objectively: files on disk, a random mark in a reply that only the context can give, and the Turn's own items.
 * A pass reached by a call outside the workspace (a path above it, the environment, the network) does not count (`honest`). The evidence also says
 * which build's tool program each Harness's user-level `harnesshub` entry runs, when it has one (`userToolProgram`). It is a gauge, not a gate: a
 * scenario that does not pass is recorded and the run goes on; the run fails only when a scenario could not run at all (a Turn that failed or did
 * not settle, an API error), or when the user's Harness configuration changed (./guard.ts).
 *
 * Outside the sandbox, from the repository root after `pnpm build`:
 *   . "$HOME/.cache/harnesshub-acceptance/env.sh"
 *   RUN HH_REAL_MODEL_CLAUDE=haiku node --test dist/tests/real/delegation-context.real.js
 *
 * HH_RULER_A / HH_RULER_B / HH_RULER_C: the parent conversation's Harness, the delegated one and a second delegated one (claude, dsh, codex);
 * a role whose Harness is not usable here skips the scenarios that need it. HH_REAL_MODEL_<ID>: a model per Harness. HH_RULER_LEVEL: the
 * permission level of every conversation (auto). HH_RULER_SCENARIOS=S1,S3: only these. HH_RULER_EVIDENCE: where the JSON evidence goes
 * (~/.cache/harnesshub-acceptance/evidence/delegation-ruler-<time>.json by default; a Markdown table is written beside it). HH_REAL_KEEP=1
 * keeps the temporary directory.
 */
const setting = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;
const ROLES = { A: setting("HH_RULER_A", "claude"), B: setting("HH_RULER_B", "dsh"), C: setting("HH_RULER_C", "codex") } as const;
type Role = keyof typeof ROLES;
const LEVEL = setting("HH_RULER_LEVEL", "auto");
const ONLY = new Set((process.env.HH_RULER_SCENARIOS ?? "").split(",").map(value => value.trim().toUpperCase()).filter(Boolean));
const TURN_MINUTES = Number(setting("HH_RULER_TURN_MINUTES", "10"));
const STARTED = new Date();
const evidencePath = process.env.HH_RULER_EVIDENCE?.trim()
  || join(homedir(), ".cache", "harnesshub-acceptance", "evidence", "delegation-ruler-" + STARTED.toISOString().replace(/[:.]/gu, "-") + ".json");
const realInstallations = process.env.HH_REAL_MANIFEST ? "any" as const : "official" as const;
const environment = captureNativeEnvironment();

type Verdict = "过" | "不过" | "跳过" | "作废" | "出错";
/**
 * A tool call of a Turn as the ruler judges it: `call` is the item's own fields (what was called, with what), `text` those and its stored detail
 * (input and output); both are searched and never written to the evidence.
 */
interface Work { readonly type: string; readonly label: string; readonly hub: boolean; readonly progress: boolean; readonly call: string; readonly text: string }
interface Turn {
  readonly sessionId: string; readonly workspace: string; readonly role: Role; readonly harnessId: string; readonly ordinal: number; readonly status: string; readonly error: string | null;
  readonly user: string; readonly reply: string; readonly work: readonly Work[]; readonly notices: readonly string[]; readonly ms: number | null;
}
interface Judged { readonly verdict: Verdict; readonly reason: string; readonly note?: string; readonly checks?: Readonly<Record<string, unknown>> }
interface Scenario { readonly id: string; readonly name: string; readonly measures: string; readonly roles: readonly Role[]; run(ruler: Ruler): Promise<Judged> }
interface Outcome extends Judged {
  readonly id: string; readonly name: string; readonly measures: string; readonly ms: number;
  readonly turns: readonly { readonly role: Role; readonly harnessId: string; readonly sessionId: string; readonly ordinal: number; readonly status: string; readonly error: string | null;
    readonly ms: number | null; readonly user: string; readonly reply: string; readonly work: readonly { readonly type: string; readonly label: string; readonly hub: boolean; readonly outside: boolean }[]; readonly notices: readonly string[] }[];
}
/** The measurement's own precondition did not hold (the model did not do the base task, or said what it was told to keep back): nothing was measured. */
class Voided extends Error {}
/** The scenario could not run: a Turn that failed or did not settle, an answer of the API that was not expected. */
class Broken extends Error {}

/** Plain words for material that has no regularity to work an answer out from (S12): drawn at random, a line is no function of the lines before it. */
const WORDS = ("river stone window paper garden silver morning travel coffee bridge letter winter market circle yellow anchor candle forest harbor island jacket kitchen ladder mirror needle orange pencil "
  + "quiet rabbit saddle ticket umbrella valley wagon zipper basket copper dinner engine feather guitar hammer insect jungle kettle lantern magnet napkin ocean pepper quilt ribbon shadow thunder velvet whistle "
  + "apple border cabin desert eagle fabric glove honey iron jewel knife lemon marble north olive piano queen radio salt table uncle violin water xenon yard zebra").split(" ");
const pass = (reason: string, note?: string, checks?: Record<string, unknown>): Judged => ({ verdict: "过", reason, ...(note === undefined ? {} : { note }), ...(checks === undefined ? {} : { checks }) });
const fail = (reason: string, note?: string, checks?: Record<string, unknown>): Judged => ({ verdict: "不过", reason, ...(note === undefined ? {} : { note }), ...(checks === undefined ? {} : { checks }) });
const mark = (prefix: string): string => prefix + "-" + randomBytes(4).toString("hex").toUpperCase();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clip = (text: string, most: number): string => { const units = [...text]; return units.length > most ? units.slice(0, most).join("") + "…" : text; };
function need(turn: Turn): Turn {
  if (turn.status !== "completed") throw new Broken(turn.role + "（" + turn.harnessId + "）第 " + (turn.ordinal + 1) + " 轮 " + turn.status + (turn.error === null ? "" : " " + turn.error));
  return turn;
}
/**
 * The tool calls that give a Harness information: everything but the Hub's own task list and wrap-up, which only show progress, and a
 * Harness's loading of its own tool definitions (Claude Code's ToolSearch, which it calls before a deferred tool such as the wrap-up).
 */
const META_TOOLS = new Set(["ToolSearch"]);
const informing = (turn: Turn): readonly Work[] => turn.work.filter(work => !work.progress && !(work.type === "tool" && META_TOOLS.has(work.label)));
/**
 * Whether a command line is the conversation's own Hub command and nothing else (a Harness that has the Hub's tools as a command, HubToolsEntry `cli`): each part of it
 * calls that command, a variable that holds its path, or says a line between two calls.
 */
function commandOnly(line: string): boolean {
  const tool = new RegExp("/" + TABLE_COMMAND_DIR + "/[0-9a-f]{16}/hub(\\s|;|$)", "u");
  if (!tool.test(line) || /[`<>]|\$\(/u.test(line)) return false;
  return line.split(/;|&&|\|/u).map(part => part.trim()).filter(Boolean).every(part => tool.test(part) || /^\$\{?[A-Za-z_]\w*\}?(\s|$)/u.test(part) || /^(echo|printf|head|tail)(\s|$)/u.test(part));
}
/** A call by its type and what it names; a path inside the record's directory from the directory on, which is what tells one read from another. */
const listed = (works: readonly Work[]): string => works.map(work => work.type + (work.label ? " " + clip(work.label.replace(/\S*\/context\/(c-[0-9a-f]{6}\/)/gu, "记录:$1"), 80) : "")).join("；");

// ---------------------------------------------------------------------------------------------------------------------
// The workspace on disk
// ---------------------------------------------------------------------------------------------------------------------

/** Every file under the workspace but those under a dot-directory or with a dot-name (a Harness's own state), by its path from the workspace. */
async function files(root: string): Promise<Map<string, { readonly mtimeMs: number; readonly size: number }>> {
  const found = new Map<string, { mtimeMs: number; size: number }>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { const info = await stat(path); found.set(relative(root, path), { mtimeMs: info.mtimeMs, size: info.size }); }
    }
  };
  await walk(root);
  return found;
}
const added = (before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): string[] => [...after.keys()].filter(path => !before.has(path)).sort();
const lines = async (path: string): Promise<string[] | null> => { try { return (await readFile(path, "utf8")).split(/\r?\n/u).map(line => line.trim()).filter(Boolean); } catch { return null; } };
/** The part of a file name a reply would name it by: the name without its extension when that still holds the random letters, else the name. */
const stem = (path: string): string => { const name = basename(path), bare = name.slice(0, name.length - extname(name).length); return bare.length >= 6 ? bare : name; };

/** A call that lists or searches the file system (what S4 asks the Harness not to do to find the file). */
const LISTING = /(^|[\s;|&(`])(ls|find|fd|tree|locate|mdfind|stat|du)(\s|$)|git\s+(status|ls-files|diff)|rg\s+(--files|-l)|grep\s+-[a-zA-Z]*[rlL]|\*/u;
async function lists(work: Work, workspace: string): Promise<boolean> {
  if (work.hub) return false;
  if (work.type === "search") return true;
  if (work.type === "command") return LISTING.test(work.label);
  if (work.type === "tool") return /glob|list|\bls\b|tree|dir|find/iu.test(work.label);
  if (work.type === "file_read" && work.label) {
    try { return (await stat(isAbsolute(work.label) ? work.label : join(workspace, work.label))).isDirectory(); } catch { return false; }
  }
  return false;
}
/**
 * A call that reaches outside the conversation's workspace: a path above it or elsewhere (the Hub's data, another Harness's transcripts), the
 * environment (the Hub's address and token), or the network. A Harness that finds what it was asked for that way did not have it from the context
 * (2026-11-13 baseline: DeepSeek Harness grepped the Hub's data directory for the parent's words when it sat next to the workspace).
 */
const ABROAD = /(^|[\s'"=(/])\.\.(\/|[\s'"]|$)|~\/|\$HOME|HARNESSHUB_|(^|[\s;|&(`])(env|printenv|curl|wget|nc|sqlite3|osascript)(\s|$)/u;
const SYSTEM_PATH = /^\/(dev|bin|sbin|usr|System|opt\/homebrew\/(bin|opt))(\/|$)/u;
/** `data`: the unique name of the Gateway's data directory, which no call of a Harness has a reason to name. */
function outside(work: Work, workspace: string, data: string): boolean {
  if (work.hub) return false;
  if (work.call.includes(data) || work.text.includes(data)) return true;
  if (work.type === "command" || work.type === "tool") {
    if (ABROAD.test(work.label)) return true;
    for (const match of work.label.matchAll(/(?:^|[\s'"=(<>|;&:])(\/[^\s'"|;&)<>]*)/gu)) {
      const path = match[1]!;
      if (path === "/" || (!path.startsWith(workspace) && !SYSTEM_PATH.test(path))) return true;
    }
    return false;
  }
  // A read, a change or a search names its path: one outside the workspace is abroad.
  return work.label.split(/,\s*|\s+/u).some(part => isAbsolute(part) && !part.startsWith(workspace) && !SYSTEM_PATH.test(part));
}
/** A pass found by reaching outside the workspace is not one: the scenario measures the context, not the file system. */
function honest(judged: Judged, turns: readonly Turn[], data: string): Judged {
  const away = turns.flatMap(turn => turn.work.filter(work => outside(work, turn.workspace, data)).map(work => turn.role + " " + work.type + " " + clip(work.label, 80)));
  if (away.length === 0) return judged;
  const note = (judged.note ? judged.note + "；" : "") + "越出工作区：" + away.join("；");
  return judged.verdict === "过" ? { ...judged, verdict: "不过", reason: "靠工作区外的文件或环境做到的（" + judged.reason + "）", note } : { ...judged, note };
}

/**
 * Where a Harness's user-level `harnesshub` entry (written from the capability page, src/infrastructure/capabilities/hub-tools.ts) runs the Hub's
 * tool program from: `this build`, another build's path (with ~), `none`, or `not checked` (a Harness whose file the ruler does not read). Codex keeps
 * an enabled entry of that name over the one the Hub gives each thread (src/adapters/control/codex.ts threadEntry), so its tools are that build's.
 * Only the one path is read out of each file.
 */
const THIS_TOOL = fileURLToPath(new URL("../../src/cli/hub-tools.js", import.meta.url));
async function userToolProgram(harnessId: string): Promise<string> {
  const home = homedir(), shown = (path: string) => path === THIS_TOOL ? "this build" : path.startsWith(home) ? "~" + path.slice(home.length) : path;
  const fromArgs = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") return "none";
    const { args, enabled } = entry as { readonly args?: unknown; readonly enabled?: unknown };
    const tool = Array.isArray(args) ? args.find((arg): arg is string => typeof arg === "string" && arg.endsWith("hub-tools.js")) : undefined;
    return enabled === false ? "none (disabled)" : tool === undefined ? "other program" : shown(tool);
  };
  try {
    if (harnessId === "claude") return fromArgs((JSON.parse(await readFile(join(home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.harnesshub);
    if (harnessId === "codex") return fromArgs((parseToml(await readFile(join(home, ".codex", "config.toml"), "utf8")) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.harnesshub);
    if (harnessId === "dsh") {
      const text = await readFile(join(home, ".dsh", "cordis.patch.yml"), "utf8").catch(() => null), tool = text === null ? null : /[^\s'"]*hub-tools\.js/u.exec(text)?.[0] ?? null;
      return tool === null ? "none" : shown(tool);
    }
  } catch { return "unreadable"; }
  return "not checked";
}

// ---------------------------------------------------------------------------------------------------------------------
// The Gateway's HTTP API
// ---------------------------------------------------------------------------------------------------------------------

interface Api { post(path: string, input: unknown): Promise<unknown>; get(path: string): Promise<unknown> }
/** Logs in to the Gateway as the page does (the bootstrap token of its start link), and speaks its HTTP API. */
async function login(server: WebServer): Promise<Api> {
  const start = new URL(server.url), origin = start.origin;
  const boot = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: new URLSearchParams(start.hash.slice(1)).get("token") }) });
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";", 1)[0]!, csrf = String((await boot.json() as { csrfToken: string }).csrfToken);
  const shown = (path: string) => path.split("?")[0]!.replace(/session-[\w-]+/gu, ":id").replace(/permission-[\w-]+/gu, ":permission");
  return {
    post: async (path, input) => {
      const response = await fetch(origin + "/api/v1" + path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(input) });
      const text = await response.text();
      if (!response.ok) throw new Broken("POST " + shown(path) + " " + response.status + " " + text.slice(0, 200));
      return JSON.parse(text) as unknown;
    },
    get: async path => {
      const response = await fetch(origin + "/api/v1" + path, { headers: { Cookie: cookie, Origin: origin } });
      const text = await response.text();
      if (!response.ok) throw new Broken("GET " + shown(path) + " " + response.status + " " + text.slice(0, 200));
      return JSON.parse(text) as unknown;
    },
  };
}
type App = ReturnType<typeof composeApplication>;
/** A one-time allow, never a standing rule: the approval must not outlive this workspace. */
function allowOnce(options: readonly { readonly id: string; readonly name: string }[]): string | null {
  return options.find(option => /^(allow|accept|approve|once|yes|proceed)/iu.test(option.id) && !/\b(always|session|forever|remember)\b/iu.test(option.id + " " + option.name))?.id ?? null;
}

/** What one scenario does with the Gateway: workspaces, conversations, messages, delegations, and the Turns as their items tell them. */
class Ruler {
  turns: Turn[] = [];
  private readonly cleanup: string[] = [];
  constructor(private readonly api: Api, private readonly app: App, private readonly root: string, readonly names: ReadonlyMap<string, string>) {}
  harness(role: Role): string { return ROLES[role]; }
  name(role: Role): string { return this.names.get(ROLES[role]) ?? ROLES[role]; }
  selection(role: Role): Record<string, unknown> {
    const harnessId = ROLES[role], model = process.env["HH_REAL_MODEL_" + harnessId.toUpperCase()];
    return { harnessId, ...(model === undefined ? {} : { nativeModel: model }), nativeOptions: { [PERMISSION_KEY]: LEVEL } };
  }
  async workspace(name: string, seed: Readonly<Record<string, string>> = {}): Promise<string> {
    const path = join(this.root, "ws-" + name + "-" + randomBytes(3).toString("hex"));
    await mkdir(path, { recursive: true });
    for (const [file, content] of Object.entries(seed)) await writeFile(join(path, file), content);
    this.cleanup.push(path);
    return realpath(path);
  }
  async done(): Promise<void> { if (process.env.HH_REAL_KEEP !== "1") for (const path of this.cleanup.splice(0)) await rm(path, { recursive: true, force: true }); }
  /** A new conversation of the role's Harness in the workspace. */
  async open(role: Role, workspace: string): Promise<string> {
    const view = await this.api.post("/sessions", { workspace, selection: this.selection(role), commandId: "create-" + randomUUID() }) as SessionViewV14;
    return view.head.id;
  }
  async head(id: string): Promise<SessionViewV14["head"]> { return (await this.api.get("/sessions/" + id) as SessionViewV14).head; }
  /** Sends a message without waiting; the ordinal its Turn will have. */
  async send(id: string, text: string): Promise<number> {
    const before = (await this.head(id)).runCount;
    await this.api.post("/sessions/" + id + "/messages", { text, commandId: "send-" + randomUUID() });
    return before;
  }
  /** Sends a message and waits for its Turn to settle. */
  async say(id: string, role: Role, text: string): Promise<Turn> {
    const before = await this.send(id, text);
    await this.settle([id], new Map([[id, before + 1]]));
    return this.turnOf(id, role, before);
  }
  /** Sets, for the Gateway of this run, how full a native session may be before the Hub opens a new one (undefined: as the Gateway was started). */
  reseatAt(share: number | undefined): void { this.app.runtime.setReseatAt(share); }
  /** How full the Harness said its window was at the end of a Turn; null when it told of no window. */
  async window(id: string, ordinal: number): Promise<{ readonly used: number; readonly size: number } | null> {
    const context = (await this.api.get("/sessions/" + id) as SessionViewV14).window.turns.find(turn => turn.run.ordinal === ordinal)?.run.turn.usage.context;
    return context === undefined || typeof context.size !== "number" || context.size <= 0 ? null : { used: context.used, size: context.size };
  }
  /** Writes a constraint on the task's board as the user does from the page. */
  async note(id: string, text: string): Promise<void> { await this.api.post("/sessions/" + id + "/task", { kind: "constraint", text }); }
  /** Switches the conversation to the role's Harness as the page does (the user's switch): its next message goes to that Harness. */
  async switchTo(id: string, role: Role): Promise<void> {
    await this.api.post("/sessions/" + id + "/switches", { selection: this.selection(role), commandId: "switch-" + randomUUID() });
  }
  /** Delegates from a conversation to the role's Harness as the page does (the user's delegation), and waits for the task's Turn to settle. */
  async delegate(from: string, role: Role, text: string): Promise<{ readonly id: string; readonly turn: Turn }> {
    const view = await this.api.post("/sessions/" + from + "/delegate", { selection: this.selection(role), text, commandId: "delegate-" + randomUUID(), messageCommandId: "task-" + randomUUID() }) as SessionViewV14;
    const id = view.head.id;
    if (view.head.parent?.sessionId !== from) throw new Broken("the delegated conversation does not name its parent");
    await this.settle([id], new Map([[id, 1]]));
    return { id, turn: await this.turnOf(id, role, 0) };
  }
  /** The conversations a conversation delegated, from the list. */
  async children(id: string): Promise<SessionSummary[]> {
    const found: SessionSummary[] = [];
    for (let after: string | null = null, pages = 0; pages < 20; pages++) {
      const page = await this.api.get("/sessions?limit=100" + (after === null ? "" : "&after=" + encodeURIComponent(after))) as SessionListView;
      found.push(...page.sessions.filter(row => row.parent?.sessionId === id));
      if (page.next === null) break;
      after = page.next;
    }
    return found;
  }
  /**
   * Waits until every conversation has at least the Turns wanted and none runs, answering what reaches the user once (allow once). `discover`
   * adds conversations as they appear (each wants one Turn); `settled` is called once per conversation when it first has settled.
   */
  async settle(ids: string[], want: Map<string, number>, options: { readonly discover?: () => Promise<readonly string[]>; readonly settled?: (id: string) => Promise<void> } = {}): Promise<void> {
    const deadline = Date.now() + TURN_MINUTES * 60 * 1000, answered = new Set<string>(), fired = new Set<string>();
    for (;;) {
      for (const id of await options.discover?.() ?? []) if (!ids.includes(id)) { ids.push(id); want.set(id, 1); }
      let all = true;
      for (const id of ids) {
        for (const request of this.app.runtime.permissionRequests(id as SessionId).filter(item => !item.decided && !answered.has(item.id))) {
          answered.add(request.id);
          const option = allowOnce(request.options);
          if (option === null) continue;
          try { await this.api.post("/sessions/" + id + "/permissions/" + request.id, { optionId: option, commandId: "allow-" + randomUUID() }); }
          catch (error) { if (!/ 40[49] /u.test(String(error))) throw error; /* the Hub's policy answered it meanwhile */ }
        }
        const head = await this.head(id), done = head.runCount >= (want.get(id) ?? 0) && head.facts.settled;
        if (done && !fired.has(id)) { fired.add(id); await options.settled?.(id); }
        if (!done) all = false;
      }
      if (all) return;
      if (Date.now() > deadline) throw new Broken("回合 " + TURN_MINUTES + " 分钟内没有结束");
      await sleep(500);
    }
  }
  /** One Turn whole: its items page by page, each long one read whole, and the stored details of its tool calls. */
  async turnOf(id: string, role: Role, ordinal: number): Promise<Turn> {
    const view = await this.api.get("/sessions/" + id) as SessionViewV14, wire = view.window.turns.find(turn => turn.run.ordinal === ordinal);
    if (wire === undefined) throw new Broken("turn " + ordinal + " is not in the window");
    const items: ProtocolItem[] = [];
    for (let after = 0; ;) {
      const page = await this.api.get("/sessions/" + id + "/runs/" + ordinal + "/items?after=" + after + "&limit=200") as RunItemsPageView;
      for (const item of page.items) items.push(item.bodyOmitted === true || item.textBytes !== undefined ? (await this.api.get("/sessions/" + id + "/runs/" + ordinal + "/items/" + item.seq) as ItemView).item : item);
      if (page.next === null) break;
      after = page.next;
    }
    const work: Work[] = [];
    for (const item of items) {
      if (!(WORK_TYPES as readonly string[]).includes(item.type) || (item.type === "file_change" && item.by === "hub")) continue;
      let detail = "";
      if (item.detail !== undefined) try { detail = (await readFile(this.app.content.read(item.detail.id).path, "utf8")).slice(0, 2 * 1024 * 1024); } catch { /* not stored */ }
      const { detail: _ref, ...fields } = item;
      const label = item.type === "command" ? item.command || item.raw || "" : item.type === "file_read" ? item.path ?? "" : item.type === "file_change" ? item.changes.map(change => change.path).join(", ")
        : item.type === "search" ? [item.scope, item.query ?? "", item.path ?? ""].filter(Boolean).join(" ") : item.type === "web" ? item.url ?? item.query ?? "" : item.type === "mcp_tool" ? item.server + "." + item.tool
        : item.type === "tool" ? item.name : item.type === "subagent" ? item.title : "";
      const call = JSON.stringify(fields);
      // The Hub's own tools, and a read of the record's directory by a Harness that reads the record as files (2026-11-13): both are the Hub's context, not the file system.
      // (A Harness may shorten the command it shows: what it ran is whole in the stored detail.)
      const hub = (item.type === "mcp_tool" && item.hub === true) || (item.type !== "file_change" && item.type !== "mcp_tool" && inRecord(label + " " + call + " " + detail.slice(0, 4000)))
        || (item.type === "command" && commandOnly(label));
      const progress = hub && item.type === "mcp_tool" && (TABLE_PROGRESS_TOOLS as readonly string[]).includes(item.tool);
      work.push({ type: item.type, label, hub, progress, call, text: call + "\n" + detail });
    }
    const text = (type: "user_message" | "assistant_message") => items.flatMap(item => item.type === type ? [item.text ?? ""] : []).join("\n");
    const turn: Turn = { sessionId: id, workspace: view.head.workspace, role, harnessId: wire.run.turn.executor.harnessId, ordinal, status: wire.run.status, error: wire.run.error?.code ?? null,
      user: text("user_message"), reply: text("assistant_message"), work, notices: items.flatMap(item => item.type === "notice" ? [item.code ?? item.text] : []), ms: wire.run.turn.durationMs ?? null };
    this.turns.push(turn);
    return turn;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The scenarios (names fixed: later runs are compared with this one by them)
// ---------------------------------------------------------------------------------------------------------------------

const SCENARIOS: readonly Scenario[] = [
  { id: "S1", name: "约束去程", roles: ["A", "B"], measures: "父对话早先说的一条长期约束，委派时不重复，子对话照做没有",
    async run(r) {
      const ws = await r.workspace("s1"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务里所有新建的文件，文件名都必须以 zz_ 开头。请记住这条约定。这一轮什么都不用做，只回答“记住了”。"));
      need(await r.say(a, "A", "顺便问一句：法国的首都是哪座城市？只回答城市名。"));
      const before = await files(ws);
      need((await r.delegate(a, "B", "在当前工作目录里新建一个文件，写一行 hello。做完回复一句话。")).turn);
      const made = added(before, await files(ws));
      if (made.length === 0) throw new Voided("B 没有新建文件");
      const off = made.filter(path => !basename(path).startsWith("zz_"));
      return off.length === 0 ? pass("B 新建的 " + made.join("、") + " 以 zz_ 开头", undefined, { made }) : fail("B 新建了 " + made.join("、") + "，没有以 zz_ 开头", undefined, { made });
    } },
  { id: "S2", name: "事实去程", roles: ["A", "B"], measures: "父对话用工具看过、没写进回复的事实，子对话能不能从记录里拿到",
    async run(r) {
      const token = mark("QX"), ws = await r.workspace("s2", { "secret.txt": "这是记号：" + token + "\n" }), a = await r.open("A", ws);
      const first = need(await r.say(a, "A", "读一下当前工作目录里的 secret.txt。只回答“读过了”，不要复述文件内容。"));
      if (!first.work.some(work => !work.hub && (work.text.includes(token) || work.label.includes("secret")))) throw new Voided("A 没有读 secret.txt");
      if (first.reply.includes(token)) throw new Voided("A 在回复里说出了记号");
      // From here on the mark is only in the conversation's records: the file is gone.
      await unlink(join(ws, "secret.txt"));
      const b = need((await r.delegate(a, "B", "之前那一轮读过的文件里有一个记号，它是什么？不要再去读那个文件，从对话记录里查。只回答记号本身；查不到就说查不到。")).turn);
      const answered = b.reply.includes(token), touched = b.work.filter(work => !work.hub && (work.text.includes(token) || /secret/iu.test(work.call)));
      const hubReads = b.work.filter(work => work.hub && !work.progress);
      const note = (hubReads.length ? "B 查了 Hub 的记录：" + listed(hubReads) : "B 没查 Hub 的记录") + (touched.length ? "；B 的工具碰了文件或记号：" + listed(touched) : "");
      if (answered && touched.length === 0) return pass("B 答出了记号，没有去读文件", note, { answered, touched: touched.length });
      return fail(answered ? "B 答出了记号，但是靠工具拿到的" : "B 答不出记号", note, { answered, touched: touched.length });
    } },
  { id: "S3", name: "回程", roles: ["A", "B"], measures: "子对话改了哪些文件，父对话的 Harness 不用工具知不知道",
    async run(r) {
      const ws = await r.workspace("s3"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务是在当前工作目录里整理几个小文件。这一轮什么都不用做，只回答“好”。"));
      const before = await files(ws);
      // The names are the child's own choice: a task that named them would carry the answer back in its own words.
      const b = need((await r.delegate(a, "B", "在当前工作目录里新建两个文本文件，文件名你自己起，每个文件名里带一段你随手想的 6 个小写字母，每个文件写一行 ok。做完只回复“完成”两个字，回复里不要提文件名。")).turn);
      const made = added(before, await files(ws));
      if (made.length < 2) throw new Voided("B 新建了 " + made.length + " 个文件，不是两个");
      if (made.some(path => b.reply.includes(stem(path)))) throw new Voided("B 的回复说出了文件名");
      const asked = need(await r.say(a, "A", "委派出去的那件事改动了哪些文件？不要查看目录、不要用任何工具，只根据你现在知道的回答；不知道就说不知道。"));
      const named = made.filter(path => asked.reply.includes(stem(path))), tools = informing(asked), told = asked.notices.includes("DELEGATION_TOLD");
      const note = (told ? "委派结果随这一轮告知了 A" : "这一轮没有告知委派结果") + (tools.length ? "；A 用了工具：" + listed(tools) : "");
      const checks = { made, named, tools: tools.length, told };
      if (named.length === made.length && tools.length === 0) return pass("A 不用工具说出了 " + made.join("、"), note, checks);
      return fail(tools.length ? "A 用了工具" + (named.length === made.length ? "才说出文件名" : "") : "A 说出 " + named.length + "/" + made.length + " 个文件名", note, checks);
    } },
  { id: "S4", name: "兄弟互知", roles: ["A", "B", "C"], measures: "同一任务里一个子对话做了什么，另一个子对话从 Hub 的记录里知不知道",
    async run(r) {
      const ws = await r.workspace("s4"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务是几个 Harness 合作改同一个文件。这一轮什么都不用做，只回答“好”。"));
      const before = await files(ws);
      const b = need((await r.delegate(a, "B", "在当前工作目录里新建一个文本文件，文件名由你自己起：一段你随手想的 6 个小写字母加 .txt。文件里只写一行 one。做完只回复“完成”两个字，回复里不要提文件名。")).turn);
      const made = added(before, await files(ws));
      if (made.length !== 1) throw new Voided("B 新建了 " + made.length + " 个文件，不是一个");
      const target = join(ws, made[0]!);
      if (!(await lines(target))?.includes("one")) throw new Voided("B 的文件里没有 one");
      const c = need((await r.delegate(a, "C", "同一个任务里另一个被委派的 Harness 刚在当前工作目录里新建了一个文件。请在那个文件末尾加一行 two。不要列目录、不要搜索文件系统，从 HarnessHub 的记录里知道是哪个文件。做完回复一句话。")).turn);
      const now = await lines(target) ?? [], one = now.indexOf("one"), two = now.lastIndexOf("two");
      const looked: Work[] = [];
      for (const work of c.work) if (await lists(work, ws)) looked.push(work);
      const hubReads = c.work.filter(work => work.hub && !work.progress);
      const note = (looked.length ? "C 列了目录或搜了文件系统：" + listed(looked) : "C 没有列目录") + (hubReads.length ? "；C 查了 Hub 的记录：" + listed(hubReads) : "") + (b.reply.includes(stem(made[0]!)) ? "；B 的回复说出了文件名" : "");
      const checks = { file: made[0], lines: now, listed: looked.length, hubReads: hubReads.length };
      if (one >= 0 && two > one) return pass("B 的 " + made[0] + " 里有 one、two 两行" + (looked.length ? "（C 靠列目录找到）" : ""), note, checks);
      return fail("B 的 " + made[0] + " 里没有加上 two", note, checks);
    } },
  { id: "S5", name: "不重做", roles: ["A", "B"], measures: "父对话已经做完的事，子对话会不会照着历史再做一遍",
    async run(r) {
      const ws = await r.workspace("s5"), a = await r.open("A", ws), done = join(ws, "done.txt");
      need(await r.say(a, "A", "在当前工作目录里新建 done.txt，写一行 v1。做完回复一句话。"));
      if ((await lines(done))?.join("\n") !== "v1") throw new Voided("A 没有建好 done.txt");
      const first = (await stat(done)).mtimeMs;
      const b = need((await r.delegate(a, "B", "在当前工作目录里新建 other.txt，写一行 x。做完回复一句话。")).turn);
      const content = (await lines(done))?.join("\n") ?? null, mtime = await stat(done).then(info => info.mtimeMs, () => null), other = (await lines(join(ws, "other.txt"))) !== null;
      const looked = b.work.filter(work => !work.hub && /done\.txt/u.test(work.label + " " + work.call));
      const checks = { content, unchanged: mtime === first, other };
      const note = looked.length ? "B 的工具碰过 done.txt：" + listed(looked) : "B 没碰 done.txt";
      if (content === "v1" && mtime === first && other) return pass("done.txt 仍是 v1、修改时间没变，other.txt 在", note, checks);
      return fail([content !== "v1" ? "done.txt 内容变了" : "", mtime !== first ? "done.txt 被重写过" : "", other ? "" : "other.txt 不在"].filter(Boolean).join("，"), note, checks);
    } },
  { id: "S6", name: "Harness 发起时本轮内容", roles: ["A", "B"], measures: "父对话的 Harness 在一轮中途自己委派，子对话看不看得到这一轮里用户说的话",
    async run(r) {
      const ws = await r.workspace("s6"), a = await r.open("A", ws), token = mark("PW"), pw = join(ws, "pw.txt");
      const before = await r.send(a, "口令是 " + token + "。请用 HarnessHub 的委派工具（hub_delegate）把“把口令写进当前工作目录的 pw.txt”这件事交给 " + r.name("B") + "（标识 " + r.harness("B") + "）。"
        + "交给它的任务文字里不要写出口令本身，只说“口令在父对话本轮的用户消息里”。pw.txt 你自己不要写。等它做完（可以用 hub_delegations 等它），告诉我结果。");
      // What the child left in pw.txt when its Turn ended: the parent may still write it afterwards.
      let atChildEnd: string[] | null | undefined;
      await r.settle([a], new Map([[a, before + 1]]), { discover: async () => (await r.children(a)).map(row => row.id),
        settled: async id => { if (id !== a && atChildEnd === undefined) atChildEnd = await lines(pw); } });
      const parent = need(await r.turnOf(a, "A", before)), kids = await r.children(a);
      if (kids.length === 0) throw new Voided("A 没有委派");
      const tasks: Turn[] = [];
      for (const kid of kids) tasks.push(await r.turnOf(kid.id, "B", 0));
      const wrote = parent.work.filter(work => !work.hub && /pw\.txt/u.test(work.label + " " + work.call)
        && (work.type === "file_change" || (work.type === "command" && /(?<![2&>])>(?!>?\s*\/dev\/null)|\btee\b|\bcp\b|\bmv\b|sed\s+-i/u.test(work.label))));
      const note = "交给了 " + [...new Set(tasks.map(turn => turn.harnessId))].join("、") + "（" + kids.length + " 个子对话，" + kids.map(kid => kid.parent?.by ?? "user").join("、") + " 发起）" + (wrote.length ? "；A 自己也动了 pw.txt：" + listed(wrote) : "");
      if (tasks.some(turn => turn.user.includes(token))) return { verdict: "作废", reason: "A 交出去的任务文字里写了口令", note, checks: { taskHasToken: true } };
      for (const turn of tasks) need(turn);
      const got = (atChildEnd ?? await lines(pw))?.join("\n") ?? null, ok = got !== null && got.includes(token);
      const checks = { taskHasToken: false, pw: got === null ? "missing" : ok ? "token" : "other", parentWrote: wrote.length };
      return ok ? pass("子对话写的 pw.txt 里有口令", note, checks) : fail(got === null ? "子对话没有写 pw.txt" : "子对话写的 pw.txt 里没有口令", note, checks);
    } },
  { id: "S7", name: "约束后到", roles: ["A", "B"], measures: "委派之后父对话才定的约束，已经开着的子对话下一轮知不知道（任务级共同事实）",
    async run(r) {
      const ws = await r.workspace("s7"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务是在当前工作目录里建几个小文件。这一轮什么都不用做，只回答“好”。"));
      const b = await r.delegate(a, "B", "在当前工作目录里新建一个文件，写一行 hello，文件名你自己起。做完回复一句话。");
      need(b.turn);
      need(await r.say(a, "A", "补一条约定：从现在起，这个任务里所有新建的文件，文件名都必须以 qq_ 开头。这一轮什么都不用做，只回答“记住了”。"));
      const before = await files(ws);
      need(await r.say(b.id, "B", "再新建一个文件，写一行 world。做完回复一句话。"));
      const made = added(before, await files(ws));
      if (made.length === 0) throw new Voided("B 第二轮没有新建文件");
      const off = made.filter(path => !basename(path).startsWith("qq_"));
      return off.length === 0 ? pass("B 第二轮新建的 " + made.join("、") + " 以 qq_ 开头", undefined, { made }) : fail("B 第二轮新建了 " + made.join("、") + "，没有以 qq_ 开头", undefined, { made });
    } },
  { id: "S8", name: "回程命令", roles: ["A", "B"], measures: "子对话跑了什么命令、输出了什么，父对话的 Harness 不用工具知不知道",
    async run(r) {
      const ws = await r.workspace("s8"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务是在当前工作目录里跑几条小命令。这一轮什么都不用做，只回答“好”。"));
      const b = need((await r.delegate(a, "B", "在当前工作目录里用命令行原样运行这条命令：echo RUN-$(openssl rand -hex 4)\n做完只回复“完成”两个字，回复里不要写出命令的输出。")).turn);
      const outputs = [...new Set(b.work.filter(work => !work.hub).flatMap(work => work.text.match(/RUN-[0-9a-f]{8}/gu) ?? []))];
      if (outputs.length === 0) throw new Voided("B 的条目里找不到这条命令的输出");
      if (outputs.some(output => b.reply.includes(output))) throw new Voided("B 在回复里说出了输出");
      const asked = need(await r.say(a, "A", "委派出去的那件事运行的命令输出了什么？不要用任何工具，只根据你现在知道的回答；不知道就说不知道。"));
      const said = outputs.some(output => asked.reply.includes(output)), tools = informing(asked), told = asked.notices.includes("DELEGATION_TOLD");
      const note = (told ? "委派结果随这一轮告知了 A" : "这一轮没有告知委派结果") + (tools.length ? "；A 用了工具：" + listed(tools) : "");
      const checks = { said, tools: tools.length, told };
      if (said && tools.length === 0) return pass("A 不用工具说出了命令输出", note, checks);
      return fail(said ? "A 用了工具才说出输出" : "A 说不出命令输出", note, checks);
    } },
  { id: "S9", name: "换回", roles: ["A", "B"], measures: "同一段对话里换到另一家做了一轮再换回来，原来那家不用工具知不知道那一轮改了什么",
    async run(r) {
      const ws = await r.workspace("s9"), a = await r.open("A", ws);
      need(await r.say(a, "A", "这个任务是在当前工作目录里建几个小文件。这一轮什么都不用做，只回答“好”。"));
      await r.switchTo(a, "B");
      const before = await files(ws);
      const b = need(await r.say(a, "B", "在当前工作目录里新建一个文本文件，文件名你自己起，文件名里带一段你随手想的 6 个小写字母，写一行 ok。做完只回复“完成”两个字，回复里不要提文件名。"));
      const made = added(before, await files(ws));
      if (made.length === 0) throw new Voided("B 没有新建文件");
      if (made.some(path => b.reply.includes(stem(path)))) throw new Voided("B 的回复说出了文件名");
      await r.switchTo(a, "A");
      const back = need(await r.say(a, "A", "刚才换到另一个 Harness 的那一轮里，它新建了哪个文件？不要查看目录、不要用任何工具，只根据你现在知道的回答；不知道就说不知道。"));
      const named = made.filter(path => back.reply.includes(stem(path))), tools = informing(back), stated = back.notices.includes("TASK_STATE_TOLD");
      const note = (stated ? "换回这一轮带上了任务现在的状态" : "换回这一轮没有带状态") + (tools.length ? "；A 用了工具：" + listed(tools) : "");
      const checks = { made, named, tools: tools.length, stated };
      if (named.length === made.length && tools.length === 0) return pass("A 不用工具说出了 " + made.join("、"), note, checks);
      return fail(tools.length ? "A 用了工具" + (named.length === made.length ? "才说出文件名" : "") : "A 说出 " + named.length + "/" + made.length + " 个文件名", note, checks);
    } },
  { id: "S10", name: "压缩之后", roles: ["C"], measures: "一家 Harness 压缩了自己的上下文之后，下一轮 Hub 有没有把状态重新给它，早先的约束它还照不照做",
    async run(r) {
      const ws = await r.workspace("s10"), c = await r.open("C", ws);
      need(await r.say(c, "C", "这个任务里有一条约定：所有新建的文件，文件名都必须以 kk_ 开头。把这条约定记到任务板上，然后只回答“记住了”。"));
      need(await r.say(c, "C", "只回答“在”。"));
      // The Harness's own compaction, asked for as its user would: its session then holds a summary of its own making.
      const squeezed = await r.say(c, "C", "/compact");
      if (squeezed.status !== "completed") throw new Voided("这家 Harness 没有完成 /compact（" + squeezed.status + (squeezed.error ? " " + squeezed.error : "") + "）");
      const before = await files(ws);
      const after = need(await r.say(c, "C", "在当前工作目录里新建一个文件，写一行 hello，文件名你自己起。做完回复一句话。"));
      const made = added(before, await files(ws)), stated = after.notices.includes("TASK_STATE_TOLD");
      if (made.length === 0) throw new Voided("压缩之后的这一轮没有新建文件");
      const off = made.filter(path => !basename(path).startsWith("kk_")), note = stated ? "压缩后的这一轮带上了任务现在的状态" : "压缩后的这一轮没有带状态";
      const checks = { made, stated };
      if (!stated) return fail("压缩之后 Hub 没有重新给状态（新建的是 " + made.join("、") + "）", note, checks);
      return off.length === 0 ? pass("压缩之后新建的 " + made.join("、") + " 以 kk_ 开头", note, checks) : fail("压缩之后新建了 " + made.join("、") + "，没有以 kk_ 开头", note, checks);
    } },
  { id: "S11", name: "中途的变化", roles: ["C"], measures: "一轮进行到一半时任务板上多了一条约束，这一轮里它调 Hub 的工具时知不知道，后面的步骤照不照做",
    async run(r) {
      const ws = await r.workspace("s11"), c = await r.open("C", ws), before = await files(ws);
      const ordinal = await r.send(c, "分三步做，开始时先用 HarnessHub 的任务清单列出这三步，每做完一步都更新一次清单：\n1. 在命令行运行 sleep 12\n2. 在命令行运行 sleep 12\n3. 在当前工作目录里新建一个文件，写一行 hello，文件名你自己起\n三步都做完后回复一句话。");
      // While it works on the first step, the user writes a constraint on the task's board from the page.
      await new Promise(done => setTimeout(done, 9000));
      await r.note(c, "这件任务里所有新建的文件，文件名都必须以 mm_ 开头。");
      await r.settle([c], new Map([[c, ordinal + 1]]));
      const turn = need(await r.turnOf(c, "C", ordinal)), made = added(before, await files(ws)), told = turn.notices.includes("TASK_BOARD_TOLD");
      if (made.length === 0) throw new Voided("这一轮没有新建文件");
      const off = made.filter(path => !basename(path).startsWith("mm_")), note = told ? "这一轮进行中带上了任务板" : "这一轮里任务板没有送到";
      const checks = { made, told };
      if (!told) return fail("中途加的约束没有在这一轮里送到（新建的是 " + made.join("、") + "）", note, checks);
      return off.length === 0 ? pass("中途加的约束送到了，新建的 " + made.join("、") + " 以 mm_ 开头", note, checks) : fail("约束送到了，但新建的 " + made.join("、") + " 没有以 mm_ 开头", note, checks);
    } },
  { id: "S12", name: "窗口快满", roles: ["A"], measures: "一家 Harness 的窗口快满时，Hub 有没有给它换一个新的原生会话；换完有没有腾出地方，早先的约束它还照不照做，没带过去的内容它还找不找得到",
    async run(r) {
      const ws = await r.workspace("s12"), a = await r.open("A", ws), key = mark("KEY"), percent = (value: number) => (Math.round(1000 * value) / 10) + "%";
      need(await r.say(a, "A", "这个任务里有一条约定：所有新建的文件，文件名都必须以 rr_ 开头。把这条约定记到任务板上，然后只回答“记住了”。"));
      let at = await r.window(a, 0), ordinal = 0;
      if (at === null) throw new Voided("这家 Harness 没有报窗口大小");
      // The mark the Hub waits for is set for this scenario so that some 90,000 tokens of material reach it, whatever the window (at the Runtime's own mark a window of a
      // million tokens would take three quarters of a million); what is measured is what happens at the mark, not where it stands.
      const share = Math.min(RESEAT_AT, (at.used + 90_000) / at.size);
      // Material without any regularity (a model works a regular one out from its beginning): plain words in a random order, with one line in its middle that is asked for at the end.
      const material = (chars: number, marked: boolean): string => {
        const rows: string[] = [];
        for (let length = 0; length < chars;) { const row = Array.from({ length: 14 }, () => WORDS[randomBytes(1)[0]! % WORDS.length]!).join(" "); rows.push(row); length += row.length + 1; }
        if (marked) rows.splice(Math.floor(rows.length / 2), 0, "编号 7 的校验码是 " + key + "。");
        return rows.join("\n");
      };
      r.reseatAt(share);
      try {
        // The window is filled a message at a time until the Harness says it is as full as the Hub waits for: the first by a fixed length, the rest by what the first cost.
        let rate = 0, chars = 200_000;
        for (let round = 0; at.used < share * at.size; round++) {
          if (round >= 8) throw new Voided("八段材料之后窗口只到 " + percent(at.used / at.size));
          const filled = need(await r.say(a, "A", "下面是一段参考材料，先不用处理，也不要用任何工具，只回答“收到”。\n\n" + material(chars, round === 0)));
          if (filled.notices.includes("NATIVE_RESEATED")) throw new Voided("材料还没填够，Hub 就换了会话");
          const next = await r.window(a, filled.ordinal);
          if (next === null) throw new Voided("这家 Harness 没有报窗口大小");
          if (next.used < at.used) throw new Voided("填到 " + percent(at.used / at.size) + " 之后它自己先压缩了（剩 " + percent(next.used / next.size) + "）");
          rate = Math.max(rate, (next.used - at.used) / chars); at = next; ordinal = filled.ordinal;
          // A little past the mark, so that the next message is the one that crosses it and not the one after.
          chars = Math.max(4_000, Math.ceil((share * at.size + 5_000 - at.used) / (rate || 0.25)));
        }
        const full = at, before = await files(ws);
        const after = need(await r.say(a, "A", "在当前工作目录里新建一个文件，写一行 hello，文件名你自己起。做完回复一句话。"));
        const made = added(before, await files(ws)), reseated = after.notices.includes("NATIVE_RESEATED"), then = await r.window(a, after.ordinal);
        const asked = need(await r.say(a, "A", "很早以前我发过的一段参考材料里，有一行写着“编号 7 的校验码”。它是什么？只回答校验码。"));
        const knew = asked.reply.includes(key), read = informing(asked), again = asked.notices.includes("NATIVE_RESEATED");
        const note = "换的位置设在 " + percent(share) + "（窗口 " + full.size + "）；换之前用到 " + percent(full.used / full.size) + "（" + full.used + "）" + (then === null ? "" : "，换之后这一轮结束时 " + percent(then.used / then.size) + "（" + then.used + "）")
          + "，填了 " + ordinal + " 段材料" + (read.length ? "；答校验码时用了：" + listed(read) : "；答校验码时没有用工具") + (again ? "；下一轮又换了一次" : "");
        const checks = { share, full, then, made, reseated, knew, again, read: read.length };
        if (!reseated) return fail("窗口用到 " + percent(full.used / full.size) + "，Hub 没有换新的原生会话", note, checks);
        if (made.length === 0) throw new Voided("换了新会话的这一轮没有新建文件");
        const off = made.filter(path => !basename(path).startsWith("rr_"));
        if (off.length > 0) return fail("换了新会话之后新建了 " + made.join("、") + "，没有以 rr_ 开头", note, checks);
        if (then !== null && then.used >= full.used) return fail("换了新会话，但没有腾出地方", note, checks);
        if (again) return fail("换了新会话之后，下一轮又换了一次", note, checks);
        return knew ? pass("换了新会话、腾出了地方，新建的 " + made.join("、") + " 以 rr_ 开头，很早以前的校验码也答对了", note, checks) : fail("换了新会话、约束照做，但很早以前的校验码没答出来", note, checks);
      } finally { r.reseatAt(undefined); }
    } },
];

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

test("the delegation ruler: what reaches whom when Harnesses work together by delegation", { timeout: 4 * 60 * 60 * 1000 }, async () => {
  const chosen = SCENARIOS.filter(scenario => ONLY.size === 0 || ONLY.has(scenario.id));
  assert.ok(chosen.length > 0, "HH_RULER_SCENARIOS names no scenario of " + SCENARIOS.map(scenario => scenario.id).join(","));
  const harnesses = [...new Set(Object.values(ROLES))];
  guardTargets(harnesses);
  // The workspaces under HH_REAL_TMP (a plain directory of the home, which Hermes can write); the Gateway's data in a directory of its own elsewhere,
  // not beside them, as the Gateway keeps its data away from the folders it gives conversations (2026-11-13, scratch folders).
  const root = await realpath(await mkdtemp(join(process.env.HH_REAL_TMP ?? tmpdir(), "hh-ruler-")));
  const hidden = await realpath(await mkdtemp(join(tmpdir(), "hh-ruler-data-")));
  const before = await snapshot(harnesses, environment);
  const outcomes: Outcome[] = [], usable = new Map<string, boolean>(), names = new Map<string, string>(), toolPrograms: Record<string, string> = {};
  for (const harnessId of harnesses) toolPrograms[harnessId] = await userToolProgram(harnessId);
  let header: EvidenceHeader | null = null, guard: GuardCheck | null = null, server: WebServer | undefined;
  const save = async () => {
    await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
    const roles = Object.fromEntries((Object.keys(ROLES) as Role[]).map(role => [role, { harnessId: ROLES[role], usable: usable.get(ROLES[role]) ?? null, model: process.env["HH_REAL_MODEL_" + ROLES[role].toUpperCase()] ?? null,
      userToolProgram: toolPrograms[ROLES[role]] ?? null }]));
    await writeFile(evidencePath, JSON.stringify({ header, startedAt: STARTED.toISOString(), level: LEVEL, roles, outcomes, guard }, null, 2) + "\n", { mode: 0o600 });
    await writeFile(evidencePath.replace(/\.json$/u, "") + ".md", table(header, outcomes, toolPrograms), { mode: 0o600 });
  };
  try {
    const data = join(hidden, "data"), locks = join(hidden, "locks"), first = join(root, "first");
    await mkdir(locks, { recursive: true, mode: 0o700 }); await mkdir(first, { recursive: true });
    // The Gateway as it composes itself (src/web/server.ts): its context table, whose tokens and tool command reach the Harnesses' processes.
    const table = new TableMount(new MemoryTableGrants(), join(data, TABLE_COMMAND_DIR));
    let app: App | undefined;
    const configuration = await prepareConfiguration({ workspace: first, ...(process.env.HH_REAL_MANIFEST ? { manifestPath: process.env.HH_REAL_MANIFEST } : {}) });
    server = await startWebServer({ root: data, configuration, port: 0, installations: realInstallations, workspaceLockRoot: locks, table, loginShell: false,
      application: (dataRoot, publish) => (app = composeApplication(dataRoot, publish, { installations: realInstallations, workspaceLockRoot: locks, table, tableGrants: table.grants })) });
    header = await evidenceHeader(app!, harnesses, { configuration });
    const api = await login(server);
    for (const view of await api.get("/harnesses") as HarnessView[]) { names.set(view.id, view.name); usable.set(view.id, view.controls.some(control => control.available)); }
    const ruler = new Ruler(api, app!, root, names);
    for (const scenario of chosen) {
      const started = Date.now(), missing = scenario.roles.filter(role => usable.get(ROLES[role]) !== true);
      let judged: Judged;
      ruler.turns = [];
      if (missing.length > 0) judged = { verdict: "跳过", reason: missing.map(role => role + "=" + ROLES[role] + (usable.has(ROLES[role]) ? " 不可用" : " 没装")).join("，") };
      else {
        try { judged = honest(await scenario.run(ruler), ruler.turns, basename(hidden)); }
        catch (error) {
          if (error instanceof Voided) judged = { verdict: "作废", reason: error.message };
          else judged = { verdict: "出错", reason: error instanceof Error ? clip(error.message, 300) : "failed" };
        } finally { await ruler.done(); }
      }
      outcomes.push({ id: scenario.id, name: scenario.name, measures: scenario.measures, ...judged, ms: Date.now() - started,
        turns: ruler.turns.map(turn => ({ role: turn.role, harnessId: turn.harnessId, sessionId: turn.sessionId, ordinal: turn.ordinal, status: turn.status, error: turn.error, ms: turn.ms,
          user: clip(turn.user, 400), reply: clip(turn.reply, 400), work: turn.work.map(work => ({ type: work.type, label: clip(work.label, 200), hub: work.hub, outside: outside(work, turn.workspace, basename(hidden)) })),
          notices: turn.notices })) });
      console.log(scenario.id + " " + scenario.name + ": " + judged.verdict + " — " + judged.reason + (judged.note ? "（" + judged.note + "）" : ""));
      await save();
    }
  } finally {
    try { await server?.close(); } finally {
      guard = await recheck(before, environment);
      await save();
      if (process.env.HH_REAL_KEEP !== "1") { await rm(root, { recursive: true, force: true }); await rm(hidden, { recursive: true, force: true }); }
    }
  }
  console.log("\n" + table(header, outcomes, toolPrograms) + "\n证据：" + evidencePath);
  assert.ok(guard.unchanged, describeGuard(guard));
  // A gauge, not a gate: only a scenario that could not run is a failure of the run.
  assert.deepEqual(outcomes.filter(outcome => outcome.verdict === "出错").map(outcome => outcome.id + ": " + outcome.reason), [], "scenarios that could not run");
});

function table(header: EvidenceHeader | null, outcomes: readonly Outcome[], toolPrograms: Readonly<Record<string, string>>): string {
  const roles = (Object.keys(ROLES) as Role[]).map(role => role + "=" + ROLES[role] + ((model => model ? "(" + model + ")" : "")(process.env["HH_REAL_MODEL_" + ROLES[role].toUpperCase()]))).join(" ");
  const cell = (text: string) => text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
  // A Harness whose user-level entry runs another build's tool program was measured with that build's Hub tools, not this commit's.
  const foreign = Object.entries(toolPrograms).filter(([, program]) => program.startsWith("~") || program.startsWith("/"));
  return "委派上下文尺子 · " + STARTED.toLocaleString("sv-SE").slice(0, 16) + " · 提交 " + (header?.commit.slice(0, 7) ?? "?") + (header?.uncommittedChanges ? "（有未提交改动）" : "") + " · " + roles + " · 档位 " + LEVEL + "\n\n"
    + "| 场景 | 结果 | 依据 | 另记 |\n|---|---|---|---|\n"
    + outcomes.map(outcome => "| " + outcome.id + " " + outcome.name + " | " + outcome.verdict + " | " + cell(outcome.reason) + " | " + cell(outcome.note ?? "") + " |").join("\n") + "\n"
    + (foreign.length === 0 ? "" : "\n注意：" + foreign.map(([harnessId, program]) => harnessId + " 的用户级配置里 harnesshub 一项跑的是 " + program).join("；")
      + "，不是这次的构建。Codex 保留用户自己的同名项（不用 Hub 按会话给的那份）；Claude Code 两份同名时用哪份没核实。这几家量到的是那份构建的 Hub 工具。\n");
}
