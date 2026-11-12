import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { textRange, turnsBefore, v14 } from "./v14.js";

/*
 * A Turn drawn from the protocol's items (docs/proposals/protocol/hub-protocol.html §13), in a real browser: the same lines for every
 * Harness, each item in the order it came, consecutive actions folded into one summary line that opens to their lines, a thought as
 * one line, the hand-over as one line, one footer. The page is given a conversation whose Runs carry protocol Turns, by a fake Gateway
 * written here: it serves the built page and the few calls the page makes, with the shapes the real Gateway sends. Everything it says
 * is data the test sets; what the test checks is what the page makes of it. A Run whose protocol Turn the page cannot read says so,
 * with the reason, and is drawn from nothing else.
 *
 * Run: `pnpm build && pnpm web:build && node --test dist/tests/browser/protocol.browser.js` (it needs the built page and Chromium).
 * Pictures of each state, light and dark, are written to artifacts/protocol-ui/ (not committed).
 */

const dist = resolve(fileURLToPath(new URL("../../../web/dist/", import.meta.url)));
const artifact = resolve("artifacts/protocol-ui");
const CSRF = "csrf-protocol-test", SESSION = "session-protocol-1", PACKET = "relay-0123456789abcdefghjk";
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const NOW = Date.now();

// ---------------------------------------------------------------------------------------------------------------------
// What the fake Gateway holds: a conversation whose Runs carry protocol Turns, in the JSON shape of the conversation view
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
interface FakeSession { id: string; version: number; lastSeq: number; epoch: number; status: string; workspace: string; selection: Json; activeRunId: string | null; pendingSwitchId: null; permissions: unknown[]; nativeStates: unknown[]; messages: Json[]; runs: Json[]; switches: unknown[] }

const HARNESS = { claude: { harnessId: "claude", harness: "Claude Code" }, codex: { harnessId: "codex", harness: "Codex" }, dsh: { harnessId: "dsh", harness: "DeepSeek Harness" } } as const;
const control = (id: string) => ({ harnessId: id, controlId: id + "-native" });

/** A protocol item: its base fields, then the fields of its type. */
let sequence = 0;
const item = (type: string, more: Json = {}, status = "completed"): Json => ({ id: "item-" + (sequence += 1), seq: sequence, type, status, ...more });
const message = (n: number, role: "user" | "assistant", text: string, status: string, seq: number): Json => ({ id: `message-${role}-${n}`, runId: "run-" + n, role, text, seq, status });
const user = (n: number): Json => item("user_message", { messageId: `message-user-${n}` });
const reply = (n: number, status = "completed"): Json => item("assistant_message", { messageId: `message-assistant-${n}`, phase: "final" }, status);
const cmd = (command: string, more: Json = {}, status = "completed"): Json => item("command", { command, ...more }, status);
const read = (path: string | null, status = "completed"): Json => item("file_read", { path }, status);
const edit = (path: string, added: number, removed: number, more: Json = {}): Json => item("file_change", { changes: [{ path, op: "modify", added, removed }], ...more });

interface RunOptions { readonly n: number; readonly harness: keyof typeof HARNESS; readonly input: string; readonly status: string; readonly items: readonly Json[]; readonly model?: string; readonly usage?: Json; readonly durationMs?: number; readonly stopReason?: string }
function run(options: RunOptions): Json {
  const { n, harness, status } = options, over = ["completed", "failed", "cancelled", "unknown"].includes(status);
  const timing = { acceptedAt: NOW - 700_000 + n * 60_000, preparingAt: NOW - 699_000 + n * 60_000, readyAt: NOW - 698_000 + n * 60_000, dispatchedAt: NOW - 697_000 + n * 60_000, firstOutputAt: NOW - 695_000 + n * 60_000, ...(over ? { endedAt: NOW - 690_000 + n * 60_000 } : {}) };
  return { id: "run-" + n, commandId: "cmd-run-" + n, input: options.input, userMessageId: "message-user-" + n, assistantMessageId: "message-assistant-" + n, selection: control(harness), epoch: 1, status, cancelRequested: false, contextThroughSeq: 0, sourceRunIds: [],
    backend: over ? { status: status === "completed" ? "completed" : "failed", reason: status } : null, cleanup: over ? { closed: true, exitCode: 0, signal: null, protocolFailure: null } : null, error: null, stopRequested: false, awaitingSwitchId: null, timing,
    protocol: { version: "hh/1", runId: "run-" + n, n, status, ...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
      executor: { ...HARNESS[harness], ...(options.model === undefined ? {} : { model: { id: options.model, label: options.model } }) }, usage: options.usage ?? { completeness: "unavailable" },
      startedAt: timing.acceptedAt, ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }), items: options.items } };
}
function conversation(runs: readonly Json[], replies: Readonly<Record<number, string>>, active: string | null = null): FakeSession {
  const messages: Json[] = [];
  let seq = 1;
  for (const row of runs) {
    const n = Number(String(row.id).slice(4));
    messages.push(message(n, "user", String(row.input), String(row.status), seq += 1));
    if (replies[n] !== undefined) messages.push(message(n, "assistant", replies[n]!, String(row.status), seq += 1));
  }
  const lastSeq = seq + 2;
  return { id: SESSION, version: lastSeq - 1, lastSeq, epoch: 1, status: "open", workspace: "/tmp/protocol-ui-workspace", selection: control("codex"), activeRunId: active, pendingSwitchId: null, permissions: [], nativeStates: [], messages, runs: [...runs], switches: [] };
}

