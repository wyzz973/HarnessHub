import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser } from "@playwright/test";
import { application } from "../../src/cli/session-application.js";
import { runManagementProcess } from "../../src/infrastructure/management/process.js";
import type { ManagementMetadataPort, ManagementInstallerPort } from "../../src/contracts/management.js";
import { startWebServer } from "../../src/web/server.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

const peer = fileURLToPath(new URL("../../../tests/fixtures/web-harness-peer.mjs", import.meta.url));
const artifact = resolve("artifacts/chat-v3");
async function launchFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-web-browser-")));
  const workspace = join(root, "workspace"), shim = join(root, "codex-fixture.mjs"); await mkdir(workspace);
  await writeFile(shim, "#!" + process.execPath + "\nimport " + JSON.stringify(pathToFileURL(peer).href) + ";\n", { mode: 0o700 });
  const manifest = join(root, "catalog.json"), authShim = join(root, "gateway-auth-fixture.mjs");
  await writeFile(authShim, "#!" + process.execPath + "\nprocess.stderr.write('unauthorized: gateway token missing\\n');process.exit(1);\n", { mode: 0o700 });
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [], overrides: { "codex-native": { executable: shim }, "openclaw-native": { executable: authShim } } }));
  const modelServer = createServer((req, res) => { assert.equal(req.method, "GET"); assert.equal(req.url, "/v1/models"); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] })); });
  await new Promise<void>(done => modelServer.listen(0, "127.0.0.1", done));
  const address = modelServer.address(); assert.ok(address && typeof address === "object");
  const metadata: ManagementMetadataPort = { resolve: async recipe => ({ recipe, version: fixtureVersion, artifactUrl: null, integrity: null, engines: {}, dependencies: [] }) };
  let fixtureVersion = "1.0.0";
  const installer: ManagementInstallerPort = { install: async (spec, ctx) => {
    assert.ok(spec.recipe.packageName);
    const code = "import {mkdir,writeFile} from 'node:fs/promises';import{join}from'node:path';const [stage,name,version,bin]=process.argv.slice(1);const root=join(stage,'node_modules',name);await mkdir(root,{recursive:true});await writeFile(join(root,'package.json'),JSON.stringify({name,version,bin:{[bin]:'entry.mjs'}}));await writeFile(join(root,'entry.mjs'),'process.exit(0);');console.log('Browser installation fixture '+version+' verified');";
    await runManagementProcess(process.execPath, ["--input-type=module", "-e", code, ctx.stage, spec.recipe.packageName, spec.version, spec.recipe.binName], ctx.stage, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: ctx.stage }, ctx);
    return { command: { executable: process.execPath, args: [join(ctx.stage, "node_modules", spec.recipe.packageName, "entry.mjs"), ...spec.recipe.args], env: {} }, observedVersion: spec.version, artifactSha256: null };
  } };
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0,
    application: (data, publish) => application(data, publish, { management: { metadata, installer }, nativeEnvironment: { home: root, values: { HOME: root, PATH: dirname(process.execPath) + ":/usr/bin:/bin" } } }) });
  return { root, gateway, setVersion: (value: string) => { fixtureVersion = value; }, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: async () => { await gateway.close(); modelServer.closeAllConnections(); await new Promise<void>(done => modelServer.close(() => done())); await rm(root, { recursive: true, force: true }); } };
}

