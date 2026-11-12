import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { readThrough } from "../fixtures/http-conversation.js";
import { CLAUDE_REPLY, CODEX_REPLY, launch, prompts, sent } from "./relay-fixture.js";

/*
 * The message box keeps what is typed in it (2026-11-12): what the box shows is what will be sent, whatever the page does around it. The real Gateway with its real store, Runtime and
 * Drivers, the real built page in a real browser; only the two Harnesses' own programs are fixtures (relay-fixture.ts). Codex's fixture can answer its model catalog late
 * (`catalogDelayMs`: the picker says "读取模型…" meanwhile) and show the user's message late (`echoDelayMs`: the Turn is under way, so the page streams and the box is for the next
 * message). What is typed is typed through keys, as an input method commits it, and as an input method composes it; the box is looked at at every frame and at every input event, and
 * its value must only ever be a longer part of what was typed, in the same element, until the message is sent; the message that goes is that text once.
 *
 * Esc in the box stops a reply that is under way. A choice made in one of the box's lists hands the focus to the box, and the Esc pressed next belongs to the list the user thinks is still
 * open: it stops nothing (the first Esc only; a key, a typed letter, a pointer press or the box losing the focus in between and the next Esc stops the reply as ever). The reply that is
 * under way is one only the user can end (the fixture's RELAY_HOLD: a command that runs for a minute); whether a stop was asked is read from what Codex was sent (`turn/interrupt`).
 *
 * Run: `pnpm build && pnpm web:build && node --test dist/tests/browser/composer.browser.js` (it needs the built page and Chromium).
 */

/** 44 characters. */
const TEXT = "把这次切换的边界情况列出来，再逐条补上测试，最后把结论写进说明文档里，别漏了回退这一条。";
const FIRST = "先帮我想一个项目名，要短一点";

type Fixture = Awaited<ReturnType<typeof launch>>;
interface Current { id: string; selection: { harnessId: string }; pendingSwitchId: string | null; runs: { input: string; status: string }[] }

/** The page opened on a real Gateway with Claude Code and Codex available. */
async function start(t: test.TestContext) {
  const fixture = await launch();
  let browser: Browser | null = null;
  // Owned before the browser launches, so a browser that cannot start never leaks a Gateway.
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin;
  const current = async (): Promise<Current> => {
    const list = ((await (await context.request.get(origin + "/api/v1/sessions")).json()) as { sessions: { id: string }[] }).sessions;
    return await readThrough(context, origin, list[0]!.id) as unknown as Current;
  };
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const log = page.getByRole("log", { name: "对话历史" });
  const model = page.getByRole("button", { name: "选择模型", exact: true });
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await context.request.get(origin + "/api/v1/harnesses")).json() as { id: string; controls: { available: boolean }[] }[])
    .filter(harness => ["claude", "codex"].includes(harness.id) && harness.controls.some(control => control.available)).length, { timeout: 30_000 }).toBe(2);
  await page.reload();
  /** Sends `text` and waits for the reply of Run number `index` (from 0) to be complete. */
  const say = async (text: string, index: number, reply: string): Promise<void> => {
    await expect(composer).toBeEnabled();
    await composer.fill(text); await composer.press("Enter");
    await expect(log.locator(".assistant-message")).toHaveCount(index + 1, { timeout: 30_000 });
    await expect(log.locator(".assistant-message").nth(index)).toContainText(reply, { timeout: 30_000 });
    await expect(log.locator(".assistant-message").nth(index)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  };
  /** Switches the conversation to `name` and waits until the switch took effect. */
  const switchTo = async (name: string, harnessId: string): Promise<void> => {
    await pick("选择 Harness", name);
    await expect.poll(async () => { const value = await current(); return value.selection.harnessId === harnessId && value.pendingSwitchId === null; }, { timeout: 20_000 }).toBe(true);
  };
  return { fixture, context, page, errors, current, composer, log, model, pick, say, switchTo, card: page.locator(".relay-card"), root: fixture.root };
}
type Started = Awaited<ReturnType<typeof start>>;

