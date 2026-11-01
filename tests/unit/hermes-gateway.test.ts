import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { CHECKOUT_FILES, GATEWAY_FILES, gatewayRefusalMessage, hermesCheckout, hermesGatewayPreflight, judgeGateway, launchdLabel, parseLaunchctlPrint, parsePsRow, readGatewayFacts,
  resolveHermesHome, type GatewayFacts, type GatewayHostQueries, type GatewayPreflight, type GatewayRecord } from "../../src/adapters/control/hermes-gateway.js";

const HOME = "/Users/fixture", GATEWAY_HOME = HOME + "/.hermes";
const COMMIT = "4e58c721c8cf9b51c46636ea84ea6a5cb540880a", OLDER = "d923a5eb" + "0".repeat(32);
/** When the gateway started (epoch ms); Hermes records it in centiseconds (gateway/status.py `_get_process_start_time`). */
const STARTED = Date.UTC(2026, 9, 22, 2, 11, 12);
const LIVE = "/Users/fixture/.hermes/hermes-agent/.hermes/bin/hermes gateway run --external-supervisor";
const ABSENT = { label: "ai.hermes.gateway", status: "absent", state: null, pid: null, installed: false } as const;
function record(over: Partial<GatewayRecord> = {}): GatewayRecord {
  return { pid: 63966, startTime: STARTED / 10, hermesHome: GATEWAY_HOME, kind: "hermes-gateway", argv: ["/Users/fixture/.hermes/hermes-agent/.hermes/bin/hermes", "gateway", "run", "--external-supervisor"], ...over };
}
/** The facts of this machine on 2026-10-22: a launchd-supervised v0.22.4 gateway serving QQ, booted from the installed commit. */
function facts(over: Partial<GatewayFacts> = {}): GatewayFacts {
  return { home: GATEWAY_HOME, viewer: true, stampCommit: COMMIT, socket: true, updating: false,
    state: { ...record(), gatewayState: "running", codeSha: COMMIT, updatedAt: "2026-10-22T02:12:00Z", platforms: ["qqbot"] },
    pidRecord: record(), lockRecord: record(), process: { startedAt: STARTED, command: LIVE },
    launchd: { label: "ai.hermes.gateway", status: "loaded", state: "running", pid: 63946, installed: true }, ...over };
}
/** No gateway at all: no records, no process, nothing supervised. */
function nothing(over: Partial<GatewayFacts> = {}): GatewayFacts { return facts({ state: null, pidRecord: null, lockRecord: null, process: null, socket: false, launchd: ABSENT, ...over }); }
function verdict(judged: GatewayPreflight): string { return judged.kind === "in-process" ? "in-process" : judged.verdict; }
function refused(judged: GatewayPreflight): Extract<GatewayPreflight, { kind: "refuse" }> { assert.equal(judged.kind, "refuse", JSON.stringify(judged)); return judged as Extract<GatewayPreflight, { kind: "refuse" }>; }

