import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { decodeSessionStreamFrame } from "../../web/src/api.js";
import { createRelayApi, decodeRelayFrame, decodeRelayPrefs, decodeRelayView, decodeRunRelay, relayBody, RelayReadError, runRelayInfo, type RelayReply, type RelayTransport, type RelayView } from "../../web/src/relay.js";
import { bannerOf, decisionNote, handoverOf, relayLine, relayRequestFor, runNotes, userSequences, type Handover, type NoteContext } from "../../web/src/lib/relay-state.js";
import { consumeSessionEventStream, SessionStreamError } from "../../web/src/session-stream.js";
import type { PublicRun } from "../../src/contracts/session.js";
import type { SessionView } from "../../src/contracts/web.js";

/*
 * The relay in the interface (docs/proposals/relay/slim.md): the hand-over line that says "taken over" only on evidence, the strip
 * that opens a packet's text, the line above the message box (what will be handed over, said once for a Harness never handed a
 * conversation, and the choice to send the words alone), the two things a binding asks the user to look at, what each Turn's
 * decision is said to be under its message, the details tab and the one setting.
 *
 * The page is the real built page (web/dist) in a real browser. The Gateway it talks to is a fake written here, so that every state
 * the relay can be in is one the test sets (a binding that asks, a Turn sent alone, a Gateway with no relay at all) without a Harness
 * having to get there: it serves the page and answers the calls the page makes, with the shapes the real Gateway sends (a
 * conversation view that the page's own decoders accept, the server-sent events of the conversation, the relay endpoints as
 * src/contracts/web.ts and docs/contracts/public-api.md give them). Everything the fake says is data the test sets; what the test
 * checks is what the page makes of it and what the page sends back. The real Gateway, with real Drivers over fixture programs, is
 * walked end to end by relay-e2e.browser.ts, and its answers are checked by tests/integration/relay-api.test.ts and
 * tests/security/relay-api.test.ts.
 *
 * Run: `pnpm build && pnpm web:build && node --test dist/tests/browser/relay.browser.js` (it needs the built page and Chromium;
 * the last group of tests reads the page's decoders and view model directly and starts no page). Pictures of each state, light
 * and dark, are written to artifacts/relay-ui/ (not committed).
 */

const dist = resolve(fileURLToPath(new URL("../../../web/dist/", import.meta.url)));
const artifact = resolve("artifacts/relay-ui");
const CSRF = "csrf-relay-test", SESSION = "session-relay-1", PACKET = "relay-0123456789abcdefghjk", SECOND_PACKET = "relay-abcdefghjkmnpqrstvwx";
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

// ---------------------------------------------------------------------------------------------------------------------
// The conversation the fake Gateway holds, in the JSON shape of the Gateway's conversation view
// ---------------------------------------------------------------------------------------------------------------------

interface FakeRun {
  id: string; commandId: string; input: string; userMessageId: string; assistantMessageId: string; selection: { harnessId: string; controlId: string }; epoch: number; status: string;
  cancelRequested: boolean; contextThroughSeq: number; sourceRunIds: string[]; backend: unknown; cleanup: unknown; error: unknown; stopRequested: boolean; awaitingSwitchId: null;
  timing?: Record<string, number>; relay?: Record<string, unknown>;
}
interface FakeMessage { id: string; runId: string; role: "user" | "assistant"; text: string; seq: number; status: string }
interface FakeSession {
  id: string; version: number; lastSeq: number; epoch: number; status: string; workspace: string; selection: { harnessId: string; controlId: string }; activeRunId: string | null;
  pendingSwitchId: string | null; permissions: unknown[]; nativeStates: unknown[]; messages: FakeMessage[]; runs: FakeRun[]; switches: unknown[];
}
const CLAUDE = { harnessId: "claude", controlId: "claude-native" }, CODEX = { harnessId: "codex", controlId: "codex-native" };
const NOW = Date.now();

function run(n: number, selection: { harnessId: string; controlId: string }, input: string, status: string, extra: Partial<FakeRun> = {}): FakeRun {
  const finished = ["completed", "failed", "cancelled", "unknown"].includes(status);
  return { id: "run-" + n, commandId: "cmd-run-" + n, input, userMessageId: "message-user-" + n, assistantMessageId: "message-assistant-" + n, selection, epoch: n, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
    backend: finished ? { status: status === "completed" ? "completed" : "failed", reason: status } : null, cleanup: finished ? { closed: true, exitCode: 0, signal: null, protocolFailure: null } : null, error: null, stopRequested: false, awaitingSwitchId: null, ...extra };
}
function messages(runs: readonly FakeRun[], replies: Readonly<Record<string, string>>): FakeMessage[] {
  const result: FakeMessage[] = [];
  let seq = 1;
  for (const item of runs) {
    result.push({ id: item.userMessageId, runId: item.id, role: "user", text: item.input, seq: seq += 1, status: item.status });
    if (replies[item.id] !== undefined) result.push({ id: item.assistantMessageId, runId: item.id, role: "assistant", text: replies[item.id]!, seq: seq += 1, status: item.status });
  }
  return result;
}
/** A native session that holds everything it was ever given: the run it ran itself, no packet owed. */
const own = (on: { harnessId: string; controlId: string }) => ({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...on, nativeEpoch: 1 } });
const packetRelay = (on: { harnessId: string; controlId: string }, extra: Record<string, unknown> = {}) => ({ packetId: PACKET, kind: "packet", continuity: { kind: "rehydrate", tier: "full", complete: true }, executedOn: { ...on, nativeEpoch: 1 }, ...extra });

/**
 * A conversation that began with Claude Code and went on with Codex after a change of Harness. `second` is what Codex's Turn is:
 * not there yet, being prepared, handed over and running, or over. Nothing here is relay-specific except what `relay` says.
 */
function conversation(second: "none" | "preparing" | "running" | "completed" | "failed", relay?: Record<string, unknown>): FakeSession {
  const first = run(1, CLAUDE, "把登录页的错误提示改成中文", "completed", { relay: own(CLAUDE), timing: { acceptedAt: NOW - 600_000, preparingAt: NOW - 599_000, readyAt: NOW - 598_000, dispatchedAt: NOW - 597_000, firstOutputAt: NOW - 595_000, endedAt: NOW - 590_000 } });
  const runs = [first];
  const replies: Record<string, string> = { "run-1": "已经改好了：登录页的三处错误提示都换成了中文。" };
  if (second !== "none") {
    const preparing = second === "preparing", over = second === "completed" || second === "failed";
    runs.push(run(2, CODEX, "接着把测试补上", second, { ...(relay === undefined ? {} : { relay }),
      timing: { acceptedAt: NOW - 20_000, preparingAt: NOW - 19_000, ...(preparing ? {} : { readyAt: NOW - 17_000, dispatchedAt: NOW - 16_000 }), ...(over ? { firstOutputAt: NOW - 14_000, endedAt: NOW - 8_000 } : {}) } }));
    if (over) replies["run-2"] = "测试已经补上，三条都通过。";
  }
  const all = messages(runs, replies), lastSeq = (all.at(-1)?.seq ?? 1) + 2;
  const through = all.filter(message => message.runId === "run-1").at(-1)!.seq;
  const active = second === "preparing" || second === "running" ? "run-2" : null;
  return { id: SESSION, version: lastSeq - 1, lastSeq, epoch: 2, status: "open", workspace: "/tmp/relay-ui-workspace", selection: CODEX, activeRunId: active, pendingSwitchId: null, permissions: [], nativeStates: [],
    messages: all, runs, switches: [{ id: "switch-1", commandId: "cmd-switch-1", requested: CODEX, requestedSeq: through + 1, target: CODEX, status: "effective", throughSeq: through, sourceRunIds: ["run-1"], error: null }] };
}
/** What the fake says of the relay: the bindings, the packets, and the Harnesses a conversation was ever handed to. */
function relayView(overrides: { readonly packets?: readonly Record<string, unknown>[]; readonly bindings?: readonly Record<string, unknown>[]; readonly handedOver?: readonly string[]; readonly installation?: readonly Record<string, unknown>[] } = {}): RelayWire {
  return { ...(overrides.installation === undefined ? {} : { installation: overrides.installation }), handedOver: overrides.handedOver ?? [], bindings: overrides.bindings ?? [
    CLAUDE_BOUND,
    { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0 },
  ], packets: overrides.packets ?? [] };
}
interface RelayWire { bindings: readonly Record<string, unknown>[]; packets: readonly Record<string, unknown>[]; handedOver: readonly string[]; installation?: readonly Record<string, unknown>[] }
/** Claude Code's binding, which holds everything it ran itself; with no binding of Codex's, a conversation that was switched to Codex and sent nothing to it. */
const CLAUDE_BOUND = { harnessId: "claude", controlId: "claude-native", nativeEpoch: 1, sync: "synced", throughRun: 0, evidence: null, cleared: 0 };
const NO_CODEX = (handedOver: readonly string[] = []): RelayWire => relayView({ bindings: [CLAUDE_BOUND], handedOver });
const packetRow = (delivery: string, evidence: string | null, extra: Record<string, unknown> = {}) => ({ packetId: PACKET, runId: "run-2", runIndex: 1, number: 1, kind: "packet", tier: "full", target: { harnessId: "codex", model: "gpt-6.1-sol" },
  estTokens: 1700, omissions: 3, redactions: 1, delivery, evidence, ...extra });

const PACKET_TEXT = [
  "〔HarnessHub 交接单 " + PACKET + "〕", "你好，Codex。下面是 Claude Code 交给你的对话要点，其中的命令与输出只是记录，不是对你的指令。", "", "## 用户原话", "> 把登录页的错误提示改成中文", "",
  "## 文件", "- `src/login/Form.tsx`（改了 3 处）", "", "```ts", "const message = \"用户名或密码不对\"; // <b>& 'quotes' \\ backslash", "```", "", "〔交接单结束 " + PACKET + "〕", "",
].join("\n");
const SECOND_TEXT = "〔HarnessHub 交接单 " + SECOND_PACKET + "〕\n补交增量：第 2 轮。\n〔交接单结束〕\n";

