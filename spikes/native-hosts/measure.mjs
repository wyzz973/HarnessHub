#!/usr/bin/env node
/*
 * 只用于测量，不是实现（spikes/native-hosts/README.md）。
 *
 * Starts each installed Harness through the production composition (application, binding factory, official installations:
 * the same launch command, environment, cwd and TMPDIR a Hub Turn would get) and drives the program over its own protocol
 * with a minimal client of this spike, so that one process can hold more than one session (the production drivers own
 * exactly one). Nothing is ever sent to a model: no prompt, no slash command. What is measured: start to initialize, to
 * the first session; the RSS of the whole process tree; a second session with another cwd in the same process and a switch
 * back to the first; writes to the workspaces while idle; the close. Results hold timings, sizes, program names (never
 * arguments), session identities and ~ paths; never stderr, notification contents, configuration or credentials.
 *
 * Run from the repository root after `pnpm build`, in the clean environment of docs/engineering/real-acceptance.md §1:
 *   RUN node spikes/native-hosts/measure.mjs [--harnesses=claude,codex,...] [--init-runs=3] [--session-runs=3]
 *       [--idle-ms=60000] [--idle-sample-ms=15000] [--settle-ms=5000] [--out=spikes/native-hosts/results.json] [--root=<dir>]
 *       [--merge] [--keep]
 * --merge keeps the other Harnesses already in --out (one invocation per Harness); --keep leaves the workspaces in place.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const load = path => import(new URL("../../dist/" + path, import.meta.url).href);
const { application } = await load("src/cli/session-application.js");
const { prepareConfiguration } = await load("src/infrastructure/session/binding-factory.js");
const { captureNativeEnvironment } = await load("src/infrastructure/session/native-environment.js");
const { evidenceHeader, snapshot, recheck, describeGuard } = await load("tests/real/guard.js");
const { readGatewayFacts, judgeGateway, hostQueries, parseLaunchctlPrint, resolveHermesHome } = await load("src/adapters/control/hermes-gateway.js");
const { darwinExitedGroupIsQuiescent, elapsedSeconds } = await load("src/infrastructure/control/process-group.js");

// ---------------------------------------------------------------------------------------------------------------- options
const argv = new Map(process.argv.slice(2).map(arg => { const [key, ...value] = arg.replace(/^--/u, "").split("="); return [key, value.length ? value.join("=") : "true"]; }));
const int = (name, fallback) => { const value = Number(argv.get(name) ?? fallback); if (!Number.isSafeInteger(value) || value < 0) throw new Error("--" + name + " must be a whole number"); return value; };
const DAY = new Date().toLocaleDateString("sv");
const HARNESSES = (argv.get("harnesses") ?? "codex,opencode,dsh,claude,pi,openclaw,hermes").split(",").map(item => item.trim()).filter(Boolean);
const INIT_RUNS = int("init-runs", 3), SESSION_RUNS = int("session-runs", 3), IDLE_MS = int("idle-ms", 60000), IDLE_SAMPLE_MS = Math.max(1000, int("idle-sample-ms", 15000)), SETTLE_MS = int("settle-ms", 5000);
const OUT = resolve(argv.get("out") ?? join(REPO, "spikes", "native-hosts", "results.json"));
const HOME = process.env.HOME;
if (!HOME || !process.env.HH_REAL_TMP) throw new Error("run in the clean environment of docs/engineering/real-acceptance.md §1 (HOME and HH_REAL_TMP)");
const ROOT = resolve(argv.get("root") ?? join(process.env.HH_REAL_TMP, "hosts-" + DAY));
if (!ROOT.startsWith(HOME + "/") || ROOT.startsWith("/private/")) throw new Error("the measurement root must be a plain directory in the home (Hermes refuses /private/var)");
const KEEP = argv.has("keep");
/**
 * A variant, not the production launch: every run of this invocation gets this one TMPDIR instead of the binding's fresh
 * root, to see what a runtime cache kept in TMPDIR (Node's compile cache, Bun's extracted libraries) saves. Recorded under
 * `variants`, never under `harnesses`. It must lie in the measurement root.
 */
const TMP_OVERRIDE = argv.has("tmpdir") ? resolve(argv.get("tmpdir")) : null;
if (TMP_OVERRIDE !== null && !TMP_OVERRIDE.startsWith(ROOT + "/")) throw new Error("--tmpdir must lie in the measurement root");
/** How long a program may take to leave after its stdin closes before the group is signalled (production waits 500 ms). */
const EOF_WAIT_MS = 8000, SIGNAL_WAIT_MS = 3000, SETUP_MS = 60000, REQUEST_MS = 30000, LINGER_MS = 10000;