test("G032-NC31 the gateway preflight attaches only to a running gateway whose process, start time, command line, profile and code are verified (A)", () => {
  const attached = judgeGateway(facts());
  assert.equal(attached.kind, "attach"); assert.equal(verdict(attached), "A");
  assert.match(attached.explanation, /pid 63966/u); assert.ok(attached.evidence.some(line => line.includes("platforms=qqbot")), attached.evidence.join("\n"));
  assert.ok(!JSON.stringify(attached).includes(HOME), "no path leaves the judgement");
  // Positive variants of a verified process: the clock-step tolerance, the unsupervised and the dedicated entry points.
  assert.equal(verdict(judgeGateway(facts({ process: { startedAt: STARTED + 4000, command: LIVE } }))), "A");
  for (const command of ["/opt/python3 -m hermes_cli.main --profile work gateway run --quiet --idle-exit", "python3 gateway/run.py", "python3 -m gateway.run", "/x/.hermes/bin/hermes gateway restart"])
    assert.equal(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command } }))), "A", command);
  // An unreadable command line falls back to the record's own argv and kind, as Hermes does.
  assert.equal(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command: "" } }))), "A");
  assert.notEqual(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command: "" }, state: { ...facts().state!, kind: "maintenance" } }))), "A");
  // So does a Hermes inline bootstrap (the real v0.22.5 launchd gateway: python3 -I -c <closure repair…>, truncated by ps long
  // before its argv); its record carries kind hermes-gateway and the gateway argv. Another kind, or a non-gateway argv, is not it.
  const bootstrap = "/Users/fixture/.hermes/tools/python-3.14.9+20261021-darwin-arm64/bin/python3 -I -c import os, re, sys\\012import contextlib, hashlib, io, pathlib, shutil, subprocess\\012os.environ.pop('PYTHONHOME', None)";
  assert.equal(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command: bootstrap }, state: { ...facts().state!, argv: ["/Users/fixture/.hermes/hermes-agent/hermes_cli/main.py", "gateway", "run", "--external-supervisor"] } }))), "A");
  assert.notEqual(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command: bootstrap }, state: { ...facts().state!, kind: "gateway" } }))), "A", "an unknown record kind");
  assert.notEqual(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command: bootstrap }, state: { ...facts().state!, argv: ["python", "-m", "hermes_cli.main", "gateway", "status"] } }))), "A", "a bootstrap of another command");
  // A record without a start time or home proves nothing against the process and still attaches (Hermes: a conflict needs both sides).
  assert.equal(verdict(judgeGateway(facts({ state: { ...facts().state!, startTime: null, hermesHome: null } }))), "A");
  // Negative samples: each breaks the chain and nothing is attached.
  const stale = judgeGateway(facts({ process: null }));
  assert.equal(stale.kind, "refuse"); assert.notEqual(verdict(stale), "A");
  assert.notEqual(verdict(judgeGateway(facts({ process: { startedAt: STARTED + 60_000, command: LIVE } }))), "A", "a recycled pid started at another time");
  for (const command of ["/usr/bin/osascript -e 'do shell script \"hermes gateway run\"'", "/x/.hermes/bin/hermes gateway status", "python3 -m tui_gateway", "/usr/bin/vim gateway run.txt"])
    assert.notEqual(verdict(judgeGateway(facts({ process: { startedAt: STARTED, command } }))), "A", command);
  assert.notEqual(verdict(judgeGateway(facts({ state: { ...facts().state!, hermesHome: GATEWAY_HOME + "/profiles/work" } }))), "A", "another profile's record");
  assert.notEqual(verdict(judgeGateway(facts({ state: { ...facts().state!, gatewayState: "stopped" } }))), "A");
  assert.notEqual(verdict(judgeGateway(facts({ state: { ...facts().state!, pid: null } }))), "A");
});

test("G032-NC31 a running gateway on other code than the installed Hermes is refused as B, with Hermes's restart", () => {
  const skewed = refused(judgeGateway(facts({ state: { ...facts().state!, codeSha: OLDER } })));
  assert.equal(skewed.verdict, "B");
  assert.match(skewed.explanation, /code_sha d923a5eb00/u); assert.match(skewed.explanation, /commit 4e58c721c8/u); assert.match(skewed.explanation, /替换/u);
  assert.deepEqual(skewed.commands, ["hermes gateway status", "hermes gateway restart"]);
  assert.match(skewed.explanation, /HarnessHub 不会启动、停止或替换你的 Hermes 网关/u); assert.match(skewed.explanation, /竞态/u);
  // A code identity that cannot be compared is not compatibility either.
  assert.equal(refused(judgeGateway(facts({ state: { ...facts().state!, codeSha: null } }))).verdict, "B");
  assert.equal(refused(judgeGateway(facts({ stampCommit: null }))).verdict, "B");
  // The same commit is A: B needs an actual difference or an unknown side.
  assert.equal(verdict(judgeGateway(facts({ state: { ...facts().state!, codeSha: COMMIT } }))), "A");
  const message = gatewayRefusalMessage(skewed);
  assert.ok(message.startsWith("Hermes 的网关当前不可用（预检 B）："), message);
  assert.ok(message.endsWith("请在终端运行：hermes gateway status，再 hermes gateway restart。"), message);
});

