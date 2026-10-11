// A Gateway owner that keeps one native process for a conversation and then waits to be killed, so that a later owner can
// be tested on what it finds (ADR-030). Arguments: build root, data root, lease root, workspace, ACP peer script, and "1"
// to record the kept process group's identity. FIXTURE_LINGER, FIXTURE_PID and FIXTURE_CHILD_PID reach the peer.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [build, data, locks, workspace, peer, identify] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(build, path)).href);
const { SessionRuntime } = await load("src/contexts/session/application/runtime.js");
const { SqliteSessionStore } = await load("src/infrastructure/session/sqlite-store.js");
const { SqliteWorkspaceLeaseProvider } = await load("src/infrastructure/session/workspace-lease.js");
const { AcpControl } = await load("src/adapters/control/acp.js");
const { PosixProcessGroups } = await load("src/infrastructure/control/process-group.js");

const leases = new SqliteWorkspaceLeaseProvider(locks);
const passed = Object.fromEntries(["FIXTURE_LINGER", "FIXTURE_PID", "FIXTURE_CHILD_PID"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
const factory = {
  validate: async () => ({ harnessId: "alpha", controlId: "alpha-acp" }),
  prepare: async (_selected, configuration, session, run) => {
    const lease = leases.acquire(configuration.workspace, session, run);
    const env = { LANG: "C.UTF-8", FIXTURE_RESUME_MODELS: "1", ...passed };
    const control = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", "hermes"], env },
      { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: 5000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 });
    let close = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); } })();
      return close;
    } };
  },
};
const store = new SqliteSessionStore(data);
let id = 0;
const app = new SessionRuntime(store, factory, { id: () => "owner-" + (++id), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
  ...(identify === "1" ? { processes: new PosixProcessGroups() } : {}) });
const configuration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
const session = await app.create(configuration, { harnessId: "alpha" }, "create");
app.setRetention(session.id, true, "keep");
app.send(session.id, "turn", "first"); await app.wait(session.id);
process.stdout.write(JSON.stringify({ session: session.id, retained: app.read(session.id).retained ?? null }) + "\n");
setInterval(() => {}, 1000);
