import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { application } from "../../src/cli/session-application.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";
import { startWebServer, type WebServer } from "../../src/web/server.js";

/*
 * The relay from the user's side, end to end (G073-C08, ADR-055 §12, the owner's decision of 2026-11-10): the real Gateway, with its
 * real store, Runtime and Drivers, and the real built page in a real browser; only the two Harnesses' own programs are fixtures. Claude
 * Code and Codex are the catalog's own entries, each run by a fixture that plays what its protocol shows of the native history
 * (tests/fixtures/relay-control-peer.mjs: the transcript Claude Code writes, the thread Codex keeps and the user message it echoes).
 * The settings are the defaults: nothing is asked, nothing is refused, no Run fails. The conversation goes
 * Claude Code -> Codex -> Claude Code, then Codex whose hand-over nothing can confirm (sent again once, then alone, the banner offering the
 * way out), then Claude Code's context cleared and the history attached again for one message.
 *
 * Run: `pnpm build && pnpm web:build && node --test dist/tests/browser/relay-e2e.browser.js` (it needs the built page and Chromium).
 * Pictures of each step, light and dark, are written to artifacts/relay-ui/ (not committed).
 */

const peer = pathToFileURL(fileURLToPath(new URL("../../../tests/fixtures/relay-control-peer.mjs", import.meta.url))).href;
const artifact = resolve("artifacts/relay-ui");
const CLAUDE_REPLY = "Claude Code：收到，我来处理。", CODEX_REPLY = "Codex：收到，接着做。";

interface Fixture { readonly root: string; readonly gateway: WebServer; readonly mode: (value: Readonly<Record<string, string | number>>) => Promise<void>; close(): Promise<void> }
/**
 * The real Gateway over a private data directory and workspace. Claude Code's and Codex's catalog entries run these programs instead of
 * the installed ones: Claude Code's keeps its transcript where the Driver reads it (the home the Gateway gives its Harnesses); Codex's
 * reads `mode` at each start (what its native side does at the next Turn: the default, or no echo of the user's message and no way to
 * be asked afterwards), and with `echoDelayMs` shows a user message that late, which keeps a hand-over visibly on its way.
 */