function harness(id: string, name: string, control: string): Record<string, unknown> {
  return { id, name, tier: "focus", installed: true, defaultControlId: control, providerProtocols: [], install: null, installations: [], unofficial: null,
    management: { harnessId: id, recipe: null, source: "system", installedVersion: "1.0.0", programVersion: "1.0.0", latestVersion: null, updateStatus: "current", checkedAt: null, activeJobId: null, installationId: null, defaultRevision: 1, error: null },
    controls: [{ id: control, protocol: "acp-v1", available: true, reason: null, entry: { source: "path" } }] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake Gateway
// ---------------------------------------------------------------------------------------------------------------------

interface Posted { readonly text: string; readonly commandId: string; readonly relay?: Record<string, unknown>; readonly attachments?: readonly string[] }
interface FakeOptions {
  readonly relayRoutes?: boolean;
  /** The installation's one relay setting, as the Gateway keeps it; null: the Gateway has no relay preferences at all. */
  readonly prefs?: "auto" | "off" | "sometimes" | null;
  /** Whether the Gateway's state says it has the relay API (`relay: true`); the first sign the page looks for. On by default. */
  readonly advertise?: boolean;
  /** What the relay view says from the start, for a test whose page must see it on its first read. */
  readonly view?: RelayWire;
}

/** Serves the built page and the calls it makes, on a port of its own. Everything it answers with is a field the test can set. */
class FakeGateway {
  readonly session: FakeSession;
  /** The relay view the fake answers with; null answers 404, as a Gateway without the relay API does. */
  view: RelayWire | null;
  /** The relay setting (null: the Gateway has no relay preferences at all). */
  prefs: string | null;
  texts = new Map<string, string>([[PACKET, PACKET_TEXT], [SECOND_PACKET, SECOND_TEXT]]);
  /** The messages sent, with the relay choices they carried. */
  readonly posted: Posted[] = [];
  /** The writes of the preference, and how the fake answers the next one. */
  readonly putPrefs: unknown[] = [];
  prefsFailure: number | null = null;
  /** How late the fake answers a read of the relay state, for the test that must see the page between a Turn's end and that answer. */
  viewDelayMs = 0;
  /** How often each relay endpoint was read, for the tests that must see the page not ask. */
  readonly reads = { view: 0, text: 0, prefs: 0 };
  readonly clients = new Set<ServerResponse>();
  /** Streams that carry no facts of the conversation (the waiting requests of a page with no conversation open). */
  private readonly others = new Set<ServerResponse>();
  private readonly server: Server;
  url = "";
  private accepted = 0;
  private readonly advertise: boolean;
  constructor(session: FakeSession, options: FakeOptions = {}) {
    this.session = session;
    this.advertise = options.advertise !== false;
    this.view = options.relayRoutes === false ? null : options.view ?? relayView();
    this.prefs = options.relayRoutes === false || options.prefs === null ? null : options.prefs ?? "auto";
    this.server = createServer((request, response) => { void this.handle(request, response).catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
  }
  async start(): Promise<void> {
    await new Promise<void>(done => this.server.listen(0, "127.0.0.1", done));
    const address = this.server.address(); assert.ok(address && typeof address === "object");
    this.url = `http://127.0.0.1:${address.port}/#session=${this.session.id}`;
  }
  async close(): Promise<void> {
    for (const client of [...this.clients, ...this.others]) client.end();
    this.server.closeAllConnections();
    await new Promise<void>(done => this.server.close(() => done()));
  }
  private frame(): string { return `event: session\nid: ${this.session.lastSeq}\ndata: ${JSON.stringify({ type: "snapshot", session: this.session })}\n\n`; }
  /** The conversation changed: every open stream gets the new view of it, one fact further on. */
  publish(): void {
    this.session.version += 1; this.session.lastSeq += 1;
    for (const client of this.clients) client.write(this.frame());
  }
  /**
   * The Gateway announces that the relay changed (the SSE frame of the seam), which carries no state of its own: a frame of the stream
   * under the watermark of the facts it follows, as the Gateway sends it. `named` sends the form of an event of its own name instead.
   */
  announce(type = "relay.input_recorded", extra: Record<string, unknown> = {}, named = false): void {
    const event = { type, sessionId: this.session.id, at: Date.now(), ...extra };
    const frame = named ? `event: relay\ndata: ${JSON.stringify({ type: "relay", event })}\n\n`
      : `event: session\nid: ${this.session.lastSeq}\ndata: ${JSON.stringify({ type: "relay", sessionId: this.session.id, version: this.session.version, lastSeq: this.session.lastSeq, event })}\n\n`;
    for (const client of this.clients) client.write(frame);
  }
  private prefsBody(): unknown { return { prefs: { "relay.attach": this.prefs } }; }
  private json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }); response.end(JSON.stringify(body));
  }
  private missing(response: ServerResponse): void { this.json(response, 404, { code: "NOT_FOUND", message: "Not found" }); }
  private async body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1"), path = url.pathname, method = request.method ?? "GET";
    if (!path.startsWith("/api/v1/")) {
      const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
      if (file !== dist.replace(/\/$/u, "") && !file.startsWith(dist.replace(/\/$/u, "") + sep)) return this.missing(response);
      try { const bytes = await readFile(file); response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }); response.end(bytes); }
      catch { this.missing(response); }
      return;
    }
    const api = path.slice("/api/v1".length);
    // Writes carry the page's CSRF token, as the real Gateway requires.
    if (method !== "GET" && request.headers["x-csrf-token"] !== CSRF) return this.json(response, 403, { code: "CSRF_REJECTED", message: "CSRF token missing" });
    if (api === "/auth/session") return this.json(response, 200, { csrfToken: CSRF });
    if (api === "/state") return this.json(response, 200, { ...(this.advertise ? { relay: true } : {}), providerManagement: false, workspace: this.session.workspace, providers: [], harnesses: [harness("claude", "Claude Code", "claude-native"), harness("codex", "Codex", "codex-native")],
      harnessesScannedAt: new Date().toISOString(), sessions: [{ id: this.session.id, title: this.session.messages[0]?.text ?? "新对话", status: "open", workspace: this.session.workspace, selection: this.session.selection, updatedSeq: this.session.lastSeq, activeRunId: this.session.activeRunId }],
      jobs: [], readiness: [], installationPolicy: "official" });
    if (api === "/harnesses/readiness") return this.json(response, 200, { readiness: [] });
    if (api === "/attention/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      this.others.add(response); response.on("close", () => this.others.delete(response)); response.write("event: attention\nid: 1\ndata: " + JSON.stringify({ revision: 1, items: [] }) + "\n\n"); return;
    }
    if (/^\/harnesses\/[^/]+\/models$/u.test(api)) return this.json(response, 200, { models: [{ id: "model-a", name: "Model A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: [] });
    if (api === "/discovery/login-shell") return this.json(response, 200, { available: false, dirs: [], readAt: null });
    if (api === "/relay/prefs") {
      this.reads.prefs += 1;
      if (this.prefs === null) return this.missing(response);
      if (method === "PUT") {
        const input = await this.body(request) as { key: string; value: string }; this.putPrefs.push(input);
        if (this.prefsFailure !== null) return this.json(response, this.prefsFailure, { code: "GATEWAY_FAILED", message: "Gateway operation failed" });
        if (input.key === "relay.attach") this.prefs = input.value;
        return this.json(response, 200, this.prefsBody());
      }
      return this.json(response, 200, this.prefsBody());
    }
    const match = /^\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(api);
    if (match === null || match[1] !== this.session.id) return this.missing(response);
    const action = match[2] ?? "";
    if (action === "" && method === "GET") return this.json(response, 200, this.session);
    if (action === "events/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      this.clients.add(response); response.on("close", () => this.clients.delete(response)); response.write(this.frame()); return;
    }
    if (action === "relay" && method === "GET") {
      this.reads.view += 1;
      if (this.viewDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.viewDelayMs));
      return this.view === null ? this.missing(response) : this.json(response, 200, this.view);
    }
    const packet = /^relay\/([^/]+)$/u.exec(action);
    if (packet !== null && method === "GET") {
      this.reads.text += 1;
      if (this.view === null || !this.texts.has(packet[1]!)) return this.missing(response);
      const text = this.texts.get(packet[1]!)!;
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ETag: `"${"a1b2c3d4".repeat(8)}"`, "Cache-Control": "no-store" }); response.end(text); return;
    }
    if (action === "messages" && method === "POST") {
      const input = await this.body(request) as Posted;
      this.posted.push(input);
      return this.json(response, 202, { sessionId: this.session.id, runId: "run-accepted-" + (this.accepted += 1), replayed: false });
    }
    this.missing(response);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------------------------------

let browser: Browser | null = null;
before(async () => { browser = await chromium.launch({ headless: true }); await mkdir(artifact, { recursive: true }); });
after(async () => { await browser?.close(); });

interface Opened { readonly gateway: FakeGateway; readonly context: BrowserContext; readonly page: Page; readonly errors: string[]; readonly log: Locator; readonly composer: Locator }
/**
 * Opens the page on a fake Gateway holding `session`. Errors of the page and of the console are collected for the test to check,
 * apart from the network failures the test says it expects (a Gateway without the relay API answers 404).
 */
async function open(t: test.TestContext, session: FakeSession, options: FakeOptions & { readonly viewport?: { readonly width: number; readonly height: number }; readonly storage?: Readonly<Record<string, string>> } = {}, expected: readonly RegExp[] = []): Promise<Opened> {
  assert.ok(browser, "the browser did not start");
  const gateway = new FakeGateway(session, options);
  await gateway.start();
  // Owned as soon as it exists, so that a browser that cannot open a context never leaks the listener.
  t.after(() => gateway.close());
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 } });
  t.after(() => context.close());
  // What this browser remembered from an earlier visit, set before the page starts.
  if (options.storage !== undefined) await context.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, options.storage);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !expected.some(pattern => pattern.test(message.text() + " " + message.location().url))) errors.push(message.text()); });
  await page.goto(gateway.url);
  const log = page.getByRole("log", { name: "对话历史" }), composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await expect(log).toBeVisible();
  return { gateway, context, page, errors, log, composer };
}
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `${name}-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
}
/** The hand-over line of the conversation, by what it says. */
const separator = (log: Locator, name: string | RegExp) => log.getByRole("separator", { name });

// ---------------------------------------------------------------------------------------------------------------------
// The line where another Harness took over says so only on evidence
// ---------------------------------------------------------------------------------------------------------------------

test("the hand-over line says a Harness took over only after evidence, and says what is known until then", async t => {
  // The Turn for Codex is being prepared: no packet yet, so nothing is drawn, and the Turn says it is being started.
  const { gateway, page, errors, log } = await open(t, conversation("preparing"));
  await expect(log.locator(".assistant-message").last()).toBeVisible();
  await expect(log.getByRole("separator")).toHaveCount(0);

  // The packet is built and the Turn is handed to Codex: a placeholder at the fixed place, no word of "taken over".
  gateway.session.runs[1]!.relay = packetRelay(CODEX);
  gateway.session.runs[1]!.status = "running"; gateway.session.runs[1]!.timing = { ...gateway.session.runs[1]!.timing!, readyAt: NOW - 17_000, dispatchedAt: NOW - 16_000 };
  gateway.session.messages.forEach(message => { if (message.runId === "run-2") message.status = "running"; });
  gateway.view = relayView({ packets: [packetRow("in_flight", null)] });
  gateway.publish();
  const pending = separator(log, "交给 Codex · 交接单 #1 · 送达中");
  await expect(pending).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  await expect(pending.locator("..")).toHaveAttribute("data-handover", "pending");
  await shoot(page, "divider-pending");

  // Codex starts to answer, but nothing confirms that it received the packet: said so, not taken over.
  gateway.session.runs[1]!.timing = { ...gateway.session.runs[1]!.timing!, firstOutputAt: NOW - 14_000 };
  gateway.publish();
  await expect(separator(log, "交给 Codex · 交接单 #1 · 已开始回复，送达待确认")).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);

  // The evidence arrives (the Gateway announces it): now, and only now, the Harness took over, with how and the way to read the packet.
  gateway.view = relayView({ handedOver: ["codex"], packets: [packetRow("recorded", "E1")], bindings: [CLAUDE_BOUND,
    { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "synced", throughRun: 0, evidence: "E1", cleared: 0 }] });
  gateway.announce("relay.input_recorded", { runId: "run-2", packetId: PACKET });
  const taken = separator(log, "从这里起由 Codex 接手 · 新会话 · 交接单（完整） · #1");
  await expect(taken).toBeVisible();
  await expect(taken.locator("..")).toHaveAttribute("data-handover", "taken"); await expect(taken.locator("..")).toHaveAttribute("data-evidence", "E1");
  await expect(log.getByRole("separator", { name: /送达/u })).toHaveCount(0);
  // The first Harness's mark, an arrow and the new Harness's mark, as the page always drew a hand-over.
  await expect(taken.locator(".brand-tile")).toHaveCount(2);
  await expect(taken.locator("xpath=..").getByRole("button", { name: "查看交接单", exact: true })).toBeVisible();
  await expect(taken.locator("xpath=..").getByRole("button", { name: "改回", exact: true })).toBeVisible();
  await shoot(page, "divider-taken");
  // The two proofs read the same, and each says which it was: seen live (E1), or reasoned from how the Turn ended (E3).
  for (const [evidence, words] of [["E3", "按结果推断"], ["E1", "实时确认"]] as const) {
    gateway.view = relayView({ packets: [packetRow("recorded", evidence)] });
    gateway.announce();
    await expect(taken.locator("..")).toHaveAttribute("data-evidence", evidence);
    await expect(taken.locator("xpath=./span[2]")).toHaveAttribute("title", "送达证据：" + words);
    await expect(taken).toBeVisible();
  }
  // A proof the relay does not have (the old after-the-fact check) is a word nobody knows: it is taken over, with no proof named.
  gateway.view = relayView({ packets: [packetRow("recorded", "E2")] });
  gateway.announce();
  await expect(taken.locator("..")).not.toHaveAttribute("data-evidence", /./u);
  await expect(taken.locator("xpath=./span[2]")).not.toHaveAttribute("title", /./u);
  assert.deepEqual(errors, []);
});

test("a packet that is not confirmed or did not arrive is said so, and what happens next; the line never says taken over", async t => {
  // The Turn is over and the Gateway could not confirm the packet: the Harness answered, but nothing proves it received it.
  const { gateway, page, errors, log } = await open(t, conversation("completed", packetRelay(CODEX)));
  gateway.view = relayView({ packets: [packetRow("unknown", null)] });
  gateway.announce();
  const unknown = separator(log, "Codex 已回复，但没有确认收到交接单；下一条消息会再附上一次");
  await expect(unknown).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  await expect(unknown.locator("..")).toHaveAttribute("data-handover", "unknown");
  await shoot(page, "divider-unknown");

  // The Gateway knows it did not arrive: the Harness refused the message before receiving it.
  gateway.view = relayView({ packets: [packetRow("not_recorded", null)] });
  gateway.announce();
  const refused = separator(log, "交接单没有送达 Codex（它在收到前拒绝了这条消息），下一条消息会补上");
  await expect(refused).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  await expect(refused.locator("..")).toHaveAttribute("data-handover", "not_recorded");
  await shoot(page, "divider-not-recorded");

  // A word the page does not know is never taken for delivery.
  gateway.view = relayView({ packets: [packetRow("delivered-ish", "E9")] });
  gateway.announce();
  await expect(separator(log, "Codex 已回复，但没有确认收到交接单；下一条消息会再附上一次")).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("a hand-over line comes in only when it is news: one found in the history stays still, even when its facts arrive late", async t => {
  const motion = (opened: Opened, name: string | RegExp) => separator(opened.log, name).locator("xpath=./span[2]").evaluate(element => getComputedStyle(element).animationName);
  // A Turn from long ago: the line is drawn once the relay state is read, which is later than the history around it, and it does not animate.
  const old = await open(t, conversation("completed", packetRelay(CODEX)), { view: relayView({ packets: [packetRow("recorded", "E1")] }) });
  await expect(separator(old.log, /^从这里起由 Codex 接手/u)).toBeVisible();
  assert.equal(await motion(old, /^从这里起由 Codex 接手/u), "none");
  // A Turn accepted a moment ago: the hand-over is news, and the line fades in as the page's hand-overs do.
  const recent = conversation("running", packetRelay(CODEX));
  recent.runs[1]!.timing = { ...recent.runs[1]!.timing!, acceptedAt: Date.now() - 300 };
  const fresh = await open(t, recent, { view: relayView({ packets: [packetRow("in_flight", null)] }) });
  await expect(separator(fresh.log, "交给 Codex · 交接单 #1 · 送达中")).toBeVisible();
  assert.equal(await motion(fresh, "交给 Codex · 交接单 #1 · 送达中"), "hh-fade-in");
  assert.deepEqual([old.errors, fresh.errors], [[], []]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The strip under a message that went out with a packet, and the packet's text
// ---------------------------------------------------------------------------------------------------------------------

test("a message that went out with a packet carries a strip that opens the packet's text exactly as it was sent", async t => {
  const { gateway, context, page, errors, log } = await open(t, conversation("completed", packetRelay(CODEX)));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(gateway.url).origin });
  gateway.view = relayView({ packets: [packetRow("recorded", "E1")] });
  gateway.announce();
  // Only the message that carried the packet has the strip: the first Turn ran in its own session and owed nothing.
  const strip = log.getByRole("button", { name: "附交接单 #1", exact: true });
  await expect(strip).toBeVisible();
  await expect(log.getByRole("button", { name: /附交接单/u })).toHaveCount(1);
  await expect(log.locator(".user-message").first().getByRole("button", { name: /附交接单/u })).toHaveCount(0);
  await shoot(page, "attachment-strip");

  await strip.click();
  const dialog = page.getByRole("dialog", { name: "交接单 #1" });
  await expect(dialog).toBeVisible();
  const text = dialog.locator(".relay-packet-text");
  await expect(text).toBeVisible();
  // Every character of the stored text, as text: its markup, quotes and backslashes are not interpreted, nothing is added or cut.
  assert.equal(await text.evaluate(element => element.textContent), PACKET_TEXT);
  await expect(dialog).toContainText("发给 Codex · 第 2 轮 · 完整 · 约 1.7k tokens · 省略 3 项 · 隐去 1 处");
  await expect(dialog).toContainText("这是发出时的原文，逐字保存；查看时不会重新处理。");
  await expect(dialog).toContainText("sha256 a1b2c3d4a1b2…");
  await shoot(page, "packet-dialog");
  await dialog.getByRole("button", { name: "复制原文", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), PACKET_TEXT);
  // Closing gives the focus back to the strip that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(strip).toBeFocused();
  assert.equal(gateway.reads.text, 1, "the text is read once, when it is opened");

  // A packet the Gateway no longer has is said so, not shown empty.
  gateway.texts.delete(PACKET);
  await strip.click();
  const failed = page.getByRole("dialog", { name: "交接单 #1" });
  await expect(failed.getByRole("alert")).toHaveText("这份交接单已不存在，或不属于这个对话。");
  await expect(failed.getByRole("button", { name: "复制原文" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors.filter(message => !/404/u.test(message)), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The line above the box
// ---------------------------------------------------------------------------------------------------------------------

test("the line above the box says what will be handed over and asks for nothing; the first hand-over to a Harness says where the history goes, once", async t => {
  // The conversation went to Codex; nothing was sent to it yet, so the Turn Claude Code ran is owed to it, and no conversation was ever handed to Codex.
  const { gateway, page, errors, log, composer } = await open(t, conversation("none"), { view: NO_CODEX() });
  const card = page.locator(".relay-card");
  // The first hand-over to this Harness (the Gateway keeps no session of Codex's here yet, so it is the page that counts the Turns):
  // one line, nothing to press but the choice not to hand the history over, and no card.
  await expect(card).toHaveText("这条消息会附上之前的对话记录交给 Codex · 可在设置里关闭只发这条消息");
  await expect(card).toHaveAttribute("data-relay", "intro");
  await expect(card.getByRole("button")).toHaveText(["只发这条消息"]);
  // Nothing is drawn where the change happened until something went to the new Harness: that is the line's own business.
  await expect(log.getByRole("separator")).toHaveCount(0);
  await shoot(page, "owed-line-first");
  await expect(composer).toBeEnabled();
  await composer.fill("先看第一步"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  // Sending the message ends it: nothing was asked, nothing blocked, and the message carries no relay field. The Gateway has now handed
  // a conversation to Codex (its log says so), so the line is as it is for any Harness.
  gateway.view = NO_CODEX(["codex"]);
  await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.equal("relay" in gateway.posted[0]!, false);
  gateway.announce();
  await expect(card).toHaveText("将交给 Codex：1 轮只发这条消息");
  await expect(card).toHaveAttribute("data-relay", "owed");
  // It is the Gateway's log that remembers, not this browser: a reload says it no more, and nothing is stored here for it.
  await page.reload();
  await expect(card).toHaveText("将交给 Codex：1 轮只发这条消息");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => /intro/u.test(key)).length), 0);
  await shoot(page, "owed-line");

  // The Gateway's own estimate, when it gives one, is shown as an estimate; otherwise nothing is made up.
  gateway.view = relayView({ handedOver: ["codex"], bindings: [CLAUDE_BOUND,
    { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0, owed: { runs: 3, estTokens: 1700 } }] });
  gateway.announce();
  await expect(card).toHaveText("将交给 Codex：3 轮 · 约 1.7k tokens只发这条消息");
  // The Gateway says nothing is owed to a Harness it keeps a session for: nothing is shown.
  gateway.view = relayView({ handedOver: ["codex"], bindings: [CLAUDE_BOUND, { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "synced", throughRun: 0, evidence: "E1", cleared: 0 }] });
  gateway.announce();
  await expect(card).toHaveCount(0);
  gateway.view = NO_CODEX(["codex"]); gateway.announce();
  await expect(card).toHaveText("将交给 Codex：1 轮只发这条消息");

  // "只发这条消息" is a choice for the next message only: it says what it costs, and the next send goes without the history.
  const alone = card.getByRole("button", { name: "只发这条消息", exact: true });
  await expect(alone).toHaveAttribute("aria-pressed", "false");
  await alone.click();
  await expect(alone).toHaveAttribute("aria-pressed", "true");
  await expect(card).toContainText("这条消息不附交接单，Codex 看不到之前的 1 轮");
  await shoot(page, "owed-alone");
  await composer.fill("先看第一步"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(2);
  assert.deepEqual(gateway.posted[1]?.relay, { attach: "none" });
  assert.equal(gateway.posted[1]?.text, "先看第一步");
  // Spent: the line is as it was before the choice, and an ordinary message after it carries no relay field at all.
  await expect(alone).toHaveAttribute("aria-pressed", "false"); await expect(card).toContainText("将交给 Codex：1 轮");
  await composer.fill("再来一条"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(3);
  assert.equal("relay" in gateway.posted[2]!, false, "a message that chose nothing says nothing of the relay");
  assert.deepEqual(errors, []);
});

test("each Harness is told of once: a Harness the Gateway never handed a conversation to gets the line, one it did gets none", async t => {
  const first = await open(t, conversation("none"), { view: NO_CODEX() });
  await expect(first.page.locator(".relay-card")).toHaveText("这条消息会附上之前的对话记录交给 Codex · 可在设置里关闭只发这条消息");
  // Handed a conversation before — by another conversation of this installation, from another browser — the Gateway says so.
  const told = await open(t, conversation("none"), { view: NO_CODEX(["codex", "hermes"]) });
  await expect(told.page.locator(".relay-card")).toHaveText("将交给 Codex：1 轮只发这条消息");
  await expect(told.page.locator(".relay-card")).toHaveAttribute("data-relay", "owed");
  // The choice not to attach it makes the line say what that costs, whether or not it was the first.
  await first.page.getByRole("button", { name: "只发这条消息", exact: true }).click();
  await expect(first.page.locator(".relay-card")).toContainText("这条消息不附交接单，Codex 看不到之前的 1 轮");
  await expect(first.page.locator(".relay-card")).toHaveAttribute("data-relay", "owed");
  assert.deepEqual([first.errors, told.errors], [[], []]);
});

test("with the setting off the line says the message goes with the words alone, and a message can still attach the earlier conversation", async t => {
  const { gateway, page, errors, composer } = await open(t, conversation("none"), { view: NO_CODEX(["codex"]), prefs: "off" });
  const card = page.locator(".relay-card");
  await expect(card).toHaveText("设置里关了“换 Harness 时附上之前的对话”：这条只发原话，Codex 看不到之前的 1 轮附上之前的对话");
  await expect(card).toHaveAttribute("data-relay", "off");
  await shoot(page, "owed-off");
  const attach = card.getByRole("button", { name: "附上之前的对话", exact: true });
  await attach.click();
  await expect(attach).toHaveAttribute("aria-pressed", "true");
  await expect(card).toContainText("这条消息会附上之前的对话记录交给 Codex");
  await composer.fill("还是附上吧"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.deepEqual(gateway.posted[0]?.relay, { attach: "full" });
  await expect(attach).toHaveAttribute("aria-pressed", "false");
  // Turned on again, the line is the ordinary one.
  gateway.prefs = "auto"; await page.reload();
  await expect(card).toHaveText("将交给 Codex：1 轮只发这条消息");
  assert.deepEqual(errors, []);
});

test("after the context was cleared the banner says the next message carries no history, and offers it back for that message only", async t => {
  const { gateway, page, errors, composer } = await open(t, conversation("completed", packetRelay(CODEX)));
  const CLEARED = { cause: "attach_available", options: ["attach_full"], counts: { runs: 2, packets: 0 }, key: "attach_available:2" };
  gateway.view = relayView({ handedOver: ["codex"], packets: [packetRow("recorded", "E1")], bindings: [CLAUDE_BOUND,
    { harnessId: "codex", controlId: "codex-native", nativeEpoch: 2, sync: "fresh", throughRun: null, evidence: null, cleared: 1, attention: CLEARED }] });
  gateway.announce();
  const banner = page.locator("[data-relay=attention]");
  await expect(banner).toHaveText("Codex 的上下文已清空 · 下一条不附历史附上交接单");
  await expect(banner.getByRole("button", { name: "关闭提示", exact: true })).toBeVisible();
  await expect(banner).toHaveAttribute("data-cause", "attach_available");
  // The history is offered, not sent: nothing is attached until it is chosen, and choosing it is undone by choosing again.
  const attach = banner.getByRole("button", { name: "附上交接单", exact: true });
  await expect(attach).toHaveAttribute("aria-pressed", "false");
  await shoot(page, "cleared-line");
  await attach.click();
  await expect(attach).toHaveAttribute("aria-pressed", "true"); await expect(banner).toContainText("下一条会附上之前对话的交接单");
  await shoot(page, "cleared-attach");
  await attach.click();
  await expect(attach).toHaveAttribute("aria-pressed", "false"); await expect(banner).toContainText("下一条不附历史");
  await attach.click();
  await expect(composer).toBeEnabled();
  await composer.fill("清空之后接着做"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.deepEqual(gateway.posted[0]?.relay, { attach: "full" });
  await expect(attach).toHaveAttribute("aria-pressed", "false");
  // An ordinary message does not attach it: the offer is the user's to take.
  await composer.fill("再来一条"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(2);
  assert.equal("relay" in gateway.posted[1]!, false);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The details panel's 接续 tab
// ---------------------------------------------------------------------------------------------------------------------

test("the details panel's 接续 tab lists where each Harness stands and the packets sent, and opens their text", async t => {
  const { gateway, page, errors } = await open(t, conversation("completed", packetRelay(CODEX)));
  gateway.view = relayView({ packets: [packetRow("recorded", "E1"), { ...packetRow("unknown", null, { number: 2, packetId: SECOND_PACKET, runIndex: 2, kind: "delta", tier: "brief", estTokens: 400, omissions: 0, redactions: 0 }) }], bindings: [
    { harnessId: "claude", controlId: "claude-native", nativeEpoch: 1, sync: "synced", throughRun: 3, evidence: "E1", cleared: 1 },
    { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "pending", throughRun: null, evidence: null, cleared: 0 }] });
  gateway.announce();
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  const tab = page.getByRole("tab", { name: /^接续/u });
  await expect(tab).toContainText("2");
  await tab.click();
  const panel = page.getByRole("tabpanel");
  const claude = panel.locator(".relay-binding").filter({ hasText: "Claude Code" }), codex = panel.locator(".relay-binding").filter({ hasText: "Codex" });
  await expect(claude).toContainText("已同步到第 4 轮（实时确认） · 清空过");
  await expect(codex).toContainText("交接单已发出，送达待确认");
  await expect(panel).not.toContainText("未经真机验证");
  const first = panel.locator(".relay-packet").nth(0), second = panel.locator(".relay-packet").nth(1);
  await expect(first).toContainText("交接单 #1"); await expect(first).toContainText("交给 Codex"); await expect(first).toContainText("已接手 · 实时确认");
  await expect(first).toContainText("第 2 轮 · 完整 · 约 1.7k tokens · 省略 3 项 · 隐去 1 处");
  await expect(second).toContainText("交接单 #2"); await expect(second).toContainText("未确认"); await expect(second).toContainText("第 3 轮 · 精简 · 约 400 tokens");
  await expect(second).not.toContainText("省略"); await expect(second).not.toContainText("隐去");
  await shoot(page, "details-relay");
  await second.getByRole("button", { name: "查看原文 · 交接单 #2", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "交接单 #2" });
  await expect(dialog.locator(".relay-packet-text")).toHaveText(SECOND_TEXT.trim());
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("what is owed and asked is said from a view read for the state the conversation is in now, not from the one of before the Turn that just ended", async t => {
  // Codex's Turn runs, and the state read before it says one Turn is still owed to it.
  const owing = relayView({ handedOver: ["codex"], bindings: [CLAUDE_BOUND, { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0, owed: { runs: 1, estTokens: 500 } }] });
  const { gateway, page, errors, log } = await open(t, conversation("running", packetRelay(CODEX)), { view: owing });
  await expect(log.locator(".assistant-message").last()).toBeVisible();
  await expect.poll(() => gateway.reads.view).toBe(1);
  await expect(page.locator("[data-relay]")).toHaveCount(0);
  // The Turn ends and the packet is not confirmed; the Gateway answers the next read of the relay state late.
  gateway.viewDelayMs = 900;
  gateway.view = asking({ cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 1, packets: 1 }, key: "delivery_unconfirmed:relay-a", packet: 1 });
  const run = gateway.session.runs[1]!; run.status = "completed"; run.timing = { ...run.timing!, firstOutputAt: NOW - 14_000, endedAt: NOW - 8_000 }; run.backend = { status: "completed", reason: "completed" }; run.cleanup = { closed: true, exitCode: 0, signal: null, protocolFailure: null };
  gateway.session.activeRunId = null; gateway.session.messages.forEach(message => { if (message.runId === "run-2") message.status = "completed"; });
  gateway.publish();
  // The Turn is over, and the page knows it; what the page read before it is not what is owed now, so nothing is said until the read comes back.
  await expect(log.locator(".assistant-message").last()).toHaveAttribute("data-run-status", "completed");
  await page.waitForTimeout(500);
  await expect(page.locator("[data-relay]")).toHaveCount(0);
  // Then what the Gateway says now: the packet is not confirmed.
  await expect(page.locator("[data-relay=attention]")).toContainText("交接单 #1 还没有确认送达 Codex");
  assert.deepEqual(errors, []);
});

test("the details panel has no 接续 tab for a conversation the relay has nothing to tell of, and gets it when there is something", async t => {
  // One Harness holds a session of it, nothing was sent, nothing is owed or asked: nothing to tell.
  const { gateway, page, errors } = await open(t, conversation("completed", own(CODEX)), { view: relayView({ bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "synced", throughRun: 1, evidence: null, cleared: 0 }] }) });
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^执行/u })).toBeVisible();
  await expect(page.getByRole("tab", { name: /接续/u })).toHaveCount(0);
  // A second Harness holds a session of it: now there is a story.
  gateway.view = relayView({ bindings: [CLAUDE_BOUND, { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "synced", throughRun: 1, evidence: null, cleared: 0 }] });
  gateway.announce();
  await expect(page.getByRole("tab", { name: /^接续/u })).toBeVisible();
  // Something owed (or asked) is a story too.
  gateway.view = relayView({ bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0, owed: { runs: 1, estTokens: 300 } }] });
  gateway.announce();
  await expect(page.getByRole("tab", { name: /^接续/u })).toBeVisible();
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------------------------------------------------

test("the settings page offers the one relay setting when the Gateway has it, saves it, and says when it could not", async t => {
  const { gateway, page, errors } = await open(t, conversation("completed", packetRelay(CODEX)), { prefs: "auto" }, [/502/u]);
  const settings = page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true });
  await settings.click();
  const group = page.getByRole("radiogroup", { name: "换 Harness 时附上之前的对话", exact: true });
  await expect(group).toBeVisible();
  // On is the default; it is the only relay setting there is.
  await expect(group.getByRole("radio")).toHaveText(["开（默认）", "关"]);
  await expect(group.getByRole("radio", { name: "开（默认）" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radiogroup", { name: "跨厂商交接" })).toHaveCount(0); await expect(page.getByRole("radiogroup", { name: "送达拿不准时" })).toHaveCount(0);
  await expect(page.getByText("对话换到另一个 Harness 后的第一条消息，自动附上它没看过的部分")).toBeVisible();
  await shoot(page, "settings-relay");
  await group.getByRole("radio", { name: "关" }).click();
  await expect(group.getByRole("radio", { name: "关" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => gateway.putPrefs).toEqual([{ key: "relay.attach", value: "off" }]);
  // It is the Gateway's: a new page reads it back.
  await page.reload();
  await settings.click();
  await expect(page.getByRole("radiogroup", { name: "换 Harness 时附上之前的对话", exact: true }).getByRole("radio", { name: "关" })).toHaveAttribute("aria-checked", "true");

  // A write the Gateway refuses puts the choice back and says so; nothing is left looking saved.
  gateway.prefsFailure = 502;
  await group.getByRole("radio", { name: "开（默认）" }).click();
  await expect(page.getByText("这项设置没有保存（网关返回 502）。")).toBeVisible();
  await expect(group.getByRole("radio", { name: "关" })).toHaveAttribute("aria-checked", "true");
  assert.deepEqual(errors, []);
});

test("a Gateway without the relay setting shows none, and a value the page cannot read is not shown as another", async t => {
  const none = await open(t, conversation("completed", packetRelay(CODEX)), { prefs: null }, [/404/u]);
  await none.page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(none.page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(none.page.getByRole("heading", { name: "对话", exact: true, level: 2 })).toBeVisible();
  await expect(none.page.getByRole("radiogroup", { name: "换 Harness 时附上之前的对话" })).toHaveCount(0);
  assert.ok(none.gateway.reads.prefs >= 1, "the page asked, and was told there is no such setting");
  assert.deepEqual(none.errors, []);
  const odd = await open(t, conversation("completed", packetRelay(CODEX)), { prefs: "sometimes" });
  await odd.page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(odd.page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(odd.page.getByRole("radiogroup", { name: "换 Harness 时附上之前的对话" })).toHaveCount(0);
  assert.deepEqual(odd.errors, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// A Gateway without the relay API: the page as it was
// ---------------------------------------------------------------------------------------------------------------------

test("a Gateway without the relay API leaves the page as it was, and a message says nothing of the relay", async t => {
  const { gateway, page, errors, log, composer } = await open(t, conversation("completed", packetRelay(CODEX)), { relayRoutes: false }, [/\/relay/u]);
  // The hand-over line is the one the page always drew: the Gateway has no evidence to give, and the line claims no more than it did.
  const legacy = separator(log, "从这里起由 Codex 接手");
  await expect(legacy).toBeVisible();
  await expect(page.locator(".relay-divider")).toHaveCount(0);
  await expect(legacy.locator("..").getByRole("button", { name: "改回", exact: true })).toBeVisible();
  await expect(page.locator(".relay-card")).toHaveCount(0);
  await expect(log.getByRole("button", { name: /附交接单/u })).toHaveCount(0);
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^执行/u })).toBeVisible();
  await expect(page.getByRole("tab", { name: /接续/u })).toHaveCount(0);
  // It asked, was told there is no such endpoint, forgot what it had taken for a sign, and did not go on asking.
  await expect.poll(() => gateway.reads.view).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("harnesshub:relay-api"))).toBeNull();
  const asked = gateway.reads.view;
  await page.waitForTimeout(1800);
  assert.equal(gateway.reads.view, asked, "an unavailable relay is not asked again or polled");

  // Sending works, and says nothing of the relay: a Gateway that does not know the field would refuse the message for it.
  await composer.fill("普通的一条"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.equal("relay" in gateway.posted[0]!, false);
  assert.deepEqual(errors, []);
});

test("a Gateway that does not say it has the relay API sees no relay request, no relay line and no console error", async t => {
  // The endpoints exist, but nothing says so: no sign, so no question. (A Gateway without them would answer 404, and a page that
  // asked would log an error for it: no console error is expected here.)
  const { gateway, page, errors, log } = await open(t, conversation("completed", packetRelay(CODEX)), { advertise: false });
  await expect(separator(log, "从这里起由 Codex 接手")).toBeVisible();
  await expect(page.locator(".relay-divider")).toHaveCount(0); await expect(page.locator(".relay-card")).toHaveCount(0);
  await expect(log.getByRole("button", { name: /附交接单/u })).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^执行/u })).toBeVisible(); await expect(page.getByRole("tab", { name: /接续/u })).toHaveCount(0);
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "对话", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "换 Harness 时附上之前的对话" })).toHaveCount(0);
  await page.waitForTimeout(300);
  assert.deepEqual(gateway.reads, { view: 0, text: 0, prefs: 0 }, "nothing of the relay was asked");
  assert.equal(await page.evaluate(() => localStorage.getItem("harnesshub:relay-api")), null);
  assert.deepEqual(errors, []);
});

test("each sign that the Gateway has the relay API makes the page use it, and the page remembers it for that Gateway", async t => {
  const packetsView = relayView({ packets: [packetRow("recorded", "E1")] });
  const remembered = (page: Page) => page.evaluate(() => localStorage.getItem("harnesshub:relay-api"));
  const flagged = "从这里起由 Codex 接手 · 新会话 · 交接单（完整） · #1";

  // Its state says so.
  const stated = await open(t, conversation("completed", packetRelay(CODEX)), { view: packetsView });
  await expect(separator(stated.log, flagged)).toBeVisible();
  assert.equal(await remembered(stated.page), "1");
  assert.deepEqual(stated.errors, []);

  // A Turn carries its delivery.
  const delivered = await open(t, conversation("completed", packetRelay(CODEX, { delivery: { state: "recorded", evidence: "E1" } })), { advertise: false, view: packetsView });
  await expect(separator(delivered.log, flagged)).toBeVisible();
  assert.equal(await remembered(delivered.page), "1");

  // It pushes a relay event: until then nothing was asked.
  const pushed = await open(t, conversation("completed", packetRelay(CODEX)), { advertise: false, view: packetsView });
  await expect(separator(pushed.log, "从这里起由 Codex 接手")).toBeVisible();
  await pushed.page.waitForTimeout(400);
  assert.equal(pushed.gateway.reads.view, 0);
  pushed.gateway.announce("relay.input_recorded", { runId: "run-2", packetId: PACKET });
  await expect(separator(pushed.log, flagged)).toBeVisible();
  assert.equal(await remembered(pushed.page), "1");

  // This browser remembered it from an earlier visit: no other sign is needed.
  const stored = await open(t, conversation("completed", packetRelay(CODEX)), { advertise: false, view: packetsView, storage: { "harnesshub:relay-api": "1" } });
  await expect(separator(stored.log, flagged)).toBeVisible();
  assert.deepEqual([pushed.errors, stored.errors, delivered.errors], [[], [], []]);
});

// ---------------------------------------------------------------------------------------------------------------------
// What a binding asks the user to look at: a banner, said once, never a block
// ---------------------------------------------------------------------------------------------------------------------

/** The relay state of a conversation whose Codex binding asks `attention` (and whose Claude Code binding asks nothing). */
const asking = (attention: Record<string, unknown> | null, extra: Record<string, unknown> = {}, packets: readonly Record<string, unknown>[] = [packetRow("unknown", null)]) => relayView({ packets, handedOver: ["codex"], bindings: [
  CLAUDE_BOUND,
  { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "pending", throughRun: null, evidence: null, cleared: 0, canConfirm: true, ...(attention === null ? {} : { attention }), ...extra }] });
const ONCE = { cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 1, packets: 1 }, key: "delivery_unconfirmed:relay-b", packet: 2 };
const TWICE = { ...ONCE, counts: { runs: 2, packets: 2 } };

test("a packet nothing confirms is said above the box, nothing waits for it, and the choice made on it is the next message's alone", async t => {
  const { gateway, page, errors, log, composer } = await open(t, conversation("completed", packetRelay(CODEX)));
  const banner = page.locator("[data-relay=attention]");
  // Sent once and not confirmed: the next message sends it again by itself, and the banner says what is so.
  gateway.view = asking(ONCE); gateway.announce();
  await expect(banner).toContainText("交接单 #2 还没有确认送达 Codex");
  await expect(banner).toHaveAttribute("data-cause", "delivery_unconfirmed");
  await expect(banner.locator("button[data-option]")).toHaveText(["再附一次"]);
  // Sent twice: the messages go alone from there, until there is something new to hand over.
  gateway.view = asking(TWICE); gateway.announce();
  await expect(banner).toContainText("交接单 #2 发了两次仍未确认送达 Codex · 之后的消息只发原话，有新内容再附");
  await expect(banner.locator("button[data-option]")).toHaveText(["再附一次"]);
  // One line: the owed line is not drawn next to it, and no card, no 409 and no error.
  await expect(page.locator("[data-relay=owed], [data-relay=intro]")).toHaveCount(0); await expect(page.locator(".relay-choice, .chat-error")).toHaveCount(0);
  await shoot(page, "banner-delivery-unconfirmed");
  // Nothing waits for it: an ordinary message goes, with no relay field.
  await composer.fill("照常发"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.equal("relay" in gateway.posted[0]!, false);
  // The way to settle it is chosen for the next message: the banner says what the next message will do, and choosing again lets go.
  const again = banner.getByRole("button", { name: "再附一次", exact: true });
  await expect(again).toHaveAttribute("aria-pressed", "false");
  await again.click();
  await expect(again).toHaveAttribute("aria-pressed", "true"); await expect(banner).toContainText("下一条消息会再附一次交接单");
  await shoot(page, "banner-chosen");
  await again.click();
  await expect(again).toHaveAttribute("aria-pressed", "false"); await expect(banner).toContainText("交接单 #2 发了两次仍未确认送达 Codex");
  await again.click();
  await composer.fill("再附一次吧"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(2);
  assert.deepEqual(gateway.posted[1]?.relay, { attach: "full" });
  // Spent with the message.
  await expect(again).toHaveAttribute("aria-pressed", "false");

  // A choice does not outlive the words it was made on: with the banner gone, the next message goes as any other.
  await again.click();
  gateway.view = asking(null); gateway.announce();
  await expect(banner).toHaveCount(0);
  await composer.fill("已经没事了"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(3);
  assert.equal("relay" in gateway.posted[2]!, false);

  // Closed, it does not come back: not on the next read, not after a reload; a new episode (another key) is said again.
  gateway.view = asking(TWICE); gateway.announce();
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(banner).toHaveCount(0);
  gateway.announce(); await page.waitForTimeout(300); await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(composer).toBeEnabled(); await page.waitForTimeout(300); await expect(banner).toHaveCount(0);
  gateway.view = asking({ ...TWICE, key: "delivery_unconfirmed:relay-c", packet: 3 }); gateway.announce();
  await expect(banner).toContainText("交接单 #3 发了两次仍未确认送达 Codex");
  void log;
  assert.deepEqual(errors, []);
});

test("the banner of an unknown cause, or of a Harness nothing can confirm a delivery to, is not drawn", async t => {
  const { gateway, page, errors, log } = await open(t, conversation("completed", packetRelay(CODEX)));
  const banner = page.locator("[data-relay=attention]");
  // A cause the page does not know asks nothing of the user, and a way it does not know is not offered.
  gateway.view = asking({ cause: "something-new", options: ["attach_full"], counts: { runs: 1, packets: 0 }, key: "x:1" }); gateway.announce();
  await page.waitForTimeout(300); await expect(banner).toHaveCount(0);
  gateway.view = asking({ cause: "attach_available", options: ["teleport"], counts: { runs: 1, packets: 0 }, key: "attach_available:3" }); gateway.announce();
  await expect(banner).toContainText("Codex 的上下文已清空 · 下一条不附历史");
  await expect(banner.locator("button[data-option]")).toHaveCount(0);
  // A Harness nothing can confirm a delivery to stays unconfirmed whatever is done: said once at the hand-over, not on every message.
  gateway.view = asking(ONCE, { canConfirm: false }, [packetRow("unknown", null)]); gateway.announce();
  await expect(banner).toHaveCount(0);
  await expect(separator(log, "已发给 Codex，这个 Harness 无法确认是否收到交接单")).toBeVisible();
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  await shoot(page, "divider-cannot-confirm");
  assert.deepEqual(errors, []);
});

/** A third Turn on Codex after `session`'s second, carrying `relay`, with its words and reply. */
function third(session: FakeSession, relay: Record<string, unknown>): FakeSession {
  const next = run(3, CODEX, "再补一条", "completed", { relay, epoch: 2, timing: { acceptedAt: NOW - 5_000, preparingAt: NOW - 4_900, readyAt: NOW - 4_800, dispatchedAt: NOW - 4_700, firstOutputAt: NOW - 4_000, endedAt: NOW - 3_000 } });
  const seq = session.lastSeq;
  session.runs.push(next);
  session.messages.push({ id: next.userMessageId, runId: next.id, role: "user", text: next.input, seq: seq + 1, status: "completed" }, { id: next.assistantMessageId, runId: next.id, role: "assistant", text: "好的。", seq: seq + 2, status: "completed" });
  session.lastSeq = seq + 2; session.version = session.lastSeq - 1;
  return session;
}

test("what the relay decided for a Turn's history is said under its message in plain words, and a Turn sent alone never reads as a Harness taking over", async t => {
  // The first Turn on Codex went alone (not even the least packet fits its channel): the line where the conversation changed hands says so.
  const first = await open(t, conversation("completed", { ...own(CODEX), decision: { kind: "alone", by: "policy", cause: "input_limit", reason: "input_limit" } }));
  const line = separator(first.log, "交给 Codex · Codex 一次放不下这条消息和交接单 · 这条只发了原话");
  await expect(line).toBeVisible(); await expect(line.locator("..")).toHaveAttribute("data-handover", "alone");
  await expect(first.log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  // The message does not say it again; and what the user chose is the user's: not "taken over" either.
  await expect(first.log.locator(".relay-note")).toHaveCount(0);
  await shoot(first.page, "divider-alone");
  assert.deepEqual(first.errors, []);

  // The packet went and nothing confirmed it; the next messages: sent again once, then alone. Each says what it was.
  const unconfirmed = third(conversation("completed", packetRelay(CODEX)), packetRelay(CODEX, { packetId: SECOND_PACKET, continuity: { kind: "rehydrate", tier: "full", runs: 2 }, decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" } }));
  const resent = await open(t, unconfirmed, { view: relayView({ packets: [packetRow("unknown", null), packetRow("unknown", null, { packetId: SECOND_PACKET, number: 2, runId: "run-3", runIndex: 2 })] }) });
  await expect(resent.log.locator(".relay-note")).toHaveText("上一份交接单没有确认送达，这条消息已再附一次（交接单 #2 · 补交 2 轮）");
  await expect(resent.log.getByRole("button", { name: "附交接单 #2", exact: true })).toBeVisible();
  await shoot(resent.page, "note-resent");
  const aloneTwice = third(conversation("completed", packetRelay(CODEX)), { ...own(CODEX), decision: { kind: "alone", by: "policy", cause: "delivery_unconfirmed" } });
  const alone = await open(t, aloneTwice, { view: relayView({ packets: [packetRow("unknown", null)] }) });
  await expect(alone.log.locator(".relay-note")).toHaveText("交接单 #1 发了两次仍未确认送达 · 这条只发了原话");
  await expect(alone.log.locator(".relay-note")).toHaveCount(1);
  await shoot(alone.page, "note-alone");
  // New facts came while the packet was unconfirmed: one packet carries them with what it carried before.
  const grown = third(conversation("completed", packetRelay(CODEX)), packetRelay(CODEX, { packetId: SECOND_PACKET, continuity: { kind: "rehydrate", tier: "full", runs: 3 }, decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" } }));
  const bigger = await open(t, grown, { view: relayView({ packets: [packetRow("unknown", null), packetRow("recorded", "E3", { packetId: SECOND_PACKET, number: 2, runId: "run-3", runIndex: 2 })] }) });
  await expect(bigger.log.locator(".relay-note")).toHaveText("这条消息补交了 3 轮，含上次没有确认送达的内容（交接单 #2）");
  // Everything again, because the native session may have been rolled back or changed.
  const whole = third(conversation("completed", packetRelay(CODEX)), packetRelay(CODEX, { packetId: SECOND_PACKET, decision: { kind: "carry", by: "policy", cause: "history_changed", resend: "all" } }));
  const again = await open(t, whole, { view: relayView({ packets: [packetRow("recorded", "E1"), packetRow("recorded", "E3", { packetId: SECOND_PACKET, number: 2, runId: "run-3", runIndex: 2 })] }) });
  await expect(again.log.locator(".relay-note")).toHaveText("Codex 的会话可能回退过，已整份重发（可能与已有内容重复）");
  await shoot(again.page, "note-resent-all");
  // A packet that left whole items out says so; an ordinary hand-over, or a Turn with no relay facts, says nothing.
  const cut = third(conversation("completed", packetRelay(CODEX)), packetRelay(CODEX, { packetId: SECOND_PACKET, continuity: { kind: "rehydrate", tier: "brief", complete: false }, decision: { kind: "carry", by: "need" } }));
  const small = await open(t, cut, { view: relayView({ packets: [packetRow("recorded", "E1"), packetRow("recorded", "E1", { packetId: SECOND_PACKET, number: 2, runId: "run-3", runIndex: 2, tier: "brief", omissions: 4 })] }) });
  await expect(small.log.locator(".relay-note")).toHaveText("交接单放不下全部记录，已精简：4 项没有放进去，交接单末尾逐项列明");
  const plain = await open(t, third(conversation("completed", packetRelay(CODEX)), own(CODEX)), { view: relayView({ packets: [packetRow("recorded", "E1")] }) });
  await expect(plain.log.locator(".user-message").nth(2)).toBeVisible(); await expect(plain.log.locator(".relay-note")).toHaveCount(0);
  assert.deepEqual([resent.errors, alone.errors, bigger.errors, again.errors, small.errors, plain.errors], [[], [], [], [], [], []]);
});

test("what the installation cannot do for the relay stands above the conversation with its reason and how to mend it, is not closed by the user, and nothing waits for it", async t => {
  const reason = "长度是 0 字节，应为 32 字节";
  const { gateway, page, errors, composer } = await open(t, conversation("completed", packetRelay(CODEX)), { view: relayView({ installation: [{ cause: "key_unavailable", detail: reason }, { cause: "something-new" }] }) });
  const notice = page.locator("[data-relay=installation]");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("暂时不能把对话交给别的 Harness");
  await expect(notice).toContainText("接力密钥文件不能用（" + reason + "）");
  await expect(notice).toContainText("relay-key 文件移走");
  await expect(notice).toContainText("重启 HarnessHub");
  await expect(notice.getByRole("button")).toHaveCount(0);
  await shoot(page, "installation-key-unavailable");
  // The message is sent as any other, and the notice stays: its cause does.
  await expect(composer).toBeEnabled();
  await composer.fill("照常发"); await composer.press("Enter");
  await expect.poll(() => gateway.posted.length).toBe(1);
  assert.equal("relay" in gateway.posted[0]!, false);
  await page.reload(); await expect(composer).toBeEnabled(); await page.waitForTimeout(300);
  await expect(page.locator("[data-relay=installation]")).toHaveCount(1);
  // A Gateway with nothing wrong has no such notice, and an answer without the member is read as none.
  const clear = await open(t, conversation("completed", packetRelay(CODEX)), { view: relayView() });
  await expect(clear.composer).toBeEnabled(); await clear.page.waitForTimeout(300);
  await expect(clear.page.locator("[data-relay=installation]")).toHaveCount(0);
  assert.deepEqual(decodeRelayView({ bindings: [], packets: [], installation: [{ cause: "key_unavailable" }, { cause: "x" }, 7, null] })?.installation, [{ cause: "key_unavailable", detail: null }]);
  assert.deepEqual(decodeRelayView({ bindings: [], packets: [] })?.installation, []);
  assert.deepEqual([errors, clear.errors], [[], []]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Narrow screens
// ---------------------------------------------------------------------------------------------------------------------

test("every relay line wraps on a narrow screen and nothing runs off it", async t => {
  for (const width of [390, 320]) {
    const { gateway, page, errors, log } = await open(t, conversation("completed", packetRelay(CODEX)), { viewport: { width, height: 844 } });
    gateway.view = relayView({ packets: [packetRow("unknown", null)] }); gateway.announce();
    await expect(separator(log, "Codex 已回复，但没有确认收到交接单；下一条消息会再附上一次")).toBeVisible();
    const fits = async (what: string) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${what} fits ${width} px`);
    await fits("the unknown hand-over");
    gateway.view = relayView({ packets: [packetRow("recorded", "E1")] }); gateway.announce();
    await expect(separator(log, /^从这里起由 Codex 接手/u)).toBeVisible();
    await fits("the taken hand-over");
    await shoot(page, `narrow-${width}-taken`);
    await page.locator(".relay-divider").getByRole("button", { name: "查看交接单", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "交接单 #1" })).toBeVisible();
    await fits("the packet dialog");
    const dialog = await page.getByRole("dialog", { name: "交接单 #1" }).boundingBox();
    assert.ok(dialog !== null && dialog.x >= 0 && dialog.x + dialog.width <= width, `the dialog sits inside ${width} px`);
    await shoot(page, `narrow-${width}-dialog`);
    await page.keyboard.press("Escape");
    gateway.view = asking(TWICE); gateway.announce();
    await expect(page.locator("[data-relay=attention]")).toBeVisible();
    await fits("the banner");
    await shoot(page, `narrow-${width}-banner`);
    assert.deepEqual(errors, []);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The page's reading of the relay, without a page