test("G032-NC31 a gateway the viewer would wait for is refused as C: starting, draining, degraded, updating, a held lock, a running launchd job or a missing socket", () => {
  for (const gatewayState of ["starting", "draining", "degraded", "conflict"]) {
    const waiting = refused(judgeGateway(facts({ state: { ...facts().state!, gatewayState } })));
    assert.equal(waiting.verdict, "C", gatewayState); assert.match(waiting.explanation, /60 秒/u); assert.deepEqual(waiting.commands, ["hermes gateway status"]);
  }
  assert.equal(refused(judgeGateway(facts({ updating: true }))).verdict, "C", "an update owns the install even with a gateway running");
  assert.match(refused(judgeGateway(facts({ updating: true }))).explanation, /update_paused/u);
  assert.equal(refused(judgeGateway(facts({ socket: false }))).verdict, "C", "running but no control socket yet");
  // A lock or pid record whose process is alive reserves the home before the state is published.
  assert.equal(refused(judgeGateway(facts({ state: null, pidRecord: null, launchd: ABSENT }))).verdict, "C");
  assert.equal(refused(judgeGateway(facts({ state: null, lockRecord: null, launchd: ABSENT }))).verdict, "C");
  // launchd runs the job but no gateway has published itself: the osascript wrapper is alive, the gateway is not yet.
  assert.equal(refused(judgeGateway(nothing({ launchd: { ...ABSENT, status: "loaded", state: "running", pid: 63946, installed: true } }))).verdict, "C");
  // A stopped or failed record with a stale process is not "transitional": the viewer would start afresh (D/E).
  assert.equal(refused(judgeGateway(nothing({ state: { ...facts().state!, gatewayState: "startup_failed" }, process: { startedAt: STARTED, command: LIVE } }))).verdict, "E");
});

test("G032-NC31 without a running gateway, a registered launchd service is D and nothing registered is E", () => {
  const loaded = refused(judgeGateway(nothing({ launchd: { ...ABSENT, status: "loaded", state: "waiting", pid: null, installed: true } })));
  assert.equal(loaded.verdict, "D"); assert.match(loaded.explanation, /launchctl kickstart/u); assert.deepEqual(loaded.commands, ["hermes gateway status", "hermes gateway start"]);
  const installed = refused(judgeGateway(nothing({ launchd: { ...ABSENT, installed: true } })));
  assert.equal(installed.verdict, "D"); assert.match(installed.explanation, /launchctl bootstrap/u);
  assert.equal(refused(judgeGateway(nothing({ launchd: { ...ABSENT, status: "unknown" } }))).verdict, "D", "an unanswerable launchd is not nothing");
  // A stale state file whose process is gone is no gateway: the supervisor decides between D and E.
  assert.equal(refused(judgeGateway(nothing({ state: facts().state, launchd: { ...ABSENT, status: "loaded", state: "waiting", installed: true } }))).verdict, "D");
  const bare = refused(judgeGateway(nothing()));
  assert.equal(bare.verdict, "E"); assert.match(bare.explanation, /无人监督、空闲即退出/u); assert.deepEqual(bare.commands, ["hermes gateway status", "hermes gateway start"]);
  assert.equal(refused(judgeGateway(nothing({ state: facts().state }))).verdict, "E", "a stale running record alone");
  assert.equal(refused(judgeGateway(nothing({ viewer: null }))).verdict, "E", "a checkout that cannot be read is judged as the viewer");
  // Profile labels name the service the viewer would start.
  assert.match(refused(judgeGateway(nothing({ launchd: { ...ABSENT, label: "ai.hermes.gateway-work", status: "loaded", state: "waiting", installed: true } }))).explanation, /ai\.hermes\.gateway-work/u);
});

test("G032-NC31 a checkout without the gateway viewer runs its sessions in-process and is not judged against the gateway", () => {
  for (const sample of [nothing({ viewer: false }), facts({ viewer: false, state: { ...facts().state!, codeSha: OLDER } }), facts({ viewer: false, updating: true })]) {
    const judged = judgeGateway(sample);
    assert.equal(judged.kind, "in-process"); assert.match(judged.explanation, /gateway_server\.py/u);
  }
});