/** From now on the page notes, at every animation frame and at every input event, what the message box holds and whether it is still the element it was. */
async function watch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = { values: [] as string[], replaced: 0, element: document.getElementById("message-input") };
    (window as unknown as { __box: typeof seen }).__box = seen;
    const note = (): void => {
      const element = document.getElementById("message-input") as HTMLTextAreaElement | null;
      if (element !== seen.element) { seen.replaced++; seen.element = element; }
      const value = element?.value ?? "";
      if (seen.values.at(-1) !== value) seen.values.push(value);
    };
    document.addEventListener("input", note, true);
    const frame = (): void => { note(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
}
async function watched(page: Page): Promise<{ readonly values: readonly string[]; readonly replaced: number }> {
  return await page.evaluate(() => { const { values, replaced } = (window as unknown as { __box: { values: string[]; replaced: number } }).__box; return { values, replaced }; });
}
/** The box only ever grew by what was typed: every value it held was the start of `text` and none was shorter than the one before, and it is still the same element. */
function assertGrew(seen: { readonly values: readonly string[]; readonly replaced: number }, text: string, where: string): void {
  assert.equal(seen.replaced, 0, where + ": the message box was replaced by another element");
  let longest = 0;
  for (const value of seen.values) {
    assert.ok(text.startsWith(value), where + ": the box showed " + JSON.stringify(value) + ", which is not the start of what was typed");
    assert.ok(value.length >= longest, where + ": the box lost " + (longest - value.length) + " characters (" + JSON.stringify(seen.values.slice(-3)) + ")");
    longest = value.length;
  }
  assert.equal(seen.values.at(-1), text, where + ": the box ended with what was typed");
}
/** The messages the Gateway holds as the user's words, in order. */
async function said(started: Started): Promise<readonly string[]> { return (await started.current()).runs.map(run => run.input); }
/** The text appears once in what the user sees of the message, and in what the Gateway was sent. */
async function assertSentOnce(started: Started, text: string, index: number, where: string): Promise<void> {
  const { log, root } = started;
  const message = log.locator(".user-message").nth(index);
  await expect(message).toContainText(text);
  assert.equal(((await message.innerText()).split(text).length - 1), 1, where + ": the message shows its words once");
  assert.equal((await said(started))[index], text, where + ": the Gateway holds the words as typed");
  const sent = readRelayPrompt((await prompts(root, "codex")).at(-1)!);
  assert.equal(sent.currentInput.text.trim(), text, where + ": Codex was sent the words as typed");
  // With a packet the words are its last part (the current instruction), once; without one they are all that was sent.
  if (sent.packet) assert.equal(sent.body.split(text).length - 1, 1, where + ": and they are in what Codex was sent once, as the current instruction");
}

/** The words the conversation holds before the walks below begin: Claude Code, then Codex, then Claude Code again. */
const BEFORE = [FIRST, "接着把项目名写进 README", "回到这里，再检查一下 README"];
/**
 * Claude Code answers, the conversation goes over to Codex and back, so that Codex has been handed a conversation before and the line above the box is the ordinary one ("将交给
 * Codex：1 轮"), and the page is opened anew (what it remembered of Codex's models is gone): the next switch to Codex reads its model catalog, which arrives `late` ms after it is asked for.
 */
async function backOnClaude(started: Started, late: number): Promise<void> {
  const { fixture, page, say, switchTo, composer } = started;
  await started.pick("选择 Harness", "Claude Code");
  await say(BEFORE[0]!, 0, CLAUDE_REPLY);
  await switchTo("Codex", "codex");
  await say(BEFORE[1]!, 1, CODEX_REPLY);
  await switchTo("Claude Code", "claude");
  await say(BEFORE[2]!, 2, CLAUDE_REPLY);
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(started.log.locator(".assistant-message")).toHaveCount(3);
  await fixture.mode({ catalogDelayMs: late });
}

test("switching the Harness never clears or repeats what is being typed: typed before the switch, after it with the model still being read, and while the model and the handoff line appear", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, card, model, errors, fixture, log } = started;
  await backOnClaude(started, 3000);
  await watch(page);
  // The first part is typed before the Harness is changed.
  const head = TEXT.slice(0, 12), middle = TEXT.slice(12, 30), tail = TEXT.slice(30);
  await composer.pressSequentially(head);
  await expect(composer).toHaveValue(head);
  await started.pick("选择 Harness", "Codex");
  await expect(model).toContainText("读取模型…");
  await expect(composer).toHaveValue(head);
  await page.keyboard.press("Escape");
  // The rest goes in while the catalog is read and the line that says what goes to Codex appears: slow enough to span both.
  await composer.pressSequentially(middle, { delay: 90 });
  await expect(composer).toHaveValue(head + middle);
  await composer.pressSequentially(tail, { delay: 90 });
  await expect(model).not.toContainText("读取模型…", { timeout: 20_000 });
  await expect(model).toContainText("gpt-5.5");
  await expect(card).toContainText("将交给 Codex：1 轮");
  await expect(composer).toHaveValue(TEXT);
  assertGrew(await watched(page), TEXT, "typed across the switch, the catalog and the line");
  await fixture.mode({});
  await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(4, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toContainText(CODEX_REPLY);
  await assertSentOnce(started, TEXT, 3, "after the switch");
  await expect(composer).toHaveValue("");
  assert.deepEqual(await said(started), [...BEFORE, TEXT]);
  assert.deepEqual(errors, [], "no console error");
});