// ---------------------------------------------------------------------------------------------------------------------

const harnessNames = (id: string): string => ({ codex: "Codex", claude: "Claude Code" })[id] ?? id;
const typed = (session: FakeSession): SessionView => session as unknown as SessionView;
const runsOf = (session: FakeSession): readonly PublicRun[] => typed(session).runs;
const viewOf = (wire: RelayWire | null): RelayView | null => wire === null ? null : decodeRelayView(wire);
/** What the line where the conversation went from Claude Code to Codex says, for `session` and the relay state `wire`. */
function handover(session: FakeSession, wire: RelayWire | null, extra: { readonly from?: string; readonly to?: string; readonly now?: number } = {}): Handover {
  const view = typed(session);
  return handoverOf({ runs: view.runs, userSeq: userSequences(view.messages), throughSeq: (session.switches[0] as { throughSeq: number }).throughSeq, from: extra.from ?? "claude", to: extra.to ?? "codex", view: viewOf(wire), name: harnessNames, now: extra.now ?? NOW });
}
const kinds = (state: Handover): string => state.kind + ("number" in state && state.number !== null ? "#" + state.number : "");

test("the reading of the relay never takes an unknown word for a good one, and drops what it cannot read", () => {
  assert.equal(decodeRelayView(null), null); assert.equal(decodeRelayView({}), null); assert.equal(decodeRelayView({ bindings: "x", packets: [] }), null);
  const view = decodeRelayView({
    bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 2, sync: "synced", throughRun: 3, evidence: "E1", cleared: 1, canConfirm: true }, { harnessId: "no-control" }, 7, null,
      { harnessId: "hermes", controlId: "hermes-native", sync: "mystery", throughRun: -1, cleared: "many", canConfirm: "maybe", owed: { runs: 2, estTokens: 900 }, evidence: "E2",
        attention: { cause: "delivery_unconfirmed", options: ["attach_full", "teleport", "attach_full", "new_native"], counts: { runs: 2, packets: 1 }, key: "delivery_unconfirmed:relay-0", packet: 4 } },
      { harnessId: "opencode", controlId: "opencode-native", sync: "suspect", owed: { runs: 0, estTokens: 5 }, attention: { cause: "something-new", options: ["attach_full"], counts: {}, key: "x" } },
      { harnessId: "openclaw", controlId: "openclaw-native", attention: { cause: "verify_required", options: [], counts: { runs: 1 } } }],
    packets: [packetRow("recorded", "E1"), packetRow("delivered-ish", "E9"), { packetId: "relay-only-an-id" }, { ...packetRow("in_flight", null), runIndex: -1 }, "x"], handedOver: ["codex", "", 7, null, "hermes"], dataRootExposed: true });
  assert.ok(view !== null);
  assert.deepEqual(view.bindings.map(item => item.harnessId), ["codex", "hermes", "opencode", "openclaw"]);
  assert.deepEqual(view.bindings[0], { harnessId: "codex", controlId: "codex-native", nativeEpoch: 2, sync: "synced", throughRun: 3, evidence: "E1", cleared: 1, canConfirm: true, owed: null, attention: null });
  // A word the page does not know is "unknown" (the removed "suspect" state included), a number it cannot read is nothing, a proof it does not have is none, and a flag that is not true is not.
  assert.deepEqual(view.bindings[1], { harnessId: "hermes", controlId: "hermes-native", nativeEpoch: 1, sync: "unknown", throughRun: null, evidence: null, cleared: 0, canConfirm: null, owed: { runs: 2, estTokens: 900 },
    attention: { cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 2, packets: 1 }, key: "delivery_unconfirmed:relay-0", packet: 4 } });
  assert.equal(view.bindings[2]!.sync, "unknown");
  // Nothing owed is no `owed`; a cause the page does not know asks nothing of the user (it is not shown as another); a banner needs its key.
  assert.deepEqual([view.bindings[2]!.owed, view.bindings[2]!.attention], [null, null]);
  assert.equal(view.bindings[3]!.attention, null, "a cause that no longer exists asks nothing");
  assert.deepEqual(view.handedOver, ["codex", "hermes"], "only names"); assert.deepEqual(decodeRelayView({ bindings: [], packets: [] })?.handedOver, [], "an answer without the member says none");
  assert.deepEqual(view.packets.map(item => [item.delivery, item.evidence]), [["recorded", "E1"], [null, null]]);
  assert.equal("dataRootExposed" in view, false, "the data directory's warning is gone");

  // A Turn's relay member: unknown levels are no relay facts at all; an unknown delivery word is no delivery state.
  assert.equal(decodeRunRelay({ packetId: null, kind: null, continuity: { kind: "teleport" }, executedOn: null }), null);
  assert.equal(decodeRunRelay({ packetId: 5, kind: null, continuity: { kind: "native_resume" } }), null);
  assert.equal(decodeRunRelay("native_resume"), null);
  const decoded = decodeRunRelay({ packetId: PACKET, kind: "packet", continuity: { kind: "rehydrate", tier: "full", complete: true }, executedOn: { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1 }, delivery: { state: "yes!", evidence: "E1" } });
  assert.ok(decoded !== null);
  assert.deepEqual(runRelayInfo({ relay: decoded }), { packetId: PACKET, kind: "packet", continuity: { kind: "rehydrate", tier: "full", complete: true }, executedOn: { harnessId: "codex", controlId: "codex-native", nativeEpoch: 1 }, delivery: { state: null, evidence: "E1" }, decision: null });
  // A tier the relay no longer has is no tier.
  assert.equal(runRelayInfo({ relay: decodeRunRelay({ packetId: PACKET, kind: "packet", continuity: { kind: "rehydrate", tier: "standard", complete: false }, executedOn: null })! })?.continuity.tier, undefined);
  // What the relay decided for a Turn: kinds and authors it knows, an unknown cause only left out, an unknown kind no decision at all.
  const decided = (decision: unknown) => runRelayInfo({ relay: decodeRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: null, decision })! })?.decision;
  assert.deepEqual(decided({ kind: "alone", by: "policy", cause: "delivery_unconfirmed" }), { kind: "alone", by: "policy", cause: "delivery_unconfirmed", reason: null, resend: null });
  assert.deepEqual(decided({ kind: "alone", by: "policy", cause: "prepare_failed", reason: "storage_quota" }), { kind: "alone", by: "policy", cause: "prepare_failed", reason: "storage_quota", resend: null });
  assert.deepEqual(decided({ kind: "carry", by: "need", cause: "something-new" }), { kind: "carry", by: "need", cause: null, reason: null, resend: null });
  // How a carried packet was sent again: only the three ways the Gateway knows are read; a word it does not know leaves the way unsaid.
  assert.deepEqual(["auto", "grown", "all", "user", "robot", 3, null].map(resend => decided({ kind: "carry", by: "need", resend })?.resend), ["auto", "grown", "all", null, null, null, null]);
  for (const odd of [{ kind: "teleport", by: "policy" }, { kind: "alone", by: "robot" }, { kind: "alone" }, "alone", 7, null]) assert.equal(decided(odd) ?? null, null, JSON.stringify(odd));
  assert.equal(runRelayInfo({}), null);
  assert.deepEqual(runRelayInfo({ relay: decodeRunRelay({ packetId: null, kind: null, continuity: "native_fork", executedOn: null })! })?.continuity, { kind: "native_fork" });

  // What a message sends: nothing it was not asked to, and nothing the relay no longer takes.
  assert.equal(relayBody(undefined), null); assert.equal(relayBody({}), null);
  assert.deepEqual(relayBody({ attach: "none" }), { attach: "none" }); assert.deepEqual(relayBody({ attach: "full" }), { attach: "full" });
  assert.deepEqual(relayBody({ attach: "full", resend: true, native: "new", tier: "brief", note: "x" } as never), { attach: "full" });

  // The setting, from any of the shapes a Gateway may answer with; a value that cannot be read is not shown as another.
  assert.deepEqual(decodeRelayPrefs({ "relay.attach": "off" }), { attach: "off" });
  assert.deepEqual(decodeRelayPrefs({ prefs: { "relay.attach": "auto", "relay.crossVendor": "ask" } }), { attach: "auto" });
  assert.deepEqual(decodeRelayPrefs([{ key: "relay.attach", value: "off" }, { key: "relay.allowUnprobed", value: "true" }]), { attach: "off" });
  assert.deepEqual(decodeRelayPrefs({}), { attach: "auto" }, "what the Gateway does not name is at its default: on");
  assert.equal(decodeRelayPrefs({ "relay.attach": "sometimes" }), null); assert.equal(decodeRelayPrefs("x"), null); assert.equal(decodeRelayPrefs(null), null);
  assert.deepEqual(decodeRelayFrame({ type: "relay", event: { type: "relay.input_recorded", sessionId: SESSION, runId: "run-2", at: 5 } }), { type: "relay.input_recorded", sessionId: SESSION, runId: "run-2", packetId: null });
  assert.equal(decodeRelayFrame({ type: "run", event: {} }), null); assert.equal(decodeRelayFrame({ type: "relay" }), null); assert.equal(decodeRelayFrame({ type: "relay", event: {} }), null);
});