test("G032-NC31 the host answers are parsed from launchctl print's top-level fields and ps's lstart row", () => {
  const printed = "ai.hermes.gateway = {\n\tactive count = 1\n\tpath = /Users/x/Library/LaunchAgents/ai.hermes.gateway.plist\n\tstate = running\n\n\tprogram = /usr/bin/osascript\n\tenvironment = {\n\t\tHERMES_HOME => /Users/x/.hermes\n\t\tpid = 7\n\t}\n\tpid = 63946\n\truns = 3\n}\n";
  assert.deepEqual(parseLaunchctlPrint(printed), { state: "running", pid: 63946 });
  assert.deepEqual(parseLaunchctlPrint("ai.hermes.gateway = {\n\tstate = waiting\n\tlast exit code = 0\n}\n"), { state: "waiting", pid: null });
  assert.deepEqual(parseLaunchctlPrint(""), { state: null, pid: null });
  const row = parsePsRow("Sun Nov  1 14:08:17 2026 " + LIVE + "\n");
  assert.ok(row !== null); assert.equal(row.command, LIVE); assert.equal(row.startedAt, Date.parse("Sun Nov  1 14:08:17 2026"));
  assert.equal(parsePsRow("Thu Oct 22 10:11:12 2026 /usr/bin/osascript -e x\n")?.command, "/usr/bin/osascript -e x");
  assert.equal(parsePsRow(""), null); assert.equal(parsePsRow("   \n"), null);
  // The label follows Hermes's service_suffix: bare for the account default home, the profile name, else a path hash.
  assert.equal(launchdLabel(GATEWAY_HOME, HOME), "ai.hermes.gateway");
  assert.equal(launchdLabel(GATEWAY_HOME + "/profiles/work", HOME), "ai.hermes.gateway-work");
  assert.equal(launchdLabel(GATEWAY_HOME + "/profiles/Bad Name", HOME).length, "ai.hermes.gateway-".length + 8);
  assert.match(launchdLabel("/srv/hermes", HOME), /^ai\.hermes\.gateway-[0-9a-f]{8}$/u);
  assert.equal(launchdLabel(HOME + "/.hermes-dev", HOME, "-dev"), "ai.hermes.gateway");
  // The checkout is the one the executable runs from, else the installer's.
  assert.equal(hermesCheckout({ HOME }, "/opt/hermes/.hermes/bin/hermes"), "/opt/hermes");
  assert.equal(hermesCheckout({ HOME }, "/opt/hermes/.hermes/bin/hermes-acp"), "/opt/hermes");
  assert.equal(hermesCheckout({ HOME }, HOME + "/.local/bin/hermes"), GATEWAY_HOME + "/hermes-agent");
});

