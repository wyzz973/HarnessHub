import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { readRelayPrompt } from "../fixtures/relay-packet.js";
import { readThrough } from "../fixtures/http-conversation.js";
import { CLAUDE_REPLY, CODEX_REPLY, launch, opened, prompts } from "./relay-fixture.js";

/*
 * The relay from the user's side, end to end (slim.md, 2026-11-11): the real Gateway, with its real store, Runtime and Drivers, and the
 * real built page in a real browser; only the two Harnesses' own programs are fixtures. Claude Code and Codex are the catalog's own entries,
 * each run by a fixture that plays what its protocol shows of the native side (tests/fixtures/relay-control-peer.mjs), and each keeps a
 * trace of every line the Gateway sent it, which is how this walk sees what did and did not reach a native side. The settings are the
 * defaults: nothing is asked, nothing is refused, no Run fails.
 *
 * The conversation goes Claude Code -> Codex -> Claude Code, then to Codex whose native side confirms nothing (the next message sends the
 * packet again, saying it may repeat; the one after goes with the words alone and the banner offers to attach it once more, which settles
 * it), then Claude Code's context is cleared (the clear is the Hub's: it reaches nothing, the next message opens a new native session, and
 * the earlier part is offered back for one message), then Codex's.
 *
 * Run: `pnpm build && pnpm web:build && node --test dist/tests/browser/relay-e2e.browser.js` (it needs the built page and Chromium).
 * Pictures of each step, light and dark, are written to artifacts/relay-ui/ (not committed).
 */