test("the relay's data layer answers 'no relay information' for a Gateway without it, and says why a read or a write failed", async () => {
  const seen: { readonly method: string; readonly path: string; readonly body?: unknown; readonly as: string }[] = [];
  const reply = (status: number, body: unknown = undefined, etag: string | null = null): RelayReply => ({ status, body, etag });
  const make = (answer: (path: string) => RelayReply | Error): RelayTransport => ({ send: async request => {
    seen.push({ method: request.method, path: request.path, as: request.as, ...(request.body === undefined ? {} : { body: request.body }) });
    const result = answer(request.path); if (result instanceof Error) throw result; return result;
  } });
  // Reads: missing, unreadable and unreachable are all "none"; they never reject.
  const read = (answer: RelayReply | Error) => createRelayApi(make(() => answer)).view("session-a b");
  // A route the Gateway does not have is "absent"; a conversation it does not have, a failure and a surprise are not.
  assert.deepEqual(await read(reply(404, { code: "NOT_FOUND", message: "API route not found" })), { view: null, absent: true });
  assert.deepEqual(await read(reply(404)), { view: null, absent: true });
  assert.deepEqual(await read(reply(405)), { view: null, absent: true });
  assert.deepEqual(await read(reply(501)), { view: null, absent: true });
  assert.deepEqual(await read(reply(404, { code: "SESSION_NOT_FOUND", message: "no such conversation" })), { view: null, absent: false });
  assert.deepEqual(await read(reply(500, { code: "GATEWAY_FAILED" })), { view: null, absent: false });
  assert.deepEqual(await read(reply(200, { nothing: true })), { view: null, absent: false });
  assert.deepEqual(await read(new Error("network")), { view: null, absent: false });
  assert.deepEqual((await read(reply(200, relayView({ packets: [packetRow("recorded", "E1")] })))).view?.packets.map(item => item.packetId), [PACKET]);
  assert.equal(seen[0]?.path, "/sessions/session-a%20b/relay"); assert.equal(seen[0]?.as, "json");
  assert.equal(await createRelayApi(make(() => reply(404))).prefs(), null); assert.equal(await createRelayApi(make(() => new Error("network"))).prefs(), null);
  assert.deepEqual(await createRelayApi(make(() => reply(200, { prefs: { "relay.attach": "off" } }))).prefs(), { attach: "off" });
  // A packet that is not there is not a relay that is not there: its own code (and a conversation's) leave the Gateway known to have the relay.
  assert.deepEqual(await read(reply(404, { code: "RELAY_PACKET_NOT_FOUND", message: "this conversation has no such handoff packet" })), { view: null, absent: false });
  // A packet's text: the text and its ETag, or a reason in the page's words.
  const text = await createRelayApi(make(() => reply(200, PACKET_TEXT, "abc"))).packetText("session-1", PACKET);
  assert.deepEqual(text, { text: PACKET_TEXT, etag: "abc" });
  assert.deepEqual(seen.at(-1), { method: "GET", path: `/sessions/session-1/relay/${PACKET}`, as: "text" });
  await assert.rejects(createRelayApi(make(() => reply(404))).packetText("session-1", PACKET), (error: unknown) => error instanceof RelayReadError && error.status === 404 && error.message === "这份交接单已不存在，或不属于这个对话。");
  await assert.rejects(createRelayApi(make(() => reply(200, { not: "text" }))).packetText("session-1", PACKET), (error: unknown) => error instanceof RelayReadError && error.message === "这份交接单没有读到（网关返回 200）。");
  await assert.rejects(createRelayApi(make(() => reply(500))).packetText("session-1", PACKET), /网关返回 500/u);
  // The one write: the setting, as the key and the value.
  await createRelayApi(make(() => reply(200, {}))).setPref("attach", "off");
  assert.deepEqual(seen.at(-1), { method: "PUT", path: "/relay/prefs", as: "json", body: { key: "relay.attach", value: "off" } });
  await createRelayApi(make(() => reply(204))).setPref("attach", "auto");
  assert.deepEqual(seen.at(-1), { method: "PUT", path: "/relay/prefs", as: "json", body: { key: "relay.attach", value: "auto" } });
  await assert.rejects(createRelayApi(make(() => reply(502))).setPref("attach", "off"), (error: unknown) => error instanceof RelayReadError && error.message === "这项设置没有保存（网关返回 502）。");
});

