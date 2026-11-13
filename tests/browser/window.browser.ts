import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";
import { appStore } from "../fixtures/runtime-store.js";
import { makeConversation, seedReply, seedTurns, type Home } from "../fixtures/big-conversations.js";
import { Scenario } from "../fixtures/store-helpers.js";

/*
 * The page as a window on a conversation (ADR-057 3.4), in a real browser against a real Gateway on a data root of conversations written through the store: one of 2,000 Turns, one
 * whose reply is 20 MiB, and a hundred and thirty more for the list. The page holds the newest Turns; it reads the older ones when the reader goes up, the words of a long reply
 * when they are asked for, and follows the Gateway's commits one by one. Only the Harness is made up (it says, runs a command, reads a file and sums up).
 */

const peer = fileURLToPath(new URL("../../../tests/fixtures/session-peer.mjs", import.meta.url));
const selection = { harnessId: "win-a", controlId: "win-a-control" };
const LISTED = 130;

interface Fixture { readonly root: string; readonly gateway: WebServer; readonly origin: string; readonly browser: Browser; readonly context: BrowserContext; readonly reply: Buffer; close(): Promise<void> }
let fixture: Fixture | undefined;

before(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-window-browser-"))), workspace = join(root, "workspace"), manifest = join(root, "catalog.json"), data = join(root, "data");
  await mkdir(workspace);
  const source = { repository: "fixture", revision: "window", upstreamId: "peer", url: "https://example.invalid/window-peer" };
  const definition = { id: selection.harnessId, name: "Win a", aliases: [], binaryNames: [], configHints: [], controls: [{ id: selection.controlId, protocol: "acp-v1", executableNames: ["fixture-peer"],
    args: [peer, "acp-v1", "a", "interleaved"], env: { FIXTURE_TRACE: join(root, "trace.ndjson") }, requiredExecutables: [], package: null, distribution: null, source }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [definition], overrides: { [selection.controlId]: { executable: process.execPath } } }));
  const configuration = await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), home: Home = { selection, configuration };
  // The list first, then the two big conversations: the list is newest first, so the first page holds the big ones and the rest of it is the next page.
  const store = appStore(data);
  let reply: Buffer;
  try {
    for (let n = 0; n < LISTED; n++) { const id = makeConversation(store, home, "listed" + String(n).padStart(3, "0")); new Scenario(store, id, "run-listed" + n, false).turn("listed " + String(n).padStart(3, "0"), "ok", { selection }); }
    seedTurns(store, home, "turns", 2000); reply = seedReply(store, home, "reply").reply;
  } finally { store.close(); }
  const gateway = await startWebServer({ installations: "any", root: data, configuration, port: 0, workspaceLockRoot: join(root, "locks"),
    application: (dataRoot, publish) => application(dataRoot, publish, { installations: "any", workspaceLockRoot: join(root, "locks") }) });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // The Gateway's launch address carries a token that signs one page in; the pages of the tests open the address without it.
  const first = await context.newPage();
  await first.goto(gateway.url); await expect(first.getByRole("button", { name: "新对话", exact: true })).toBeVisible(); await first.close();
  fixture = { root, gateway, origin: new URL(gateway.url).origin, browser, context, reply, close: async () => { try { await browser.close(); } finally { try { await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } } } };
});
after(async () => { await fixture?.close(); });

/** A page of the signed-in context, with the network it makes and what goes wrong in it recorded. */
interface Watched { readonly page: Page; readonly requests: string[]; readonly errors: string[] }
async function watched(): Promise<Watched> {
  const f = fixture!, page = await f.context.newPage(), requests: string[] = [], errors: string[] = [];
  await page.addInitScript(() => {
    const tasks: number[] = []; Reflect.set(window, "__longTasks", tasks);
    try { new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration); }).observe({ type: "longtask", buffered: true }); } catch { /* a browser without long task entries */ }
    // The Gateway's stream can be held (the commits it brings are not delivered) and dropped (the connection fails), as a network does.
    const original = window.fetch.bind(window); let held = false, drop: (() => void)[] = []; const waiters: (() => void)[] = [];
    Reflect.set(window, "__hold", (next: boolean) => { held = next; if (!held) for (const release of waiters.splice(0)) release(); });
    Reflect.set(window, "__drop", () => { for (const fail of drop.splice(0)) fail(); });
    window.fetch = async (input, init) => {
      const response = await original(input, init), url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!url.includes("/events/stream") || !response.ok || response.body === null) return response;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        start(controller) { drop.push(() => controller.error(new TypeError("the connection was dropped"))); },
        async transform(chunk, sink) { if (held) await new Promise<void>(resolve => waiters.push(resolve)); sink.enqueue(chunk); } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) requests.push(request.method() + " " + url.pathname + url.search); });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("the connection was dropped") && !message.text().includes("Failed to load resource")) errors.push(message.text()); });
  await page.goto(f.origin); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  return { page, requests, errors };
}
const longestTask = (page: Page): Promise<number> => page.evaluate(() => Math.max(0, ...(Reflect.get(window, "__longTasks") as number[])));
const openFrom = async (w: Watched, title: RegExp | string): Promise<void> => {
  await w.page.getByRole("navigation", { name: "对话列表" }).getByRole("button", { name: title }).first().click();
  await expect(w.page.getByRole("log", { name: "对话历史" })).toBeVisible();
};
const scroller = (page: Page) => page.locator(".chat-scroll");
const userMessages = (page: Page) => page.getByRole("log", { name: "对话历史" }).locator("article.user-message");
const heldTurns = (page: Page): Promise<string[]> => userMessages(page).allInnerTexts().then(texts => texts.map(text => text.replace(/^你：\s*/u, "").trim()));