test("typing that starts once the model is read and the handoff line is shown is the same text, sent once", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, card, model, errors, log, fixture } = started;
  await backOnClaude(started, 1500);
  await started.switchTo("Codex", "codex");
  await expect(model).not.toContainText("读取模型…", { timeout: 20_000 });
  await expect(card).toContainText("将交给 Codex：1 轮");
  await watch(page);
  await composer.pressSequentially(TEXT, { delay: 40 });
  await expect(composer).toHaveValue(TEXT);
  assertGrew(await watched(page), TEXT, "typed after everything is in");
  await fixture.mode({});
  await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(4, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await assertSentOnce(started, TEXT, 3, "typed late");
  assert.deepEqual(errors, [], "no console error");
});

test("text composed by an input method (pinyin shown in the box until it is committed) survives the model being read, the line appearing and the Harness being changed", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, context, composer, card, model, errors, log, fixture } = started;
  await backOnClaude(started, 2500);
  const cdp = await context.newCDPSession(page);
  await composer.focus();
  const pieces: readonly (readonly [string, string])[] = [["ba zhe ci", "把这次"], ["qie huan", "切换"], ["de bian jie", "的边界"], ["qing kuang", "情况"], ["lie chu lai", "列出来"]];
  let committed = "";
  const compose = async ([pinyin, words]: readonly [string, string], wait: number): Promise<void> => {
    await cdp.send("Input.imeSetComposition", { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length });
    await expect(composer).toHaveValue(committed + pinyin);
    await page.waitForTimeout(wait);
    // Still composing: the box holds the words before it and the pinyin, whatever the page did meanwhile.
    await expect(composer).toHaveValue(committed + pinyin);
    await cdp.send("Input.insertText", { text: words });
    committed += words;
    await expect(composer).toHaveValue(committed);
  };
  await compose(pieces[0]!, 100);
  // The Harness is changed with part of the message written; its model is being read.
  await started.pick("选择 Harness", "Codex");
  await expect(model).toContainText("读取模型…");
  await expect(composer).toHaveValue(committed);
  await composer.focus();
  await watch(page);
  await compose(pieces[1]!, 600);
  await compose(pieces[2]!, 1200);
  // Composed across the moment the catalog arrives and the line appears.
  await compose(pieces[3]!, 1200);
  await expect(model).not.toContainText("读取模型…", { timeout: 20_000 });
  await expect(card).toContainText("将交给 Codex：1 轮");
  await compose(pieces[4]!, 300);
  await expect(composer).toHaveValue(committed);
  assert.equal(committed, "把这次切换的边界情况列出来");
  const seen = await watched(page);
  assert.equal(seen.replaced, 0, "the message box was replaced by another element");
  await fixture.mode({});
  await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(4, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await assertSentOnce(started, committed, 3, "composed");
  assert.deepEqual(errors, [], "no console error");
});

test("after a choice is made in the Harness list or the model list, the keys typed next go into the message box, not to the control that opened the list", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, model, errors, log } = started;
  await backOnClaude(started, 1500);
  // Opened and chosen with the mouse, Escape pressed as it is when the list still looks open, and then the message is typed without clicking into the box.
  await started.pick("选择 Harness", "Codex");
  await page.keyboard.press("Escape");
  await page.keyboard.type(TEXT, { delay: 15 });
  await expect(composer).toHaveValue(TEXT);
  await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toHaveCount(0);
  // The model list: chosen from, it hands the keys to the box too, and what is in the box stays.
  await expect(model).not.toContainText("读取模型…", { timeout: 20_000 });
  await model.click();
  await page.getByRole("option", { name: /gpt-5\.5/u }).first().click();
  await page.keyboard.type(" 补一句 ok", { delay: 15 });
  await expect(composer).toHaveValue(TEXT + " 补一句 ok");
  await expect(page.getByRole("combobox", { name: "搜索模型", exact: true })).toHaveCount(0);
  // A list closed without a choice gives the focus back to the control that opened it.
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "选择 Harness", exact: true })).toBeFocused();
  await composer.click();
  await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(4, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await assertSentOnce(started, TEXT + " 补一句 ok", 3, "typed after choosing");
  assert.deepEqual(errors, [], "no console error");
});