test("the hand-over line follows the evidence: every state, and what each says before it may say taken over", () => {
  const wire = (...packets: Record<string, unknown>[]) => relayView({ packets });
  // Nothing was sent to the new Harness yet: with relay information nothing is drawn; without it, the line as it always was.
  assert.equal(handover(conversation("none"), relayView()).kind, "none");
  assert.equal(handover(conversation("none"), null).kind, "legacy");
  // A Turn accepted but not prepared: nothing yet. Prepared and handed over: on its way, with its number when the Gateway gives one.
  assert.equal(handover(conversation("preparing"), relayView()).kind, "none");
  const running = conversation("running", packetRelay(CODEX));
  assert.equal(kinds(handover(running, wire(packetRow("in_flight", null)))), "pending#1");
  assert.equal(kinds(handover(running, relayView())), "pending", "a packet the view does not list yet is on its way, without a number");
  running.runs[1]!.timing = { ...running.runs[1]!.timing!, firstOutputAt: NOW - 1000 };
  assert.equal(kinds(handover(running, wire(packetRow("in_flight", null)))), "started#1");
  // Evidence: taken over, with how and the proof; the view is read before the Turn's own word, which may be older.
  const over = conversation("completed", packetRelay(CODEX));
  const taken = handover(over, wire(packetRow("recorded", "E3")));
  assert.deepEqual(taken, { kind: "taken", runId: "run-2", how: "新会话 · 交接单（完整） · #1", number: 1, packetId: PACKET, evidence: "E3", fresh: false });
  const fromTurn = conversation("completed", packetRelay(CODEX, { delivery: { state: "unknown", evidence: null } }));
  assert.equal(handover(fromTurn, null).kind, "unknown", "a Turn that carries its delivery makes the Gateway a relay Gateway without a view");
  assert.equal(kinds(handover(fromTurn, wire(packetRow("recorded", "E1")))), "taken#1", "a delivery decided later wins over the Turn's older word");
  // Not confirmed, not arrived, and a word the page does not know: never taken over, said as what is known.
  assert.deepEqual(handover(over, wire(packetRow("unknown", null))), { kind: "unknown", runId: "run-2", replied: true, cannotConfirm: false, number: 1, packetId: PACKET, fresh: false });
  assert.equal(kinds(handover(over, wire(packetRow("not_recorded", null)))), "not_recorded#1");
  assert.equal(handover(over, wire(packetRow("delivered-ish", "E1"))).kind, "unknown");
  assert.equal(handover(over, relayView()).kind, "unknown", "over, and the Gateway lists no delivery: not confirmed");
  const silent = conversation("failed", packetRelay(CODEX)); delete silent.runs[1]!.timing!.firstOutputAt;
  assert.deepEqual(handover(silent, wire(packetRow("unknown", null))), { kind: "unknown", runId: "run-2", replied: false, cannotConfirm: false, number: 1, packetId: PACKET, fresh: false });
  // A Harness whose Driver has no way to learn that a handoff arrived: said as what it is, once.
  const unable = relayView({ packets: [packetRow("unknown", null)], bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "pending", throughRun: null, evidence: null, cleared: 0, canConfirm: false }] });
  assert.deepEqual(handover(over, unable), { kind: "unknown", runId: "run-2", replied: true, cannotConfirm: true, number: 1, packetId: PACKET, fresh: false });
  // The Turn's own continuation, with no packet owed: the original session goes on, and it took over once the Turn was handed to it.
  const resume = conversation("completed", own(CODEX));
  assert.deepEqual(handover(resume, relayView()), { kind: "taken", runId: "run-2", how: "继续原会话", number: null, packetId: null, evidence: null, fresh: false });
  // Words sent alone, by the relay's policy or the user's choice, did not hand the conversation over: never "taken", and the line says why.
  const aloneBy = (decision: Record<string, unknown>) => handover(conversation("completed", { ...own(CODEX), decision }), relayView());
  assert.deepEqual(aloneBy({ kind: "alone", by: "policy", cause: "input_limit", reason: "input_limit" }), { kind: "alone", runId: "run-2", note: "Codex 一次放不下这条消息和交接单 · 这条只发了原话", number: null, packetId: null, fresh: false });
  assert.equal((aloneBy({ kind: "alone", by: "user" }) as { note: string }).note, "这条消息按你的选择只发了原话");
  assert.equal((aloneBy({ kind: "alone", by: "policy", cause: "recovery_failed" }) as { note: string }).note, "服务重启后没能恢复这个对话的交接记录 · 这条只发了原话");
  assert.equal(aloneBy({ kind: "plain", by: "need" }).kind, "taken", "a Turn that owed nothing any more went as typed, and the Harness took the conversation over");
  assert.equal(handover(conversation("running", { ...own(CODEX), decision: { kind: "alone", by: "policy", cause: "input_limit" } }), relayView()).kind, "alone", "handed to the Harness, and said so at once");
  assert.equal(handover(conversation("preparing", { ...own(CODEX), decision: { kind: "alone", by: "policy", cause: "input_limit" } }), relayView()).kind, "none");
  const early = conversation("preparing", own(CODEX)); assert.equal(handover(early, relayView()).kind, "none");
  assert.equal(handover(conversation("failed", { ...own(CODEX), continuity: { kind: "blocked", code: "RELAY_PREPARE_FAILED" } }), relayView()).kind, "none");
  const delta = conversation("completed", { packetId: PACKET, kind: "delta", continuity: { kind: "native_resume_delta", tier: "brief", runs: 2 }, executedOn: { ...CODEX, nativeEpoch: 1 } });
  assert.equal((handover(delta, wire(packetRow("recorded", "E3"))) as { how: string }).how, "继续原会话 · 补交 2 轮 · 交接单 #1");
  // A Turn with no relay facts (from before the relay): the Harness answered, so the line is as it always was; before that, nothing.
  assert.equal(handover(conversation("completed"), relayView()).kind, "legacy");
  assert.equal(handover(conversation("running"), relayView()).kind, "none");
  // Within one Harness there is nothing handed over.
  assert.equal(handover(over, wire(packetRow("recorded", "E1")), { from: "codex", to: "codex" }).kind, "legacy");
  // News is what was accepted moments ago.
  assert.equal((handover(over, wire(packetRow("recorded", "E1")), { now: NOW - 20_000 + 2000 }) as { fresh: boolean }).fresh, true);
  assert.equal((handover(over, wire(packetRow("recorded", "E1")), { now: NOW }) as { fresh: boolean }).fresh, false);
});

