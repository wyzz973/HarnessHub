import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { nativeConversationId, singleText, type BackendResult, type CleanupEvidence, type ControlEvent, type HarnessControl } from "../../src/contracts/control.js";
import { SessionError, type HarnessSelection, type PreparedSessionBinding, type SelectionRequest, type SessionBindingFactory, type SessionConfiguration, type SessionId, type SessionRuntimeOptions } from "../../src/contracts/session.js";
import { SessionRuntime } from "../../src/contexts/session/application/runtime.js";
import { LocalContentStore } from "../../src/infrastructure/session/content-store.js";
import type { SqliteConversationStore, SqliteConversationStoreOptions } from "../../src/infrastructure/session/conversation-store.js";
import { appStore } from "./runtime-store.js";
import { temporary } from "./store-helpers.js";

/*
 * A conversation made by the Runtime on a real store and a real content store, with a Harness that does what a test scripts: for each input the events it makes, in order, and then the
 * words of its reply when the script gives none. Only the Harness is made up. The Runtime and the store are closed before the directory they stand in is removed.
 */
export const STAMP = new Date("2026-11-13T00:00:00.000Z");

/** What a Harness does with an input: the events it makes (and, when they are all there is, the words of a reply after them); with `hold`, the Turn does not end until the promise does. */
export type Script = (turn: number, text: string) => readonly ControlEvent[] | { readonly events: readonly ControlEvent[]; readonly reply: false; readonly hold?: Promise<void> };
class ScriptedHarness implements SessionBindingFactory {
  private turns = 0;
  constructor(private readonly script: Script) {}
  async validate(request: SelectionRequest): Promise<HarnessSelection> {
    if (request.harnessId !== "alpha" && request.harnessId !== "bravo") throw new SessionError("HARNESS_UNAVAILABLE", "fixture target is unavailable");
    return { harnessId: request.harnessId, controlId: request.harnessId + "-acp" };
  }
  async prepare(selected: HarnessSelection, configuration: SessionConfiguration, session: SessionId): Promise<PreparedSessionBinding> {
    let opened = false;
    // A native session has one holder: each conversation has its own.
    const native = "native-" + selected.harnessId + "-" + session;
    const control: HarnessControl = {
      initialize: async () => ({ protocol: "acp-v1", protocolVersion: 1, agentName: "fake", agentVersion: "1", authenticationMethods: [], capabilities: {} }),
      open: async () => { opened = true; return nativeConversationId(native); },
      checkpoint: async () => opened ? "private-" + native : null,
      healthy: () => true,
      enablePermissions: () => {},
      decidePermission: async () => {},
      startText: async (_id, turn, output) => {
        const text = singleText(turn), made = this.script(++this.turns, text), events = Array.isArray(made) ? made : (made as { events: readonly ControlEvent[] }).events;
        for (const event of events) output(event);
        if (Array.isArray(made)) output({ type: "text", text: "reply to: " + text });
        const hold = Array.isArray(made) ? undefined : (made as { hold?: Promise<void> }).hold;
        const done = (): BackendResult => ({ status: "completed", reason: "fake", input: "recorded" });
        return { result: hold === undefined ? Promise.resolve<BackendResult>(done()) : hold.then(done), requestStop: async () => ({ requested: true }) };
      },
      close: async () => ({ closed: true, exitCode: 0, signal: null, protocolFailure: null } satisfies CleanupEvidence),
    };
    return { control, workspace: configuration.workspace, assertOwned: () => {}, close: () => control.close() };
  }
}
export interface ScriptedWorld {
  readonly configuration: SessionConfiguration;
  readonly root: string;
  readonly data: string;
  readonly store: SqliteConversationStore;
  readonly content: LocalContentStore;
  readonly app: SessionRuntime;
  readonly id: SessionId;
  /** Sends an input and waits for its Turn to end. */
  send(text: string): Promise<void>;
}
export async function scriptedWorld(t: TestContext, script: Script, options: {
  readonly wrap?: (store: SqliteConversationStore) => SqliteConversationStore; readonly runtime?: Partial<SessionRuntimeOptions>;
  /** Runs on the data directory before the store opens it: a test that wants a data root as an earlier build, or a broken disk, left it makes it here. */
  readonly before?: (data: string) => void;
  /** More of what the store is opened with. */
  readonly store?: SqliteConversationStoreOptions;
} = {}): Promise<ScriptedWorld> {
  const open: { app?: SessionRuntime; store?: SqliteConversationStore } = {};
  t.after(async () => { await open.app?.close(); open.store?.close(); });
  const root = temporary(t), workspace = join(root, "workspace"), data = join(root, "data");
  mkdirSync(workspace);
  options.before?.(data);
  const store = appStore(data, { now: () => STAMP, ...options.store }), content = new LocalContentStore(data, () => store.assertOwner());
  open.store = store;
  let next = 0;
  const app = new SessionRuntime(options.wrap === undefined ? store : options.wrap(store), new ScriptedHarness(script), { id: () => String(++next), now: () => STAMP, publish: () => {}, fingerprint: value => createHash("sha256").update(value).digest("hex"), content, ...options.runtime });
  open.app = app;
  const configuration: SessionConfiguration = { workspace, manifestPath: null, manifestSha256: null, configHome: null, packageRoots: [], searchDirs: [], pathOnly: true };
  const session = await app.create(configuration, { harnessId: "alpha" }, "create");
  return { configuration, root, data, store, content, app, id: session.id, async send(text) { app.send(session.id, text, "send-" + ++next); await app.wait(session.id); } };
}