async function launch(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-relay-e2e-"))), workspace = join(root, "workspace");
  await mkdir(workspace);
  const state = join(root, "native-state.json"), modeFile = join(root, "codex-mode.json"), claudeShim = join(root, "claude-fixture.mjs"), codexShim = join(root, "codex-fixture.mjs"), codexPeer = join(root, "codex-peer.mjs");
  await writeFile(modeFile, "{}");
  const commands = JSON.stringify([{ name: "compact", description: "Clear conversation history but keep a summary" }, { name: "context", description: "Show current context usage" }]);
  // Claude Code: the transcript is the CLI's, in the Gateway's home for its Harnesses (CLAUDE_CONFIG_DIR is not set, so ~/.claude of that home).
  await writeFile(claudeShim, "#!" + process.execPath + "\n" + [
    `process.env.RELAY_PROTOCOL = "acp"; process.env.RELAY_STATE = ${JSON.stringify(state)}; process.env.RELAY_TRANSCRIPT = ${JSON.stringify(join(root, ".claude"))};`,
    `process.env.RELAY_REPLY = ${JSON.stringify(CLAUDE_REPLY)}; process.env.RELAY_COMMANDS = ${JSON.stringify(commands)};`, `await import(${JSON.stringify(peer)});`, ""].join("\n"), { mode: 0o700 });
  // Codex: the same fixture, behind a proxy that holds the whole Turn back when the mode says so (the order of what it says is kept).
  await writeFile(codexPeer, `import { readFileSync } from "node:fs";\nconst mode = JSON.parse(readFileSync(${JSON.stringify(modeFile)}, "utf8"));\n`
    + `Object.assign(process.env, { RELAY_PROTOCOL: "codex", RELAY_STATE: ${JSON.stringify(state)}, RELAY_REPLY: ${JSON.stringify(CODEX_REPLY)}, RELAY_ECHO_FIELD: "clientId" }, Object.fromEntries(Object.entries(mode).map(([key, value]) => [key, String(value)])));\n`
    + `await import(${JSON.stringify(peer)});\n`);
  await writeFile(codexShim, "#!" + process.execPath + "\n" + [
    `import { spawn } from "node:child_process"; import { readFileSync } from "node:fs"; import { createInterface } from "node:readline";`,
    `const delay = Number(JSON.parse(readFileSync(${JSON.stringify(modeFile)}, "utf8")).echoDelayMs ?? 0);`,
    `const child = spawn(process.execPath, [${JSON.stringify(codexPeer)}], { stdio: ["pipe", "pipe", "inherit"] });`,
    `process.stdin.pipe(child.stdin); process.stdin.on("end", () => child.stdin.end());`,
    `let chain = Promise.resolve();`,
    `createInterface({ input: child.stdout }).on("line", line => {`,
    `  let wait = 0; try { const message = JSON.parse(line); if (delay > 0 && message.method === "item/started" && message.params?.item?.type === "userMessage") wait = delay; } catch { /* not JSON */ }`,
    `  chain = chain.then(async () => { if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait)); process.stdout.write(line + "\\n"); });`,
    `});`,
    `child.on("exit", code => chain.then(() => process.exit(code ?? 0)));`, ""].join("\n"), { mode: 0o700 });
  const manifest = join(root, "catalog.json");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "claude-acp-npm": { executable: claudeShim }, "codex-native": { executable: codexShim } } }));
  let gateway: WebServer;
  try {
    gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0, providerManagement: false,
      // The Harnesses are manifest entries, which only a development Gateway reads (ADR-044); their home is the private one.
      application: (data, publish) => application(data, publish, { installations: "any", nativeEnvironment: { home: root, values: { HOME: root, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } }, workspaceLockRoot: join(root, "locks") }) });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  return { root, gateway, mode: async value => { await writeFile(modeFile, JSON.stringify(value)); }, close: async () => { try { await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `${name}-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
}

/** The page opened on a real Gateway with Claude Code and Codex available, and what the walks below do with it. */
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
  const current = async (): Promise<{ id: string; epoch: number; pendingSwitchId: string | null; selection: { harnessId: string }; runs: { status: string; relay?: { packetId: string | null; decision?: { kind: string; by: string; cause?: string } } }[] }> => {
    const list = await (await context.request.get(origin + "/api/v1/sessions")).json() as { id: string }[];
    return await (await context.request.get(origin + "/api/v1/sessions/" + list[0]!.id)).json();
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
  return { fixture, context, page, errors, refused, origin, current, pick, composer, log, switchTo, say, card: page.locator(".relay-card"), banner: page.locator("[data-relay=attention]"),
    separator: (name: string | RegExp) => log.getByRole("separator", { name }) };
}

test("G073-C08 A -> B -> A in the browser under the defaults: handed over with a packet and evidence, brought up to date on the way back, a delivery nothing confirms sent again once and then alone with the way out in a banner, a cleared context given its history for one message; nothing asked, no 409, no failed Run", { timeout: 240_000 }, async t => {
  const { fixture, page, errors, refused, current, pick, composer, log, switchTo, say, card, banner, separator } = await start(t);

  // ---- 1. Claude Code answers, on a conversation of its own --------------------------------------------------------------------
  await pick("选择 Harness", "Claude Code");
  await say("先帮我想一个项目名，要短一点", 0, CLAUDE_REPLY);
  await expect(card).toHaveCount(0); await expect(page.locator(".relay-divider, .relay-note, [data-relay]")).toHaveCount(0);
  await shoot(page, "e2e-1-claude");

  // ---- 2. Over to Codex: the line above the box says where the history goes, and nothing is asked --------------------------------
  await switchTo("Codex", "codex");
  await expect(card).toHaveAttribute("data-relay", "intro");
  await expect(card).toContainText("这条消息会附上之前的对话记录交给 Codex · 可在设置里改为每次询问");
  await expect(page.locator(".relay-intro")).toHaveCount(0);
  await shoot(page, "e2e-2-intro");
  // Codex's native side shows the user's message late: the hand-over is on its way, and the line says so and not more.
  await fixture.mode({ echoDelayMs: 2500 });
  await composer.fill("接着把项目名写进 README"); await composer.press("Enter");
  const pending = separator("交给 Codex · 交接单 #1 · 送达中");
  await expect(pending).toBeVisible({ timeout: 20_000 });
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(0);
  await shoot(page, "e2e-3-pending");
  // The evidence arrives (Codex says it recorded the entry): now the Harness took over, with how and the proof.
  const taken = separator("从这里起由 Codex 接手 · 新会话 · 交接单（标准） · #1");
  await expect(taken).toBeVisible({ timeout: 30_000 });
  await expect(taken.locator("..")).toHaveAttribute("data-handover", "taken"); await expect(taken.locator("..")).toHaveAttribute("data-evidence", "E1");
  await expect(log.locator(".assistant-message").nth(1)).toContainText(CODEX_REPLY, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(1)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await fixture.mode({});
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-4-taken");
  // The message went with its packet: the strip opens the packet's text exactly as it was sent.
  const strip = log.getByRole("button", { name: "附交接单 #1", exact: true });
  await expect(strip).toBeVisible();
  await strip.click();
  const dialog = page.getByRole("dialog", { name: "交接单 #1" });
  const packet = dialog.locator(".relay-packet-text");
  await expect(packet).toBeVisible();
  const text = (await packet.textContent()) ?? "";
  assert.ok(text.includes("先帮我想一个项目名，要短一点"), "the packet carries what the user said to Claude Code");
  assert.ok(text.includes(CLAUDE_REPLY), "and what Claude Code answered");
  await shoot(page, "e2e-5-packet");
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);

  // ---- 3. Back to Claude Code: what Codex did in between goes with the next message, as an increment ------------------------------
  await switchTo("Claude Code", "claude");
  // Claude Code is another service than Codex, and it has not been told of in this browser: the same one line, once.
  await expect(card).toContainText("这条消息会附上之前的对话记录交给 Claude Code · 可在设置里改为每次询问");
  await expect(card.getByRole("button")).toHaveText(["只发这条消息"]);
  await shoot(page, "e2e-6-return-line");
  await say("回到这里，再检查一下 README", 2, CLAUDE_REPLY);
  const back = separator(/^从这里起由 Claude Code 接手 · 继续原会话 · 补交 1 轮/u);
  await expect(back).toBeVisible({ timeout: 30_000 });
  await expect(log.getByRole("button", { name: /^附交接单 #2$/u })).toBeVisible();
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-7-back");

  // ---- 4. Codex again, and its native side confirms nothing: sent again once, then alone; the way out is a banner ------------------
  await switchTo("Codex", "codex");
  await fixture.mode({ RELAY_HOOK: "1", RELAY_TURNS_FAULT: "refuse" });
  await say("第四条：补一条边界测试", 3, CODEX_REPLY);
  const unconfirmed = separator("Codex 已回复，但没有确认收到交接单；下一条消息会再附上一次");
  await expect(unconfirmed).toBeVisible({ timeout: 30_000 });
  await expect(log.getByRole("separator", { name: /接手/u })).toHaveCount(2);
  await shoot(page, "e2e-8-unconfirmed");
  // The next message sends the packet again by itself (once), and says so.
  await say("第五条：再补一条", 4, CODEX_REPLY);
  await expect(log.locator(".relay-note").last()).toContainText("上一份交接单没有确认送达，这条消息已再附一次（交接单 #4");
  await shoot(page, "e2e-9-resent");
  // The one after goes alone, said under the message, and the banner offers the ways out: nothing was asked, nothing failed.
  await say("第六条：只发这一条的话", 5, CODEX_REPLY);
  await expect(log.locator(".relay-note").last()).toHaveText("交接单 #4 发了两次仍未确认送达 · 这条只发了原话");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("发了两次仍未确认送达 Codex · 之后的消息只发原话，有新内容再附");
  await expect(banner.locator("button[data-option]")).toHaveText(["再附一次", "新开原生会话"]);
  await expect(card).toHaveCount(1);
  await shoot(page, "e2e-10-banner");
  // Codex's native side is well again; the way out chosen on the banner is a field of the next message, which then confirms the packet.
  await fixture.mode({});
  await banner.getByRole("button", { name: "再附一次", exact: true }).click();
  await expect(banner).toContainText("下一条消息会再附一次交接单");
  await say("第七条：照banner再附一次", 6, CODEX_REPLY);
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-11-settled");

  // ---- 5. Claude Code's context cleared: the next message carries no history, and the history is offered back for one --------------
  await switchTo("Claude Code", "claude");
  await say("/clear", 7, "");
  await expect(card).toHaveAttribute("data-relay", "cleared");
  await expect(card).toContainText("Claude Code 的上下文已清空 · 下一条不附历史");
  await shoot(page, "e2e-12-cleared");
  await card.getByRole("button", { name: "附上交接单", exact: true }).click();
  await expect(card).toContainText("下一条会附上之前对话的交接单");
  await say("清空之后接着做：把这份交接单里的第一件事说一遍", 8, CLAUDE_REPLY);
  await expect(log.getByRole("button", { name: /^附交接单 #\d+$/u }).last()).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveCount(0);
  await shoot(page, "e2e-13-attached");

  // ---- Nothing was refused and nothing failed -----------------------------------------------------------------------------------
  const finished = await current();
  assert.deepEqual(finished.runs.map(run => run.status), Array(9).fill("completed"), "every Run completed");
  assert.deepEqual(refused, [], "no message was answered with a refusal");
  assert.deepEqual(errors, [], "no console error");
  // The decisions the relay recorded, as the page showed them.
  assert.deepEqual(finished.runs.map(run => run.relay?.decision ? `${run.relay.decision.kind}/${run.relay.decision.by}${run.relay.decision.cause ? "/" + run.relay.decision.cause : ""}` : "-"),
    ["-", "carry/need", "carry/need", "carry/need", "carry/policy/delivery_unconfirmed", "alone/policy/delivery_unconfirmed", "carry/user", "-", "carry/user"]);
});

test("G073-C08 the strict setting asks as the stricter design did: once the one automatic resend is spent a delivery nothing confirms is a 409 with the ways out above the box, the draft is kept, and the way chosen sends it", { timeout: 240_000 }, async t => {
  const { fixture, context, page, errors, refused, origin, current, pick, composer, log, switchTo, say, banner } = await start(t);
  await pick("选择 Harness", "Claude Code");
  await say("先说一句话", 0, CLAUDE_REPLY);
  await switchTo("Codex", "codex");
  // Codex's native side confirms nothing, so what the relay does about the packet it cannot confirm is the setting's matter.
  await fixture.mode({ RELAY_HOOK: "1", RELAY_TURNS_FAULT: "refuse" });
  await say("第二条", 1, CODEX_REPLY);
  // The setting, as the user changes it: 送达拿不准时 -> 每次问我 (the Gateway's, so a read of the preferences shows it too).
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  const unsure = page.getByRole("radiogroup", { name: "送达拿不准时", exact: true });
  await expect(unsure.getByRole("radio", { name: "自动处理（默认）" })).toHaveAttribute("aria-checked", "true");
  await unsure.getByRole("radio", { name: "每次问我" }).click();
  await expect(unsure.getByRole("radio", { name: "每次问我" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => ((await (await context.request.get(origin + "/api/v1/relay/prefs")).json()) as { prefs: Record<string, string> }).prefs["relay.whenUnsure"]).toBe("ask");
  await page.getByRole("button", { name: /先说一句话/u }).first().click();
  await expect(composer).toBeEnabled();
  // Back in the conversation the first packet is still unconfirmed, and the banner says so (it asks nothing: the next message would go).
  await expect(banner).toContainText("交接单 #1 还没有确认送达 Codex");
  // Even asking each time, the relay sends a packet it cannot confirm once more by itself: the third message goes, with the packet again.
  await say("第三条", 2, CODEX_REPLY);
  await expect(log.locator(".relay-note").last()).toContainText("上一份交接单没有确认送达，这条消息已再附一次（交接单 #2");
  assert.equal(refused.length, 0, "nothing was refused yet");

  // That was the one: the next message is refused, whole. Nothing was sent, no Run was made, and the draft is still in the box.
  await composer.fill("第四条：这条要先问我"); await composer.press("Enter");
  const choice = page.locator(".relay-choice");
  await expect(choice).toBeVisible({ timeout: 20_000 });
  await expect(choice).toContainText("上一份交接单没有确认送达 Codex");
  await expect(choice.locator("button[data-option]")).toHaveText(["再附一次", "只发这条消息", "新开原生会话"]);
  await expect(composer).toHaveValue("第四条：这条要先问我");
  assert.equal((await current()).runs.length, 3, "the refused message made no Run");
  assert.equal(refused.filter(item => item.startsWith("409")).length, 1, "exactly one refusal, the one the setting asks for");
  await shoot(page, "e2e-strict-choice");
  // The way chosen sends the same draft with its field, and the conversation goes on.
  await choice.getByRole("button", { name: "再附一次", exact: true }).click();
  await expect(log.locator(".assistant-message")).toHaveCount(4, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(3)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  await expect(choice).toHaveCount(0); await expect(composer).toHaveValue("");
  // And the other way out: the next one is asked again, and sent alone as typed.
  await composer.fill("第五条：只发这一条"); await composer.press("Enter");
  await expect(choice).toBeVisible({ timeout: 20_000 });
  await choice.getByRole("button", { name: "只发这条消息", exact: true }).click();
  await expect(log.locator(".assistant-message")).toHaveCount(5, { timeout: 30_000 });
  await expect(log.locator(".assistant-message").nth(4)).toHaveAttribute("data-run-status", "completed", { timeout: 30_000 });
  const finished = await current();
  assert.deepEqual(finished.runs.map(run => run.status), ["completed", "completed", "completed", "completed", "completed"], "every Run that was made completed");
  assert.deepEqual(finished.runs.map(run => run.relay?.decision ? `${run.relay.decision.kind}/${run.relay.decision.by}${run.relay.decision.cause ? "/" + run.relay.decision.cause : ""}` : "-"),
    ["-", "carry/need", "carry/policy/delivery_unconfirmed", "carry/user", "alone/user"]);
  assert.equal(refused.filter(item => item.startsWith("409")).length, 2, "the two asks, and no other refusal");
  assert.deepEqual(refused.filter(item => !item.startsWith("409")), []);
  // The two 409s are the browser's own report of an answer the page handled as a choice, not a fault of the page.
  assert.deepEqual(errors.filter(message => !/409/u.test(message)), [], "no other console error");
});
