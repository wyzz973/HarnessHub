import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { application } from "../../src/cli/session-application.js";
import { runManagementProcess } from "../../src/infrastructure/management/process.js";
import type { ManagementMetadataPort, ManagementInstallerPort } from "../../src/contracts/management.js";
import { startWebServer } from "../../src/web/server.js";
import { prepareConfiguration } from "../../src/infrastructure/session/binding-factory.js";

/**
 * A browser context that answers any request for Google Fonts locally and empty. The page asks for none since ADR-054 §2
 * (G054-FR6 and G054-DL1 prove it); the route stays as a guard, so a regression could not make a test depend on Google.
 */
async function isolatedContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext(options);
  await context.route(/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//u, route => route.fulfill({ status: 200, contentType: route.request().url().includes("googleapis") ? "text/css" : "font/woff2", body: "" }));
  return context;
}
const peer = fileURLToPath(new URL("../../../tests/fixtures/web-harness-peer.mjs", import.meta.url));
const controlPeer = pathToFileURL(fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url))).href;
const artifact = resolve("artifacts/chat-v3");
/**
 * The control-peer's ACP agent in `scenario` under a catalog Harness's own entry (ADR-050 tests): `--version` answers
 * `version`, the way the Gateway's version probe asks, and anything else starts the agent.
 */
function catalogShim(version: string, scenario: string): string {
  return "#!" + process.execPath + "\nif (process.argv.includes(\"--version\")) { process.stdout.write(" + JSON.stringify(version + "\n") + "); process.exit(0); }\n"
    + "process.argv.splice(2, Infinity, \"acp-v1\", " + JSON.stringify(scenario) + ");\nawait import(" + JSON.stringify(controlPeer) + ");\n";
}
async function launchFixture(providerManagement = true, nativeAcp: { readonly name: string; readonly scenario: string; readonly env?: Readonly<Record<string, string>> } | null = null, nativeCodex: { readonly name: string; readonly scenario: string } | null = null, hermes = false,
  budgets?: { readonly executionBudgetMs: number; readonly waitBudgetMs: number }, loginShell?: { readonly shell: string; readonly shells: string },
  /**
   * Catalog Harnesses the control-peer stands in for, by the version their entry reports. With any, discovery's PATH holds
   * Node.js alone instead of its whole directory, where this computer's own `dsh` or `claude` may be installed.
   */
  shims: { readonly gemini?: string; readonly dsh?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "harness-web-browser-")));
  const workspace = join(root, "workspace"), shim = join(root, "codex-fixture.mjs"); await mkdir(workspace);
  await writeFile(shim, "#!" + process.execPath + "\nimport " + JSON.stringify(pathToFileURL(peer).href) + ";\n", { mode: 0o700 });
  // Hermes 0.12 as its own entry: the control-peer's Hermes behaviour under the version whose approvals wait 60 seconds.
  const hermesShim = join(root, "hermes-fixture.mjs");
  if (hermes) await writeFile(hermesShim, "#!" + process.execPath + "\nprocess.argv.splice(2, Infinity, \"acp-v1\", \"hermes\");\nprocess.env.FIXTURE_AGENT_VERSION = \"0.12.0\";\nawait import("
    + JSON.stringify(controlPeer) + ");\n", { mode: 0o700 });
  // The 0.12 checkout the shim stands for: acp_adapter/server.py without gateway_server.py, so the gateway preflight (ADR-051
  // A2) sees an in-process agent and starts it instead of judging the fixture home against a gateway it never has.
  if (hermes) { await mkdir(join(root, ".hermes", "hermes-agent", "acp_adapter"), { recursive: true }); await writeFile(join(root, ".hermes", "hermes-agent", "acp_adapter", "server.py"), "# fixture: Hermes 0.12 runs its ACP sessions in-process\n"); }
  const geminiShim = join(root, "gemini-fixture.mjs"), dshShim = join(root, "dsh-fixture.mjs"), nodeOnly = join(root, "node-bin");
  if (shims.gemini !== undefined) await writeFile(geminiShim, catalogShim(shims.gemini, "basic"), { mode: 0o700 });
  // DeepSeek Harness keeps its sessions for loading again, as the "native-resume" scenario does.
  if (shims.dsh !== undefined) await writeFile(dshShim, catalogShim(shims.dsh, "native-resume"), { mode: 0o700 });
  const isolated = shims.gemini !== undefined || shims.dsh !== undefined;
  if (isolated) { await mkdir(nodeOnly); await symlink(process.execPath, join(nodeOnly, "node")); }
  const manifest = join(root, "catalog.json"), authShim = join(root, "gateway-auth-fixture.mjs");
  await writeFile(authShim, "#!" + process.execPath + "\nprocess.stderr.write('unauthorized: gateway token missing\\n');process.exit(1);\n", { mode: 0o700 });
  // An ACP agent whose native command changes one of its own settings and announces it (control-peer "native-config").
  const acp = nativeAcp === null ? null : { id: "native-acp", name: nativeAcp.name, aliases: [], binaryNames: [], configHints: [], controls: [{ id: "native-acp", protocol: "acp-v1", executableNames: ["fixture"],
    args: [fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url)), "acp-v1", nativeAcp.scenario], env: nativeAcp.env ?? {}, package: null, distribution: null, requiredExecutables: [],
    source: { repository: "fixture", revision: nativeAcp.scenario, upstreamId: "fixture", url: "https://example.invalid/" + nativeAcp.scenario } }] };
  // A Codex app-server fixture under its own entry, for scenarios the default Codex shim cannot select (plan mode).
  const codex = nativeCodex === null ? null : { id: "native-codex", name: nativeCodex.name, aliases: [], binaryNames: [], configHints: [], controls: [{ id: "native-codex", protocol: "codex-app-server", executableNames: ["fixture"],
    args: [fileURLToPath(new URL("../../../tests/fixtures/control-peer.mjs", import.meta.url)), "codex-app-server", nativeCodex.scenario], env: {}, package: null, distribution: null, requiredExecutables: [],
    source: { repository: "fixture", revision: nativeCodex.scenario, upstreamId: "fixture", url: "https://example.invalid/" + nativeCodex.scenario } }] };
  await writeFile(manifest, JSON.stringify({ version: 2, definitions: [...(acp ? [acp] : []), ...(codex ? [codex] : [])], overrides: { "codex-native": { executable: shim }, "openclaw-native": { executable: authShim }, ...(hermes ? { "hermes-native": { executable: hermesShim } } : {}),
    ...(acp ? { "native-acp": { executable: process.execPath } } : {}), ...(codex ? { "native-codex": { executable: process.execPath } } : {}),
    ...(shims.gemini !== undefined ? { "gemini-npm": { executable: geminiShim } } : {}), ...(shims.dsh !== undefined ? { "dsh-native": { executable: dshShim } } : {}) } }));
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
  let composed: ReturnType<typeof application> | null = null;
  const gateway = await startWebServer({ root: join(root, "data"), configuration: await prepareConfiguration({ workspace, manifestPath: manifest, pathOnly: true }), port: 0, providerManagement, ...(loginShell === undefined ? {} : { loginShell }),
    // The fixture's Harnesses are discovery-manifest entries, which only a development Gateway reads (ADR-044).
    application: (data, publish) => (composed = application(data, publish, { installations: "any", management: { installationMode: "private-fixture", metadata, installer }, nativeEnvironment: { home: root, values: { HOME: root, PATH: (isolated ? nodeOnly : dirname(process.execPath)) + ":/usr/bin:/bin" } }, ...(budgets === undefined ? {} : { budgets }), workspaceLockRoot: join(root, "locks") })) });
  return { root, gateway, runtime: () => { assert.ok(composed); return composed.runtime; }, setVersion: (value: string) => { fixtureVersion = value; }, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: async () => { await gateway.close(); modelServer.closeAllConnections(); await new Promise<void>(done => modelServer.close(() => done())); await rm(root, { recursive: true, force: true }); } };
}
/** The settings switch that lists the frozen Harnesses (Cursor, Gemini CLI, Pi) for new work as well (ADR-050). */
const FROZEN_SWITCH = "显示冻结的 Harness（Cursor、Gemini CLI、Pi）";
/** Shows the frozen Harnesses through the settings page, as a user does; the page stays on the settings. */
async function showFrozenHarnesses(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
  const toggle = page.getByRole("switch", { name: FROZEN_SWITCH });
  await toggle.click(); await expect(toggle).toBeChecked();
}

