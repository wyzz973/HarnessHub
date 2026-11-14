import type { ControlLaunch, ControlOptions } from "../../../contracts/control.js";
import { ControlError, JsonRpcProcess, RequestRefused, object, string, type RpcRequest } from "../../../infrastructure/control/json-rpc-process.js";
import { record, userAgentVersion, type Row } from "./mapping.js";
import { refusalOf } from "./requests.js";
import { checkSchema, type CodexSchemaCheck } from "./schema.js";

/** A failure of the Hub's own consumer of events: it ends the connection, as it always did; nothing Codex sends does. */
export class ConsumerFailure extends Error { constructor(readonly original: unknown) { super("event consumer failed"); } }

/** What the host hands its owner: messages about the threads it owns (and their sub-agent threads), and everything else it cannot place. */
export interface HostEvents {
  /** A notification about an owned thread (`root`) or one of its descendants (`thread`). */
  thread(root: string, thread: string, method: string, params: Row): void;
  /** A thread Codex announced (`thread/started`) that is not known to be anyone's yet: the owner may be opening it. */
  announced(thread: Row): void;
  /** A notification that names no thread (account, configuration, MCP start-up). */
  global(method: string, params: Row): void;
  /** A server request about an owned thread or one of its descendants. */
  request(root: string, thread: string, request: RpcRequest, params: Row): Promise<unknown> | unknown;
  /** A message the host could not read; said once to whoever runs, never a failure. */
  fault(method: string): void;
  failure(error: Error): void;
}
export interface Handshake { readonly userAgent: string; readonly version: string | null; readonly check: CodexSchemaCheck }

/**
 * One `codex app-server --listen stdio://` process and the threads on it (research of 2026-11-14 §8.2): it routes every notification and server
 * request by `threadId` to the thread's owner, or to the owned thread a sub-agent thread descends from. A thread nobody owns (another client's,
 * an internal worker's) or one given up is counted and dropped; its requests are refused. Nothing Codex sends ends the connection: a message
 * the host cannot read is a diagnostic. One host serves one Hub conversation today; owning several threads is what a pool will need.
 */