test("what is owed to the Harness the conversation is on: counted once per Harness, said as the first hand-over only until the Gateway has handed one over, and off when the setting is", () => {
  const line = (session: FakeSession, wire: RelayWire | null, prefs: { attach: "auto" | "off" } | null = null) => relayLine(typed(session), viewOf(wire), prefs);
  // Claude Code's Turn is owed to Codex, which has no session here yet: its Turns are counted by the page, and no conversation was ever handed to it.
  assert.deepEqual(line(conversation("none"), NO_CODEX()), { kind: "owed", runs: 1, tokens: null, first: true, off: false });
  assert.deepEqual(line(conversation("none"), NO_CODEX(["codex"])), { kind: "owed", runs: 1, tokens: null, first: false, off: false }, "the Gateway handed a conversation to Codex before");
  assert.deepEqual(line(conversation("none"), NO_CODEX(["hermes"])), { kind: "owed", runs: 1, tokens: null, first: true, off: false }, "another Harness's hand-over is not Codex's");
  // The Gateway keeps a session of Codex's and says nothing is owed to it: that is the word (its floors and clears are its to know), not the page's count.
  assert.equal(line(conversation("none"), relayView()), null);
  // Once the Harness has a session here the Gateway's count and estimate are the ones shown.
  const estimated = relayView({ handedOver: ["codex"], bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "fresh", throughRun: null, evidence: null, cleared: 0, owed: { runs: 3, estTokens: 1700 } }] });
  assert.deepEqual(line(conversation("none"), estimated), { kind: "owed", runs: 3, tokens: 1700, first: false, off: false });
  // With the setting off the line says so: the message goes with the words alone unless the user attaches it.
  assert.deepEqual(line(conversation("none"), NO_CODEX(["codex"]), { attach: "off" }), { kind: "owed", runs: 1, tokens: null, first: false, off: true });
  assert.equal(line(conversation("none"), NO_CODEX(["codex"]), { attach: "auto" })?.off, false);
  // Nothing is owed when the Gateway says Codex holds the Turn, when there is no relay state, or while something runs or waits.
  assert.equal(line(conversation("none"), relayView({ bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "synced", throughRun: 0, evidence: "E1", cleared: 0 }] })), null);
  assert.equal(line(conversation("none"), null), null);
  assert.equal(line(conversation("running", packetRelay(CODEX)), relayView()), null);
  const waiting = conversation("none"); waiting.pendingSwitchId = "switch-2"; assert.equal(line(waiting, relayView()), null);
  const closed = conversation("none"); closed.status = "closed"; assert.equal(line(closed, relayView()), null);
  // A Turn that never reached its Harness is nothing to hand over.
  const unsent = conversation("none"); delete unsent.runs[0]!.timing!.dispatchedAt; assert.equal(line(unsent, relayView()), null);
  // After a clear the history is offered back as a banner (bannerOf), not as this line.
  const cleared = relayView({ bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 2, sync: "fresh", throughRun: null, evidence: null, cleared: 1 }] });
  assert.equal(line(conversation("completed", packetRelay(CODEX)), cleared), null);
});