test("the next message typed while a reply streams stays as typed through the stream's frames and the end of the Turn, and is sent once", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors, log, fixture } = started;
  await backOnClaude(started, 800);
  await started.switchTo("Codex", "codex");
  await expect(started.model).not.toContainText("读取模型…", { timeout: 20_000 });
  await fixture.mode({ echoDelayMs: 2500 });
  // A Turn that is under way for a while: the box is for the next message.
  const second = "第四条：先把这条发出去";
  await composer.fill(second); await composer.press("Enter");
  await expect(composer).toHaveAttribute("placeholder", "回复进行中，可以先写下一条…", { timeout: 20_000 });
  await expect(composer).toHaveValue("");
  await watch(page);
  // Typed over the 2.5 s it is held back and the seconds in which its frames arrive and it ends.
  await composer.pressSequentially(TEXT, { delay: 110 });
  await expect(composer).toHaveValue(TEXT);
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await expect(composer).toHaveValue(TEXT);
  assertGrew(await watched(page), TEXT, "typed while the reply streamed");
  await fixture.mode({});
  await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(5, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(4)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await assertSentOnce(started, TEXT, 4, "typed while streaming");
  assert.deepEqual(await said(started), [...BEFORE, second, TEXT]);
  await expect(composer).toHaveValue("");
  assert.deepEqual(errors, [], "no console error");
});

test("a message sent with Enter while a reply runs is held, shown once in the held row, and goes out once when the Turn ends, with the box empty meanwhile", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors, log, fixture } = started;
  await backOnClaude(started, 800);
  await started.switchTo("Codex", "codex");
  await expect(started.model).not.toContainText("读取模型…", { timeout: 20_000 });
  await fixture.mode({ echoDelayMs: 3000 });
  const second = "第四条：先把这条发出去";
  await composer.fill(second); await composer.press("Enter");
  await expect(composer).toHaveAttribute("placeholder", "回复进行中，可以先写下一条…", { timeout: 20_000 });
  await watch(page);
  await composer.pressSequentially(TEXT, { delay: 20 });
  await expect(composer).toHaveValue(TEXT);
  await composer.press("Enter");
  // Held: the words are in the held row and not in the box; the Turn goes on.
  const held = page.locator(".queued-message");
  await expect(held).toHaveCount(1);
  await expect(held).toContainText(TEXT);
  await expect(composer).toHaveValue("");
  await fixture.mode({});
  // The Turn ends and the held message goes out by itself, once.
  await expect(log.locator(".assistant-message")).toHaveCount(5, { timeout: 40_000 });
  await expect(log.locator(".assistant-message").nth(4)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await expect(held).toHaveCount(0);
  await assertSentOnce(started, TEXT, 4, "held and sent");
  assert.deepEqual(await said(started), [...BEFORE, second, TEXT]);
  await expect(composer).toHaveValue("");
  assert.deepEqual(errors, [], "no console error");
});

/**
 * A reply under way that only the user ends: the conversation is on Codex and its last message started a Turn that does not end by itself. `status` is that Run's state as the Gateway holds
 * it, `stops` how many interrupts Codex was sent.
 */
async function running(started: Started) {
  const { fixture, composer, model, root } = started;
  await backOnClaude(started, 300);
  await started.switchTo("Codex", "codex");
  await expect(model).not.toContainText("读取模型…", { timeout: 20_000 });
  await fixture.mode({ RELAY_HOLD: "1" });
  await composer.fill("跑一个要很久的命令"); await composer.press("Enter");
  await expect(composer).toHaveAttribute("placeholder", "回复进行中，可以先写下一条…", { timeout: 20_000 });
  const status = async (): Promise<string | undefined> => (await started.current()).runs.at(-1)?.status;
  const stops = async (): Promise<number> => (await sent(root, "codex")).filter(line => line.method === "turn/interrupt").length;
  await expect.poll(status, { timeout: 20_000 }).toBe("running");
  return { status, stops };
}
/**
 * The page can take a stop now: the stop key is enabled, which it is not while the page is busy saving a choice (a pick of another Harness makes it switch, and an Esc in that moment is
 * ignored whatever the box does with it). A test presses Esc only after this, so that what it sees is the box's doing.
 */