test("a conversation of 2,000 Turns opens as its newest ten, the older ones are read when the reader goes up and the place on the screen stays, and a Turn sent from there is told in order", { timeout: 180_000 }, async t => {
  const w = await watched();
  t.after(() => w.page.close());
  await openFrom(w, /question 0/u);
  await expect(userMessages(w.page).last()).toContainText("question 1999");
  // The first screen is the window: ten Turns held, no older Turn asked for.
  assert.deepEqual(await heldTurns(w.page), Array.from({ length: 10 }, (_, index) => "question " + (1990 + index)));
  const reads = (pattern: RegExp): string[] => w.requests.filter(request => pattern.test(request));
  // The conversation comes with its stream: the first frame of the connection is the window (a snapshot), so no other read of it is made.
  assert.equal(reads(/^GET \/api\/v1\/sessions\/session-turns\/events\/stream/u).length, 1, "the conversation was opened by one connection: " + w.requests.join(" | "));
  assert.deepEqual(reads(/^GET \/api\/v1\/sessions\/session-turns$/u), [], "and not read besides");
  assert.deepEqual(reads(/\/turns\?/u), [], "no older Turn is asked for before the reader goes up");
  // Going up reads the page before the oldest Turn held, and the Turn the reader was looking at stays where it was on the screen. The page is held back until the place is taken.
  const anchor = userMessages(w.page).filter({ hasText: "question 1990" }), offset = (): Promise<number> => anchor.evaluate(element => element.getBoundingClientRect().top - (document.querySelector(".chat-scroll") as HTMLElement).getBoundingClientRect().top);
  let asked = false, release: () => void = () => undefined;
  const gate = new Promise<void>(done => { release = done; });
  await w.page.route(/\/turns\?before=/u, async route => { asked = true; await gate; await route.continue(); });
  await scroller(w.page).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => asked, { timeout: 15_000 }).toBe(true);
  const placed = await offset();
  release();
  await expect.poll(async () => (await heldTurns(w.page)).length, { timeout: 15_000 }).toBe(30);
  assert.equal(reads(/\/turns\?before=/u).length, 1, "one page of older Turns was asked for: " + reads(/\/turns\?/u).join(" | "));
  assert.deepEqual((await heldTurns(w.page)).slice(0, 2), ["question 1970", "question 1971"]);
  await expect.poll(async () => Math.abs((await offset()) - placed), { timeout: 5_000 }).toBeLessThan(2);
  // Once more: the page before that one.
  await scroller(w.page).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => (await heldTurns(w.page)).length, { timeout: 15_000 }).toBe(50);
  assert.deepEqual((await heldTurns(w.page)).slice(0, 2), ["question 1950", "question 1951"]);
  assert.equal(new Set(await heldTurns(w.page)).size, 50, "no Turn is held twice");
  // A Turn sent from up there: it is the newest Turn, it comes after the ones held, and its work is told in the order it happened.
  const composer = w.page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("还有一个问题"); await composer.press("Enter");
  await expect(userMessages(w.page).last()).toContainText("还有一个问题", { timeout: 20_000 });
  const turn = w.page.getByRole("log", { name: "对话历史" }).locator("article.protocol-turn").last();
  // The history is longer than a hand-over holds, so the Turn says the task's state before the words (2026-11-13): this Harness gives back all it was given.
  await expect(turn).toContainText(/总结：[\s\S]*还有一个问题/u, { timeout: 20_000 });
  await expect(turn).toContainText("带上了任务现在的状态");
  assert.equal((await heldTurns(w.page)).length, 51, "the older Turns already read are still held, and the new one with them");
  // The Turn ended well: what it did before its summary is one line (2026-11-14), which opens to it in the order it happened — what was said, then the work —
  // and the summary stands under the line.
  const fold = turn.locator(".turn-fold > button");
  await expect(fold).toHaveText("运行了 1 条命令，读取了 README.md"); await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click(); await expect(turn.getByText("先看一下目录。")).toBeVisible();
  const said = await turn.innerText(), order = ["运行了 1 条命令，读取了 README.md", "先看一下目录。", "总结："].map(text => said.indexOf(text));
  assert.ok(order.every(at => at >= 0), "the Turn shows the line of its work, what was said and the summary: " + JSON.stringify(said.slice(0, 600)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the order they happened: " + order.join(","));
  // And the work, opened, is the command and then the file, between the two things said.
  await turn.getByRole("button", { name: /运行了 1 条命令/u }).click();
  await expect(turn).toContainText("ls -la");
  const opened = await turn.innerText(), steps = ["先看一下目录。", "ls -la", "总结："].map(text => opened.indexOf(text));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps, "opened, the command stands between the words: " + JSON.stringify(opened.slice(0, 800)));
  assert.ok(steps.every(at => at >= 0));
  assert.deepEqual(w.errors, []);
  assert.ok(await longestTask(w.page) < 1000, "no task of the page took a second");
});