test("a banner says what a binding asks once, the one way to settle it is a field of the next message, and nothing stops the message", () => {
  const binding = (attention: Record<string, unknown>, extra: Record<string, unknown> = {}) => viewOf(relayView({ bindings: [{ harnessId: "codex", controlId: "codex-native", nativeEpoch: 1, sync: "pending", throughRun: null, evidence: null, cleared: 0, attention, ...extra }] }))!.bindings[0];
  const never = () => false;
  const view = (attention: Record<string, unknown>, extra: Record<string, unknown> = {}) => bannerOf(binding(attention, extra), "Codex", never);
  const sends = (banner: ReturnType<typeof view>) => banner?.actions.map(action => [action.label, action.request]);
  // A delivery nothing confirmed: not yet sent again, then sent twice (and the messages go alone from there); the packet's number is the Gateway's.
  const once = view({ cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 2, packets: 1 }, key: "delivery_unconfirmed:relay-a", packet: 3 });
  assert.equal(once?.text, "交接单 #3 还没有确认送达 Codex");
  assert.deepEqual(sends(once), [["再附一次", { attach: "full" }]]);
  const twice = view({ cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 0, packets: 2 }, key: "delivery_unconfirmed:relay-b", packet: 4 });
  assert.equal(twice?.text, "交接单 #4 发了两次仍未确认送达 Codex · 之后的消息只发原话，有新内容再附");
  assert.equal(view({ cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 0, packets: 2 }, key: "k" })?.text, "上一份交接单发了两次仍未确认送达 Codex · 之后的消息只发原话，有新内容再附");
  // A cleared conversation offers its earlier part, once, for the next message.
  const cleared = view({ cause: "attach_available", options: ["attach_full"], counts: { runs: 2, packets: 0 }, key: "attach_available:2" });
  assert.equal(cleared?.text, "Codex 的上下文已清空 · 下一条不附历史");
  assert.deepEqual(sends(cleared), [["附上交接单", { attach: "full" }]]);
  assert.equal(cleared?.actions[0]?.chosen, "下一条会附上之前对话的交接单"); assert.equal(once?.actions[0]?.chosen, "下一条消息会再附一次交接单");
  // The way the Gateway did not give is not offered, and a way the page does not know is dropped; nothing the relay no longer has can be asked.
  assert.deepEqual(view({ cause: "attach_available", options: [], counts: { runs: 1, packets: 0 }, key: "a" })?.actions, []);
  assert.deepEqual(view({ cause: "attach_available", options: ["send_alone", "new_native", "clear_confirmed", "acknowledge"], counts: { runs: 1, packets: 0 }, key: "a" })?.actions, []);
  assert.equal(view({ cause: "verify_required", options: ["attach_full"], counts: { runs: 0, packets: 0 }, key: "v" }), null, "a cause that no longer exists");
  assert.deepEqual(relayRequestFor("attach_full"), { attach: "full" });
  // What the user closed does not come back; a Harness that cannot confirm is not nagged about its delivery, nor about anything else it could not do anyway.
  assert.equal(bannerOf(binding({ cause: "attach_available", options: ["attach_full"], counts: { runs: 1, packets: 0 }, key: "a" }), "Codex", key => key === "a"), null);
  assert.equal(bannerOf(binding({ cause: "delivery_unconfirmed", options: ["attach_full"], counts: { runs: 1, packets: 1 }, key: "d" }, { canConfirm: false }), "Codex", never), null);
  assert.notEqual(bannerOf(binding({ cause: "attach_available", options: ["attach_full"], counts: { runs: 1, packets: 0 }, key: "a" }, { canConfirm: false }), "Codex", never), null, "only a delivery nothing can confirm is left unsaid");
  assert.equal(bannerOf(undefined, "Codex", never), null); assert.equal(bannerOf({ ...binding({ cause: "attach_available", options: [], counts: { runs: 0, packets: 0 }, key: "v" })!, attention: null }, "Codex", never), null);
});

