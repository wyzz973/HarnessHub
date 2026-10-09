import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser } from "@playwright/test";
import { startWebServer } from "../../src/web/server.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/web-harness-peer.mjs", import.meta.url));
const artifact = resolve("artifacts/web");
async function launchFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-web-browser-")));
  const workspace = join(root, "workspace"), shim = join(root, "codex-fixture.mjs"); await mkdir(workspace);
  await writeFile(shim, "#!" + process.execPath + "\nimport " + JSON.stringify(pathToFileURL(peer).href) + ";\n", { mode: 0o700 });
  const manifest = join(root, "catalog.json");
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-native": { executable: shim } } }));
  const modelServer = createServer((req, res) => { assert.equal(req.method, "GET"); assert.equal(req.url, "/v1/models"); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] })); });
  await new Promise<void>(done => modelServer.listen(0, "127.0.0.1", done));
  const address = modelServer.address(); assert.ok(address && typeof address === "object");
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0 });
  return { root, gateway, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: async () => { await gateway.close(); modelServer.closeAllConnections(); await new Promise<void>(done => modelServer.close(() => done())); await rm(root, { recursive: true, force: true }); } };
}

test("real browser validates Provider management, public chat switching, cancellation and responsive layouts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture();
  let browser: Browser | null = null;
  // Own the listener before browser launch, so missing browser binaries cannot leak a live gateway.
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors: string[] = [];
  let droppedSwitchResponse = false, expectedNetworkErrors = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (droppedSwitchResponse && message.text().includes("net::ERR_CONNECTION_RESET")) expectedNetworkErrors++;
    else errors.push(message.text());
  });
  await page.goto(fixture.gateway.url); await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(artifact, "initial-desktop.png"), fullPage: true, animations: "disabled" });
  async function responsive(label: string) {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: join(artifact, `${label}-${width}.png`), fullPage: true, animations: "disabled" });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + " has horizontal overflow");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await responsive("initial");

  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "连接你的第一个模型服务" })).toBeVisible();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).first().click();
  await responsive("provider-editor");
  async function createProvider(name: string, model: string, key: string, protocol = "openai-responses") {
    await page.getByLabel("名称", { exact: true }).fill(name);
    await page.getByLabel("API 协议", { exact: true }).selectOption(protocol);
    await page.getByLabel("Base URL", { exact: true }).fill(fixture.baseUrl);
    await page.getByLabel(/API Key/u).fill(key);
    await page.getByLabel("模型 ID 列表", { exact: true }).fill(model);
    await page.getByLabel("默认模型", { exact: true }).selectOption(model);
    await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await createProvider("工作模型 A", "model-a", "browser-fixture-key-A");
  await page.getByRole("button", { name: "测试 工作模型 A 的模型目录", exact: true }).click();
  await expect(page.getByText("模型目录可达 · 返回 2 个模型", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
  await createProvider("工作模型 B", "model-b", "browser-fixture-key-B");
  await page.screenshot({ path: join(artifact, "providers-desktop.png"), fullPage: true, animations: "disabled" });
  await responsive("providers");
  await page.getByRole("button", { name: "新对话", exact: false }).first().click();
  await page.getByLabel("选择 Harness", { exact: true }).selectOption("codex");
  await page.getByLabel("选择 Provider", { exact: true }).selectOption({ label: "工作模型 A" });
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("请梳理这个项目的运行链路");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(composer).toHaveValue("请梳理这个项目的运行链路");
  await composer.press("Shift+Enter"); await expect(composer).toHaveValue("请梳理这个项目的运行链路\n");
  await composer.press("Enter");
  const log = page.getByRole("log", { name: "对话历史" });
  await expect(log).toContainText("已由 model-a 处理");
  await expect(log).toContainText("凭据过滤验证：[redacted]");
  const origin = new URL(fixture.gateway.url).origin;
  async function snapshot() {
    const list = await (await context.request.get(origin + "/api/v1/sessions")).json() as { id: string }[];
    assert.equal(list.length, 1);
    return await (await context.request.get(origin + "/api/v1/sessions/" + list[0]!.id)).json() as { id: string; selection: { provider: { revision: number; model: string } }; runs: { status: string; selection: { provider: { revision: number; model: string } } }[]; epoch: number };
  }
  const first = await snapshot(); assert.equal(first.selection.provider.model, "model-a");
  // Lose a committed switch response while read delivery is delayed. Only transport is fault-injected;
  // the request still goes through the formal server, SQLite, Runtime and external process.
  const switchKeys: string[] = [];
  let releaseReads!: () => void, holdReads = true;
  const reads = new Promise<void>(done => { releaseReads = done; });
  t.after(() => { holdReads = false; releaseReads(); });
  await page.route("**/api/v1/sessions/" + first.id, async route => {
    if (holdReads) await reads;
    await route.continue();
  });
  await page.route("**/api/v1/sessions/" + first.id + "/switches", async route => {
    const payload: unknown = route.request().postDataJSON();
    assert.ok(payload !== null && typeof payload === "object" && "commandId" in payload && typeof payload.commandId === "string");
    switchKeys.push(payload.commandId);
    if (!droppedSwitchResponse) {
      const committed = await route.fetch(); assert.equal(committed.status(), 202);
      droppedSwitchResponse = true; await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.getByLabel("选择 Provider", { exact: true }).selectOption({ label: "工作模型 B" });
  await page.getByRole("button", { name: "应用选择", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法连接本机网关");
  await page.getByRole("button", { name: "应用选择", exact: true }).click();
  await expect.poll(() => switchKeys.length).toBe(2); assert.equal(switchKeys[0], switchKeys[1]);
  holdReads = false; releaseReads();
  await page.unroute("**/api/v1/sessions/" + first.id);
  await page.unroute("**/api/v1/sessions/" + first.id + "/switches");
  await expect(page.getByText("已生效", { exact: true }).first()).toBeVisible();
  await composer.fill("继续解释下一步"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(log).toContainText("已由 model-b 处理");
  let current = await snapshot(); assert.equal(current.epoch, 2); assert.equal(current.runs[0]!.selection.provider.model, "model-a"); assert.equal(current.runs[1]!.selection.provider.model, "model-b");
  await page.screenshot({ path: join(artifact, "chat-desktop.png"), fullPage: true, animations: "disabled" });
  await responsive("chat");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  await expect(page.getByLabel(/API Key/u)).toHaveValue("");
  await page.getByLabel("模型 ID 列表", { exact: true }).fill("model-b\nmodel-b2");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作模型 B", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByRole("button", { name: "配置 v1 · 使用最新 v2", exact: true })).toBeVisible();
  current = await snapshot(); assert.equal(current.selection.provider.revision, 1);
  await page.getByRole("button", { name: "配置 v1 · 使用最新 v2", exact: true }).click();
  await page.getByLabel("选择模型", { exact: true }).selectOption("model-b2");
  await page.getByRole("button", { name: "应用选择", exact: true }).click();
  await composer.fill("第三轮使用新版本"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(log).toContainText("已由 model-b2 处理");
  current = await snapshot(); assert.equal(current.runs[1]!.selection.provider.revision, 1); assert.equal(current.runs[2]!.selection.provider.revision, 2);
  await page.reload();
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("第三轮使用新版本");
  assert.equal((await snapshot()).id, first.id);
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("等待取消");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("已停止");
  current = await snapshot(); assert.equal(current.runs.at(-1)?.status, "cancelled");
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用这个 Provider", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("停用后不能发起新调用");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
  await createProvider("其他协议连接", "claude-fixture", "browser-fixture-key-C", "anthropic-messages");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  const providerPicker = page.getByLabel("选择 Provider", { exact: true });
  await expect(providerPicker.locator("option").filter({ hasText: "其他协议连接" })).toHaveJSProperty("disabled", true);
  await expect(providerPicker.locator("option").filter({ hasText: "其他协议连接" })).toHaveText("其他协议连接 · 协议不兼容");
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));
  await page.getByRole("button", { name: "Harnesses", exact: true }).click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新检测", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Codex", exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "harnesses-desktop.png"), fullPage: true, animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: join(artifact, `harnesses-${width}.png`), fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile layout has horizontal overflow");
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(expectedNetworkErrors, 1, "only the deliberately lost transport may log a network error");
  assert.ok(!(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes("browser-fixture-key"));
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));

});