test("real browser validates Provider management, public chat switching, cancellation and responsive layouts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture();
  let browser: Browser | null = null;
  // Own the listener before browser launch, so missing browser binaries cannot leak a live gateway.
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Fault-inject delivery of real SSE bytes, while preserving the server/store/runtime and all commands.
  await context.addInitScript(() => {
    const original = window.fetch.bind(window); let held = false;
    const waiters: Array<() => void> = [];
    Reflect.set(window, "__holdFactDelivery", (next: boolean) => { held = next; if (!held) for (const release of waiters.splice(0)) release(); });
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!url.includes("/events/stream") || !response.ok || response.body === null) return response;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ async transform(chunk, sink) {
        if (held) await new Promise<void>(resolve => waiters.push(resolve)); sink.enqueue(chunk);
      } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
  const page = await context.newPage(), errors: string[] = [];
  let droppedSwitchResponse = false, expectedNetworkErrors = 0, reusedLaunch = false, expectedAuthErrors = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (droppedSwitchResponse && message.text().includes("net::ERR_CONNECTION_RESET")) expectedNetworkErrors++;
    else if (reusedLaunch && message.location().url.endsWith("/api/v1/auth/bootstrap") && message.text().includes("401")) expectedAuthErrors++;
    else errors.push(message.text());
  });
  await page.goto(fixture.gateway.url); await page.waitForLoadState("networkidle");
  await page.screenshot({ path: join(artifact, "initial-desktop.png"), fullPage: true, animations: "disabled" });
  async function responsive(label: string) {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (label === "chat") await expect.poll(() => page.locator(".chat-scroll").evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(3);
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
  async function pick(label: string, value: string) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
  const harnessTrigger = page.getByRole("button", { name: "选择 Harness", exact: true });
  await harnessTrigger.click();
  const search = page.getByRole("combobox", { name: "搜索 Harness", exact: true });
  await expect(search).toBeFocused();
  await search.fill("no-such-harness-fixture");
  await expect(page.getByText("没有匹配的选项", { exact: true })).toBeVisible();
  await search.fill("Codex");
  await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(search).toBeVisible();
  await search.press("ArrowDown"); await search.press("Enter");
  await expect(harnessTrigger).toContainText("Codex"); await expect(harnessTrigger).toBeFocused();
  await harnessTrigger.click();
  await page.screenshot({ path: join(artifact, "harness-picker-desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.locator(".picker-popover")).toBeVisible();
  // Floating placement follows viewport resize asynchronously; assert the observed settled bounds.
  await expect.poll(async () => {
    const bounds = await page.locator(".picker-popover").boundingBox();
    return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 320;
  }, { message: "picker remains inside narrow viewport after placement settles" }).toBe(true);
  await page.screenshot({ path: join(artifact, "harness-picker-320.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(harnessTrigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await harnessTrigger.click();
  const duration = await page.locator(".picker-popover").evaluate(element => {
    const style = getComputedStyle(element);
    return [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)));
  });
  assert.ok(duration.every(value => value <= 1), "reduced motion disables picker animation");
  await page.keyboard.press("Escape"); await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await pick("选择 Provider", "工作模型 A");
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("请梳理这个项目的运行链路");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(composer).toHaveValue("请梳理这个项目的运行链路");
  await composer.press("Shift+Enter"); await expect(composer).toHaveValue("请梳理这个项目的运行链路\n");
  await composer.press("Enter");
  const log = page.getByRole("log", { name: "对话历史" });
  try { await expect(log).toContainText("已由 model-a 处理"); }
  catch (failure) {
    await page.screenshot({ path: join(artifact, "stream-failure.png"), fullPage: true, animations: "disabled" });
    const base = new URL(fixture.gateway.url).origin;
    const list: unknown = await (await context.request.get(base + "/api/v1/sessions")).json();
    const observations: unknown[] = [];
    if (Array.isArray(list)) for (const item of list) {
      if (item !== null && typeof item === "object" && "id" in item && typeof item.id === "string") observations.push(await (await context.request.get(base + "/api/v1/sessions/" + item.id)).json());
    }
    await writeFile(join(artifact, "stream-failure.json"), JSON.stringify({ errors, body: (await page.locator("body").innerText()).slice(0, 4000), observations }));
    throw failure;
  }
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
  await page.evaluate(() => { const hold = Reflect.get(window, "__holdFactDelivery"); if (typeof hold !== "function") throw new Error("missing fact delivery fixture"); hold(true); });
  t.after(async () => { if (!page.isClosed()) await page.evaluate(() => { const hold = Reflect.get(window, "__holdFactDelivery"); if (typeof hold === "function") hold(false); }); });
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
  await pick("选择 Provider", "工作模型 B");
  await expect(page.getByRole("alert")).toContainText("暂时无法连接本机网关");
  await page.getByRole("button", { name: "重试切换", exact: true }).click();
  await expect.poll(() => switchKeys.length).toBe(2); assert.equal(switchKeys[0], switchKeys[1]);
  holdReads = false; releaseReads();
  await page.evaluate(() => { const hold = Reflect.get(window, "__holdFactDelivery"); if (typeof hold === "function") hold(false); });
  await page.unroute("**/api/v1/sessions/" + first.id);
  await page.unroute("**/api/v1/sessions/" + first.id + "/switches");
  await expect(page.getByRole("button", { name: "选择 Provider", exact: true })).toContainText("工作模型 B");
  await expect.poll(async () => (await snapshot()).epoch).toBe(2);
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
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await expect(page.getByRole("button", { name: "使用最新 v2", exact: true })).toBeVisible();
  current = await snapshot(); assert.equal(current.selection.provider.revision, 1);
  await page.getByRole("button", { name: "使用最新 v2", exact: true }).click();
  await page.getByRole("button", { name: "收起高级配置", exact: true }).click();
  await pick("选择模型", "model-b2");
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
  await expect(page.getByRole("heading", { name: "模型连接", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("停用后不能发起新调用");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
  await createProvider("其他协议连接", "claude-fixture", "browser-fixture-key-C", "anthropic-messages");
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Provider", exact: true }).click();
  await expect(page.getByRole("option", { name: "其他协议连接", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));
  await page.getByRole("button", { name: "Harnesses", exact: true }).click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新检测", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "查看 Codex 详情", exact: true })).toBeVisible();
  const brandImages = page.locator(".harness-table-row img.brand-icon");
  await expect(brandImages).toHaveCount(await page.locator(".harness-table-row").count());
  await expect.poll(() => brandImages.evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  const target = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 Autohand Code 详情", exact: true }) });
  await target.getByRole("button", { name: "安装", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("安装完成", { exact: true })).toBeVisible();
  await detail.getByText("安装日志", { exact: false }).first().click();
  await expect(detail.getByRole("log", { name: "安装日志" })).toContainText("1.0.0 verified");
  await page.screenshot({ path: join(artifact, "install-detail.png"), fullPage: true, animations: "disabled" });
  fixture.setVersion("2.0.0");
  await detail.getByRole("button", { name: "检查 Autohand Code 更新", exact: true }).click();
  await expect(detail.getByText("有新版本", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "升级 Harness", exact: true }).click();
  await expect.poll(async () => {
    const jobs: unknown = await (await context.request.get(origin + "/api/v1/installation-jobs")).json();
    assert.ok(Array.isArray(jobs));
    return jobs.length === 2 && jobs.every(job => job !== null && typeof job === "object" && "status" in job && job.status === "completed");
  }).toBe(true);
  await expect(detail.getByText("2.0.0", { exact: true }).first()).toBeVisible();
  await expect(detail.getByRole("status").filter({ hasText: "安装完成" })).toBeVisible();
  await expect(detail.getByText("当前已是最新", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "已是最新", exact: true })).toBeDisabled();
  await page.screenshot({ path: join(artifact, "upgrade-detail.png"), fullPage: true, animations: "disabled" });
  await detail.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click();
  await expect(target.getByRole("button", { name: "开始对话", exact: true })).toBeVisible();
  await expect(target.getByRole("button", { name: "升级", exact: true })).toHaveCount(0);
  await page.locator(".harness-management-body").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(artifact, "harnesses-desktop.png"), fullPage: true, animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: join(artifact, `harnesses-${width}.png`), fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile layout has horizontal overflow");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  reusedLaunch = true; await page.goto(fixture.gateway.url); await page.reload();
  await expect(page.getByRole("heading", { name: "从一个想法，开始协作。", exact: true })).toBeVisible();
  assert.equal(expectedAuthErrors, 1, "reusing a launch token is denied even though the authenticated cookie remains valid");
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(expectedNetworkErrors, 1, "only the deliberately lost transport may log a network error");
  assert.ok(!(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes("browser-fixture-key"));
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));

});

test("live chat renders committed partial Markdown before completion, respects reading position and reconnects without another Run", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 943, height: 1079 } });
  // Clipboard is the external platform effect; keep test data in this browser context, not the user's clipboard.
  await context.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { Object.defineProperty(window, "__fixtureCopiedText", { configurable: true, value: text }); } } }); });
  const page = await context.newPage(), errors: string[] = [], streamRequests: string[] = [], imageRequests: string[] = [];
  let droppedMessageAck = false, expectedMessageAckErrors = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") {
    if (droppedMessageAck && message.text().includes("net::ERR_CONNECTION_RESET")) expectedMessageAckErrors++;
    else errors.push(message.text());
  } });
  page.on("request", request => {
    if (request.url().includes("/events/stream")) streamRequests.push(request.url());
    if (request.url().includes("example.invalid/chat-image")) imageRequests.push(request.url());
  });
  function object(value: unknown): Record<string, unknown> { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
  const launch = new URL(fixture.gateway.url), origin = launch.origin;
  const boot = await context.request.post(origin + "/api/v1/auth/bootstrap", { headers: { Origin: origin }, data: { token: new URLSearchParams(launch.hash.slice(1)).get("token") } });
  assert.equal(boot.status(), 200); const auth = object(await boot.json()); assert.equal(typeof auth.csrfToken, "string");
  const created = await context.request.post(origin + "/api/v1/providers", { headers: { Origin: origin, "X-CSRF-Token": String(auth.csrfToken) }, data: { commandId: "stream-provider", input: {
    name: "流式验收模型", protocol: "openai-responses", baseUrl: fixture.baseUrl, models: ["model-a"], defaultModel: "model-a", enabled: true, apiKey: "synthetic-stream-fixture-key",
  } } }); assert.equal(created.status(), 201);
  await page.goto(origin); await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeVisible();
  for (const [label, value] of [["选择 Harness", "Codex"], ["选择 Provider", "流式验收模型"]] as const) {
    await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click();
  }
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.route("**/api/v1/sessions/*/messages", async route => {
    if (droppedMessageAck) { await route.continue(); return; }
    const receipt = await route.fetch(); assert.equal(receipt.status(), 202);
    // Deliver committed facts before dropping the ACK. The UI already knows this request was received.
    await expect(log).toContainText("STREAM_RENDER：逐段展示，完成前保持连接");
    droppedMessageAck = true; await route.abort("connectionreset");
  });
  await composer.fill("STREAM_RENDER：逐段展示，完成前保持连接"); await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(log).toContainText("第一段已经到达。");
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true })).toBeEnabled();
  await expect(log.locator("pre")).toContainText('const answer = "par');
  assert.ok(streamRequests.length >= 1, "partial output is transported on the live session stream");
  async function current() {
    const list: unknown = await (await context.request.get(origin + "/api/v1/sessions")).json(); assert.ok(Array.isArray(list) && list.length === 1);
    const id = object(list[0]).id; assert.equal(typeof id, "string");
    const snapshot = object(await (await context.request.get(origin + "/api/v1/sessions/" + String(id))).json());
    assert.ok(Array.isArray(snapshot.runs)); assert.ok(Array.isArray(snapshot.messages));
    return { id: String(id), snapshot, runs: snapshot.runs.map(object), messages: snapshot.messages.map(object) };
  }
  const first = await current(); assert.equal(first.runs.length, 1); assert.equal(first.runs[0]!.status, "running");
  assert.ok(!String(first.messages.at(-1)?.text).includes("第三段完成"), "backend is held before the final text and terminal result");
  const scroll = page.locator(".chat-scroll");
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);
  await page.screenshot({ path: join(artifact, "streaming-943.png"), fullPage: true, animations: "disabled" });
  await scroll.evaluate(element => { element.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "回到最新回复", exact: true })).toBeVisible();
  async function step(stage: string) {
    const pending = join(fixture.root, "workspace", "next-stream-control.json"), target = join(fixture.root, "workspace", "stream-control.json");
    await writeFile(pending, JSON.stringify({ stage })); await rename(pending, target);
  }
  await step("second");
  await expect(log).toContainText("第二段正在生成。");
  await expect(log.getByRole("table")).toContainText("SSE");
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(5);
  assert.equal((await current()).runs[0]!.status, "running");
  await page.getByRole("button", { name: "回到最新回复", exact: true }).click();
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4);
    const height = await page.locator(".composer").evaluate(element => element.getBoundingClientRect().height);
    assert.ok(height <= 140, "empty mobile composer remains compact while a response streams");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "live Markdown does not overflow narrow viewport");
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), "long replies only scroll inside the transcript, without empty document overflow");
    await page.screenshot({ path: join(artifact, `streaming-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 943, height: 1079 });
  await page.reload();
  await expect(log).toContainText("第二段正在生成。");
  assert.ok(streamRequests.length >= 2, "reload opens a new fact connection");
  const resumed = await current(); assert.equal(resumed.id, first.id); assert.equal(resumed.runs.length, 1); assert.equal(resumed.runs[0]!.status, "running");
  assert.equal(String(resumed.messages.at(-1)?.text).split("第一段已经到达。").length - 1, 1, "reconnecting replaces canonical text rather than appending replayed output");
  await step("finish"); await expect(log).toContainText("第三段完成。");
  await expect.poll(async () => (await current()).runs[0]!.status).toBe("completed");
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true })).toHaveCount(0);
  assert.equal(await page.evaluate(() => "__unsafeChatScript" in window), false); assert.deepEqual(imageRequests, []);
  await expect(log.getByText("本轮结束", { exact: true })).toHaveCount(0);
  await page.locator(".assistant-message").last().hover();
  await log.getByRole("button", { name: "复制回复", exact: true }).last().click();
  await expect(log.getByRole("button", { name: "已复制回复", exact: true })).toBeVisible();
  const copied: unknown = await page.evaluate(() => Reflect.get(window, "__fixtureCopiedText"));
  assert.equal(copied, String((await current()).messages.at(-1)?.text), "copy uses canonical Markdown, not display-only repaired text");
  await log.getByRole("button", { name: "执行详情", exact: true }).last().click();
  await expect(log.getByText("流式验收模型", { exact: true })).toBeVisible();
  await log.getByRole("button", { name: "执行详情", exact: true }).last().click();
  await page.screenshot({ path: join(artifact, "chat-completed-943.png"), fullPage: true, animations: "disabled" });
  await log.getByRole("button", { name: "放回输入框", exact: true }).first().click();
  await expect(composer).toHaveValue("STREAM_RENDER：逐段展示，完成前保持连接"); assert.equal((await current()).runs.length, 1, "editing a draft does not re-dispatch a Run");
  await composer.fill("STREAM_CANCEL：保留已经收到的部分内容"); await composer.press("Enter");
  await expect(page.locator('.assistant-message[data-run-status="running"]')).toContainText("第一段已经到达。");
  const partial = await current(); assert.equal(partial.runs.length, 2); assert.equal(partial.runs[1]!.status, "running");
  assert.ok(String(partial.messages.at(-1)?.text).includes("第一段已经到达。"));
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("已停止");
  const stopped = await current(); assert.equal(stopped.runs.length, 2); assert.equal(stopped.runs[1]!.status, "cancelled");
  assert.ok(String(stopped.messages.at(-1)?.text).includes("第一段已经到达。"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page.locator(".assistant-message").last().evaluate(element => {
    const style = getComputedStyle(element); return [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)));
  }); assert.ok(motion.every(value => value <= 1));
  await page.screenshot({ path: join(artifact, "chat-cancelled-943.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "关闭这个对话", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "结束这次会话？", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续对话", exact: true }).click();
  assert.equal((await current()).snapshot.status, "open");
  await page.getByRole("button", { name: "关闭这个对话", exact: true }).click();
  await page.getByRole("button", { name: "结束会话", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "对话已关闭，可查看历史" })).toBeVisible();
  await expect(page.getByText("可以继续对话", { exact: true })).toHaveCount(0);
  assert.equal((await current()).snapshot.status, "closed");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeDisabled();
  await expect(log).toContainText("第一段已经到达。");
  await expect(page.getByText("可以继续对话", { exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []); assert.equal(expectedMessageAckErrors, 1);
  assert.ok(!(await page.locator("body").innerText()).includes("synthetic-stream-fixture-key"));
});

test("failed Harness selection keeps the same conversation usable, shows recovery actions and preserves per-chat drafts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 943, height: 1079 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const launch = new URL(fixture.gateway.url), origin = launch.origin;
  const boot = await context.request.post(origin + "/api/v1/auth/bootstrap", { headers: { Origin: origin }, data: { token: new URLSearchParams(launch.hash.slice(1)).get("token") } });
  assert.equal(boot.status(), 200); const auth = await boot.json();
  const provider = await context.request.post(origin + "/api/v1/providers", { headers: { Origin: origin, "X-CSRF-Token": String(auth.csrfToken) }, data: { commandId: "recovery-provider", input: {
    name: "可用模型连接", protocol: "openai-responses", baseUrl: fixture.baseUrl, models: ["model-a"], defaultModel: "model-a", enabled: true, apiKey: "synthetic-recovery-key",
  } } }); assert.equal(provider.status(), 201);
  await page.goto(origin);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  const current = async () => {
    const id = new URL(page.url()).hash.slice(1).split("session=")[1]; assert.ok(id);
    const response = await context.request.get(origin + "/api/v1/sessions/" + id); assert.equal(response.status(), 200); return await response.json();
  };
  await pick("选择 Harness", "Codex"); await pick("选择 Provider", "可用模型连接");
  await composer.fill("FIRST_CONVERSATION"); await composer.press("Enter"); await expect(log).toContainText("已由");
  await expect.poll(async () => (await current()).runs[0].status).toBe("completed"); const first = await current();
  await composer.fill("选择失败也要保留这条草稿");
  await pick("选择 Harness", "OpenClaw"); await pick("选择 Provider", "Harness 原生连接");
  await expect(page.getByText("未能切换到 OpenClaw", { exact: true })).toBeVisible();
  await expect(page.locator(".selection-failure").getByText(/尚未配置 Gateway 认证/)).toBeVisible();
  await expect(composer).toBeEnabled(); await expect(composer).toHaveValue("选择失败也要保留这条草稿");
  const failed = await current(); assert.equal(failed.id, first.id); assert.equal(failed.status, "open"); assert.equal(failed.runs.length, 1);
  assert.equal(failed.selection.harnessId, "codex"); assert.equal(failed.switches[0].error.code, "GATEWAY_AUTH_REQUIRED");
  await page.screenshot({ path: join(artifact, "harness-selection-failed.png"), fullPage: true, animations: "disabled" });
  const modelReload = page.waitForResponse(response => response.url().includes("/harnesses/openclaw/models"));
  await page.reload(); await modelReload;
  await expect(page.getByText("未能切换到 OpenClaw", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("选择失败也要保留这条草稿");
  assert.equal((await current()).switches.length, failed.switches.length, "refresh must not retry an already failed selection");
  await page.getByRole("button", { name: "继续使用当前选择", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择 Harness", exact: true })).toContainText("Codex");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await composer.press("Enter"); await expect.poll(async () => (await current()).runs[1]?.status).toBe("completed");
  assert.equal((await current()).id, first.id);
  await composer.fill("FAIL_ONCE：由用户明确重试"); await composer.press("Enter");
  await expect.poll(async () => (await current()).runs[2]?.status).toBe("failed");
  await page.locator(".assistant-message").last().hover(); await page.getByRole("button", { name: "重试回复", exact: true }).last().click();
  await expect.poll(async () => (await current()).runs[3]?.status).toBe("completed");
  const retried = await current(); assert.equal(retried.runs[2].status, "failed"); assert.notEqual(retried.runs[2].id, retried.runs[3].id);
  await composer.fill("第一段对话的未发送草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await pick("选择 Harness", "Codex"); await pick("选择 Provider", "可用模型连接");
  await composer.fill("SECOND_CONVERSATION"); await composer.press("Enter"); await expect(page).toHaveURL(/#session=/u); await expect.poll(async () => (await current()).runs[0]?.status).toBe("completed");
  const second = await current(); assert.notEqual(second.id, first.id); await composer.fill("第二段对话的未发送草稿");
  await page.getByRole("button", { name: "FIRST_CONVERSATION", exact: true }).click();
  await expect(composer).toHaveValue("第一段对话的未发送草稿"); assert.equal((await current()).runs.length, 4);
  await page.getByRole("button", { name: "SECOND_CONVERSATION", exact: true }).click();
  await expect(composer).toHaveValue("第二段对话的未发送草稿"); assert.equal((await current()).runs.length, 1);
  await page.reload(); await expect(composer).toHaveValue("第二段对话的未发送草稿"); assert.equal((await current()).runs.length, 1);
  await page.getByRole("button", { name: "新对话", exact: true }).click(); await composer.fill("新对话尚未发送的草稿");
  await page.getByRole("button", { name: "FIRST_CONVERSATION", exact: true }).click();
  await page.getByRole("button", { name: "新对话", exact: true }).click(); await expect(composer).toHaveValue("新对话尚未发送的草稿");
  await page.reload(); await expect(composer).toHaveValue("新对话尚未发送的草稿");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifact, "preserved-chat-drafts.png"), fullPage: true, animations: "disabled" });
  await expect.poll(() => page.evaluate(() => Object.entries(sessionStorage).some(([key, value]) => key.startsWith("harnessgateway:chat-draft:") && key.endsWith(":new") && JSON.parse(value).message === "新对话尚未发送的草稿"))).toBe(true);
  await page.evaluate(() => {
    const entry = Object.entries(sessionStorage).find(([key]) => key.startsWith("harnessgateway:chat-draft:") && key.endsWith(":new")); if (!entry) throw new Error("owned draft was not saved");
    const value = JSON.parse(entry[1]); value.unrecognizedCredential = "synthetic-untrusted-cache-value"; sessionStorage.setItem(entry[0], JSON.stringify(value));
  });
  await page.reload(); await expect(composer).toHaveValue("");
  const unchanged = await (await context.request.get(origin + "/api/v1/sessions")).json(); assert.equal(unchanged.length, 2, "invalid cached drafts cannot create or submit a conversation");
  assert.deepEqual(errors, []);
});

test("native model selection follows the installed Harness and rapid choices switch directly without Apply", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 943, height: 1079 } }), page = await context.newPage();
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  await pick("选择 Harness", "Codex"); await expect(page.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
  await pick("选择模型", "Native B"); await composer.fill("NATIVE_FIRST：沿用本机配置"); await composer.press("Enter");
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("已由 native-b 处理");
  const origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  await expect.poll(async () => (await current()).runs[0].status).toBe("completed"); const first = await current(); assert.equal(first.selection.nativeModel, "native-b");
  await composer.fill("切换期间保留这个草稿");
  await pick("选择模型", "Native A"); await pick("选择模型", "Native B");
  await expect.poll(async () => { const value = await current(); return value.pendingSwitchId === null && value.selection.nativeModel === "native-b"; }).toBe(true);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "应用选择", exact: true })).toHaveCount(0); await expect(composer).toHaveValue("切换期间保留这个草稿");
  await composer.press("Enter"); await expect.poll(async () => (await current()).runs[1]?.status).toBe("completed");
  const latest = await current(); assert.equal(latest.id, first.id); assert.equal(latest.runs[1].selection.nativeModel, "native-b");
  await composer.fill("FAIL_ONCE：检查重试按钮布局"); await composer.press("Enter"); await expect.poll(async () => (await current()).runs[2]?.status).toBe("failed");
  await page.locator(".assistant-message").last().hover();
  for (const width of [943, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const retry = page.getByRole("button", { name: "重试回复", exact: true }).last();
    const box = await retry.boundingBox(); assert.ok(box && box.width >= 90 && box.height <= 36, "retry label remains horizontal");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(artifact, `native-models-${width}.png`), fullPage: true, animations: "disabled" });
  }
});
