import assert from "node:assert/strict";
import test from "node:test";
import { ManagementError, type ManagementInstallContext, type ManagementRecipe, type NativeInstallPlan, type UsedService } from "../../src/contracts/management.js";
import { inspectProgramUsage, inspectRootsUsage, installationRoots, parseJob, parseJobs, parseListening, parseOpeners, parseProcessTable, parseServiceState, portArgument, programName, restartProgramService, type ProgramHost } from "../../src/infrastructure/management/program-usage.js";

// Shapes of the real macOS outputs (launchctl 7.0 on macOS 27, lsof 4.91), with the values of this test only.
const JOBS = "PID\tStatus\tLabel\n4039\t0\tai.openclaw.gateway\n4736\t0\tai.openclaw.node\n-\t0\tai.openclaw.sync-claude-token\n4058\t0\tai.hermes.gateway\n312\t0\tcom.apple.Finder\n";
const job = (pid: number, args: readonly string[]) => "{\n\t\"StandardOutPath\" = \"/tmp/out.log\";\n\t\"Label\" = \"label\";\n\t\"OnDemand\" = false;\n\t\"LastExitStatus\" = 0;\n\t\"PID\" = " + pid + ";\n\t\"Program\" = \"" + args[0] + "\";\n\t\"ProgramArguments\" = (\n"
  + args.map(arg => "\t\t\"" + arg + "\";\n").join("") + "\t);\n};\n";
const GATEWAY = job(4039, ["/opt/homebrew/opt/node/bin/node", "/opt/homebrew/lib/node_modules/openclaw/dist/index.js", "gateway", "--port", "18789"]);
const NODE = job(4736, ["/opt/homebrew/opt/node/bin/node", "/opt/homebrew/lib/node_modules/openclaw/dist/index.js", "node", "run", "--host", "127.0.0.1", "--port", "18789"]);
const HERMES = job(4058, ["/Users/me/.hermes/hermes-agent/venv/bin/python", "-m", "hermes_cli.main", "gateway", "run", "--replace"]);
const print = (state: string, pid: number | null, runs: number) => "gui/501/ai.openclaw.gateway = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/ai.openclaw.gateway.plist\n\ttype = LaunchAgent\n\tstate = " + state
  + "\n\n\tprogram = /opt/homebrew/opt/node/bin/node\n\targuments = {\n\t\t/opt/homebrew/opt/node/bin/node\n\t\tgateway\n\t}\n\n\tenvironment = {\n\t\tOPENCLAW_GATEWAY_TOKEN => secret-value\n\t}\n\n\truns = " + runs
  + (pid === null ? "" : "\n\tpid = " + pid) + "\n\tlast exit code = (never exited)\n\n\tresource coalition = {\n\t\ttype = resource\n\t\tstate = active\n\t}\n}\n";
const plan: NativeInstallPlan = { harnessId: "openclaw", controlId: "openclaw-native", channel: "npm", manager: "/opt/homebrew/bin/npm", reference: "openclaw", prefix: "/opt/homebrew",
  entry: "/opt/homebrew/bin/openclaw", actualEntry: "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs", beforeVersion: "2026.3.23-2", fingerprint: "0".repeat(64), reason: null };