async function temporary(t: TestContext): Promise<string> {
  // A short prefix: the fixture's unix socket path must stay under the platform's limit. Canonical, as Hermes records homes.
  const root = await realpath(await mkdtemp(join(tmpdir(), "hg-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(path: string, text: string, mode = 0o600): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode }); }
async function listen(t: TestContext, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => resolve()); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
}
const CREDENTIALS = [".env", "auth.json", "config.yaml", "state.db", "SOUL.md"];
function fakeHost(questions: { targets: string[]; pids: number[] }, launchd: { status: "loaded" | "absent" | "unknown"; output: string } = { status: "loaded", output: "ai.hermes.gateway = {\n\tstate = running\n\tpid = 63946\n}\n" }, row: string | null = "Thu Oct 22 10:11:12 2026 " + LIVE): GatewayHostQueries {
  return { launchd: async target => { questions.targets.push(target); return launchd; }, process: async pid => { questions.pids.push(pid); return row === null ? null : parsePsRow(row); } };
}
/** A home as the installer and a running gateway leave it, with credentials beside the records. */
async function hermesHome(t: TestContext, home: string, checkout: string, startedAt: number): Promise<void> {
  await put(join(home, "gateway_state.json"), JSON.stringify({ pid: 63966, kind: "hermes-gateway", argv: ["python", "-m", "hermes_cli.main", "gateway", "run"], start_time: startedAt / 10, hermes_home: home, gateway_state: "running",
    exit_reason: null, restart_requested: false, active_agents: 0, platforms: { qqbot: { state: "connected" } }, updated_at: "2026-10-22T02:12:00+00:00", code_sha: COMMIT, code_version: "0.22.4+70.g4e58c72", session_store: { status: "ok" } }));
  await put(join(home, "gateway.pid"), "63966\n", 0o755);
  await put(join(home, "gateway.lock"), JSON.stringify({ pid: 63966, kind: "hermes-gateway", argv: ["python", "-m", "hermes_cli.main", "gateway", "run"], start_time: startedAt / 10, hermes_home: home, profile: "default" }));
  await listen(t, join(home, "gateway.sock"));
  await put(join(checkout, "install-stamp.json"), JSON.stringify({ schemaVersion: 2, commit: COMMIT, baseVersion: "0.22.4", displayVersion: "0.22.4+70.g4e58c72" }));
  await put(join(checkout, "acp_adapter", "gateway_server.py"), "# viewer\n");
  await put(join(checkout, "acp_adapter", "server.py"), "# agent\n");
  for (const name of CREDENTIALS) { await put(join(home, name), "SECRET-" + name); await chmod(join(home, name), 0o000); }
}

test("G032-NC32 the reader resolves the home as hermes does, reads only the named records and never a credential file", async t => {
  const root = await temporary(t), home = join(root, ".hermes"), checkout = join(home, "hermes-agent"), started = Date.parse("Thu Oct 22 10:11:12 2026");
  await hermesHome(t, home, checkout, started);
  await put(join(root, "Library", "LaunchAgents", "ai.hermes.gateway.plist"), "<plist/>");
  const touched: string[] = [], questions = { targets: [] as string[], pids: [] as number[] };
  const read = await readGatewayFacts({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost(questions), path => touched.push(path));
  assert.equal(read.home, home); assert.equal(read.viewer, true); assert.equal(read.stampCommit, COMMIT); assert.equal(read.socket, true); assert.equal(read.updating, false);
  assert.deepEqual(read.state, { pid: 63966, startTime: started / 10, hermesHome: home, kind: "hermes-gateway", argv: ["python", "-m", "hermes_cli.main", "gateway", "run"], gatewayState: "running", codeSha: COMMIT, updatedAt: "2026-10-22T02:12:00+00:00", platforms: ["qqbot"] });
  assert.deepEqual(read.pidRecord, { pid: 63966, startTime: null, hermesHome: null, kind: null, argv: null }, "a bare pid file is a record of its pid alone");
  assert.equal(read.lockRecord?.pid, 63966); assert.equal(read.lockRecord?.hermesHome, home);
  assert.deepEqual(read.process, { startedAt: started, command: LIVE });
  assert.deepEqual(read.launchd, { label: "ai.hermes.gateway", status: "loaded", state: "running", pid: 63946, installed: true });
  assert.deepEqual(questions, { targets: ["gui/" + String(process.getuid!()) + "/ai.hermes.gateway"], pids: [63966] });
  // Every path looked at is one of the named files, the checkout itself, the profile pointer or the plist; the credentials were never opened.
  const allowed = new Set([...GATEWAY_FILES.map(name => join(home, name)), ...CHECKOUT_FILES.map(name => join(checkout, name)), checkout, join(root, "Library", "LaunchAgents", "ai.hermes.gateway.plist")]);
  for (const path of touched) assert.ok(allowed.has(path), "read outside the named files: " + path);
  assert.ok(touched.every(path => !CREDENTIALS.includes(basename(path))));
  for (const name of ["gateway_state.json", "gateway.pid", "gateway.lock", "gateway.sock"]) assert.ok(touched.includes(join(home, name)), name);
  // The whole preflight on these facts is A.
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }))), "A");
  // The same home read by its gateway's dead pid is no gateway, and with its launchd job loaded that is D.
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }, { status: "loaded", output: "x = {\n\tstate = waiting\n}\n" }, null))), "D");
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }, { status: "absent", output: "" }, null))), "D", "the plist is installed");
  await rm(join(root, "Library", "LaunchAgents", "ai.hermes.gateway.plist"));
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }, { status: "absent", output: "" }, null))), "E");
  // An update fence in the checkout, and a gateway that booted from other code.
  await put(join(checkout, ".hermes-update-in-progress"), "");
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }))), "C");
  await rm(join(checkout, ".hermes-update-in-progress"));
  await put(join(checkout, "install-stamp.json"), JSON.stringify({ commit: OLDER, displayVersion: "0.23.0" }));
  assert.equal(verdict(await hermesGatewayPreflight({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost({ targets: [], pids: [] }))), "B");
});