/** A control entry the next fake Gateway reports as unavailable (its Harness then cannot take a message). */
let unavailableControl: string | null = null;
function harnessView(id: string, name: string): Json {
  return { id, name, tier: "focus", installed: true, defaultControlId: id + "-native", providerProtocols: [], install: null, installations: [], unofficial: null,
    management: { harnessId: id, recipe: null, source: "system", installedVersion: "1.0.0", programVersion: "1.0.0", latestVersion: null, updateStatus: "current", checkedAt: null, activeJobId: null, installationId: null, defaultRevision: 1, error: null },
    controls: [{ id: id + "-native", protocol: "acp-v1", available: unavailableControl !== id + "-native", reason: unavailableControl === id + "-native" ? "找不到程序" : null, entry: { source: "path" } }] };
}
const PACKET_TEXT = "〔HarnessHub 交接单 " + PACKET + "〕\n下面是 Claude Code 交给你的对话要点。\n〔交接单结束〕\n";
const CONTENT: Readonly<Record<string, Json>> = {
  "content-npmtest": { kind: "execute", name: "shell", input: "npm test", output: "# tests 10\n# pass 7\n# fail 3", exitCode: 1 },
  "content-cartdiff": { kind: "edit", name: "apply_patch", diff: "--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1,2 +1,2 @@\n-const total = tax(subtotal - discount);\n+const total = tax(subtotal) - discount;\n const x = 1;\n" },
};
const ref = (id: string): Json => ({ id, name: id + ".json", mediaType: "application/json", kind: "file", bytes: 10, sha256: "a".repeat(64) });

class FakeGateway {
  readonly clients = new Set<ServerResponse>();
  /** How many times a page connected to the conversation's stream, and read the conversation by its own request. */
  streams = 0; reads = 0;
  private readonly others = new Set<ServerResponse>();
  private readonly server: Server;
  url = "";
  constructor(readonly session: FakeSession) {
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
  private frame(): string { return `event: session\nid: ${this.session.lastSeq}\ndata: ${JSON.stringify({ type: "snapshot", session: v14(this.session as unknown as Record<string, unknown>) })}\n\n`; }
  /** One commit of the conversation: every open stream gets that commit's frame and not the conversation (`version` and `lastSeq` are the frame's). */
  publishCommit(frame: Json): void { this.session.version = Number(frame.version); this.session.lastSeq = Number(frame.lastSeq); for (const client of this.clients) client.write(`event: session\nid: ${frame.lastSeq}\ndata: ${JSON.stringify(frame)}\n\n`); }
  /** The conversation changed: every open stream gets the new view of it, one fact further on. */
  publish(): void { this.session.version += 1; this.session.lastSeq += 1; for (const client of this.clients) client.write(this.frame()); }
  private json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); }
  private missing(response: ServerResponse): void { this.json(response, 404, { code: "NOT_FOUND", message: "Not found" }); }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1"), path = url.pathname, method = request.method ?? "GET";
    if (!path.startsWith("/api/v1/")) {
      const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
      if (file !== dist.replace(/\/$/u, "") && !file.startsWith(dist.replace(/\/$/u, "") + sep)) return this.missing(response);
      try { const bytes = await readFile(file); response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }); response.end(bytes); } catch { this.missing(response); }
      return;
    }
    const api = path.slice("/api/v1".length);
    if (api === "/auth/session") return this.json(response, 200, { csrfToken: CSRF });
    if (api === "/state") return this.json(response, 200, { relay: true, providerManagement: false, workspace: this.session.workspace, providers: [], harnesses: [harnessView("claude", "Claude Code"), harnessView("codex", "Codex"), harnessView("dsh", "DeepSeek Harness")],
      harnessesScannedAt: new Date().toISOString(), sessions: [{ id: this.session.id, title: String(this.session.messages[0]?.text ?? "新对话"), status: "open", workspace: this.session.workspace, selection: this.session.selection, updatedSeq: this.session.lastSeq, activeRunId: this.session.activeRunId }],
      jobs: [], readiness: [], installationPolicy: "official" });
    if (api === "/harnesses/readiness") return this.json(response, 200, { readiness: [] });
    if (api === "/attention/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      this.others.add(response); response.on("close", () => this.others.delete(response)); response.write("event: attention\nid: 1\ndata: " + JSON.stringify({ revision: 1, items: [] }) + "\n\n"); return;
    }
    if (/^\/harnesses\/[^/]+\/models$/u.test(api)) return this.json(response, 200, { models: [{ id: "model-a", name: "Model A" }], defaultModel: "model-a", authentication: "ready", canSelect: true, commands: [] });
    if (api === "/discovery/login-shell") return this.json(response, 200, { available: false, dirs: [], readAt: null });
    if (api === "/relay/prefs") return this.json(response, 200, { prefs: { "relay.attach": "auto" } });
    const stored = /^\/content\/([^/]+)$/u.exec(api);
    if (stored !== null && method === "GET") return CONTENT[stored[1]!] === undefined ? this.missing(response) : this.json(response, 200, CONTENT[stored[1]!]);
    const match = /^\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(api);
    if (match === null || match[1] !== this.session.id) return this.missing(response);
    const action = match[2] ?? "";
    if (action === "" && method === "GET") { this.reads++; return this.json(response, 200, v14(this.session as unknown as Record<string, unknown>)); }
    const before = /^turns$/u.test(action) ? url.searchParams.get("before") : null;
    if (before !== null && method === "GET") return this.json(response, 200, turnsBefore(this.session as unknown as Record<string, unknown>, before, Number(url.searchParams.get("limit") ?? 20)));
    const range = /^runs\/(\d+)\/items\/(\d+)\/text$/u.exec(action);
    if (range !== null && method === "GET") { const found = textRange(this.session as unknown as Record<string, unknown>, Number(range[1]), Number(range[2]), Number(url.searchParams.get("from") ?? 0), Number(url.searchParams.get("to") ?? 0)); return found === null ? this.missing(response) : this.json(response, 200, found); }
    if (action === "events/stream") {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
      this.streams++; this.clients.add(response); response.on("close", () => this.clients.delete(response)); response.write(this.frame()); return;
    }
    if (action === "relay" && method === "GET") return this.json(response, 200, { handedOver: ["codex"], bindings: [], packets: [] });
    if (action === "relay/" + PACKET && method === "GET") { response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ETag: `"${"a1b2c3d4".repeat(8)}"`, "Cache-Control": "no-store" }); response.end(PACKET_TEXT); return; }
    this.missing(response);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------------------------------