const recipe: ManagementRecipe = { harnessId: "openclaw", controlId: "openclaw-native", kind: "npm", packageName: "openclaw", referenceVersion: "latest", binName: "openclaw", args: ["acp"], archiveUrl: null, archiveSha256: null,
  relativeExecutable: null, dependencies: [], processNames: ["openclaw-gateway", "openclaw-node"],
  services: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", restart: true, portFlag: "--port" }, { label: "ai.openclaw.node", name: "OpenClaw Node", restart: false, restartCommand: "openclaw node restart" }] };
const SELF = 7000;
const PROCESSES = [
  "    1     0 /sbin/launchd", " 4039     1 openclaw-gateway    ", " 4736     1 openclaw-node       ", " 4058     1 /Users/me/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace",
  " 7000  6000 node dist/src/cli/web.js --port 4317", " 7100  7000 /opt/homebrew/opt/node/bin/node /opt/homebrew/bin/openclaw acp", " 7101  7100 /opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/worker.js",
  " 8100  8000 /opt/homebrew/opt/node/bin/node /opt/homebrew/bin/openclaw tui", " 8200     1 openclaw-gateway", " 8300  8000 /usr/bin/vim /opt/homebrew/bin/openclaw-notes.txt"].join("\n") + "\n";
const context = (signal = new AbortController().signal): ManagementInstallContext => ({ stage: "/tmp/stage", signal, assertOwned: () => {}, log: () => assert.fail("host outputs are never logged") });
function host(overrides: Partial<ProgramHost> = {}): ProgramHost & { readonly kicked: string[] } {
  const kicked: string[] = [];
  return { platform: "darwin", uid: 501, self: SELF, kicked,
    processes: async () => PROCESSES, jobs: async () => JOBS,
    job: async label => ({ "ai.openclaw.gateway": GATEWAY, "ai.openclaw.node": NODE, "ai.hermes.gateway": HERMES } as Record<string, string>)[label] ?? null,
    print: async target => target.startsWith("gui/501/") ? print("running", 4039, 1) : null,
    kickstart: async target => { kicked.push(target); }, listening: async () => "", openers: async () => "", sleep: async () => {}, now: () => 0, ...overrides };
}

test("G011-UP1 the macOS outputs are parsed field by field, and the environment block of a job is never read", () => {
  assert.deepEqual(parseJobs(JOBS), [{ pid: 4039, label: "ai.openclaw.gateway" }, { pid: 4736, label: "ai.openclaw.node" }, { pid: 4058, label: "ai.hermes.gateway" }, { pid: 312, label: "com.apple.Finder" }]);
  assert.deepEqual(parseJob(GATEWAY), { pid: 4039, program: "/opt/homebrew/opt/node/bin/node", args: ["/opt/homebrew/opt/node/bin/node", "/opt/homebrew/lib/node_modules/openclaw/dist/index.js", "gateway", "--port", "18789"] });
  assert.deepEqual(parseJob("{\n\t\"Label\" = \"x\";\n};\n"), { pid: null, program: null, args: [] });
  // Only top-level fields count: the nested `state = active` of a resource coalition is not the job's state.
  assert.deepEqual(parseServiceState(print("running", 9001, 2)), { state: "running", pid: 9001, runs: 2 });
  assert.deepEqual(parseServiceState(print("not running", null, 3)), { state: "not running", pid: null, runs: 3 });
  assert.deepEqual(parseListening("p4039\nf15\nn127.0.0.1:18789\nf16\nn[::1]:18789\nf17\nn127.0.0.1:18791\n"), [18789, 18789, 18791]);
  assert.equal(portArgument(["gateway", "--port", "18789"], "--port"), 18789); assert.equal(portArgument(["--port=4000"], "--port"), 4000);
  assert.equal(portArgument(["--port", "x"], "--port"), null); assert.equal(portArgument(["gateway"], "--port"), null);
  assert.equal(programName("/opt/homebrew/opt/node/bin/node /opt/homebrew/bin/openclaw tui --secret prompt"), "openclaw");
  assert.equal(programName("openclaw-gateway    "), "openclaw-gateway"); assert.equal(programName("/bin/zsh -c 'echo hi'"), "zsh");
  assert.equal(parseProcessTable("not a table"), null);
  assert.deepEqual(installationRoots(plan), ["/opt/homebrew/bin/openclaw", "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs", "/opt/homebrew/lib/node_modules/openclaw"]);
});

test("G011-UP1 the programs of one installation are its launchd services, its resident and other programs, never HarnessHub's own", async () => {
  const usage = await inspectProgramUsage(plan, recipe, host(), context());
  assert.equal(usage.servicesKnown, true);
  // Both OpenClaw jobs run from the installation; the Hermes job does not, and Apple's jobs are not read.
  assert.deepEqual(usage.services.map(service => [service.label, service.pid, service.target, service.port, service.program, service.declared?.restart]), [
    ["ai.openclaw.gateway", 4039, "gui/501/ai.openclaw.gateway", 18789, "/opt/homebrew/opt/node/bin/node", true], ["ai.openclaw.node", 4736, "gui/501/ai.openclaw.node", null, "/opt/homebrew/opt/node/bin/node", false]]);
  // A gateway started by hand (its title hides its path) is resident; a terminal session is another program; this
  // process's own children (a conversation's `openclaw acp`) are left out, and so is an unrelated path that only shares a prefix.
  assert.deepEqual(usage.resident, [{ pid: 8200, name: "openclaw-gateway" }]);
  assert.deepEqual(usage.processes, [{ pid: 8100, name: "openclaw" }]);
  // Elsewhere the service manager is not read: the same programs are plain resident programs.
  const linux = await inspectProgramUsage(plan, recipe, host({ platform: "linux", jobs: async () => assert.fail("launchd is macOS only") }), context());
  assert.equal(linux.servicesKnown, false); assert.deepEqual(linux.services, []);
  assert.deepEqual(linux.resident.map(program => program.pid), [4039, 4736, 8200]);
  await assert.rejects(inspectProgramUsage(plan, recipe, host({ processes: async () => "garbage" }), context()), (error: unknown) => error instanceof ManagementError && error.code === "PROCESS_INSPECTION_FAILED");
});

const gateway: UsedService = { label: "ai.openclaw.gateway", pid: 4039, target: "gui/501/ai.openclaw.gateway", port: 18789, program: "/opt/homebrew/opt/node/bin/node", declared: recipe.services![0]! };
/** A clock that sleeping advances, and launchd states that follow it: the old process until `restartAt`, then `states`. */
function timeline(states: (time: number) => string | null, listening: (time: number) => string = () => "") {
  let time = 0, kicked = 0;
  const h = host({ now: () => time, sleep: async milliseconds => { time += milliseconds; }, kickstart: async () => { kicked++; },
    print: async () => kicked === 0 ? print("running", 4039, 1) : states(time), listening: async () => listening(time) });
  return { host: h, kicked: () => kicked, time: () => time };
}
const timing = { pollMs: 500, stableMs: 5000, deadlineMs: 60000 };

test("G011-UP1 a restarted service counts as running again only under a new, stable process that listened on its port", async () => {
  const healthy = timeline(time => print("running", time < 1000 ? null : 9001, 2), time => time >= 3000 ? "p9001\nf20\nn127.0.0.1:18789\n" : "");
  assert.deepEqual(await restartProgramService(gateway, healthy.host, context(), timing), { pid: 9001, ready: true });
  assert.equal(healthy.kicked(), 1); assert.ok(healthy.time() >= 6000 && healthy.time() < 7000, String(healthy.time()));
  // Without a known port it is running, its availability unverified.
  assert.deepEqual(await restartProgramService({ ...gateway, port: null }, timeline(() => print("running", 9001, 2)).host, context(), timing), { pid: 9001, ready: null });
  // Running and stable but never listening in the window: not ready, said by the caller.
  assert.deepEqual(await restartProgramService(gateway, timeline(() => print("running", 9001, 2)).host, context(), timing), { pid: 9001, ready: false });
  // The old process, a crash loop (launched more than once since the restart) and a stopped job never count.
  for (const states of [() => print("running", 4039, 1), (time: number) => print("running", 9000 + Math.floor(time / 2000), 2 + Math.floor(time / 2000)), () => print("not running", null, 2), () => null]) {
    await assert.rejects(restartProgramService(gateway, timeline(states).host, context(), timing), (error: unknown) => error instanceof ManagementError && error.code === "SERVICE_NOT_RECOVERED");
  }
  // A service that stopped since the user agreed is not started; a refused restart is said as such.
  assert.equal(await restartProgramService(gateway, host({ print: async () => print("not running", null, 1), kickstart: async () => assert.fail("a stopped service is not started") }), context(), timing), null);
  await assert.rejects(restartProgramService(gateway, host({ kickstart: async () => { throw new ManagementError("PROCESS_FAILED", "exit 5"); } }), context(), timing),
    (error: unknown) => error instanceof ManagementError && error.code === "SERVICE_RESTART_FAILED");
  // Cancellation stops the wait.
  const controller = new AbortController();
  await assert.rejects(restartProgramService(gateway, host({ print: async target => { controller.abort(); return print("running", 4039, 1) + target.slice(0, 0); },
    sleep: async (_ms, signal) => { if (signal.aborted) throw new ManagementError("CANCELLED", "cancelled"); } }), context(controller.signal), timing), (error: unknown) => error instanceof ManagementError && error.code === "CANCELLED");
});
test("G011-UN7 a native program started by name, whose command line names no path, is found by the executable it has open", async () => {
  const opened: (readonly string[])[] = [];
  const table = PROCESSES + " 9100  9000 claude --resume\n 9200  9000 claude\n";
  const usage = await inspectRootsUsage(["/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code"], ["/bin/sh"], () => null,
    host({ processes: async () => table, jobs: async () => "", openers: async files => { opened.push(files); return "p9100\nf1\np" + SELF + "\np9200\n"; } }), context());
  assert.deepEqual(opened, [["/bin/sh"]], "only existing program files are asked about");
  assert.deepEqual(usage.processes, [{ pid: 9100, name: "claude" }, { pid: 9200, name: "claude" }], "this process is HarnessHub's own and left out");
  assert.deepEqual(parseOpeners("p1\nfcwd\np22\n"), [1, 22]);
  // A program file that is not there is not asked about.
  const missing = await inspectRootsUsage(["/nowhere"], ["/nowhere/claude.exe"], () => null, host({ jobs: async () => "", openers: async () => assert.fail("not asked") }), context());
  assert.deepEqual(missing.processes, []);
});