test("G032-NC32 HERMES_HOME, the sticky profile and the executable's checkout move what is read; invalid records are absent facts; a pre-viewer checkout is in-process", async t => {
  const root = await temporary(t), questions = { targets: [] as string[], pids: [] as number[] };
  // HERMES_HOME wins, ~ is the home, and the profile pointer is not even read then.
  const touched: string[] = [];
  assert.equal(await resolveHermesHome({ HOME: root, HERMES_HOME: "~/elsewhere" }, path => touched.push(path)), join(root, "elsewhere"));
  assert.equal(await resolveHermesHome({ HOME: root, HERMES_HOME: "/srv/hermes" }), "/srv/hermes");
  assert.deepEqual(touched, []);
  // The sticky profile names the home when its directory exists; "default", an invalid name or a missing directory keep the root.
  assert.equal(await resolveHermesHome({ HOME: root }), join(root, ".hermes"));
  await put(join(root, ".hermes", "active_profile"), "work\n");
  assert.equal(await resolveHermesHome({ HOME: root }), join(root, ".hermes"), "a profile without a directory");
  await mkdir(join(root, ".hermes", "profiles", "work"), { recursive: true });
  assert.equal(await resolveHermesHome({ HOME: root }), join(root, ".hermes", "profiles", "work"));
  for (const name of ["default", "Bad Name", "../x", ""]) { await writeFile(join(root, ".hermes", "active_profile"), name); assert.equal(await resolveHermesHome({ HOME: root }), join(root, ".hermes"), JSON.stringify(name)); }
  await writeFile(join(root, ".hermes", "active_profile"), "work");
  // The profile's gateway is read from the profile home and asked of its own launchd label.
  const profile = join(root, ".hermes", "profiles", "work"), checkout = join(root, ".hermes", "hermes-agent"), started = Date.parse("Thu Oct 22 10:11:12 2026");
  await hermesHome(t, profile, checkout, started);
  const read = await readGatewayFacts({ HOME: root }, join(root, ".local", "bin", "hermes"), fakeHost(questions, { status: "absent", output: "" }));
  assert.equal(read.home, profile); assert.equal(read.launchd.label, "ai.hermes.gateway-work"); assert.deepEqual(questions.targets, ["gui/" + String(process.getuid!()) + "/ai.hermes.gateway-work"]);
  assert.equal(read.state?.hermesHome, profile); assert.equal(verdict(judgeGateway(read)), "A");
  // Invalid or oversized records are absent facts, a pointer names the socket, and the executable's own checkout is read.
  const other = join(root, "opt", "hermes");
  await put(join(other, "install-stamp.json"), JSON.stringify({ commit: "not a sha" }));
  await put(join(other, "acp_adapter", "server.py"), "# 0.22.2: no gateway_server.py\n");
  await put(join(profile, "gateway_state.json"), "{ not json");
  await put(join(profile, "gateway.pid"), "pid: 1\n");
  await rm(join(profile, "gateway.sock"));
  const socketDir = join(root, "t", "hermes-gw-abc"); await listen(t, join(socketDir, "control.sock"));
  await put(join(profile, "gateway.sock.path"), join(socketDir, "control.sock") + "\n");
  const partial = await readGatewayFacts({ HOME: root }, join(other, ".hermes", "bin", "hermes"), fakeHost({ targets: [], pids: [] }, { status: "absent", output: "" }));
  assert.equal(partial.state, null); assert.equal(partial.pidRecord, null); assert.equal(partial.stampCommit, null); assert.equal(partial.viewer, false); assert.equal(partial.socket, true);
  assert.equal(partial.lockRecord?.pid, 63966, "the lock still reads");
  assert.equal(judgeGateway(partial).kind, "in-process", "a checkout without the viewer never needs the gateway");
  // A missing checkout is unknown, and judged as the viewer.
  const unknown = await readGatewayFacts({ HOME: root }, join(root, "absent", ".hermes", "bin", "hermes"), fakeHost({ targets: [], pids: [] }, { status: "absent", output: "" }));
  assert.equal(unknown.viewer, null); assert.equal(unknown.stampCommit, null);
  assert.equal(refused(judgeGateway(unknown)).verdict, "C", "the lock's process is alive: the viewer would wait");
});