test("a page whose connection fails shows the Turns it missed once it is back, and keeps the older Turns the reader had read", { timeout: 120_000 }, async t => {
  const w = await watched();
  t.after(() => w.page.close());
  await openFrom(w, /question 0/u);
  await scroller(w.page).evaluate(element => { element.scrollTop = 0; });
  await expect.poll(async () => (await heldTurns(w.page)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(30);
  const held = (await heldTurns(w.page)).length, streams = () => w.requests.filter(request => request.includes("/events/stream")).length, before = streams();
  // The commits stop arriving, a Turn is sent, and then the connection fails: the page has not been told of the Turn, and it asks again.
  await w.page.evaluate(() => (Reflect.get(window, "__hold") as (held: boolean) => void)(true));
  const composer = w.page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("断线时发的"); await composer.press("Enter");
  await w.page.waitForTimeout(1500);
  await expect(w.page.getByRole("log", { name: "对话历史" }).locator("article.protocol-turn").filter({ hasText: /总结：[\s\S]*断线时发的/u })).toHaveCount(0);
  await w.page.evaluate(() => (Reflect.get(window, "__drop") as () => void)());
  await w.page.evaluate(() => (Reflect.get(window, "__hold") as (held: boolean) => void)(false));
  await expect(w.page.getByRole("log", { name: "对话历史" }).locator("article.protocol-turn").filter({ hasText: /总结：[\s\S]*断线时发的/u })).toHaveCount(1, { timeout: 30_000 });
  assert.ok(streams() > before, "the page asked for the stream again");
  assert.equal((await heldTurns(w.page)).length, held + 1, "the Turns read before are held, and the Turn it missed with them");
  assert.deepEqual(w.errors, []);
});

test("a reply of 20 MiB opens without a long task, the words are asked for by range when they are asked to be shown, and the page holds what it was given", { timeout: 180_000 }, async t => {
  const w = await watched();
  t.after(() => w.page.close());
  await openFrom(w, /write a lot/u);
  const reply = w.page.getByRole("log", { name: "对话历史" }).locator("article.protocol-turn").last();
  const more = reply.getByRole("button", { name: /显示(这段回复|更多)/u });
  await expect(more).toBeVisible({ timeout: 20_000 });
  assert.deepEqual(w.requests.filter(request => request.includes("/text")), [], "no word of the reply is asked for until the reader asks");
  assert.ok(await longestTask(w.page) < 1000, "no task took a second to show a conversation with a reply of 20 MiB: " + await longestTask(w.page));
  const heldBefore = await w.page.evaluate(() => document.body.innerText.length);
  assert.ok(heldBefore < 200_000, "the page holds " + heldBefore + " characters of a reply of 20 MiB it was not asked to show");
  await more.click();
  await expect.poll(() => w.requests.filter(request => /\/text\?from=0/u.test(request)).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => w.page.evaluate(() => document.body.innerText.length), { timeout: 20_000 }).toBeGreaterThan(300_000);
  const shown = await w.page.evaluate(() => document.body.innerText.length);
  assert.ok(shown < 4 * 1024 * 1024, "one request shows about a MiB, not the reply: " + shown);
  assert.ok(await longestTask(w.page) < 1500, "no task took long to show it: " + await longestTask(w.page));
  assert.ok(fixture!.reply.length > 20 * 1024 * 1024 - 100 * 1024);
  assert.deepEqual(w.errors, []);
});

test("the list of conversations holds the first page and reads the next when the reader reaches its end, every conversation once", { timeout: 120_000 }, async t => {
  const w = await watched();
  t.after(() => w.page.close());
  const list = w.page.getByRole("navigation", { name: "对话列表" }), rows = list.locator(".session-item");
  await expect(rows.first()).toBeVisible();
  await expect.poll(() => rows.count()).toBe(100);
  assert.equal(w.requests.filter(request => /^GET \/api\/v1\/sessions\?(?:after|limit)/u.test(request)).length, 0, "the first page was the plain list");
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(LISTED + 2);
  assert.equal(w.requests.filter(request => /^GET \/api\/v1\/sessions\?after=/u.test(request)).length, 1, "one more page: " + w.requests.filter(request => request.includes("/sessions")).join(" | "));
  const titles = await rows.allInnerTexts();
  assert.equal(new Set(titles.map(title => title.trim())).size, titles.length, "no conversation is listed twice");
  assert.deepEqual(w.errors, []);
});