test("real browser validates Provider management, public chat switching, cancellation and responsive layouts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture();
  let browser: Browser | null = null;
  // Own the listener before browser launch, so missing browser binaries cannot leak a live gateway.
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 1000 } });
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
  // The waiting-request stream stays open while the page is (ADR-035), so the network never goes idle: wait for the shell.
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible(); await expect(page.locator(".session-section")).toBeVisible();
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

  await page.getByRole("button", { name: "模型与账号", exact: true }).click();
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
  // Reduced motion leaves popups only a fade of 150 ms or less (ADR-054 §3): the picker neither grows nor moves.
  const motion = await page.locator(".picker-popover").evaluate(element => {
    const style = getComputedStyle(element);
    return { properties: style.transitionProperty, durations: [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000))) };
  });
  assert.ok(motion.durations.every(value => value <= 150) && motion.properties.split(",").every(property => property.trim() === "opacity"), "reduced motion leaves the picker only a short fade: " + motion.properties + " " + motion.durations.join(","));
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
  await page.getByRole("button", { name: "模型与账号", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  await expect(page.getByLabel(/API Key/u)).toHaveValue("");
  await page.getByLabel("模型 ID 列表", { exact: true }).fill("model-b\nmodel-b2");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作模型 B", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
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
  await expect(page.getByRole("log")).toContainText("已取消（用户停止）");
  current = await snapshot(); assert.equal(current.runs.at(-1)?.status, "cancelled");
  await page.getByRole("button", { name: "模型与账号", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用这个 Provider", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型连接", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("停用后不能发起新调用");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "模型与账号", exact: true }).click();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
  await createProvider("其他协议连接", "claude-fixture", "browser-fixture-key-C", "anthropic-messages");
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Provider", exact: true }).click();
  await expect(page.getByRole("option", { name: "其他协议连接", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
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
  // A completed upgrade is said as one (ADR-043); the first task above was an installation.
  await expect(detail.getByRole("status").filter({ hasText: "升级完成" })).toBeVisible();
  await expect(detail.getByText("当前渠道无需升级", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "今天想让哪个 Agent 做什么？", exact: true })).toBeVisible();
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
  const context = await isolatedContext(browser, { viewport: { width: 943, height: 1079 } });
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
    assert.ok(height <= 140, "empty mobile composer remains compact while a response streams: " + height + "px " + JSON.stringify(await page.locator(".composer").innerText()));
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
  // At this width the details panel opens as a drawer over the conversation, with the Turn's execution facts.
  await log.getByRole("button", { name: "执行详情", exact: true }).last().click();
  await expect(page.getByRole("complementary", { name: "详情栏" }).getByText("流式验收模型", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭详情栏", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "详情栏" })).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "chat-completed-943.png"), fullPage: true, animations: "disabled" });
  await log.getByRole("button", { name: "放回输入框", exact: true }).first().click();
  await expect(composer).toHaveValue("STREAM_RENDER：逐段展示，完成前保持连接"); assert.equal((await current()).runs.length, 1, "editing a draft does not re-dispatch a Run");
  await composer.fill("STREAM_CANCEL：保留已经收到的部分内容"); await composer.press("Enter");
  await expect(page.locator('.assistant-message[data-run-status="running"]')).toContainText("第一段已经到达。");
  const partial = await current(); assert.equal(partial.runs.length, 2); assert.equal(partial.runs[1]!.status, "running");
  assert.ok(String(partial.messages.at(-1)?.text).includes("第一段已经到达。"));
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect(page.locator(".assistant-message").last()).toContainText("已取消（用户停止）");
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

test("unavailable native authentication keeps the same conversation usable, shows recovery actions and preserves per-chat drafts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 943, height: 1079 } }), page = await context.newPage(), errors: string[] = [];
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
  // An Agent's catalog arrives just after it is chosen and the merged picker re-flows (its model and pill change): the next
  // part is pressed once it has, so the press does not straddle the move.
  const agent = async (name: string) => { await pick("选择 Harness", name); await expect(page.getByRole("button", { name: "选择模型", exact: true })).not.toHaveText(/读取/u); };
  const current = async () => {
    const id = new URL(page.url()).hash.slice(1).split("session=")[1]; assert.ok(id);
    const response = await context.request.get(origin + "/api/v1/sessions/" + id); assert.equal(response.status(), 200); return await response.json();
  };
  await agent("Codex"); await pick("选择 Provider", "可用模型连接");
  await composer.fill("FIRST_CONVERSATION"); await composer.press("Enter"); await expect(log).toContainText("已由");
  await expect.poll(async () => (await current()).runs[0].status).toBe("completed"); const first = await current();
  await composer.fill("选择失败也要保留这条草稿");
  await agent("OpenClaw"); await pick("选择 Provider", "Harness 原生连接");
  await expect(page.getByText(/本机认证尚未就绪/)).toBeVisible();
  await expect(page.getByRole("button",{name:"发送消息",exact:true})).toBeDisabled();
  // The picker shows what the latest catalog read and Runs found, before anything else is sent.
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await expect(page.getByRole("option", { name: "OpenClaw", exact: true })).toHaveAccessibleDescription(/需要登录/);
  await expect(page.getByRole("option", { name: "Codex", exact: true })).toHaveAccessibleDescription(/启动约 \d+ 秒/);
  await page.keyboard.press("Escape");
  await expect(composer).toBeEnabled(); await expect(composer).toHaveValue("选择失败也要保留这条草稿");
  const failed = await current(); assert.equal(failed.id, first.id); assert.equal(failed.status, "open"); assert.equal(failed.runs.length, 1);
  assert.equal(failed.selection.harnessId,"openclaw"); assert.equal(failed.switches.at(-1).status,"effective");
  await page.screenshot({ path: join(artifact, "harness-selection-failed.png"), fullPage: true, animations: "disabled" });
  const modelReload = page.waitForResponse(response => response.url().includes("/harnesses/openclaw/models"));
  await page.reload(); await modelReload;
  await expect(page.getByText(/本机认证尚未就绪/)).toBeVisible();
  await expect(composer).toHaveValue("选择失败也要保留这条草稿");
  assert.equal((await current()).switches.length, failed.switches.length, "refresh must not retry an already failed selection");
  await agent("Codex"); await pick("选择 Provider","可用模型连接");
  await expect(page.getByRole("button", { name: "选择 Harness", exact: true })).toContainText("Codex");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await composer.press("Enter"); await expect.poll(async () => (await current()).runs[1]?.status).toBe("completed");
  assert.equal((await current()).id, first.id);
  await composer.fill("FAIL_ONCE：由用户明确重试"); await expect(page.getByRole("button",{name:"发送消息",exact:true})).toBeEnabled(); await composer.press("Enter");
  await expect.poll(async () => (await current()).runs[2]?.status).toBe("failed");
  await page.locator(".assistant-message").last().hover(); await page.getByRole("button", { name: "重试回复", exact: true }).last().click();
  await expect.poll(async () => (await current()).runs[3]?.status).toBe("completed");
  const retried = await current(); assert.equal(retried.runs[2].status, "failed"); assert.notEqual(retried.runs[2].id, retried.runs[3].id);
  await composer.fill("第一段对话的未发送草稿");
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await agent("Codex"); await pick("选择 Provider", "可用模型连接");
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

test("native settings switch without Apply and approvals survive refresh or cancellation in unified chat", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true }); const context = await isolatedContext(browser, { viewport: { width: 943, height: 1079 } }), page = await context.newPage();
  await page.goto(fixture.gateway.url);
  await expect(page.getByRole("button", { name: "模型与账号", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "选择 Provider", exact: true })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  await pick("选择 Harness", "Codex"); await expect(page.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
  await pick("选择模型", "Native B"); await expect(page.getByRole("button",{name:"思考强度",exact:true})).toBeEnabled(); await pick("思考强度","高"); await composer.fill("NATIVE_FIRST：沿用本机配置"); await composer.press("Enter");
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("已由 native-b 处理");
  const origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  await expect.poll(async () => (await current()).runs[0].status).toBe("completed"); const first = await current(); assert.equal(first.selection.nativeModel, "native-b"); assert.equal(first.runs[0].selection.nativeOptions.reasoning_effort,"high");
  await composer.fill("切换期间保留这个草稿");
  await pick("选择模型", "Native A"); await pick("选择模型", "Native B");
  await expect.poll(async () => { const value = await current(); return value.pendingSwitchId === null && value.selection.nativeModel === "native-b"; }).toBe(true);
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "应用选择", exact: true })).toHaveCount(0); await expect(composer).toHaveValue("切换期间保留这个草稿");
  await composer.press("Enter"); await expect.poll(async () => (await current()).runs[1]?.status).toBe("completed");
  const latest = await current(); assert.equal(latest.id, first.id); assert.equal(latest.runs[1].selection.nativeModel, "native-b");
  await composer.fill("FAIL_ONCE：检查重试按钮布局"); await expect(page.getByRole("button",{name:"发送消息",exact:true})).toBeEnabled(); await composer.press("Enter"); await expect.poll(async () => (await current()).runs[2]?.status).toBe("failed");
  await page.locator(".assistant-message").last().hover();
  for (const width of [943, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const retry = page.getByRole("button", { name: "重试回复", exact: true }).last();
    const box = await retry.boundingBox(); assert.ok(box && box.width >= 90 && box.height <= 36, "retry label remains horizontal");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(artifact, `native-models-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 943, height: 1079 });
  await composer.fill("APPROVAL：统一界面原生审批");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  const approval = page.getByRole("region", { name: "工具审批", exact: true });
  await expect(approval).toContainText("读取验收工作区");
  assert.equal((await current()).permissions.length, 1);
  await page.reload(); await expect(approval).toContainText("读取验收工作区");
  await approval.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("原生审批已收到：accept");
  await expect.poll(async () => (await current()).runs[3]?.status).toBe("completed");
  await expect(approval).toHaveCount(0); assert.equal((await current()).permissions.length, 0);
  await composer.fill("APPROVAL：取消未决定的原生审批");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(approval).toBeVisible();
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect.poll(async () => (await current()).runs[4]?.status).toBe("cancelled");
  await expect(approval).toHaveCount(0); assert.equal((await current()).status, "open");
  const beforeBranch = await current();
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await expect(page.getByText("继续已有会话", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新建立原生会话", exact: true }).click();
  await expect.poll(async () => (await current()).nativeStates.length).toBe(0);
  assert.equal((await current()).messages.length, beforeBranch.messages.length);
  assert.ok(!JSON.stringify(await current()).includes("checkpoint"), "private native recovery references never enter the Web DTO");
});

test("unified chat shows native plan, notices, tool details with diffs and turn usage from committed facts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  await expect(log.getByText("计划 · 1/2 完成")).toBeVisible(); await expect(log.getByText("修改文件")).toBeVisible();
  await expect(log.getByText("浏览器验收提示")).toBeVisible();
  await expect(log.getByText(/输入 1\.2k · 输出 300 · 上下文 15%/u)).toBeVisible();
  // The Run's own phases give the first-output and total time next to its usage.
  await expect(log.locator(".run-timing").first()).toHaveText(/^首字 [0-9.]+ 秒 · 用时 [0-9.]+ 秒$/u);
  // The process is folded into one line by default; opening it lists each tool.
  await expect(log.locator(".process-summary")).toContainText("执行 1 条命令"); await log.locator(".process-summary").first().click();
  const command = log.getByRole("button", { name: /ls -la/u });
  await expect(command).toBeEnabled(); await command.click();
  await expect(log.getByText("README.md").first()).toBeVisible(); await expect(log.locator(".native-tool-detail pre").first()).toContainText("ls -la");
  await log.getByRole("button", { name: /修改 README\.md/u }).click();
  await expect(log.locator(".native-diff .is-add")).toContainText("+新内容"); await expect(log.locator(".native-diff .is-remove")).toContainText("-旧内容");
  await page.locator(".assistant-message").last().hover(); await page.getByRole("button", { name: "执行详情", exact: true }).last().click();
  await expect(page.getByText("本轮用量")).toBeVisible();
  await page.screenshot({ path: join(artifact, "native-activity.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "native activity must not overflow a narrow screen");
  assert.deepEqual(errors, []);
});

test("unified chat attaches files, refuses inputs the model does not take, keeps staged attachments across reload and shows them on the message", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), chips = page.getByRole("list", { name: "待发送的附件" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const picker = page.locator("input[type=file]");
  // The selected model lists no audio input, so a voice note is marked and blocks sending until it is removed.
  await picker.setInputFiles([{ name: "voice.wav", mimeType: "audio/wav", buffer: Buffer.from("RIFF\0\0\0\0WAVEfmt ") }]);
  await expect(chips.getByText("当前 Harness 或模型不接受音频")).toBeVisible();
  await composer.fill("ATTACHMENTS 看看这些");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "移除附件 voice.wav", exact: true }).click();
  await picker.setInputFiles([{ name: "shot.png", mimeType: "image/png", buffer: png }, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachments") }]);
  await expect(chips.locator(".attachment-chip")).toHaveCount(2); await expect(chips.getByText("上传中")).toHaveCount(0);
  // Staged attachments are part of the per-chat draft and survive a reload.
  await page.reload();
  await expect(page.getByRole("list", { name: "待发送的附件" }).locator(".attachment-chip")).toHaveCount(2);
  await expect(composer).toHaveValue("ATTACHMENTS 看看这些");
  await page.screenshot({ path: join(artifact, "attachments-composer.png"), animations: "disabled" });
  await composer.press("Enter");
  await expect(log).toContainText("收到附件：图片 1，文件 1，均可读。");
  await expect(page.getByRole("list", { name: "待发送的附件" })).toHaveCount(0);
  const sent = log.locator(".user-message").last();
  await expect(sent.locator(".message-attachment-image img")).toHaveAttribute("alt", "shot.png");
  await expect(sent.getByRole("link", { name: /notes\.txt/u })).toHaveAttribute("download", "notes.txt");
  assert.equal(await sent.locator(".message-attachment-image img").evaluate(image => (image as HTMLImageElement).naturalWidth), 1, "the sent image is served from the content store");
  await page.screenshot({ path: join(artifact, "attachments-sent.png"), fullPage: true, animations: "disabled" });
  // The conversation exports with its attachments listed by name; export sits in the header's "更多操作" menu (ADR-054 §5),
  // as a download link of that menu.
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  const exportLink = page.getByRole("menuitem", { name: "导出 Markdown", exact: true });
  await expect(exportLink).toHaveAttribute("download", "");
  const exported = await page.evaluate(async href => (await fetch(href, { credentials: "same-origin" })).text(), await exportLink.getAttribute("href") ?? "");
  assert.ok(exported.includes("ATTACHMENTS 看看这些") && exported.includes("- shot.png（image/png") && exported.includes("收到附件：图片 1，文件 1，均可读。"));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "attachments must not overflow a narrow screen");
  assert.deepEqual(errors, []);
});

test("a branch opens with the quoted history and continues in its own native copy while the original stays unchanged", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("分支前的第一条消息"); await composer.press("Enter");
  await expect(log).toContainText("分支前的第一条消息", { timeout: 15000 }); await expect(log.locator(".assistant-message")).toHaveCount(1);
  await expect(log.locator(".assistant-message").last()).toContainText("已由");
  await page.locator(".assistant-message").last().hover();
  await page.getByRole("button", { name: "从这里分支", exact: true }).click();
  const origin = page.getByRole("region", { name: "分支来源" });
  await expect(origin).toContainText("分支自之前的对话"); await expect(origin).toContainText("2 条消息");
  await expect(origin.getByText("原生会话已分支")).toBeVisible({ timeout: 15000 });
  await origin.getByText("查看分支前的对话").click(); await expect(origin).toContainText("分支前的第一条消息");
  await expect(page.getByRole("button", { name: "分支 · 分支前的第一条消息", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("分支 · 分支前的第一条消息");
  await page.screenshot({ path: join(artifact, "branch-origin.png"), animations: "disabled" });
  await composer.fill("WHICH_THREAD 分支"); await composer.press("Enter");
  await expect(log).toContainText("原生分支线程，公共历史 0 轮，分支历史 0 条", { timeout: 15000 });
  // The original conversation keeps its own native thread and history.
  await origin.getByRole("button", { name: /打开原对话/u }).click();
  await expect(page.getByRole("region", { name: "分支来源" })).toHaveCount(0);
  await composer.fill("WHICH_THREAD 原对话"); await composer.press("Enter");
  await expect(log).toContainText("原线程", { timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the branch view must not overflow a narrow screen");
  assert.deepEqual(errors, []);
});

test("the native extensions panel lists skills, MCP servers and plugins and invokes a skill through its command", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "原生扩展", exact: true }).click();
  const panel = page.locator(".native-extensions");
  await expect(panel.getByRole("button", { name: "browser-skill", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(panel).toContainText("浏览器验收技能");
  await panel.getByText("MCP 服务器").click(); await expect(panel).toContainText("browser-docs"); await expect(panel).toContainText("已连接"); await expect(panel).toContainText("1 个工具");
  await panel.getByText("插件与扩展").click(); await expect(panel).toContainText("browser-plugin"); await expect(panel).toContainText("v2.0.0");
  await page.screenshot({ path: join(artifact, "native-extensions.png"), animations: "disabled" });
  await panel.getByRole("button", { name: "browser-skill", exact: true }).click();
  await expect(composer).toHaveValue("/skill:browser-skill ");
  await composer.press("End"); await composer.type("看看这个仓库"); await composer.press("Enter");
  await expect(log).toContainText("已使用技能 browser-skill：看看这个仓库", { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("a setting a native command changed is kept, shown in the composer and can be put back to the selection", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Native Settings", scenario: "native-config" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Native Settings", exact: true }).click();
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await page.getByRole("button", { name: "Native fast", exact: true }).click();
  // An option list opened from the settings panel stacks above it, wherever it happens to be placed.
  const stacking = await page.evaluate(() => [".picker-popover", ".composer-settings-panel"].map(selector => Number(getComputedStyle(document.querySelector(selector)!.closest(".hh-positioner")!).zIndex)));
  assert.ok(stacking[0]! > stacking[1]!, "option list z-index " + stacking.join(" over "));
  await page.getByRole("option", { name: "Off", exact: true }).click();
  await page.keyboard.press("Escape");
  const reply = async (text: string, count: number) => {
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled(); await composer.fill(text);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect.poll(async () => { if (!new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session")) return null; const value = await current(); return value.runs.length === count && value.activeRunId === null && value.runs.at(-1).status; }, { timeout: 15000 }).toBe("completed");
  };
  await reply("first turn", 1);
  assert.deepEqual((await current()).selection.nativeOptions, { "native-fast": "off" });
  await reply("/native-fast on", 2);
  const hint = page.locator(".native-carried");
  await expect(hint).toContainText("原生命令已改为 Native fast On；下一回合沿用，不改回所选。");
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await expect(page.locator(".native-observed")).toContainText("Native fast On"); await page.keyboard.press("Escape");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the hint must not overflow");
    await page.screenshot({ path: join(artifact, `native-carried-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await reply("third turn", 3);
  await expect(hint).toBeVisible();
  await hint.getByRole("button", { name: "改用所选设置", exact: true }).click();
  await expect(hint).toHaveCount(0); await expect.poll(async () => (await current()).epoch).toBe(2);
  await reply("fourth turn", 4);
  assert.equal((await current()).nativeStates[0].observed.options["native-fast"], "off");
  await expect(log.locator(".assistant-message")).toHaveCount(4);
  assert.deepEqual(errors, []);
});

test("a native session of the workspace is continued from the composer, quoted above the chat and marked as held", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Native Sessions", scenario: "session-list" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Native Sessions", exact: true }).click();
  await page.getByRole("button", { name: "本机会话", exact: true }).click();
  const panel = page.locator(".native-sessions");
  await expect(panel.getByText("Earlier work", { exact: true })).toBeVisible({ timeout: 15000 });
  await panel.getByRole("button", { name: "加载更早的会话", exact: true }).click(); await expect(panel.getByText("未命名会话", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: join(artifact, "native-sessions-panel.png"), animations: "disabled" });
  await panel.locator("li", { hasText: "Earlier work" }).getByRole("button", { name: "接续", exact: true }).click();
  const origin = page.getByRole("region", { name: "接续来源" });
  await expect(origin).toContainText("接续本机 Native Sessions 会话「Earlier work」", { timeout: 15000 }); await expect(origin).toContainText("4 条消息");
  await origin.getByText("查看本机会话的历史").click(); await expect(origin).toContainText("first question"); await expect(origin).toContainText("second answer");
  await expect(page.getByRole("button", { name: "接续 · Earlier work", exact: true })).toBeVisible();
  await composer.fill("what did I ask first?"); await composer.press("Enter");
  await expect(log.locator(".assistant-message").last()).toContainText("你好 fixture", { timeout: 15000 });
  await page.getByRole("button", { name: "本机会话", exact: true }).click();
  await expect(page.locator(".native-sessions li", { hasText: "Earlier work" }).getByRole("button", { name: /打开对话/u })).toBeVisible({ timeout: 15000 });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the continued conversation must not overflow a narrow screen");
  await page.screenshot({ path: join(artifact, "native-session-continued-390.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("tools a sub-agent ran are shown under the sub-agent call", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Native Agents", scenario: "subagent" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Native Agents", exact: true }).click();
  await composer.fill("让子代理运行 echo"); await composer.press("Enter");
  await expect(log.locator(".assistant-message").last()).toContainText("你好 fixture", { timeout: 15000 });
  await log.locator(".process-summary").last().click();
  const tools = log.getByRole("list", { name: "工具活动" }).last();
  await expect(tools.locator(":scope > li")).toHaveCount(1);
  await expect(tools).toContainText("Run echo SUB-OK"); await expect(tools).toContainText("子 Agent · 1 个工具");
  const nested = tools.getByRole("list", { name: "子 Agent 的工具：Run echo SUB-OK" });
  await expect(nested).toContainText("echo SUB-OK");
  await nested.getByRole("button", { name: /echo SUB-OK/u }).click(); await expect(nested.locator(".native-tool-detail")).toContainText("输出"); await expect(nested.locator(".native-tool-detail")).toContainText("SUB-OK");
  await page.screenshot({ path: join(artifact, "native-subagent-tools.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "nested tools must not overflow a narrow screen");
  assert.deepEqual(errors, []);
});

test("Codex plan mode answers with its plan, and a thread that follows the native configuration says it is still in plan mode", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, null, { name: "Codex Plan", scenario: "plan-mode" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), note = page.locator("#composer-notice");
  const origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const mode = async (label: string) => {
    await page.getByRole("button", { name: "协作模式", exact: true }).click(); await page.getByRole("option", { name: label, exact: true }).click();
  };
  const reply = async (text: string, count: number) => {
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled(); await composer.fill(text);
    await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect.poll(async () => { if (!new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session")) return null; const value = await current(); return value.runs.length === count && value.activeRunId === null && value.runs.at(-1).status; }, { timeout: 15000 }).toBe("completed");
  };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex Plan", exact: true }).click();
  await mode("计划");
  await expect(note).toContainText("计划模式：Codex Plan 先给出方案");
  await reply("plan it", 1);
  // The proposed plan is the reply, rendered as the Markdown list Codex wrote.
  await expect(log.getByRole("listitem")).toHaveText(["读代码", "改实现"]);
  // Following the native configuration does not take the thread out of plan mode, and the composer says so.
  await mode("默认 · 本机默认");
  await expect(note).toContainText("这个 Codex Plan 线程仍为计划模式：跟随本机配置不会改回");
  await reply("next", 2);
  await expect(note).toContainText("仍为计划模式");
  // Choosing the default mode sends it; the thread leaves plan mode.
  await mode("默认");
  await expect(note).not.toContainText("仍为计划模式");
  await reply("do it", 3);
  assert.equal((await current()).nativeStates[0].observed.options.collaboration_mode, "default");
  assert.deepEqual(errors, []);
});

test("a conversation keeps its native process between Turns, shows it, and ends it on request", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Kept Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const reply = async (text: string, count: number) => {
    await composer.fill(text); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect.poll(async () => { if (!new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session")) return null; const value = await current(); return value.runs.length === count && value.activeRunId === null && value.runs.at(-1).status; }, { timeout: 15000 }).toBe("completed");
  };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Kept Agent", exact: true }).click();
  // Off by default; a new conversation can choose it before its first message, so even the first Turn's process is kept.
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  const keep = page.getByRole("checkbox", { name: "保持原生进程" });
  await expect(keep).not.toBeChecked(); await keep.click(); await expect(keep).toBeChecked();
  await page.keyboard.press("Escape");
  await reply("first", 1);
  const first = await current();
  assert.equal(first.retention.enabled, true); assert.equal(first.runs[0].retained, true); assert.equal(first.retention.process?.harnessId, "native-acp");
  await reply("second", 2);
  const reused = await current();
  assert.equal(reused.runs[1].reused, true); assert.equal(reused.runs[1].retained, true); assert.equal(reused.runs[1].cleanup, null);
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await expect(page.locator(".kept-setting")).toContainText("原生进程保留中");
  await page.screenshot({ path: join(artifact, "kept-process-panel.png"), animations: "disabled" });
  await page.locator(".kept-setting").getByRole("button", { name: "结束后台进程", exact: true }).click();
  await expect(page.locator(".kept-setting")).not.toContainText("原生进程保留中");
  const ended = await current();
  assert.equal(ended.retention.process, null); assert.equal(ended.retention.enabled, true, "ending the process keeps the choice for later Turns");
  const events = await (await context.request.get(origin + "/api/v1/sessions/" + ended.id + "/events?afterSeq=0&limit=100")).json();
  assert.deepEqual(events.events.filter((event: { type: string }) => event.type === "native.process_closed").map((event: { data: { reason: string; cleanup: { closed: boolean } } }) => [event.data.reason, event.data.cleanup.closed]), [["ended_by_user", true]]);
  assert.deepEqual(errors, []);
});

test("a new conversation starts a Harness with the model and thinking level last sent with it, and nothing else", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Native Settings", scenario: "native-config" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), fast = page.getByRole("button", { name: "Native fast", exact: true }), thinking = page.getByRole("button", { name: "思考强度", exact: true });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Native Settings", exact: true }).click();
  await thinking.click(); await page.getByRole("option", { name: "最大", exact: true }).click();
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await fast.click(); await page.getByRole("option", { name: "On", exact: true }).click(); await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled(); await composer.fill("first");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("你好 fixture", { timeout: 15000 });
  const check = async () => {
    // The thinking level comes back, marked as last used; the other native setting follows the program's default.
    await expect(thinking).toContainText("最大");
    await thinking.click(); await expect(page.getByRole("option", { name: "最大", exact: true })).toHaveAccessibleDescription(/上次使用/); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "高级配置", exact: true }).click(); await expect(fast).toContainText("本机默认"); await page.keyboard.press("Escape");
  };
  // Through the picker of a new conversation.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Native Settings", exact: true }).click();
  await check();
  // Through the welcome's list of ready Agents (opened from its summary, ADR-054 §5) in another new conversation.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.locator(".agent-summary").click();
  await page.getByRole("button", { name: "选择 Native Settings", exact: true }).click();
  await check();
  assert.deepEqual(errors, []);
});

test("a waiting approval is marked in the sidebar with whose deadline it is, counts down, opens its conversation and is gone when it expires", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false, null, null, true); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } });
  // Notifications are recorded instead of shown, by a browser that allows them once asked.
  await context.addInitScript(() => {
    const shown: { title: string; body: string; tag: string }[] = [], state = { permission: "default" };
    Object.defineProperty(window, "__notices", { value: shown });
    class Recorded { static get permission() { return state.permission; } static async requestPermission() { state.permission = "granted"; return "granted"; }
      onclick: (() => void) | null = null; constructor(title: string, options: { body?: string; tag?: string } = {}) { shown.push({ title, body: options.body ?? "", tag: options.tag ?? "" }); } close() {} }
    Object.defineProperty(window, "Notification", { configurable: true, value: Recorded });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  // Off until the user turns it on; turning it on is what asks the browser.
  await page.getByRole("button", { name: "等你处理", exact: true }).click();
  const toggle = page.getByRole("button", { name: "待处理时通知我", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false"); await toggle.click(); await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Hermes Agent", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("approve this"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled();
  // The page is in the background when Hermes asks, so a notification goes out.
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); });
  await composer.press("Enter");
  const card = page.getByRole("region", { name: "工具审批", exact: true });
  await expect(card).toContainText("rm -rf build", { timeout: 15000 });
  await expect(card.locator(".permission-deadline")).toHaveText(/^原程序期限 · \d+ 秒后自动拒绝$/u);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); });
  const notices = await page.evaluate(() => (window as unknown as { __notices: { title: string; body: string }[] }).__notices);
  assert.equal(notices.length, 1); assert.equal(notices[0]!.title, "Hermes Agent 等待你处理");
  assert.match(notices[0]!.body, /^等待审批（原程序期限，\d+ 秒后自动拒绝）$/u, "only the Harness and the wait, nothing of the conversation");
  // Another conversation is open; the sidebar still says which one waits, for what, and for how long.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const waiting = page.locator(".session-item.has-attention");
  await expect(waiting).toHaveCount(1); await expect(page.locator(".attention-count")).toHaveText("1");
  const line = waiting.locator(".attention-line");
  await expect(line).toHaveText(/^等待审批 · 原程序期限 \d+ 秒后自动拒绝$/u);
  const seconds = async () => Number(/(\d+) 秒/u.exec((await line.textContent()) ?? "")?.[1]);
  const first = await seconds(); await page.waitForTimeout(2200); const later = await seconds();
  assert.ok(first <= 58 && later < first, `${first} then ${later}`);
  await page.screenshot({ path: join(artifact, "attention-sidebar.png"), animations: "disabled" });
  // Deciding happens in the conversation: the row opens it, with its approval card.
  await waiting.click();
  await expect(card).toBeVisible(); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  // At Hermes's deadline the mark is gone and the conversation says the approval timed out.
  await expect(waiting).toHaveCount(0, { timeout: 70000 });
  await expect(page.locator(".attention-count")).toHaveCount(0);
  await expect(page.getByText("审批已超时")).toBeVisible({ timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("a Turn's diagnostics are copied from its details without conversation content unless the user asks for it", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(fixture.gateway.url).origin });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  await log.getByRole("button", { name: "执行详情", exact: true }).last().click();
  const content = page.getByRole("checkbox", { name: "包含这一轮的提示词与回复" });
  await expect(content).not.toBeChecked();
  const copy = page.getByRole("button", { name: "复制诊断信息", exact: true });
  await copy.click(); await expect(page.getByText("已复制诊断信息（不含对话内容）。")).toBeVisible();
  const plain = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(plain.split("\n")[0], "HarnessHub 诊断 · 不含对话内容");
  assert.equal(plain.includes("NATIVE_ACTIVITY"), false); assert.equal(plain.includes(fixture.root), false, "no private path reaches the page");
  await content.check(); await copy.click(); await expect(page.getByText("已复制诊断信息（含对话内容）。")).toBeVisible();
  const full = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(full.split("\n")[0]!, /^HarnessHub 诊断 · 含对话内容/u); assert.match(full, /\n提示词：\nNATIVE_ACTIVITY\n/u);
  await page.screenshot({ path: join(artifact, "run-diagnostics.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("a Turn waiting for another conversation's work in their workspace names it and why, opens it, can be cancelled, and starts once it is free", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const send = async (text: string) => { await composer.fill(text); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter"); };
  // The first conversation waits for an approval, holding the workspace; its deadline is HarnessHub's wait budget.
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await send("approve this");
  const card = page.getByRole("region", { name: "工具审批", exact: true });
  await expect(card).toContainText("rm -rf build", { timeout: 15000 });
  await expect(card.locator(".permission-deadline")).toHaveText("等待期限 · 剩余 30 分");
  await expect(page.locator(".session-item.has-attention .attention-line")).toHaveText("等待审批 · 等待期限 剩余 30 分");
  // A second conversation in the same workspace queues behind it, and says which conversation and why, without paths.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await send("queued work");
  const status = log.locator(".response-status");
  await expect(status).toHaveText("排队中：等待对话「approve this」释放工作区（它正在等待你的审批）", { timeout: 15000 });
  await expect(log.locator(".queued-turn small")).toHaveText("最多再等 30 分钟，到时这条消息不会发出。");
  assert.equal((await log.textContent())?.includes(fixture.root), false, "no private path reaches the page");
  await page.screenshot({ path: join(artifact, "queued-turn.png"), animations: "disabled" });
  // Cancelling the queued Turn stops only it; a new message queues again.
  await log.getByRole("button", { name: "取消排队", exact: true }).click();
  await expect(log.locator("[data-run-status=cancelled]")).toHaveCount(1);
  await send("queued again");
  await expect(log.locator(".response-status").last()).toHaveText(/^排队中：等待对话「approve this」/u, { timeout: 15000 });
  // The holder opens from the queued Turn; once its approval is decided and its Turn ends, the queued Turn starts by itself.
  await log.getByRole("button", { name: "打开那个对话", exact: true }).click();
  await expect(card).toBeVisible(); await card.getByRole("button", { name: "Allow once", exact: true }).click();
  await page.locator(".session-item", { hasText: "queued work" }).click();
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  await expect(log).toContainText("你好 fixture");
  assert.deepEqual(errors, []);
});

test("a Turn that waits for its workspace past its wait budget is not sent, and names the conversation that held it", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Busy Agent", scenario: "stop" }, null, false, { executionBudgetMs: 60_000, waitBudgetMs: 3000 }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const send = async (text: string) => { await composer.fill(text); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter"); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Busy Agent", exact: true }).click();
  await send("long work"); await expect(log).toContainText("你好 fixture", { timeout: 15000 });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Busy Agent", exact: true }).click();
  await send("waits too long");
  await expect(log.locator(".response-status")).toHaveText("排队中：等待对话「long work」释放工作区（它正在运行）", { timeout: 15000 });
  const failure = log.locator(".run-error");
  await expect(failure).toHaveText("工作区正被另一项任务使用，这条消息没有发出。可以等它结束后重新发送，或为新对话选择其他工作区。占用它的是对话「long work」。打开那个对话", { timeout: 15000 });
  await page.screenshot({ path: join(artifact, "workspace-busy.png"), animations: "disabled" });
  await failure.getByRole("button", { name: "打开那个对话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "long work" })).toBeVisible();
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect(log.locator("[data-run-status=cancelled]")).toHaveCount(1, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("a Turn waiting for a slot says how many conversations run, has no deadline of its own, and can be cancelled", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Busy Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin;
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeVisible();
  const csrf = String((await (await context.request.get(origin + "/api/v1/auth/session")).json()).csrfToken);
  const write = (path: string, data: unknown) => context.request.post(origin + path, { headers: { Origin: origin, "X-CSRF-Token": csrf }, data });
  // Four conversations, each in its own workspace, wait for an approval and so take every slot.
  for (const index of [1, 2, 3, 4]) {
    const workspace = join(fixture.root, "busy-" + index); await mkdir(workspace);
    const created = await write("/api/v1/sessions", { workspace, selection: { harnessId: "native-acp", controlId: "native-acp" }, commandId: "create-busy-" + index });
    assert.equal(created.status(), 201);
    assert.equal((await write("/api/v1/sessions/" + String((await created.json()).id) + "/messages", { text: "approve this", commandId: "send-busy-" + index })).status(), 202);
  }
  await expect(page.locator(".attention-count")).toHaveText("4", { timeout: 15000 });
  // A fifth conversation, in another workspace, waits for one of them to end.
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Busy Agent", exact: true }).click();
  await composer.fill("queued work"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(log.locator(".response-status")).toHaveText("等待开始：4 个对话正在执行，其中一个结束后自动开始", { timeout: 15000 });
  await expect(log.locator(".queued-turn small")).toHaveText("没有单独的等待期限，按发送先后轮到。");
  await expect(log.getByRole("button", { name: "打开那个对话", exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "slot-wait.png"), animations: "disabled" });
  await log.getByRole("button", { name: "取消排队", exact: true }).click();
  await expect(log.locator("[data-run-status=cancelled]")).toContainText("已取消（用户停止）");
  assert.deepEqual(errors, []);
});

test("a Harness of a version HarnessHub never ran shows that version alone in the Harness list, its detail, the welcome and the picker, with nothing said about it (ADR-053)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  // The texts ADR-038 showed beside a version no record named (the badge, the line naming the version run for real, the
  // months-apart line, the recipe's reference-version row), each caught by a substring; none appears anywhere any more.
  const hints = ["经验证", "验证过的版本", "相隔", "目录参考"];
  const sayNothing = async (where: string) => { const text = await page.locator("body").innerText(); for (const hint of hints) assert.ok(!text.includes(hint), where + " says " + JSON.stringify(hint)); };
  // The fixture installs Gemini CLI 1.0.0, a version no record names. Gemini CLI is frozen, so it is shown first (ADR-050).
  await showFrozenHarnesses(page);
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
  const row = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 Gemini CLI 详情", exact: true }) });
  await row.getByRole("button", { name: "安装", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("安装完成", { exact: true })).toBeVisible({ timeout: 30000 });
  // The detail: the version as a fact, next to the latest one; the recipe's "目录参考" version is gone with the hint.
  await expect(detail.getByText("当前版本", { exact: true }).locator("..")).toContainText("1.0.0");
  await expect(detail.getByText("最新版本", { exact: true })).toBeVisible();
  await sayNothing("the detail");
  await detail.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click();
  // The list: the version alone, with no mark beside it, like the Harness nothing was ever recorded for.
  await expect(row).toContainText("v1.0.0"); await expect(row.locator(".badge")).toHaveText(["冻结"]);
  const autohand = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 Autohand Code 详情", exact: true }) });
  await expect(autohand.locator(".badge")).toHaveCount(0);
  await sayNothing("the Harness list");
  await page.screenshot({ path: join(artifact, "version-fact.png"), animations: "disabled" });
  // The welcome's list of Agents (opened from its summary, ADR-054 §5) and the picker show the version the same way, and
  // the Harness is chosen like any other.
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.locator(".agent-summary").click();
  const card = page.getByRole("region", { name: "本机发现的 Harness" }).getByRole("button", { name: "选择 Gemini CLI", exact: true });
  await expect(card).toContainText("v1.0.0"); await expect(card.locator(".badge")).toHaveCount(0);
  await sayNothing("the welcome");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  const option = page.getByRole("option", { name: "Gemini CLI", exact: true });
  await expect(option).toContainText("v1.0.0"); await expect(option).toBeEnabled();
  await sayNothing("the picker");
  await option.click();
  await expect(page.getByRole("button", { name: "选择 Harness", exact: true })).toContainText("Gemini CLI");
  assert.deepEqual(errors, []);
});

test("the execution settings name the native session and give the program's own continue commands, whatever version the fixture's Codex reports (ADR-039, ADR-053)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("hello"); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  const resume = page.getByRole("complementary", { name: "详情栏" }).getByLabel("在原程序中继续");
  // The identifier, the interactive command and its copy button: the fixture's Codex reports no version HarnessHub ever ran, and none is needed.
  await expect(resume.locator(".native-resume-row code")).toHaveText([/^browser-native-\d+$/u, /^codex resume browser-native-\d+$/u]);
  await expect(resume.locator(".native-resume-row small")).toHaveText(["原生会话 ID", "在该对话的工作区目录中运行"]);
  await expect(resume.getByRole("button", { name: "复制原生会话 ID", exact: true })).toBeVisible();
  await expect(resume.getByRole("button", { name: "复制恢复命令", exact: true })).toBeVisible();
  // The one-question form unfolds with its flag, since the fixture's workspace is no Git repository.
  await resume.getByRole("button", { name: "只问一次", exact: true }).click();
  await expect(resume.locator(".native-resume-row code").nth(2)).toHaveText(/^codex exec --skip-git-repo-check resume browser-native-\d+ "你的问题"$/u);
  await expect(resume.getByRole("button", { name: "复制只问一次的命令", exact: true })).toBeVisible();
  await expect(resume.locator(".native-resume-note")).toHaveText(["工作区不是 git 仓库，Codex 需要这个标志", "原程序首次在这个目录运行时可能先询问是否信任这个目录；接受会写入它自己的全局配置。", "在原程序中继续会使两边的回合交错；回到 HarnessHub 继续前，先在原程序中结束。"]);
  await expect(resume).not.toContainText("验证");
  await page.screenshot({ path: join(artifact, "native-resume.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("ending a kept process says once that its background tasks outside its group may still run", { skip: process.platform === "win32" ? "process groups are POSIX; Windows is not verified" : false, timeout: 120000 }, async t => {
  const outsiderDirectory = await realpath(await mkdtemp(join(tmpdir(), "harness-outside-browser-"))), outsiderFile = join(outsiderDirectory, "outsider.pid");
  const fixture = await launchFixture(false, { name: "Kept Agent", scenario: "hermes", env: { FIXTURE_OUTSIDER: outsiderFile } }); let browser: Browser | null = null;
  t.after(async () => {
    try { await browser?.close(); } finally {
      await fixture.close();
      for (const line of (await readFile(outsiderFile, "utf8").catch(() => "")).split("\n").filter(Boolean)) { try { process.kill(Number(line), "SIGKILL"); } catch { /* already ended */ } }
      await rm(outsiderDirectory, { recursive: true, force: true });
    }
  });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Kept Agent", exact: true }).click();
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await page.getByRole("checkbox", { name: "保持原生进程" }).click(); await page.keyboard.press("Escape");
  await composer.fill("first"); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  await page.getByRole("button", { name: "高级配置", exact: true }).click();
  await expect(page.locator(".kept-setting")).toContainText("原生进程保留中");
  await page.locator(".kept-setting").getByRole("button", { name: "结束后台进程", exact: true }).click();
  await expect(page.locator(".kept-setting")).not.toContainText("原生进程保留中");
  await page.keyboard.press("Escape");
  await expect(page.getByText("原程序的后台任务可能仍在运行（1 个进程）：它们已离开原程序的进程组，HarnessHub 没有结束它们。")).toBeVisible();
  await page.screenshot({ path: join(artifact, "kept-outside.png"), animations: "disabled" });
  // Said once: the next message ends the notice.
  await composer.fill("second"); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByText("原程序的后台任务可能仍在运行", { exact: false })).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("the settings page reads the login shell's PATH only when asked, says it runs the login configuration, and lets each added directory go", { skip: process.platform === "win32" ? "login shells are POSIX" : false, timeout: 120000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "harness-login-browser-"))), bin = join(directory, "tools"), shell = join(directory, "login-sh"), shells = join(directory, "shells");
  await mkdir(bin);
  await writeFile(shell, `#!/bin/sh\n[ "$1" = "-l" ] && [ "$2" = "-c" ] || exit 9\nPATH="${bin}:/usr/bin" exec /bin/sh -c "$3"\n`, { mode: 0o700 });
  await writeFile(shells, shell + "\n");
  const fixture = await launchFixture(false, null, null, false, undefined, { shell, shells }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  // The refusal below is an expected 409, which the browser logs as a failed resource.
  let expectedRefusals = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => {
    if (entry.type() !== "error") return;
    if (entry.location().url.endsWith("/api/v1/discovery/login-shell") && entry.text().includes("409")) expectedRefusals++; else errors.push(entry.text());
  });
  await page.goto(fixture.gateway.url);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const panel = page.getByRole("region", { name: "来自登录 shell 的目录" });
  await expect(panel).toContainText("会执行你的 shell 登录配置（login-sh -l）来读取 PATH");
  await expect(panel).toContainText("只运行列在 /etc/shells 中的 shell：用 Homebrew 等方式安装、没有加入这个文件的 shell 会被拒绝。");
  await expect(panel.locator("li")).toHaveCount(0); await expect(panel).not.toContainText("没有带来新的目录");
  await panel.getByRole("button", { name: "读取并重新检测" }).click();
  await expect(panel.locator("li code")).toHaveText([bin], { timeout: 30000 });
  await page.screenshot({ path: join(artifact, "login-shell-panel.png"), animations: "disabled" });
  await panel.locator("li").getByRole("button", { name: "移除" }).click();
  await expect(panel.locator("li")).toHaveCount(0, { timeout: 30000 });
  await expect(panel).toContainText("登录 shell 的 PATH 没有带来新的目录。");
  // A shell the system's list no longer names is refused with its reason, and the directories stay as they were.
  await writeFile(shells, "/bin/sh\n");
  await panel.getByRole("button", { name: "读取并重新检测" }).click();
  await expect(panel.getByRole("status")).toHaveText("HarnessHub 没有运行你的登录 shell：它必须是列在 /etc/shells 中的绝对路径。用 Homebrew 等方式安装、没有加入这个文件的 shell 常见这种情况。搜索目录没有变化。");
  await expect(panel.locator("li")).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "login-shell-refused.png"), animations: "disabled" });
  assert.deepEqual(errors, []); assert.ok(expectedRefusals <= 1);
});

test("G054-FR1 G054-FR8 a conversation that needs the user leads the sidebar and the inbox, and number keys choose one-time options on a focused card", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await composer.fill("approve this"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  const card = page.getByRole("region", { name: "工具审批", exact: true });
  await expect(card).toContainText("rm -rf build", { timeout: 15000 });
  // One-time options carry their number; an option that lasts beyond this request has none and can only be clicked.
  await expect(card.getByRole("button", { name: "Allow once", exact: true })).toContainText("1");
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toContainText("2");
  await expect(card.getByRole("button", { name: "Allow always", exact: true })).not.toContainText(/\d/u);
  await page.screenshot({ path: join(artifact, "approval-card.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "approval-card-dark.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  // In another conversation, the waiting one leads the sidebar, and the inbox lists it with whose deadline applies.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const group = page.locator(".session-group").first();
  await expect(group).toContainText("等你处理"); await expect(group.locator(".session-item")).toHaveCount(1);
  await page.getByRole("button", { name: /^等你处理（1 项）$/u }).click();
  const inbox = page.locator(".inbox-pop");
  await expect(inbox).toContainText("approve this"); await expect(inbox).toContainText(/等待审批 · 等待期限 剩余 \d+ 分/u);
  await expect(inbox.getByRole("button", { name: "待处理时通知我", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: join(artifact, "inbox.png"), animations: "disabled" });
  await inbox.getByRole("button", { name: /approve this/u }).click();
  await expect(card).toBeVisible();
  // The approval waits in the composer's place (ADR-054 §5), so no text field takes the keys meanwhile: a number pressed
  // anywhere but on the approval decides nothing; on the focused approval it decides, and the composer comes back.
  await expect(composer).toBeHidden();
  await page.locator("#chat-title").click(); await page.keyboard.press("1"); await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await card.locator("strong").first().click(); await expect(card).toBeFocused();
  await page.keyboard.press("2");
  await expect(log).toContainText('"optionId":"deny"', { timeout: 15000 });
  await expect(card).toHaveCount(0); await expect(composer).toBeVisible();
  await expect(page.locator(".session-group").first()).not.toContainText("等你处理");
  assert.deepEqual(errors, []);
});

test("G054-FR2 G054-FR3 the process folds into one line, the density choice stays after reload, and the details panel shows changes, steps, plan and facts", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  const summary = log.locator(".process-summary");
  await expect(summary).toHaveText("执行 1 条命令，改动 1 个文件"); await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("list", { name: "工具活动" })).toHaveCount(0);
  await page.getByRole("button", { name: "详细", exact: true }).click();
  await expect(log.getByRole("list", { name: "工具活动" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "详细", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(log.getByRole("list", { name: "工具活动" })).toBeVisible();
  await page.getByRole("button", { name: "简洁", exact: true }).click();
  await expect(log.getByRole("list", { name: "工具活动" })).toHaveCount(0);
  // Wide enough for the panel beside the conversation: it opens on the conversation's changes, read-only.
  const panel = page.getByRole("complementary", { name: "详情栏" });
  await expect(panel.getByRole("tab", { name: /改动/u })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText("本对话改动 1 个文件"); await expect(panel).toContainText("README.md");
  await expect(panel.locator(".native-diff .is-add")).toContainText("新内容"); await expect(panel.locator(".native-diff .is-remove")).toContainText("旧内容");
  await expect(panel.getByRole("button", { name: /撤销|还原|revert/iu })).toHaveCount(0);
  await panel.getByRole("tab", { name: /过程/u }).click();
  await expect(panel).toContainText("收到消息"); await expect(panel.getByRole("list", { name: "工具活动" })).toContainText("ls -la");
  await panel.getByRole("tab", { name: /计划/u }).click(); await expect(panel).toContainText("计划 · 1/2 完成");
  await panel.getByRole("tab", { name: /执行/u }).click(); await expect(panel).toContainText("本轮用量"); await expect(panel.getByRole("button", { name: "复制诊断信息", exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "details-panel.png"), animations: "disabled" });
  await page.getByRole("button", { name: "详情栏", exact: true }).click(); await expect(panel).toHaveCount(0);
  // Narrower, the panel opens over the conversation and closes back to it.
  await page.setViewportSize({ width: 943, height: 900 });
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("本轮用量");
  await page.getByRole("button", { name: "关闭详情栏", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "详情栏", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the details sheet must not overflow a narrow screen");
  await page.screenshot({ path: join(artifact, "details-sheet-390.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-FR4 a message written while a reply runs is sent once after a completed Turn, and goes back to the composer unsent otherwise", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin, composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const step = async (stage: string) => { const pending = join(fixture.root, "workspace", "next-stream-control.json"); await writeFile(pending, JSON.stringify({ stage })); await rename(pending, join(fixture.root, "workspace", "stream-control.json")); };
  const held = page.locator(".queued-message"), notice = (text: string) => page.getByRole("status").filter({ hasText: text });
  const opened = () => new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session") !== null;
  const running = async (count: number) => { await expect.poll(async () => { if (!opened()) return null; const value = await current(); return value.runs.length === count && value.runs.at(-1).status; }, { timeout: 15000 }).toBe("running"); };
  const settled = async (count: number, status: string) => { await expect.poll(async () => { if (!opened()) return null; const value = await current(); return value.runs.length === count && value.activeRunId === null && value.runs.at(-1).status; }, { timeout: 15000 }).toBe(status); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  // Completed: the held message is sent once, as a normal message.
  await composer.fill("STREAM_RENDER：第一轮"); await composer.press("Enter"); await running(1);
  await composer.fill("下一条：本轮结束后发送"); await composer.press("Enter");
  await expect(held).toContainText("将在本轮结束后发送"); await expect(held).toContainText("下一条：本轮结束后发送"); await expect(composer).toHaveValue("");
  assert.equal((await current()).runs.length, 1, "holding a message sends nothing");
  await step("finish"); await settled(2, "completed");
  assert.equal((await current()).runs[1].input, "下一条：本轮结束后发送"); await expect(held).toHaveCount(0);
  await expect(log.locator(".user-message").last()).toContainText("下一条：本轮结束后发送");
  // Withdrawn: nothing is sent.
  await composer.fill("STREAM_RENDER：第三轮"); await composer.press("Enter"); await running(3);
  await composer.fill("撤回这一条"); await composer.press("Enter"); await expect(held).toBeVisible();
  await held.getByRole("button", { name: "撤回", exact: true }).click(); await expect(held).toHaveCount(0);
  await step("finish"); await settled(3, "completed");
  // Cancelled: the held message returns to the composer, unsent.
  await composer.fill("STREAM_RENDER：第四轮"); await composer.press("Enter"); await running(4);
  await composer.fill("停止后放回输入框"); await composer.press("Enter"); await expect(held).toBeVisible();
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click(); await settled(4, "cancelled");
  await expect(composer).toHaveValue("停止后放回输入框"); await expect(held).toHaveCount(0);
  await expect(notice("上一轮没有正常结束，暂存的消息已放回输入框，没有发出。")).toBeVisible();
  assert.equal((await current()).runs.length, 4);
  // Reloaded: back in the composer, never sent by the reloaded page.
  await composer.fill("STREAM_RENDER：第五轮"); await composer.press("Enter"); await running(5);
  await composer.fill("重新载入后放回"); await composer.press("Enter"); await expect(held).toBeVisible();
  await page.reload(); await expect(composer).toHaveValue("重新载入后放回"); await expect(held).toHaveCount(0);
  await step("finish"); await settled(5, "completed");
  await page.waitForTimeout(1000); assert.equal((await current()).runs.length, 5, "a reloaded page does not send a held message");
  // A selection change after holding: the message waits in the composer for the new selection.
  await composer.fill("STREAM_RENDER：第六轮"); await composer.press("Enter"); await running(6);
  await composer.fill("换模型后放回"); await composer.press("Enter"); await expect(held).toBeVisible();
  await page.getByRole("button", { name: "选择模型", exact: true }).click(); await page.getByRole("option", { name: "Native B", exact: true }).click();
  await step("finish"); await settled(6, "completed");
  await expect(composer).toHaveValue("换模型后放回"); await expect(notice("所选 Harness 或模型已改变，暂存的消息已放回输入框，没有发出。")).toBeVisible();
  await page.waitForTimeout(1000); assert.equal((await current()).runs.length, 6);
  assert.deepEqual(errors, []);
});

test("G054-DL3 the home greets, says who is ready from the readiness facts and who needs the user, shows the workspace without a branch, and the merged picker opens each choice on its own", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const shoot = async (name: string) => {
    // Shots show the settled page: the longest transition of these screens (the approval's 300 ms) has ended.
    await page.waitForTimeout(400);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width} in ${scheme}`);
        await page.screenshot({ path: join(artifact, `${name}-${scheme}-${width}.png`), animations: "disabled" });
      }
    }
    await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 1440, height: 960 });
  };
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), welcome = page.locator(".welcome"), box = page.locator(".composer-box"), chip = page.locator(".agent-chip");
  // H01: the greeting, 32/42 · 500 on a wide screen.
  const greeting = page.getByRole("heading", { name: "今天想让哪个 Agent 做什么？", exact: true });
  await expect(greeting).toBeVisible();
  assert.deepEqual(await greeting.evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; }), ["32px", "42px", "500"]);
  // H06: the first time, three steps with nothing to fill in: what was found, where it works, a first question.
  const steps = page.getByRole("list", { name: "开始使用" }).getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText(/找到了 \d+ 个 Agent/u); await expect(steps.nth(1)).toContainText("选一个项目文件夹"); await expect(steps.nth(1)).toContainText("/workspace");
  await expect(steps.nth(2)).toContainText("讲讲这个项目的结构");
  await shoot("dl3-first");
  await steps.nth(2).getByRole("button", { name: "讲讲这个项目的结构", exact: true }).click();
  await expect(composer).toHaveValue("讲讲这个项目的结构"); await expect(composer).toBeFocused(); await composer.fill("");
  // H04: radius 28 and the three-layer shadow, blue while focused.
  // The box's shadow as drawn: Tailwind's empty ring and inset layers (transparent, zero) are left out.
  const shadow = () => box.evaluate(element => getComputedStyle(element).boxShadow.split(/,(?![^(]*\))/u).map(part => part.trim()).filter(part => part !== "rgba(0, 0, 0, 0) 0px 0px 0px 0px").join(", "));
  assert.equal(await box.evaluate(element => getComputedStyle(element).borderTopLeftRadius), "28px");
  await expect.poll(shadow).toBe("rgba(58, 106, 224, 0.6) 0px 0px 0px 0.5px, rgba(58, 106, 224, 0.12) 0px 0px 0px 3px, rgba(0, 0, 0, 0.04) 0px 4px 16px 0px");
  await composer.evaluate(element => (element as HTMLTextAreaElement).blur());
  await expect.poll(shadow).toBe("rgba(0, 0, 0, 0.1) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.03) 0px 4px 16px 0px, rgba(0, 0, 0, 0.03) 0px 0px 24px 0px");
  // H05: attachments at the bottom left; the merged picker and the send key at the bottom right, in that order.
  const add = page.getByRole("button", { name: "添加文件或上下文", exact: true }), sendKey = page.getByRole("button", { name: "发送消息", exact: true });
  const [frame, plus, picker, send] = await Promise.all([box.boundingBox(), add.boundingBox(), chip.boundingBox(), sendKey.boundingBox()]);
  assert.ok(frame && plus && picker && send);
  assert.ok(plus.x - frame.x < 24 && frame.x + frame.width - (send.x + send.width) < 20 && picker.x > plus.x + plus.width && picker.x + picker.width <= send.x, "add | … | picker · send");
  assert.ok(frame.y + frame.height - (send.y + send.height) < 16 && frame.y + frame.height - (plus.y + plus.height) < 20, "both at the bottom of the box");
  await expect(chip).toContainText("选择 Harness");
  // Each part of the merged picker opens its own list: the Agent (its list says ⌘J), the model, the thinking level.
  await chip.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await expect(page.locator(".picker-popover")).toContainText("由谁来做");
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(chip.locator(".brand-tile[data-brand='codex']")).toBeVisible(); await expect(chip).toContainText("Codex");
  await expect(composer).toHaveAttribute("placeholder", /^让 Codex 做什么？/u);
  await chip.getByRole("button", { name: "选择模型", exact: true }).click(); await page.getByRole("option", { name: "Native B", exact: true }).click();
  await expect(chip.getByRole("button", { name: "选择模型", exact: true })).toHaveText("Native B");
  const thinking = chip.getByRole("button", { name: "思考强度", exact: true });
  await thinking.click(); await page.getByRole("option", { name: "高", exact: true }).click(); await expect(thinking).toHaveText("思考 高");
  await shoot("dl3-picker");
  // After a first conversation, a new one shows the summary: who is ready, the workspace by its folder, and no branch.
  await composer.fill("hello"); await composer.press("Enter");
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const summary = page.locator(".agent-summary");
  await expect(summary).toHaveText(/^\d+ 个 Agent 就绪$/u);
  await expect(welcome.getByRole("button", { name: "workspace", exact: true })).toBeVisible();
  assert.doesNotMatch(await welcome.innerText(), /分支|branch|git/iu, "the Gateway gives no branch, so none is shown");
  // H02: an Agent whose latest read asked for a sign-in moves from ready to needing the user (OpenClaw's fixture is signed out).
  const ready = Number(/^(\d+)/u.exec(await summary.innerText())?.[1]);
  await chip.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "OpenClaw", exact: true }).click();
  await expect(page.getByText(/本机认证尚未就绪/u)).toBeVisible();
  // (Other Agents this computer has, found but not ready to run, are named there as well.)
  await expect(welcome.getByRole("button", { name: /(?:OpenClaw|\d+ 个 Agent) 需要处理$/u })).toBeVisible();
  await expect(summary).toHaveText(`${ready - 1} 个 Agent 就绪`);
  // The summary lists the available Agents with their versions and states, and chooses one.
  await summary.click();
  const list = page.getByRole("region", { name: "本机发现的 Harness" });
  await expect(list.getByRole("button", { name: "选择 OpenClaw", exact: true })).toContainText("需要登录");
  await list.getByRole("button", { name: "选择 Codex", exact: true }).click();
  await expect(chip).toContainText("Codex"); await expect(composer).toBeFocused();
  await shoot("dl3-home");
  assert.deepEqual(errors, []);
});

test("G054-DL5 an approval waits in the composer's place: ⏎ allows once and esc refuses there, lasting options are click-only, the decision is written back into the Turn, and a question stays in its Turn", { timeout: 150000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }, { name: "Codex Question", scenario: "native-question" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const shoot = async (name: string) => {
    // Shots show the settled page: the longest transition of these screens (the approval's 300 ms) has ended.
    await page.waitForTimeout(400);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width} in ${scheme}`);
        await page.screenshot({ path: join(artifact, `${name}-${scheme}-${width}.png`), animations: "disabled" });
      }
    }
    await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 1440, height: 960 });
  };
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), box = page.locator(".composer-box");
  const dock = box.getByRole("region", { name: "工具审批", exact: true }), results = log.locator(".approval-result");
  const ask = async () => { await composer.fill("approve this"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter"); await expect(dock).toContainText("rm -rf build", { timeout: 15000 }); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await ask();
  // P02: in the composer's place and with the composer's focus: who asks and whose deadline, the command, what a lasting choice means.
  await expect(composer).toBeHidden(); await expect(dock).toBeFocused();
  await expect(dock).toContainText("Shared Agent 在等你审批"); await expect(dock.locator(".permission-deadline")).toHaveText("等待期限 · 剩余 30 分");
  await expect(dock).toContainText("选“Allow always”后"); await expect(dock).toContainText("只能点选");
  // P03: ⏎ allows once and esc refuses; number keys choose one-time options; the lasting option has no key.
  await expect(dock.getByRole("button", { name: "Allow once", exact: true })).toHaveAttribute("aria-keyshortcuts", "1 Enter");
  await expect(dock.getByRole("button", { name: "Deny", exact: true })).toHaveAttribute("aria-keyshortcuts", "2 Escape");
  await expect(dock.getByRole("button", { name: "Allow always", exact: true })).not.toHaveAttribute("aria-keyshortcuts");
  // P04: the amber ring, and the Turn keeps a mark that points to it.
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).boxShadow)).toContain("rgb(245, 158, 11) 0px 0px 0px 1.5px");
  await expect(log.getByRole("button", { name: "等你批准，请求停在下方输入框的位置", exact: true })).toBeVisible();
  await shoot("dl5-dock");
  // Pointing at the approval makes the keys its own at once.
  await dock.click({ position: { x: 60, y: 8 } }); await expect(dock).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(log).toContainText('"optionId":"allow_once"', { timeout: 15000 });
  await expect(dock).toHaveCount(0); await expect(composer).toBeVisible(); await expect(composer).toBeFocused();
  await expect(results).toHaveText(["你允许了一次：rm -rf build"]);
  assert.equal(await results.first().evaluate(element => getComputedStyle(element).animationName), "hh-fade-in");
  await expect(log.getByRole("button", { name: "等你批准，请求停在下方输入框的位置", exact: true })).toHaveCount(0);
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).boxShadow)).not.toContain("rgb(245, 158, 11)");
  // esc refuses (a key right after the approval took the focus is still taken as meant for the message being typed).
  await ask(); await expect(dock).toBeFocused(); await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await expect(log).toContainText('"optionId":"deny"', { timeout: 15000 });
  await expect(results).toHaveText(["你允许了一次：rm -rf build", "你拒绝了：rm -rf build"]);
  // A lasting option answers to no key and only to a click.
  await ask(); await page.waitForTimeout(600); await page.keyboard.press("3"); await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "Allow always", exact: true }).click();
  await expect(log).toContainText('"optionId":"allow_always"', { timeout: 15000 });
  await expect(results.last()).toHaveText("你选择了“Allow always”：rm -rf build");
  await shoot("dl5-decided");
  // A question stays in its Turn, and the composer stays where it is.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex Question", exact: true }).click();
  await composer.fill("ask me"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  const question = log.getByRole("region", { name: "Harness 交互", exact: true });
  await expect(question).toContainText("选择原生计划", { timeout: 15000 });
  await expect(composer).toBeVisible(); await expect(box.getByRole("region", { name: "工具审批", exact: true })).toHaveCount(0);
  await question.getByRole("button", { name: "取消", exact: true }).click();
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("G054-DL6 the plan bar above the composer says how far the plan is and opens every step, and the line under it shows the round, steps and time with only the usage the Gateway reported", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const shoot = async (name: string) => {
    // Shots show the settled page: the longest transition of these screens (the approval's 300 ms) has ended.
    await page.waitForTimeout(400);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width} in ${scheme}`);
        await page.screenshot({ path: join(artifact, `${name}-${scheme}-${width}.png`), animations: "disabled" });
      }
    }
    await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 1440, height: 960 });
  };
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin, composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const step = async (stage: string) => { const pending = join(fixture.root, "workspace", "next-stream-control.json"); await writeFile(pending, JSON.stringify({ stage })); await rename(pending, join(fixture.root, "workspace", "stream-control.json")); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  // P01: the plan with a step left stays above the composer; it opens every step and its arrow turns.
  const bar = page.locator(".plan-bar"), toggle = bar.getByRole("button").first();
  await expect(toggle).toContainText("计划"); await expect(toggle).toContainText("1 / 2 · 正在：修改文件"); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const below = await page.locator(".composer-box").boundingBox(), above = await toggle.boundingBox();
  assert.ok(below && above && above.y + above.height <= below.y, "the plan bar sits above the composer");
  await shoot("dl6-plan");
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(bar.getByRole("list", { name: "Codex 维护的计划" }).getByRole("listitem")).toHaveText(["读取工作区", "修改文件"]);
  await expect(toggle.locator("svg").last()).toHaveClass(/rotate-180/u);
  await shoot("dl6-plan-open");
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // P05: the round, its steps and its time, then exactly the usage the run reported: no cost, since the fixture reports none.
  const run = (await current()).runs[0], line = page.locator(".composer-status");
  await expect(line).toContainText("第 1 轮"); await expect(line).toContainText("2 步"); await expect(line).toContainText(/用时 [\d.]+ 秒/u);
  assert.equal(run.usage.turn.input, 1200); await expect(line).toContainText("输入 1.2k");
  if (run.usage.context?.size) await expect(line).toContainText(`上下文 ${Math.round(run.usage.context.used / run.usage.context.size * 100)}%`);
  assert.equal(run.usage.cost, undefined); await expect(line).not.toContainText("¥"); await expect(line).not.toContainText("会话累计"); await expect(line).not.toContainText("本轮 ");
  // While a reply runs, the time counts up; a run that reported no usage shows none.
  await composer.fill("STREAM_RENDER：计时"); await composer.press("Enter");
  await expect.poll(async () => (await current()).runs.at(-1).status, { timeout: 15000 }).toBe("running");
  await expect(line).toContainText("第 2 轮"); await expect(line).toContainText(/已用 \d+ 秒/u); await expect(line).not.toContainText("输入");
  // #15: a message sent here rises into place; #16: the send key's glyph has turned into the stop square.
  await expect(log.locator(".motion-message-in .user-message").last()).toContainText("STREAM_RENDER：计时");
  assert.match(await log.locator(".motion-message-in").last().evaluate(element => getComputedStyle(element).animationName), /hh-message-rise/u);
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true }).locator(".send-stop")).toHaveAttribute("data-state", "stop");
  await step("finish");
  await expect.poll(async () => (await current()).runs.at(-1).status, { timeout: 15000 }).toBe("completed");
  await expect(line).toContainText(/用时 [\d.]+ 秒/u);
  await expect(page.getByRole("button", { name: "发送消息", exact: true }).locator(".send-stop")).toHaveAttribute("data-state", "send");
  // The history a page opens with does not move.
  await page.reload(); await expect(log.locator(".user-message")).toHaveCount(2); await expect(log.locator(".motion-message-in")).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("G054-DL9 ⌘J opens the Agent list, ⌘. stops the reply, ⌘\\ opens and closes the details pushing the conversation, ↑ edits the last message, / lists the native commands and @ adds a file; composition triggers none of them", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin, composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const search = page.getByRole("combobox", { name: "搜索 Harness", exact: true }), trigger = page.getByRole("button", { name: "选择 Harness", exact: true });
  // ⌘J: the Agent list with its search; composition never opens it.
  await composer.focus(); await composer.dispatchEvent("keydown", { key: "j", code: "KeyJ", metaKey: true, ctrlKey: true, isComposing: true, bubbles: true });
  await expect(search).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+J");
  await expect(search).toBeFocused(); await expect(page.locator(".picker-popover")).toContainText("由谁来做");
  await search.fill("Codex"); await search.press("Enter");
  // Opened from the keyboard while writing, the list gives the focus back to the message.
  await expect(trigger).toContainText("Codex"); await expect(composer).toBeFocused();
  // Moving on with the keyboard, the focus ring shows at once around each part of the merged picker, inside its edge.
  await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  for (let step = 0; step < 8 && !(await trigger.evaluate(element => element === document.activeElement)); step++) await page.keyboard.press("Tab");
  await expect(trigger).toBeFocused();
  assert.deepEqual(await trigger.evaluate(element => { const style = getComputedStyle(element); return [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.transitionProperty.includes("outline")]; }), ["solid", "2px", "-2px", false]);
  await page.screenshot({ path: join(artifact, "dl9-focus.png"), clip: { x: 640, y: 560, width: 640, height: 200 } });
  // / lists the native commands; ↑ ↓ and ⏎ fill one in; esc closes the list and keeps the text.
  await composer.fill("/");
  const commands = page.getByRole("listbox", { name: "原生命令", exact: true });
  await expect(commands.getByRole("option")).toContainText(["/compact", "/export"]);
  await page.screenshot({ path: join(artifact, "dl9-commands.png"), animations: "disabled" });
  await composer.press("ArrowDown"); await composer.press("Enter"); await expect(composer).toHaveValue("/export ");
  await composer.fill("/ex"); await expect(commands.getByRole("option")).toHaveText([/^\/export/u]); await composer.press("Escape");
  await expect(commands).toHaveCount(0); await expect(composer).toHaveValue("/ex");
  // @ at the start of a word offers a file, which then goes with the message; inside a word it is text.
  const files = page.getByRole("listbox", { name: "引用文件", exact: true });
  await composer.fill("看看"); await composer.press("@"); await expect(files).toHaveCount(0); await expect(composer).toHaveValue("看看@");
  await composer.fill("看看 "); await composer.press("@"); await expect(files.getByRole("option")).toHaveText(/从这台电脑选择文件/u);
  const chooser = page.waitForEvent("filechooser"); await composer.press("Enter");
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(composer).toHaveValue("看看 "); await expect(page.getByRole("list", { name: "待发送的附件" }).locator(".attachment-chip")).toHaveCount(1);
  await page.getByRole("button", { name: "移除附件 notes.txt", exact: true }).click();
  // ⌘. stops the reply, and only that: the details panel, which ⌘. used to toggle, stays as it was.
  await composer.fill("STREAM_RENDER：⌘. 停止"); await composer.press("Enter");
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true })).toBeEnabled({ timeout: 15000 });
  const panel = page.getByRole("complementary", { name: "详情栏" }), open = await panel.count();
  await page.keyboard.press("ControlOrMeta+.");
  await expect.poll(async () => (await current()).runs.at(-1).status, { timeout: 15000 }).toBe("cancelled");
  assert.equal(await panel.count(), open);
  // ↑ in the empty composer brings the last message back to edit; nothing is sent.
  await composer.fill(""); await composer.press("ArrowUp"); await expect(composer).toHaveValue("STREAM_RENDER：⌘. 停止");
  assert.equal((await current()).runs.length, 1);
  // ⌘\ opens and closes the details, pushing the conversation aside instead of covering it; the header button does the same.
  const width = () => page.locator(".chat-scroll").evaluate(element => Math.round(element.getBoundingClientRect().width));
  if (open) { await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toHaveCount(0); }
  const full = await width();
  await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toBeVisible();
  await expect.poll(width).toBeLessThanOrEqual(full - 380);
  await page.screenshot({ path: join(artifact, "dl9-panel.png"), animations: "disabled" });
  await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toHaveCount(0); await expect.poll(width).toBe(full);
  const button = page.getByRole("button", { name: "详情栏", exact: true });
  await button.click(); await expect(panel).toBeVisible(); await expect(button).toHaveAttribute("aria-pressed", "true");
  // Its content slid in once: a key and then the pointer again (the input mode changing) do not make it start over.
  await page.waitForTimeout(400); await page.keyboard.press("Shift");
  assert.equal(await page.evaluate(() => { document.dispatchEvent(new PointerEvent("pointerdown")); return getComputedStyle(document.querySelector(".details-aside")!.firstElementChild!).opacity; }), "1");
  await button.click(); await expect(panel).toHaveCount(0); await expect(button).toHaveAttribute("aria-pressed", "false");
  // With reduced motion the panel appears at once: no widening and no slide.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button.click(); await expect(panel).toBeVisible();
  assert.deepEqual(await page.locator(".details-aside").evaluate(element => [getComputedStyle(element).transitionDuration, getComputedStyle(element.firstElementChild!).animationName]), ["0s", "none"]);
  await button.click(); await expect(panel).toHaveCount(0); await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.deepEqual(errors, []);
});

test("G054-FR5 the command palette searches conversations and actions, and the shortcuts open it, the shortcut sheet and a new conversation", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("PALETTE_TARGET 第一段对话"); await composer.press("Enter"); await expect(log).toContainText("已由");
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.getByRole("heading", { name: "新对话", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  const search = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true });
  await expect(search).toBeFocused();
  await search.fill("PALETTE_TARGET");
  // Composition never runs a command.
  await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }); await expect(search).toBeVisible();
  await search.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("PALETTE_TARGET 第一段对话");
  await page.keyboard.press("ControlOrMeta+K"); await search.fill("我的 Agent"); await search.press("Enter");
  await expect(page.getByRole("heading", { name: "我的 Agent", exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("dialog", { name: "快捷键" })).toContainText("搜索与命令"); await page.keyboard.press("Escape");
  await page.screenshot({ path: join(artifact, "palette.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-FR6 the chosen theme applies before the first paint and survives reload, dark pages fit narrow screens, and reduced motion stops transitions", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [], fonts: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  page.on("request", request => { if (/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//u.test(request.url())) fonts.push(request.url()); });
  await page.goto(fixture.gateway.url);
  // Nothing comes from elsewhere (ADR-054 §2): the policy allows only this Gateway, and the text uses the system fonts.
  const policy = (await context.request.get(new URL(fixture.gateway.url).origin + "/")).headers()["content-security-policy"] ?? "";
  assert.equal(policy, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  assert.match(await page.evaluate(() => getComputedStyle(document.body).fontFamily), /^"HH Quote", -apple-system, /u);
  // Without a session, the startup page explains how to sign in, in Chinese.
  const visitor = await isolatedContext(browser), outside = await visitor.newPage();
  await outside.goto(new URL(fixture.gateway.url).origin + "/");
  await expect(outside.getByRole("alert")).toContainText("这个页面还没有登录。"); await expect(outside.getByText("请使用本机网关启动时提供的入口链接", { exact: false })).toBeVisible();
  await visitor.close();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("radio", { name: /深色/u }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // The dark main area of ADR-054 §1 (#18191C).
  assert.equal(await background(), "rgb(24, 25, 28)");
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter"); await expect(page.getByRole("log", { name: "对话历史" })).toContainText("原生活动已完成。");
  for (const target of ["chat", "harnesses", "settings"] as const) {
    if (target === "harnesses") await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
    if (target === "settings") await page.getByRole("button", { name: "设置", exact: true }).click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${target} overflows at ${width} in the dark theme`);
      await page.screenshot({ path: join(artifact, `dark-${target}-${width}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("ControlOrMeta+K");
  // With reduced motion only fades of 150 ms or less remain (ADR-054 §3); the palette, opened from the keyboard, appears at once.
  const durations = await page.locator(".palette-pop").evaluate(element => { const style = getComputedStyle(element); return [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000))); });
  assert.ok(durations.every(value => value <= 1), "a palette opened from the keyboard is not animated: " + durations.join(","));
  await page.keyboard.press("Escape");
  // A popover opened with the pointer keeps only a short fade: it neither grows nor moves.
  const popover = await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent("pointerdown"));
    const probe = document.createElement("div"); probe.className = "surface-pop"; probe.setAttribute("data-starting-style", ""); document.body.append(probe);
    const style = getComputedStyle(probe), result = { input: document.documentElement.dataset.input, properties: style.transitionProperty, transform: style.transform, animation: style.animationName,
      durations: [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000))) };
    probe.remove(); return result;
  });
  assert.deepEqual([popover.input, popover.properties, popover.transform, popover.animation], ["pointer", "opacity", "none", "none"]);
  assert.ok(popover.durations.every(value => value <= 150) && popover.durations.some(value => value > 0), "a popover only fades, within 150 ms: " + popover.durations.join(","));
  await page.getByRole("radio", { name: /跟随系统/u }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/u);
  // No request went to Google Fonts while the pages above were shown.
  assert.deepEqual(fonts, []);
  assert.deepEqual(errors, []);
});

test("G054-DL1 the neutral tokens follow the system in both themes, text uses the system fonts, nothing loads from elsewhere, and the icon is the one-point mark", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const origin = new URL(fixture.gateway.url).origin;
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [], elsewhere: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  page.on("request", request => { const url = request.url(); if (!url.startsWith("data:") && new URL(url).origin !== origin) elsewhere.push(url); });
  await page.goto(fixture.gateway.url);
  await expect(page.locator("svg.logo-mark").first()).toBeVisible();

  // §2: the policy allows only this Gateway, the page asks nothing of anywhere else, and no Google Fonts rule remains.
  const policy = (await context.request.get(origin + "/")).headers()["content-security-policy"] ?? "";
  assert.equal(policy, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  assert.doesNotMatch(policy, /fonts\.(?:googleapis|gstatic)\.com/u);
  assert.equal(await page.locator("link[href*='fonts.googleapis.com'], link[href*='fonts.gstatic.com']").count(), 0);
  // §2: system fonts with the PingFang quotes, Geist Mono for code, tabular figures, weights up to 600.
  const type = await page.evaluate(async () => {
    await document.fonts.ready;
    const code = document.createElement("code"), strong = document.createElement("strong"), token = document.createElement("i"); token.style.fontFamily = "var(--font-sans)"; document.body.append(code, strong, token);
    const result = { stack: getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim(), body: getComputedStyle(document.body).fontFamily, token: getComputedStyle(token).fontFamily,
      size: getComputedStyle(document.body).fontSize + "/" + getComputedStyle(document.body).lineHeight, code: getComputedStyle(code).fontFamily, numbers: getComputedStyle(document.body).fontVariantNumeric,
      strong: getComputedStyle(strong).fontWeight, quote: [...document.fonts].filter(face => face.family.replaceAll("\"", "") === "HH Quote").map(face => face.weight + " " + face.unicodeRange).sort() };
    code.remove(); strong.remove(); token.remove(); return result;
  });
  // Chrome reports BlinkMacSystemFont as "system-ui" once computed, so the stack is read from its token and the page uses that token.
  assert.equal(type.stack, "\"HH Quote\", -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif");
  assert.match(type.body, /^"HH Quote", -apple-system, /u); assert.equal(type.body, type.token);
  assert.match(type.code, /^"Geist Mono Variable", /u);
  assert.deepEqual([type.size, type.numbers, type.strong], ["14px/20px", "tabular-nums", "600"]);
  assert.deepEqual(type.quote, ["400 U+2018-2019, U+201C-201D", "500 U+2018-2019, U+201C-201D", "600 U+2018-2019, U+201C-201D"]);
  // §1 and §2: the type scale (size/line height · weight), the radii and the composer's three-layer shadow.
  const scale = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), value = (name: string) => root.getPropertyValue(name).trim();
    const steps = ["greeting", "title", "section", "panel", "reading", "ui", "ui-sm", "caption", "code"].map(step => value(`--text-${step}`) + "/" + value(`--text-${step}--line-height`) + (value(`--text-${step}--font-weight`) ? " · " + value(`--text-${step}--font-weight`) : ""));
    return { steps, radii: ["tag", "row", "control", "block", "card", "composer"].map(radius => value(`--radius-${radius}`)) };
  });
  assert.deepEqual(scale.steps, ["32px/42px · 500", "28px/36px · 600", "20px/28px · 600", "17px/24px · 600", "15px/26px", "14px/20px", "13px/20px", "12px/18px", "12.5px/20px"]);
  assert.deepEqual(scale.radii, ["6px", "8px", "10px", "12px", "14px", "28px"]);

  // §1: tokens read through the same variables the components use, light by default and dark when the system is dark.
  const tokens = () => page.evaluate(() => {
    const probe = document.createElement("i"), well = document.createElement("span"), app = document.createElement("span"), mono = document.createElement("img");
    well.className = "brand-tile"; well.dataset.kind = "mark"; app.className = "brand-tile"; app.dataset.kind = "app"; mono.className = "brand-mono";
    document.body.append(probe, well, app, mono);
    const color = (name: string) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const names = ["--bg-sidebar", "--bg-app", "--bg-surface", "--bg-subtle", "--bg-hover", "--bg-selected", "--text", "--text-2", "--text-3", "--accent", "--accent-text", "--on-accent", "--amber-dot", "--amber", "--red-dot", "--red", "--add-text"];
    probe.style.boxShadow = "var(--sh-composer)";
    const result = { ...Object.fromEntries(names.map(name => [name, color(name)])), page: getComputedStyle(document.body).backgroundColor, composer: getComputedStyle(probe).boxShadow,
      well: getComputedStyle(well).backgroundColor, app: getComputedStyle(app).backgroundColor, mono: getComputedStyle(mono).filter, theme: document.documentElement.getAttribute("data-theme") };
    probe.remove(); well.remove(); app.remove(); mono.remove(); return result;
  });
  assert.deepEqual(await tokens(), {
    "--bg-sidebar": "rgb(249, 250, 251)", "--bg-app": "rgb(255, 255, 255)", "--bg-surface": "rgb(255, 255, 255)", "--bg-subtle": "rgb(244, 245, 247)", "--bg-hover": "rgb(235, 237, 240)",
    "--bg-selected": "rgba(38, 49, 72, 0.07)", "--text": "rgb(15, 17, 21)", "--text-2": "rgb(75, 80, 89)", "--text-3": "rgb(100, 105, 115)", "--accent": "rgb(58, 106, 224)",
    "--accent-text": "rgb(47, 95, 208)", "--on-accent": "rgb(255, 255, 255)", "--amber-dot": "rgb(245, 158, 11)", "--amber": "rgb(180, 83, 9)", "--red-dot": "rgb(239, 68, 68)",
    "--red": "rgb(220, 38, 38)", "--add-text": "rgb(21, 128, 61)", page: "rgb(255, 255, 255)",
    composer: "rgba(0, 0, 0, 0.1) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.03) 0px 4px 16px 0px, rgba(0, 0, 0, 0.03) 0px 0px 24px 0px",
    well: "rgb(255, 255, 255)", app: "rgba(0, 0, 0, 0)", mono: "none", theme: null });
  // §4: every Agent mark on the page sits in a tile of at least 16 px.
  for (const tile of await page.locator(".brand-tile").all()) { const box = await tile.boundingBox(); assert.ok(box === null || (box.width >= 16 && box.height >= 16), "an Agent mark is at least 16 px"); }
  await page.screenshot({ path: join(artifact, "dl1-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  assert.deepEqual(await tokens(), {
    "--bg-sidebar": "rgb(17, 18, 20)", "--bg-app": "rgb(24, 25, 28)", "--bg-surface": "rgb(31, 32, 35)", "--bg-subtle": "rgb(38, 39, 43)", "--bg-hover": "rgb(47, 48, 52)",
    "--bg-selected": "rgba(255, 255, 255, 0.08)", "--text": "rgb(243, 244, 246)", "--text-2": "rgb(180, 184, 191)", "--text-3": "rgb(149, 154, 162)", "--accent": "rgb(58, 106, 224)",
    "--accent-text": "rgb(138, 176, 255)", "--on-accent": "rgb(255, 255, 255)", "--amber-dot": "rgb(245, 158, 11)", "--amber": "rgb(251, 191, 36)", "--red-dot": "rgb(240, 82, 82)",
    "--red": "rgb(248, 113, 113)", "--add-text": "rgb(74, 222, 128)", page: "rgb(24, 25, 28)",
    composer: "rgba(255, 255, 255, 0.12) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.35) 0px 8px 24px 0px",
    well: "rgb(42, 43, 47)", app: "rgba(0, 0, 0, 0)", mono: "invert(1)", theme: null });
  await page.screenshot({ path: join(artifact, "dl1-dark-1440.png"), animations: "disabled" });

  // §4: the favicon and the sidebar mark are "one point fanning out": a blue tile, one dot, three lines, on the 32 grid.
  const icon = decodeURIComponent((await page.locator("link[rel='icon']").getAttribute("href") ?? "").replace(/^data:image\/svg\+xml,/u, ""));
  assert.match(icon, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 32 32'>/u);
  for (const part of ["<stop offset='0' stop-color='#5a87f2'/>", "<stop offset='1' stop-color='#2f5fd6'/>", "<rect width='32' height='32' rx='7.5' fill='url(#t)'/>", "stroke='#fff' stroke-width='2.75'",
    "<path d='M12 16c4.5 0 5.5-6.5 12.5-6.5'/>", "<path d='M12 16h12.5'/>", "<path d='M12 16c4.5 0 5.5 6.5 12.5 6.5'/>", "<circle cx='10' cy='16' r='4' fill='#fff'/>"]) assert.ok(icon.includes(part), "the favicon draws " + part);
  const mark = page.locator("svg.logo-mark").first();
  assert.deepEqual(await mark.evaluate(svg => ({ box: svg.getAttribute("viewBox"), stops: [...svg.querySelectorAll("stop")].map(stop => stop.getAttribute("stop-color")), lines: [...svg.querySelectorAll("path")].map(path => path.getAttribute("d")),
    dot: [...svg.querySelectorAll("circle")].map(circle => [circle.getAttribute("cx"), circle.getAttribute("cy"), circle.getAttribute("r")].join(" ")),
    filled: getComputedStyle(svg.querySelector("rect") as Element).fill.startsWith("url(") })), {
    box: "0 0 32 32", stops: ["#5a87f2", "#2f5fd6"], lines: ["M12 16c4.5 0 5.5-6.5 12.5-6.5", "M12 16h12.5", "M12 16c4.5 0 5.5 6.5 12.5 6.5"], dot: ["10 16 4"], filled: true });
  assert.deepEqual(elsewhere, []);
  assert.deepEqual(errors, []);
});

test("G054-UP1 an upgrade first says what it restarts, closes and leaves on the old version and sends exactly that consent; one that changed nothing says so", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  // The fixture's OpenClaw shown as the user's npm installation with an update; the fixture itself has no native channel (ADR-017).
  const viewed = "a".repeat(64), checked = "b".repeat(64);
  const native = (harness: { id: string; management: Record<string, unknown> }) => harness.id !== "openclaw" ? harness : { ...harness, installed: true,
    management: { ...harness.management, source: "system", installedVersion: "2026.3.23-2", programVersion: "2026.3.23-2", latestVersion: "2026.10.2", updateStatus: "available",
      recipe: { controlId: "openclaw-native", kind: "npm", sourceLabel: "npm registry", packageName: "openclaw", referenceVersion: "latest", canInstall: true, reason: null },
      native: { channel: "npm", location: "/opt/homebrew/bin/openclaw", fingerprint: viewed, canInstall: false, canUpgrade: true, reason: null } } };
  const base = { id: "", harnessId: "openclaw", controlId: "openclaw-native", action: "upgrade", status: "failed", phase: "failed", cancelRequested: false, resolvedVersion: "2026.10.2", installationId: null, logCursor: 0 };
  const legacy = { ...base, id: "management-11111111-1111-4111-8111-111111111111", createdAt: "2026-10-12T13:12:27.277Z", updatedAt: "2026-10-12T13:12:28.662Z",
    error: { code: "HARNESS_BUSY", message: "本机程序仍有活动进程，请结束对应任务后再升级；其他对话可以继续。" },
    native: { channel: "npm", location: "/opt/homebrew/bin/openclaw", beforeVersion: "2026.3.23-2", actualVersion: null, dispatched: false, configurationPreserved: null } };
  const refused = { ...base, id: "management-22222222-2222-4222-8222-222222222222", createdAt: "2026-10-12T14:00:00.000Z", updatedAt: "2026-10-12T14:00:02.000Z",
    error: { code: "HARNESS_BUSY", message: "另一个 HarnessHub 进程正在使用这个程序（例如另一个服务里正在回复的对话），没有升级。等它结束后再升级。" },
    native: { channel: "npm", location: "/opt/homebrew/bin/openclaw", beforeVersion: "2026.3.23-2", actualVersion: null, dispatched: false, configurationPreserved: null, restartServices: ["ai.openclaw.gateway"], closedConversations: 1 } };
  let jobs: unknown[] = [legacy], submitted: Record<string, unknown> | null = null, blocked = true;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan", "**/api/v1/harnesses/check-updates"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(native) : { ...body, harnesses: body.harnesses.map(native), jobs } });
  });
  await page.route("**/api/v1/installation-jobs?limit=50", route => route.fulfill({ json: jobs }));
  await page.route("**/api/v1/installation-jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON(); jobs = [refused, legacy]; await route.fulfill({ status: 202, json: refused });
  });
  await page.route("**/api/v1/harnesses/openclaw/maintenance", route => route.fulfill({ json: { harnessId: "openclaw", checkedAt: "2026-10-12T14:00:00.000Z", fingerprint: checked, channel: "npm", location: "/opt/homebrew/bin/openclaw",
    currentVersion: "2026.3.23-2", targetVersion: "2026.10.2", servicesKnown: true,
    restart: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", pid: 4039, command: "launchctl kickstart -k gui/501/ai.openclaw.gateway", portKnown: true }],
    resident: [{ label: "ai.openclaw.node", name: "OpenClaw Node", pid: 4736, restartCommand: "openclaw node restart" }], processes: [{ pid: 8100, name: "openclaw" }],
    conversations: blocked ? [{ sessionId: "s-replying", title: "正在回复的对话", busy: true }] : [{ sessionId: "s-idle", title: "空闲的对话", busy: false }],
    otherUsers: blocked ? [{ pid: 51234 }] : [], staleRecords: 2, plugins: ["openclaw-weixin"], notes: ["重启时 Gateway 连接的消息渠道（例如微信、飞书）会断开片刻，最好选一个能接受短暂中断的时间升级。"],
    rollback: "npm install --global openclaw@2026.3.23-2",
    runtimes: [
      { runtime: "Node.js", required: ">=24.16.0 <25 || >=26.1.0", found: blocked ? "25.9.0" : "26.11.1", path: blocked ? "/opt/homebrew/bin/node" : "/Users/me/.nvm/versions/node/v26.11.1/bin/node", satisfied: !blocked, service: null, restarted: true, upgradeCommand: blocked ? "brew upgrade node" : null },
      { runtime: "Node.js", required: ">=24.16.0 <25 || >=26.1.0", found: blocked ? "25.9.0" : "26.11.0", path: "/opt/homebrew/opt/node/bin/node", satisfied: !blocked, service: "ai.openclaw.gateway", restarted: true, upgradeCommand: "brew upgrade node" },
      { runtime: "Node.js", required: ">=24.16.0 <25 || >=26.1.0", found: "25.9.0", path: "/opt/homebrew/opt/node@25/bin/node", satisfied: false, service: "ai.openclaw.node", restarted: false, upgradeCommand: "brew upgrade node@25" }] } }));
  await page.goto(fixture.gateway.url);
  // The sidebar counts the available update next to the page's name.
  await page.getByRole("button", { name: "我的 Agent 1 个可升级", exact: true }).click();
  const row = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }) });
  // Something in a Turn, or another HarnessHub process, blocks: said before anything runs, and the upgrade cannot be confirmed.
  await row.getByRole("button", { name: "升级", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "升级 OpenClaw" });
  await expect(dialog.getByText("现在不能升级")).toBeVisible();
  await expect(dialog).toContainText("有 1 个对话正在使用 OpenClaw（正在回复或等你处理）"); await expect(dialog.getByRole("button", { name: "正在回复的对话" })).toBeVisible();
  await expect(dialog).toContainText("另一个 HarnessHub 进程（进程 51234）正在使用 OpenClaw");
  // Both the program's Node.js and the one the restarted Gateway starts must meet the range; each says how to upgrade it.
  await expect(dialog.locator(".upgrade-runtime")).toHaveText([
    "OpenClaw 2026.10.2 要求 Node.js >=24.16.0 <25 || >=26.1.0，本机运行 OpenClaw 的 Node.js 是 25.9.0（/opt/homebrew/bin/node）。需要先升级它，可以运行 brew upgrade node；HarnessHub 不替你升级 Node.js。",
    "OpenClaw 2026.10.2 要求 Node.js >=24.16.0 <25 || >=26.1.0，OpenClaw Gateway（ai.openclaw.gateway）启动用的 Node.js 是 25.9.0（/opt/homebrew/opt/node/bin/node）。需要先升级它，可以运行 brew upgrade node；HarnessHub 不替你升级 Node.js。"]);
  await expect(dialog.getByRole("button", { name: "升级并重启 OpenClaw Gateway" })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  assert.equal(submitted, null, "nothing is sent while the upgrade is blocked");
  // Otherwise it says everything it touches, before anything runs.
  blocked = false;
  await row.getByRole("button", { name: "升级", exact: true }).click();
  await expect(dialog.getByText("2026.3.23-2 → 2026.10.2")).toBeVisible();
  for (const text of ["沿用原来的 npm 全局安装，把 OpenClaw 从 2026.3.23-2 升级到 2026.10.2。",
    "OpenClaw Gateway（ai.openclaw.gateway，进程 4039）会在新版本核实后立即重启：", "launchctl kickstart -k gui/501/ai.openclaw.gateway", "1 个对话保留的 OpenClaw 进程会先关闭，下次发消息时重新连接。",
    "OpenClaw Node（ai.openclaw.node，进程 4736），升级后可运行 openclaw node restart", "openclaw（进程 8100）", "还会清除 2 条已结束的 HarnessHub 进程留下的使用记录。",
    "已安装的插件：openclaw-weixin。新版本可能不兼容它们。", "最好选一个能接受短暂中断的时间升级", "npm install --global openclaw@2026.3.23-2"]) await expect(dialog).toContainText(text);
  // Seven months apart, and a target no record names: the versions are stated, and nothing is inferred from them (ADR-053).
  for (const text of ["相隔", "还没有验证", "验证过的版本"]) await expect(dialog).not.toContainText(text);
  // A service left running only needs a newer Node.js before its own restart: said, without blocking.
  await expect(dialog.locator(".upgrade-runtime-warning")).toHaveText("OpenClaw Node（ai.openclaw.node）启动用的 Node.js 是 25.9.0（/opt/homebrew/opt/node@25/bin/node），2026.10.2 要求 >=24.16.0 <25 || >=26.1.0。升级后重启它之前，需要先升级这个 Node.js（brew upgrade node@25）。");
  await page.screenshot({ path: join(artifact, "upgrade-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "升级并重启 OpenClaw Gateway" }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  assert.deepEqual(submitted!.restartServices, ["ai.openclaw.gateway"]); assert.equal(submitted!.expectedNativeFingerprint, checked, "the consent is for the installation the confirmation described");
  // A refusal before anything changed is "没有升级", not a failed installation, and says what was closed.
  const detail = page.getByRole("dialog", { name: "OpenClaw 详情" });
  await expect(detail.locator(".installation-state")).toContainText("没有升级");
  await expect(detail.locator(".installation-state")).toContainText("OpenClaw 没有任何改动，仍是 2026.3.23-2。升级前关闭了 1 个对话保留的进程，它们下次发消息时会重新连接。");
  await expect(detail).toContainText("另一个 HarnessHub 进程正在使用这个程序");
  await expect(detail.getByText("已核实版本")).toHaveCount(0); await expect(detail.getByRole("button", { name: /安装日志/u })).toHaveCount(0);
  await expect(detail.getByText("安装失败")).toHaveCount(0);
  // The old refusal, which told users to end a task that did not exist, is explained as what it was.
  await detail.getByRole("combobox", { name: "选择安装任务" }).selectOption(legacy.id);
  await expect(detail.locator(".installation-state")).toContainText("没有升级");
  await expect(detail).toContainText("开始前发现这个程序正在运行（例如它的后台服务），按当时的规则没有升级。现在再点升级，会先列出需要重启或关闭的程序，由你确认后再升级。");
  await expect(detail).not.toContainText("请结束对应任务");
  await page.screenshot({ path: join(artifact, "upgrade-unchanged.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-UP2 a conversation whose kept process an upgrade closed says so until its next Turn", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Kept Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const reply = async (text: string, count: number) => {
    await composer.fill(text); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect.poll(async () => { if (!new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session")) return null; const value = await current(); return value.runs.length === count && value.activeRunId === null && value.runs.at(-1).status; }, { timeout: 15000 }).toBe("completed");
  };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Kept Agent", exact: true }).click();
  await page.getByRole("button", { name: "高级配置", exact: true }).click(); await page.getByRole("checkbox", { name: "保持原生进程" }).click(); await page.keyboard.press("Escape");
  await reply("first", 1);
  assert.equal((await current()).retention.process?.harnessId, "native-acp");
  assert.equal(await fixture.runtime().releaseForUpgrade("native-acp"), 1);
  const notice = "升级 Kept Agent 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序，并恢复原生会话。";
  await expect(page.locator("#composer-notice")).toHaveText(notice);
  const closed = await current();
  assert.equal(closed.retention.process, null); assert.equal(closed.retention.upgraded.harnessId, "native-acp");
  const events = await (await context.request.get(origin + "/api/v1/sessions/" + closed.id + "/events?afterSeq=0&limit=100")).json();
  assert.deepEqual(events.events.filter((event: { type: string }) => event.type === "native.process_closed").map((event: { data: { reason: string; cleanup: { closed: boolean } } }) => [event.data.reason, event.data.cleanup.closed]), [["harness_upgrade", true]]);
  // The details panel is open by default at this width.
  await page.getByRole("complementary", { name: "详情栏" }).getByRole("tab", { name: /后台/u }).click();
  await expect(page.locator(".kept-upgraded")).toHaveText("升级 Kept Agent 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序。");
  await page.screenshot({ path: join(artifact, "upgrade-kept-closed.png"), animations: "disabled" });
  await reply("second", 2);
  await expect(page.getByText(notice)).toHaveCount(0);
  assert.equal((await current()).retention.upgraded, undefined, "the next Turn starts the new version");
  assert.deepEqual(errors, []);
});

test("G054-UP3 an upgrade through the product's documented sequence shows its hops, the exact commands, the gateway offline in between and the Doctor's rewrite, cannot be sent until the backup is confirmed, sends that consent, and the task shows each hop (ADR-052)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  // The fixture's OpenClaw shown as the user's npm installation (2026.3.23-2, before July 2026) with the latest release available.
  const viewed = "c".repeat(64), checked = "d".repeat(64), entry = "/opt/homebrew/bin/openclaw";
  const native = (harness: { id: string; management: Record<string, unknown> }) => harness.id !== "openclaw" ? harness : { ...harness, installed: true,
    management: { ...harness.management, source: "system", installedVersion: "2026.3.23-2", programVersion: "2026.3.23-2", latestVersion: "2026.10.9", updateStatus: "available",
      recipe: { controlId: "openclaw-native", kind: "npm", sourceLabel: "npm registry", packageName: "openclaw", referenceVersion: "latest", canInstall: true, reason: null },
      native: { channel: "npm", location: entry, fingerprint: viewed, canInstall: false, canUpgrade: true, reason: null } } };
  const done = { id: "management-33333333-3333-4333-8333-333333333333", harnessId: "openclaw", controlId: "openclaw-native", action: "upgrade", status: "completed", phase: "completed", cancelRequested: false,
    createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:20:00.000Z", resolvedVersion: "2026.10.9", installationId: null, error: null, logCursor: 0,
    native: { channel: "npm", location: entry, beforeVersion: "2026.3.23-2", actualVersion: "2026.10.9", dispatched: true, configurationPreserved: true, restartServices: ["ai.openclaw.gateway"], backupConfirmed: true,
      hops: [{ version: "2026.9.5", installed: true, doctor: "ok" }, { version: "2026.10.9", installed: true, doctor: "ok" }],
      services: [{ label: "ai.openclaw.gateway", outcome: "restarted", pid: 50001, ready: true }, { label: "ai.openclaw.node", outcome: "restarted", pid: 50002, ready: null }], configurationMigrated: ["~/.openclaw/openclaw.json"] } };
  const install = (version: string) => "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew --no-audit --no-fund --allow-scripts=openclaw --registry=https://registry.npmjs.org openclaw@" + version;
  const commands = [entry + " gateway stop", install("2026.9.5"), entry + " doctor --fix --yes", install("2026.10.9"), entry + " doctor --fix --yes", entry + " gateway start", entry + " gateway status --deep", entry + " node restart"];
  let jobs: unknown[] = [], submitted: Record<string, unknown> | null = null;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan", "**/api/v1/harnesses/check-updates"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(native) : { ...body, harnesses: body.harnesses.map(native), jobs } });
  });
  await page.route("**/api/v1/installation-jobs?limit=50", route => route.fulfill({ json: jobs }));
  await page.route("**/api/v1/installation-jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON(); jobs = [done]; await route.fulfill({ status: 202, json: done });
  });
  await page.route("**/api/v1/harnesses/openclaw/maintenance", route => route.fulfill({ json: { harnessId: "openclaw", checkedAt: "2026-11-01T10:00:00.000Z", fingerprint: checked, channel: "npm", location: entry,
    currentVersion: "2026.3.23-2", targetVersion: "2026.10.9", servicesKnown: true,
    restart: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", pid: 4039, command: entry + " gateway start", portKnown: true }], resident: [], processes: [{ pid: 8100, name: "openclaw" }],
    conversations: [], otherUsers: [], staleRecords: 0, plugins: ["openclaw-weixin"],
    notes: ["升级期间 Gateway 停止，微信、飞书等渠道离线，直到最后一跳的 Doctor 通过并重新启动；HarnessHub 不再用 launchctl kickstart 重启它。最好选一个能接受中断的时间升级。"], rollback: null, runtimes: [],
    sequence: { hops: [{ version: "2026.9.5", bridge: true, runtimes: [] }, { version: "2026.10.9", bridge: false, runtimes: [] }], commands,
      gateway: { label: "ai.openclaw.gateway", name: "OpenClaw Gateway", pid: 4039 }, restarts: [{ label: "ai.openclaw.node", name: "OpenClaw Node", pid: 4736, command: entry + " node restart" }],
      backupCommand: "openclaw backup create --output <目录> --verify",
      doctor: { command: entry + " doctor --fix --yes", rewrites: ["~/.openclaw/openclaw.json"], backups: "Doctor 每次改写配置都先把原件轮换保存为 ~/.openclaw/openclaw.json.bak（更早的是 .bak.1 到 .bak.4）。" },
      rollback: "退回旧版本只能从升级前的备份恢复：openclaw backup restore <备份文件> --target <新目录>（不在原目录上恢复）。旧版本打不开新版本迁移过的数据库，所以用 npm 装回旧版本不能恢复。" } } }));
  await page.goto(fixture.gateway.url);
  await page.getByRole("button", { name: "我的 Agent 1 个可升级", exact: true }).click();
  const row = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }) });
  await row.getByRole("button", { name: "升级", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "升级 OpenClaw" });
  await expect(dialog.getByText("2026.3.23-2 → 2026.10.9")).toBeVisible();
  // The hops and the exact lines, in upstream's order; the gateway offline in between; the node service restarted by the product; the Doctor's rewrite and its backups.
  await expect(dialog).toContainText("按 OpenClaw 官方文档的步骤升级（2 跳）");
  await expect(dialog).toContainText("依次装入 2026.9.5（上游要求先经过的中间版本）、2026.10.9，每一跳装好后运行 OpenClaw 自己的 Doctor 迁移配置");
  await expect(dialog.locator(".upgrade-sequence li")).toHaveText(commands);
  await expect(dialog.locator(".upgrade-offline")).toHaveText("OpenClaw Gateway（ai.openclaw.gateway，进程 4039）在第一跳之前由 OpenClaw 自己的命令停止，最后一跳的 Doctor 通过后再由它的命令启动，并核实它重新运行、在端口上监听；期间它连接的渠道（例如微信、飞书）离线。HarnessHub 不用 launchctl kickstart 重启它。");
  await expect(dialog).toContainText("OpenClaw Node（ai.openclaw.node，进程 4736）由 OpenClaw 自己的命令重启：");
  await expect(dialog.locator(".upgrade-doctor")).toContainText("每一跳的 /opt/homebrew/bin/openclaw doctor --fix --yes 会改写 ~/.openclaw/openclaw.json。Doctor 每次改写配置都先把原件轮换保存为 ~/.openclaw/openclaw.json.bak（更早的是 .bak.1 到 .bak.4）。");
  await expect(dialog).toContainText("openclaw（进程 8100）"); await expect(dialog).toContainText("已安装的插件：openclaw-weixin");
  // No npm rollback is offered: the previous version is only returned to from the backup, which the user must confirm before the upgrade can be sent.
  await expect(dialog).not.toContainText("要退回 2026.3.23-2，先运行"); await expect(dialog).toContainText("退回旧版本只能从升级前的备份恢复");
  await expect(dialog).not.toContainText("launchctl kickstart -k gui/");
  const confirm = dialog.getByRole("button", { name: "升级并重启 OpenClaw Gateway" }), backup = dialog.getByRole("checkbox", { name: /我已运行 openclaw backup create --output <目录> --verify 并核对了备份/u });
  await expect(confirm).toBeDisabled();
  await backup.check(); await expect(confirm).toBeEnabled();
  await backup.uncheck(); await expect(confirm).toBeDisabled(); await backup.check();
  await page.screenshot({ path: join(artifact, "upgrade-sequence.png"), animations: "disabled" });
  await confirm.click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  assert.deepEqual(submitted!.restartServices, ["ai.openclaw.gateway"]); assert.equal(submitted!.backupConfirmed, true); assert.equal(submitted!.expectedNativeFingerprint, checked, "the consent is for the installation the confirmation described");
  // The task shows each hop, the services the sequence started, and the configuration the Doctor migrated: HarnessHub wrote nothing.
  const detail = page.getByRole("dialog", { name: "OpenClaw 详情" });
  await expect(detail.locator(".installation-state")).toContainText("升级完成");
  await expect(detail.locator(".installation-state")).toContainText("已升级到 2026.10.9，已重启 ai.openclaw.gateway、ai.openclaw.node，~/.openclaw/openclaw.json 由 Doctor 迁移。");
  await expect(detail.locator(".upgrade-hop")).toHaveText(["2026.9.5：已装入，Doctor 通过", "2026.10.9：已装入，Doctor 通过"]);
  await expect(detail).toContainText("HarnessHub 没有写入；~/.openclaw/openclaw.json 由产品的 Doctor 迁移，原件在它的 .bak 备份里");
  await expect(detail).toContainText("ai.openclaw.gateway：已重启（进程 50001），正在监听"); await expect(detail).toContainText("ai.openclaw.node：已重启（进程 50002），可用性未验证");
  // The page scans once the task ended; that request must not be mid-flight through a route when the browser closes.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  assert.deepEqual(errors, []);
});

test("G054-OC1 a Harness lists each official installation with the one in use, and a non-official one only as a note beside the official way to install (ADR-044)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  // The fixture's Codex shown with three npm installations and an adapter; its DeepSeek Harness only as a source checkout on PATH.
  const shaped = (harness: { id: string; installed: boolean; installations: unknown[]; unofficial: unknown; install: unknown; management: Record<string, unknown>; controls: { available: boolean }[] }) => harness.id === "codex" ? { ...harness,
    installations: [
      { ref: "1".repeat(64), channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "codex", version: "0.162.1", role: "product", active: true, maintained: true, canUninstall: true, upgrade: null, latest: null },
      { ref: "2".repeat(64), channel: "npm", label: "npm 全局（Homebrew 的 Node.js）", command: "codex", version: "0.160.0", role: "product", active: false, maintained: true, canUninstall: true, upgrade: null, latest: null },
      { ref: "3".repeat(64), channel: "pnpm", label: "pnpm 全局", command: "codex", version: "0.150.0", role: "product", active: false, maintained: false, canUninstall: false, upgrade: null, latest: null },
      { ref: "4".repeat(64), channel: "npm", label: "npm 全局（Homebrew 的 Node.js）", command: "codex-acp", version: "0.9.0", role: "adapter", active: true, maintained: true, canUninstall: true, upgrade: null, latest: null }],
    unofficial: { command: "codex", onPath: true, pathDefault: true } }
    : harness.id === "dsh" ? { ...harness, installed: false, installations: [], unofficial: { command: "dsh", onPath: true, pathDefault: true }, controls: harness.controls.map(control => ({ ...control, available: false })),
      management: { ...harness.management, source: "missing" } } : harness;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped) } });
  });
  await page.goto(fixture.gateway.url);
  // Gemini CLI below is frozen, so the frozen Harnesses are shown first (ADR-050).
  await showFrozenHarnesses(page);
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
  await page.getByRole("button", { name: "查看 Codex 详情", exact: true }).click();
  const codex = page.getByRole("dialog", { name: "Codex 详情" });
  await expect(codex.locator(".harness-installations li")).toHaveText([
    "npm 全局（nvm v26.11.1）当前使用卸载v0.162.1", "npm 全局（Homebrew 的 Node.js）卸载v0.160.0", "pnpm 全局v0.150.0 · 当前版本不维护这种安装方式", "npm 全局（Homebrew 的 Node.js）接入口 codex-acp当前使用卸载v0.9.0"]);
  // Each maintained installation can be uninstalled on its own; a pnpm installation is listed only.
  await expect(codex.getByRole("button", { name: /^卸载/u })).toHaveCount(3);
  await expect(codex).toContainText("“当前使用”按 HarnessHub 服务进程的 PATH 顺序确定；终端常被 nvm 等改动 PATH，用的可能是另一份。");
  await expect(codex.locator(".harness-installations li").first().locator("[title]")).toHaveAttribute("title", "按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同");
  // A development Gateway says it accepts unofficial entries; this fixture is one.
  await expect(page.locator(".development-entries")).toHaveText("开发模式：接受非官网安装。服务以 --allow-unofficial 启动，列表里的开发入口不是正式安装。");
  await expect(codex.locator(".harness-unofficial")).toHaveText("在 PATH 中发现一个非官网安装（开发目录、npm link 或其他），命令名 codex；平台不使用也不维护它。终端里 codex 运行的是这份非官网安装；HarnessHub 使用的是标为“当前使用”的官网安装。");
  await page.screenshot({ path: join(artifact, "harness-installations.png"), animations: "disabled" });
  await codex.getByRole("button", { name: "关闭 Harness 详情" }).click();
  await page.getByRole("button", { name: "查看 DeepSeek Harness 详情", exact: true }).click();
  const dsh = page.getByRole("dialog", { name: "DeepSeek Harness 详情" });
  await expect(dsh.locator(".harness-unofficial")).toHaveText("在 PATH 中发现一个非官网安装（开发目录、npm link 或其他），命令名 dsh；平台不使用也不维护它。终端里能用的就是它。");
  await expect(dsh.locator(".harness-installations")).toHaveCount(0);
  await expect(dsh).toContainText("npm install -g @deepseek-ai/dsh"); await expect(dsh).toContainText("命令于 2026-10-17 对照官方说明核对。");
  await dsh.getByRole("button", { name: "关闭 Harness 详情" }).click();
  // The official page's own note travels with the product, installed or not.
  await page.getByRole("button", { name: "查看 Gemini CLI 详情", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Gemini CLI 详情" }).locator(".harness-install-note")).toHaveText("官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。");
  assert.deepEqual(errors, []);
});

test("G054-UN1 uninstalling one installation first says what it stops, removes and keeps, and sends exactly that consent; a resident program blocks it", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const ref = "e".repeat(64), fingerprint = "f".repeat(64), label = "npm 全局（Homebrew 的 Node.js）";
  const shaped = (harness: { id: string; installations: unknown[]; unofficial: unknown }) => harness.id !== "openclaw" ? harness : { ...harness, installed: true, unofficial: null,
    installations: [{ ref, channel: "npm", label, command: "openclaw", version: "2026.3.23-2", role: "product", active: true, maintained: true, canUninstall: true, upgrade: null, latest: null }] };
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped) } });
  });
  let blocked = true, submitted: Record<string, unknown> | null = null;
  const interrupts = "Gateway 连接的消息渠道（例如微信、飞书）会断开，重新安装并运行 openclaw onboard --install-daemon 后才恢复。";
  await page.route(`**/api/v1/harnesses/openclaw/installations/${ref}/uninstall`, route => route.fulfill({ json: { harnessId: "openclaw", ref, checkedAt: "2026-10-17T10:00:00.000Z", fingerprint,
    channel: "npm", label, role: "product", version: "2026.3.23-2", active: true, commands: ["/opt/homebrew/bin/npm uninstall --global --prefix /opt/homebrew openclaw"],
    removes: ["/opt/homebrew/lib/node_modules/openclaw", "/opt/homebrew/bin/openclaw"], skipped: [], documented: true, kept: ["~/.openclaw"],
    services: [{ label: "ai.openclaw.gateway", name: "OpenClaw Gateway", pid: 4039, commands: ["/opt/homebrew/bin/openclaw gateway stop", "/opt/homebrew/bin/openclaw gateway uninstall"], interrupts }],
    undeclaredServices: [], resident: blocked ? [{ pid: 6576, name: "openclaw-node", stop: "openclaw node stop" }] : [], processes: [{ pid: 8100, name: "openclaw" }],
    conversations: [{ sessionId: "s-idle", title: "空闲的对话", busy: false }], otherUsers: [], localChanges: null, after: { kind: "none" } } }));
  const job = { id: "management-77777777-7777-4777-8777-777777777777", harnessId: "openclaw", controlId: "openclaw-native", action: "uninstall", status: "queued", phase: "queued", cancelRequested: false,
    createdAt: "2026-10-17T10:00:01.000Z", updatedAt: "2026-10-17T10:00:01.000Z", resolvedVersion: "2026.3.23-2", installationId: null, error: null, logCursor: 0,
    native: { channel: "npm", location: "/opt/homebrew/bin/openclaw", beforeVersion: "2026.3.23-2", actualVersion: null, dispatched: false, configurationPreserved: null,
      uninstall: { label, role: "product", stopServices: ["ai.openclaw.gateway"], stoppedServices: [], removed: false } } };
  await page.route("**/api/v1/installation-jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON(); await route.fulfill({ status: 202, json: job });
  });
  // The queued task as the page then follows it; this fixture runs nothing.
  await page.route(`**/api/v1/installation-jobs/${job.id}`, route => route.fulfill({ json: job }));
  await page.route(`**/api/v1/installation-jobs/${job.id}/logs**`, route => route.fulfill({ json: { entries: [], nextSeq: 0, hasMore: false } }));
  await page.goto(fixture.gateway.url);
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
  await page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "OpenClaw 详情" });
  await detail.getByRole("button", { name: `卸载${label}里的 openclaw`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "卸载 OpenClaw" });
  // A resident program the uninstall cannot stop the product's way: said before anything runs, and nothing can be confirmed.
  await expect(dialog.getByText("现在不能卸载")).toBeVisible();
  await expect(dialog.locator(".uninstall-resident")).toHaveText("openclaw-node（进程 6576）正在运行，先运行 openclaw node stop 停止它，再卸载。");
  await expect(dialog.getByRole("button", { name: "停止服务并卸载" })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(detail).toBeVisible(); assert.equal(submitted, null, "nothing is sent while the uninstall is blocked");
  // Otherwise it says what it stops first, what it removes, what stays and what is used afterwards.
  blocked = false;
  await detail.getByRole("button", { name: `卸载${label}里的 openclaw`, exact: true }).click();
  await expect(dialog.locator(".uninstall-service")).toContainText("OpenClaw Gateway（ai.openclaw.gateway，进程 4039）按产品自己的命令停止并注销：");
  for (const text of ["/opt/homebrew/bin/openclaw gateway stop", "/opt/homebrew/bin/openclaw gateway uninstall", interrupts, "服务注册会被移除；重新安装后需要再安装服务。",
    "1 个对话保留的 OpenClaw 进程会先关闭。", "/opt/homebrew/bin/npm uninstall --global --prefix /opt/homebrew openclaw", "/opt/homebrew/lib/node_modules/openclaw",
    "这些程序正在运行这份安装，不会被关闭；卸载后它们可能出错，建议先退出：openclaw（进程 8100）。"]) await expect(dialog).toContainText(text);
  await expect(dialog.locator(".uninstall-kept")).toHaveText("配置、登录和会话数据保留：~/.openclaw。");
  await expect(dialog.locator(".uninstall-after")).toHaveText("卸载后，OpenClaw 在 HarnessHub 里显示为未安装。");
  await page.screenshot({ path: join(artifact, "uninstall-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "停止服务并卸载" }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  const { commandId, ...consent } = submitted!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.deepEqual(consent, { harnessId: "openclaw", action: "uninstall", installation: ref, expectedInstallationFingerprint: fingerprint, stopServices: ["ai.openclaw.gateway"] }, "the consent is exactly what the confirmation showed");
  await expect(page.getByRole("dialog", { name: "OpenClaw 详情" }).locator(".installation-state")).toContainText("等待卸载");
  assert.deepEqual(errors, []);
});

test("G054-IN1 installing a missing product the official way first says what runs, where it writes and what the terminal will run, and sends exactly the confirmed check", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const fingerprint = "a".repeat(64);
  const shaped = (harness: { id: string; install: Record<string, unknown> | null; installations: unknown[] }) => harness.id !== "dsh" ? harness
    : { ...harness, installed: false, installations: [], unofficial: null, install: { ...harness.install, method: "npm", available: true } };
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped) } });
  });
  let blocked: string | null = "@deepseek-ai/dsh@9.9.7 要求 Node.js >=26，安装用的 Node.js（~/.nvm/versions/node/v24.0.0/bin/node）是 24.0.0。请先升级这个 Node.js；HarnessHub 不安装 Node.js。";
  const note = "DeepSeek Harness 会读取 ~/.dsh 下已有的配置和 acp profile（包括源码版留下的）；HarnessHub 还没有验证它们与官网版的兼容性。";
  await page.route("**/api/v1/harnesses/dsh/install", route => route.fulfill({ json: { harnessId: "dsh", checkedAt: "2026-10-17T11:00:00.000Z", fingerprint, expiresAt: "2026-10-17T11:15:00.000Z", method: "npm",
    officialCommand: "npm install -g @deepseek-ai/dsh", docs: "https://www.npmjs.com/package/@deepseek-ai/dsh", source: "@deepseek-ai/dsh@9.9.7", sha256: null,
    runs: "~/.nvm/versions/node/v26.11.1/bin/npm install --global --prefix ~/.nvm/versions/node/v26.11.1 @deepseek-ai/dsh@9.9.7", writes: ["~/.nvm/versions/node/v26.11.1"], shellProfile: null, configFiles: [],
    version: "9.9.7", prefix: { label: "nvm v26.11.1", path: "~/.nvm/versions/node/v26.11.1" },
    runtime: { runtime: "Node.js", required: ">=22", found: "26.11.1", path: "~/.nvm/versions/node/v26.11.1/bin/node", satisfied: true, service: null, restarted: true, upgradeCommand: null },
    terminal: { command: "dsh", before: null, after: "this" }, notes: [note], blocked } }));
  let submitted: Record<string, unknown> | null = null;
  const job = { id: "management-88888888-8888-4888-8888-888888888888", harnessId: "dsh", controlId: "dsh", action: "install", status: "queued", phase: "queued", cancelRequested: false,
    createdAt: "2026-10-17T11:00:05.000Z", updatedAt: "2026-10-17T11:00:05.000Z", resolvedVersion: null, installationId: null, error: null, logCursor: 0,
    native: { channel: "npm", location: "~/.nvm/versions/node/v26.11.1/bin/dsh", beforeVersion: null, actualVersion: null, dispatched: false, configurationPreserved: null,
      official: { method: "npm", source: "@deepseek-ai/dsh@9.9.7", sha256: null, shellChanges: [], configChanges: [], blocked: [], installed: false } } };
  await page.route("**/api/v1/installation-jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON(); await route.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/v1/installation-jobs/${job.id}`, route => route.fulfill({ json: job }));
  await page.route(`**/api/v1/installation-jobs/${job.id}/logs**`, route => route.fulfill({ json: { entries: [], nextSeq: 0, hasMore: false } }));
  await page.goto(fixture.gateway.url);
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
  const row = page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: "查看 DeepSeek Harness 详情", exact: true }) });
  await row.getByRole("button", { name: "安装", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "安装 DeepSeek Harness" });
  await expect(dialog.locator(".install-blocked")).toContainText("要求 Node.js >=26");
  await expect(dialog.getByRole("button", { name: "安装", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  assert.equal(submitted, null, "nothing is sent while the install is blocked");
  blocked = null;
  await row.getByRole("button", { name: "安装", exact: true }).click();
  for (const text of ["npm install -g @deepseek-ai/dsh", "@deepseek-ai/dsh@9.9.7", "~/.nvm/versions/node/v26.11.1/bin/npm install --global --prefix ~/.nvm/versions/node/v26.11.1 @deepseek-ai/dsh@9.9.7",
    "nvm v26.11.1（~/.nvm/versions/node/v26.11.1）", "26.11.1 满足 >=22", note]) await expect(dialog).toContainText(text);
  // 9.9.7 is a version no record names; the confirmation states it and says nothing about it (ADR-053).
  for (const text of ["还不是", "验证过的版本"]) await expect(dialog).not.toContainText(text);
  await expect(dialog.locator(".install-terminal")).toHaveText("安装后，终端里的 dsh 就是这份新安装。");
  await page.screenshot({ path: join(artifact, "install-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "安装", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  const { commandId, ...consent } = submitted!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.deepEqual(consent, { harnessId: "dsh", action: "install", expectedInstallFingerprint: fingerprint });
  await expect(page.getByRole("dialog", { name: "DeepSeek Harness 详情" }).locator(".installation-state")).toContainText("等待安装");
  assert.deepEqual(errors, []);
});

test("G054-UG1 upgrading one installation first says the versions, what runs and who uses it, and sends exactly the confirmed check; Hermes is only shown for the terminal", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const homebrewNode = "e".repeat(64), nvm = "d".repeat(64), checkout = "c".repeat(64), fingerprint = "f".repeat(64), label = "npm 全局（Homebrew 的 Node.js）";
  const checkedAt = "2026-10-17T12:00:00.000Z";
  const shaped = (harness: { id: string; installations: unknown[]; unofficial: unknown }) => harness.id === "claude" ? { ...harness, installed: true, unofficial: null, installations: [
    { ref: nvm, channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "claude", version: "2.1.302", role: "product", active: true, maintained: true, canUninstall: true, upgrade: "version", latest: { version: "2.1.302", source: "npm", checkedAt, error: null } },
    { ref: homebrewNode, channel: "npm", label, command: "claude", version: "2.1.296", role: "product", active: false, maintained: true, canUninstall: true, upgrade: "version", latest: { version: "2.1.305", source: "npm", checkedAt, error: null } }] }
    : harness.id === "hermes" ? { ...harness, installed: true, unofficial: null, installations: [
      { ref: checkout, channel: "script", label: "官方安装脚本", command: "hermes", version: null, role: "product", active: true, maintained: true, canUninstall: true, upgrade: "terminal", latest: null }] } : harness;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped) } });
  });
  let busy = true, submitted: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/harnesses/claude/installations/${homebrewNode}/upgrade`, route => route.fulfill({ json: { harnessId: "claude", ref: homebrewNode, checkedAt, fingerprint, expiresAt: "2026-10-17T12:15:00.000Z",
    label, role: "product", channel: "npm", kind: "version", current: "2.1.296", target: "2.1.305", prerelease: false,
    runs: "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.305", writes: ["/opt/homebrew"], script: null, shellProfile: null, configFiles: [], dependencies: [], sharedRuntimes: [], runtime: null,
    active: false, conversations: [{ sessionId: "s-busy", title: "正在回复的对话", busy }], otherUsers: [], processes: [{ pid: 4242, name: "claude" }], terminal: null,
    notes: ["这不是 HarnessHub 当前使用的那份（当前使用 npm 全局（nvm v26.11.1））；升级后“当前使用”不变。"],
    blocked: busy ? "有 1 个 HarnessHub 对话正在使用这份安装（正在回复或等你处理），等它们结束或停止后再升级。" : null } }));
  const explains = "它会把 ~/.hermes/hermes-agent 里的本地改动先 git stash，再 git pull 或 git reset 到最新、重装依赖、迁移 ~/.hermes/config.yaml，并重启网关（QQ 等消息渠道会断开片刻）。HarnessHub 不代为运行，请在终端运行。";
  await page.route(`**/api/v1/harnesses/hermes/installations/${checkout}/upgrade`, route => route.fulfill({ json: { harnessId: "hermes", ref: checkout, checkedAt, fingerprint: "a".repeat(64), expiresAt: checkedAt,
    label: "官方安装脚本", role: "product", channel: "script", kind: "terminal", current: "0.12.0", target: null, prerelease: false, runs: "hermes update --yes", writes: [], script: null, shellProfile: null, configFiles: [],
    dependencies: [], sharedRuntimes: [], runtime: null, active: true, conversations: [], otherUsers: [], processes: [],
    terminal: { command: "hermes update --yes", explains, localChanges: 2 }, notes: ["这份安装的目录里有 2 处没有提交的改动，hermes update --yes 会先把它们 git stash 起来。"],
    blocked: "HarnessHub 不代为运行这个产品的更新，请在终端运行 hermes update --yes。" } }));
  const job = { id: "management-99999999-9999-4999-8999-999999999999", harnessId: "claude", controlId: "claude-acp-npm", action: "upgrade", status: "completed", phase: "completed", cancelRequested: false,
    createdAt: "2026-10-17T12:00:05.000Z", updatedAt: "2026-10-17T12:01:05.000Z", resolvedVersion: "2.1.305", installationId: null, error: null, logCursor: 0,
    native: { channel: "npm", location: "/opt/homebrew/bin/claude", beforeVersion: "2.1.296", actualVersion: "2.1.305", dispatched: true, configurationPreserved: true,
      installation: { label, role: "product", kind: "version", command: "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.305", dependencies: [], shellChanges: [], configChanges: [], blocked: [] } } };
  await page.route("**/api/v1/installation-jobs", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    submitted = route.request().postDataJSON(); await route.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/v1/installation-jobs/${job.id}`, route => route.fulfill({ json: job }));
  await page.route(`**/api/v1/installation-jobs/${job.id}/logs**`, route => route.fulfill({ json: { entries: [], nextSeq: 0, hasMore: false } }));
  await page.goto(fixture.gateway.url);
  await page.getByRole("button", { name: "我的 Agent", exact: true }).click();
  await page.getByRole("button", { name: "查看 Claude Code 详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Claude Code 详情" });
  // Each installation says what the last update check found; the one behind offers its exact newer version.
  await expect(detail.locator(".harness-installations li").nth(0)).toContainText("v2.1.302 · 已是最新");
  await expect(detail.locator(".harness-installations li").nth(1)).toContainText("v2.1.296 · 可升级到 v2.1.305");
  await detail.getByRole("button", { name: `升级到 v2.1.305：${label}里的 claude`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "升级 Claude Code" });
  // A conversation replying with it blocks the upgrade, and the conversation can be opened from there.
  await expect(dialog.locator(".upgrade-blocked")).toContainText("有 1 个 HarnessHub 对话正在使用这份安装");
  await expect(dialog.getByRole("button", { name: "正在回复的对话" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "升级", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  assert.equal(submitted, null, "nothing is sent while the upgrade is blocked");
  busy = false;
  await detail.getByRole("button", { name: `升级到 v2.1.305：${label}里的 claude`, exact: true }).click();
  for (const text of ["2.1.296 → 2.1.305", "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.305", "/opt/homebrew；其他位置都不能写。",
    "这些程序正在运行这份安装，不会被关闭，重开后才用新版本：claude（进程 4242）。", "升级后“当前使用”不变。"]) await expect(dialog).toContainText(text);
  // 2.1.305 is a version no record names: stated as the target, with nothing inferred from it (ADR-053).
  for (const text of ["还不是", "验证过的版本"]) await expect(dialog).not.toContainText(text);
  await page.screenshot({ path: join(artifact, "installation-upgrade-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "升级", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  const { commandId, ...consent } = submitted!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.deepEqual(consent, { harnessId: "claude", action: "upgrade", installation: homebrewNode, expectedInstallationFingerprint: fingerprint }, "the request is exactly the confirmed check");
  await expect(page.getByRole("dialog", { name: "Claude Code 详情" }).locator(".installation-state")).toContainText(`已升级${label}里的 Claude Code：2.1.296 → 2.1.305。`);
  // Hermes updates only in a terminal: the command and what it does are shown, and nothing can be confirmed.
  await page.getByRole("dialog", { name: "Claude Code 详情" }).getByRole("button", { name: "关闭 Harness 详情" }).click();
  await page.getByRole("button", { name: "查看 Hermes Agent 详情", exact: true }).click();
  await page.getByRole("dialog", { name: "Hermes Agent 详情" }).getByRole("button", { name: "更新方式：官方安装脚本里的 hermes", exact: true }).click();
  const terminal = page.getByRole("dialog", { name: "升级 Hermes Agent" });
  await expect(terminal.locator(".upgrade-terminal-command")).toHaveText("hermes update --yes");
  await expect(terminal).toContainText(explains); await expect(terminal).toContainText("2 处没有提交的改动");
  await expect(terminal.getByRole("button", { name: "升级", exact: true })).toHaveCount(0);
  await terminal.getByRole("button", { name: "关闭", exact: true }).click(); await expect(terminal).toBeHidden();
  assert.deepEqual(errors, []);
});

/** The capability view the page tests show: four Harnesses, a skill of each kind of visibility, and one unreadable file. */
/** What a history holds besides its changes, backups and drift: no orphaned settings and no skill snapshots yet. */
const HISTORY_EXTRA = { orphans: [] as unknown[], snapshots: { count: 0, bytes: 0, keep: 50 } };
function capabilityView() {
  const all = { skill: "read", mcp: "read", instructions: "read", subagent: "read", command: "read", hook: "read", plugin: "read" };
  const view = { checkedAt: "2026-10-18T09:00:00.000Z", truncated: false,
    harnesses: [{ harnessId: "claude", name: "Claude Code", version: "2.1.302", kinds: all, skillSwitch: "file", pluginSwitch: "file", pluginReason: null, shared: { reads: "links", links: 1, redundant: 0, placeable: "skill-link" }, notes: ["自定义命令已并入技能，同名时技能优先。"] },
      { harnessId: "codex", name: "Codex", version: "0.162.1", kinds: all, skillSwitch: "file", pluginSwitch: "file", pluginReason: null, shared: { reads: "native", links: 0, redundant: 0, placeable: null }, notes: [] },
      { harnessId: "cursor", name: "Cursor", version: "2026.10.01-e373342", kinds: { ...all, instructions: "invisible", command: "unsupported", plugin: "invisible" }, skillSwitch: null, pluginSwitch: null, pluginReason: "Cursor 不在磁盘上记录插件。", shared: { reads: "native", links: 0, redundant: 0, placeable: null }, notes: ["Cursor 的用户规则保存在应用设置里，不在磁盘上。"] },
      { harnessId: "hermes", name: "Hermes Agent", version: "0.12.0", kinds: { ...all, instructions: "unsupported", subagent: "unsupported", command: "unsupported" }, skillSwitch: "file", pluginSwitch: null,
        pluginReason: "hermes plugins enable 会经 save_config 整份重写 config.yaml（丢掉注释、补上默认项），暂时只读。", shared: { reads: "links", links: 1, redundant: 0, placeable: "shared-dir" }, notes: ["Hermes 0.12 不读 ~/.agents/skills。"] }],
    entries: [
      { kind: "skill", key: "skill:alpha", name: "alpha", description: "Shared alpha skill", owner: "skills-cli", source: "https://github.com/owner/repo.git", location: "~/.agents/skills/alpha",
        edges: [{ harnessId: "claude", mechanism: "linked", status: "active", via: "~/.claude/skills/alpha", reason: null }, { harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/alpha", reason: null },
          { harnessId: "codex", mechanism: "own-copy", status: "active", via: "~/.codex/skills/alpha", reason: null }, { harnessId: "cursor", mechanism: "native-shared", status: "duplicate", via: "~/.agents/skills/alpha", reason: "Cursor 没有说明同名技能怎样处理" },
          { harnessId: "hermes", mechanism: "linked", status: "active", via: "~/.hermes/skills/alpha", reason: null }],
        warnings: [{ kind: "duplicate", harnessId: "codex", text: "Codex 会同时列出 2 个名为 alpha 的技能：~/.agents/skills/alpha、~/.codex/skills/alpha。" }], facts: { kind: "skill", files: 2, bytes: 2048 },
        shared: { folder: "~/.agents/skills/alpha", placed: [] } },
      { kind: "skill", key: "skill:beta", name: "beta", description: null, owner: "user", source: null, location: "~/.agents/skills/beta",
        edges: [{ harnessId: "claude", mechanism: "linked", status: "disabled", via: "~/.claude/skills/beta", reason: "settings.json 的 skillOverrides 把它设为 off" }, { harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/beta", reason: null }],
        warnings: [], facts: { kind: "skill", files: 1, bytes: 300 } },
      { kind: "mcp", key: "mcp:github", name: "github", description: null, owner: "user", source: null, location: "~/.claude.json",
        edges: [{ harnessId: "claude", mechanism: "config", status: "active", via: "~/.claude.json", reason: null, facts: { kind: "mcp", transport: "stdio", program: "npx @modelcontextprotocol/server-github", host: null, variables: ["GITHUB_TOKEN"], headers: [], references: 1, literal: 0, enabled: true } }],
        warnings: [], facts: { kind: "mcp", transport: "stdio", program: "npx @modelcontextprotocol/server-github", host: null, variables: ["GITHUB_TOKEN"], headers: [], references: 1, literal: 0, enabled: true } },
      { kind: "instructions", key: "instructions:~/.claude/CLAUDE.md", name: "~/.claude/CLAUDE.md", description: null, owner: "user", source: null, location: "~/.claude/CLAUDE.md",
        edges: [{ harnessId: "claude", mechanism: "config", status: "active", via: "~/.claude/CLAUDE.md", reason: null }], warnings: [], facts: { kind: "instructions", bytes: 120, managedBlocks: [] } },
      { kind: "subagent", key: "subagent:reviewer", name: "reviewer", description: "Reviews changes", owner: "user", source: null, location: "~/.claude/agents/reviewer.md",
        edges: [{ harnessId: "claude", mechanism: "own-copy", status: "active", via: "~/.claude/agents/reviewer.md", reason: null }, { harnessId: "cursor", mechanism: "compat-root", status: "active", via: "~/.claude/agents/reviewer.md", reason: null }],
        warnings: [{ kind: "cross", harnessId: "cursor", text: "Cursor 也会使用 ~/.claude/agents/reviewer.md。" }], facts: { kind: "subagent", format: "markdown" } },
      { kind: "hook", key: "hook:~/.claude/settings.json#PreToolUse#0.0", name: "PreToolUse（Bash）", description: "guard.sh", owner: "user", source: null, location: "~/.claude/settings.json",
        edges: [{ harnessId: "claude", mechanism: "config", status: "active", via: "~/.claude/settings.json", reason: null }, { harnessId: "cursor", mechanism: "compat-root", status: "active", via: "~/.claude/settings.json", reason: null }],
        warnings: [{ kind: "cross", harnessId: "cursor", text: "Cursor 默认也会运行这个 Hook（来自 ~/.claude/settings.json）。" }], facts: { kind: "hook", event: "PreToolUse", matcher: "Bash", program: "guard.sh" } },
      // One plugin both Claude Code and Codex have: one row, each Harness with its own version, state and switch.
      { kind: "plugin", key: "plugin:tool@market", name: "tool@market", description: null, owner: "user", source: null, location: "~/.claude/plugins/installed_plugins.json",
        edges: [{ harnessId: "claude", mechanism: "config", status: "active", via: "~/.claude/plugins/installed_plugins.json", reason: null, facts: { kind: "plugin", version: "1.2.0", enabled: true, switchable: true } },
          { harnessId: "codex", mechanism: "config", status: "disabled", via: "~/.codex/config.toml", reason: "Codex 停用了它", facts: { kind: "plugin", version: "1.1.0", enabled: false, switchable: true } }],
        warnings: [], facts: { kind: "plugin", version: "1.2.0", enabled: true, switchable: true } }],
    unreadable: [{ harnessId: "codex", file: "~/.codex/config.toml", reason: "无法解析（TomlError）" }] };
  return view;
}

test("G054-CA1 the capability page opens from the sidebar and from a Harness's details, shows every kind as an entry × Harness matrix, and expands an entry's warnings", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const view = capabilityView();
  let requests = 0;
  await page.route("**/api/v1/capabilities", route => { requests++; return route.fulfill({ json: view }); });
  const ref = "a".repeat(64), shaped = (harness: { id: string; installations: unknown[]; unofficial: unknown }) => harness.id === "claude" ? { ...harness, installed: true, unofficial: null, installations: [
    { ref, channel: "npm", label: "npm 全局（nvm v26.11.1）", command: "claude", version: "2.1.302", role: "product", active: true, maintained: true, canUninstall: true, upgrade: null, latest: null }] } : harness;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped) } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  const navigation = page.getByRole("complementary", { name: "主导航" });
  await navigation.getByRole("button", { name: "能力", exact: true }).click();
  await expect(page.getByRole("heading", { name: "能力", exact: true })).toBeVisible();
  // Cursor is frozen: its column, its place in the Harness list and its reading rules stay out until the settings show it (ADR-050).
  const matrix = page.locator(".capability-matrix");
  await expect(matrix.locator("thead th")).toHaveText([/技能/u, /Claude Code/u, /Codex/u, /Hermes Agent/u]);
  await expect(page.getByRole("combobox", { name: "只看一个 Harness" }).locator("option")).toHaveText(["全部 Harness", "Claude Code", "Codex", "Hermes Agent"]);
  await showFrozenHarnesses(page);
  await navigation.getByRole("button", { name: "能力", exact: true }).click();
  // Seven kinds, each with its count; the skills matrix has one column per Harness, saying how each sees each skill.
  const tabs = page.getByRole("tablist", { name: "能力类别" });
  for (const [label, count] of [["技能", 2], ["MCP", 1], ["指令", 1], ["子 Agent", 1], ["命令", 0], ["Hooks", 1], ["插件", 1]] as const) await expect(tabs.getByRole("tab", { name: label + " " + count, exact: true })).toBeVisible();
  // Each column names its Harness and the version its channel records, Cursor's dated one like the others; no column says anything about its version (ADR-053).
  await expect(matrix.locator("thead th")).toHaveText([/技能/u, /Claude Code.*v2\.1\.302/u, /Codex.*v0\.162\.1/u, /Cursor.*v2026\.10\.01-e373342/u, /Hermes Agent.*v0\.12\.0/u]);
  await expect(matrix.locator("thead")).not.toContainText("核实");
  // The rules section says which version each Harness runs and points to its notes, and nothing about the version.
  const rules = page.locator("details").filter({ hasText: "各 Harness 的读取规则与说明" });
  await rules.locator("summary").click();
  await expect(rules).toContainText("v2026.10.01-e373342 · 读取规则见说明"); await expect(rules).toContainText("Cursor 的用户规则保存在应用设置里，不在磁盘上。");
  await expect(rules).not.toContainText("核实");
  await rules.locator("summary").click();
  const alpha = matrix.locator("tbody tr").filter({ hasText: "alpha" }).first();
  await expect(alpha.locator("td").nth(0)).toHaveText("✓链接"); await expect(alpha.locator("td").nth(1)).toHaveText("✓共享目录✓自有目录"); await expect(alpha.locator("td").nth(2)).toHaveText("⧉重复");
  await expect(matrix.locator("tbody tr").filter({ hasText: "beta" }).first().locator("td").nth(0)).toHaveText("⊘已停用");
  await expect(alpha).toContainText("vercel skills"); await expect(alpha).toContainText("1 条提示");
  // An entry expands to where each Harness finds it, why, and the warnings.
  await alpha.getByRole("button", { name: /alpha/u }).click();
  const detail = page.locator(".capability-detail");
  for (const text of ["~/.agents/skills/alpha", "https://github.com/owner/repo.git", "2 个文件 · 2.0 KB", "Cursor 没有说明同名技能怎样处理", "Codex 会同时列出 2 个名为 alpha 的技能"]) await expect(detail).toContainText(text);
  // A file that could not be read is said, with the reason.
  await expect(page.getByText("有文件无法读取，其中的内容没有显示")).toBeVisible(); await expect(page.getByText("无法解析（TomlError）")).toBeVisible();
  // Filters: search, one Harness, and only entries with warnings or not in use.
  await page.getByRole("textbox", { name: "搜索能力" }).fill("bet"); await expect(matrix.locator("tbody tr")).toHaveCount(1); await page.getByRole("textbox", { name: "搜索能力" }).fill("");
  await page.getByRole("checkbox", { name: "只看有提示或未生效的" }).check(); await expect(matrix.locator("tbody > tr").filter({ hasText: "beta" })).toHaveCount(1);
  await page.getByRole("checkbox", { name: "只看有提示或未生效的" }).uncheck();
  // Other kinds: a kind a Harness keeps off disk or does not have is marked in its column; an empty kind says so.
  await tabs.getByRole("tab", { name: "指令 1", exact: true }).click();
  const instructions = matrix.locator("tbody tr").first();
  await expect(instructions.locator("td").nth(2)).toHaveText("?"); await expect(instructions.locator("td").nth(3)).toHaveText("—");
  await tabs.getByRole("tab", { name: "Hooks 1", exact: true }).click();
  await matrix.locator("tbody tr").first().getByRole("button").click();
  await expect(page.locator(".capability-detail")).toContainText("Cursor 默认也会运行这个 Hook");
  await tabs.getByRole("tab", { name: "命令 0", exact: true }).click();
  await expect(page.getByText("这一类还没有条目")).toBeVisible();
  await tabs.getByRole("tab", { name: "MCP 1", exact: true }).click();
  await expect(matrix.locator("tbody tr").first().locator("td").nth(0)).toHaveText("✓配置");
  await page.getByRole("combobox", { name: "只看一个 Harness" }).selectOption("codex");
  await expect(page.getByText("这一类还没有条目")).toBeVisible();
  await page.getByRole("combobox", { name: "只看一个 Harness" }).selectOption("");
  await tabs.getByRole("tab", { name: "技能 2", exact: true }).click();
  await page.screenshot({ path: join(artifact, "capabilities.png"), animations: "disabled" });
  // From a Harness's details, the page opens on that Harness.
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "我的 Agent" }).click();
  await page.getByRole("button", { name: "查看 Claude Code 详情", exact: true }).click();
  await page.getByRole("dialog", { name: "Claude Code 详情" }).getByRole("button", { name: "查看 Claude Code 的能力", exact: true }).click();
  await expect(page.getByRole("heading", { name: "能力", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "只看一个 Harness" })).toHaveValue("claude");
  await expect(page.locator(".capability-matrix thead th")).toHaveCount(2);
  // At phone width the matrix scrolls inside its frame; the page itself does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  assert.ok(requests >= 2, "the view is read each time the page opens");
  assert.deepEqual(errors, []);
});

test("G054-CA2 turning a skill off shows the file and the exact change first, sends exactly the confirmed check, and the result can be restored", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const fingerprint = "f".repeat(64), restoreFingerprint = "e".repeat(64), backupId = "11111111-2222-4333-8444-555555555555", at = "2026-10-18T09:30:00.000Z";
  const diff = "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -2,5 +2,5 @@\n   \"model\": \"claude-opus-5-5\",\n   \"skillOverrides\": {\n-    \"alpha\": \"user-invocable-only\"\n+    \"alpha\": \"off\"\n   },\n";
  const checks: URLSearchParams[] = [], posted: Record<string, unknown>[] = [], restores: Record<string, unknown>[] = [];
  let history = { changes: [] as unknown[], backups: [] as unknown[], drift: [] as unknown[], ...HISTORY_EXTRA };
  const change = { id: "c-1", kind: "skill-switch", harnessId: "claude", subject: "alpha", file: "~/.claude/settings.json", status: "applied", diff, backupId, error: null, notes: ["Claude Code 会立即读到改动。"], at };
  // OpenClaw too: its switch is its own command, whose rewrite is summarized first.
  const view = capabilityView(), openclawKinds = { skill: "read", mcp: "read", instructions: "read", subagent: "unsupported", command: "unsupported", hook: "read", plugin: "read" };
  view.harnesses.push({ harnessId: "openclaw", name: "OpenClaw", version: "2026.3.23-2", kinds: openclawKinds, skillSwitch: "command", pluginSwitch: null, pluginReason: "本机版改 plugins.* 会让 Gateway 自动重启（ADR-045 裁决第 9 条），只读。", shared: { reads: "native", links: 52, redundant: 52, placeable: null }, notes: [] } as unknown as typeof view.harnesses[number]);
  (view.entries[0]!.edges as unknown[]).push({ harnessId: "openclaw", mechanism: "native-shared", status: "active", via: "~/.agents/skills/alpha", reason: null });
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: view }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route("**/api/v1/capabilities/skill-switch?**", route => {
    const query = new URL(route.request().url()).searchParams; checks.push(query);
    if (query.get("harnessId") === "openclaw") return route.fulfill({ json: { kind: "skill-switch", harnessId: "openclaw", name: "alpha", enabled: false, file: "~/.openclaw/openclaw.json",
      command: "openclaw config set skills.entries.alpha.enabled false --strict-json", diff: "--- a/~/.openclaw/openclaw.json\n+++ b/~/.openclaw/openclaw.json\n@@ -1,3 +1,9 @@\n-{\n-  // mine\n+{\n+  \"commands\": {}\n",
      rewrite: { target: "skills.entries.alpha.enabled", before: null, after: "false", added: ["commands", "meta"], removed: [], changed: [], commentLines: 1 }, links: [], current: "none",
      notes: ["正在运行的 OpenClaw Gateway（飞书、微信等频道）不会被 HarnessHub 重启。"], blocked: null, fingerprint: "c".repeat(64), expiresAt: "2026-10-18T09:45:00.000Z" } });
    if (query.get("harnessId") === "hermes") return route.fulfill({ json: { kind: "skill-switch", harnessId: "hermes", name: "alpha", enabled: false, file: "~/.hermes/config.yaml", command: null, diff: null, rewrite: null, links: [], current: "none",
      notes: [], blocked: "无需修改：它已经在 skills.disabled 里。", fingerprint: "d".repeat(64), expiresAt: "2026-10-18T09:45:00.000Z" } });
    return route.fulfill({ json: { kind: "skill-switch", harnessId: query.get("harnessId"), name: "alpha", enabled: false, file: query.get("harnessId") === "codex" ? "~/.codex/config.toml" : "~/.claude/settings.json",
      command: null, diff, rewrite: null, links: [], current: "other", notes: ["原来是 user-invocable-only；停用后改成 off，之后在这里启用会改回 user-invocable-only。"], blocked: null, fingerprint, expiresAt: "2026-10-18T09:45:00.000Z" } });
  });
  await page.route("**/api/v1/capabilities/changes", async route => {
    posted.push(route.request().postDataJSON() as Record<string, unknown>);
    history = { changes: [change], backups: [{ id: backupId, file: "~/.claude/settings.json", createdAt: at, bytes: 120, changeId: "c-1", subject: "alpha" }], drift: [], ...HISTORY_EXTRA };
    await route.fulfill({ json: change });
  });
  await page.route(`**/api/v1/capabilities/backups/${backupId}/restore`, route => route.fulfill({ json: { backupId, file: "~/.claude/settings.json", diff: diff.replace("-    \"alpha\": \"user-invocable-only\"\n+    \"alpha\": \"off\"", "-    \"alpha\": \"off\"\n+    \"alpha\": \"user-invocable-only\""),
    changedSince: false, notes: ["恢复前会先备份现在的文件。"], fingerprint: restoreFingerprint, expiresAt: "2026-10-18T09:45:00.000Z" } }));
  await page.route("**/api/v1/capabilities/restores", async route => {
    restores.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { id: "c-2", kind: "restore", harnessId: null, subject: "alpha", file: "~/.claude/settings.json", status: "applied", diff: null, backupId: "22222222-2222-4333-8444-555555555555", error: null, notes: ["已恢复到“alpha”之前的样子。"], at } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  const matrix = page.locator(".capability-matrix");
  await matrix.locator("tbody tr").filter({ hasText: "alpha" }).first().getByRole("button", { name: /alpha/u }).click();
  // Each Harness with a switch offers it; Codex switches each copy; Cursor has none.
  const switches = page.locator(".skill-switches");
  await expect(switches.getByRole("button")).toHaveText(["在 Claude Code 中停用", "在 Codex 中停用（共享目录）", "在 Codex 中停用（自有目录）", "在 Hermes Agent 中停用", "在 OpenClaw 中停用"]);
  await switches.getByRole("button", { name: "在 Claude Code 中停用", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "在 Claude Code 中停用 alpha" });
  for (const text of ["~/.claude/settings.json", "不是 HarnessHub 写的", "原来是 user-invocable-only", "写入前先备份原文件"]) await expect(dialog).toContainText(text);
  await expect(dialog.locator(".capability-diff .text-red")).toHaveText(["-    \"alpha\": \"user-invocable-only\""]);
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+    \"alpha\": \"off\""]);
  assert.deepEqual(Object.fromEntries(checks[0]!), { harnessId: "claude", name: "alpha", enabled: "false" }, "no copy is named for a Harness that switches by name");
  assert.equal(posted.length, 0, "nothing is sent before the confirmation");
  await page.screenshot({ path: join(artifact, "skill-switch-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "停用", exact: true }).click(); await expect(dialog).toBeHidden();
  const { commandId, ...sent } = posted[0]!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u); assert.deepEqual(sent, { fingerprint }, "the request is exactly the confirmed check");
  const result = page.locator(".capability-result");
  await expect(result).toContainText("已在 Claude Code 中停用 alpha"); await expect(result).toContainText("Claude Code 会立即读到改动。");
  // The history lists the change and its backup.
  await page.locator(".capability-history summary").click();
  await expect(page.locator(".capability-history")).toContainText("技能开关 · alpha"); await expect(page.locator(".capability-history")).toContainText("1 次修改 · 1 份备份");
  // Codex names the copy it switches; a check that needs no change cannot be confirmed.
  await switches.getByRole("button", { name: "在 Codex 中停用（共享目录）", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "在 Codex 中停用 alpha" })).toContainText("~/.codex/config.toml");
  assert.equal(checks.at(-1)?.get("via"), "~/.agents/skills/alpha");
  await page.getByRole("dialog", { name: "在 Codex 中停用 alpha" }).getByRole("button", { name: "取消", exact: true }).click();
  await switches.getByRole("button", { name: "在 Hermes Agent 中停用", exact: true }).click();
  const hermes = page.getByRole("dialog", { name: "在 Hermes Agent 中停用 alpha" });
  await expect(hermes.locator(".switch-blocked")).toHaveText("无需修改：它已经在 skills.disabled 里。");
  await expect(hermes.getByRole("button", { name: "停用", exact: true })).toBeDisabled();
  await hermes.getByRole("button", { name: "取消", exact: true }).click();
  // A whole-file rewrite shows the target and a summary; the full masked diff only on request, with its limit said.
  await switches.getByRole("button", { name: "在 OpenClaw 中停用", exact: true }).click();
  const claw = page.getByRole("dialog", { name: "在 OpenClaw 中停用 alpha" });
  await expect(claw.locator(".switch-rewrite")).toContainText("skills.entries.alpha.enabled：（没有） → false");
  await expect(claw.locator(".switch-rewrite")).toContainText("这条命令还会：新增 commands、meta；丢失 1 行注释。");
  await expect(claw.locator(".capability-diff")).toHaveCount(0);
  await claw.getByRole("button", { name: "显示完整差异（已打码）", exact: true }).click();
  await expect(claw.locator(".capability-diff")).toBeVisible(); await expect(claw).toContainText("没有特征的值仍可能显示");
  await expect(claw).toContainText("openclaw config set skills.entries.alpha.enabled false --strict-json");
  await claw.getByRole("button", { name: "取消", exact: true }).click();
  // The result offers the file as it was before; restoring shows its own diff first and sends exactly that check.
  await result.getByRole("button", { name: "恢复修改前的文件", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "恢复修改前的文件" });
  await expect(restore.locator(".capability-diff .text-green")).toHaveText(["+    \"alpha\": \"user-invocable-only\""]);
  await restore.getByRole("button", { name: "恢复", exact: true }).click(); await expect(restore).toBeHidden();
  const { commandId: restoreCommand, ...restored } = restores[0]!;
  assert.match(String(restoreCommand), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u); assert.deepEqual(restored, { fingerprint: restoreFingerprint });
  await expect(page.locator(".capability-result")).toContainText("已恢复 ~/.claude/settings.json");
  assert.deepEqual(errors, []);
});

test("G054-CA3 the shared skills directory says how each Harness reads it, makes Hermes read it, removes redundant links with an undo, and places a skill in Claude Code", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const view = capabilityView(), at = "2026-10-18T10:00:00.000Z", expiresAt = "2026-10-18T10:15:00.000Z";
  view.harnesses.push({ harnessId: "openclaw", name: "OpenClaw", version: "2026.3.23-2", kinds: view.harnesses[0]!.kinds, skillSwitch: "command",
    pluginSwitch: null, pluginReason: "本机版改 plugins.* 会让 Gateway 自动重启（ADR-045 裁决第 9 条），只读。", shared: { reads: "native", links: 2, redundant: 2, placeable: null }, notes: [] } as unknown as typeof view.harnesses[number]);
  (view.entries as unknown[]).push({ kind: "skill", key: "skill:gamma", name: "gamma", description: "Only in the shared directory", owner: "user", source: null, location: "~/.agents/skills/gamma",
    edges: [{ harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/gamma", reason: null }], warnings: [], facts: { kind: "skill", files: 1, bytes: 120 },
    shared: { folder: "~/.agents/skills/gamma", placed: [] } }, { kind: "skill", key: "skill:delta", name: "delta", description: "Placed by HarnessHub", owner: "user", source: null, location: "~/.agents/skills/delta",
    edges: [{ harnessId: "claude", mechanism: "linked", status: "active", via: "~/.claude/skills/delta", reason: null }], warnings: [], facts: { kind: "skill", files: 1, bytes: 120 },
    shared: { folder: "~/.agents/skills/delta", placed: ["~/.claude/skills/delta"] } });
  const check = (kind: string, name: string, extra: Record<string, unknown>) => ({ kind, harnessId: "x", name, enabled: false, file: "~/.hermes/config.yaml", command: null, diff: null, rewrite: null, links: [],
    current: "none", notes: [], blocked: null, fingerprint: "a".repeat(64), expiresAt, ...extra });
  const cleanupLinks = [{ path: "~/.openclaw/skills/alpha", target: "../../.agents/skills/alpha", action: "remove" }, { path: "~/.openclaw/skills/beta", target: "../../.agents/skills/beta", action: "remove" }];
  const requests: string[] = [], posted: Record<string, unknown>[] = [];
  let history = { changes: [] as unknown[], backups: [] as unknown[], drift: [] as unknown[], ...HISTORY_EXTRA };
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: view }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route(/\/api\/v1\/capabilities\/(shared-dir|skill-link|link-cleanup|changes\/[^/]+\/undo)/u, route => {
    const url = new URL(route.request().url()); requests.push(url.pathname.replace("/api/v1/capabilities/", "") + url.search);
    if (url.pathname.endsWith("/shared-dir")) return route.fulfill({ json: check("shared-dir", "~/.agents/skills", { harnessId: "hermes", enabled: true, fingerprint: "1".repeat(64),
      diff: "--- a/~/.hermes/config.yaml\n+++ b/~/.hermes/config.yaml\n@@ -4,3 +4,3 @@\n skills:\n-  external_dirs: []\n+  external_dirs: [\"~/.agents/skills\"]\n", notes: ["Hermes 会多看到 3 个共享技能：gamma、delta、epsilon。", "正在运行的 Hermes 网关（QQ 等消息渠道）不会被 HarnessHub 重启。"] }) });
    if (url.pathname.endsWith("/link-cleanup")) return route.fulfill({ json: check("link-cleanup", "多余链接", { harnessId: "openclaw", file: "~/.openclaw/skills", fingerprint: "2".repeat(64), links: cleanupLinks,
      notes: ["只删 ~/.openclaw/skills 里这 2 个指向 ~/.agents/skills 的链接，技能本身不动；可以在“修改与备份”里撤销。", "`npx skills` 以后可能会重新建这些链接。"] }) });
    if (url.pathname.endsWith("/undo")) return route.fulfill({ json: check("link-undo", "多余链接", { harnessId: "openclaw", file: "~/.openclaw/skills", fingerprint: "3".repeat(64),
      links: cleanupLinks.map(link => ({ ...link, action: "create" })) }) });
    const present = url.searchParams.get("present") === "true";
    return route.fulfill({ json: check("skill-link", url.searchParams.get("name")!, { harnessId: "claude", file: "~/.claude/skills", fingerprint: (present ? "4" : "5").repeat(64), enabled: present, current: present ? "none" : "harnesshub",
      links: [{ path: "~/.claude/skills/" + url.searchParams.get("name"), target: "~/.agents/skills/" + url.searchParams.get("name"), action: present ? "create" : "remove" }] }) });
  });
  const views: Record<string, unknown> = {
    ["1".repeat(64)]: { id: "11111111-1111-4111-8111-111111111111", kind: "shared-dir", harnessId: "hermes", subject: "~/.agents/skills", file: "~/.hermes/config.yaml", status: "applied", diff: null, backupId: "21111111-1111-4111-8111-111111111111", error: null, notes: [], at },
    ["2".repeat(64)]: { id: "12222222-2222-4222-8222-222222222222", kind: "link-cleanup", harnessId: "openclaw", subject: "多余链接", file: "~/.openclaw/skills", status: "applied", diff: null, backupId: null, error: null, notes: [], links: cleanupLinks, at },
    ["3".repeat(64)]: { id: "13333333-3333-4333-8333-333333333333", kind: "link-undo", harnessId: "openclaw", subject: "多余链接", file: "~/.openclaw/skills", status: "applied", diff: null, backupId: null, error: null, notes: [],
      links: cleanupLinks.map(link => ({ ...link, action: "create" })), at },
    ["4".repeat(64)]: { id: "14444444-4444-4444-8444-444444444444", kind: "skill-link", harnessId: "claude", subject: "gamma", file: "~/.claude/skills", status: "applied", diff: null, backupId: null, error: null, notes: [],
      links: [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "create" }], at },
    ["5".repeat(64)]: { id: "15555555-5555-4555-8555-555555555555", kind: "skill-link", harnessId: "claude", subject: "delta", file: "~/.claude/skills", status: "applied", diff: null, backupId: null, error: null, notes: [],
      links: [{ path: "~/.claude/skills/delta", target: "~/.agents/skills/delta", action: "remove" }], at } };
  await page.route("**/api/v1/capabilities/changes", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; posted.push(body);
    const result = views[String(body.fingerprint)]; history = { changes: [result, ...history.changes], backups: [], drift: [], ...HISTORY_EXTRA };
    await route.fulfill({ json: result });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  // How each Harness reads the shared directory, with what can change.
  const card = page.getByRole("region", { name: "共享技能目录" });
  for (const text of ["Claude Code经自己目录里的链接；自己目录里有 1 个指向它的链接", "Codex自己读取", "Hermes Agent经自己目录里的链接", "OpenClaw自己读取；自己目录里有 2 个指向它的链接，其中 2 个多余"]) await expect(card).toContainText(text);
  await card.getByRole("button", { name: "让 Hermes Agent 读取共享目录", exact: true }).click();
  const hermes = page.getByRole("dialog", { name: "让 Hermes Agent 读取共享目录" });
  await expect(hermes.locator(".capability-diff .text-green")).toHaveText(["+  external_dirs: [\"~/.agents/skills\"]"]);
  for (const text of ["Hermes 会多看到 3 个共享技能", "不会被 HarnessHub 重启"]) await expect(hermes).toContainText(text);
  await hermes.getByRole("button", { name: "读取", exact: true }).click(); await expect(hermes).toBeHidden();
  await expect(page.locator(".capability-result")).toContainText("Hermes Agent 已读取共享目录");
  // OpenClaw's redundant links: each one listed before anything is removed, and the change can be undone from the history.
  await card.getByRole("button", { name: "清理 2 个多余链接", exact: true }).click();
  const cleanup = page.getByRole("dialog", { name: "清理 OpenClaw 的多余链接" });
  await expect(cleanup.locator(".capability-links li")).toHaveText(["− 删除~/.openclaw/skills/alpha → ../../.agents/skills/alpha", "− 删除~/.openclaw/skills/beta → ../../.agents/skills/beta"]);
  await expect(cleanup).toContainText("`npx skills` 以后可能会重新建这些链接。");
  await cleanup.getByRole("button", { name: "清理", exact: true }).click(); await expect(cleanup).toBeHidden();
  await page.locator(".capability-history summary").click();
  await expect(page.locator(".capability-history")).toContainText("清理链接 · 多余链接"); await expect(page.locator(".capability-history")).toContainText("删除 2 个链接");
  await page.locator(".capability-history li").filter({ hasText: "清理链接" }).getByRole("button", { name: "撤销", exact: true }).click();
  const undo = page.getByRole("dialog", { name: "撤销：多余链接" });
  await expect(undo.locator(".capability-links li")).toHaveCount(2); await expect(undo.locator(".capability-links li").first()).toContainText("+ 新建");
  await undo.getByRole("button", { name: "撤销", exact: true }).click(); await expect(undo).toBeHidden();
  // Claude Code takes a shared skill it does not see by a link of its own; one HarnessHub placed can be removed again.
  const matrix = page.locator(".capability-matrix");
  await matrix.locator("tbody tr").filter({ hasText: "gamma" }).first().getByRole("button", { name: /gamma/u }).click();
  await page.getByRole("button", { name: "放到 Claude Code", exact: true }).click();
  const place = page.getByRole("dialog", { name: "把 gamma 放到 Claude Code" });
  await expect(place.locator(".capability-links li")).toHaveText(["+ 新建~/.claude/skills/gamma → ~/.agents/skills/gamma"]);
  await place.getByRole("button", { name: "放置", exact: true }).click(); await expect(place).toBeHidden();
  await matrix.locator("tbody tr").filter({ hasText: "delta" }).first().getByRole("button", { name: /delta/u }).click();
  await page.getByRole("button", { name: "从 Claude Code 移除（HarnessHub 放置的）", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "从 Claude Code 移除 delta" });
  await expect(remove.locator(".capability-links li")).toHaveText(["− 删除~/.claude/skills/delta → ~/.agents/skills/delta"]);
  await remove.getByRole("button", { name: "移除", exact: true }).click(); await expect(remove).toBeHidden();
  assert.deepEqual(requests, ["shared-dir?harnessId=hermes&present=true", "link-cleanup?harnessId=openclaw", "changes/12222222-2222-4222-8222-222222222222/undo",
    "skill-link?harnessId=claude&name=gamma&present=true", "skill-link?harnessId=claude&name=delta&present=false"]);
  assert.deepEqual(posted.map(item => item.fingerprint), ["1", "2", "3", "4", "5"].map(digit => digit.repeat(64)), "each confirmation sends exactly its own check");
  await page.screenshot({ path: join(artifact, "capabilities-shared-directory.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-CA4 what HarnessHub wrote and someone else then removed is shown with re-apply and stop tracking, and nothing is put back without a confirmation", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-10-18T10:00:00.000Z", hermesId = "a".repeat(32), alphaId = "b".repeat(32);
  const drift = [{ id: hermesId, kind: "shared-dir", harnessId: "hermes", subject: "~/.agents/skills", file: "~/.hermes/config.yaml", state: "removed", changeId: "11111111-1111-4111-8111-111111111111", at },
    { id: alphaId, kind: "skill-switch", harnessId: "claude", subject: "alpha", file: "~/.claude/settings.json", state: "changed", changeId: "12222222-2222-4222-8222-222222222222", at }];
  let history = { changes: [] as unknown[], backups: [] as unknown[], drift: drift as unknown[], ...HISTORY_EXTRA };
  const requests: string[] = [], posted: Record<string, unknown>[] = [], forgotten: unknown[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route(/\/api\/v1\/capabilities\/drift\/[^/]+\/reapply/u, route => {
    requests.push(new URL(route.request().url()).pathname.replace("/api/v1/capabilities/", ""));
    return route.fulfill({ json: { kind: "shared-dir", harnessId: "hermes", name: "~/.agents/skills", enabled: true, file: "~/.hermes/config.yaml", command: null, rewrite: null, links: [], current: "none", blocked: null,
      diff: "--- a/~/.hermes/config.yaml\n+++ b/~/.hermes/config.yaml\n@@ -4,3 +4,3 @@\n skills:\n-  external_dirs: []\n+  external_dirs: [\"~/.agents/skills\"]\n", notes: ["Hermes 会多看到 6 个共享技能。"],
      fingerprint: "7".repeat(64), expiresAt: "2026-10-18T10:15:00.000Z" } });
  });
  await page.route("**/api/v1/capabilities/changes", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; posted.push(body);
    const result = { id: "13333333-3333-4333-8333-333333333333", kind: "shared-dir", harnessId: "hermes", subject: "~/.agents/skills", file: "~/.hermes/config.yaml", status: "applied", diff: null, backupId: null, error: null, notes: [], at };
    history = { changes: [result], backups: [], drift: history.drift.filter(item => (item as { id: string }).id !== hermesId), ...HISTORY_EXTRA };
    await route.fulfill({ json: result });
  });
  await page.route("**/api/v1/capabilities/forget", async route => {
    const body = route.request().postDataJSON() as { id: string }; forgotten.push(body);
    history = { ...history, drift: history.drift.filter(item => (item as { id: string }).id !== body.id) };
    await route.fulfill({ json: { forgotten: true } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  // Each one says what HarnessHub wrote, where, and what became of it; nothing was sent yet.
  const notice = page.locator(".capability-drift");
  await expect(notice).toContainText("HarnessHub 写过的 2 项设置已不在原处"); await expect(notice).toContainText("HarnessHub 不会自动改回");
  await expect(notice.locator("li")).toHaveText([/Hermes Agent · 共享目录 · ~\/\.agents\/skills已被外部移除~\/\.hermes\/config\.yaml/u, /Claude Code · 技能开关 · alpha已被外部改动~\/\.claude\/settings\.json/u]);
  assert.deepEqual([requests, posted, forgotten], [[], [], []]);
  // Re-applying shows the usual check first and sends exactly that check.
  await notice.locator("li").filter({ hasText: "共享目录" }).getByRole("button", { name: "重新应用", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重新应用：~/.agents/skills" });
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+  external_dirs: [\"~/.agents/skills\"]"]);
  assert.equal(posted.length, 0, "the check alone writes nothing");
  await dialog.getByRole("button", { name: "重新应用", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(page.locator(".capability-result")).toContainText("已重新应用：~/.agents/skills");
  await expect(notice.locator("li")).toHaveCount(1);
  // Stopping tracking sends the one entry and changes no file; the notice goes once nothing is left.
  await notice.getByRole("button", { name: "不再跟踪", exact: true }).click();
  await expect(notice).toBeHidden();
  assert.deepEqual(requests, ["drift/" + hermesId + "/reapply"]);
  assert.deepEqual(posted.map(item => item.fingerprint), ["7".repeat(64)]);
  assert.deepEqual(forgotten, [{ id: alphaId }]);
  assert.deepEqual(errors, []);
});

test("G054-CA5 skills are added from a GitHub repository after reading it, updates are checked and shown file by file, a deletion lists the links and lock entry it removes, and orphaned switch settings can be cleared", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-10-18T10:00:00.000Z", orphanId = "c".repeat(32), listingId = "d".repeat(32), sha = "e".repeat(40);
  let history = { changes: [] as unknown[], backups: [] as unknown[], drift: [] as unknown[], orphans: [{ id: orphanId, kind: "skill", harnessId: "claude", subject: "gone-skill", file: "~/.claude/settings.json" }] as unknown[],
    snapshots: { count: 0, bytes: 0, keep: 50 } };
  const requests: string[] = [], posted: Record<string, unknown>[] = [];
  const check = (fields: Record<string, unknown>) => ({ harnessId: "", enabled: true, file: "~/.agents/skills", command: null, diff: null, rewrite: null, links: [], current: "none", blocked: null, notes: ["只改共享目录 ~/.agents/skills 和下面列出的链接与 lock 条目，不改任何 Harness 的模型或登录配置。"],
    expiresAt: "2026-10-18T10:15:00.000Z", orphans: [], lock: null, source: null, ...fields });
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route(/\/api\/v1\/capabilities\/(skill-sources|skill-add|skill-updates|skill-update|skill-delete|orphans)/u, route => {
    const url = new URL(route.request().url()), path = url.pathname.replace("/api/v1/capabilities/", "");
    requests.push(path + url.search);
    if (path === "skill-sources") return route.fulfill({ json: { id: listingId, repository: "https://github.com/acme/skills", ref: null, commit: sha, expiresAt: "2026-10-18T10:15:00.000Z", skills: [
      { name: "alpha-tools", installName: "alpha-tools", description: "Tools for alpha", folder: "skills/alpha-tools", files: 3, bytes: 2048, executables: 1, plugin: false, state: "new", reason: null },
      { name: "beta", installName: "beta", description: null, folder: "skills/beta", files: 1, bytes: 100, executables: 0, plugin: false, state: "refused", reason: "包含链接 alias.md，HarnessHub 只装普通文件" }] } });
    if (path === "skill-add") return route.fulfill({ json: check({ kind: "skill-add", name: "alpha-tools", fingerprint: "1".repeat(64), source: { repository: "https://github.com/acme/skills", ref: null, commit: sha },
      skills: [{ name: "alpha-tools", folder: "~/.agents/skills/alpha-tools", action: "add", files: 3, bytes: 2048, executables: 1, plugin: false, changes: [], overwrites: 0 }] }) });
    if (path === "skill-updates") return route.fulfill({ json: { checkedAt: at, skills: [{ name: "alpha", manager: "skills-cli", repository: "https://github.com/owner/repo", state: "available", modified: false, reason: null }] } });
    if (path === "skill-update") return route.fulfill({ json: check({ kind: "skill-update", name: "alpha", current: "other", fingerprint: "2".repeat(64), source: { repository: "https://github.com/owner/repo", ref: null, commit: sha },
      lock: { file: "~/.agents/.skill-lock.json", diff: "--- a/~/.agents/.skill-lock.json\n+++ b/~/.agents/.skill-lock.json\n@@ -8,1 +8,1 @@\n-      \"skillFolderHash\": \"old\",\n+      \"skillFolderHash\": \"new\",\n" },
      skills: [{ name: "alpha", folder: "~/.agents/skills/alpha", action: "update", files: 2, bytes: 2100, executables: 0, plugin: false, changes: [{ path: "SKILL.md", action: "change" }, { path: "new.md", action: "add" }], overwrites: 0 }] }) });
    if (path === "skill-delete") return route.fulfill({ json: check({ kind: "skill-delete", name: "alpha", enabled: false, current: "other", fingerprint: "3".repeat(64),
      links: [{ path: "~/.claude/skills/alpha", target: "../../.agents/skills/alpha", action: "remove", owner: "other" }, { path: "~/.claude/skills/alpha-mine", target: "~/.agents/skills/alpha", action: "remove", owner: "harnesshub" }],
      lock: { file: "~/.agents/.skill-lock.json", diff: "--- a/~/.agents/.skill-lock.json\n+++ b/~/.agents/.skill-lock.json\n@@ -3,3 +3,0 @@\n-    \"alpha\": {\n" }, orphans: [{ harnessId: "claude", file: "~/.claude/settings.json" }],
      skills: [{ name: "alpha", folder: "~/.agents/skills/alpha", action: "delete", files: 2, bytes: 2048, executables: 0, plugin: false, changes: [], overwrites: 0 }] }) });
    return route.fulfill({ json: check({ kind: "skill-switch", harnessId: "claude", name: "gone-skill", file: "~/.claude/settings.json", current: "harnesshub", fingerprint: "4".repeat(64),
      diff: "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -2,3 +2,1 @@\n-  \"skillOverrides\": {\n-    \"gone-skill\": \"off\"\n-  }\n", notes: [] }) });
  });
  await page.route("**/api/v1/capabilities/changes", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>; posted.push(body);
    const kind = body.fingerprint === "1".repeat(64) ? "skill-add" : body.fingerprint === "3".repeat(64) ? "skill-delete" : "skill-switch";
    const result = { id: "1444444" + posted.length + "-4444-4444-8444-444444444444", kind, harnessId: kind === "skill-switch" ? "claude" : null, subject: kind === "skill-add" ? "alpha-tools" : kind === "skill-delete" ? "alpha" : "gone-skill",
      file: "~/.agents/skills", status: "applied", diff: null, backupId: null, error: null, notes: [], at,
      ...(kind === "skill-switch" ? {} : { skills: [{ name: kind === "skill-add" ? "alpha-tools" : "alpha", folder: "~/.agents/skills/x", before: kind === "skill-add" ? null : "a".repeat(40), after: kind === "skill-add" ? "b".repeat(40) : null }] }) };
    history = { ...history, changes: [result, ...history.changes], orphans: kind === "skill-switch" ? [] : history.orphans };
    await route.fulfill({ json: result });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  // Adding: the repository is read first; the refused skill cannot be chosen, the new one is chosen, and the confirmation shows its folder.
  await page.getByRole("button", { name: "从 GitHub 添加技能", exact: true }).click();
  const adding = page.getByRole("dialog", { name: "从 GitHub 添加技能" });
  await adding.getByRole("textbox", { name: "GitHub 仓库" }).fill("acme/skills"); await adding.getByRole("button", { name: "读取", exact: true }).click();
  await expect(adding.locator(".skill-source-list li")).toHaveCount(2);
  await expect(adding.getByRole("checkbox", { name: "选择 beta" })).toBeDisabled(); await expect(adding).toContainText("包含链接 alias.md");
  await expect(adding.getByRole("checkbox", { name: "选择 alpha-tools" })).toBeChecked(); await expect(adding).toContainText("含 1 个可执行文件");
  assert.equal(posted.length, 0, "reading a repository writes nothing");
  await adding.getByRole("button", { name: "添加所选（1）" }).click();
  const confirmAdd = page.getByRole("dialog", { name: "添加技能 alpha-tools" });
  await expect(confirmAdd.locator(".skill-plans")).toContainText("新增 alpha-tools"); await expect(confirmAdd.locator(".skill-plans")).toContainText("3 个文件 · 2.0 KB · 含 1 个可执行文件");
  await expect(confirmAdd).toContainText("https://github.com/acme/skills · eeeeeeeeeeee"); await expect(confirmAdd).toContainText("不改任何 Harness 的模型或登录配置");
  await confirmAdd.getByRole("button", { name: "添加", exact: true }).click(); await expect(confirmAdd).toBeHidden();
  await expect(page.locator(".capability-result")).toContainText("已添加技能 alpha-tools");
  // Checking updates marks the skill with a newer version; its update is shown file by file with the lock entry it changes.
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.locator(".skill-update-summary")).toContainText("1 个技能有新版本");
  const alphaRow = page.locator(".capability-matrix tbody tr").filter({ hasText: "alpha" }).first();
  await expect(alphaRow.locator(".badge")).toContainText(["有新版本"]);
  await alphaRow.getByRole("button", { name: /alpha/u }).click();
  const detail = page.locator(".capability-detail");
  await expect(detail.getByRole("button", { name: "覆盖本地改动并更新" })).toHaveCount(0);
  await detail.getByRole("button", { name: "更新", exact: true }).click();
  const confirmUpdate = page.getByRole("dialog", { name: "更新 alpha" });
  await expect(confirmUpdate.locator(".skill-file-changes li")).toHaveText(["~ 修改SKILL.md", "+ 新增new.md"]);
  await expect(confirmUpdate).toContainText("npx skills 的 lock 里有记录"); await expect(confirmUpdate.locator(".capability-diff .text-green")).toHaveText(["+      \"skillFolderHash\": \"new\","]);
  await confirmUpdate.getByRole("button", { name: "取消", exact: true }).click(); await expect(confirmUpdate).toBeHidden();
  // Deleting lists the links by who made them, the lock entry, and the switch settings that stay.
  await detail.getByRole("button", { name: "删除", exact: true }).click();
  const confirmDelete = page.getByRole("dialog", { name: "删除 alpha" });
  await expect(confirmDelete).toContainText("HarnessHub 放置的链接（1）"); await expect(confirmDelete).toContainText("其他工具（多为 npx skills）建的链接（1）");
  await expect(confirmDelete.locator(".skill-orphans")).toContainText("claude · ~/.claude/settings.json");
  await confirmDelete.getByRole("button", { name: "删除", exact: true }).click(); await expect(confirmDelete).toBeHidden();
  // An orphaned switch setting is cleared through the usual switch check.
  const orphans = page.locator(".capability-orphans");
  await expect(orphans).toContainText("孤立的停用设置（技能已删除）1 项"); await expect(orphans).toContainText("Claude Code · gone-skill");
  await orphans.getByRole("button", { name: "清除", exact: true }).click();
  const confirmClear = page.getByRole("dialog", { name: "清除停用设置：gone-skill" });
  await expect(confirmClear.locator(".capability-diff .text-red")).toHaveText(["-  \"skillOverrides\": {", "-    \"gone-skill\": \"off\"", "-  }"]);
  await confirmClear.getByRole("button", { name: "清除", exact: true }).click(); await expect(confirmClear).toBeHidden();
  await expect(orphans).toBeHidden();
  // The history offers undo for the skill changes.
  await page.locator(".capability-history summary").click();
  await expect(page.locator(".capability-history li").filter({ hasText: "删除技能 · alpha" }).getByRole("button", { name: "撤销" })).toBeVisible();
  assert.deepEqual(requests, ["skill-sources?source=acme%2Fskills", "skill-add?listing=" + listingId + "&names=alpha-tools", "skill-updates?refresh=1", "skill-update?name=alpha&overwrite=false", "skill-delete?name=alpha", "orphans/" + orphanId + "/clear"]);
  assert.deepEqual(posted.map(item => item.fingerprint), ["1".repeat(64), "3".repeat(64), "4".repeat(64)]);
  assert.deepEqual(errors, []);
});

test("G054-CA6 the MCP list shows each server per Harness, imports what the Harnesses have with a claim, writes a server only through its shown check, and keeps no credential in a new one", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-10-18T10:00:00.000Z", fs = { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], cwd: null, url: null, env: [{ key: "FS_TOKEN", variable: "FS_TOKEN" }], headers: [] };
  const harnesses = [{ harnessId: "claude", name: "Claude Code", writable: false, reason: "Claude Code 的 MCP 由它自己的命令写入，HarnessHub 下一步接入；现在只读。" }, { harnessId: "codex", name: "Codex", writable: true, reason: null },
    { harnessId: "cursor", name: "Cursor", writable: true, reason: null }, { harnessId: "hermes", name: "Hermes Agent", writable: true, reason: null }];
  let codexState = "absent";
  const inventory = () => ({ harnesses, servers: [{ name: "fs", definition: fs, command: "npx -y @modelcontextprotocol/server-filesystem", variables: [{ name: "FS_TOKEN", set: false }], updatedAt: at,
    targets: [{ harnessId: "claude", state: "unsupported", reason: harnesses[0]!.reason, file: null }, { harnessId: "codex", state: codexState, reason: null, file: "~/.codex/config.toml" },
      { harnessId: "cursor", state: "claimable", reason: "定义与清单一致，还不是 HarnessHub 管理的", file: "~/.cursor/mcp.json" }, { harnessId: "hermes", state: "synced", reason: null, file: "~/.hermes/config.yaml" }] }],
    candidates: [{ id: "a".repeat(32), name: "linear", definition: { transport: "http", command: null, args: [], cwd: null, url: "https://mcp.linear.app/sse", env: [], headers: [{ name: "Authorization", variable: "LINEAR_TOKEN", prefix: "Bearer " }] },
      problem: null, foundIn: [{ harnessId: "cursor", file: "~/.cursor/mcp.json" }], state: "new" },
      { id: "b".repeat(32), name: "github", definition: null, problem: "API_KEY 的值像是密钥，必须改成变量引用", foundIn: [{ harnessId: "claude", file: "~/.claude.json" }], state: "new" }] });
  const requests: string[] = [], posted: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  // A server HarnessHub wrote into Claude Code that a running session then wrote over.
  const lost = { id: "d".repeat(32), kind: "mcp", harnessId: "claude", subject: "fs", file: "~/.claude.json", state: "removed", changeId: "17777777-7777-4777-8777-777777777777", at };
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: { changes: [], backups: [], drift: [lost], ...HISTORY_EXTRA } }));
  await page.route("**/api/v1/capabilities/mcp", route => route.fulfill({ json: inventory() }));
  await page.route(/\/api\/v1\/capabilities\/mcp\/(sync|remove)\?/u, route => {
    const url = new URL(route.request().url()); requests.push(url.pathname.replace("/api/v1/capabilities/", "") + url.search);
    return route.fulfill({ json: { kind: "mcp-sync", harnessId: "codex", name: "fs", enabled: true, file: "~/.codex/config.toml", command: null, rewrite: null, links: [], current: "none", blocked: null,
      diff: "--- a/~/.codex/config.toml\n+++ b/~/.codex/config.toml\n@@ -9,0 +10,4 @@\n+[mcp_servers.fs]\n+args = [\"-y\", \"@modelcontextprotocol/server-filesystem\"]\n+command = \"npx\"\n+env_vars = [\"FS_TOKEN\"]\n",
      notes: ["目标 Harness 会以你的身份运行这个程序：npx -y @modelcontextprotocol/server-filesystem", "需要的环境变量：FS_TOKEN（HarnessHub 的环境里未设置）。值不写进配置文件。", "Codex 要重启后才读到改动。"],
      fingerprint: "5".repeat(64), expiresAt: "2026-10-18T10:15:00.000Z" } });
  });
  await page.route(/\/api\/v1\/capabilities\/(changes|mcp\/import|mcp\/claim|mcp\/servers)$/u, async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1/capabilities/", ""), body = route.request().postDataJSON() as Record<string, unknown>; posted.push({ path, body });
    if (path === "changes") { codexState = "synced"; return route.fulfill({ json: { id: "15555555-5555-4555-8555-555555555555", kind: "mcp-sync", harnessId: "codex", subject: "fs", file: "~/.codex/config.toml", status: "applied", diff: null, backupId: "16666666-6666-4666-8666-666666666666", error: null, notes: [], at } }); }
    if (path === "mcp/servers") return route.fulfill({ json: { name: body.name } });
    return route.fulfill({ json: [] });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  await page.getByRole("tab", { name: /^MCP/u }).click();
  await expect(page.locator(".capability-drift li")).toHaveText([/Claude Code · MCP · fs写入丢失（可能被运行中的 Claude Code 会话冲掉）~\/\.claude\.json/u]);
  // Each server per Harness: written, the same but not yet HarnessHub's, not written, not writable (with why); the variable it needs and whether it is set.
  const panel = page.locator(".mcp-inventory"), row = panel.locator("tbody tr").filter({ hasText: "fs" });
  await expect(row.locator("td")).toHaveText([/^—$/u, /未写入写入/u, /一致认领/u, /已写入移除/u]);
  await expect(row).toContainText("FS_TOKEN 未设置");
  // Writing goes through its check: the diff and the program it will run are shown, and only that check is sent.
  await row.locator("td").nth(1).getByRole("button", { name: "写入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "写入 fs 到 Codex" });
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+[mcp_servers.fs]", "+args = [\"-y\", \"@modelcontextprotocol/server-filesystem\"]", "+command = \"npx\"", "+env_vars = [\"FS_TOKEN\"]"]);
  await expect(dialog).toContainText("目标 Harness 会以你的身份运行这个程序：npx -y @modelcontextprotocol/server-filesystem");
  assert.equal(posted.length, 0, "the check alone writes nothing");
  await dialog.getByRole("button", { name: "写入", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(row.locator("td").nth(1)).toHaveText(/已写入/u);
  // Claiming an identical entry and importing what the Harnesses have change no file; a server with a literal credential cannot be imported.
  await row.locator("td").nth(2).getByRole("button", { name: "认领", exact: true }).click();
  await expect(page.locator(".capability-notice")).toContainText("已认领 fs");
  await panel.getByRole("button", { name: "从现有配置导入（1）" }).click();
  const importing = page.getByRole("dialog", { name: "从现有配置导入 MCP 服务器" });
  await expect(importing.getByRole("checkbox", { name: "导入 github" })).toBeDisabled(); await expect(importing).toContainText("API_KEY 的值像是密钥");
  await importing.getByRole("checkbox", { name: "导入 linear" }).check();
  await expect(importing.getByRole("checkbox", { name: "认领 Cursor 里的这一项" })).toBeChecked();
  await importing.getByRole("button", { name: "导入所选（1）" }).click(); await expect(importing).toBeHidden();
  await expect(page.locator(".capability-notice")).toContainText("已导入 1 个服务器");
  // A new server keeps the variable's name, never a value.
  await panel.getByRole("button", { name: "新建服务器", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建 MCP 服务器" });
  await form.getByRole("textbox", { name: "服务器名称" }).fill("search"); await form.getByRole("textbox", { name: "程序" }).fill("uvx"); await form.getByRole("textbox", { name: "参数" }).fill("search-mcp\n--fast");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  await form.getByRole("textbox", { name: "环境变量的名字" }).fill("SEARCH_TOKEN"); await form.getByRole("textbox", { name: "取值的变量" }).fill("SEARCH_TOKEN");
  await form.getByRole("button", { name: "保存到清单", exact: true }).click(); await expect(form).toBeHidden();
  assert.deepEqual(requests, ["mcp/sync?name=fs&harnessId=codex"]);
  assert.deepEqual(posted.map(item => item.path), ["changes", "mcp/claim", "mcp/import", "mcp/servers"]);
  assert.deepEqual(posted[1]!.body, { name: "fs", harnessIds: ["cursor"] });
  assert.deepEqual(posted[2]!.body, { candidate: "a".repeat(32), claim: ["cursor"] });
  assert.deepEqual(posted[3]!.body, { name: "search", replace: false, definition: { transport: "stdio", command: "uvx", args: ["search-mcp", "--fast"], cwd: null, url: null, env: [{ key: "SEARCH_TOKEN", variable: "SEARCH_TOKEN" }], headers: [] } });
  assert.deepEqual(errors, []);
});

test("G054-CA7 the instructions are edited and saved without touching any Harness, written into a Harness only through its shown check, and a check another tool's file blocks goes on only when the user says so", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-10-18T10:00:00.000Z", caution = "cc-switch 启用或切换提示词时会整份改写 ~/.gemini/GEMINI.md（区块随之消失，或被收进它的提示词），停用最后一个提示词时会清空它。";
  let shared = { text: "", updatedAt: null as string | null }, geminiState = "absent";
  const view = () => ({ shared, additions: [], limitBytes: 16384, targets: [
    { harnessId: "claude", name: "Claude Code", file: "~/.claude/CLAUDE.md", state: "absent", reason: null, effect: "新开的 Claude Code 会话读到，包括 HarnessHub 里新开的会话；运行中的会话不受影响。", cautions: [] },
    { harnessId: "gemini", name: "Gemini CLI", file: "~/.gemini/GEMINI.md", state: geminiState, reason: null, effect: "新开的 Gemini CLI 会话读到；运行中的会话可以用 /memory refresh 重新读取。", cautions: [caution] },
    { harnessId: "cursor", name: "Cursor", file: null, state: "unsupported", reason: "Cursor 的用户规则保存在应用设置里，不在磁盘上；它只读项目根目录的 AGENTS.md 与 CLAUDE.md。", effect: null, cautions: [] },
    { harnessId: "hermes", name: "Hermes Agent", file: null, state: "unsupported", reason: "Hermes 没有用户级指令文件；SOUL.md 是人格文件，HarnessHub 不写它。", effect: null, cautions: [] }] });
  const checks: string[] = [], posted: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: { changes: [], backups: [], drift: [], ...HISTORY_EXTRA } }));
  await page.route("**/api/v1/capabilities/instructions", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: view() });
    const body = route.request().postDataJSON() as Record<string, unknown>; posted.push({ path: "instructions", body });
    shared = { text: String(body.shared), updatedAt: at };
    return route.fulfill({ json: view() });
  });
  await page.route(/\/api\/v1\/capabilities\/instructions\/(sync|remove)\?/u, route => {
    const url = new URL(route.request().url()); checks.push(url.pathname.replace("/api/v1/capabilities/", "") + url.search);
    const acknowledged = url.searchParams.get("options") === "acknowledge-cc-switch";
    return route.fulfill({ json: { kind: "instructions-sync", harnessId: "gemini", name: "指令", enabled: true, file: "~/.gemini/GEMINI.md", command: null, rewrite: null, links: [], current: "none",
      blocked: acknowledged ? null : caution, proceed: acknowledged ? null : { option: "acknowledge-cc-switch", label: "我知道，仍然写入" },
      diff: acknowledged ? "--- a/~/.gemini/GEMINI.md\n+++ b/~/.gemini/GEMINI.md\n@@ -1,0 +1,3 @@\n+<!-- harnesshub:begin id=instructions sha=0123456789ab -->\n+回复使用中文。\n+<!-- harnesshub:end id=instructions -->\n" : null,
      notes: ["新开的 Gemini CLI 会话读到；运行中的会话可以用 /memory refresh 重新读取。"], fingerprint: "6".repeat(64), expiresAt: "2026-10-18T10:15:00.000Z" } });
  });
  await page.route(/\/api\/v1\/capabilities\/changes$/u, route => {
    posted.push({ path: "changes", body: route.request().postDataJSON() as Record<string, unknown> }); geminiState = "synced";
    return route.fulfill({ json: { id: "18888888-8888-4888-8888-888888888888", kind: "instructions-sync", harnessId: "gemini", subject: "指令", file: "~/.gemini/GEMINI.md", status: "applied", diff: null, backupId: null, error: null, notes: [], at } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  await page.getByRole("tab", { name: /^指令/u }).click();
  const panel = page.locator(".instructions-panel"), gemini = panel.locator("tbody tr[data-harness=gemini]");
  // Each Harness's file, state and when it reads a change; what a write will ask about; why Cursor and Hermes have none.
  await expect(gemini).toContainText("~/.gemini/GEMINI.md"); await expect(gemini).toContainText("未写入"); await expect(gemini).toContainText(caution);
  await expect(panel.locator("tbody tr[data-harness=hermes]")).toContainText("SOUL.md 是人格文件");
  // Editing marks the texts unsaved and holds back every write until they are saved; saving writes no Harness file.
  await panel.getByRole("textbox", { name: "共享指令" }).fill("回复使用中文。");
  await expect(panel).toContainText("有未保存的修改");
  await expect(gemini.getByRole("button", { name: "写入", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".capability-notice")).toContainText("已保存指令");
  await expect(panel.locator("tbody tr[data-harness=cursor]").getByRole("button", { name: "复制共享指令" })).toBeVisible();
  // The write's check is blocked by cc-switch until the user says so; then the exact block is shown and only that check is confirmed.
  await gemini.getByRole("button", { name: "写入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "写入指令：Gemini CLI" });
  await expect(dialog.locator(".switch-blocked")).toContainText("cc-switch 启用或切换提示词时会整份改写");
  await expect(dialog.getByRole("button", { name: "写入", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "我知道，仍然写入" }).click();
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+<!-- harnesshub:begin id=instructions sha=0123456789ab -->", "+回复使用中文。", "+<!-- harnesshub:end id=instructions -->"]);
  await expect(dialog).toContainText("只改 HarnessHub 的区块，区块外的内容不变");
  await dialog.getByRole("button", { name: "写入", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(gemini).toContainText("已写入");
  assert.deepEqual(checks, ["instructions/sync?harnessId=gemini", "instructions/sync?harnessId=gemini&options=acknowledge-cc-switch"]);
  assert.deepEqual(posted.map(item => item.path), ["instructions", "changes"]);
  assert.deepEqual(posted[0]!.body, { shared: "回复使用中文。", additions: {} });
  assert.equal(posted[1]!.body.fingerprint, "6".repeat(64));
  assert.deepEqual(errors, []);
});

test("G054-CA8 the subagent list writes a subagent into each Harness only through its shown check, says why some Harnesses take none, and a skill written from text goes through its own check", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-10-19T10:00:00.000Z";
  let codexState = "absent";
  const inventory = () => ({ subagents: [{ name: "code-checker", definition: { description: "Checks a change for what it breaks", prompt: "You check one change." }, updatedAt: at,
    targets: [{ harnessId: "claude", state: "synced", reason: null, file: "~/.claude/agents/code-checker.md" }, { harnessId: "codex", state: codexState, reason: null, file: "~/.codex/agents/code-checker.toml" },
      { harnessId: "cursor", state: "unsupported", reason: "本机 cursor-agent 只读工作区里的子 Agent，不读家目录", file: null }] }],
    harnesses: [{ harnessId: "claude", name: "Claude Code", writable: true, reason: null }, { harnessId: "codex", name: "Codex", writable: true, reason: null },
      { harnessId: "cursor", name: "Cursor", writable: false, reason: "本机 cursor-agent 只读工作区里的子 Agent，不读家目录" }] });
  const checks: string[] = [], posted: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: { changes: [], backups: [], drift: [], ...HISTORY_EXTRA } }));
  await page.route("**/api/v1/capabilities/subagents", route => route.fulfill({ json: inventory() }));
  await page.route(/\/api\/v1\/capabilities\/subagents\/(sync|remove)\?/u, route => {
    const url = new URL(route.request().url()); checks.push(url.pathname.replace("/api/v1/capabilities/", "") + url.search);
    return route.fulfill({ json: { kind: "subagent-sync", harnessId: "codex", name: "code-checker", enabled: true, file: "~/.codex/agents/code-checker.toml", command: null, rewrite: null, links: [], current: "none", blocked: null,
      diff: "--- /dev/null\n+++ b/~/.codex/agents/code-checker.toml\n@@ -0,0 +1,4 @@\n+name = \"code-checker\"\n+description = \"Checks a change for what it breaks\"\n+developer_instructions = \"\"\"\n+You check one change.\"\"\"\n",
      notes: ["只新建 HarnessHub 自己的文件 ~/.codex/agents/code-checker.toml，不写工具、权限、hooks、MCP，不改模型与登录配置。", "这个子 Agent 用父会话的模型与设置，不能放宽父会话的沙箱和审批。"],
      fingerprint: "7".repeat(64), expiresAt: "2026-10-19T10:15:00.000Z" } });
  });
  await page.route(/\/api\/v1\/capabilities\/(changes|subagents\/save|skill-create)$/u, async route => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1/capabilities/", ""), body = route.request().postDataJSON() as Record<string, unknown>; posted.push({ path, body });
    if (path === "subagents/save") return route.fulfill({ json: { name: body.name } });
    if (path === "skill-create") return route.fulfill({ json: { kind: "skill-create", harnessId: "", name: "standup-notes", enabled: true, file: "~/.agents/skills", command: null, rewrite: null, links: [], current: "none", blocked: null,
      diff: "--- /dev/null\n+++ b/~/.agents/skills/standup-notes/SKILL.md\n@@ -0,0 +1,6 @@\n+---\n+name: standup-notes\n+description: \"Writes my standup notes\"\n+---\n+\n+Summarize yesterday.\n",
      skills: [{ name: "standup-notes", folder: "~/.agents/skills/standup-notes", action: "add", files: 1, bytes: 90, executables: 0, plugin: false, changes: [{ path: "SKILL.md", action: "add" }], overwrites: 0 }], source: null, lock: null,
      notes: ["参数占位符各家不同：Claude Code 的 $0 是第一个参数，OpenCode、Cursor 的 $1 才是；Codex 的技能没有参数。"], fingerprint: "8".repeat(64), expiresAt: "2026-10-19T10:15:00.000Z" } });
    codexState = "synced";
    return route.fulfill({ json: { id: "19999999-9999-4999-8999-999999999999", kind: "subagent-sync", harnessId: "codex", subject: "code-checker", file: "~/.codex/agents/code-checker.toml", status: "applied", diff: null, backupId: null, error: null, notes: [], at } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  await page.getByRole("tab", { name: /^子 Agent/u }).click();
  // Each subagent per writable Harness; why Cursor takes none is said under the table, not as a column.
  const panel = page.locator(".subagent-inventory"), row = panel.locator("tbody tr").filter({ hasText: "code-checker" });
  await expect(row.locator("td")).toHaveText([/已写入移除/u, /未写入写入/u]);
  await expect(panel).toContainText("Cursor：本机 cursor-agent 只读工作区里的子 Agent，不读家目录");
  // Writing goes through its check: the new file and what the subagent inherits are shown, and only that check is confirmed.
  await row.locator("td").nth(1).getByRole("button", { name: "写入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "写入 code-checker 到 Codex" });
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+name = \"code-checker\"", "+description = \"Checks a change for what it breaks\"", "+developer_instructions = \"\"\"", "+You check one change.\"\"\""]);
  await expect(dialog).toContainText("不能放宽父会话的沙箱和审批");
  await dialog.getByRole("button", { name: "写入", exact: true }).click(); await expect(dialog).toBeHidden();
  await expect(row.locator("td").nth(1)).toHaveText(/已写入/u);
  // A new subagent keeps only its name, description and prompt.
  await panel.getByRole("button", { name: "新建子 Agent" }).click();
  const form = page.getByRole("dialog", { name: "新建子 Agent" });
  await form.getByRole("textbox", { name: "子 Agent 名字" }).fill("test-writer"); await form.getByRole("textbox", { name: "子 Agent 说明" }).fill("Writes tests"); await form.getByRole("textbox", { name: "子 Agent 正文" }).fill("Write tests first.");
  await form.getByRole("button", { name: "保存到清单" }).click(); await expect(form).toBeHidden();
  // A skill written from text: the dialog collects the texts, and the change is shown and confirmed like any other.
  await page.getByRole("tab", { name: /^技能/u }).click();
  await page.getByRole("button", { name: "新建技能", exact: true }).click();
  const skillForm = page.getByRole("dialog", { name: "新建技能" });
  await skillForm.getByRole("textbox", { name: "技能名字" }).fill("standup-notes"); await skillForm.getByRole("textbox", { name: "技能说明" }).fill("Writes my standup notes"); await skillForm.getByRole("textbox", { name: "技能正文" }).fill("Summarize yesterday.");
  await skillForm.getByRole("button", { name: "检查改动" }).click();
  const confirmSkill = page.getByRole("dialog", { name: "新建技能 standup-notes" });
  await expect(confirmSkill.locator(".capability-diff")).toContainText("+name: standup-notes");
  await expect(confirmSkill).toContainText("Codex 的技能没有参数");
  await confirmSkill.getByRole("button", { name: "取消" }).click();
  assert.deepEqual(checks, ["subagents/sync?name=code-checker&harnessId=codex"]);
  assert.deepEqual(posted.map(item => item.path), ["changes", "subagents/save", "skill-create"]);
  assert.deepEqual(posted[1]!.body, { name: "test-writer", definition: { description: "Writes tests", prompt: "Write tests first." }, replace: false });
  assert.deepEqual(posted[2]!.body, { name: "standup-notes", description: "Writes my standup notes", body: "Summarize yesterday." });
  assert.deepEqual(errors, []);
});

test("G054-CA9 the plugins tab says whose plugins can be switched and why the others are read only; a plugin both Claude Code and Codex have is one row with a switch each, shown and confirmed like any change", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const fingerprint = "a".repeat(64), at = "2026-10-19T09:30:00.000Z", checks: URLSearchParams[] = [], posted: Record<string, unknown>[] = [];
  const diff = "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -2,4 +2,4 @@\n   \"enabledPlugins\": {\n-    \"tool@market\": true,\n+    \"tool@market\": false,\n     \"lone@market\": true\n";
  const notes = ["新开的 Claude Code 会话才读到这次改动，包括 HarnessHub 新开的会话；运行中的会话要 /reload-plugins，HarnessHub 的会话里没有这个命令。",
    "项目的 .claude/settings.json、.claude/settings.local.json、--settings 与组织的管理设置都能覆盖这里：在用户级写 false 关不掉项目启用的插件。claude.ai 下发的管理设置无法从文件核对。"];
  let history = { changes: [] as unknown[], backups: [] as unknown[], drift: [] as unknown[], ...HISTORY_EXTRA };
  const change = { id: "p-1", kind: "plugin-switch", harnessId: "claude", subject: "tool@market", file: "~/.claude/settings.json", status: "applied", diff, backupId: "33333333-2222-4333-8444-555555555555", error: null, notes, at };
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route("**/api/v1/capabilities/plugin-switch?**", route => {
    const query = new URL(route.request().url()).searchParams; checks.push(query);
    if (query.get("harnessId") === "codex") return route.fulfill({ json: { kind: "plugin-switch", harnessId: "codex", name: "tool@market", enabled: true, file: "~/.codex/config.toml", command: null, diff: null, rewrite: null,
      links: [], current: "other", notes: [], blocked: "它依赖的 needed@market 已停用。HarnessHub 不连带改动依赖。", fingerprint: "b".repeat(64), expiresAt: "2026-10-19T09:45:00.000Z" } });
    return route.fulfill({ json: { kind: "plugin-switch", harnessId: "claude", name: "tool@market", enabled: false, file: "~/.claude/settings.json", command: null, diff, rewrite: null, links: [], current: "other", notes,
      blocked: null, fingerprint, expiresAt: "2026-10-19T09:45:00.000Z" } });
  });
  await page.route("**/api/v1/capabilities/changes", async route => {
    posted.push(route.request().postDataJSON() as Record<string, unknown>);
    history = { changes: [change], backups: [{ id: change.backupId, file: "~/.claude/settings.json", createdAt: at, bytes: 120, changeId: "p-1", subject: "tool@market" }], drift: [], ...HISTORY_EXTRA };
    await route.fulfill({ json: change });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  await page.getByRole("tab", { name: "插件 1", exact: true }).click();
  // Who can switch, and why the others only read.
  const support = page.locator(".plugin-support");
  await expect(support).toContainText("Claude Code、Codex 的插件可以在这里停用或启用"); await expect(support).toContainText("安装与卸载还没有提供。");
  // Cursor is frozen and hidden by default, with its line (ADR-050).
  await expect(support.locator("li")).toHaveText(["Hermes Agent：hermes plugins enable 会经 save_config 整份重写 config.yaml（丢掉注释、补上默认项），暂时只读。"]);
  // One row; each Harness its own version, state and switch.
  const matrix = page.locator(".capability-matrix");
  await expect(matrix.locator("tbody tr")).toHaveCount(1);
  await matrix.locator("tbody tr").first().getByRole("button", { name: /tool@market/u }).click();
  const detail = page.locator(".capability-detail");
  await expect(detail).toContainText("v1.2.0 · 已启用"); await expect(detail).toContainText("v1.1.0 · 已停用"); await expect(detail).toContainText("Codex 停用了它");
  const switches = page.locator(".plugin-switches");
  await expect(switches.getByRole("button")).toHaveText(["在 Claude Code 中停用", "在 Codex 中启用"]);
  await switches.getByRole("button", { name: "在 Claude Code 中停用", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "在 Claude Code 中停用插件 tool@market" });
  for (const text of ["~/.claude/settings.json", "/reload-plugins", "关不掉项目启用的插件", "写入前先备份原文件"]) await expect(dialog).toContainText(text);
  await expect(dialog.locator(".capability-diff .text-red")).toHaveText(["-    \"tool@market\": true,"]);
  await expect(dialog.locator(".capability-diff .text-green")).toHaveText(["+    \"tool@market\": false,"]);
  assert.deepEqual(Object.fromEntries(checks[0]!), { harnessId: "claude", id: "tool@market", enabled: "false" });
  assert.equal(posted.length, 0, "nothing is sent before the confirmation");
  await page.screenshot({ path: join(artifact, "plugin-switch-confirmation.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "停用", exact: true }).click(); await expect(dialog).toBeHidden();
  const { commandId, ...sent } = posted[0]!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u); assert.deepEqual(sent, { fingerprint }, "the request is exactly the confirmed check");
  await expect(page.locator(".capability-result")).toContainText("已在 Claude Code 中停用 tool@market");
  await page.locator(".capability-history summary").click();
  await expect(page.locator(".capability-history")).toContainText("插件开关 · tool@market");
  // A check refused for a dependency cannot be confirmed.
  await matrix.locator("tbody tr").first().getByRole("button", { name: /tool@market/u }).click();
  if (!(await switches.isVisible())) await matrix.locator("tbody tr").first().getByRole("button", { name: /tool@market/u }).click();
  await switches.getByRole("button", { name: "在 Codex 中启用", exact: true }).click();
  const codex = page.getByRole("dialog", { name: "在 Codex 中启用插件 tool@market" });
  await expect(codex.locator(".switch-blocked")).toHaveText("它依赖的 needed@market 已停用。HarnessHub 不连带改动依赖。");
  await expect(codex.getByRole("button", { name: "启用", exact: true })).toBeDisabled();
  assert.deepEqual(Object.fromEntries(checks.at(-1)!), { harnessId: "codex", id: "tool@market", enabled: "true" });
  await codex.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(posted.length, 1); assert.deepEqual(errors, []);
});

test("G054-FZ1 the frozen Harnesses stay out of the picker, the welcome, the palette and my Agents until the settings show them, and a conversation on one still opens with its choice (ADR-050)", { timeout: 120000 }, async t => {
  // The control-peer stands in for Gemini CLI under its own catalog entry.
  const fixture = await launchFixture(false, null, null, false, undefined, undefined, { gemini: "0.62.0" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  const frozen = ["Gemini CLI", "Cursor", "Pi"], picker = page.getByRole("button", { name: "选择 Harness", exact: true });
  const welcome = page.getByRole("region", { name: "本机发现的 Harness" }), navigation = page.getByRole("complementary", { name: "主导航" });
  const row = (name: string) => page.locator(".harness-table-row").filter({ has: page.getByRole("button", { name: `查看 ${name} 详情`, exact: true }) });
  // By default none of them is offered for new work, though Gemini CLI is installed and ready: not in the welcome's list of
  // Agents (opened from its summary, ADR-054 §5), nor in its icons, nor in the picker.
  await expect(page.locator(".agent-summary .brand-tile[data-brand='codex']")).toHaveCount(1);
  for (const name of ["gemini", "cursor", "pi"]) await expect(page.locator(`.agent-summary .brand-tile[data-brand='${name}']`)).toHaveCount(0);
  await page.locator(".agent-summary").click();
  await expect(welcome.getByRole("button", { name: "选择 Codex", exact: true })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "选择 Gemini CLI", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await picker.click(); await expect(page.getByRole("option", { name: "Codex", exact: true })).toBeVisible();
  for (const name of frozen) await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+K"); await page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }).fill("开始新对话");
  await expect(page.getByText("用 Codex 开始新对话", { exact: true })).toBeVisible(); await expect(page.getByText("用 Gemini CLI 开始新对话", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await navigation.getByRole("button", { name: "我的 Agent", exact: true }).click();
  await expect(row("Codex")).toBeVisible();
  for (const name of frozen) await expect(row(name)).toHaveCount(0);
  // The list says how many it left out, and leads to the switch that shows them.
  const note = page.locator(".hidden-frozen");
  await expect(note).toHaveText("已隐藏 3 个冻结的 Harness，可在设置里显示");
  await note.getByRole("button", { name: "可在设置里显示", exact: true }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  const toggle = page.getByRole("switch", { name: FROZEN_SWITCH });
  await expect(page.locator(".frozen-setting")).toContainText("冻结：保留适配与历史对话，不再打磨；停在它们上面的对话照常打开。");
  await expect(toggle).not.toBeChecked(); await toggle.click(); await expect(toggle).toBeChecked();
  // Shown: each is listed with its mark, and only they carry it.
  await navigation.getByRole("button", { name: "我的 Agent", exact: true }).click();
  for (const name of frozen) await expect(row(name).locator(".harness-frozen")).toHaveText("冻结");
  await expect(row("Codex").locator(".harness-frozen")).toHaveCount(0); await expect(note).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "frozen-shown.png"), animations: "disabled" });
  // A conversation on Gemini CLI.
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await picker.click(); await page.getByRole("option", { name: "Gemini CLI", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await composer.fill("frozen work"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(log).toContainText("你好 fixture", { timeout: 15000 });
  // Hidden again: the conversation still opens on Gemini CLI and keeps it chosen and offered; a new conversation does not offer it.
  await navigation.getByRole("button", { name: "设置", exact: true }).click();
  await expect(toggle).toBeChecked(); await toggle.click(); await expect(toggle).not.toBeChecked();
  await navigation.getByRole("button", { name: "frozen work", exact: true }).click();
  await expect(page.locator("#chat-title")).toHaveText("frozen work");
  await expect(page.locator(".chat-page header")).toContainText("Gemini CLI");
  await expect(log).toContainText("你好 fixture");
  await expect(picker).toContainText("Gemini CLI");
  await picker.click(); await expect(page.getByRole("option", { name: "Gemini CLI", exact: true })).toBeVisible(); await page.keyboard.press("Escape");
  await expect(navigation.getByRole("button", { name: "frozen work", exact: true })).toHaveAccessibleDescription("Gemini CLI");
  await navigation.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(picker).toContainText("选择 Harness");
  await picker.click(); await expect(page.getByRole("option", { name: "Gemini CLI", exact: true })).toHaveCount(0); await page.keyboard.press("Escape");
  await page.locator(".agent-summary").click(); await expect(welcome.getByRole("button", { name: "选择 Codex", exact: true })).toBeVisible();
  await expect(welcome.getByRole("button", { name: "选择 Gemini CLI", exact: true })).toHaveCount(0); await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("G054-FZ2 an idle page asks the Gateway nothing; coming back reads the state and scans at most once a minute, the button scans at once, and a running task is read every 800 ms and scanned once it ends, asked again on coming back if that failed (ADR-050)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  // The one scan request the test refuses is an expected 503, which the browser logs as a failed resource.
  let refusals = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() !== "error") return; if (entry.location().url.endsWith("/api/v1/harnesses/rescan") && entry.text().includes("503")) refusals++; else errors.push(entry.text()); });
  // The Gateway's state, with its last scan made a minute old and a task of its own added when the test says so (G054-UP1's way).
  let stale = false, task: "none" | "running" | "ended" = "none", started = "", ended = "";
  const job = (status: "installing" | "completed", updatedAt: string) => ({ id: "management-00000000-0000-4000-8000-000000000054", harnessId: "codex", controlId: "codex-native", action: "upgrade",
    status, phase: status, cancelRequested: false, createdAt: started, updatedAt, resolvedVersion: null, installationId: null, error: null, logCursor: 0 });
  await page.route("**/api/v1/state", async route => {
    const response = await route.fetch(), body = await response.json() as { jobs: unknown[] };
    await route.fulfill({ response, json: { ...body, ...(stale ? { harnessesScannedAt: new Date(Date.now() - 61_000).toISOString() } : {}),
      jobs: task === "none" ? body.jobs : [task === "running" ? job("installing", started) : job("completed", ended), ...body.jobs] } });
  });
  const reads: number[] = [], scans: { readonly at: number; readonly body: unknown }[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/state") reads.push(Date.now());
    if (path === "/api/v1/harnesses/rescan" && request.method() === "POST") scans.push({ at: Date.now(), body: request.postDataJSON() as unknown });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await expect.poll(() => reads.length).toBe(1);
  // Idle: nothing at all for twelve seconds, where the page used to read the state every five and scan with it.
  await page.waitForTimeout(12_000);
  assert.deepEqual([reads.length, scans.length], [1, 0], "an idle page asks nothing");
  // Coming back with a fresh scan reads the state and scans nothing.
  const focus = () => page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  const shown = () => page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await focus(); await expect.poll(() => reads.length).toBe(2);
  await shown(); await expect.poll(() => reads.length).toBe(3);
  await page.waitForTimeout(500); assert.equal(scans.length, 0, "the last scan is not a minute old");
  // With the last scan a minute old: one scan, however often the page comes back within the minute.
  stale = true;
  await focus(); await expect.poll(() => scans.length).toBe(1); assert.deepEqual(scans[0]!.body, {});
  for (let index = 0; index < 4; index++) { await page.waitForTimeout(150); await focus(); await shown(); }
  await expect.poll(() => reads.length).toBeGreaterThanOrEqual(6);
  await page.waitForTimeout(1000); assert.equal(scans.length, 1, "at most one scan a minute on coming back");
  // The button scans at once.
  stale = false;
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "我的 Agent", exact: true }).click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click(); await expect.poll(() => scans.length).toBe(2);
  // A running task is read every 800 ms; once it has ended the page asks for one scan after its end, then reads no more.
  started = new Date().toISOString(); task = "running";
  const before = reads.length;
  await focus();
  await expect.poll(() => reads.length - before, { timeout: 15000 }).toBeGreaterThanOrEqual(5);
  const gaps = reads.slice(before + 1).map((at, index, list) => at - (index === 0 ? reads[before]! : list[index - 1]!));
  assert.ok(gaps.every(gap => gap >= 700 && gap <= 3000), "reads while the task runs: " + gaps.join(", ") + " ms apart");
  assert.equal(scans.length, 2, "a running task asks for no scan");
  // The first ask after the end is refused; the page says so, and asks again when it next comes back.
  let refuse = true;
  await page.route("**/api/v1/harnesses/rescan", async route => {
    if (refuse && (route.request().postDataJSON() as { after?: string }).after !== undefined) { refuse = false; await route.fulfill({ status: 503, json: { code: "MANAGEMENT_UNAVAILABLE", message: "refused by the test" } }); return; }
    await route.fallback();
  });
  ended = new Date().toISOString(); task = "ended";
  await expect.poll(() => scans.length, { timeout: 10000 }).toBe(3);
  assert.deepEqual(scans[2]!.body, { after: ended });
  await expect(page.locator(".connection-notice")).toBeVisible();
  const settled = reads.length; await page.waitForTimeout(3000);
  assert.equal(reads.length, settled, "nothing is read once the task has ended"); assert.equal(scans.length, 3);
  await focus(); await expect.poll(() => scans.length).toBe(4);
  assert.deepEqual(scans[3]!.body, { after: ended }); await expect(page.locator(".connection-notice")).toHaveCount(0);
  await page.waitForTimeout(1000); assert.equal(scans.length, 4, "asked once more, and once only");
  assert.equal(refusals, 1); assert.deepEqual(errors, []);
});

test("G054-FZ3 DeepSeek Harness of any version shows its one-question command with the credentials it depends on, and no interactive command (ADR-039, ADR-053)", { timeout: 120000 }, async t => {
  // The control-peer stands in for DeepSeek Harness under a version HarnessHub never ran: the command does not depend on it.
  const fixture = await launchFixture(false, null, null, false, undefined, undefined, { dsh: "0.3.1" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  const option = page.getByRole("option", { name: "DeepSeek Harness", exact: true });
  // The picker shows the version as a fact and nothing about it.
  await expect(option).toContainText("v0.3.1"); await expect(option).not.toContainText("验证"); await option.click();
  await composer.fill("hello"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  // Mutation check (run by hand, not kept): without NativeResume's once-only branch, only the identifier is shown.
  const resume = page.getByRole("complementary", { name: "详情栏" }).getByLabel("在原程序中继续");
  await expect(resume.locator(".native-resume-row code")).toHaveText(["session-fixture", "dsh headless --session-id session-fixture \"你的问题\""]);
  await expect(resume.locator(".native-resume-row small")).toHaveText(["原生会话 ID", "只问一次 · 在该对话的工作区目录中运行"]);
  await expect(resume.locator(".native-resume-note")).toHaveText([/^dsh headless 不读 DeepSeek Harness 界面里保存的密钥和账号登录.*三行设为 disabled）$/u,
    "原程序首次在这个目录运行时可能先询问是否信任这个目录；接受会写入它自己的全局配置。", "在原程序中继续会使两边的回合交错；回到 HarnessHub 继续前，先在原程序中结束。"]);
  await expect(resume.getByRole("button", { name: "复制只问一次的命令", exact: true })).toBeVisible();
  await expect(resume.getByRole("button", { name: "复制恢复命令", exact: true })).toHaveCount(0);
  await expect(resume).not.toContainText("验证");
  await page.screenshot({ path: join(artifact, "native-resume-once.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});