const artifact = resolve("artifacts/relay-ui");

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `${name}-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The page opened on a real Gateway with Claude Code and Codex available, and what the walk below does with it. */
async function start(t: test.TestContext) {
  const fixture = await launch();
  let browser: Browser | null = null;
  // Owned before the browser launches, so a browser that cannot start never leaks a Gateway.
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors: string[] = [], refused: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  // Every answer to a message the page sent: under the defaults none of them is a refusal.
  page.on("response", response => { if (response.url().includes("/messages") && response.request().method() === "POST" && response.status() >= 300) refused.push(response.status() + " " + response.url()); });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin;
  type Decision = { kind: string; by: string; cause?: string; resend?: string };
  interface Current { id: string; epoch: number; pendingSwitchId: string | null; selection: { harnessId: string }; runs: { status: string; relay?: { packetId: string | null; decision?: Decision; delivery?: { state: string; evidence: string | null } } }[] }
  const current = async (): Promise<Current> => {
    const list = ((await (await context.request.get(origin + "/api/v1/sessions")).json()) as { sessions: { id: string }[] }).sessions;
    return await readThrough(context, origin, list[0]!.id);
  };
  /** The relay's own view of the conversation (GET …/relay), as the page reads it. */
  const relay = async (): Promise<{ bindings: { harnessId: string; nativeEpoch: number; sync: string; evidence: string | null; cleared: number; attention?: { cause: string; options: string[] } }[]; handedOver: string[] }> => {
    const { id } = await current();
    return await (await context.request.get(origin + "/api/v1/sessions/" + id + "/relay")).json();
  };
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const log = page.getByRole("log", { name: "对话历史" });
  /** Switches the conversation to `name` and waits until the switch took effect. */
  async function switchTo(name: string, harnessId: string): Promise<void> {
    await pick("选择 Harness", name);
    await expect.poll(async () => { const value = await current(); return value.selection.harnessId === harnessId && value.pendingSwitchId === null; }, { timeout: 20_000 }).toBe(true);
  }
  /** Sends `text` and waits for the reply of Run number `index` (from 0) to be complete. */
  async function say(text: string, index: number, reply: string): Promise<void> {
    await expect(composer).toBeEnabled();
    await composer.fill(text); await composer.press("Enter");
    await expect(log.locator(".assistant-message")).toHaveCount(index + 1, { timeout: 30_000 });
    await expect(log.locator(".assistant-message").nth(index)).toContainText(reply, { timeout: 30_000 });
    await expect(log.locator(".assistant-message").nth(index)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  }
  // Both Harnesses are on offer before the first message.
  await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await context.request.get(origin + "/api/v1/harnesses")).json() as { id: string; controls: { available: boolean }[] }[])
    .filter(harness => ["claude", "codex"].includes(harness.id) && harness.controls.some(control => control.available)).length, { timeout: 30_000 }).toBe(2);
  await page.reload();
  return { fixture, context, page, errors, refused, origin, current, relay, pick, composer, log, switchTo, say, card: page.locator(".relay-card"), banner: page.locator("[data-relay=attention]"),
    separator: (name: string | RegExp) => log.getByRole("separator", { name }) };
}

test("the slim relay in the browser under the defaults: handed over with a packet and evidence, brought up to date on the way back, a delivery nothing confirms sent again once and then alone with the way out in a banner, a clear that reaches no native side and opens a new one, on both Harnesses; nothing asked, no refusal, no failed Run", { timeout: 300_000 }, async t => {
  const { fixture, page, errors, refused, current, relay, pick, composer, log, switchTo, say, card, banner, separator } = await start(t);
  const root = fixture.root;

  // ---- 1. Claude Code answers, on a conversation of its own --------------------------------------------------------------------
  await pick("选择 Harness", "Claude Code");
  await say("先帮我想一个项目名，要短一点", 0, CLAUDE_REPLY);
  await expect(card).toHaveCount(0); await expect(page.locator(".switch-divider, [data-relay]")).toHaveCount(0);
  assert.deepEqual(await prompts(root, "claude"), ["先帮我想一个项目名，要短一点"], "a conversation that stays on one Harness hands nothing over: the words as typed");
  await shoot(page, "e2e-1-claude");

  // ---- 2. Over to Codex: one line says where the history goes, once, and nothing is asked ----------------------------------------
  await switchTo("Codex", "codex");
  await expect(card).toHaveAttribute("data-relay", "intro");
  await expect(card).toContainText("这条消息会附上之前的对话记录交给 Codex · 可在设置里关闭");
  // The line asks for nothing: the one choice about the history, to send this message without it, is in the "+" menu of the message box.
  await expect(card.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "添加文件或上下文", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "只发这条消息", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await shoot(page, "e2e-2-intro");
  // Codex's native side shows the user's message late: the hand-over is on its way, and the line says so and not more.
  await fixture.mode({ echoDelayMs: 2500 });
  await composer.fill("接着把项目名写进 README"); await composer.press("Enter");
  const pending = separator(/^Claude Code → Codex · 带上了之前的全部(?: \d+ 轮|对话) · 送达中$/u);
  await expect(pending).toBeVisible({ timeout: 20_000 });
  await expect(pending.locator("..")).toHaveAttribute("data-delivery", "sending");
  await shoot(page, "e2e-3-pending");
  // The evidence arrives (Codex says it recorded the entry): the line loses its flag, and says no more than what the Turn carried.
  const taken = separator(/^Claude Code → Codex · 带上了之前的全部(?: \d+ 轮|对话)$/u);
  await expect(taken).toBeVisible({ timeout: 30_000 });
  await expect(taken.locator("..")).toHaveAttribute("data-delivery", "confirmed");
  await expect(log.locator(".assistant-message").nth(1)).toContainText(CODEX_REPLY, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(1)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await fixture.mode({});
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-4-taken");
  // The message went with its packet: the line's link opens the packet's text exactly as it was sent, which is what Codex was sent.
  const strip = log.getByRole("button", { name: "查看交接单", exact: true });
  await expect(strip).toHaveCount(1);
  await strip.click();
  const dialog = page.getByRole("dialog", { name: "交接单 #1" });
  const packet = dialog.locator(".relay-packet-text");
  await expect(packet).toBeVisible();
  const text = (await packet.textContent()) ?? "";
  assert.ok(text.includes("先帮我想一个项目名，要短一点"), "the packet carries what the user said to Claude Code");
  assert.ok(text.includes(CLAUDE_REPLY), "and what Claude Code answered");
  await shoot(page, "e2e-5-packet");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
  const first = readRelayPrompt((await prompts(root, "codex"))[0]!);
  assert.deepEqual([first.packet, first.currentInput.text.trim(), first.history.map(row => row.user.text)], [true, "接着把项目名写进 README", ["先帮我想一个项目名，要短一点"]], "Codex was sent the packet and the words");
  assert.equal(text.trim(), first.body.trim(), "the link shows the text that was sent");

  // ---- 3. Back to Claude Code: what Codex did in between goes with the next message, as an increment ------------------------------
  await switchTo("Claude Code", "claude");
  // No conversation was handed to Claude Code on this installation yet: the same one line, once.
  await expect(card).toContainText("这条消息会附上之前的对话记录交给 Claude Code · 可在设置里关闭");
  await expect(card.getByRole("button")).toHaveCount(0);
  await shoot(page, "e2e-6-return-line");
  await say("回到这里，再检查一下 README", 2, CLAUDE_REPLY);
  const back = separator(/^Codex → Claude Code · 带上了之前 1 轮/u);
  await expect(back).toBeVisible({ timeout: 30_000 });
  await expect(log.getByRole("button", { name: "查看交接单", exact: true })).toHaveCount(2);
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-7-back");
  const returned = readRelayPrompt((await prompts(root, "claude")).at(-1)!);
  assert.deepEqual([returned.packet, returned.kind, returned.currentInput.text.trim(), returned.history.map(row => row.user.text)], [true, "delta", "回到这里，再检查一下 README", ["接着把项目名写进 README"]], "Claude Code was sent only what Codex did meanwhile");
  assert.equal(await opened(root, "claude"), 1, "its own native session went on");

  // ---- 4. Codex again, and its native side confirms nothing: sent again once, then alone; the way out is a banner ------------------
  await switchTo("Codex", "codex");
  // Handed a conversation before: the line is the ordinary one, with what is owed.
  await expect(card).toContainText("将交给 Codex：1 轮");
  await fixture.mode({ RELAY_HOOK: "1" });
  await say("第四条：补一条边界测试", 3, CODEX_REPLY);
  const unconfirmed = separator(/^Claude Code → Codex · 带上了.* · 未确认收到$/u);
  await expect(unconfirmed).toBeVisible({ timeout: 30_000 });
  await expect(log.getByRole("separator")).toHaveCount(3);
  // The banner says what is so, and asks for nothing: the next message goes by itself.
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText("交接单 #3 还没有确认送达 Codex再附一次");
  await shoot(page, "e2e-8-unconfirmed");
  // Closed, this episode does not come back; the next one (another packet) is said again.
  await banner.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(banner).toHaveCount(0);
  // The next message sends the packet again by itself (once), and says so; what Codex was sent says it may repeat.
  await say("第五条：再补一条", 4, CODEX_REPLY);
  const resent = readRelayPrompt((await prompts(root, "codex")).at(-1)!);
  assert.deepEqual([resent.packet, resent.currentInput.text.trim()], [true, "第五条：再补一条"]);
  assert.ok(resent.body.includes("可能有你已经收到过的部分"), "the packet says that parts of it may already be there");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("交接单 #4 发了两次仍未确认送达 Codex · 之后的消息只发原话，有新内容再附");
  await shoot(page, "e2e-9-resent");
  // The one after goes alone, said under the message, as typed to the native side; nothing was asked, nothing failed.
  await say("第六条：只发这一条的话", 5, CODEX_REPLY);
  assert.equal((await prompts(root, "codex")).at(-1), "第六条：只发这一条的话", "alone: the words as typed");
  await expect(banner).toBeVisible();
  await expect(banner.locator("button[data-option]")).toHaveText(["再附一次"]);
  await expect(card).toHaveCount(1);
  await shoot(page, "e2e-10-banner");
  // Codex's native side is well again; the way out chosen on the banner is a field of the next message, which then confirms the packet.
  await fixture.mode({});
  await banner.getByRole("button", { name: "再附一次", exact: true }).click();
  await expect(banner).toContainText("下一条消息会再附一次交接单");
  await say("第七条：照banner再附一次", 6, CODEX_REPLY);
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  await expect(card).toHaveCount(0);
  const settled = readRelayPrompt((await prompts(root, "codex")).at(-1)!);
  assert.deepEqual([settled.packet, settled.currentInput.text.trim()], [true, "第七条：照banner再附一次"]);
  assert.deepEqual((await relay()).bindings.filter(item => item.harnessId === "codex").map(item => [item.sync, item.evidence, item.attention ?? null]), [["synced", "E1", null]], "the packet reached Codex: nothing is pending any more");
  await shoot(page, "e2e-11-settled");

  // ---- 5. Claude Code's context cleared: the clear reaches no native side; the next message opens a new one and carries none of the history,
  //         and the history is offered back for one message ------------------------------------------------------------------------------
  await switchTo("Claude Code", "claude");
  const claudePrompts = (await prompts(root, "claude")).length;
  await say("/clear", 7, "");
  assert.equal((await prompts(root, "claude")).length, claudePrompts, "the clear was not sent to Claude Code");
  // The conversation changed hands with a clear: nothing was handed over, and the line says so instead of "continues the original session".
  await expect(separator(/^Codex → Claude Code · 只发了原话$/u)).toBeVisible();
  await expect(log.locator(".quiet-line[data-item=context_event]").last()).toHaveText("上下文已清空，下一条消息开新会话");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-cause", "attach_available");
  await expect(banner).toContainText("Claude Code 的上下文已清空 · 下一条不附历史");
  await expect(banner.locator("button[data-option]")).toHaveText(["附上交接单"]);
  assert.deepEqual((await relay()).bindings.filter(item => item.harnessId === "claude").map(item => [item.nativeEpoch, item.sync, item.cleared]), [[2, "fresh", 1]], "a new epoch that holds nothing");
  await shoot(page, "e2e-12-cleared");
  // The history is offered, not sent: chosen for the next message, it goes with that one alone, and with all of it.
  await banner.getByRole("button", { name: "附上交接单", exact: true }).click();
  await expect(banner).toContainText("下一条会附上之前对话的交接单");
  await say("清空之后接着做：把这份交接单里的第一件事说一遍", 8, CLAUDE_REPLY);
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  assert.equal(await opened(root, "claude"), 2, "the first message after the clear opened a new native session");
  const attached = readRelayPrompt((await prompts(root, "claude")).at(-1)!);
  assert.deepEqual([attached.packet, attached.kind, attached.currentInput.text.trim()], [true, "packet", "清空之后接着做：把这份交接单里的第一件事说一遍"]);
  assert.ok(attached.history.some(row => row.user.text === "先帮我想一个项目名，要短一点") && attached.history.some(row => row.user.text === "第七条：照banner再附一次"), "everything said before the clear, whoever said it");
  await shoot(page, "e2e-13-attached");

  // ---- 6. Codex's context cleared: the same, on a Harness whose native side was never told ------------------------------------------
  await switchTo("Codex", "codex");
  const codexPrompts = (await prompts(root, "codex")).length, codexSessions = await opened(root, "codex");
  await say("/clear", 9, "");
  assert.equal((await prompts(root, "codex")).length, codexPrompts, "the clear was not sent to Codex");
  await expect(separator(/^Claude Code → Codex · 只发了原话$/u)).toBeVisible();
  assert.equal(await opened(root, "codex"), codexSessions, "and its session is given up, not replaced ahead of the next message");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-cause", "attach_available");
  await expect(banner).toContainText("Codex 的上下文已清空 · 下一条不附历史");
  assert.deepEqual((await relay()).bindings.filter(item => item.harnessId === "codex").map(item => [item.nativeEpoch, item.sync, item.cleared]), [[2, "fresh", 1]], "a new epoch that holds nothing");
  await shoot(page, "e2e-14-codex-cleared");
  // Not attached: the next message opens a new native session and goes as typed.
  await say("清空之后的 Codex：只发这一条", 10, CODEX_REPLY);
  assert.equal(await opened(root, "codex"), codexSessions + 1, "a new native session");
  assert.equal((await prompts(root, "codex")).at(-1), "清空之后的 Codex：只发这一条", "as typed: no packet");
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  // Every message that carried a packet has its link, and every change of Harness its line. A message to the same Harness has a line
  // only when it still carried the conversation (again, by the banner's choice, after a clear) or went alone though something was owed:
  // that line names no hand-over, only what the message carried.
  await expect(separator(/^又带了一次之前的内容 · 未确认收到$/u)).toHaveCount(1);
  await expect(separator(/^只发了原话$/u)).toHaveCount(1);
  await expect(separator(/^带上了之前.*$/u)).toHaveCount(2);
  await expect(log.getByRole("button", { name: "查看交接单", exact: true })).toHaveCount(6);
  await expect(log.getByRole("separator")).toHaveCount(9);
  await shoot(page, "e2e-15-codex-new-session");

  // ---- Nothing was refused and nothing failed -----------------------------------------------------------------------------------
  const finished = await current();
  assert.deepEqual(finished.runs.map(run => run.status), Array(11).fill("completed"), "every Run completed");
  assert.deepEqual(refused, [], "no message was answered with a refusal");
  assert.deepEqual(errors, [], "no console error");
  // The decisions the relay recorded, as the page showed them.
  assert.deepEqual(finished.runs.map(run => run.relay?.decision ? `${run.relay.decision.kind}/${run.relay.decision.by}${run.relay.decision.cause ? "/" + run.relay.decision.cause : ""}${run.relay.decision.resend ? "/" + run.relay.decision.resend : ""}` : "-"),
    ["-", "carry/need", "carry/need", "carry/need", "carry/policy/delivery_unconfirmed/auto", "alone/policy/delivery_unconfirmed", "carry/user", "-", "carry/user", "-", "-"]);
  // What each Run's packet came to: only the ones with evidence say "recorded", and the page said the same.
  assert.deepEqual(finished.runs.map(run => run.relay?.delivery ? `${run.relay.delivery.state}${run.relay.delivery.evidence ? "/" + run.relay.delivery.evidence : ""}` : "-"),
    ["-", "recorded/E1", "recorded/E3", "unknown", "unknown", "-", "recorded/E1", "-", "recorded/E3", "-", "-"]);
});