async function canStop(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true })).toBeEnabled({ timeout: 20_000 });
}
/** Nothing was stopped: given the stop time to arrive, the Codex side was asked for none and the Run still runs. */
async function assertGoesOn(page: Page, run: Awaited<ReturnType<typeof running>>, where: string): Promise<void> {
  await page.waitForTimeout(700);
  assert.equal(await run.stops(), 0, where + ": Codex was asked to interrupt");
  assert.equal(await run.status(), "running", where + ": the reply is still under way");
}
/** The reply is stopped: Codex was asked once and the Run ends cancelled. */
async function assertStopped(run: Awaited<ReturnType<typeof running>>, where: string): Promise<void> {
  await expect.poll(run.stops, { message: where + ": Codex is asked to interrupt", timeout: 20_000 }).toBe(1);
  await expect.poll(run.status, { message: where + ": the Run ends stopped", timeout: 20_000 }).toBe("cancelled");
}

test("an Esc pressed right after a choice in the Harness list stops nothing, and the next one stops the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors } = started;
  const run = await running(started);
  // The list closes with the choice and the focus is in the box; the Esc is the user's for the list they think is still open.
  await started.pick("选择 Harness", "Claude Code");
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.press("Escape");
  await assertGoesOn(page, run, "the Esc after the choice");
  // That Esc was the one; the next is the box's own.
  await page.keyboard.press("Escape");
  await assertStopped(run, "the second Esc");
  assert.deepEqual(errors, [], "no console error");
});

test("a letter typed after a choice in the Harness list makes the next Esc stop the reply at once", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors } = started;
  const run = await running(started);
  await started.pick("选择 Harness", "Claude Code");
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.type("x");
  await expect(composer).toHaveValue("x");
  await page.keyboard.press("Escape");
  await assertStopped(run, "the Esc after a letter");
  assert.equal(await composer.inputValue(), "x", "what was typed stays");
  assert.deepEqual(errors, [], "no console error");
});

test("an Esc pressed right after a choice in the model list stops nothing either, and the next one stops the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, model, errors } = started;
  const run = await running(started);
  await model.click();
  await page.getByRole("option", { name: /gpt-5\.5/u }).first().click();
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.press("Escape");
  await assertGoesOn(page, run, "the Esc after the model choice");
  await page.keyboard.press("Escape");
  await assertStopped(run, "the second Esc");
  assert.deepEqual(errors, [], "no console error");
});

test("the mode list is the same: an Esc pressed right after a choice in it stops nothing, and the next one stops the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors } = started;
  const run = await running(started);
  await page.getByRole("button", { name: "协作模式", exact: true }).click();
  await page.getByRole("option", { name: "计划", exact: true }).click();
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.press("Escape");
  await assertGoesOn(page, run, "the Esc after the mode choice");
  await page.keyboard.press("Escape");
  await assertStopped(run, "the second Esc");
  assert.deepEqual(errors, [], "no console error");
});

test("a choice made with the keyboard is the same: the Esc after it stops nothing, the next one stops the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, errors } = started;
  const run = await running(started);
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+J");
  const search = page.getByRole("combobox", { name: "搜索 Harness", exact: true });
  await expect(search).toBeFocused();
  await search.fill("Claude"); await search.press("Enter");
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.press("Escape");
  await assertGoesOn(page, run, "the Esc after the keyboard choice");
  await page.keyboard.press("Escape");
  await assertStopped(run, "the second Esc");
  assert.deepEqual(errors, [], "no console error");
});

test("a list closed with Esc and no choice stops nothing, and nothing was handed over: the Esc in the box afterwards stops the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer } = started;
  const run = await running(started);
  // The Esc is the list's, the focus goes back to where it came from, and the reply goes on.
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toHaveCount(0);
  await assertGoesOn(page, run, "the Esc that closed the list");
  await composer.focus();
  await page.keyboard.press("Escape");
  await assertStopped(run, "the Esc in the box after a list closed with Esc");
});

test("a pointer press after a choice leaves the next Esc to stop the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer, log } = started;
  const run = await running(started);
  await started.pick("选择 Harness", "Claude Code");
  await expect(composer).toBeFocused();
  await canStop(page);
  // A press on the page anywhere: the user has moved on; the box takes the focus back from the keyboard, not from a press.
  await log.click({ position: { x: 5, y: 5 }, force: true });
  await composer.focus();
  await page.keyboard.press("Escape");
  await assertStopped(run, "the Esc after a pointer press");
});

test("the box losing the focus after a choice leaves the next Esc to stop the reply", { timeout: 120_000 }, async t => {
  const started = await start(t);
  const { page, composer } = started;
  const run = await running(started);
  await started.pick("选择 Harness", "Claude Code");
  await expect(composer).toBeFocused();
  await canStop(page);
  await page.keyboard.press("Shift+Tab");
  await expect(composer).not.toBeFocused();
  await composer.focus();
  await page.keyboard.press("Escape");
  await assertStopped(run, "the Esc after the box lost the focus");
});
