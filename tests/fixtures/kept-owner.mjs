// A Gateway owner that keeps one native process for a conversation (ADR-030), with mode "ask" leaves one approval waiting
// (ADR-035), or with mode "queue" also a Turn queued behind it for a slot (an operator's limit of one conversation at once, ADR-036), and then waits to be killed, so that a later
// owner can be tested on what it finds. Arguments: build
// root, data root, lease root, workspace, ACP peer script, "1" to record the kept process group's identity, and the mode.
// FIXTURE_LINGER, FIXTURE_PID, FIXTURE_CHILD_PID, FIXTURE_OUTSIDER and FIXTURE_HOLD reach the peer.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [build, data, locks, workspace, peer, identify, mode = "keep"] = process.argv.slice(2);
const load = path => import(pathToFileURL(join(build, path)).href);
const { SessionRuntime } = await load("src/contexts/session/application/runtime.js");
const { SqliteConversationStore } = await load("src/infrastructure/session/conversation-store.js");
const { recoverConversation } = await load("src/contexts/session/domain/conversation-state.js");
const { recoverConversationRelay } = await load("src/contexts/session/domain/relay/recover.js");
const { SqliteWorkspaceLeaseProvider } = await load("src/infrastructure/session/workspace-lease.js");
const { AcpControl } = await load("src/adapters/control/acp.js");
const { PosixProcessGroups } = await load("src/infrastructure/control/process-group.js");

const leases = new SqliteWorkspaceLeaseProvider(locks);
const passed = Object.fromEntries(["FIXTURE_LINGER", "FIXTURE_PID", "FIXTURE_CHILD_PID", "FIXTURE_OUTSIDER", "FIXTURE_HOLD"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
const factory = {
  validate: async () => ({ harnessId: "alpha", controlId: "alpha-acp" }),
  prepare: async (_selected, configuration, session, run) => {
    const lease = leases.acquire(configuration.workspace, session, run);
    const env = { LANG: "C.UTF-8", FIXTURE_RESUME_MODELS: "1", FIXTURE_SESSION_ID: "session-fixture-" + session, ...passed };
    const control = new AcpControl({ protocol: "acp-v1", executable: process.execPath, args: [peer, "acp-v1", "hermes"], env },
      { cwd: configuration.workspace, env, requestTimeoutMs: 2000, runTimeoutMs: 5000, maxFrameBytes: 2 * 1024 * 1024, maxDiagnosticBytes: 4096, closeGraceMs: 120 });
    let close = null;
    return { control, workspace: configuration.workspace, assertOwned: () => lease.assertOwned(), close: () => {
      close ??= (async () => { let evidence = null; try { evidence = await control.close(); return evidence; } finally { lease.release(evidence?.closed === true); } })();
      return close;
    } };
  },
};
const store = new SqliteConversationStore(data, { recover: recoverConversation, recoverRelay: recoverConversationRelay });
let id = 0;
const app = new SessionRuntime(store, factory, { id: () => "owner-" + (++id), now: () => new Date(), publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"),
  ...(identify === "1" ? { processes: new PosixProcessGroups() } : {}), ...(mode === "queue" ? { maxParallel: 1 } : {}) });
const configuration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
const session = await app.create(configuration, { harnessId: "alpha" }, "create");
if (mode === "queue") {
  // One conversation waits for an approval; another queues behind it for the only slot there is.
  const other = await app.create(configuration, { harnessId: "alpha" }, "create-queued");
  app.send(session.id, "approve this", "first");
  for (let i = 0; i < 200 && app.attention().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  app.send(other.id, "turn", "queued");
  for (let i = 0; i < 200 && app.slotWait(other.id) === null; i++) await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.write(JSON.stringify({ session: session.id, queued: other.id, queue: app.slotWait(other.id) }) + "\n");
} else if (mode === "ask") {
  app.send(session.id, "approve this", "first");
  for (let i = 0; i < 200 && app.attention().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.write(JSON.stringify({ session: session.id, attention: app.attention() }) + "\n");
} else {
  app.setRetention(session.id, true, "keep");
  app.send(session.id, "turn", "first"); await app.wait(session.id);
  process.stdout.write(JSON.stringify({ session: session.id, retained: store.get(session.id).retained ?? null }) + "\n");
}
setInterval(() => {}, 1000);