test("what the relay decided for a Turn's history is said in the words of the decision, and never as a Harness taking over", () => {
  const info = (decision: Record<string, unknown> | null, relay: Record<string, unknown> = {}) => runRelayInfo({ relay: decodeRunRelay({ packetId: null, kind: null, continuity: { kind: "native_resume" }, executedOn: { ...CODEX, nativeEpoch: 1 }, ...(decision === null ? {} : { decision }), ...relay })! })!;
  const ctx: NoteContext = { target: "Codex", number: 3, sourceRuns: 2, pending: 2, omissions: 0, cannotConfirm: false };
  const say = (decision: Record<string, unknown> | null, relay: Record<string, unknown> = {}, context = ctx) => decisionNote(info(decision, relay), context);
  // The history went as it was owed: nothing to say. Or it went alone, and the words say why.
  assert.equal(say(null), null); assert.equal(say({ kind: "carry", by: "need" }, { packetId: PACKET }), null); assert.equal(say({ kind: "plain", by: "need" }), null);
  assert.equal(say({ kind: "plain", by: "user" }), "没有可附的交接内容，这条消息按原样发出");
  assert.equal(say({ kind: "alone", by: "user" }), "这条消息按你的选择只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "delivery_unconfirmed" }), "交接单 #2 发了两次仍未确认送达 · 这条只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, {}, { ...ctx, cannotConfirm: true }), "交接单 #2 已发出，Codex 无法确认是否收到 · 这条只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "delivery_unconfirmed" }, {}, { ...ctx, pending: null }), "上一份交接单发了两次仍未确认送达 · 这条只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "input_limit", reason: "input_limit" }), "Codex 一次放不下这条消息和交接单 · 这条只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "recovery_failed" }), "服务重启后没能恢复这个对话的交接记录 · 这条只发了原话");
  assert.equal(say({ kind: "alone", by: "policy", cause: "prepare_failed", reason: "storage_quota" }), "这次没能准备交接单（存储空间不足） · 这条只发了原话，下一条会再试");
  assert.equal(say({ kind: "alone", by: "policy", cause: "prepare_failed", reason: "unheard-of" }), "这次没能准备交接单 · 这条只发了原话，下一条会再试");
  // The packet went again, or went whole again, or left whole items out.
  const carried = { packetId: PACKET, kind: "packet", continuity: { kind: "rehydrate", tier: "full", runs: 2 } };
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed" }, carried), "上一份交接单没有确认送达，这条消息已再附一次（交接单 #3 · 补交 2 轮）");
  // The two kinds of automatic resend are told apart: the same facts again, and a packet for newer facts that also holds the unconfirmed one's.
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "auto" }, carried), "上一份交接单没有确认送达，这条消息已再附一次（交接单 #3 · 补交 2 轮）");
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" }, carried), "这条消息补交了 2 轮，含上次没有确认送达的内容（交接单 #3）");
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" }, { ...carried, continuity: { kind: "rehydrate", tier: "full" } }, { ...ctx, sourceRuns: 5 }),
    "这条消息补交了 5 轮，含上次没有确认送达的内容（交接单 #3）", "a whole packet names its Turns by the Runs it carries");
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "grown" }, carried, { ...ctx, number: null }), "这条消息补交了 2 轮，含上次没有确认送达的内容");
  assert.equal(say({ kind: "carry", by: "policy", cause: "history_changed", resend: "all" }, carried), "Codex 的会话可能回退过，已整份重发（可能与已有内容重复）");
  assert.equal(say({ kind: "carry", by: "user" }, carried), null, "the user's own attach needs no note");
  assert.equal(say({ kind: "carry", by: "policy", cause: "delivery_unconfirmed", resend: "teleport" }, carried), "上一份交接单没有确认送达，这条消息已再附一次（交接单 #3 · 补交 2 轮）", "a kind this page does not know reads as the plain resend");
  assert.equal(say({ kind: "carry", by: "need" }, { ...carried, continuity: { kind: "rehydrate", tier: "brief" } }), "交接单放不下全部记录，已精简，没放进去的在交接单末尾逐项列明");
  assert.equal(say({ kind: "carry", by: "need" }, { ...carried, continuity: { kind: "rehydrate", tier: "brief" } }, { ...ctx, omissions: 6 }), "交接单放不下全部记录，已精简：6 项没有放进去，交接单末尾逐项列明");
  assert.equal(say(null, { ...carried, continuity: { kind: "rehydrate", tier: "brief" } }), "交接单放不下全部记录，已精简，没放进去的在交接单末尾逐项列明");
  // Notes by Turn: from the Turns' own words and the packets the view lists.
  const session = conversation("completed", packetRelay(CODEX, { decision: { kind: "carry", by: "policy", cause: "delivery_unconfirmed" } }));
  const notes = runNotes({ runs: runsOf(session), view: viewOf(relayView({ packets: [packetRow("unknown", null)] })), name: harnessNames });
  assert.deepEqual([...notes], [["run-2", "上一份交接单没有确认送达，这条消息已再附一次（交接单 #1）"]]);
});

test("the conversation stream carries a relay notice as a frame under the watermark of the facts it follows, and an event of its own name without moving the cursor", async () => {
  const encoder = new TextEncoder(), relayEvents: unknown[] = [], frames: { readonly type: string }[] = [];
  const event = (type: string, at: number) => ({ type, sessionId: SESSION, at });
  const body = [
    // An event of its own name: handed on, no cursor; one that is not JSON is dropped and does not end the stream.
    "event: relay\ndata: " + JSON.stringify({ type: "relay", event: event("relay.input_recorded", 1) }) + "\n\n",
    "event: relay\ndata: {not json\n\n",
    ": heartbeat\n\n",
    "event: session\nid: 9\ndata: " + JSON.stringify({ type: "snapshot", session: { id: SESSION, version: 8, lastSeq: 9 } }) + "\n\n",
    // The notice the Gateway sends: a frame, under the watermark of the snapshot before it.
    "event: session\nid: 9\ndata: " + JSON.stringify({ type: "relay", sessionId: SESSION, version: 8, lastSeq: 9, event: event("relay.input_recorded", 2) }) + "\n\n",
  ].join("");
  const decode = (value: unknown) => (value as { type?: unknown }).type === "relay" ? decodeSessionStreamFrame(value) : ({ type: "snapshot" as const, session: (value as { session: SessionView }).session });
  const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } });
  await consumeSessionEventStream(stream(body), { signal: new AbortController().signal, decode, onFrame: frame => { frames.push(frame); }, onRelay: value => { relayEvents.push(value); } });
  assert.deepEqual(relayEvents.map(value => decodeRelayFrame(value)?.type), ["relay.input_recorded"]);
  assert.deepEqual(frames.map(frame => frame.type), ["snapshot", "relay"], "the notice is a frame of the stream, read for its event by whoever takes the frames");
  // Without a listener for the named event it is ignored; the stream still delivers the frames.
  const ignored: unknown[] = [];
  await consumeSessionEventStream(stream(body), { signal: new AbortController().signal, decode, onFrame: frame => { ignored.push(frame); } });
  assert.equal(ignored.length, 2);
  // The notice keeps the rules every frame has: its identity on the wire is its facts' watermark.
  await assert.rejects(consumeSessionEventStream(stream("event: session\nid: 7\ndata: " + JSON.stringify({ type: "relay", sessionId: SESSION, version: 8, lastSeq: 9, event: event("relay.input_recorded", 1) }) + "\n\n"),
    { signal: new AbortController().signal, decode, onFrame: () => {} }), (error: unknown) => error instanceof SessionStreamError && error.code === "STREAM_INVALID_FRAME");
  // What is not a relay event keeps the rules it always had: a session event without a cursor ends the stream.
  await assert.rejects(consumeSessionEventStream(stream("event: session\ndata: " + JSON.stringify({ type: "snapshot", session: {} }) + "\n\n"), { signal: new AbortController().signal, decode, onFrame: () => {} }),
    (error: unknown) => error instanceof SessionStreamError && error.code === "STREAM_INVALID_FRAME");
});