let browser: Browser | null = null;
before(async () => { browser = await chromium.launch({ headless: true }); await mkdir(artifact, { recursive: true }); });
after(async () => { await browser?.close(); });

interface Opened { readonly gateway: FakeGateway; readonly context: BrowserContext; readonly page: Page; readonly errors: string[]; readonly log: Locator }
async function open(t: test.TestContext, session: FakeSession, viewport = { width: 1280, height: 1000 }): Promise<Opened> {
  assert.ok(browser, "the browser did not start");
  const gateway = new FakeGateway(session);
  await gateway.start();
  t.after(() => gateway.close());
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(gateway.url);
  const log = page.getByRole("log", { name: "对话历史" });
  await expect(log).toBeVisible();
  return { gateway, context, page, errors, log };
}
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `${name}-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The conversation of the first tests: one Turn with its text between its actions, one after a hand-over, one that did not go well. */
function mixed(): FakeSession {
  sequence = 0;
  const first = run({ n: 1, harness: "claude", input: "把失败的测试修好，别改测试的预期值", status: "completed", durationMs: 65_400, stopReason: "end_turn",
    usage: { completeness: "complete", input: 4, output: 1248, cost: { amount: 0.8727869, currency: "USD", scope: "conversation" } },
    items: [user(1), item("reasoning", { text: "折扣和税的先后顺序可能反了。", durationMs: 3000 }), read("/work/shop/src/cart.js"), item("notice", { severity: "info", text: "先看一眼购物车的实现，再跑测试" }),
      cmd("npm test", { exitCode: 1, detail: ref("content-npmtest") }, "failed"), edit("/work/shop/src/cart.js", 2, 2, { detail: ref("content-cartdiff"), nativeName: "apply_patch" }), cmd("npm test", { exitCode: 0 }), reply(1)] });
  const second = run({ n: 2, harness: "codex", input: "Codex，刚才改了什么？", status: "completed", model: "GPT-6.1", durationMs: 31_000, stopReason: "end_turn",
    usage: { completeness: "complete", input: 41_000, output: 1_100 },
    items: [item("switch", { from: HARNESS.claude, to: { ...HARNESS.codex, model: { id: "GPT-6.1", label: "GPT-6.1" } }, context: "full", turns: 1, session: "new", delivery: "confirmed", packetId: PACKET }), user(2),
      ...Array.from({ length: 7 }, () => read(null)), ...Array.from({ length: 6 }, () => cmd("rg taxFor")), item("hologram", { whatever: 1 }), item("notice", { severity: "warning", text: "上下文接近上限" }), reply(2)] });
  const third = run({ n: 3, harness: "dsh", input: "接着做", status: "failed", stopReason: "refusal", durationMs: 4_000, usage: { completeness: "unavailable" }, items: [user(3)] });
  return conversation([first, second, third], { 1: "修好了。total 现在先减折扣再算税。", 2: "只改了 src/cart.js 的 total。", });
}

test("a Turn is drawn from its items in the order they came: a thought, an action, a notice that ends the run, a run of actions, the answer", async t => {
  const { page, errors, log } = await open(t, mixed());
  // The protocol path draws no process line, no header with the Harness's name over the Turn, and no timing of the first output.
  await expect(log.locator(".process-summary")).toHaveCount(0);
  await expect(log).not.toContainText("首字"); await expect(log).not.toContainText("其他工具");
  const first = log.locator("article.assistant-message").nth(0);
  await expect(first).toHaveAttribute("data-run-status", "completed");
  // In the order they came: the thought, the one read, the notice, the run (folded, with its three lines inside), the answer.
  const order = await first.locator(".reasoning-row, .action-row, .native-notice, .action-group, .markdown").evaluateAll(nodes => nodes.map(node => node.className.split(" ")[0]));
  assert.deepEqual(order, ["reasoning-row", "action-row", "native-notice", "action-group", "markdown"], "the run with a failure in it is folded: its lines are not in the page until it is opened");
  await first.locator(".action-group").getByRole("button").first().click();
  const opened = await first.locator(".reasoning-row, .action-row, .native-notice, .action-group, .markdown").evaluateAll(nodes => nodes.map(node => node.className.split(" ")[0]));
  assert.deepEqual(opened, ["reasoning-row", "action-row", "native-notice", "action-group", "action-row", "action-row", "action-row", "markdown"]);
  await expect(first.locator(".reasoning-row")).toContainText("思考了 3 秒");
  await expect(first.locator(".action-row").first()).toHaveText("读取了 cart.js");
  await expect(first.locator(".native-notice")).toContainText("先看一眼购物车的实现");
  await expect(first.locator(".markdown").last()).toContainText("修好了");
  await shoot(page, "turns");
  assert.deepEqual(errors, []);
});

test("a thought is one line that opens to what was thought", async t => {
  const { log, errors } = await open(t, mixed());
  const first = log.locator("article.assistant-message").nth(0);
  const thought = first.getByRole("button", { name: /^思考了 3 秒/u });
  await expect(thought).toHaveAttribute("aria-expanded", "false");
  await expect(first.getByText("折扣和税的先后顺序可能反了。")).toHaveCount(0);
  await thought.click();
  await expect(thought).toHaveAttribute("aria-expanded", "true");
  await expect(first.getByText("折扣和税的先后顺序可能反了。")).toBeVisible();
  await thought.click();
  await expect(thought).toHaveAttribute("aria-expanded", "false");
  assert.deepEqual(errors, []);
});

test("a run with something that failed is folded like any other, says what failed after the words it belongs to, and each line opens its input, output or diff", async t => {
  const { log, errors } = await open(t, mixed());
  const first = log.locator("article.assistant-message").nth(0), group = first.locator(".action-group");
  // Two commands and one edit of one file: counted, with the failure after the words it belongs to; folded, as Claude's desktop app folds it.
  const header = group.getByRole("button", { name: "运行了 2 条命令（1 个失败），修改了 cart.js", exact: true });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(group).toHaveAttribute("data-problems", "1");
  await header.click(); await expect(header).toHaveAttribute("aria-expanded", "true");
  const lines = group.locator(".action-row");
  await expect(lines).toHaveText(["运行失败 npm test 退出码 1", "修改了 cart.js +2 −2", "运行了 npm test"]);
  // The program's own name for an action is not in its line; it is a small line in what the line opens to.
  await expect(lines.nth(1)).not.toContainText("apply_patch");
  const failed = lines.nth(0).getByRole("button");
  await failed.click();
  const detail = group.locator(".native-tool-detail").first();
  await expect(detail).toContainText("# pass 7"); await expect(detail).toContainText("npm test");
  await lines.nth(1).getByRole("button").click();
  const diff = group.locator(".native-tool-detail").nth(1);
  await expect(diff).toContainText("apply_patch"); await expect(diff.locator(".diff-line.is-add")).toHaveCount(1); await expect(diff.locator(".diff-line.is-remove")).toHaveCount(1);
  // A group can be folded by hand, and opened again.
  await header.click(); await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click(); await expect(header).toHaveAttribute("aria-expanded", "true");
  assert.deepEqual(errors, []);
});

test("the hand-over is one line, from → to and what it was given, with a link to the packet; the next Turn's actions are one folded line", async t => {
  const { page, log, errors } = await open(t, mixed());
  const line = log.getByRole("separator", { name: "Claude Code → Codex · 带上了之前的全部 1 轮" });
  await expect(line).toBeVisible();
  await expect(line.locator("xpath=..")).toHaveAttribute("data-delivery", "confirmed");
  // One word of the link, and no way back from here (the picker does that); the packet opens as it was sent.
  const view = log.getByRole("button", { name: "查看交接单", exact: true });
  await expect(view).toHaveText("查看");
  await expect(log.getByRole("button", { name: "改回" })).toHaveCount(0);
  await expect(log.getByRole("button", { name: /^附交接单/u })).toHaveCount(0);
  await view.click();
  const dialog = page.getByRole("dialog", { name: "交接单" });
  await expect(dialog.locator(".relay-packet-text")).toContainText("下面是 Claude Code 交给你的对话要点。");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  // Seven reads whose paths nobody gave and six commands: one folded line, counted, with each line one click away.
  const second = log.locator("article.assistant-message").nth(1), group = second.locator(".action-group");
  const header = group.getByRole("button", { name: "运行了 6 条命令，读取了 7 个文件", exact: true });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(group.locator(".action-row").first()).not.toBeVisible();
  await header.click();
  await expect(group.locator(".action-row")).toHaveCount(13);
  await expect(group.locator(".action-row").nth(0)).toHaveText("读取了一个文件");
  await expect(group.locator(".action-row").nth(12)).toHaveText("运行了 rg taxFor");
  await shoot(page, "handover-and-group");
  assert.deepEqual(errors, []);
});

test("what the page does not know is kept as a line that says so, and a notice is one line of its own", async t => {
  const { log, errors } = await open(t, mixed());
  const second = log.locator("article.assistant-message").nth(1);
  await expect(second.locator(".quiet-line[data-item=unrecognized]")).toHaveText("未识别的条目（hologram）");
  await expect(second.locator(".native-notice")).toContainText("上下文接近上限");
  assert.deepEqual(errors, []);
});

test("every Turn ends with the same footer, and says why it ended when that was not the ordinary end", async t => {
  const { page, log, errors } = await open(t, mixed());
  const footers = log.locator(".turn-footer");
  await expect(footers).toHaveText([
    "Claude Code · 用时 1 分 05 秒 · 输入 4 · 输出 1.2k · 对话累计 US$0.87",
    "Codex · GPT-6.1 · 用时 31 秒 · 输入 41.0k · 输出 1.1k",
    "DeepSeek Harness · 用时 4.0 秒",
  ]);
  // Not the ordinary end: the state's word, then the table's sentence, on the failed Turn only.
  const third = log.locator("article.assistant-message").nth(2);
  await expect(third.locator(".quiet-line[data-item=end]")).toHaveText("失败 · 模型拒绝了这个请求");
  await expect(log.locator(".quiet-line[data-item=end]")).toHaveCount(1);
  // The way forward from a failure stays in sight.
  await expect(third.getByRole("button", { name: "重试回复" })).toBeVisible();
  await shoot(page, "footers");
  assert.deepEqual(errors, []);
});

test("a Turn that goes on shows its open run and the action in progress, folds the run once words follow it, and ends with its footer", async t => {
  sequence = 0;
  // The items keep their ids from one view of the Turn to the next, as the Gateway's do: each is the same line as it grows.
  const named = (id: string, row: Json): Json => ({ ...row, id });
  const items = (stage: "acting" | "replying" | "done"): Json[] => {
    const counted = [named("u", user(1)), named("t", item("reasoning", { text: "先跑一遍测试。", durationMs: 2000 })), named("c1", cmd("git status --short")), named("c2", cmd("npm test", {}, stage === "acting" ? "running" : "completed"))];
    return stage === "acting" ? counted : [...counted, named("r", reply(1, stage === "done" ? "completed" : "running"))];
  };
  const session = conversation([run({ n: 1, harness: "codex", input: "修好测试", status: "running", model: "GPT-6.1", items: items("acting"), usage: { completeness: "unavailable" } })], {}, "run-1");
  const { gateway, page, log, errors } = await open(t, session);
  const turn = log.locator("article.assistant-message").nth(0);
  // In progress: the run is open and its last line turns, and the live line at the tail says what the Turn is doing.
  const group = turn.locator(".action-group");
  await expect(group.getByRole("button", { name: "运行了 2 条命令", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(".action-row")).toHaveText(["运行了 git status --short", "正在运行 npm test"]);
  await expect(turn.locator(".live-line .response-status")).toHaveText("正在运行 npm test");
  await expect(turn).toHaveAttribute("aria-busy", "true");
  await expect(turn.locator(".turn-footer")).toHaveText("Codex · GPT-6.1");
  await shoot(page, "going-on");
  // The action ends and the Harness starts to answer: nothing can join the run any more, so it folds.
  const runs = gateway.session.runs as Json[], messages = gateway.session.messages;
  const change = (stage: "replying" | "done", status: string) => { runs[0]!.status = status; (runs[0]!.protocol as Json).status = status; (runs[0]!.protocol as Json).items = items(stage); messages.forEach(row => { row.status = status; }); };
  change("replying", "running");
  messages.push(message(1, "assistant", "测试跑完了，三个失败。", "running", 99));
  gateway.session.lastSeq = 99; gateway.session.version = 98; gateway.publish();
  await expect(group.getByRole("button", { name: "运行了 2 条命令", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(turn.locator(".markdown")).toContainText("测试跑完了");
  await expect(turn.locator(".live-line .response-status")).toHaveText("正在回复");
  // Over: the footer carries its time and the Turn is no longer busy.
  change("done", "completed");
  (runs[0]!.protocol as Json).durationMs = 12_000; (runs[0]!.protocol as Json).stopReason = "end_turn"; (runs[0]!.timing as Json).endedAt = NOW; gateway.session.activeRunId = null;
  gateway.publish();
  await expect(turn).toHaveAttribute("aria-busy", "false");
  await expect(turn.locator(".live-line")).toHaveCount(0);
  await expect(turn.locator(".turn-footer")).toHaveText("Codex · GPT-6.1 · 用时 12 秒");
  assert.deepEqual(errors, []);
});

test("a Turn that has shown nothing yet says what it waits for, and an action never ended in a Turn that is over is not shown as done", async t => {
  sequence = 0;
  const over = run({ n: 1, harness: "codex", input: "后来的", status: "completed", durationMs: 5000, stopReason: "end_turn", items: [user(1), cmd("make", {}, "running"), cmd("make test", {}, "pending"), reply(1)] });
  const starting = run({ n: 2, harness: "claude", input: "先排着", status: "preparing", items: [user(2)] });
  const { page, log, errors } = await open(t, conversation([over, starting], { 1: "好了" }, "run-2"));
  // An action the Turn never reported ended is unknown once the Turn is over: neither done nor in progress, and its run's line counts it.
  const first = log.locator("article.assistant-message").nth(0), header = first.getByRole("button", { name: "运行了 2 条命令（2 个结果未知）", exact: true });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(first.locator(".action-row")).toHaveText(["运行 make 结果未知", "运行 make test 结果未知"]);
  await expect(first.locator(".action-group")).toHaveAttribute("data-problems", "2");
  // Nothing in the other Turn shows work yet: a line says it is being started.
  const waiting = log.locator("article.assistant-message").nth(1);
  await expect(waiting.locator(".live-line")).toContainText("正在启动 Claude Code");
  await expect(waiting.locator(".turn-footer")).toHaveText("Claude Code");
  await shoot(page, "waiting-and-unknown");
  assert.deepEqual(errors, []);
});

test("a Run whose protocol Turn the page cannot read says so with the reason beside your message, and is drawn from nothing else", async t => {
  sequence = 0;
  const newer = run({ n: 1, harness: "codex", input: "版本不认识的", status: "completed", durationMs: 1000, items: [user(1), reply(1)] });
  (newer.protocol as Json).version = "hh/9";
  // The facts a Run used to carry are still there, and are not read: nothing is drawn from them.
  Object.assign(newer, { tools: [{ id: "tool-1", title: "ls", kind: "execute", status: "completed" }], thinking: "旧的思考" });
  const none = run({ n: 2, harness: "codex", input: "没有协议的", status: "completed", durationMs: 1000, items: [user(2), reply(2)] });
  delete none.protocol;
  // A Turn whose header is not one at all (a Gateway that sends what it likes): the Run stays, with the reason.
  const broken = run({ n: 3, harness: "claude", input: "条目坏了的", status: "completed", durationMs: 1000, items: [user(3), reply(3)] });
  (broken.protocol as Json).executor = null;
  const good = run({ n: 4, harness: "codex", input: "好好的一轮", status: "completed", durationMs: 2000, stopReason: "end_turn", items: [user(4), reply(4)] });
  const { page, log, errors } = await open(t, conversation([newer, none, broken, good], { 1: "第一轮的话", 2: "第二轮的话", 3: "第三轮的话", 4: "第四轮的话" }));
  const lines = log.locator(".unreadable-turn .quiet-line");
  await expect(lines).toHaveText(["这一轮无法显示：协议版本 hh/9，这个页面只认 hh/1", "这一轮无法显示：服务没有给出这一轮的协议数据", /^这一轮无法显示：这一轮的协议数据读不出来：/u]);
  // Your message stays where it was, and so do the reply's own words, which are a message of the conversation; the rest of the Turn is not drawn.
  await expect(log.locator(".user-message")).toHaveText(["你：版本不认识的", "你：没有协议的", "你：条目坏了的", "你：好好的一轮"]);
  await expect(log).toContainText("第一轮的话"); await expect(log).toContainText("第三轮的话");
  await expect(log.locator(".unreadable-turn .turn-footer, .unreadable-turn .process-summary, .unreadable-turn .action-row")).toHaveCount(0);
  await expect(log.locator(".turn-footer")).toHaveCount(1);
  // The Turn that can be read next to them is drawn as ever, and the line under the box belongs to it.
  await expect(log.locator("article.assistant-message").last().locator(".turn-footer")).toHaveText("Codex · 用时 2.0 秒");
  await expect(page.locator(".composer-status")).toContainText("第 4 轮");
  await shoot(page, "unreadable");
  assert.deepEqual(errors, []);
});

test("on a phone the lines wrap inside the column and nothing makes the page wider", async t => {
  const { page, log, errors } = await open(t, mixed(), { width: 390, height: 900 });
  await expect(log.getByRole("separator", { name: /Claude Code → Codex/u })).toBeVisible();
  await log.locator("article.assistant-message").nth(1).getByRole("button", { name: "运行了 6 条命令，读取了 7 个文件" }).click();
  const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, log: (document.querySelector("[role=log]") as HTMLElement).scrollWidth - (document.querySelector("[role=log]") as HTMLElement).clientWidth }));
  assert.deepEqual(overflow, { page: 0, log: 0 });
  await shoot(page, "phone");
  assert.deepEqual(errors, []);
});

test("the other items each have a line of their own: a clear, a decision, an answer, a proposal, a recap, work handed over, an artifact, a stop", async t => {
  sequence = 0;
  const options = [{ id: "allow", role: "allow_once", label: "Allow" }];
  const stopped = run({ n: 1, harness: "claude", input: "做点事", status: "cancelled", stopReason: "user_stopped", durationMs: 9_000, usage: { completeness: "unavailable" }, items: [
    user(1), item("context_event", { kind: "compaction" }),
    item("approval", { subject: "command", title: "运行 npm test", options, decision: { role: "allow_once", by: "user", at: NOW } }),
    item("question", { title: "用哪个库？", answer: "dayjs" }), item("plan_proposal", { markdown: "先改 total，再补测试。" }),
    item("recap", { summary: "改了 total，还没有提交。", ask: "接着修剩下的吗？", actions: ["接着修"] }),
    item("delegation", { to: HARNESS.codex, task: "补测试" }), item("artifact", { kind: "link", name: "测试报告", uri: "https://example.com/report" }),
    item("interrupt", { by: "user" }), reply(1)] });
  const { page, log, errors } = await open(t, conversation([stopped], { 1: "停在这里了。" }));
  const turn = log.locator("article.assistant-message").nth(0);
  await expect(turn.locator(".quiet-line[data-item=context_event]")).toHaveText("上下文已压缩");
  await expect(turn.locator(".quiet-line[data-item=approval]")).toHaveText("已允许：运行 npm test");
  await expect(turn.locator(".quiet-line[data-item=question]")).toHaveText("已回答：用哪个库？（dayjs）");
  await expect(turn.locator(".plan-proposal")).toContainText("先改 total，再补测试。");
  // The wrap-up is one line of its Turn (the question and the answers are the next-step box's, above the message box).
  await expect(turn.locator(".recap-line")).toHaveText("小结：改了 total，还没有提交。");
  await expect(turn.locator(".quiet-line[data-item=delegation]")).toHaveText("已交给 Codex：补测试");
  await expect(turn.getByRole("link", { name: "测试报告" })).toHaveAttribute("href", "https://example.com/report");
  // The stop is said once, by its own item; the line that ends a Turn does not say it again.
  await expect(turn.locator(".quiet-line[data-item=interrupt]")).toHaveText("你停止了这一轮");
  await expect(turn.locator(".quiet-line[data-item=end]")).toHaveCount(0);
  await expect(turn.locator(".turn-footer")).toHaveText("Claude Code · 用时 9.0 秒");
  await shoot(page, "other-items");
  assert.deepEqual(errors, []);
});

test("the next-step box: its first answer goes with ⌘⏎ when the message box is empty, and with the Harness unavailable its answers say why they wait", async t => {
  sequence = 0;
  const done = run({ n: 1, harness: "codex", input: "修一下 total", status: "completed", durationMs: 2_000, items: [user(1), item("recap", { summary: "改了 total，还没有提交。", ask: "接着修剩下的吗？", actions: ["接着修", "先不用"] }), reply(1)] });
  const withRecap = () => ({ ...conversation([done], { 1: "改好了。" }), recap: { runId: "run-1", ordinal: 0, harnessId: "codex", summary: "改了 total，还没有提交。", ask: "接着修剩下的吗？", actions: ["接着修", "先不用"] } }) as unknown as FakeSession;
  const { page, errors } = await open(t, withRecap());
  const box = page.locator(".next-step"), composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await expect(box).toContainText("接着修剩下的吗？");
  await expect(box.getByRole("button", { name: "接着修" })).toBeEnabled(); await expect(box.locator(".next-step-blocked")).toHaveCount(0);
  const sent: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/messages$/u.test(request.url())) sent.push(String(JSON.parse(request.postData() ?? "{}").text)); });
  // Words in the box: ⌘⏎ is the box's own, and sends them.
  await composer.fill("我自己写"); await composer.press("Meta+Enter");
  await expect.poll(() => sent).toEqual(["我自己写"]);
  // Once that send is over (refused here), the answers can be sent again.
  await expect(box.getByRole("button", { name: "接着修" })).toBeEnabled();
  await composer.fill(""); await composer.press("Meta+Enter");
  await expect.poll(() => sent).toEqual(["我自己写", "接着修"]);
  // The fake Gateway refuses the messages; that is all the errors there are.
  assert.ok(errors.every(error => /404|Not found/iu.test(error)), errors.join("\n"));
  unavailableControl = "codex-native";
  try {
    const blocked = await open(t, withRecap()), waiting = blocked.page.locator(".next-step");
    await expect(waiting.getByRole("button", { name: "接着修" })).toBeDisabled(); await expect(waiting.getByRole("button", { name: "先不用" })).toBeDisabled();
    await expect(waiting.locator(".next-step-blocked")).toHaveText("这个控制入口目前不可用，请在 Harness 页中检查。");
    await expect(waiting.getByRole("button", { name: "接着修" })).toHaveAccessibleDescription("这个控制入口目前不可用，请在 Harness 页中检查。");
    await shoot(blocked.page, "next-step-blocked");
  } finally { unavailableControl = null; }
});

test("a task list of more than twelve steps folds its middle and opens it all on request", async t => {
  sequence = 0;
  const steps = Array.from({ length: 16 }, (_, index) => ({ text: "步骤 " + (index + 1), status: index < 8 ? "completed" : index === 8 ? "in_progress" : "pending" }));
  const working = run({ n: 1, harness: "claude", input: "做一件大事", status: "running", items: [user(1), item("plan", { steps })] });
  const { page, errors } = await open(t, conversation([working], {}, "run-1"));
  const bar = page.locator(".plan-bar"), toggle = bar.getByRole("button").first();
  await expect(toggle).toContainText("8/16 · 正在：步骤 9");
  await toggle.click();
  const list = bar.getByRole("list", { name: "Claude Code 的任务清单" });
  await expect(list.getByRole("listitem")).toHaveText(["步骤 1", "步骤 2", "还有 4 步，展开", "步骤 7", "步骤 8", "步骤 9", "步骤 10", "步骤 11", "还有 3 步，展开", "步骤 15", "步骤 16"]);
  await list.getByRole("button", { name: "还有 4 步，展开" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(16);
  assert.deepEqual(errors, []);
});

test("what happens inside a delegated task hangs under the task and opens with it", async t => {
  sequence = 0;
  const task = item("subagent", { title: "找出所有用到税率的地方" }), inside = [read("/w/src/tax.js"), cmd("rg taxFor")].map(row => ({ ...row, parentId: task.id }));
  const first = run({ n: 1, harness: "claude", input: "查一下税率", status: "completed", durationMs: 8_000, stopReason: "end_turn", items: [user(1), task, ...inside, reply(1)] });
  const { log, errors } = await open(t, conversation([first], { 1: "税率都在 tax.js。" }));
  const turn = log.locator("article.assistant-message").nth(0);
  // One line for the task; what it did is not drawn beside it, and it is not counted among the Turn's own actions.
  await expect(turn.locator(".action-group")).toHaveCount(0);
  await expect(turn.locator(".action-row")).toHaveText(["运行了子任务“找出所有用到税率的地方”"]);
  await turn.getByRole("button", { name: /运行了子任务/u }).click();
  // Inside, the task's actions are laid out as a Turn's are: two in a row are one folded line, which opens to its lines.
  const nested = turn.getByRole("group", { name: /子任务里的动作/u });
  await nested.getByRole("button", { name: "运行了 1 条命令，读取了 tax.js", exact: true }).click();
  await expect(nested.locator(".action-row")).toHaveText(["读取了 tax.js", "运行了 rg taxFor"]);
  assert.deepEqual(errors, []);
});

test("the page follows a Turn by the commit frames it is sent: words added at the offset it holds are shown without the conversation being read, and a frame that does not follow what it holds makes it read the conversation again", async t => {
  sequence = 0;
  const answered = reply(1, "running");
  const session = conversation([run({ n: 1, harness: "codex", input: "修好测试", status: "running", items: [user(1), answered], usage: { completeness: "unavailable" } })], { 1: "测试跑完了" }, "run-1");
  const { gateway, log, errors } = await open(t, session);
  const turn = log.locator("article.assistant-message").nth(0);
  await expect(turn.locator(".markdown")).toContainText("测试跑完了");
  assert.deepEqual([gateway.streams, gateway.reads], [1, 0], "the conversation came with the stream, as its first frame");
  // A commit that appended words at the end of what the page holds: shown, and the page asked for nothing.
  const reply1 = session.messages.find(row => row.role === "assistant")!, frame = (add: number, from: number, text: string): Json => ({ type: "commit", sessionId: SESSION, version: session.version + add, lastSeq: session.lastSeq + add,
    texts: [{ runId: "run-1", itemSeq: answered.seq, from, text }] });
  const first = frame(1, Buffer.byteLength("测试跑完了"), "，三个失败。");
  reply1.text = "测试跑完了，三个失败。"; gateway.publishCommit(first);
  await expect(turn.locator(".markdown")).toContainText("测试跑完了，三个失败。");
  gateway.publishCommit(frame(1, Buffer.byteLength("测试跑完了，三个失败。"), "先看第一个。")); reply1.text = "测试跑完了，三个失败。先看第一个。";
  await expect(turn.locator(".markdown")).toContainText("测试跑完了，三个失败。先看第一个。");
  assert.deepEqual([gateway.streams, gateway.reads], [1, 0], "two commits were followed by their frames alone");
  // A frame whose offset is not the end of what the page holds: it missed a commit, and it does not guess; it connects again and is given the conversation as it is.
  reply1.text = "测试跑完了，三个失败。先看第一个。再补一句。";
  gateway.publishCommit(frame(1, 3, "错位的字"));
  await expect.poll(() => gateway.streams, { timeout: 15_000 }).toBe(2);
  await expect(turn.locator(".markdown")).toContainText("测试跑完了，三个失败。先看第一个。再补一句。");
  await expect(turn.locator(".markdown")).not.toContainText("错位的字");
  assert.deepEqual(errors, []);
});