export class CodexHost {
  readonly rpc: JsonRpcProcess;
  private readonly owned = new Set<string>();
  private readonly parents = new Map<string, string>();
  private readonly released = new Set<string>();
  private readonly closing = new Map<string, (() => void)[]>();
  private counted = 0;
  constructor(readonly launch: ControlLaunch, readonly options: ControlOptions, private readonly events: HostEvents) {
    this.rpc = new JsonRpcProcess(launch, options, { notification: (method, params) => this.notification(method, params), request: request => this.serverRequest(request), failure: error => events.failure(error) });
  }
  /** Updates Codex sent that belong to no Turn of this connection: other threads', given-up threads', and its own between Turns. */
  get unattributed(): number { return this.counted; }
  count(): void { this.counted++; }
  own(thread: string): void { this.owned.add(thread); this.released.delete(thread); }
  /** Gives a thread up: what Codex still says of it is counted and dropped, and nobody approves for it. */
  release(thread: string): void { this.owned.delete(thread); this.released.add(thread); }
  isReleased(thread: string): boolean { return this.released.has(thread); }
  /** A sub-agent thread spawned by `parent`: its own thread/started says so (and wins), a parent's item says so only of a thread not placed yet (`keep`). */
  adopt(child: string, parent: string, keep = false): void { if (child !== parent && !this.owned.has(child) && !(keep && this.parents.has(child))) this.parents.set(child, parent); }
  parentOf(thread: string): string | null { return this.parents.get(thread) ?? null; }
  /** The owned thread `thread` is or descends from; null for anyone else's. */
  rootOf(thread: string): string | null {
    let current: string | undefined = thread;
    for (let depth = 0; current !== undefined && depth < 32; depth++) { if (this.owned.has(current)) return current; current = this.parents.get(current); }
    return null;
  }
  /** Resolves once Codex says the thread closed (`thread/closed`), or false after `ms`. */
  waitClosed(thread: string, ms: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { done(false); }, ms), list = this.closing.get(thread) ?? [];
      const done = (closed: boolean) => { clearTimeout(timer); const rest = (this.closing.get(thread) ?? []).filter(item => item !== wake); if (rest.length) this.closing.set(thread, rest); else this.closing.delete(thread); resolve(closed); };
      const wake = () => done(true);
      list.push(wake); this.closing.set(thread, list);
    });
  }
  /**
   * The handshake: the experimental API declared always (plan mode, its deltas and the newer fields need it), `turn/diff/updated` opted out of (the Hub
   * keeps its own checkpoints), then the version from the user agent and, for a version not seen in this process, the drift check of its schema.
   */
  async initialize(timeoutMs: number): Promise<Handshake> {
    const response = object(await this.rpc.request("initialize", {
      clientInfo: { name: "harnessgateway", title: "HarnessGateway", version: "0.0.0" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"], requestAttestation: false },
    }, timeoutMs, "abort", "NATIVE_INITIALIZE_TIMEOUT"), "Codex initialize result");
    const userAgent = string(response.userAgent, "Codex user agent", 4096), version = userAgentVersion(userAgent);
    await this.rpc.notify("initialized", {});
    return { userAgent, version, check: await checkSchema(this.launch, this.options.env, version) };
  }
  private notification(method: string, raw: unknown): void {
    try {
      const params = raw === undefined || raw === null ? {} : object(raw, "Codex notification params");
      if (method === "thread/started") {
        const thread = record(params.thread);
        if (thread === null || typeof thread.id !== "string") { this.events.fault(method); return; }
        if (typeof thread.parentThreadId === "string" && thread.parentThreadId) this.adopt(thread.id, thread.parentThreadId);
        if (this.released.has(thread.id)) { this.counted++; return; }
        const root = this.rootOf(thread.id);
        if (root === null) { this.events.announced(thread); if (this.rootOf(thread.id) === null) this.counted++; return; }
        this.events.thread(root, thread.id, method, params); return;
      }
      const thread = typeof params.threadId === "string" ? params.threadId : typeof params.conversationId === "string" ? params.conversationId : undefined;
      if (method === "thread/closed" && thread !== undefined) for (const wake of this.closing.get(thread) ?? []) wake();
      if (thread === undefined) { this.events.global(method, params); return; }
      if (this.released.has(thread)) { this.counted++; return; }
      const root = this.rootOf(thread);
      if (root === null) { this.counted++; return; }
      this.events.thread(root, thread, method, params);
    } catch (error) {
      if (error instanceof ConsumerFailure) throw error.original;
      this.events.fault(method);
    }
  }
  private serverRequest(request: RpcRequest): unknown {
    const params = record(request.params) ?? {}, thread = typeof params.threadId === "string" ? params.threadId : typeof params.conversationId === "string" ? params.conversationId : undefined;
    const root = thread === undefined ? null : this.rootOf(thread);
    if (thread !== undefined && root !== null && !this.released.has(thread)) {
      return Promise.resolve().then(() => this.events.request(root, thread, request, params)).catch((error: unknown) => {
        if (error instanceof ConsumerFailure) throw error.original;
        if (error instanceof RequestRefused || error instanceof ControlError && error.code === "METHOD_NOT_FOUND") throw error;
        // A request the owner could not read is refused, never left unanswered and never a failure of the connection.
        this.events.fault(request.method);
        return this.refusal(request.method);
      });
    }
    if (thread !== undefined) this.counted++;
    return this.refusal(request.method);
  }
  /** The answer to a request nobody here decides: a refusal of the kind the method takes; the few that ask for something the Hub does not hold are refused with an error. */
  private refusal(method: string): unknown {
    if (method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (method === "account/chatgptAuthTokens/refresh") throw new RequestRefused("HarnessHub does not hold ChatGPT tokens; Codex keeps its own sign-in");
    if (method === "attestation/generate") throw new RequestRefused("HarnessHub gives no client attestation");
    const answer = refusalOf(method);
    if (answer === undefined) throw new ControlError("METHOD_NOT_FOUND", "client capability is not implemented");
    return answer;
  }
}