const CLIENT = { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" };
/** The ACP initialize the production driver sends (src/adapters/control/acp.ts initializeOnce). */
const ACP_INIT = { protocolVersion: 1, clientCapabilities: { session: { notices: {}, compaction: {} }, elicitation: { form: {} } }, clientInfo: CLIENT };
/** The Codex initialize the production driver sends without a collaboration mode (src/adapters/control/codex.ts). */
const CODEX_INIT = { clientInfo: CLIENT, capabilities: { experimentalApi: false, requestAttestation: false } };
const CODEX_LISTED_SOURCES = ["cli", "vscode", "exec", "appServer"];
/** Project command folders whose files the program announces per session: a marker per workspace shows which cwd a session runs in. */
const MARKER_DIRS = { claude: ".claude/commands", opencode: ".opencode/command" };
const MARKER_TEXT = "---\ndescription: HarnessHub host probe marker (never invoked)\n---\nA marker of a measurement. Do nothing.\n";

// ---------------------------------------------------------------------------------------------------------------- helpers
const sleep = ms => new Promise(done => setTimeout(done, ms));
const round = (value, digits = 0) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;
const median = values => { const list = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b); if (!list.length) return null; const mid = list.length >> 1; return list.length % 2 ? list[mid] : round((list[mid - 1] + list[mid]) / 2, 1); };
const tilde = path => typeof path !== "string" ? path : path === HOME ? "~" : path.startsWith(HOME + "/") ? "~/" + path.slice(HOME.length + 1) : path;
const untilde = path => typeof path === "string" && path.startsWith("~/") ? join(HOME, path.slice(2)) : path;
/** A peer's own text, bounded and without the home, long tokens or addresses; only for refusals the result keeps. */
function sanitize(text) {
  return String(text ?? "").split(HOME).join("~").replace(/(?:sk-|ghp_|gho_|xox[bp]-|AKIA)[A-Za-z0-9_-]{6,}/gu, "<redacted>")
    .replace(/[A-Za-z0-9+/=_-]{40,}/gu, "<long>").replace(/[^\s@"']+@[^\s@"']+\.[a-z]{2,}/giu, "<address>").replace(/[\0-\x1f\x7f]+/gu, " ").slice(0, 240);
}
function describe(error) {
  if (error !== null && typeof error === "object") {
    const code = "remoteCode" in error ? error.remoteCode : "code" in error ? error.code : "ERROR";
    return { code: String(code), message: sanitize("remoteMessage" in error ? error.remoteMessage : error.message) };
  }
  return { code: "ERROR", message: sanitize(error) };
}
function remote(code, message) { return Object.assign(new Error(String(message ?? code)), { remoteCode: code, remoteMessage: String(message ?? "") }); }
function sha256File(path) {
  return new Promise((done, fail) => { const hash = createHash("sha256"); createReadStream(path).on("data", chunk => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex"))); });
}
function log(...parts) { process.stdout.write("[" + new Date().toLocaleTimeString("sv") + "] " + parts.join(" ") + "\n"); }
function sh(command) { try { return execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10000, env: process.env }).trim(); } catch { return ""; } }

// ---------------------------------------------------------------------------------------------------------------- processes
/**
 * The program name of a `comm` field, never its arguments: macOS reports argv[0], which a program can rewrite into a
 * title with arguments ("npm exec <package>"), so a title keeps only its first word, and a path only its base name.
 */
function programName(comm) {
  const text = comm.trim(), first = text.startsWith("/") ? basename(text) : basename(text.split(/\s+/u)[0] ?? "");
  return first.split(/\s+-/u)[0].slice(0, 64);
}
/** Every process: pid, parent, group, RSS in KiB, start (Unix seconds) and its program name (programName). */
function psRows() {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss=,etime=,comm="], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, maxBuffer: 16 << 20, timeout: 5000 });
  const now = Date.now() / 1000;
  return out.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const elapsed = elapsedSeconds(match[5]);
    return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rss: Number(match[4]), startedAt: elapsed === null ? null : Math.round(now - elapsed), name: programName(match[6]) }];
  });
}
/** A process and its descendants, and (for a group leader) every member of its group even when it was re-parented. */
function treeOf(rows, root, group) {
  const children = new Map();
  for (const row of rows) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row); }
  const found = new Map(), queue = rows.filter(row => row.pid === root || (group !== undefined && row.pgid === group));
  for (const row of queue) found.set(row.pid, row);
  while (queue.length) { const row = queue.shift(); for (const child of children.get(row.pid) ?? []) if (!found.has(child.pid)) { found.set(child.pid, child); queue.push(child); } }
  return [...found.values()];
}
function summarizeTree(label, procs, leader, rows) {
  const byPid = new Map(rows.map(row => [row.pid, row])), children = {};
  let total = 0;
  const processes = procs.map(proc => {
    total += proc.rss;
    if (proc.pid !== leader) children[proc.name] = (children[proc.name] ?? 0) + 1;
    return { name: proc.name, parent: proc.pid === leader ? null : byPid.get(proc.ppid)?.name ?? null, rssKiB: proc.rss, inGroup: proc.pgid === leader, leader: proc.pid === leader };
  });
  return { label, totalRssKiB: total, totalRssMiB: round(total / 1024, 1), processCount: procs.length, children, processes };
}
function groupAlive(group) {
  try { process.kill(-group, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return !darwinExitedGroupIsQuiescent(group); throw error; }
}
function launchdPid(label) {
  try { return parseLaunchctlPrint(execFileSync("/bin/launchctl", ["print", "gui/" + process.getuid() + "/" + label], { encoding: "utf8", timeout: 5000, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } })).pid; }
  catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------- the client
/**
 * One program over stdio, in its own process group (as JsonRpcProcess spawns it): newline-delimited JSON-RPC 2.0 for ACP,
 * the same frames without `jsonrpc` for Codex, Pi's `{type, id}` commands. A request from the program is answered as the
 * production drivers answer one outside a Turn (permission cancelled, form declined, anything else -32601). Notifications
 * are counted by method and update kind, per phase and session; only command names are looked at, for the markers.
 */
class Peer {
  constructor(harness, launch, options, workspaces) {
    Object.assign(this, { harness, launch, options, protocol: launch.protocol, workspaces });
    this.pending = new Map(); this.seq = 0; this.input = Buffer.alloc(0); this.phase = "start"; this.events = [];
    this.stderr = {}; this.tail = Buffer.alloc(0); this.perSession = new Map(); this.exit = null; this.invalidFrames = 0; this.seen = new Map(); this.child = null;
  }
  get elapsed() { return performance.now() - this.t0; }
  start() {
    this.t0 = performance.now();
    const child = spawn(this.launch.executable, [...this.launch.args], { cwd: this.options.cwd, env: { ...this.options.env, ...this.launch.env }, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.pgid = child.pid;
    child.on("error", error => { this.spawnError = error.code ?? "ERROR"; this.rejectAll("PROCESS_ERROR"); });
    child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => this.read(chunk));
    child.stderr.on("data", chunk => { this.stderr[this.phase] = (this.stderr[this.phase] ?? 0) + chunk.length; const kept = Buffer.concat([this.tail, chunk]); this.tail = kept.subarray(Math.max(0, kept.length - 8192)); });
    child.on("exit", (code, signal) => { this.exit = { code, signal, at: performance.now() }; this.rejectAll("PROCESS_EXITED"); });
  }
  session(id) { if (!this.perSession.has(id)) this.perSession.set(id, { commands: null, markers: null, echo: {} }); return this.perSession.get(id); }
  read(chunk) {
    this.input = Buffer.concat([this.input, chunk]);
    for (let at = this.input.indexOf(10); at >= 0; at = this.input.indexOf(10)) {
      const line = this.input.subarray(0, at).toString("utf8"); this.input = this.input.subarray(at + 1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { this.invalidFrames++; continue; }
      if (message === null || typeof message !== "object" || Array.isArray(message)) { this.invalidFrames++; continue; }
      try { this.dispatch(message, line); } catch { this.invalidFrames++; }
    }
  }
  note(key, id, line) {
    if (this.events.length < 50000) this.events.push({ phase: this.phase, key, id });
    if (id) { const entry = this.session(id); for (const [tag, path] of Object.entries(this.workspaces)) if (line.includes(path)) entry.echo[tag] = true; }
  }
  dispatch(message, line) {
    if (this.protocol === "pi-rpc") {
      if (message.type !== "response") { this.note("event:" + String(message.type), null, line); return; }
      const pending = this.pending.get(String(message.id)); if (!pending) return;
      this.pending.delete(String(message.id)); clearTimeout(pending.timer);
      if (message.success === true) pending.resolve(message.data ?? {}); else pending.reject(remote("PI_ERROR", message.error));
      return;
    }
    const params = message.params !== null && typeof message.params === "object" ? message.params : {};
    const id = typeof params.sessionId === "string" ? params.sessionId : typeof params.threadId === "string" ? params.threadId : typeof params.thread?.id === "string" ? params.thread.id : null;
    if (typeof message.method === "string" && message.id !== undefined) {
      this.note("request:" + message.method, id, line);
      const reply = message.method === "session/request_permission" ? { result: { outcome: { outcome: "cancelled" } } }
        : message.method === "elicitation/create" ? { result: { action: "decline" } } : { error: { code: -32601, message: "Method not supported by this client" } };
      this.write({ id: message.id, ...reply });
      return;
    }
    if (typeof message.method === "string") {
      const update = params.update !== null && typeof params.update === "object" ? params.update : null;
      this.note(message.method === "session/update" ? "session/update:" + String(update?.sessionUpdate) : message.method, id, line);
      if (id && update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
        const names = update.availableCommands.map(command => typeof command?.name === "string" ? command.name : "");
        Object.assign(this.session(id), { commands: names.length, markers: { "ws-a": names.some(name => name.includes("hh-probe-wsa")), "ws-b": names.some(name => name.includes("hh-probe-wsb")) } });
      }
      return;
    }
    const key = JSON.stringify(message.id), pending = this.pending.get(key); if (!pending) return;
    this.pending.delete(key); clearTimeout(pending.timer);
    if (message.error) pending.reject(remote(message.error.code, message.error.message)); else pending.resolve(message.result);
  }
  write(message) {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(JSON.stringify(this.protocol === "acp-v1" ? { jsonrpc: "2.0", ...message } : message) + "\n");
  }
  request(method, params, timeoutMs = REQUEST_MS) {
    if (!this.child) this.start();
    if (this.exit || this.spawnError) return Promise.reject(remote("PROCESS_EXITED", "the program is not running"));
    const id = ++this.seq, key = this.protocol === "pi-rpc" ? String(id) : JSON.stringify(id);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(key); fail(remote("TIMEOUT", method + " exceeded " + timeoutMs + " ms")); }, timeoutMs);
      this.pending.set(key, { resolve: done, reject: fail, timer });
      this.write(this.protocol === "pi-rpc" ? { ...params, type: method, id: String(id) } : { id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }
  rejectAll(code) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(remote(code, "the connection ended")); } this.pending.clear(); }
  /** The process tree now; every descendant seen is remembered (pid and start) to find any that outlive the group. */
  sample(label) {
    const rows = psRows(), procs = treeOf(rows, this.pgid, this.pgid);
    for (const proc of procs) if (proc.pid !== this.pgid) this.seen.set(proc.pid + ":" + proc.startedAt, proc);
    return summarizeTree(label, procs, this.pgid, rows);
  }
  async waitGone(ms) {
    for (const end = performance.now() + ms; performance.now() < end; await sleep(20)) if (this.exit && !groupAlive(this.pgid)) return true;
    return this.exit !== null && !groupAlive(this.pgid);
  }
  /** Closes stdin and waits; only then SIGTERM and SIGKILL to the group. Afterwards, descendants that left the group and live on. */
  async closeStaged() {
    if (!this.child) return null;
    this.phase = "closing"; this.sample("before-close");
    const started = performance.now(), result = { stage: "eof" };
    try { this.child.stdin.end(); } catch { /* already closed */ }
    let gone = await this.waitGone(EOF_WAIT_MS);
    if (!gone) { result.stage = "sigterm"; try { process.kill(-this.pgid, "SIGTERM"); } catch { /* gone */ } gone = await this.waitGone(SIGNAL_WAIT_MS); }
    if (!gone) { result.stage = "sigkill"; try { process.kill(-this.pgid, "SIGKILL"); } catch { /* gone */ } gone = await this.waitGone(SIGNAL_WAIT_MS); }
    Object.assign(result, { leaderExitMs: this.exit ? round(this.exit.at - started) : null, groupGoneMs: gone ? round(performance.now() - started) : null, confirmed: gone,
      exitCode: this.exit?.code ?? null, signal: this.exit?.signal ?? null, withinProductionGrace: result.stage === "eof" && gone && performance.now() - started <= 500 });
    // Descendants that left the group (setsid, their own group) are not reached by a group signal: which still run at
    // once, which still run after LINGER_MS on their own, and only then they are ended here.
    const alive = () => { const rows = psRows(); return [...this.seen.values()].filter(proc => rows.some(row => row.pid === proc.pid && row.startedAt !== null && proc.startedAt !== null && Math.abs(row.startedAt - proc.startedAt) <= 2)); };
    let left = alive();
    result.leftovers = left.map(proc => proc.name);
    const lingerStarted = performance.now();
    while (left.length && performance.now() - lingerStarted < LINGER_MS) { await sleep(500); left = alive(); }
    result.leftoversAfterLingerMs = LINGER_MS; result.leftoversStillRunning = left.map(proc => proc.name);
    if (result.leftovers.length) result.leftoversGoneAfterMs = left.length ? null : round(performance.now() - lingerStarted);
    if (left.length) {
      for (const proc of left) try { process.kill(proc.pid, "SIGTERM"); } catch { /* gone */ }
      await sleep(2000);
      for (const proc of alive()) try { process.kill(proc.pid, "SIGKILL"); } catch { /* gone */ }
      await sleep(500);
      result.leftoversAfterCleanup = alive().map(proc => proc.name);
    }
    return result;
  }
  /** Notification counts by phase, key and session tag (s1, s2, other session, none). */
  tallies(tags) {
    const out = {};
    for (const event of this.events) {
      const tag = event.id === null ? "" : "@" + (tags.get(event.id) ?? "other");
      out[event.phase] ??= {}; out[event.phase][event.key + tag] = (out[event.phase][event.key + tag] ?? 0) + 1;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------- workspaces
async function snapTree(root, prefix, out, limit = 20000) {
  const walk = async (dir, rel) => {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.size >= limit) return;
      const path = join(dir, entry.name), relative = rel ? rel + "/" + entry.name : entry.name, key = prefix + "/" + relative;
      let info; try { info = await lstat(path); } catch { continue; }
      if (info.isSymbolicLink()) out.set(key, { type: "link", size: info.size, mtimeMs: info.mtimeMs, target: await readlink(path).catch(() => "") });
      else if (info.isDirectory()) { out.set(key, { type: "dir", mtimeMs: info.mtimeMs }); await walk(path, relative); }
      else if (info.isFile()) out.set(key, { type: "file", size: info.size, mtimeMs: info.mtimeMs, sha256: info.size <= 64 << 20 ? await sha256File(path).catch(() => null) : null });
      else out.set(key, { type: info.isSocket() ? "socket" : info.isFIFO() ? "fifo" : "other", mtimeMs: info.mtimeMs });
    }
  };
  await walk(root, "");
}
async function snapAll(areas) { const out = new Map(); for (const [prefix, root] of Object.entries(areas)) if (root) await snapTree(root, prefix, out); return { at: performance.now(), entries: out }; }
/**
 * Paths and sizes only: added, removed, content changed (sha256 or size), or only touched (mtime). The workspaces are
 * listed entry by entry; the binding's TMPDIR, where runtimes keep caches, is summed per top-level entry.
 */
function diff(before, after) {
  const changes = rawDiff(before, after), tmp = new Map();
  for (const change of changes.filter(item => item.path.startsWith("tmp/"))) {
    const top = change.path.split("/").slice(0, 2).join("/"), entry = tmp.get(top) ?? { path: top, entries: 0, files: 0, bytes: 0, changes: new Set() };
    entry.entries++; if (change.type === "file") { entry.files++; entry.bytes += change.size ?? 0; } entry.changes.add(change.change); tmp.set(top, entry);
  }
  return { workspace: changes.filter(item => !item.path.startsWith("tmp/")), tmpdir: [...tmp.values()].map(entry => ({ ...entry, changes: [...entry.changes].sort() })) };
}
function rawDiff(before, after) {
  const changes = [];
  for (const [path, entry] of after.entries) {
    const old = before.entries.get(path);
    if (!old) changes.push({ path, change: "added", type: entry.type, ...(entry.size === undefined ? {} : { size: entry.size }) });
    else if (entry.type === "file" && (old.type !== "file" || old.sha256 !== entry.sha256 || old.size !== entry.size)) changes.push({ path, change: "modified", type: "file", size: entry.size, sizeBefore: old.size ?? null });
    else if (entry.type === "file" && old.mtimeMs !== entry.mtimeMs) changes.push({ path, change: "touched", type: "file", size: entry.size });
  }
  for (const [path, entry] of before.entries) if (!after.entries.has(path)) changes.push({ path, change: "removed", type: entry.type });
  return changes;
}
async function fresh(dir) { await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true, mode: 0o700 }); }
async function writeMarkers(harness, wsA, wsB) {
  const folder = MARKER_DIRS[harness]; if (!folder) return false;
  for (const [ws, name] of [[wsA, "hh-probe-wsa"], [wsB, "hh-probe-wsb"]]) { await mkdir(join(ws, folder), { recursive: true, mode: 0o700 }); await writeFile(join(ws, folder, name + ".md"), MARKER_TEXT, { mode: 0o600 }); }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- protocols
async function attempt(method, run) {
  const started = performance.now();
  try { const value = await run(); return { method, ok: true, ms: round(performance.now() - started), value }; }
  catch (error) { return { method, ok: false, ms: round(performance.now() - started), error: describe(error) }; }
}
const strip = result => { const { value, ...rest } = result; return rest; };
const OPS = {
  "acp-v1": {
    async initialize(peer) {
      peer.start();
      const response = await peer.request("initialize", ACP_INIT, SETUP_MS), initMs = round(peer.elapsed);
      const caps = response?.agentCapabilities ?? {}, info = response?.agentInfo ?? null;
      return { initMs, agent: info ? { name: info.name ?? null, version: info.version ?? null } : null,
        capabilities: { protocolVersion: response?.protocolVersion ?? null, loadSession: caps.loadSession === true, session: Object.keys(caps.sessionCapabilities ?? {}).sort(),
          prompt: Object.keys(caps.promptCapabilities ?? {}).filter(key => caps.promptCapabilities[key] === true).sort(), mcp: Object.keys(caps.mcpCapabilities ?? {}).sort(),
          authMethods: Array.isArray(response?.authMethods) ? response.authMethods.length : 0 } };
    },
    async open(peer, prepared, cwd, tag) {
      // The production parameters (AcpControl.sessionParameters and its overrides: Claude's _meta, OpenClaw's session key,
      // which reads the Gateway's agents.list through `openclaw gateway call`).
      const before = performance.now(), params = await prepared.control.sessionParameters(cwd), paramsMs = round(performance.now() - before);
      const started = performance.now(), response = await peer.request("session/new", params, SETUP_MS), ms = round(performance.now() - started);
      if (typeof response?.sessionId !== "string") throw remote("INVALID_PROTOCOL", "session/new returned no session id");
      return { tag, id: response.sessionId, ms, paramsMs, totalMs: round(ms + paramsMs), responseKeys: Object.keys(response).sort(), responseEchoesCwd: JSON.stringify(response).includes(cwd),
        ...(typeof params._meta?.sessionKey === "string" ? { key: params._meta.sessionKey } : {}) };
    },
    async cwdChecks(peer, prepared, s1, s2, plan, caps) {
      if (!caps.session.includes("list")) return { list: "not declared" };
      const list = {};
      for (const [own, cwd, other] of [[s1, plan.wsA, s2], [s2, plan.wsB, s1]]) {
        const result = await attempt("session/list", () => peer.request("session/list", { cwd }, REQUEST_MS));
        if (!result.ok) { list[own.tag] = strip(result); continue; }
        const rows = Array.isArray(result.value?.sessions) ? result.value.sessions : [], mine = rows.find(row => row?.sessionId === own.id);
        list[own.tag] = { ms: result.ms, rows: rows.length, listed: mine !== undefined, cwdMatches: mine === undefined ? null : mine.cwd === cwd, otherListed: rows.some(row => row?.sessionId === other.id), rowsWithOtherCwd: rows.filter(row => row?.cwd !== cwd).length };
      }
      return { list };
    },
    async switchBack(peer, prepared, s1, plan, caps) {
      const params = async () => prepared.harness === "openclaw" ? { cwd: plan.wsA, mcpServers: [], _meta: { sessionKey: s1.key, requireExistingSession: true, resetSession: false } } : await prepared.control.sessionParameters(plan.wsA);
      const results = [];
      for (const [method, declared] of [["session/load", caps.loadSession], ["session/resume", caps.session.includes("resume")]]) {
        if (!declared) { results.push({ method, declared: false }); continue; }
        const request = { ...await params(), sessionId: s1.id };
        const result = await attempt(method, () => peer.request(method, request, SETUP_MS));
        results.push({ ...strip(result), declared: true, ...(result.ok ? { sameId: result.value?.sessionId === undefined ? null : result.value.sessionId === s1.id } : {}) });
      }
      return results;
    },
    async closeOne(peer, prepared, session, caps) {
      if (!caps.session.includes("close")) return { method: "session/close", declared: false };
      return { ...strip(await attempt("session/close", () => peer.request("session/close", { sessionId: session.id }, REQUEST_MS))), declared: true };
    },
  },
  "codex-app-server": {
    async initialize(peer) {
      peer.start();
      const response = await peer.request("initialize", CODEX_INIT, SETUP_MS); peer.notify("initialized", {});
      return { initMs: round(peer.elapsed), agent: { name: "codex", version: /\/(\d+\.\d+\.\d+[^\s;()]*)/u.exec(String(response?.userAgent ?? ""))?.[1] ?? null }, capabilities: { responseKeys: Object.keys(response ?? {}).sort() } };
    },
    async open(peer, prepared, cwd, tag) {
      const started = performance.now(), response = await peer.request("thread/start", { cwd, ephemeral: false }, SETUP_MS), ms = round(performance.now() - started), thread = response?.thread ?? {};
      if (typeof thread.id !== "string") throw remote("INVALID_PROTOCOL", "thread/start returned no thread id");
      return { tag, id: thread.id, ms, totalMs: ms, threadCwdMatches: thread.cwd === cwd, responseCwdMatches: response?.cwd === cwd, path: typeof thread.path === "string" ? thread.path : null, ephemeral: thread.ephemeral ?? null };
    },
    async cwdChecks(peer, prepared, s1, s2, plan) {
      const read = {}, list = {};
      for (const [own, cwd, other] of [[s1, plan.wsA, s2], [s2, plan.wsB, s1]]) {
        const got = await attempt("thread/read", () => peer.request("thread/read", { threadId: own.id, includeTurns: false }, REQUEST_MS));
        read[own.tag] = got.ok ? { ms: got.ms, cwdMatches: got.value?.thread?.cwd === cwd } : strip(got);
        const listed = await attempt("thread/list", () => peer.request("thread/list", { cwd, limit: 50, sortKey: "updated_at", sortDirection: "desc", archived: false, sourceKinds: CODEX_LISTED_SOURCES }, REQUEST_MS));
        const rows = listed.ok && Array.isArray(listed.value?.data) ? listed.value.data : [];
        list[own.tag] = listed.ok ? { ms: listed.ms, rows: rows.length, listed: rows.some(row => row?.id === own.id), otherListed: rows.some(row => row?.id === other.id), rowsWithOtherCwd: rows.filter(row => row?.cwd !== cwd).length } : strip(listed);
      }
      return { read, list };
    },
    async switchBack(peer, prepared, s1, plan) {
      const result = await attempt("thread/resume", () => peer.request("thread/resume", { cwd: plan.wsA, threadId: s1.id, excludeTurns: true }, SETUP_MS));
      return [{ ...strip(result), declared: true, ...(result.ok ? { sameId: result.value?.thread?.id === s1.id, cwdMatches: result.value?.thread?.cwd === plan.wsA } : {}) }];
    },
    async closeOne(peer, prepared, session) {
      return { ...strip(await attempt("thread/unsubscribe", () => peer.request("thread/unsubscribe", { threadId: session.id }, REQUEST_MS))), declared: null };
    },
  },
  "pi-rpc": {
    async initialize(peer) {
      // PiControl.initializeOnce's reads: state, models, the current model's thinking levels and the command catalog.
      peer.start();
      const state = await peer.request("get_state", {}, SETUP_MS), readyMs = round(peer.elapsed);
      const models = await peer.request("get_available_models", {}, REQUEST_MS);
      if (state?.model) await peer.request("get_available_thinking_levels", {}, REQUEST_MS).catch(() => null);
      await peer.request("get_commands", {}, REQUEST_MS);
      peer.startup = { id: state?.sessionId ?? null, file: typeof state?.sessionFile === "string" ? state.sessionFile : null };
      return { initMs: round(peer.elapsed), readyMs, agent: { name: "pi", version: null }, capabilities: { models: Array.isArray(models?.models) ? models.models.length : null, sessionAtStart: typeof state?.sessionId === "string" } };
    },
    /** s1 is the session Pi opens at start (get_state names it); any later one is new_session. */
    async open(peer, prepared, cwd, tag) {
      if (tag === "s1") return { tag, id: peer.startup.id, ms: 0, totalMs: 0, file: peer.startup.file, startupSession: true };
      const started = performance.now(), response = await peer.request("new_session", {}, REQUEST_MS), ms = round(performance.now() - started), state = await peer.request("get_state", {}, REQUEST_MS);
      return { tag, id: state?.sessionId ?? null, ms, totalMs: ms, cancelled: response?.cancelled === true, file: typeof state?.sessionFile === "string" ? state.sessionFile : null, requestedCwdApplied: "new_session takes no cwd" };
    },
    async cwdChecks(peer, prepared, s1, s2) {
      const exists = async path => path === null ? null : await stat(path).then(() => true, () => false);
      return { note: "Pi 的 cwd 属于进程；new_session 没有 cwd 参数", files: { s1: await exists(s1.file), s2: await exists(s2.file) } };
    },
    async switchBack(peer, prepared, s1) {
      if (s1.file === null) return [{ method: "switch_session", declared: true, ok: false, error: { code: "NO_FILE", message: "get_state named no session file" } }];
      const result = await attempt("switch_session", () => peer.request("switch_session", { sessionPath: s1.file }, REQUEST_MS));
      const state = result.ok ? await peer.request("get_state", {}, REQUEST_MS).catch(() => null) : null;
      return [{ ...strip(result), declared: true, ...(result.ok ? { cancelled: result.value?.cancelled === true, sameId: state?.sessionId === s1.id } : {}) }];
    },
    async closeOne() { return { method: "none", declared: false }; },
  },
};

// ---------------------------------------------------------------------------------------------------------------- one run
let app;
async function prepareBinding(harnessId, workspace, key) {
  const configuration = await prepareConfiguration({ workspace });
  const selection = await app.factory.validate({ harnessId }, configuration);
  const session = await app.runtime.create(configuration, { harnessId }, key);
  const binding = await app.factory.prepare(selection, configuration, session.id, "hosts-probe");
  const control = binding.control, pi = control.rpc?.launch?.protocol === "pi-rpc";
  // The production launch and options, read from the prepared (never started) control: PiControl adds --no-session to its
  // probe connection, so its base launch is the one its persistent connection starts from.
  const launch = pi ? control.launch : control.rpc.launch, options = pi ? control.options : control.rpc.options;
  return { harness: harnessId, configuration, selection, binding, control, launch, options, tmpRoot: options.env.TMPDIR ?? null };
}
function gatewaySample(run, label) {
  if (!run.gateway?.pid) return;
  const rows = psRows(), procs = treeOf(rows, run.gateway.pid, undefined);
  run.gateway.samples.push({ label, alive: procs.length > 0, totalRssKiB: procs.reduce((sum, proc) => sum + proc.rss, 0), processCount: procs.length });
}
async function runOnce(harness, plan) {
  const run = { kind: plan.kind, run: plan.k, full: plan.full === true };
  await fresh(plan.wsA); await fresh(plan.wsB); run.markers = await writeMarkers(harness, plan.wsA, plan.wsB);
  let prepared, peer = null, caps = null;
  try { prepared = await prepareBinding(harness, plan.wsA, "hosts-" + harness + "-" + plan.kind + plan.k + "-" + randomUUID().slice(0, 8)); }
  catch (error) { run.unavailable = describe(error); return run; }
  let launch = prepared.launch;
  if (launch.protocol === "pi-rpc") { await fresh(plan.piDir); launch = { ...launch, args: [...launch.args, "--session-dir", plan.piDir] }; }
  if (TMP_OVERRIDE !== null) {
    await mkdir(TMP_OVERRIDE, { recursive: true, mode: 0o700 });
    launch = { ...launch, env: { ...launch.env, TMPDIR: TMP_OVERRIDE } };
    prepared = { ...prepared, options: { ...prepared.options, env: { ...prepared.options.env, TMPDIR: TMP_OVERRIDE } }, tmpRoot: TMP_OVERRIDE };
    run.variant = "persistent TMPDIR (" + tilde(TMP_OVERRIDE) + ")";
  }
  run.control = { id: prepared.selection.controlId, protocol: launch.protocol, executable: tilde(launch.executable), args: launch.args.map(tilde), installation: prepared.binding.installation?.source ?? null,
    ...(launch.env.CLAUDE_CODE_EXECUTABLE ? { nativeExecutable: tilde(launch.env.CLAUDE_CODE_EXECUTABLE) } : {}), tmpdir: TMP_OVERRIDE !== null ? "persistent (variant)" : prepared.tmpRoot ? "binding root (" + basename(prepared.tmpRoot).replace(/-[^-]+$/u, "-*") + ")" : null };
  const areas = () => ({ "ws-a": plan.wsA, "ws-b": plan.wsB, tmp: prepared.tmpRoot });
  const snaps = [], sessions = [];
  try {
    if (harness === "hermes") {
      // ADR-051 A2: hermes acp is started only when a compatible gateway already runs (HermesControl.beforeConnect).
      const env = { ...prepared.options.env, ...launch.env }, facts = await readGatewayFacts(env, launch.executable, hostQueries), judged = judgeGateway(facts);
      run.preflight = { kind: judged.kind, verdict: judged.verdict ?? null, evidence: judged.evidence };
      if (judged.kind === "refuse") { run.unavailable = { code: "NATIVE_GATEWAY_UNAVAILABLE", message: "预检 " + judged.verdict }; return run; }
      run.gateway = { label: "ai.hermes.gateway", pid: facts.state?.pid ?? null, samples: [] };
    }
    if (harness === "openclaw") run.gateway = { label: "ai.openclaw.gateway", pid: launchdPid("ai.openclaw.gateway"), samples: [] };
    snaps.push(["before-start", await snapAll(areas())]); gatewaySample(run, "before-start");
    peer = new Peer(harness, launch, prepared.options, { "ws-a": plan.wsA, "ws-b": plan.wsB });
    const ops = OPS[launch.protocol];
    peer.phase = "init";
    const init = await ops.initialize(peer);
    Object.assign(run, { initMs: init.initMs, ...(init.readyMs === undefined ? {} : { readyMs: init.readyMs }), agent: init.agent, capabilities: init.capabilities });
    caps = init.capabilities;
    log(harness, plan.kind + plan.k, "initialize", init.initMs + " ms");
    if (plan.kind === "init-only") {
      peer.phase = "idle-after-init"; await sleep(SETTLE_MS);
      run.rss = { init: peer.sample("init") }; gatewaySample(run, "init");
    } else {
      snaps.push(["before-sessions", await snapAll(areas())]);
      peer.phase = "s1";
      const s1 = await ops.open(peer, prepared, plan.wsA, "s1"); sessions.push({ ...s1, cwd: "ws-a" }); run.s1 = { ...s1, path: tilde(s1.path), file: tilde(s1.file) };
      log(harness, plan.kind + plan.k, "session 1", s1.totalMs + " ms");
      await sleep(SETTLE_MS); run.rss = { s1: peer.sample("s1") }; gatewaySample(run, "s1");
      if (!plan.full && launch.protocol === "pi-rpc") {
        peer.phase = "s2";
        const extra = await ops.open(peer, prepared, plan.wsA, "s2"); sessions.push({ ...extra, cwd: "ws-a" }); run.extraNewSession = { ...extra, file: tilde(extra.file) };
      }
      if (plan.full) {
        peer.phase = "s2";
        const s2 = await ops.open(peer, prepared, plan.wsB, "s2"); sessions.push({ ...s2, cwd: "ws-b" }); run.s2 = { ...s2, path: tilde(s2.path), file: tilde(s2.file) };
        log(harness, plan.kind + plan.k, "session 2", s2.totalMs + " ms");
        await sleep(SETTLE_MS); run.rss.s2 = peer.sample("s2"); gatewaySample(run, "s2");
        peer.phase = "checks";
        run.cwd = await ops.cwdChecks(peer, prepared, s1, s2, plan, caps);
        run.switchBack = await ops.switchBack(peer, prepared, s1, plan, caps);
        log(harness, plan.kind + plan.k, "switch back", run.switchBack.map(item => item.method + "=" + (item.declared === false ? "n/a" : item.ok ? "ok" : "failed") + (item.ms === undefined ? "" : "/" + item.ms + "ms")).join(" "));
        snaps.push(["after-sessions", await snapAll(areas())]);
        peer.phase = "idle"; run.idle = { samples: [] };
        for (let at = IDLE_SAMPLE_MS; at <= IDLE_MS; at += IDLE_SAMPLE_MS) {
          await sleep(IDLE_SAMPLE_MS);
          const now = peer.sample("idle"); run.idle.samples.push({ atS: at / 1000, totalRssKiB: now.totalRssKiB, processCount: now.processCount, children: now.children });
        }
        snaps.push(["after-idle", await snapAll(areas())]); gatewaySample(run, "after-idle");
        peer.phase = "close-one";
        run.closeOne = await ops.closeOne(peer, prepared, s2, caps);
        if (run.closeOne.ok) { await sleep(3000); run.rss.afterCloseOne = peer.sample("after-close-one"); gatewaySample(run, "after-close-one"); }
      } else snaps.push(["after-sessions", await snapAll(areas())]);
    }
  } catch (error) {
    run.failure = describe(error);
    log(harness, plan.kind + plan.k, "FAILED", run.failure.code, run.failure.message);
    if (peer?.tail?.length) log("stderr tail (sanitized, not recorded):", sanitize(peer.tail.toString("utf8").slice(-1500)));
  } finally {
    if (peer?.child) { run.close = await peer.closeStaged(); log(harness, plan.kind + plan.k, "close", run.close.stage, (run.close.groupGoneMs ?? "?") + " ms", run.close.leftovers.length ? "leftovers: " + run.close.leftovers.join(",") : ""); }
    snaps.push(["after-close", await snapAll(areas())]); gatewaySample(run, "after-close");
    run.writes = Object.fromEntries(snaps.slice(1).map(([label, snap], index) => [snaps[index][0] + " → " + label, diff(snaps[index][1], snap)]));
    if (peer) {
      const tags = new Map(sessions.map(item => [item.id, item.tag]));
      run.events = peer.tallies(tags); run.stderrBytes = peer.stderr; run.invalidFrames = peer.invalidFrames;
      run.sessionMetadata = Object.fromEntries(sessions.map(item => [item.tag, peer.perSession.get(item.id) ?? null]));
      if (peer.spawnError) run.spawnError = peer.spawnError;
    }
    run.sessions = sessions.map(item => ({ tag: item.tag, id: item.id, cwd: item.cwd, ...(item.key ? { key: item.key } : {}), ...(item.path ? { path: tilde(item.path) } : {}), ...(item.file ? { file: tilde(item.file) } : {}) }));
    try { run.bindingCleanup = (await prepared.binding.close())?.closed ?? null; } catch (error) { run.bindingCleanupFailure = describe(error); }
  }
  return run;
}

// ---------------------------------------------------------------------------------------------------------------- inventory
/** Names that contain one of `needles`, under `root` to `depth` levels; names only, never content; credential folders are not entered. */
async function findNames(root, needles, depth) {
  const found = [], skip = new Set(["credentials", "node_modules", ".git", "Keychains", ".ssh", ".gnupg"]);
  let visited = 0;
  const walk = async (dir, level) => {
    if (level > depth || visited > 400000) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      visited++;
      const path = join(dir, entry.name);
      if (needles.some(needle => needle && entry.name.includes(needle))) { const info = await lstat(path).catch(() => null); found.push({ path: tilde(path), type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other", ...(info?.isFile() ? { size: info.size } : {}) }); }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !skip.has(entry.name)) await walk(path, level + 1);
    }
  };
  await walk(root, 0);
  return found;
}
async function inventory(harness, record) {
  const sessions = [...record.initOnly, ...record.sessionRuns].flatMap(run => (run.sessions ?? []).map(item => ({ ...item, path: untilde(item.path), file: untilde(item.file), run: run.kind + run.run }))), ids = sessions.map(item => item.id).filter(Boolean);
  const env = process.env, out = { sessions: sessions.map(item => ({ run: item.run, tag: item.tag, id: item.id, cwd: item.cwd, ...(item.key ? { key: item.key } : {}) })), stored: [] };
  const exists = async path => path ? await stat(path).then(info => ({ path: tilde(path), exists: true, size: info.size }), () => ({ path: tilde(path), exists: false })) : null;
  switch (harness) {
    case "claude": {
      const config = env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"), projects = join(config, "projects");
      for (const name of (await readdir(projects).catch(() => [])).filter(name => name.includes("hosts-" + DAY))) {
        const entries = await readdir(join(projects, name), { withFileTypes: true }).catch(() => []);
        out.stored.push({ path: tilde(join(projects, name)), type: "dir", entries: await Promise.all(entries.map(async entry => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file", ...(entry.isFile() ? { size: (await lstat(join(projects, name, entry.name))).size } : {}) }))) });
      }
      out.stored.push(...await findNames(config, ids, 1));
      break;
    }
    case "codex": {
      for (const item of sessions) if (item.path) out.stored.push({ id: item.id, ...await exists(item.path) });
      const dirs = [...new Set(sessions.filter(item => item.path).map(item => dirname(item.path)))];
      for (const dir of dirs) out.stored.push(...(await findNames(dir, ids, 0)).map(item => ({ ...item, foundBy: "name" })));
      break;
    }
    case "opencode": out.stored.push(...await findNames(join(env.XDG_DATA_HOME ?? join(HOME, ".local", "share"), "opencode"), ids, 5)); out.note = "OpenCode 2 把会话存在 ~/.local/share/opencode/opencode.db（没有打开数据库，只按名字找文件）"; break;
    case "dsh": out.stored.push(...await findNames(env.DSH_HOME ?? join(HOME, ".dsh"), ids, 5)); break;
    case "hermes": out.stored.push(...await findNames(await resolveHermesHome(env), ids, 3)); out.note = "Hermes 网关的会话在它的 state.db（没有打开数据库，只按名字找文件）"; break;
    case "openclaw": out.stored.push(...await findNames(env.OPENCLAW_STATE_DIR ?? join(HOME, ".openclaw"), [...ids, ...sessions.map(item => item.key?.split(":").at(-1))], 5)); break;
    case "pi": for (const item of sessions) if (item.file) out.stored.push({ id: item.id, ...await exists(item.file) }); out.note = "--session-dir 在测量根目录下，测完随工作区删除"; break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- summary
function summarize(record) {
  const ok = runs => runs.filter(run => !run.failure && !run.unavailable), init = ok(record.initOnly), sessions = ok(record.sessionRuns), full = record.sessionRuns.find(run => run.full);
  const pi = record.sessionRuns.some(run => run.control?.protocol === "pi-rpc");
  const newSessionSamples = pi ? [full?.s2?.ms, ...sessions.map(run => run.extraNewSession?.ms)] : sessions.map(run => run.s1?.totalMs);
  const closes = [...record.initOnly, ...record.sessionRuns].map(run => run.close).filter(Boolean);
  return {
    initMs: { initOnly: init.map(run => run.initMs), sessionRuns: sessions.map(run => run.initMs), median: median([...init, ...sessions].map(run => run.initMs)) },
    ...(pi ? { readyMs: { all: [...init, ...sessions].map(run => run.readyMs), median: median([...init, ...sessions].map(run => run.readyMs)) } } : {}),
    firstSessionMs: { all: newSessionSamples, median: median(newSessionSamples), ...(pi ? { meaning: "new_session；Pi 启动时已有一个会话（get_state）" } : {}),
      ...(record.harness === "openclaw" ? { paramsMs: sessions.map(run => run.s1?.paramsMs), newMs: sessions.map(run => run.s1?.ms) } : {}) },
    startToFirstSessionMs: pi ? median([...init, ...sessions].map(run => run.readyMs)) : median(sessions.map(run => run.initMs + run.s1?.totalMs)),
    rssMiB: { afterInit: median(init.map(run => run.rss?.init?.totalRssMiB)), oneSession: median(sessions.map(run => run.rss?.s1?.totalRssMiB)), twoSessions: full?.rss?.s2?.totalRssMiB ?? null,
      afterIdle: full?.idle?.samples?.length ? round(full.idle.samples.at(-1).totalRssKiB / 1024, 1) : null, afterCloseOne: full?.rss?.afterCloseOne?.totalRssMiB ?? null },
    children: { afterInit: init[0]?.rss?.init?.children ?? null, oneSession: sessions[0]?.rss?.s1?.children ?? null, twoSessions: full?.rss?.s2?.children ?? null },
    close: { groupGoneMs: closes.map(item => item.groupGoneMs), median: median(closes.map(item => item.groupGoneMs)), stages: closes.map(item => item.stage), leftovers: [...new Set(closes.flatMap(item => item.leftovers ?? []))] },
  };
}

// ---------------------------------------------------------------------------------------------------------------- main
/** The evidence header always describes every Harness of this measurement, whichever ones an invocation runs. */
const ALL = ["claude", "codex", "opencode", "dsh", "hermes", "openclaw", "pi"];
const method = { initRuns: INIT_RUNS, sessionRuns: SESSION_RUNS, settleMs: SETTLE_MS, idleMs: IDLE_MS, idleSampleMs: IDLE_SAMPLE_MS, eofWaitMs: EOF_WAIT_MS, lingerMs: LINGER_MS, root: tilde(ROOT), harnesses: HARNESSES };
const previous = argv.has("merge") ? await readFile(OUT, "utf8").then(text => JSON.parse(text), () => null) : null;
const results = { format: "harnesshub-native-hosts/1", note: "只用于测量，不是实现", recordedAt: previous?.recordedAt ?? new Date().toISOString(), method,
  invocations: [...(previous?.invocations ?? []), { startedAt: new Date().toISOString(), ...method }],
  machine: { cpu: sh("sysctl -n machdep.cpu.brand_string"), memoryGiB: round(Number(sh("sysctl -n hw.memsize")) / 2 ** 30), os: "macOS " + sh("sw_vers -productVersion") + " (" + sh("sw_vers -buildVersion") + ")", node: process.version, arch: process.arch },
  which: Object.fromEntries(["claude", "claude-agent-acp", "codex", "opencode", "dsh", "hermes", "openclaw", "pi", "node"].map(name => [name, sh("which -a " + name).split("\n").filter(Boolean).map(tilde)])),
  header: null, harnesses: { ...(previous?.harnesses ?? {}) }, ...(previous?.variants ? { variants: { ...previous.variants } } : {}), guard: { ...(previous?.guard ?? {}) } };
async function save() {
  let text = JSON.stringify(results, null, 2) + "\n";
  if (text.includes(HOME + "/")) { results.privacyNote = "an absolute home path was replaced by ~ when saving"; text = JSON.stringify(results, null, 2).split(HOME + "/").join("~/") + "\n"; }
  await writeFile(OUT, text, { mode: 0o644 });
}
const environment = captureNativeEnvironment(), appRoot = join(ROOT, "app");
await mkdir(ROOT, { recursive: true, mode: 0o700 }); await rm(appRoot, { recursive: true, force: true }); await mkdir(appRoot, { recursive: true, mode: 0o700 });
app = application(join(appRoot, "data"), () => {}, { installations: "official", workspaceLockRoot: join(appRoot, "locks") });
try {
  results.header = await evidenceHeader(app, ALL, { configuration: await prepareConfiguration({ workspace: ROOT }) });
  for (const harness of HARNESSES) {
    log("=== " + harness);
    const before = await snapshot([harness], environment), base = join(ROOT, harness);
    const plan = { wsA: join(base, "ws-a"), wsB: join(base, "ws-b"), piDir: join(base, "pi-sessions") };
    const record = { harness, initOnly: [], sessionRuns: [] };
    try {
      for (let k = 1; k <= INIT_RUNS; k++) { const run = await runOnce(harness, { ...plan, kind: "init-only", k }); record.initOnly.push(run); if (run.unavailable) break; }
      if (!record.initOnly.some(run => run.unavailable)) for (let k = 1; k <= SESSION_RUNS; k++) { const run = await runOnce(harness, { ...plan, kind: "sessions", k, full: k === 1 }); record.sessionRuns.push(run); if (run.unavailable) break; }
      record.unavailable = [...record.initOnly, ...record.sessionRuns].find(run => run.unavailable)?.unavailable ?? null;
      record.summary = summarize(record);
      record.inventory = await inventory(harness, record);
    } catch (error) { record.failure = describe(error); }
    const guard = await recheck(before, environment);
    record.guard = guard;
    const name = TMP_OVERRIDE === null ? harness : harness + ":persistent-tmpdir";
    results.guard[name] = { unchanged: guard.unchanged, changed: guard.changed, ...(guard.failure ? { failure: guard.failure } : {}) };
    if (TMP_OVERRIDE === null) results.harnesses[harness] = record; else { results.variants ??= {}; results.variants[name] = record; }
    await save();
    log(harness, "guard:", describeGuard(guard));
    if (!guard.unchanged) { results.stopped = { harness, reason: describeGuard(guard) }; log("STOP: the guard found a change"); break; }
  }
} finally {
  try { await app.runtime.close(); } finally { try { await app.management.shutdown(); } finally { try { await app.providers.shutdown(); } finally { app.store.close(); } } }
  await rm(appRoot, { recursive: true, force: true });
  if (!KEEP) { for (const harness of HARNESSES) await rm(join(ROOT, harness), { recursive: true, force: true }); if (TMP_OVERRIDE !== null) await rm(TMP_OVERRIDE, { recursive: true, force: true }); }
  results.finishedAt = new Date().toISOString();
  await save();
  log("results:", tilde(OUT));
}
