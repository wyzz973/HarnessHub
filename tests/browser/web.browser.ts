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
/**
 * Opens the composer's advanced settings (控制入口、原生选项与后台进程) as a user does since ruling R2: from the footer of
 * the Agent list, which closes as the panel opens.
 */
async function openAdvanced(page: Page): Promise<void> {
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await page.getByRole("button", { name: "高级配置…", exact: true }).click();
  // Fully in, so that a screenshot taken next shows it whole.
  await expect(page.locator(".composer-settings-panel")).toHaveCSS("opacity", "1");
}
/** Opens the Agent's read-only skills, MCP servers and plugins from the footer of the Agent list (ruling R2). */
async function openExtensions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  await page.getByRole("button", { name: "查看技能与扩展…", exact: true }).click();
  await expect(page.locator(".native-extensions")).toHaveCSS("opacity", "1");
}
/** Opens the Agent's own sessions in this workspace from the composer's "+" menu (ruling R2). */
async function openNativeSessions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "添加文件或上下文", exact: true }).click();
  await page.getByRole("menuitem", { name: "继续原程序的会话…", exact: true }).click();
  await expect(page.locator(".native-sessions")).toHaveCSS("opacity", "1");
}
/**
 * Holds the event stream's bytes while asked to (fault injection on the delivery of real SSE bytes: the server, its store
 * and every command are untouched), so that a request such as an approval arrives at a moment the test chooses. Install it
 * on the context before the page opens; the returned function holds (true) or releases (false) the page's stream.
 */
async function holdFactDelivery(context: Awaited<ReturnType<typeof isolatedContext>>): Promise<(page: Page, held: boolean) => Promise<void>> {
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
  return (page, held) => page.evaluate(value => { const set = Reflect.get(window, "__holdFactDelivery"); if (typeof set !== "function") throw new Error("missing fact delivery fixture"); set(value); }, held);
}
/**
 * Points at a row button and reads the tint it takes, then leaves it and reads the tint gone (Motion board #30: its
 * background, 120 ms on the standard curve). `tint` is the subtle fill, or the hover fill for a row on a subtle surface.
 */
async function rowTint(page: Page, row: ReturnType<Page["locator"]>, tint = "rgb(244, 245, 247)"): Promise<void> {
  const background = () => row.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.mouse.move(2, 2); await expect.poll(background).toBe("rgba(0, 0, 0, 0)");
  await row.hover(); await expect.poll(background).toBe(tint);
  assert.deepEqual(await row.evaluate(element => { const style = getComputedStyle(element); return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction]; }),
    ["background-color", "0.12s", "cubic-bezier(0.2, 0, 0, 1)"]);
  await page.mouse.move(2, 2); await expect.poll(background).toBe("rgba(0, 0, 0, 0)");
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

  await page.getByRole("button", { name: "模型连接", exact: true }).click();
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
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "providers-dark-desktop.png"), fullPage: true, animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
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
  await page.getByRole("button", { name: "模型连接", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  // A connection's configuration version is said in words, without a "v" the page would add (ruling P).
  await expect(page.getByText("配置版本 1", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/API Key/u)).toHaveValue("");
  await page.getByLabel("模型 ID 列表", { exact: true }).fill("model-b\nmodel-b2");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作模型 B", exact: true })).toBeVisible();
  const edited = page.getByRole("article", { name: "工作模型 B", exact: true });
  await expect(edited.getByText("配置版本 2", { exact: true })).toBeVisible(); await expect(edited).not.toContainText("v2");
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  // The newer version of the connection in use waits in the advanced settings: its amber dot is on the Agent part of the
  // merged picker, and on 高级配置… in the Agent list's footer (ruling R2), each described in words.
  const agentPart = page.getByRole("button", { name: "选择 Harness", exact: true }), newer = "所选模型连接有新的配置版本，可以在高级配置里改用";
  await expect(agentPart.locator(".outdated-dot")).toBeVisible(); await expect(agentPart).toHaveAccessibleDescription(newer);
  await agentPart.click();
  const advanced = page.getByRole("button", { name: "高级配置…", exact: true });
  await expect(advanced).toHaveAccessibleDescription(newer); await expect(page.locator(".picker-popover")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: join(artifact, "outdated-connection.png"), animations: "disabled" });
  await advanced.click();
  await expect(page.getByRole("button", { name: "使用最新版本 2", exact: true })).toBeVisible();
  current = await snapshot(); assert.equal(current.selection.provider.revision, 1);
  await page.getByRole("button", { name: "使用最新版本 2", exact: true }).click();
  await page.getByRole("button", { name: "收起高级配置", exact: true }).click();
  await expect(agentPart.locator(".outdated-dot")).toHaveCount(0); await expect(agentPart).not.toHaveAccessibleDescription(newer);
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
  // A Turn the user stopped says so in the Interaction board's words (ADR-054 decision H).
  await expect(page.getByRole("log").locator("[data-run-status=cancelled]")).toContainText("已停止");
  await expect(page.getByRole("log").locator("[data-run-status=cancelled]")).not.toContainText("已取消");
  current = await snapshot(); assert.equal(current.runs.at(-1)?.status, "cancelled");
  await page.getByRole("button", { name: "模型连接", exact: true }).click();
  await page.getByRole("button", { name: "编辑 工作模型 B", exact: true }).click();
  await page.getByRole("checkbox", { name: "启用这个 Provider", exact: true }).uncheck();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型连接", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("textbox", { name: "发送消息", exact: true }).fill("停用后不能发起新调用");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
  // The palette names the page as the sidebar and its heading do; the name it had before still finds it (ruling O).
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }); await palette.fill("模型与账号");
  await expect(page.getByRole("option")).toHaveCount(1); await expect(page.getByRole("option")).toHaveAccessibleName(/^模型连接/u);
  await palette.press("Enter"); await expect(page.getByRole("heading", { name: "模型连接", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加 Provider", exact: true }).click();
  await createProvider("其他协议连接", "claude-fixture", "browser-fixture-key-C", "anthropic-messages");
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Provider", exact: true }).click();
  await expect(page.getByRole("option", { name: "其他协议连接", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  assert.ok(!(await page.locator("body").innerText()).includes("browser-fixture-key"));
  await page.getByRole("button", { name: "Harness", exact: true }).click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新检测", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "查看 Codex 详情", exact: true })).toBeVisible();
  // Every Agent card and every row of "还可以安装" carries its mark; the list shows its first rows until "全部".
  await page.getByRole("button", { name: /^显示全部/u }).click();
  const brandImages = page.locator(".agent-entry img.brand-icon");
  await expect(brandImages).toHaveCount(await page.locator(".agent-entry").count());
  await expect.poll(() => brandImages.evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  const target = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 Autohand Code 详情", exact: true }) });
  await target.getByRole("button", { name: "安装", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("安装完成", { exact: true })).toBeVisible();
  await detail.getByText("安装日志", { exact: false }).first().click();
  await expect(detail.getByRole("log", { name: "安装日志" })).toContainText("1.0.0 verified");
  await page.screenshot({ path: join(artifact, "install-detail.png"), fullPage: true, animations: "disabled" });
  fixture.setVersion("2.0.0");
  await detail.getByRole("button", { name: "检查 Autohand Code 更新", exact: true }).click();
  await expect(detail.getByText("可以升级到 2.0.0", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "升级到 2.0.0", exact: true }).click();
  await expect.poll(async () => {
    const jobs: unknown = await (await context.request.get(origin + "/api/v1/installation-jobs")).json();
    assert.ok(Array.isArray(jobs));
    return jobs.length === 2 && jobs.every(job => job !== null && typeof job === "object" && "status" in job && job.status === "completed");
  }).toBe(true);
  await expect(detail.getByText("2.0.0", { exact: true }).first()).toBeVisible();
  // A completed upgrade is said as one (ADR-043); the first task above was an installation.
  await expect(detail.getByRole("status").filter({ hasText: "升级完成" })).toBeVisible();
  await expect(detail.getByText("已是最新 2.0.0", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "已是最新", exact: true })).toBeDisabled();
  // Installed and current, it can start a conversation from its details; its card says it is ready and offers no upgrade.
  await expect(detail.getByRole("button", { name: "开始对话", exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "upgrade-detail.png"), fullPage: true, animations: "disabled" });
  await detail.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click();
  await expect(target.locator(".status-pill")).toHaveText("就绪");
  await expect(target.getByRole("button", { name: /^升级/u })).toHaveCount(0);
  await page.locator(".harness-management-body").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(artifact, "harnesses-desktop.png"), fullPage: true, animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: join(artifact, `harnesses-${width}.png`), fullPage: true, animations: "disabled" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile layout has horizontal overflow");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  reusedLaunch = true; await page.goto(fixture.gateway.url); await page.reload();
  await expect(page.getByRole("heading", { name: "今天想让哪个 Harness 做什么？", exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "回到最新回复", exact: true })).toHaveText("回到最新");
  // #14: it rises and fades in over 200 ms.
  assert.deepEqual(await page.getByRole("button", { name: "回到最新回复", exact: true }).evaluate(element => { const style = getComputedStyle(element); return [style.animationName, style.animationDuration]; }), ["hh-enter", "0.2s"]);
  await page.waitForTimeout(250); await page.screenshot({ path: join(artifact, "follow-latest-943.png"), animations: "disabled" });
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
  // The connection's configuration version is a number under its name, without a "v" the page would add (ruling P).
  await expect(page.getByRole("complementary", { name: "详情栏" }).locator(".execution-details dt", { hasText: "配置版本" }).locator("xpath=following-sibling::dd[1]")).toHaveText("1");
  await page.getByRole("button", { name: "关闭详情栏", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "详情栏" })).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "chat-completed-943.png"), fullPage: true, animations: "disabled" });
  // A draft the user wrote is not lost when 放回输入框 fills the composer: a toast offers to put it back.
  await composer.fill("还没写完的草稿");
  await log.getByRole("button", { name: "放回输入框", exact: true }).first().click();
  await expect(composer).toHaveValue("STREAM_RENDER：逐段展示，完成前保持连接");
  const replaced = page.getByRole("dialog", { name: "已替换输入框里的草稿" });
  await expect(replaced).toBeVisible(); await replaced.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(composer).toHaveValue("还没写完的草稿"); await expect(composer).toBeFocused();
  // An empty composer is filled without a toast.
  await composer.fill("");
  await log.getByRole("button", { name: "放回输入框", exact: true }).first().click();
  await expect(composer).toHaveValue("STREAM_RENDER：逐段展示，完成前保持连接"); assert.equal((await current()).runs.length, 1, "editing a draft does not re-dispatch a Run");
  await expect(replaced).toHaveCount(0);
  await composer.fill("STREAM_CANCEL：保留已经收到的部分内容"); await composer.press("Enter");
  await expect(page.locator('.assistant-message[data-run-status="running"]')).toContainText("第一段已经到达。");
  const partial = await current(); assert.equal(partial.runs.length, 2); assert.equal(partial.runs[1]!.status, "running");
  assert.ok(String(partial.messages.at(-1)?.text).includes("第一段已经到达。"));
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  // The user stopped it: the Turn and the header say 已停止 (ADR-054 decision H).
  await expect(page.locator(".assistant-message").last()).toContainText("已停止");
  await expect(page.locator(".chat-page > header .status-pill")).toHaveText("Codex 已停止");
  const stopped = await current(); assert.equal(stopped.runs.length, 2); assert.equal(stopped.runs[1]!.status, "cancelled");
  assert.ok(String(stopped.messages.at(-1)?.text).includes("第一段已经到达。"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page.locator(".assistant-message").last().evaluate(element => {
    const style = getComputedStyle(element); return [style.animationDuration, style.transitionDuration].flatMap(value => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)));
  }); assert.ok(motion.every(value => value <= 1));
  await page.screenshot({ path: join(artifact, "chat-cancelled-943.png"), fullPage: true, animations: "disabled" });
  // The conversation ends from the "…" menu's 结束对话… alone (ruling R3): the header has no × of its own.
  await expect(page.getByRole("button", { name: "关闭这个对话" })).toHaveCount(0);
  const more = page.getByRole("button", { name: "更多操作", exact: true }), end = page.getByRole("menuitem", { name: "结束对话…", exact: true });
  await more.click(); await expect(end).toHaveAccessibleDescription("结束会话，保留历史"); await end.click();
  await expect(page.getByRole("dialog", { name: "结束这次会话？", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续对话", exact: true }).click();
  assert.equal((await current()).snapshot.status, "open");
  await more.click(); await end.click();
  await page.getByRole("button", { name: "结束会话", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "发送消息", exact: true })).toBeDisabled();
  // Once ended, the item stays in the menu, disabled.
  await more.click(); await expect(end).toBeDisabled(); await page.keyboard.press("Escape");
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
  await expect(page.getByRole("button", { name: "模型连接", exact: true })).toHaveCount(0);
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
  // A failed Turn's line says the state's word first, as the sidebar and the header do (ruling N).
  await expect(page.locator(".assistant-message").last().locator(".process-summary")).toHaveText(/^失败 · 用时 [0-9.]+ 秒$/u);
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
  await openAdvanced(page);
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
  // ADR-054: the plan stands above the composer and in the details, not inside the Turn. The panel is closed until opened
  // (decision E); at this width the header's button opens it beside the conversation.
  const panel = page.getByRole("complementary", { name: "详情栏" });
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await panel.getByRole("tab", { name: /计划/u }).click();
  await expect(panel.getByText("Codex 维护的计划 · 1 / 2 完成")).toBeVisible(); await expect(panel.getByText("修改文件")).toBeVisible();
  await expect(log.getByText("计划 · 1/2 完成")).toHaveCount(0);
  await expect(log.getByText("浏览器验收提示")).toBeVisible();
  // The usage under the reply is the board's: input, output and cost; the context share is in the details (below).
  await expect(log.locator(".native-usage")).toHaveText("输入 1.2k · 输出 300");
  // The Run's own phases give the first-output time next to its usage, and the total time ends the process line.
  await expect(log.locator(".run-timing").first()).toHaveText(/^首字 [0-9.]+ 秒$/u);
  // The process is folded into one line once the Turn ended; opening it lists each tool.
  const summary = log.locator(".process-summary");
  await expect(summary).toHaveAttribute("aria-expanded", "false"); await expect(summary).toContainText("运行 1 条命令"); await expect(summary).toHaveText(/ · [0-9.]+ 秒$/u);
  await summary.first().click();
  const command = log.getByRole("button", { name: /ls -la/u });
  await expect(command).toBeEnabled(); await command.click();
  await expect(log.getByText("README.md").first()).toBeVisible(); await expect(log.locator(".native-tool-detail pre").first()).toContainText("ls -la");
  await log.getByRole("button", { name: /修改 README\.md/u }).click();
  await expect(log.locator(".native-diff .is-add")).toContainText("+新内容"); await expect(log.locator(".native-diff .is-remove")).toContainText("-旧内容");
  await page.locator(".assistant-message").last().hover(); await page.getByRole("button", { name: "执行详情", exact: true }).last().click();
  await expect(page.getByText("本轮用量")).toBeVisible(); await expect(panel).toContainText("1,500 / 10,000 tokens（15%）");
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
  // The branch opened in place of the page whose button was pressed, and that button went away with it: the branch takes
  // the focus where the user continues, its message box, instead of leaving it to the page.
  await expect(composer).toBeFocused();
  await expect(origin.getByText("原生会话已分支")).toBeVisible({ timeout: 15000 });
  await origin.getByText("查看分支前的对话").click(); await expect(origin).toContainText("分支前的第一条消息");
  await expect(page.getByRole("button", { name: "分支 · 分支前的第一条消息", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("分支 · 分支前的第一条消息");
  await page.screenshot({ path: join(artifact, "branch-origin.png"), animations: "disabled" });
  await composer.fill("WHICH_THREAD 分支"); await composer.press("Enter");
  await expect(log).toContainText("原生分支线程，公共历史 0 轮，分支历史 0 条", { timeout: 15000 });
  // The original conversation keeps its own native thread and history. Opened from 打开原对话, it takes the focus in its
  // message box as well.
  await origin.getByRole("button", { name: /打开原对话/u }).click();
  await expect(page.getByRole("region", { name: "分支来源" })).toHaveCount(0); await expect(composer).toBeFocused();
  await composer.fill("WHICH_THREAD 原对话"); await composer.press("Enter");
  await expect(log).toContainText("原线程", { timeout: 15000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the branch view must not overflow a narrow screen");
  // The header's … menu branches from the latest reply, and that branch takes the focus in its message box too.
  await page.setViewportSize({ width: 1280, height: 900 }); await expect(log.locator("[data-run-status=completed]")).toHaveCount(2, { timeout: 15000 });
  await page.getByRole("button", { name: "更多操作", exact: true }).click(); await page.getByRole("menuitem", { name: "从最新回复分支", exact: true }).click();
  await expect(origin).toContainText("4 条消息", { timeout: 15000 }); await expect(composer).toBeFocused();
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
  const reads: string[] = []; page.on("request", request => { if (/\/harnesses\/[^/]+\/extensions\?/u.test(request.url())) reads.push(request.url()); });
  await openExtensions(page);
  const panel = page.locator(".native-extensions"), agentPart = page.getByRole("button", { name: "选择 Harness", exact: true });
  await expect(panel.getByRole("button", { name: "browser-skill", exact: true })).toBeVisible({ timeout: 15000 });
  // Opened from the Agent list's footer, the panel takes the focus; closed, it gives it back to the Agent part of the merged
  // picker, the control that held the item (ruling R2). Opened again, it shows what it read without reading again.
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); await expect(agentPart).toBeFocused();
  // From the keyboard as well: ⌘J opens the Agent list, Tab walks on to its footer, ⏎ on 查看技能与扩展… opens the panel with
  // the focus inside it, and esc gives the focus back to the Agent part.
  const footerItem = page.getByRole("button", { name: "查看技能与扩展…", exact: true });
  await page.keyboard.press("ControlOrMeta+J"); await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toBeFocused();
  for (let step = 0; step < 12 && !(await page.evaluate(() => document.activeElement?.textContent === "查看技能与扩展…")); step++) await page.keyboard.press("Tab");
  await expect(footerItem).toBeFocused(); await page.keyboard.press("Enter");
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); await expect(agentPart).toBeFocused();
  await openExtensions(page);
  await expect(panel).toContainText("浏览器验收技能"); assert.equal(reads.length, 1, "the extensions are read once");
  // Each group's line opens it in place and, pointed at, tints like any row.
  await rowTint(page, panel.getByRole("button", { name: /^MCP 服务器/u }));
  await panel.getByText("MCP 服务器").click(); await expect(panel).toContainText("browser-docs"); await expect(panel).toContainText("已连接"); await expect(panel).toContainText("1 个工具");
  await panel.getByText("插件与扩展").click(); await expect(panel).toContainText("browser-plugin");
  // A version is shown as the program reported it, without a "v" the page would add (ruling P).
  await expect(panel).toContainText("2.0.0"); await expect(panel).not.toContainText("v2.0.0");
  await page.screenshot({ path: join(artifact, "native-extensions.png"), animations: "disabled" });
  // Choosing a skill puts its command in the message as choosing a "/" command does: the panel closes and the caret stands
  // after the command, in the focused message box.
  const caret = () => composer.evaluate(element => { const field = element as HTMLTextAreaElement; return [field.selectionStart, field.selectionEnd, field.value.length]; });
  await panel.getByRole("button", { name: "browser-skill", exact: true }).click();
  await expect(composer).toHaveValue("/skill:browser-skill ");
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused(); assert.deepEqual(await caret(), [21, 21, 21]);
  // From the keyboard as well, and after the command also when the message already was that command, the caret elsewhere.
  await composer.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(3, 3));
  await openExtensions(page);
  await panel.getByRole("button", { name: "browser-skill", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused(); assert.deepEqual(await caret(), [21, 21, 21]);
  await expect(composer).toHaveValue("/skill:browser-skill ");
  // A message already written is never lost: the command goes in front of it, the caret right after the command. Chosen
  // again with the caret at the end, the command is not put in a second time, and the caret goes back after it.
  await composer.fill("这个仓库");
  await openExtensions(page);
  await panel.getByRole("button", { name: "browser-skill", exact: true }).click();
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("/skill:browser-skill 这个仓库"); assert.deepEqual(await caret(), [21, 21, 25]);
  await composer.press("End"); await openExtensions(page);
  await panel.getByRole("button", { name: "browser-skill", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("/skill:browser-skill 这个仓库"); assert.deepEqual(await caret(), [21, 21, 25]);
  await composer.type("看看"); await expect(composer).toHaveValue("/skill:browser-skill 看看这个仓库"); await composer.press("Enter");
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openNativeSessions(page);
  const panel = page.locator(".native-sessions");
  await expect(panel.getByText("Earlier work", { exact: true })).toBeVisible({ timeout: 15000 });
  await panel.getByRole("button", { name: "加载更早的会话", exact: true }).click(); await expect(panel.getByText("未命名会话", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: join(artifact, "native-sessions-panel.png"), animations: "disabled" });
  await panel.locator("li", { hasText: "Earlier work" }).getByRole("button", { name: "接续", exact: true }).click();
  const origin = page.getByRole("region", { name: "接续来源" });
  await expect(origin).toContainText("接续本机 Native Sessions 会话「Earlier work」", { timeout: 15000 }); await expect(origin).toContainText("4 条消息");
  // The panel and the button pressed went away with the page that held them; the conversation that opens takes the focus
  // where the user continues, its message box, instead of leaving it to the page.
  await expect(composer).toBeFocused();
  await rowTint(page, origin.getByRole("button", { name: "查看本机会话的历史", exact: true }));
  await origin.getByText("查看本机会话的历史").click(); await expect(origin).toContainText("first question"); await expect(origin).toContainText("second answer");
  await expect(page.getByRole("button", { name: "接续 · Earlier work", exact: true })).toBeVisible();
  await composer.fill("what did I ask first?"); await composer.press("Enter");
  await expect(log.locator(".assistant-message").last()).toContainText("你好 fixture", { timeout: 15000 });
  await openNativeSessions(page);
  await expect(page.locator(".native-sessions li", { hasText: "Earlier work" }).getByRole("button", { name: /打开对话/u })).toBeVisible({ timeout: 15000 });
  // Opened from the "+" menu, the panel holds the focus; closed, it gives it back to "+", the control that held the item (ruling R2).
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加文件或上下文", exact: true })).toBeFocused();
  // From the keyboard as well: ⏎ on "+" opens its menu at its first item, End goes to 继续原程序的会话… (its last), ⏎ opens
  // the panel with the focus inside it, and esc gives the focus back to "+".
  const add = page.getByRole("button", { name: "添加文件或上下文", exact: true }), resume = page.getByRole("menuitem", { name: "继续原程序的会话…", exact: true });
  await page.keyboard.press("Enter"); await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End"); await expect(resume).toBeFocused(); await page.keyboard.press("Enter");
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0); await expect(add).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the continued conversation must not overflow a narrow screen");
  await page.screenshot({ path: join(artifact, "native-session-continued-390.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  // 打开对话 opens the conversation that already continues the session in place of this page, as 接续 does, and its
  // message box takes the focus as well.
  const newChat = page.getByRole("button", { name: "新对话", exact: true });
  await newChat.click(); await expect(origin).toHaveCount(0);
  await openNativeSessions(page);
  await panel.locator("li", { hasText: "Earlier work" }).getByRole("button", { name: /打开对话/u }).click();
  await expect(origin).toContainText("「Earlier work」", { timeout: 15000 }); await expect(composer).toBeFocused();
  // Focus the user moves elsewhere while the next conversation is being created (here to the sidebar's search, which stays
  // usable meanwhile) stays where they put it.
  await newChat.click(); await openNativeSessions(page);
  await panel.getByRole("button", { name: "加载更早的会话", exact: true }).click(); await expect(panel.getByText("未命名会话", { exact: true })).toBeVisible({ timeout: 15000 });
  // A conversation the Gateway does not create leaves the panel open and the page says why; the 接续 pressed, which waited
  // disabled meanwhile, has the focus again, so the user tries again from where they were rather than from the page.
  await page.route("**/api/v1/sessions/import", route => route.fulfill({ status: 503, json: { code: "HARNESS_UNAVAILABLE", message: "refused by the test" } }));
  const unnamed = panel.locator("li", { hasText: "未命名会话" }).getByRole("button", { name: "接续", exact: true });
  await unnamed.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "这个 Harness 当前不可用" })).toBeVisible({ timeout: 15000 });
  await expect(unnamed).toBeEnabled(); await expect(unnamed).toBeFocused(); await expect(panel).toHaveCount(1);
  await page.unroute("**/api/v1/sessions/import");
  let create = () => {}; const creating = new Promise<void>(resolve => { create = resolve; });
  await page.route("**/api/v1/sessions/import", async route => { await creating; await route.fallback(); });
  await panel.locator("li", { hasText: "未命名会话" }).getByRole("button", { name: "接续", exact: true }).click();
  const search = page.getByRole("button", { name: "搜索与命令", exact: true });
  await search.focus(); await expect(search).toBeFocused(); create();
  await expect(origin).toContainText("接续本机 Native Sessions 会话", { timeout: 15000 }); await expect(origin).not.toContainText("Earlier work");
  await expect(search).toBeFocused();
  await page.unroute("**/api/v1/sessions/import");
  // Where the conversation that opens takes no message, its title takes the focus: here that conversation, once ended.
  await page.getByRole("button", { name: "更多操作", exact: true }).click(); await page.getByRole("menuitem", { name: /^结束对话…/u }).click();
  await page.getByRole("dialog", { name: "结束这次会话？" }).getByRole("button", { name: "结束会话", exact: true }).click();
  const title = page.locator("#chat-title");
  await expect(title).toContainText("已结束", { timeout: 15000 });
  await newChat.click(); await openNativeSessions(page);
  await panel.getByRole("button", { name: "加载更早的会话", exact: true }).click();
  await panel.locator("li", { hasText: "未命名会话" }).getByRole("button", { name: /打开对话/u }).click();
  await expect(title).toContainText("已结束", { timeout: 15000 }); await expect(composer).toBeDisabled(); await expect(title).toBeFocused();
  // The one refused import is the only failed request.
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]);
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
  // The steps stay open while the Turn runs and fold 1.1 s after it ended (ADR-054 §3); opened again, they list the tools.
  await expect(log.locator(".process-summary").last()).toHaveAttribute("aria-expanded", "false");
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
  await openAdvanced(page);
  // Opened from the Agent list's footer, the settings take the focus, and closed they give it back to the Agent part of the
  // merged picker, the control that held the item (ruling R2).
  const settings = page.locator(".composer-settings-panel");
  await expect.poll(() => settings.evaluate(element => element.contains(document.activeElement))).toBe(true);
  const keep = page.getByRole("checkbox", { name: "保持原生进程" });
  await expect(keep).not.toBeChecked(); await keep.click(); await expect(keep).toBeChecked();
  await page.keyboard.press("Escape"); await expect(settings).toHaveCount(0);
  await expect(page.getByRole("button", { name: "选择 Harness", exact: true })).toBeFocused();
  await reply("first", 1);
  const first = await current();
  assert.equal(first.retention.enabled, true); assert.equal(first.runs[0].retained, true); assert.equal(first.retention.process?.harnessId, "native-acp");
  await reply("second", 2);
  const reused = await current();
  assert.equal(reused.runs[1].reused, true); assert.equal(reused.runs[1].retained, true); assert.equal(reused.runs[1].cleanup, null);
  await openAdvanced(page);
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
  await openAdvanced(page);
  await fast.click(); await page.getByRole("option", { name: "On", exact: true }).click(); await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled(); await composer.fill("first");
  await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("你好 fixture", { timeout: 15000 });
  const check = async () => {
    // The thinking level comes back, marked as last used; the other native setting follows the program's default.
    await expect(thinking).toContainText("最大");
    await thinking.click(); await expect(page.getByRole("option", { name: "最大", exact: true })).toHaveAccessibleDescription(/上次使用/); await page.keyboard.press("Escape");
    await openAdvanced(page); await expect(fast).toContainText("本机默认"); await page.keyboard.press("Escape");
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
  assert.equal(notices.length, 1); assert.equal(notices[0]!.title, "Hermes Agent 等你处理");
  assert.match(notices[0]!.body, /^等你批准（原程序期限，\d+ 秒后自动拒绝）$/u, "only the Harness and the wait, nothing of the conversation");
  // Another conversation is open; the sidebar still says which one waits, for what, and for how long.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const waiting = page.locator(".session-item.has-attention");
  await expect(waiting).toHaveCount(1); await expect(page.locator(".attention-count")).toHaveText("1");
  const line = waiting.locator(".attention-line");
  await expect(line).toHaveText(/^等你批准 · 原程序期限 \d+ 秒后自动拒绝$/u);
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
  await expect(page.locator(".session-item.has-attention .attention-line")).toHaveText("等你批准 · 等待期限 剩余 30 分");
  // A second conversation in the same workspace queues behind it, and says which conversation and why, without paths.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await send("queued work");
  const status = log.locator(".response-status");
  // What the holder waits for is said as every other place says it (ADR-054 decision G).
  await expect(status).toHaveText("排队中：等待对话「approve this」释放工作区（它在等你批准）", { timeout: 15000 });
  // Waiting, it has not started: the line under the composer counts no time for it, as the Turn's own line counts none.
  await expect(page.locator(".composer-status")).toHaveText("第 1 轮");
  await expect(log.locator(".queued-turn small")).toHaveText("最多再等 30 分钟，到时这条消息不会发出。");
  assert.equal((await log.textContent())?.includes(fixture.root), false, "no private path reaches the page");
  await page.screenshot({ path: join(artifact, "queued-turn.png"), animations: "disabled" });
  // Cancelling the queued Turn stops only it; a new message queues again.
  await log.getByRole("button", { name: "取消排队", exact: true }).click();
  await expect(log.locator("[data-run-status=cancelled]")).toHaveCount(1);
  await send("queued again");
  await expect(log.locator(".response-status").last()).toHaveText(/^排队中：等待对话「approve this」/u, { timeout: 15000 });
  // The holder opens from the queued Turn; once its approval is decided and its Turn ends, the queued Turn starts by itself.
  // It opened in place of the page whose link was pressed: the approval waiting in its composer's place takes the focus.
  await log.getByRole("button", { name: "打开那个对话", exact: true }).click();
  await expect(card).toBeVisible(); await expect(card).toBeFocused(); await card.getByRole("button", { name: "Allow once", exact: true }).click();
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
  // The conversation that held the workspace opens in place of this page and takes the focus in its message box.
  await failure.getByRole("button", { name: "打开那个对话", exact: true }).click();
  await expect(page.getByRole("heading", { name: "long work" })).toBeVisible(); await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "停止当前回复", exact: true }).click();
  await expect(log.locator("[data-run-status=cancelled]")).toHaveCount(1, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("a Turn the Runtime cancelled when its wait budget ran out keeps the contract's words in the Turn and the details, the header says 已取消, never 已停止, and out of sight it is announced like a failure while the user's own stop is not (ADR-036, ADR-054 decision H, ruling K)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }, null, false, { executionBudgetMs: 60_000, waitBudgetMs: 2000 }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  // At this width the details open over the conversation, from the Turn's own button.
  const context = await isolatedContext(browser, { viewport: { width: 943, height: 900 } });
  // System notifications are recorded instead of shown, by a browser that allows them once asked (X04); the page's
  // visibility is the test's to say.
  await context.addInitScript(() => {
    const shown: { title: string; body: string; silent: boolean }[] = [], state = { permission: "default", hidden: false };
    Object.defineProperty(window, "__notices", { value: shown }); Object.defineProperty(window, "__hide", { value: (hidden: boolean) => { state.hidden = hidden; document.dispatchEvent(new Event("visibilitychange")); } });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.hidden ? "hidden" : "visible" });
    class Recorded { static get permission() { return state.permission; } static async requestPermission() { state.permission = "granted"; return "granted"; }
      onclick: (() => void) | null = null; constructor(title: string, options: { body?: string; silent?: boolean } = {}) { shown.push({ title, body: options.body ?? "", silent: options.silent ?? false }); } close() {} }
    Object.defineProperty(window, "Notification", { configurable: true, value: Recorded });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const hide = (hidden: boolean) => page.evaluate(value => (window as unknown as { __hide: (hidden: boolean) => void }).__hide(value), hidden);
  const notices = () => page.evaluate(() => (window as unknown as { __notices: { title: string; body: string; silent: boolean }[] }).__notices);
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const ask = async () => {
    await composer.fill("approve this"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect(page.getByRole("region", { name: "工具审批", exact: true })).toContainText("rm -rf build", { timeout: 15000 });
  };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await ask();
  // Nobody decides, and the page is out of sight: HarnessHub's wait budget runs out and the Runtime stops the Turn, which the
  // program settles as cancelled.
  await hide(true);
  const turn = log.locator(".assistant-message").last();
  await expect(turn).toHaveAttribute("data-run-status", "cancelled", { timeout: 15000 });
  const run = (await current()).runs.at(-1);
  assert.deepEqual([run.status, run.error?.code, run.cancelRequested], ["cancelled", "WAIT_EXPIRED", false]);
  // Notifications were never chosen, so nothing is shown; back in sight, the offer says the Turn was cancelled, never done.
  assert.deepEqual(await notices(), []);
  await hide(false);
  const offer = page.getByRole("dialog", { name: "这一轮在后台被取消了" });
  await expect(offer).toContainText("要在做完或需要你时用系统通知告诉你吗？");
  await offer.getByRole("button", { name: "开启通知", exact: true }).click(); await expect(offer).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Notification.permission)).toBe("granted");
  // The Turn keeps the contract's own words; the header's word is 已取消; nothing calls it the user's stop.
  await expect(turn.locator(".process-summary")).toContainText("已取消（等待你的决定超时）"); await expect(turn.locator(".process-summary")).not.toContainText("已停止");
  await expect(page.locator(".chat-page > header .status-pill")).toHaveText("Shared Agent 已取消");
  await turn.hover(); await turn.getByRole("button", { name: "执行详情", exact: true }).click();
  const facts = page.getByRole("complementary", { name: "详情栏" }).locator(".execution-details");
  await expect(facts.locator("dt", { hasText: "执行状态" }).locator("xpath=following-sibling::dd[1]")).toHaveText("已取消（等待你的决定超时）");
  await page.screenshot({ path: join(artifact, "runtime-cancelled.png"), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(page.getByRole("complementary", { name: "详情栏" })).toHaveCount(0);
  // Notifications on: a Turn the Runtime cancels out of sight is announced as a failure is, silently, titled with the Agent
  // and the contract's words unchanged, with nothing of the conversation.
  await ask(); await hide(true);
  await expect(log.locator(".assistant-message").last()).toHaveAttribute("data-run-status", "cancelled", { timeout: 15000 });
  await expect.poll(async () => (await notices()).length, { timeout: 15000 }).toBe(1);
  const [cancelled] = await notices();
  assert.equal(cancelled!.title, "Shared Agent 已取消（等待你的决定超时）"); assert.equal(cancelled!.silent, true); assert.match(cancelled!.body, /^用时 \d+ 秒$/u);
  await hide(false);
  // The user's own stop, out of sight as well, is not announced.
  await ask(); await hide(true); await page.keyboard.press("ControlOrMeta+Period");
  const last = log.locator(".assistant-message").last();
  await expect(last).toHaveAttribute("data-run-status", "cancelled", { timeout: 15000 }); await expect(last.locator(".process-summary")).toContainText("已停止");
  const stopped = (await current()).runs.at(-1);
  assert.equal(stopped.cancelRequested, true); assert.ok(!["RUN_TIMEOUT", "WAIT_EXPIRED", "OWNER_ENDED"].includes(stopped.error?.code), "the user stopped it: " + stopped.error?.code);
  assert.equal((await notices()).length, 1, "the user's own stop is not announced");
  await hide(false);
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
  await expect(log.locator(".response-status")).toHaveText("排队中：4 个对话正在执行，其中一个结束后自动开始", { timeout: 15000 });
  // Nothing of it has started, so the line under the composer counts no time for it, as the Turn's own line counts none.
  await expect(page.locator(".composer-status")).toHaveText("第 1 轮");
  // The header and the page's announcement name the state as the Turn does (ruling N).
  await expect(page.locator(".chat-page > header .status-pill")).toHaveText("Busy Agent 排队中"); await expect(page.locator(".chat-page > .sr-only[role=status]")).toHaveText("排队中");
  // So do the details: a Turn not started has no dot of work going on, and its facts say 排队中.
  await page.keyboard.press("ControlOrMeta+Backslash");
  const details = page.getByRole("complementary", { name: "详情栏" });
  await details.getByRole("tab", { name: "过程", exact: true }).click();
  const queuedRow = details.locator("ol > li > button").filter({ hasText: "第 1 轮" });
  await expect(queuedRow.locator(".status-dot")).toHaveAttribute("data-tone", "idle"); await expect(queuedRow.getByRole("img", { name: "排队中", exact: true })).toHaveCount(1);
  await details.getByRole("tab", { name: "执行", exact: true }).click();
  await expect(details.locator(".execution-details dt", { hasText: "执行状态" }).locator("xpath=following-sibling::dd[1]")).toHaveText("排队中");
  await page.keyboard.press("ControlOrMeta+Backslash"); await expect(details).toHaveCount(0);
  await expect(log.locator(".queued-turn small")).toHaveText("没有单独的等待期限，按发送先后轮到。");
  await expect(log.getByRole("button", { name: "打开那个对话", exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "slot-wait.png"), animations: "disabled" });
  await log.getByRole("button", { name: "取消排队", exact: true }).click();
  // The user cancelled it before it started: a stop of the user's, said 已停止 (ADR-054 decision H).
  await expect(log.locator("[data-run-status=cancelled]")).toContainText("已停止");
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
  await page.getByRole("button", { name: "Harness", exact: true }).click();
  // Frozen entries come last in "还可以安装", after its first rows.
  await page.getByRole("button", { name: /^显示全部/u }).click();
  const row = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 Gemini CLI 详情", exact: true }) });
  await row.getByRole("button", { name: "安装", exact: true }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("安装完成", { exact: true })).toBeVisible({ timeout: 30000 });
  // The detail: the version as a fact, next to the latest one; the recipe's "目录参考" version is gone with the hint.
  await expect(detail.getByText("当前版本", { exact: true }).locator("..")).toContainText("1.0.0");
  await expect(detail.getByText("最新版本", { exact: true })).toBeVisible();
  await sayNothing("the detail");
  await detail.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click();
  // The card: the version alone before its channel, with no mark beside it, like the Harness nothing was ever recorded for.
  await expect(row.locator(".agent-meta")).toHaveText(/^1\.0\.0 · /u); await expect(row.locator(".badge")).toHaveText(["冻结"]);
  const autohand = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 Autohand Code 详情", exact: true }) });
  await expect(autohand.locator(".badge")).toHaveCount(0);
  await sayNothing("the Harness list");
  await page.screenshot({ path: join(artifact, "version-fact.png"), animations: "disabled" });
  // The welcome's list of Agents (opened from its summary, ADR-054 §5) and the picker show the version the same way, as
  // the Agent page does (no "v" in front, Foundations board), and the Harness is chosen like any other. The Agent page has
  // no way back of its own (ADR-054 补充 D): the sidebar leads there.
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "新对话", exact: true }).click();
  await page.locator(".agent-summary").click();
  const card = page.getByRole("region", { name: "本机可用的 Harness" }).getByRole("button", { name: "选择 Gemini CLI", exact: true });
  await expect(card).toContainText(/(?<!v)1\.0\.0 · /u); await expect(card).not.toContainText("v1.0.0"); await expect(card.locator(".badge")).toHaveCount(0);
  await sayNothing("the welcome");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click();
  const option = page.getByRole("option", { name: "Gemini CLI", exact: true });
  await expect(option).toContainText("1.0.0"); await expect(option).not.toContainText("v1.0.0"); await expect(option).toBeEnabled();
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
  // The panel is closed until opened (ADR-054 decision E); without changes or a plan it opens on the Turn's execution facts.
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  const resume = page.getByRole("complementary", { name: "详情栏" }).getByLabel("在原程序中继续");
  // The identifier, the interactive command and its copy button: the fixture's Codex reports no version HarnessHub ever ran, and none is needed.
  await expect(resume.locator(".native-resume-row code")).toHaveText([/^browser-native-\d+$/u, /^codex resume browser-native-\d+$/u]);
  await expect(resume.locator(".native-resume-row small")).toHaveText(["原生会话 ID", "在该对话的工作区目录中运行"]);
  await expect(resume.getByRole("button", { name: "复制原生会话 ID", exact: true })).toBeVisible();
  await expect(resume.getByRole("button", { name: "复制恢复命令", exact: true })).toBeVisible();
  // The one-question form unfolds with its flag, since the fixture's workspace is no Git repository. Its line tints when
  // pointed at, like any row.
  await rowTint(page, resume.getByRole("button", { name: "只问一次", exact: true }));
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
  await openAdvanced(page);
  await page.getByRole("checkbox", { name: "保持原生进程" }).click(); await page.keyboard.press("Escape");
  await composer.fill("first"); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  await openAdvanced(page);
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
  // In another conversation, the waiting one leads its project in the sidebar (ADR-054 §5 groups by project, no longer by
  // state), and the inbox lists it with whose deadline applies.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  const group = page.locator(".session-group").first();
  await expect(group.locator(".session-item").first()).toHaveAccessibleDescription(/等你处理/u); await expect(group.locator(".session-item")).toHaveCount(1);
  await page.getByRole("button", { name: /^等你处理（1 项）$/u }).click();
  const inbox = page.locator(".inbox-pop");
  await expect(inbox).toContainText("approve this"); await expect(inbox).toContainText(/等你批准 · 等待期限 剩余 \d+ 分/u);
  await expect(inbox.getByRole("button", { name: "待处理时通知我", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(inbox).toHaveCSS("opacity", "1"); await page.screenshot({ path: join(artifact, "inbox.png"), animations: "disabled" });
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
  await expect(page.locator(".session-group").first().locator(".session-item").first()).not.toHaveAccessibleDescription(/等你处理/u);
  await expect(page.locator(".session-item.has-attention")).toHaveCount(0);
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
  // D04: the panel stays closed and its button carries the number. The number pops in as news, when changes come while the
  // conversation is shown; brought back by closing the panel, here from the keyboard (#37), it is simply there.
  const button = page.getByRole("button", { name: "详情栏", exact: true });
  const pop = () => button.evaluate(element => [...element.querySelectorAll(":scope > span")].map(span => getComputedStyle(span).animationName).join());
  await expect(button).toHaveText("1"); assert.match(await pop(), /hh-pop-in/u, "a change made in view pops the number in");
  await page.keyboard.press("ControlOrMeta+\\"); await expect(button).toHaveAttribute("aria-pressed", "true"); await expect(button).toHaveText("");
  await page.keyboard.press("ControlOrMeta+\\"); await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toHaveText("1"); assert.equal(await pop(), "none", "closing the panel brings the number back without motion");
  const summary = log.locator(".process-summary");
  await expect(summary).toHaveText(/^改了 1 处，运行 1 条命令 · [0-9.]+ 秒$/u); await expect(summary).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("list", { name: "工具活动" })).toHaveCount(0);
  // The density is the "…" menu's checkable 显示每一步, checked for every step (ruling R1); the header has no 简洁 or 详细.
  const header = page.locator(".chat-page > header"), more = header.getByRole("button", { name: "更多操作", exact: true });
  const everyStep = page.getByRole("menuitemcheckbox", { name: "显示每一步", exact: true });
  await expect(header.getByRole("button", { name: /^(简洁|详细)$/u })).toHaveCount(0);
  await more.click(); await expect(everyStep).toHaveAttribute("aria-checked", "false"); await everyStep.click();
  await expect(everyStep).toHaveCount(0);
  await expect(log.getByRole("list", { name: "工具活动" })).toBeVisible();
  await page.reload();
  await more.click(); await expect(everyStep).toHaveAttribute("aria-checked", "true");
  await expect(log.getByRole("list", { name: "工具活动" })).toBeVisible();
  await everyStep.click();
  await expect(log.getByRole("list", { name: "工具活动" })).toHaveCount(0);
  // D04 (ADR-054 decision E): wide enough for the panel beside the conversation, it still stays closed, changes or not; its
  // button carries the number of changes, said in full to a screen reader. A page drawn again in the compact density reads
  // no tool detail while the panel is closed.
  const panel = page.getByRole("complementary", { name: "详情栏" });
  const origin = new URL(fixture.gateway.url).origin, id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session");
  const details = ((await (await context.request.get(origin + "/api/v1/sessions/" + id)).json()).runs as { tools?: { detail?: { id: string } }[] }[]).flatMap(run => (run.tools ?? []).flatMap(tool => tool.detail ? [tool.detail.id] : []));
  assert.ok(details.length > 0, "the fixture's tools carry stored detail");
  const reads: string[] = [];
  page.on("request", request => { if (details.some(content => request.url().includes("/api/v1/content/" + encodeURIComponent(content)))) reads.push(request.url()); });
  await page.reload(); await expect(log).toContainText("原生活动已完成。");
  await expect(panel).toHaveCount(0); await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toHaveText("1"); await expect(button).toHaveAccessibleDescription("本对话改动 1 处");
  assert.equal(await pop(), "none", "drawn with the conversation, the number is simply there");
  await page.waitForTimeout(500); assert.deepEqual(reads, [], "no tool detail is read while the panel is closed");
  // Opened, it shows the conversation's changes, read-only. The 改动 tab and its scope say the button's number at once, from
  // the same facts, before any diff is read; the file comes with the read.
  let release!: () => void; const held = new Promise<void>(done => { release = done; });
  await page.route("**/api/v1/content/**", async route => { await held; await route.continue(); });
  await button.click();
  await expect(panel.getByRole("tab", { name: /改动/u })).toHaveText("改动1"); await expect(panel.getByRole("tab", { name: /改动/u })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("radio", { name: "整个对话 1", exact: true })).toHaveAttribute("aria-checked", "true"); await expect(panel).not.toContainText("README.md");
  release();
  await expect(panel).toContainText("README.md"); assert.ok(reads.length > 0, "opened, the panel reads the diffs");
  // Opening it was the user's choice, which this browser keeps.
  await page.reload(); await expect(panel).toBeVisible(); await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(panel.locator(".native-diff .is-add")).toContainText("新内容"); await expect(panel.locator(".native-diff .is-remove")).toContainText("旧内容");
  await expect(panel.getByRole("button", { name: /撤销|还原|revert/iu })).toHaveCount(0);
  await panel.getByRole("tab", { name: /过程/u }).click();
  await expect(panel).toContainText("收到消息"); await expect(panel.getByRole("list", { name: "工具活动" })).toContainText("ls -la");
  await panel.getByRole("tab", { name: /计划/u }).click(); await expect(panel).toContainText("Codex 维护的计划 · 1 / 2 完成");
  await panel.getByRole("tab", { name: /执行/u }).click(); await expect(panel).toContainText("本轮用量"); await expect(panel.getByRole("button", { name: "复制诊断信息", exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "details-panel.png"), animations: "disabled" });
  await page.getByRole("button", { name: "详情栏", exact: true }).click(); await expect(panel).toHaveCount(0);
  // Narrower, the panel opens over the conversation and closes back to it.
  await page.setViewportSize({ width: 943, height: 900 });
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("本轮用量");
  await page.getByRole("button", { name: "关闭详情栏", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  // On a phone the menu offers 显示每一步 as well (ruling R1: at every width).
  await more.click(); await expect(everyStep).toBeVisible(); await expect(everyStep).toHaveAttribute("aria-checked", "false"); await page.keyboard.press("Escape");
  // At 320 the whole menu stays on the screen: its footer wraps rather than push the menu past the edge.
  await page.setViewportSize({ width: 320, height: 844 });
  await more.click(); await expect(everyStep).toBeVisible();
  await expect.poll(async () => { const box = await page.getByRole("menu").boundingBox(); return box !== null && box.x >= 0 && box.x + box.width <= 320; }, { message: "the … menu fits a 320 px screen" }).toBe(true);
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "详情栏", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "the details sheet must not overflow a narrow screen");
  await page.screenshot({ path: join(artifact, "details-sheet-390.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-DL4 each reply names its Agent, model and thinking level, a hand-over is a hairline with a pill, and the process opens from one line to steps to raw output", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const pick = async (label: string, value: string) => { await page.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  await pick("选择 Harness", "Codex"); await expect(page.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
  await pick("选择模型", "Native B"); await expect(page.getByRole("button", { name: "思考强度", exact: true })).toBeEnabled(); await pick("思考强度", "高");
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  const first = log.locator(".assistant-message").first();
  // C03: every reply starts with who answered (the Agent's own mark, 24 px), its name, the model and the thinking level.
  await expect(first).toHaveAttribute("aria-label", "Codex 的回复");
  const mark = await first.locator(".brand-tile").first().boundingBox(); assert.ok(mark && Math.round(mark.width) === 24 && Math.round(mark.height) === 24, "the Agent mark is 24 px");
  await expect(first.getByText("Native B · 思考 高", { exact: true })).toBeVisible();
  // C04: the process is one line once the Turn ended, counting each kind of step and the total time; failures would be counted in it.
  const summary = first.locator(".process-summary");
  await expect(summary).toHaveAttribute("aria-expanded", "false"); await expect(summary).toHaveText(/^改了 1 处，运行 1 条命令 · [0-9.]+ 秒$/u);
  await expect(first.getByRole("list", { name: "工具活动" })).toHaveCount(0);
  // It is one line where it fits, the chevron right after the words: the words never wrap at the width of those they replaced.
  assert.deepEqual(await summary.evaluate(element => { const words = element.querySelector(".swap-text")!.getBoundingClientRect(), chevron = element.querySelector(":scope > svg")!.getBoundingClientRect();
    return [element.getBoundingClientRect().height <= 28, chevron.left - words.right <= 8]; }), [true, true], "the folded line is one line with its chevron after the words");
  // The line is the steps' button from the keyboard too: Enter and Space open and close them.
  await expect(summary).toHaveAttribute("role", "button");
  await summary.focus(); await page.keyboard.press("Enter"); await expect(summary).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press(" "); await expect(summary).toHaveAttribute("aria-expanded", "false");
  // C05: opened, each step says its verb and what it acted on; the edit counts its lines, the command gives its exit code.
  await summary.click(); await expect(summary).toHaveAttribute("aria-expanded", "true");
  const steps = first.getByRole("list", { name: "工具活动" });
  await expect(steps.locator(":scope > li")).toHaveCount(2);
  const command = steps.locator(":scope > li").filter({ hasText: "ls -la" }), edit = steps.locator(":scope > li").filter({ hasText: "README.md" });
  await expect(command).toContainText("运行"); await expect(command).toContainText("退出码 0");
  await expect(edit).toContainText("修改"); await expect(edit).toContainText("+1"); await expect(edit).toContainText("−1");
  // Consecutive reads are grouped into one step (no fixture reads twice in a row; tests/unit/web-turn.test.ts proves the grouping).
  // The third layer: a step opens to the raw input and output the program reported.
  await command.getByRole("button", { name: /ls -la/u }).click();
  const raw = command.locator(".native-tool-detail");
  await expect(raw.locator("pre").first()).toHaveText("ls -la"); await expect(raw).toContainText("输出"); await expect(raw).toContainText("README.md");
  // A step that opens tints when pointed at (Motion board #30: its background, 120 ms on the standard curve) and untints when
  // left; from the keyboard its focus ring is the row's, 2 px inside its edge.
  const editRow = edit.getByRole("button", { name: /修改 README\.md/u }), tint = () => editRow.evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(await tint(), "rgba(0, 0, 0, 0)");
  await editRow.hover(); await expect.poll(tint).toBe("rgb(244, 245, 247)");
  assert.deepEqual(await editRow.evaluate(element => { const style = getComputedStyle(element); return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction]; }),
    ["background-color", "0.12s", "cubic-bezier(0.2, 0, 0, 1)"]);
  await page.mouse.move(2, 2); await expect.poll(tint).toBe("rgba(0, 0, 0, 0)");
  await page.keyboard.press("Shift"); await editRow.focus();
  assert.deepEqual(await editRow.evaluate(element => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth, style.outlineOffset]; }), [true, "solid", "2px", "-2px"]);
  await editRow.blur();
  await page.screenshot({ path: join(artifact, "dl4-turn-light-1440.png"), animations: "disabled" });
  // D02: the details tabs are 改动 (with the number of changes, the button's), 计划, 过程, 后台 and 执行; the underline sits under
  // the chosen tab. The panel is closed until opened (decision E).
  const panel = page.getByRole("complementary", { name: "详情栏" });
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
  await expect(panel.getByRole("tab")).toHaveText(["改动1", "计划", "过程", "后台", "执行"]);
  for (const [name, file] of [["计划", "plan"], ["过程", "process"], ["后台", "background"], ["改动", "changes"]] as const) {
    const tab = panel.getByRole("tab", { name: new RegExp("^" + name, "u") });
    await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => panel.locator(".tabs-indicator").evaluate(indicator => { const chosen = indicator.parentElement!.querySelector<HTMLElement>("[aria-selected=true]")!;
      return Math.abs(indicator.getBoundingClientRect().left - chosen.getBoundingClientRect().left) < 1 && Math.abs(indicator.getBoundingClientRect().width - chosen.getBoundingClientRect().width) < 1; })).toBe(true);
    await page.screenshot({ path: join(artifact, `dl4-panel-${file}-light-1440.png`), animations: "disabled" });
  }
  // D03: the changes of this Turn or of the whole conversation, each file with its lines, the diff read-only and from its Agent.
  await expect(panel.getByRole("radio", { name: "整个对话 1", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(panel.getByRole("button", { name: /README\.md/u })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("region", { name: /^差异：/u })).toContainText("只读 · 来自 Codex");
  // C08: switching the model takes effect between Turns and marks the place: a hairline with the pill in the middle.
  await pick("选择模型", "Native A");
  await expect.poll(async () => { const value = await current(); return value.pendingSwitchId === null && value.selection.nativeModel === "native-a"; }).toBe(true);
  // The same Agent with another model says "改用" and the new choice in the words of a Turn's identity line (the model alone:
  // the change keeps no thinking level of its own); the pill shows the Agent's mark, without the arrow of a hand-over.
  const handover = log.getByRole("separator", { name: "从这里起改用 Native A", exact: true });
  await expect(handover).toBeVisible(); await expect(handover).toHaveText("从这里起改用 Native A");
  await expect(handover.locator(".brand-tile")).toHaveCount(1); await expect(handover.locator("path[pathLength]")).toHaveCount(0);
  const pill = await handover.evaluate(element => { const pill = element.querySelector(":scope > span:nth-child(2)") as HTMLElement, line = element.firstElementChild as HTMLElement;
    return { radius: getComputedStyle(pill).borderRadius, height: pill.getBoundingClientRect().height, line: line.getBoundingClientRect().height, shadow: getComputedStyle(pill).boxShadow }; });
  assert.ok(pill.radius.startsWith("3.35544e+07") || parseFloat(pill.radius) >= 15, "the pill is round: " + pill.radius);
  assert.equal(Math.round(pill.height), 30); assert.ok(pill.line <= 1, "the line is a hairline: " + pill.line); assert.match(pill.shadow, /0px 0px 0px 0\.5px/u);
  await composer.fill("第二轮"); await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(2);
  await expect(log.locator(".assistant-message").last()).toContainText("已由", { timeout: 15000 });
  await expect(log.locator(".assistant-message").last().getByText(/^Native A/u)).toBeVisible();
  // The conversation keeps its identity across the hand-over: one conversation, both Turns in it.
  const after = await current(); assert.equal(after.runs.length, 2); assert.equal(after.runs[0].selection.nativeModel, "native-b"); assert.equal(after.runs[1].selection.nativeModel, "native-a");
  assert.equal((await (await context.request.get(origin + "/api/v1/sessions")).json()).length, 1);
  await expect(log.locator(".assistant-message").last()).toHaveAttribute("data-run-status", "completed");
  // The latest Turn changed nothing: "本轮" says so, "整个对话" still lists the file; 过程 lists both Turns, oldest first.
  await panel.getByRole("radio", { name: "本轮 0", exact: true }).click(); await expect(panel).toContainText("这一轮没有改动文件。");
  await panel.getByRole("radio", { name: "整个对话 1", exact: true }).click(); await expect(panel.getByRole("button", { name: /README\.md/u })).toBeVisible();
  await panel.getByRole("tab", { name: /^过程/u }).click();
  await expect(panel).toContainText("这个对话的全部步骤，按时间排列");
  await expect(panel.getByRole("button", { name: /第 1 轮/u })).toContainText("修改 1 · 运行 1"); await expect(panel.getByRole("button", { name: /第 2 轮/u })).toHaveAttribute("aria-expanded", "true");
  // A Turn's line opens its steps and, pointed at, tints like any row.
  await rowTint(page, panel.getByRole("button", { name: /第 1 轮/u }));
  await page.screenshot({ path: join(artifact, "dl4-handover-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(artifact, "dl4-handover-dark-1440.png"), animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the Turns fit " + width + " px");
    await page.screenshot({ path: join(artifact, `dl4-dark-${width}.png`), animations: "disabled" });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(artifact, "dl4-light-320.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-DL7 a running Turn shows the arc, the swept words and a timer every second, streamed text comes in at a steady pace, and the end hands over to 已完成; reduced motion keeps only short fades", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), origin = new URL(fixture.gateway.url).origin;
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  async function step(stage: string) {
    const pending = join(fixture.root, "workspace", "next-stream-control.json"), target = join(fixture.root, "workspace", "stream-control.json");
    await writeFile(pending, JSON.stringify({ stage })); await rename(pending, target);
  }
  // Records, in the page, how much of the last reply is shown while it streams: the shown and committed lengths and the fading
  // pieces, from now until `settle` ms after more text was committed (at most 8 s, so a slow machine still sees it arrive).
  const record = (settle: number) => page.evaluate(async after => {
    const samples: [number, number, number][] = [];
    let end = performance.now() + 8000, first: number | null = null, token: string[] | null = null;
    while (performance.now() < end) {
      const reply = [...document.querySelectorAll(".assistant-message")].at(-1)?.querySelector<HTMLElement>(".markdown.text-reading");
      if (reply) {
        const pieces = reply.querySelectorAll(".motion-token");
        samples.push([Number(reply.dataset.shown), Number(reply.dataset.committed), pieces.length]);
        if (pieces.length && token === null) { const style = getComputedStyle(pieces[0]!); token = [style.animationName, style.animationDuration, style.animationTimingFunction]; }
        first ??= samples[0]![1];
        if (samples.at(-1)![1] > first && end > performance.now() + after) end = performance.now() + after;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { samples, token };
  }, settle);
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  // The Turn is drawn once: its process line is held from the moment it appears, before the reply has any text. Until
  // then the conversation the first message creates is never shown as empty and ready for one.
  await page.evaluate(() => {
    const probe: { line: Element | null; textless: boolean; ready: boolean } = { line: null, textless: false, ready: false };
    (window as unknown as { __turnLine: typeof probe }).__turnLine = probe;
    const observer = new MutationObserver(() => {
      probe.ready ||= [...document.querySelectorAll("[role=log] h2")].some(node => node.textContent === "对话准备好了");
      const line = document.querySelector("[role=log] .assistant-message .turn-process");
      if (line === null) return;
      probe.line = line; probe.textless = line.closest(".assistant-message")!.querySelector(".markdown") === null; observer.disconnect();
    });
    observer.observe(document.body, { subtree: true, childList: true });
  });
  await composer.fill("STREAM_RENDER：动效验收"); await composer.press("Enter");
  const turn = log.locator(".assistant-message").last(), row = turn.locator(".process-summary"), reply = turn.locator(".markdown.text-reading");
  await expect(turn).toContainText("第一段已经到达。");
  // When the reply's first text came (the Runtime creates its message then), the same line is still in the page: not drawn anew.
  assert.deepEqual(await page.evaluate(() => { const probe = (window as unknown as { __turnLine: { line: Element | null; textless: boolean } }).__turnLine;
    return [probe.textless, probe.line?.isConnected ?? null, probe.line === [...document.querySelectorAll("[role=log] .assistant-message .turn-process")].at(-1)]; }),
    [true, true, true], "the Turn keeps its element as its reply starts");
  assert.equal(await page.evaluate(() => (window as unknown as { __turnLine: { ready: boolean } }).__turnLine.ready), false, "the new conversation is not shown as empty while its first message is on its way");
  // #10: the first piece arrived as more than 120 characters at once, so it is shown at once, without fading pieces.
  await expect.poll(() => reply.evaluate(element => element.dataset.shown === element.dataset.committed)).toBe(true);
  await expect(reply.locator(".motion-token")).toHaveCount(0);
  // #01 #02: the arc turns once every 0.8 s and a soft band sweeps the words every 4 s after waiting 0.6 s.
  await expect(row.locator(".shimmer-text")).toHaveText("正在回复");
  assert.equal(await row.locator(".spinner").evaluate(element => getComputedStyle(element).animationDuration), "0.8s");
  assert.deepEqual(await row.locator(".shimmer-text").evaluate(element => { const style = getComputedStyle(element); return [style.animationName, style.animationDuration, style.animationDelay]; }), ["hh-shimmer", "4s", "0.6s"]);
  // #07: the words slide their width, so the timer after them glides instead of jumping.
  assert.deepEqual(await row.locator(".swap-text").evaluate(element => [getComputedStyle(element).transitionProperty, getComputedStyle(element).transitionDuration]), ["width", "0.18s"]);
  // #03: the timer counts every second in tabular figures.
  const timer = row.getByText(/^· 已用 \d+ 秒$/u), before = await timer.textContent();
  await expect(timer).not.toHaveText(before ?? "", { timeout: 3000 });
  assert.equal(await timer.evaluate(element => getComputedStyle(element).fontVariantNumeric), "tabular-nums");
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifact, "dl7-running-light-1440.png"), animations: "disabled" });
  // #08 #09: about 70 committed characters come in over the next second as a growing prefix, each piece fading in over 700 ms.
  const sampling = record(1800);
  await step("second");
  const { samples, token } = await sampling, grown = samples.filter(([, committed]) => committed > samples[0]![1]);
  assert.ok(grown.length > 0, "the second piece arrived while recording");
  assert.ok(samples.every(([shown, committed], index) => shown <= committed && (index === 0 || shown >= samples[index - 1]![0])), "what is shown only grows and never passes what was committed");
  assert.ok(grown.some(([shown, committed]) => shown < committed), "the new text is released over time, not at once");
  assert.ok(grown.some(([, , pieces]) => pieces > 1), "released pieces fade in one by one");
  assert.deepEqual(grown.at(-1)!.slice(0, 2), [grown.at(-1)![1], grown.at(-1)![1]], "it caught up with the committed text");
  assert.deepEqual(token, ["hh-fade-in", "0.7s", "cubic-bezier(0.37, 0.55, 0.86, 0.88)"], "each piece fades in over 700 ms on the token curve");
  // #11: the 7 px dot at the end of the text breathes while it is written.
  await expect(reply).toHaveClass(/caret-host/u);
  assert.deepEqual(await reply.evaluate(element => { const style = getComputedStyle(element.querySelector(":scope > p:last-of-type")!, "::after"); return [style.width, style.animationName, style.animationDuration]; }), ["7px", "hh-end-dot", "1.25s"]);
  // #12: at the end the arc and the words leave first, and "已完成" arrives 0.21 s later in the same place.
  const handover = page.evaluate(() => new Promise<{ depart: boolean; together: boolean; delay: string | null; words: string[] }>(resolve => {
    const target = [...document.querySelectorAll(".assistant-message")].at(-1)!.querySelector(".process-summary")!;
    const seen = { depart: false, together: false, delay: null as string | null, words: [] as string[] };
    const look = () => {
      const depart = target.querySelector(".motion-depart"), arrive = target.querySelector(".motion-arrive");
      if (depart) seen.depart = true;
      if (depart && arrive) seen.together = true;
      if (arrive && seen.delay === null) seen.delay = getComputedStyle(arrive).animationDelay;
      const text = (target.textContent ?? "").trim(); if (text && seen.words.at(-1) !== text) seen.words.push(text);
    };
    const observer = new MutationObserver(look); observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(() => { observer.disconnect(); look(); resolve(seen); }, 3000);
  }));
  await step("finish");
  const seen = await handover;
  assert.ok(seen.depart && seen.together, "the running layer leaves while the finished one arrives in its place: " + JSON.stringify(seen));
  assert.equal(seen.delay, "0.21s");
  assert.match(seen.words.at(-1)!, /^已完成 · 用时 [0-9.]+ 秒$/u);
  // The timer stops when the Run ends: while the last words are shown and the line hands over, it never passes the total.
  const total = Number(/用时 ([0-9.]+) 秒$/u.exec(seen.words.at(-1)!)![1]);
  assert.ok(seen.words.every(words => { const shown = /已用 (\d+) 秒/u.exec(words); return !shown || Number(shown[1]) <= total; }), "the timer never passes the total: " + JSON.stringify(seen.words));
  await expect(turn).toHaveAttribute("data-run-status", "completed");
  await expect(row.locator(".spinner")).toHaveCount(0); await expect(row.locator(".motion-depart")).toHaveCount(0);
  // The finished line is one line where it fits (its words keep their own width, not one rounded down from the box).
  await expect.poll(() => row.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(28);
  // The dot fades out once the text is written, and the fading pieces give way to plain text: the text itself never changed.
  await expect(reply).not.toHaveClass(/caret-host/u); await expect(reply.locator(".motion-token")).toHaveCount(0);
  const shownText = (await reply.textContent()) ?? "";
  assert.ok(shownText.indexOf("第一段已经到达。") < shownText.indexOf("第二段正在生成。") && shownText.indexOf("第二段正在生成。") < shownText.indexOf("第三段完成。"), "the committed order is kept");
  assert.equal(await reply.evaluate(element => element.dataset.shown === element.dataset.committed), true);
  const message = (await current()).messages.at(-1); assert.equal(Number(await reply.getAttribute("data-committed")), message.text.length, "every committed character is shown");
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifact, "dl7-done-light-1440.png"), animations: "disabled" });
  // #38: with reduced motion the arc is a still dot, the words do not sweep, and replies show as they arrive.
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await composer.fill("STREAM_RENDER：减少动态效果"); await composer.press("Enter");
  await expect(log.locator(".assistant-message")).toHaveCount(2);
  const still = log.locator(".assistant-message").nth(1);
  await expect(still).toHaveAttribute("data-run-status", "running"); await expect(still).toContainText("第一段已经到达。");
  assert.deepEqual(await still.locator(".process-summary").evaluate(target => {
    const spinner = target.querySelector(".spinner")!, words = target.querySelector(".shimmer-text")!;
    return [getComputedStyle(spinner).animationName, getComputedStyle(spinner.querySelector(".spinner-arc")!).display, getComputedStyle(words).animationName, getComputedStyle(words).backgroundImage];
  }), ["none", "none", "none", "none"]);
  const instant = record(600);
  await step("second");
  const recorded = (await instant).samples, quiet = recorded.filter(([, committed]) => committed > recorded[0]![1]);
  assert.ok(quiet.length > 0 && quiet.every(([shown, committed, pieces]) => shown === committed && pieces === 0), "with reduced motion the text shows as it arrives, without fading pieces: " + JSON.stringify(recorded));
  // Nothing moves, scales, blurs or loops: what animates is a fade of 150 ms or less, once.
  const moving = await still.evaluate(element => [element, ...element.querySelectorAll("*")].flatMap(node => {
    const style = getComputedStyle(node), seconds = (value: string) => value.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? .001 : 1));
    const animated = style.animationName !== "none" && seconds(style.animationDuration).some(value => value > .15 || style.animationIterationCount === "infinite");
    const moved = seconds(style.transitionDuration).some(value => value > .15) || seconds(style.transitionDuration).some(value => value > 0) && /transform|translate|scale|rotate|filter|width/u.test(style.transitionProperty);
    return animated || moved ? [node.className + " " + style.animationName + " " + style.transitionProperty] : [];
  }));
  assert.deepEqual(moving, []);
  await still.locator(".process-summary").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifact, "dl7-reduced-dark-1440.png"), animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "a running Turn fits " + width + " px");
    await still.locator(".process-summary").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(artifact, `dl7-running-dark-${width}.png`), animations: "disabled" });
  }
  await step("finish"); await expect(still).toHaveAttribute("data-run-status", "completed");
  assert.deepEqual(errors, []);
});

test("G054-DL7 an end dot on its own line after a code block closes that line as it fades, so the end of a reply does not jump and following the latest keeps the bottom; reduced motion lets it go at once, and history shows no dot (ruling L)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 700 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const step = async (stage: string) => {
    const pending = join(fixture.root, "workspace", "next-stream-control.json"), target = join(fixture.root, "workspace", "stream-control.json");
    await writeFile(pending, JSON.stringify({ stage })); await rename(pending, target);
  };
  // Every frame from the finish until the dot is gone: the room the reply keeps under its last block (the dot's line), how
  // far the page is from its bottom, whether the reply is done (data-done) or still holds the dot, and the height of the
  // code block above it; whether "回到最新" showed, and the dot line's transition.
  const watchEnd = () => page.evaluate(() => new Promise<{ frames: [number, number, boolean, boolean, number][]; follow: boolean; transition: string | null }>(resolve => {
    const reply = [...document.querySelectorAll(".assistant-message")].at(-1)!.querySelector<HTMLElement>(".markdown.text-reading")!, scroller = document.querySelector<HTMLElement>(".chat-scroll")!;
    const frames: [number, number, boolean, boolean, number][] = [];
    let follow = false, transition: string | null = null, until = Number.POSITIVE_INFINITY;
    reply.addEventListener("transitionrun", event => {
      if ((event as TransitionEvent).pseudoElement === "::after" && (event as TransitionEvent).propertyName === "height") { const style = getComputedStyle(reply, "::after"); transition = style.transitionDuration + " " + style.transitionTimingFunction; }
    });
    const stop = setTimeout(() => resolve({ frames, follow, transition }), 8000);
    const frame = () => {
      frames.push([reply.getBoundingClientRect().bottom - reply.lastElementChild!.getBoundingClientRect().bottom, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, reply.hasAttribute("data-done"), reply.classList.contains("caret-host"),
        reply.querySelector(".code-block")!.getBoundingClientRect().height]);
      if (document.querySelector(".follow-stream")) follow = true;
      if (!reply.classList.contains("caret-host") && until === Number.POSITIVE_INFINITY) until = performance.now() + 300;
      if (performance.now() > until) { clearTimeout(stop); resolve({ frames, follow, transition }); return; }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  /** The frames while the reply's dot was going: from the last frame before it was done to the end. */
  const closing = (frames: readonly [number, number, boolean, boolean, number][]) => { const first = frames.findIndex(([, , done]) => done); assert.ok(first > 0, "the reply was seen being written, then done"); return frames.slice(first - 1); };
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("STREAM_BLOCK：以代码块结尾"); await composer.press("Enter");
  const turn = log.locator(".assistant-message").last(), reply = turn.locator(".markdown.text-reading");
  await expect(reply.locator(".code-block")).toContainText("pnpm test", { timeout: 15000 });
  // While it is written the dot stands on a line of its own under the code block: a block one line (26 px) high.
  await expect(reply).toHaveClass(/caret-host/u);
  assert.deepEqual(await reply.evaluate(element => { const style = getComputedStyle(element, "::after"); return [style.content, style.display, style.height, style.width, style.animationName]; }), ['""', "block", "26px", "7px", "hh-end-dot"]);
  // The conversation is longer than the window and follows the latest reply.
  await expect.poll(() => page.locator(".chat-scroll").evaluate(element => element.scrollHeight > element.clientHeight + 200 && element.scrollHeight - element.scrollTop - element.clientHeight < 2)).toBe(true);
  const ending = watchEnd(); await step("finish"); const seen = await ending;
  await expect(turn).toHaveAttribute("data-run-status", "completed");
  const going = closing(seen.frames), lines = going.map(([line]) => line);
  // The dot's line closes with its fade: from 26 px to nothing in 200 ms on the fade's curve, through the frames between,
  // never at once, and only closing.
  assert.ok(Math.abs(lines[0]! - 26) <= .5 && Math.abs(lines.at(-1)!) <= .5, "the dot's line closes: " + JSON.stringify(lines));
  assert.ok(lines.filter(line => line < 25.5 && line > .5).length >= 2, "the reply's end moves over several frames: " + JSON.stringify(lines));
  assert.ok(lines.every((line, index) => index === 0 || line <= lines[index - 1]! + .01), "it only closes: " + JSON.stringify(lines));
  assert.equal(seen.transition, "0.2s, 0.2s cubic-bezier(0.2, 0, 0, 1), cubic-bezier(0.2, 0, 0, 1)");
  // Nothing else moves at the end either: the code block keeps its height while its closing fence comes in, released whole,
  // never shown for a moment as one more line of code.
  assert.ok(seen.frames.every(([, , , , code]) => code === seen.frames[0]![4]), "the code block keeps its height: " + JSON.stringify(seen.frames.map(frame => frame[4])));
  // Following the latest is kept: the page stays at its bottom in every frame from the finish, and "回到最新" never shows.
  assert.ok(seen.frames.every(([, gap]) => gap < 2), "the page stays at its bottom: " + JSON.stringify(seen.frames.map(([, gap]) => gap)));
  assert.equal(seen.follow, false); await expect(page.getByRole("button", { name: "回到最新回复", exact: true })).toHaveCount(0);
  await expect(reply).not.toHaveClass(/caret-host/u); assert.equal(await reply.evaluate(element => getComputedStyle(element, "::after").content), "none");
  await page.screenshot({ path: join(artifact, "dl7-end-dot-closed-light-1440.png"), animations: "disabled" });
  // With reduced motion the dot and its line go at once: the reply ends where it ends in one step.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await composer.fill("STREAM_BLOCK：减少动态效果"); await composer.press("Enter");
  const calm = log.locator(".assistant-message").last().locator(".markdown.text-reading");
  await expect(log.locator(".assistant-message")).toHaveCount(2); await expect(calm.locator(".code-block")).toContainText("pnpm test", { timeout: 15000 });
  await expect(calm).toHaveClass(/caret-host/u);
  await expect.poll(() => page.locator(".chat-scroll").evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2)).toBe(true);
  const sudden = watchEnd(); await step("finish"); const instant = await sudden;
  const quick = closing(instant.frames).map(([line]) => line);
  assert.ok(Math.abs(quick[0]! - 26) <= .5 && quick.slice(1).every(line => Math.abs(line) <= .5), "with reduced motion the line goes at once: " + JSON.stringify(quick));
  assert.ok(closing(instant.frames).every(([, gap]) => gap < 2), "the page stays at its bottom"); assert.equal(instant.follow, false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Drawn from history, a reply never shows the dot.
  await page.reload(); await expect(log.locator(".assistant-message")).toHaveCount(2);
  await expect(log.locator(".markdown.text-reading")).toHaveCount(2); await expect(log.locator(".caret-host, [data-done]")).toHaveCount(0);
  assert.deepEqual(await log.locator(".markdown.text-reading").evaluateAll(elements => elements.map(element => getComputedStyle(element, "::after").content)), ["none", "none"]);
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
  // "Codex Policy" is a Codex whose configuration sets an approval policy, which the composer shows at its bottom left.
  const fixture = await launchFixture(false, null, { name: "Codex Policy", scenario: "permissions-settings" }); let browser: Browser | null = null;
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
  const greeting = page.getByRole("heading", { name: "今天想让哪个 Harness 做什么？", exact: true });
  await expect(greeting).toBeVisible();
  assert.deepEqual(await greeting.evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; }), ["32px", "42px", "500"]);
  // H06: the first time, three steps with nothing to fill in: what was found, where it works, a first question.
  const steps = page.getByRole("list", { name: "开始使用" }).getByRole("listitem");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText(/找到了 \d+ 个 Harness/u); await expect(steps.nth(1)).toContainText("选一个项目文件夹"); await expect(steps.nth(1)).toContainText("/workspace");
  await expect(steps.nth(2)).toContainText("讲讲这个项目的结构");
  await shoot("dl3-first");
  // What was found opens the list of Agents; pointed at, it tints a shade darker than the step it sits on.
  await rowTint(page, steps.nth(0).getByRole("button", { name: /^查看找到的 \d+ 个 Harness$/u }), "rgb(235, 237, 240)");
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
  await page.waitForTimeout(200);
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `dl3-agents-${scheme}-1440.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("option", { name: "Codex", exact: true }).click();
  await expect(chip.locator(".brand-tile[data-brand='codex']")).toBeVisible(); await expect(chip).toContainText("Codex");
  await expect(composer).toHaveAttribute("placeholder", /^让 Codex 做什么？/u);
  await chip.getByRole("button", { name: "选择模型", exact: true }).click(); await page.getByRole("option", { name: "Native B", exact: true }).click();
  await expect(chip.getByRole("button", { name: "选择模型", exact: true })).toHaveText("Native B");
  const thinking = chip.getByRole("button", { name: "思考强度", exact: true });
  await thinking.click(); await page.getByRole("option", { name: "高", exact: true }).click(); await expect(thinking).toHaveText("思考 高");
  await shoot("dl3-picker");
  // At phone widths the model gives way (an ellipsis) before the Agent's name and the pill: nothing of the merged picker is
  // cut off or scrolls.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await chip.evaluate(element => element.scrollWidth <= element.clientWidth), `the merged picker fits at ${width}`);
    assert.ok(await chip.getByRole("button", { name: "选择 Harness", exact: true }).locator("span.truncate").evaluate(element => element.scrollWidth <= element.clientWidth), `the Agent keeps its name at ${width}`);
    const [whole, pill, chevron] = await Promise.all([chip.boundingBox(), thinking.boundingBox(), chip.locator("svg.lucide-chevron-down").boundingBox()]);
    assert.ok(whole && pill && chevron && pill.x >= whole.x && chevron.x + chevron.width <= whole.x + whole.width, `its pill and chevron show whole at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  // After a first conversation, a new one shows the summary: who is ready, the workspace by its folder, and no branch.
  await composer.fill("hello"); await composer.press("Enter");
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  // The summary's words, apart from its icons (an Agent without a reviewed mark shows its initials in its tile).
  const summary = page.locator(".agent-summary"), words = summary.locator(":scope > span").last();
  await expect(words).toHaveText(/^\d+ 个 Harness 就绪$/u); await expect(summary).toHaveAccessibleName(/^\d+ 个 Harness 就绪$/u);
  await rowTint(page, summary);
  await expect(welcome.getByRole("button", { name: "workspace", exact: true })).toBeVisible();
  assert.doesNotMatch(await welcome.innerText(), /分支|branch|git/iu, "the Gateway gives no branch, so none is shown");
  // H02: an Agent whose latest read asked for a sign-in moves from ready to needing the user (OpenClaw's fixture is signed out).
  const ready = Number(/^(\d+)/u.exec(await words.innerText())?.[1]);
  await chip.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "OpenClaw", exact: true }).click();
  await expect(page.getByText(/本机认证尚未就绪/u)).toBeVisible();
  // (Other Agents this computer has, found but not ready to run, are named there as well.)
  const needs = welcome.getByRole("button", { name: /(?:OpenClaw|\d+ 个 Harness) 需要处理$/u });
  await expect(needs).toBeVisible();
  await expect(words).toHaveText(`${ready - 1} 个 Harness 就绪`);
  // The dot between who is ready and who needs the user sits as far from the words on either side.
  const [said, dot, link] = await Promise.all([words.boundingBox(), welcome.locator("span[aria-hidden='true']", { hasText: "·" }).boundingBox(), needs.boundingBox()]);
  assert.ok(said && dot && link && Math.abs((dot.x - said.x - said.width) - (link.x - dot.x - dot.width)) <= 1, "the dot is centred between the two");
  // The summary lists the available Agents with their versions and states, and chooses one.
  await summary.click();
  const list = page.getByRole("region", { name: "本机可用的 Harness" });
  await expect(list.getByRole("button", { name: "选择 OpenClaw", exact: true })).toContainText("需要登录");
  await rowTint(page, list.getByRole("button", { name: "选择 Codex", exact: true }));
  // What is not installed is found on the Agent page, called by that page's name.
  await expect(list).toContainText(/另有 \d+ 个在目录中但未安装，可以在 Harness 页查看官方安装方式。/u); await expect(list).not.toContainText(/我的 Agent|Agent 页/u);
  await list.getByRole("button", { name: "选择 Codex", exact: true }).click();
  await expect(chip).toContainText("Codex"); await expect(composer).toBeFocused();
  await shoot("dl3-home");
  // H05: the program's own approval rule sits at the bottom left after the attachments, before the merged picker.
  await chip.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex Policy", exact: true }).click();
  const rule = page.getByRole("button", { name: "审批策略", exact: true });
  await expect(rule).toHaveText("从不请求审批");
  const [ruleBox, addBox, chipBox] = await Promise.all([rule.boundingBox(), add.boundingBox(), chip.boundingBox()]);
  assert.ok(ruleBox && addBox && chipBox && ruleBox.x > addBox.x + addBox.width && ruleBox.x + ruleBox.width < chipBox.x && Math.abs(ruleBox.y + ruleBox.height / 2 - (addBox.y + addBox.height / 2)) <= 2,
    "the rule follows the add button on its line, before the picker");
  await rule.click(); await expect(page.getByRole("option", { name: "按需请求审批", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(rule).toBeFocused();
  // Ruling R2: the bottom left keeps "+" and the rule only, as the Main board draws it. What adds to this message is in "+",
  // the native sessions included; the Agent's extensions and advanced settings are in the Agent list's footer.
  const corner = page.getByRole("group", { name: "附件与权限", exact: true });
  await expect(corner.getByRole("button")).toHaveCount(2);
  await expect(corner.getByRole("button").nth(0)).toHaveAccessibleName("添加文件或上下文"); await expect(corner.getByRole("button").nth(1)).toHaveAccessibleName("审批策略");
  await expect(page.getByRole("button", { name: /^(本机会话|原生扩展|高级配置)$/u })).toHaveCount(0);
  await add.click();
  await expect(page.getByRole("menuitem", { name: /^添加文件或图片…/u })).toBeVisible(); await expect(page.getByRole("menuitem", { name: "继续原程序的会话…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(add).toBeFocused();
  await chip.getByRole("button", { name: "选择 Harness", exact: true }).click();
  const agentList = page.locator(".picker-popover");
  await expect(agentList.getByRole("button", { name: "查看技能与扩展…", exact: true })).toBeVisible(); await expect(agentList.getByRole("button", { name: "高级配置…", exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `dl3-agent-footer-${scheme}-1440.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
  await shoot("dl3-permission");
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
  // It names the state in the header's words (Interaction board: 等你批准).
  await expect(dock.locator("#approval-dock-title")).toHaveText("Shared Agent 等你批准"); await expect(page.locator(".chat-page > header .status-pill")).toHaveText("Shared Agent 等你批准");
  await expect(dock.locator(".permission-deadline")).toHaveText("等待期限 · 剩余 30 分");
  await expect(dock).toContainText("选“Allow always”后"); await expect(dock).toContainText("只能点选");
  // P03: ⏎ allows once and esc refuses; number keys choose one-time options; the lasting option has no key.
  await expect(dock.getByRole("button", { name: "Allow once", exact: true })).toHaveAttribute("aria-keyshortcuts", "1 Enter");
  await expect(dock.getByRole("button", { name: "Deny", exact: true })).toHaveAttribute("aria-keyshortcuts", "2 Escape");
  await expect(dock.getByRole("button", { name: "Allow always", exact: true })).not.toHaveAttribute("aria-keyshortcuts");
  // P04: the amber ring, and the Turn keeps a mark that points to it.
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).boxShadow)).toContain("rgb(245, 158, 11) 0px 0px 0px 1.5px");
  await expect(log.getByRole("button", { name: "等你批准，请求停在下方输入框的位置", exact: true })).toBeVisible();
  // Decision F: the Turn says the wait once. No step is in progress here, so its process line says 等你批准 in the process's
  // grey with the timer and without the arc; the one amber line is the mark under it.
  const waiting = log.locator(".assistant-message").last(), line = waiting.locator(".process-summary"), marker = waiting.locator(".docked-approval");
  await expect(line.locator(".response-status")).toHaveText("等你批准"); await expect(line).toContainText(/· 已用 \d+ 秒/u);
  await expect(line.locator(".spinner")).toHaveCount(0); await expect(line.locator(".shimmer-text")).toHaveCount(0);
  await expect(marker).toHaveCount(1); await expect(marker).toHaveText("等你批准，请求停在下方输入框的位置");
  const amber = await marker.evaluate(element => getComputedStyle(element).color);
  assert.deepEqual(await waiting.evaluate((turn, color) => [...turn.querySelectorAll("*")].filter(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent!.trim() !== "")
    && getComputedStyle(node).color === color).map(node => node.textContent!.trim()), amber), ["等你批准，请求停在下方输入框的位置"], "the mark is the Turn's only amber line");
  await shoot("dl5-dock");
  // The mark is a control: ⏎ on it, or a click, moves the focus to the approval. Reached from the keyboard, the approval shows
  // the product's focus ring at once (2 px, accent text, around its own corners); reached with the pointer it shows none.
  const ring = () => dock.evaluate(element => { const style = getComputedStyle(element); return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset, /outline|all/u.test(style.transitionProperty) && parseFloat(style.transitionDuration) > 0]; });
  await page.locator("#chat-title").click(); await marker.focus(); await page.keyboard.press("Enter"); await expect(dock).toBeFocused();
  assert.deepEqual(await ring(), ["solid", "2px", "rgb(47, 95, 208)", "2px", false]);
  await page.screenshot({ path: join(artifact, "dl5-dock-focus-light-1440.png"), animations: "disabled" });
  await page.locator("#chat-title").click(); await marker.click(); await expect(dock).toBeFocused();
  assert.equal((await ring())[0], "none");
  // Pointing at the approval makes the keys its own at once.
  await dock.click({ position: { x: 60, y: 8 } }); await expect(dock).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(log).toContainText('"optionId":"allow_once"', { timeout: 15000 });
  await expect(dock).toHaveCount(0); await expect(composer).toBeVisible(); await expect(composer).toBeFocused();
  await expect(results).toHaveText(["你允许了一次：rm -rf build"]);
  assert.equal(await results.first().evaluate(element => getComputedStyle(element).animationName), "hh-fade-in");
  await expect(log.getByRole("button", { name: "等你批准，请求停在下方输入框的位置", exact: true })).toHaveCount(0);
  await expect.poll(() => box.evaluate(element => getComputedStyle(element).boxShadow)).not.toContain("rgb(245, 158, 11)");
  // M20: the same box turns into the approval, its height in 300 ms while the amber ring fades in over its own 200 ms, and
  // back in 200 ms; a decision from the keyboard puts the composer back at once (#37). The box's own transitions are logged
  // from here, once the ring of the first decision has gone.
  await page.waitForTimeout(300);
  await box.evaluate(element => {
    const entries: string[] = []; (window as unknown as { __box: string[] }).__box = entries;
    for (const type of ["transitionrun", "transitionend", "transitioncancel"]) element.addEventListener(type, event => {
      const name = (event as TransitionEvent).propertyName, target = event.target as Element;
      if (target === element && (name === "height" || name === "box-shadow")) entries.push(type.slice(10) + ":" + name + (type === "transitionrun" && name === "height" ? ":" + getComputedStyle(element).transitionDuration.split(",")[0]!.trim() : ""));
      // The composer's own layer fades out and back in over 100 ms.
      if (type === "transitionrun" && target.matches("form.composer") && name === "opacity") entries.push("composer-fade:" + getComputedStyle(target).transitionDuration);
    });
    // The approval's layer rises in 80 ms after the composer's starts to leave.
    element.addEventListener("animationstart", event => { const target = event.target as Element, style = getComputedStyle(target); if (target.querySelector("#approval-dock")) entries.push("dock-in:" + (event as AnimationEvent).animationName + ":" + style.animationDelay + ":" + style.animationDuration); });
  });
  const boxLog = () => page.evaluate(() => [...(window as unknown as { __box: string[] }).__box]);
  // esc refuses (a key right after the approval took the focus is still taken as meant for the message being typed).
  await ask(); await expect(dock).toBeFocused();
  await expect.poll(boxLog).toEqual(expect.arrayContaining(["run:height:0.3s", "end:height", "end:box-shadow", "composer-fade:0.1s", "dock-in:hh-enter:0.08s:0.2s"]));
  assert.ok(!(await boxLog()).includes("cancel:box-shadow"), "the morph does not cut the ring's fade short");
  await page.waitForTimeout(600);
  const docked = (await boxLog()).length;
  await page.keyboard.press("Escape");
  await expect(log).toContainText('"optionId":"deny"', { timeout: 15000 });
  await expect(results).toHaveText(["你允许了一次：rm -rf build", "你拒绝了：rm -rf build"]);
  await expect(composer).toBeVisible(); await page.waitForTimeout(300);
  const back = (await boxLog()).slice(docked);
  assert.ok(!back.some(entry => entry.startsWith("run:height") || entry === "end:box-shadow" || entry.startsWith("composer-fade")), `from the keyboard the composer comes back at once (${back.join(", ")})`);
  // A lasting option answers to no key and only to a click; the pointer's decision morphs back in 200 ms.
  await ask(); await page.waitForTimeout(600); await page.keyboard.press("3"); await expect(dock).toBeVisible();
  const clicked = (await boxLog()).length;
  await dock.getByRole("button", { name: "Allow always", exact: true }).click();
  await expect(log).toContainText('"optionId":"allow_always"', { timeout: 15000 });
  await expect(results.last()).toHaveText("你选择了“Allow always”：rm -rf build");
  await expect.poll(async () => (await boxLog()).slice(clicked)).toEqual(expect.arrayContaining(["run:height:0.2s", "end:height", "end:box-shadow", "composer-fade:0.1s"]));
  await shoot("dl5-decided");
  // R04: with reduced motion the composer and the approval swap at once (no height, no ring fade, no rise): the approval
  // only fades in over 120 ms. (The shots above switched the colour scheme; its shadow change settles first.)
  await page.waitForTimeout(300); await page.emulateMedia({ reducedMotion: "reduce" });
  const calm = (await boxLog()).length;
  await ask(); await page.waitForTimeout(600);
  await dock.getByRole("button", { name: "Allow once", exact: true }).click(); await expect(composer).toBeVisible(); await page.waitForTimeout(300);
  const swapped = (await boxLog()).slice(calm);
  assert.deepEqual(swapped, ["dock-in:hh-fade-in:0s:0.12s"], `reduced motion swaps at once (${swapped.join(", ")})`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // A question stays in its Turn, and the composer stays where it is.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex Question", exact: true }).click();
  await composer.fill("ask me"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  const question = log.getByRole("region", { name: "审批与提问", exact: true });
  await expect(question).toContainText("选择原生计划", { timeout: 15000 });
  await expect(composer).toBeVisible(); await expect(box.getByRole("region", { name: "工具审批", exact: true })).toHaveCount(0);
  // The same state says the same words everywhere (decision G): the card, the header and the Turn's line say 等你回答; no
  // marker points below, since nothing waits in the composer's place.
  await expect(question).toContainText("Codex Question 等你回答"); await expect(page.locator(".chat-page > header .status-pill")).toHaveText("Codex Question 等你回答");
  await expect(log.locator(".assistant-message").last().locator(".process-summary .response-status")).toHaveText("等你回答");
  await expect(log.locator(".docked-approval")).toHaveCount(0);
  await question.getByRole("button", { name: "取消", exact: true }).click();
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("G054-DL5 while an approval waits, the Turn names the step it asks for in the 想… form, grey and still with its timer, in its line, its steps and the details; once allowed the step runs (ruling J)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const dock = page.locator(".composer-box").getByRole("region", { name: "工具审批", exact: true });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  // The fixture reads a file, then asks before it runs a command, which it reports as pending until it is allowed.
  await composer.fill("STEP_APPROVAL 清理构建目录"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(dock).toContainText("rm -rf build", { timeout: 15000 });
  const turn = log.locator(".assistant-message").last(), line = turn.locator(".process-summary"), steps = turn.getByRole("list", { name: "工具活动", exact: true });
  const asked = steps.locator(".native-tool").filter({ hasText: "rm -rf build" });
  // The line names the step in the Interaction board's words, grey and still beside its timer: no arc, no sweep, no amber.
  await expect(line.locator(".response-status")).toHaveText("想运行 rm -rf build"); await expect(line).toContainText(/· 已用 \d+ 秒/u);
  await expect(line.locator(".spinner")).toHaveCount(0); await expect(line.locator(".shimmer-text")).toHaveCount(0);
  await expect(line.locator(".status-dot")).toHaveAttribute("data-tone", "idle");
  // Its step says the same words and does not spin either; the read before it is done. Nothing in the Turn turns.
  await expect(steps.locator(".native-tool")).toHaveCount(2);
  await expect(steps.locator(".native-tool").first()).toHaveText("读取 app.ts"); await expect(asked).toHaveText("想运行 rm -rf build");
  await expect(turn.locator(".spinner")).toHaveCount(0);
  // The mark under it stays the Turn's only amber line.
  const marker = turn.locator(".docked-approval");
  await expect(marker).toHaveText("等你批准，请求停在下方输入框的位置");
  const amber = await marker.evaluate(element => getComputedStyle(element).color);
  assert.deepEqual(await turn.evaluate((root, color) => [...root.querySelectorAll("*")].filter(node => [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent!.trim() !== "")
    && getComputedStyle(node).color === color).map(node => node.textContent!.trim()), amber), ["等你批准，请求停在下方输入框的位置"], "the mark is the Turn's only amber line");
  // The page announces the same state in the header's words (decision G), never that the reply runs.
  const announced = page.locator(".chat-page > .sr-only[role=status]");
  await expect(announced).toHaveText("等你批准");
  // The details list the same step in the same words.
  await page.keyboard.press("ControlOrMeta+Backslash");
  const details = page.getByRole("complementary", { name: "详情栏" });
  await details.getByRole("tab", { name: "过程", exact: true }).click();
  const listed = details.getByRole("list", { name: "工具活动", exact: true }).locator(".native-tool").filter({ hasText: "rm -rf build" });
  await expect(listed).toHaveText("想运行 rm -rf build"); await expect(listed.locator(".spinner")).toHaveCount(0);
  // Nothing of the Turn runs in the details either: its row carries the amber dot of waiting, named 等你批准 as the header
  // and the sidebar name it, and its facts say 等你批准 rather than that it is executing.
  const turnRow = details.locator("ol > li > button").filter({ hasText: "第 1 轮" });
  await expect(turnRow.locator(".status-dot")).toHaveAttribute("data-tone", "wait"); await expect(turnRow.getByRole("img", { name: "等你批准", exact: true })).toHaveCount(1);
  await details.getByRole("tab", { name: "执行", exact: true }).click();
  await expect(details.locator(".execution-details dt", { hasText: "执行状态" }).locator("xpath=following-sibling::dd[1]")).toHaveText("等你批准");
  await details.getByRole("tab", { name: "过程", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(artifact, "dl5-asking-step-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl5-asking-step-dark-1440.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  // Allowed, the step runs: the line and the step say 正在运行 with the arc, and the line sweeps again.
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(line.locator(".response-status")).toHaveText("正在运行 rm -rf build", { timeout: 15000 });
  await expect(line.locator(".spinner")).toHaveCount(1); await expect(line.locator(".shimmer-text")).toHaveText("正在运行 rm -rf build");
  await expect(asked).toHaveText("正在运行 rm -rf build"); await expect(asked.locator(".spinner")).toHaveCount(1);
  await expect(listed).toHaveText("正在运行 rm -rf build"); await expect(listed.locator(".spinner")).toHaveCount(1);
  await expect(announced).not.toHaveText("等你批准");
  await expect(turnRow.locator(".status-dot")).toHaveAttribute("data-tone", "run");
  // Done, it reads as a step that ran, and the folded line counts it.
  await writeFile(join(fixture.root, "workspace", "step-continue"), "go");
  await expect(turn).toHaveAttribute("data-run-status", "completed", { timeout: 15000 });
  await expect(listed).toHaveText("运行 rm -rf build");
  await expect(line).toContainText("读了 1 个文件，运行 1 条命令");
  // A Turn that fails after its step was refused says so in red, and its line is a row that tints when pointed at: its words
  // read at 4.5:1 on that tint in both themes, as all small text must (ruling M).
  await composer.fill("STEP_APPROVAL_FAILS 再清理一次"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(dock).toContainText("rm -rf build", { timeout: 15000 });
  await dock.getByRole("button", { name: "Deny", exact: true }).click();
  const refused = log.locator(".assistant-message").last(), refusedLine = refused.locator(".process-summary");
  await expect(refused).toHaveAttribute("data-run-status", "failed", { timeout: 15000 });
  await expect(refusedLine).toHaveText(/^失败 · 读了 1 个文件，运行 1 条命令，1 项失败 · 用时 [0-9.]+ 秒$/u); await expect(refusedLine).toHaveAttribute("role", "button");
  await refusedLine.hover();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(300);
    assert.notEqual(await refusedLine.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "the line is tinted while pointed at");
    await dl10Readable(page, `a failed Turn's line pointed at in ${scheme}`, scheme);
  }
  await page.emulateMedia({ colorScheme: "light" });
  assert.deepEqual(errors, []);
});

test("G054-DL5 an approval that takes the composer's place closes a panel the composer opened and takes the focus it held, and the panel does not come back once the approval is decided (ruling R2)", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } });
  // Holds the event stream's bytes while asked to, so that the approval arrives while the panel is open and holds the focus.
  const delivery = await holdFactDelivery(context);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const hold = (next: boolean) => delivery(page, next);
  t.after(async () => { if (!page.isClosed()) await hold(false); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), panel = page.locator(".composer-settings-panel");
  const dock = page.locator(".composer-box").getByRole("region", { name: "工具审批", exact: true });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Shared Agent", exact: true }).click();
  await composer.fill("hello"); await composer.press("Enter");
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  // The next message asks before it runs a command; its request waits in the held stream while the settings are opened.
  await hold(true);
  await composer.fill("approve this"); await composer.press("Enter"); await expect(composer).toHaveValue("");
  await openAdvanced(page);
  await expect.poll(() => panel.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await hold(false);
  await expect(dock).toContainText("rm -rf build", { timeout: 15000 });
  // The approval closes the panel and takes the focus the panel held, as it takes the focus from the message box.
  await expect(panel).toHaveCount(0); await expect(dock).toBeFocused();
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(dock).toHaveCount(0, { timeout: 15000 }); await expect(composer).toBeFocused();
  // Decided, the composer is back with the focus, and the panel stays closed: it does not open again by itself.
  await page.waitForTimeout(500);
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused();
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(2, { timeout: 15000 });
  // The same when the message box has the focus and the panel stays open beside it: the approval takes the focus from the
  // message box, and once decided the panel stays closed.
  await openAdvanced(page);
  await composer.fill("approve this"); await expect(panel).toHaveCount(1); await composer.press("Enter");
  await expect(dock).toContainText("rm -rf build", { timeout: 15000 });
  await expect(panel).toHaveCount(0); await expect(dock).toBeFocused();
  await dock.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(dock).toHaveCount(0, { timeout: 15000 }); await page.waitForTimeout(500);
  await expect(panel).toHaveCount(0); await expect(composer).toBeFocused();
  assert.deepEqual(errors, []);
});

test("G054-DL5 an approval that takes the composer's place also closes the Agent list, the model and thinking lists, the \"+\" menu and a list open in the advanced settings, takes the focus they held, and none of them comes back once it is decided (ruling R2)", { timeout: 150000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 960 } });
  // Holds the event stream's bytes while asked to, so that the approval arrives while a list or the menu is open.
  const delivery = await holdFactDelivery(context);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const hold = (next: boolean) => delivery(page, next);
  t.after(async () => { if (!page.isClosed()) await hold(false); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), chip = page.locator(".agent-chip"), add = page.getByRole("button", { name: "添加文件或上下文", exact: true });
  const dock = page.locator(".composer-box").getByRole("region", { name: "工具审批", exact: true }), layers = page.locator(".picker-popover, [role=menu]");
  const pick = async (label: string, value: string) => { await chip.getByRole("button", { name: label, exact: true }).click(); await page.getByRole("option", { name: value, exact: true }).click(); };
  // Codex with Native B shows the whole merged picker: the Agent, the model and the thinking level.
  await pick("选择 Harness", "Codex"); await expect(chip.getByRole("button", { name: "选择模型", exact: true })).toBeEnabled();
  await pick("选择模型", "Native B"); await expect(chip.getByRole("button", { name: "思考强度", exact: true })).toBeEnabled();
  await composer.fill("hello"); await composer.press("Enter");
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  // Each layer the composer opens, opened as a user does, with the focus in it.
  const openers: readonly (readonly [string, () => Promise<void>])[] = [
    ["the Agent list (⌘J)", async () => { await page.keyboard.press("ControlOrMeta+J"); await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toBeFocused(); }],
    ["the model list", async () => { await chip.getByRole("button", { name: "选择模型", exact: true }).click(); await expect(page.getByRole("combobox", { name: "搜索模型", exact: true })).toBeFocused(); }],
    ["the thinking list", async () => { await chip.getByRole("button", { name: "思考强度", exact: true }).click(); await expect(page.getByRole("combobox", { name: "搜索思考强度", exact: true })).toBeFocused(); }],
    ["the + menu from the keyboard", async () => { await add.focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("menuitem").first()).toBeFocused(); }],
    ["the + menu from the pointer", async () => { await add.click(); await expect.poll(() => page.getByRole("menu").evaluate(menu => menu.contains(document.activeElement))).toBe(true); }],
  ];
  for (const [index, [name, open]] of openers.entries()) {
    // The next message asks before it reads the workspace; its request waits in the held stream while the layer opens.
    await hold(true);
    await composer.fill("APPROVAL：" + name); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await open(); await expect(layers).toHaveCount(1);
    await hold(false);
    await expect(dock).toContainText("读取验收工作区", { timeout: 15000 });
    // The approval closes the layer and takes the focus it held, as it takes the focus from the message box.
    await expect(layers, name).toHaveCount(0); await expect(dock, name).toBeFocused();
    if (index === 0) {
      // Past the moment it ignores keys still meant for the message, esc refuses there: the focus goes back to the message
      // box, never to the page.
      await page.waitForTimeout(600); await page.keyboard.press("Escape");
    } else await dock.getByRole("button", { name: "允许一次", exact: true }).click();
    await expect(dock).toHaveCount(0, { timeout: 15000 }); await expect(composer, name).toBeFocused();
    await expect(page.locator("[data-run-status=completed]")).toHaveCount(index + 2, { timeout: 15000 });
    // Decided, nothing the composer had open comes back by itself.
    await page.waitForTimeout(500);
    await expect(layers, name).toHaveCount(0); await expect(composer, name).toBeFocused();
  }
  // A list open in the advanced settings (协作模式) closes as the panel does, instead of staying whole over the dock until
  // the panel has gone; the dock takes the focus it held.
  await hold(true);
  await composer.fill("APPROVAL：a list in the advanced settings"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await openAdvanced(page);
  const settings = page.locator(".composer-settings-panel");
  await settings.getByRole("button", { name: "协作模式", exact: true }).click(); await expect(page.getByRole("combobox", { name: "搜索协作模式", exact: true })).toBeFocused();
  await expect(layers).toHaveCount(1);
  // Whether the list starts its own exit (Base UI's data-ending-style) before it is removed, or is removed whole with the
  // panel once the panel's exit has ended.
  await layers.evaluate(list => {
    const record = { exit: "" }; Reflect.set(window, "__nestedListExit", record);
    const observer = new MutationObserver(() => {
      if (list.hasAttribute("data-ending-style")) { record.exit = "its own exit"; observer.disconnect(); }
      else if (!list.isConnected) { record.exit = "removed whole"; observer.disconnect(); }
    });
    observer.observe(list, { attributes: true }); observer.observe(document.body, { childList: true, subtree: true });
  });
  await hold(false);
  await expect(dock).toContainText("读取验收工作区", { timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, "__nestedListExit") as { readonly exit: string }).exit)).toBe("its own exit");
  await expect(settings).toHaveCount(0); await expect(layers).toHaveCount(0); await expect(dock).toBeFocused();
  await dock.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(dock).toHaveCount(0, { timeout: 15000 }); await expect(composer).toBeFocused();
  await expect(page.locator("[data-run-status=completed]")).toHaveCount(openers.length + 2, { timeout: 15000 });
  await page.waitForTimeout(500);
  await expect(settings).toHaveCount(0); await expect(layers).toHaveCount(0); await expect(composer).toBeFocused();
  await expect(page.getByRole("log", { name: "对话历史" })).toContainText("原生审批已收到：decline");
  // The Agent list the approval closed opens again from ⌘J.
  await page.keyboard.press("ControlOrMeta+J"); await expect(page.getByRole("combobox", { name: "搜索 Harness", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(layers).toHaveCount(0); await expect(composer).toBeFocused();
  assert.deepEqual(errors, []);
});

test("G054-FR8 G054-DL5 a decision of the docked approval pressed with the pointer after keyboard use is sent on that one press: the numbers show for the keyboard only and keep their room, so no decision moves under the pointer, at 390, 320 and 1440 in both themes", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  // The number of each one-time option: the part of its button hidden from assistive technology, which hears the key named.
  const dock = page.locator(".composer-box").getByRole("region", { name: "工具审批", exact: true }), keys = dock.locator("button[aria-keyshortcuts] > [aria-hidden=true]");
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  // Where each of the dock's buttons is laid out (transforms aside: a pressed button scales to .97).
  const layout = () => dock.getByRole("button").evaluateAll(buttons => buttons.map(button => {
    const element = button as HTMLElement; return `${element.getAttribute("aria-label")} ${element.offsetLeft},${element.offsetTop} ${element.offsetWidth}×${element.offsetHeight}`; }));
  // Codex asks with three one-time options, each with its number for the keyboard: 允许一次 (⏎), 拒绝 (esc) and 取消.
  const decisions = [["允许一次", "accept", "你允许了一次：读取验收工作区"], ["拒绝", "decline", "你拒绝了：读取验收工作区"], ["取消", "cancel", "你拒绝了：读取验收工作区"]] as const;
  let round = 0;
  for (const [shade, scheme] of (["light", "dark"] as const).entries()) for (const [step, width] of [390, 320, 1440].entries()) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    // Each width presses a different decision in each theme.
    const [name, id, result] = decisions[(step + shade) % decisions.length]!; round++;
    // Sent from the keyboard: the approval takes the focus and each one-time option shows its number.
    await composer.fill(`APPROVAL：${name} ${width} ${scheme}`); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
    await expect(dock).toContainText("读取验收工作区", { timeout: 15000 }); await expect(dock).toBeFocused();
    await expect(keys).toHaveText(["2", "3", "1"]);
    for (const key of await keys.all()) await expect(key).toBeVisible();
    await dl10Settle(page);
    const before = await layout();
    await page.screenshot({ path: join(artifact, `dl5-dock-keys-${scheme}-${width}.png`), animations: "disabled" });
    // The press hides the numbers as it starts, the page reading the pointer from there (Motion board #37); the decisions
    // keep their size and place meanwhile, so the press ends on the decision it began on, and that one press decides.
    const box = await dock.getByRole("button", { name, exact: true }).boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await expect(keys.first()).toBeHidden();
    const pressed = await layout();
    await page.mouse.up();
    await expect(log.locator(".approval-result")).toHaveCount(round, { timeout: 15000 });
    await expect(log.locator(".approval-result").last()).toHaveText(result);
    await expect(dock).toHaveCount(0); await expect(log).toContainText("原生审批已收到：" + id, { timeout: 15000 });
    assert.deepEqual(pressed, before, `no decision moves under the pointer at ${width} in ${scheme}`);
    await expect(page.locator("[data-run-status=completed]")).toHaveCount(round, { timeout: 15000 });
  }
  // Without the keyboard the numbers stay hidden, and the decisions take the same room as with them.
  await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill("APPROVAL：pointer only"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(dock).toContainText("读取验收工作区", { timeout: 15000 }); await expect(keys).toHaveCount(3);
  for (const key of await keys.all()) await expect(key).toBeHidden();
  await dl10Settle(page);
  const plain = await layout();
  await page.screenshot({ path: join(artifact, "dl5-dock-pointer-light-390.png"), animations: "disabled" });
  await page.keyboard.press("Shift"); for (const key of await keys.all()) await expect(key).toBeVisible();
  assert.deepEqual(await layout(), plain, "the numbers take their room whether they show or not");
  await dock.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(log.locator(".approval-result")).toHaveCount(round + 1, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("G054-DL5 a decision of the docked approval pressed at its very edge is sent on that press, though pressing scales it to .97 (#31), at 390, 320 and 1440 in both themes; let go off it, nothing is sent", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 390, height: 844 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const sent: string[] = []; page.on("request", request => { if (request.method() === "POST" && /\/permissions\//u.test(request.url())) sent.push(request.url()); });
  await page.goto(fixture.gateway.url);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" }), send = page.getByRole("button", { name: "发送消息", exact: true });
  const dock = page.locator(".composer-box").getByRole("region", { name: "工具审批", exact: true });
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  // Codex asks with 允许一次 (⏎), 拒绝 (esc) and 取消. On a phone 允许一次 fills a line of its own, and .97 draws each of its
  // ends in by some 5 px.
  const rounds = [[390, "light", "允许一次", "left"], [390, "dark", "拒绝", "right"], [320, "light", "允许一次", "right"], [320, "dark", "取消", "left"], [1440, "light", "允许一次", "right"], [1440, "dark", "拒绝", "left"]] as const;
  for (const [index, [width, scheme, name, edge]] of rounds.entries()) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    // Asked after keyboard use and after pointer use in turn.
    await composer.fill(`APPROVAL：${name} ${edge} ${width} ${scheme}`); await expect(send).toBeEnabled();
    if (index % 2 === 0) await composer.press("Enter"); else await send.click();
    await expect(dock).toContainText("读取验收工作区", { timeout: 15000 }); await dl10Settle(page);
    const button = dock.getByRole("button", { name, exact: true }), box = await button.boundingBox(); assert.ok(box);
    // Pressed 1 px inside one end and held until the decision has scaled all the way, the pointer is outside what is drawn
    // of it; let go there, the press still sends it.
    const x = edge === "left" ? box.x + 1 : box.x + box.width - 1;
    await page.mouse.move(x, box.y + box.height / 2); await page.mouse.down();
    await expect.poll(() => button.evaluate(element => getComputedStyle(element).transform)).toBe("matrix(0.97, 0, 0, 0.97, 0, 0)");
    const drawn = await button.boundingBox(); assert.ok(drawn && (x < drawn.x || x > drawn.x + drawn.width), `the press at ${width} is outside the pressed ${name}`);
    await page.mouse.up();
    await expect(log.locator(".approval-result")).toHaveCount(index + 1, { timeout: 15000 }); await expect(dock).toHaveCount(0);
    assert.equal(sent.length, index + 1, `one press at ${width} in ${scheme} sends ${name} once`);
    await expect(page.locator("[data-run-status=completed]")).toHaveCount(index + 1, { timeout: 15000 });
  }
  // The room kept is the decision's own and no more, all through the press: let go a few pixels past its end, at once or once
  // it has scaled, a press sends nothing, and the approval keeps waiting.
  await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill("APPROVAL：let go off it"); await send.click();
  await expect(dock).toContainText("读取验收工作区", { timeout: 15000 }); await dl10Settle(page);
  const allow = dock.getByRole("button", { name: "允许一次", exact: true }), box = await allow.boundingBox(); assert.ok(box);
  for (const held of [false, true]) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    if (held) await expect.poll(() => allow.evaluate(element => getComputedStyle(element).transform)).toBe("matrix(0.97, 0, 0, 0.97, 0, 0)");
    await page.mouse.move(box.x + box.width + 3, box.y + box.height / 2); await page.mouse.up();
  }
  await page.waitForTimeout(500);
  assert.equal(sent.length, rounds.length, "a press let go off the decision sends nothing"); await expect(dock).toBeVisible();
  await allow.click(); await expect(log.locator(".approval-result")).toHaveCount(rounds.length + 1, { timeout: 15000 });
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
  // The motions this page plays are logged as they start: the send key's glyph (#16, #17) and the plan bar's parts (#22).
  await page.evaluate(() => {
    const entries: string[] = []; (window as unknown as { __motion: string[] }).__motion = entries;
    document.addEventListener("animationstart", event => { const { animationName } = event as AnimationEvent; if (/^hh-(send-to-stop|stop-to-send)$/u.test(animationName)) entries.push(animationName + ":" + getComputedStyle(event.target as Element).animationDuration); }, true);
    document.addEventListener("transitionrun", event => {
      const target = event.target as Element, { propertyName } = event as TransitionEvent;
      if (target.matches(".plan-bar .collapsible") && propertyName === "grid-template-rows" || target.matches(".plan-bar svg") && propertyName === "rotate") entries.push(propertyName + ":" + getComputedStyle(target).transitionDuration.split(",")[0]!.trim());
    }, true);
  });
  const motion = () => page.evaluate(() => [...(window as unknown as { __motion: string[] }).__motion]);
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  // #15: the first message, sent from the home, rises into the conversation it opened, once: one rise in the log, around it.
  await expect(log.locator(".motion-message-in")).toHaveCount(1); await expect(log.locator(".motion-message-in .user-message")).toHaveText(/NATIVE_ACTIVITY/u);
  // P01: the plan with a step left stays above the composer; it opens every step and its arrow turns.
  const bar = page.locator(".plan-bar"), toggle = bar.getByRole("button").first();
  await expect(toggle).toContainText("计划"); await expect(toggle).toContainText("1 / 2 · 正在：修改文件"); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const below = await page.locator(".composer-box").boundingBox(), above = await toggle.boundingBox();
  assert.ok(below && above && above.y + above.height <= below.y, "the plan bar sits above the composer");
  assert.ok(Math.abs(below.y - above.y - above.height - 8) <= 1, `closed, it keeps the composer's 8 px gap and no more (${below.y - above.y - above.height})`);
  await shoot("dl6-plan");
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(bar.getByRole("list", { name: "Codex 维护的计划" }).getByRole("listitem")).toHaveText(["读取工作区", "修改文件"]);
  await expect(toggle.locator("svg").last()).toHaveClass(/rotate-180/u);
  // #22: the steps open by their height (0fr → 1fr) and the arrow turns, both in 200 ms.
  await expect.poll(motion).toEqual(expect.arrayContaining(["grid-template-rows:0.2s", "rotate:0.2s"]));
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
  // #15: a message sent here rises into place, once (one rise per message sent in view); #16: the send key's glyph has turned
  // into the stop square.
  await expect(log.locator(".motion-message-in .user-message").last()).toContainText("STREAM_RENDER：计时"); await expect(log.locator(".motion-message-in")).toHaveCount(2);
  assert.match(await log.locator(".motion-message-in").last().evaluate(element => getComputedStyle(element).animationName), /hh-message-rise/u);
  await expect(page.getByRole("button", { name: "停止当前回复", exact: true }).locator(".send-stop")).toHaveAttribute("data-state", "stop");
  await expect.poll(motion).toContain("hh-send-to-stop:0.48s");
  // P06: meanwhile the next message is written and held above the plan bar; withdrawn, it is never sent.
  await composer.fill("下一条：先暂存"); await composer.press("Enter");
  const held = page.locator(".queued-message"); await expect(held).toContainText("将在本轮结束后发送"); await expect(composer).toHaveValue("");
  await shoot("dl6-running");
  await held.getByRole("button", { name: "撤回", exact: true }).click(); await expect(held).toHaveCount(0);
  const turnedBack = async () => (await motion()).filter(entry => entry === "hh-stop-to-send:0.48s").length, before = await turnedBack();
  await step("finish");
  await expect.poll(async () => (await current()).runs.at(-1).status, { timeout: 15000 }).toBe("completed");
  await expect(line).toContainText(/用时 [\d.]+ 秒/u);
  await expect(page.getByRole("button", { name: "发送消息", exact: true }).locator(".send-stop")).toHaveAttribute("data-state", "send");
  await expect.poll(turnedBack).toBe(before + 1);
  // The history a page opens with does not move.
  await page.reload(); await expect(log.locator(".user-message")).toHaveCount(2); await expect(log.locator(".motion-message-in")).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("G054-DL9 ⌘J opens the Agent list, ⌘. stops the reply, ⌘\\ opens and closes the details pushing the conversation, ↑ edits the last message, / lists the native commands and @ adds a file; composition triggers none of them; an Agent chosen mid-reply takes over after the Turn", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
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
  // The panel's width transitions and its content's slide are logged as they start (#23, #37).
  await page.evaluate(() => {
    const entries: string[] = []; (window as unknown as { __panel: string[] }).__panel = entries;
    document.addEventListener("transitionrun", event => { const target = event.target as Element; if (target.classList.contains("details-aside") && (event as TransitionEvent).propertyName === "width") entries.push("width:" + getComputedStyle(target).transitionDuration); }, true);
    document.addEventListener("animationstart", event => { if ((event as AnimationEvent).animationName === "hh-panel-in") entries.push("slide:" + getComputedStyle(event.target as Element).animationDelay); }, true);
  });
  const panelLog = () => page.evaluate(() => [...(window as unknown as { __panel: string[] }).__panel]);
  const width = () => page.locator(".chat-scroll").evaluate(element => Math.round(element.getBoundingClientRect().width));
  if (open) { await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toHaveCount(0); }
  const full = await width();
  await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toBeVisible();
  await expect.poll(width).toBeLessThanOrEqual(full - 380);
  await page.screenshot({ path: join(artifact, "dl9-panel.png"), animations: "disabled" });
  await page.keyboard.press("ControlOrMeta+\\"); await expect(panel).toHaveCount(0); await expect.poll(width).toBe(full);
  assert.deepEqual(await panelLog(), [], "from the keyboard the panel opens and closes at once");
  // Once fully closed (it leaves the page), the button opens it anew.
  await expect(page.locator(".details-aside")).toHaveCount(0);
  const button = page.getByRole("button", { name: "详情栏", exact: true });
  await button.click(); await expect(panel).toBeVisible(); await expect(button).toHaveAttribute("aria-pressed", "true");
  // With the pointer it widens in 300 ms and its content slides in 60 ms later, once (the panel adds no slide of its own).
  await expect.poll(panelLog).toEqual(["width:0.3s", "slide:0.06s"]);
  // Its content slid in once: a key and then the pointer again (the input mode changing) do not make it start over.
  await page.waitForTimeout(400); await page.keyboard.press("Shift");
  assert.equal(await page.evaluate(() => { document.dispatchEvent(new PointerEvent("pointerdown")); return getComputedStyle(document.querySelector(".details-aside")!.firstElementChild!).opacity; }), "1");
  await button.click(); await expect(panel).toHaveCount(0); await expect(button).toHaveAttribute("aria-pressed", "false");
  // It closes in 200 ms; the slide never started over.
  await expect.poll(panelLog).toEqual(["width:0.3s", "slide:0.06s", "width:0.2s"]);
  // With reduced motion the panel appears at once: no widening and no slide.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await button.click(); await expect(panel).toBeVisible();
  assert.deepEqual(await page.locator(".details-aside").evaluate(element => [getComputedStyle(element).transitionDuration, getComputedStyle(element.firstElementChild!).animationName]), ["0s", "none"]);
  await button.click(); await expect(panel).toHaveCount(0); await page.emulateMedia({ reducedMotion: "no-preference" });
  // X05: ⌘J while a reply runs chooses who takes over; the Turn goes on with Codex and the choice applies once it ends.
  const step = async (stage: string) => { const pending = join(fixture.root, "workspace", "next-stream-control.json"); await writeFile(pending, JSON.stringify({ stage })); await rename(pending, join(fixture.root, "workspace", "stream-control.json")); };
  await composer.fill("STREAM_RENDER：换 Harness"); await composer.press("Enter");
  await expect.poll(async () => (await current()).runs.at(-1).status, { timeout: 15000 }).toBe("running");
  await page.keyboard.press("ControlOrMeta+J"); await search.fill("Shared Agent"); await search.press("Enter");
  const strip = page.locator(".composer-change");
  await expect(strip).toHaveText("本轮结束后由 Shared Agent 接手"); await expect(composer).toBeFocused();
  await expect.poll(async () => (await current()).pendingSwitchId).not.toBeNull();
  const handing = await current(); assert.equal(handing.runs.at(-1).status, "running"); assert.equal(handing.runs.at(-1).selection.harnessId, "codex");
  await page.waitForTimeout(250);
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `dl9-handover-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
  await step("finish");
  await expect.poll(async () => { const value = await current(); return value.activeRunId === null && value.pendingSwitchId === null && value.selection.harnessId; }, { timeout: 15000 }).toBe("native-acp");
  const handed = await current(); assert.equal(handed.runs.at(-1).status, "completed"); assert.equal(handed.runs.at(-1).selection.harnessId, "codex");
  await expect(strip).toHaveCount(0); await expect(trigger).toContainText("Shared Agent");
  // C08: where it took over, a pill with the mark of the Agent before, an arrow and the new Agent's mark (Conversation board).
  const handover = page.getByRole("log", { name: "对话历史" }).getByRole("separator", { name: "从这里起由 Shared Agent 接手", exact: true });
  await expect(handover).toBeVisible();
  await expect(handover.locator(".brand-tile")).toHaveCount(2); await expect(handover.locator(".brand-tile").first()).toHaveAttribute("data-brand", "codex");
  // #19: made in view, it comes in: the pill fades in, the arrow draws in 160 ms, the new mark pops from .6, the lines grow.
  const handoverMotion = () => handover.evaluate(element => {
    const pill = element.children[1]!, arrow = pill.querySelector("path[pathLength]")!, mark = pill.children[2]!;
    const motion = (node: Element) => { const style = getComputedStyle(node); return [style.animationName, style.animationDuration, style.animationDelay].join(" / "); };
    return { pill: motion(pill), arrow: motion(arrow), mark: motion(mark) + " / " + getComputedStyle(mark).getPropertyValue("--motion-scale-from").trim(), lines: [motion(element.firstElementChild!), motion(element.lastElementChild!)] };
  });
  assert.deepEqual(await handoverMotion(), { pill: "hh-fade-in / 0.2s / 0s", arrow: "hh-draw / 0.16s / 0.14s", mark: "hh-pop-in, hh-fade-in / 0.3s, 0.12s / 0.22s / 0.6",
    lines: ["hh-line-grow / 0.3s / 0.12s", "hh-line-grow / 0.3s / 0.12s"] });
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `dl9-handover-pill-${scheme}.png`), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
  // Found in the history the page opens with, it stays still.
  await page.reload(); await expect(handover).toBeVisible();
  assert.deepEqual(await handoverMotion(), { pill: "none / 0s / 0s", arrow: "none / 0s / 0s", mark: "none / 0s / 0s / ", lines: ["none / 0s / 0s", "none / 0s / 0s"] });
  // A new conversation opened from the keyboard (⇧⌘O) is simply there (#37); opened with the pointer, the greeting rises in.
  const greeting = page.getByRole("heading", { name: "今天想让哪个 Harness 做什么？", exact: true });
  await page.keyboard.press("ControlOrMeta+Shift+O"); await expect(greeting).toBeVisible();
  assert.equal(await greeting.evaluate(element => getComputedStyle(element).animationName), "none");
  await page.getByRole("button", { name: "新对话", exact: true }).click(); await expect(greeting).toBeVisible();
  assert.equal(await greeting.evaluate(element => getComputedStyle(element).animationName), "hh-enter");
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
  await expect(page.getByRole("heading", { name: "Harness", exact: true, level: 1 })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("dialog", { name: "快捷键" })).toContainText("搜索与命令"); await page.keyboard.press("Escape");
  await page.screenshot({ path: join(artifact, "palette.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
});

test("G054-DL2 the sidebar groups conversations by project with a state dot each, and keeps the inbox, Agent with its update count, capabilities, the settings and the local service in reach", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const address = new URL(fixture.gateway.url), origin = address.origin;
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } });
  // System notifications are recorded instead of shown, by a browser that allows them once asked (X04); the page's
  // visibility is the test's to say.
  await context.addInitScript(() => {
    const shown: { title: string; body: string; silent: boolean }[] = [], state = { permission: "default", hidden: false };
    Object.defineProperty(window, "__notices", { value: shown }); Object.defineProperty(window, "__hide", { value: (hidden: boolean) => { state.hidden = hidden; document.dispatchEvent(new Event("visibilitychange")); } });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state.hidden ? "hidden" : "visible" });
    class Recorded { static get permission() { return state.permission; } static async requestPermission() { state.permission = "granted"; return "granted"; }
      onclick: (() => void) | null = null; constructor(title: string, options: { body?: string; silent?: boolean } = {}) { shown.push({ title, body: options.body ?? "", silent: options.silent ?? false }); } close() {} }
    Object.defineProperty(window, "Notification", { configurable: true, value: Recorded });
  });
  const page = await context.newPage(), errors: string[] = [];
  let refusedStreams = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() !== "error") return; if (entry.location().url.endsWith("/api/v1/attention/stream") && entry.text().includes("503")) refusedStreams++; else errors.push(entry.text()); });
  const hide = (hidden: boolean) => page.evaluate(value => (window as unknown as { __hide: (hidden: boolean) => void }).__hide(value), hidden);
  const notices = () => page.evaluate(() => (window as unknown as { __notices: { title: string; body: string; silent: boolean }[] }).__notices);
  // The Gateway reports an update for Codex once the test says so (G054-UP1's way of changing the state it returns).
  let update = false;
  await page.route("**/api/v1/state", async route => {
    const response = await route.fetch(), body = await response.json() as { harnesses: { id: string; management: Record<string, unknown> }[] };
    await route.fulfill({ response, json: { ...body, harnesses: body.harnesses.map(harness => update && harness.id === "codex" ? { ...harness, management: { ...harness.management, latestVersion: "9.9.9", updateStatus: "available" } } : harness) } });
  });
  // The page starts while its connection for waiting requests is refused, as when the local service restarts.
  await page.route("**/api/v1/attention/stream", route => route.fulfill({ status: 503, json: { code: "STREAM_CLOSED", message: "refused by the test" } }));
  await page.goto(fixture.gateway.url);
  const navigation = page.getByRole("complementary", { name: "主导航" }), row = (title: string) => navigation.getByRole("button", { name: title, exact: true });
  await expect(row("新对话")).toBeVisible();
  // While it is down the settings row says so, and the page keeps trying; once it is back the row says connected again.
  await expect(navigation.locator(".service-status")).toHaveAttribute("title", "与本机服务的连接中断 · " + address.hostname + ":" + address.port);
  await expect(navigation.getByRole("status")).toHaveText("与本机服务的连接中断");
  await page.unroute("**/api/v1/attention/stream");
  await expect(navigation.locator(".service-status")).toHaveAttribute("title", "本机服务已连接 · " + address.hostname + ":" + address.port, { timeout: 15000 });
  await expect(navigation.getByRole("status")).toHaveText("");
  assert.ok(refusedStreams >= 1, "the refused connection was tried");
  // From the top as on the board: the mark, a new conversation, search, the inbox, Agent, capabilities; the projects; the settings.
  const order = ["HarnessHub 首页", "新对话", "搜索与命令", "等你处理", "Harness", "能力", "设置"];
  const tops = await Promise.all(order.map(async name => (await row(name).boundingBox())?.y ?? -1));
  assert.ok(tops.every((top, index) => top >= 0 && (index === 0 || top > tops[index - 1]!)), "the sidebar's entries in the board's order: " + tops.join(", "));
  await expect(navigation.locator("svg.logo-mark")).toBeVisible(); await expect(navigation.getByRole("heading", { name: "项目", exact: true })).toBeVisible();
  await expect(row("新对话")).toHaveCSS("height", "38px"); await expect(row("新对话")).toHaveCSS("border-radius", "12px");
  // The settings row names the port this page came from, and the local service as connected; no update is reported yet.
  await expect(navigation.locator(".service-status")).toHaveText(address.port);
  await expect(navigation.locator(".service-status")).toHaveAttribute("title", "本机服务已连接 · " + address.hostname + ":" + address.port);
  await expect(navigation.locator(".badge-accent")).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  const send = async (text: string) => { await composer.fill(text); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter"); };
  const pick = async (name: string) => { await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); };
  // A conversation's row opens in place at the top of its project when it first appears (Motion board #36): the observer
  // marks each row that arrives already opening, before its title becomes its first message.
  await page.evaluate(() => {
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement)
      for (const item of [node, ...node.querySelectorAll(".motion-list-insert")]) if (item.classList.contains("motion-list-insert")) item.setAttribute("data-arrived-opening", ""); }).observe(document.body, { childList: true, subtree: true });
  });
  // A Turn that failed marks its conversation red, and the mark stays once another conversation is open. It ended while
  // the page was out of sight and notifications were never chosen: nothing is shown, and coming back offers them once,
  // saying how that Turn ended.
  await pick("Codex"); await hide(true); await send("FAIL_ONCE 第一段");
  await expect(row("FAIL_ONCE 第一段").locator(".status-dot")).toHaveAttribute("data-tone", "fail", { timeout: 15000 });
  await expect(navigation.locator("[data-arrived-opening]").filter({ has: page.getByRole("button", { name: "FAIL_ONCE 第一段", exact: true }) })).toHaveCount(1);
  assert.deepEqual(await notices(), []);
  await hide(false);
  const offer = page.getByRole("dialog", { name: "这一轮在后台失败了" });
  await expect(offer).toContainText("要在做完或需要你时用系统通知告诉你吗？");
  await offer.getByRole("button", { name: "开启通知", exact: true }).click(); await expect(offer).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Notification.permission)).toBe("granted");
  // One waiting for an approval is amber, counted on the inbox entry and in the tab's title.
  await row("新对话").click(); await pick("Shared Agent"); await send("approve this");
  await expect(navigation.locator(".attention-count")).toHaveText("1", { timeout: 15000 });
  await expect(row("approve this").locator(".status-dot")).toHaveAttribute("data-tone", "wait");
  await expect(row("approve this")).toHaveAccessibleDescription(/^Shared Agent · 等你处理 等你批准 · 等待期限 剩余 \d+ 分$/u);
  await expect(page).toHaveTitle("(1) HarnessHub");
  // One running in another workspace forms a project of its own, with a breathing blue dot.
  const csrf = String((await (await context.request.get(origin + "/api/v1/auth/session")).json()).csrfToken);
  const write = (path: string, data: unknown) => context.request.post(origin + path, { headers: { Origin: origin, "X-CSRF-Token": csrf }, data });
  const other = join(fixture.root, "second-project"); await mkdir(other);
  const created = await write("/api/v1/sessions", { workspace: other, selection: { harnessId: "codex", controlId: "codex-native" }, commandId: "dl2-create-running" }); assert.equal(created.status(), 201);
  const running = String((await created.json()).id);
  assert.equal((await write("/api/v1/sessions/" + running + "/messages", { text: "等待取消 长任务", commandId: "dl2-send-running" })).status(), 202);
  // The page reads the state again when it comes back into view (ADR-050), and so learns of it.
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await expect(row("等待取消 长任务").locator(".status-dot")).toHaveAttribute("data-tone", "run", { timeout: 15000 });
  await expect(row("等待取消 长任务").locator(".status-dot")).toHaveAttribute("data-live", "");
  // Two projects, named by their folders with the full path on hover; inside the default one, the waiting conversation leads.
  const projects = navigation.locator(".session-group"), project = (name: string) => projects.filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(projects).toHaveCount(2);
  await expect(project("workspace").locator(".session-item")).toHaveCount(2);
  await expect(project("workspace").locator(".session-item").first()).toHaveAccessibleName("approve this");
  await expect(project("workspace").locator(".session-item").nth(1)).toHaveAccessibleName("FAIL_ONCE 第一段");
  await expect(project("second-project").locator(".session-item")).toHaveCount(1);
  // Spaced as every row of the sidebar is, the projects start 2 px under their heading (Sidebar board).
  const heading = await navigation.getByRole("heading", { name: "项目", exact: true }).boundingBox(), firstProject = await projects.first().getByRole("button").first().boundingBox();
  assert.equal(Math.round(firstProject!.y - heading!.y - heading!.height), 2);
  await row("second-project").hover(); await expect(page.locator(".tooltip-pop")).toHaveText(other); await page.mouse.move(900, 600);
  // A project closes and opens; closed, it still shows its most pressing state and how many conversations it holds.
  await expect(row("workspace")).toHaveAttribute("aria-expanded", "true");
  await row("workspace").click(); await expect(row("workspace")).toHaveAttribute("aria-expanded", "false");
  await expect(project("workspace").locator(".session-item")).toHaveCount(0);
  await expect(row("workspace").locator(".status-dot")).toHaveAttribute("data-tone", "wait"); await expect(row("workspace")).toContainText("2");
  await expect(row("workspace")).toHaveAccessibleDescription("2 个对话，有等你处理的");
  await row("workspace").click(); await expect(project("workspace").locator(".session-item")).toHaveCount(2);
  await page.mouse.move(900, 600); await page.screenshot({ path: join(artifact, "dl2-sidebar-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl2-sidebar-dark-1440.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  // From another conversation, the inbox reads what the request asks; until that read is back the item says its state in
  // the words every place uses (ADR-054 补充 G). Its one-time option is sent from there, and the marks leave.
  const waitingId = ((await (await context.request.get(origin + "/api/v1/state")).json()) as { sessions: { id: string; title: string }[] }).sessions.find(item => item.title === "approve this")?.id;
  assert.ok(waitingId); let release = () => {}; const read = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/sessions/" + waitingId, async route => { await read; await route.fallback(); });
  await row("新对话").click();
  await row("等你处理（1 项）").click();
  const inbox = page.locator(".inbox-pop");
  // It opens on the most urgent item, so ⏎ opens that conversation and tab reaches its one-time option.
  await expect(inbox.getByRole("button", { name: /approve this/u })).toBeFocused();
  await expect(inbox.locator("[id^='inbox-']")).toHaveText(["Shared Agent 等你批准"]);
  release(); await page.unroute("**/api/v1/sessions/" + waitingId);
  await expect(inbox).toContainText("Shared Agent：rm -rf build"); await expect(inbox).toContainText(/approve this·等你批准 · 等待期限 剩余 \d+ 分/u);
  await expect(inbox.getByRole("button", { name: "Allow always" })).toHaveCount(0); await expect(inbox.getByRole("button", { name: "Deny" })).toHaveCount(0);
  await expect(inbox).toHaveCSS("opacity", "1"); await page.screenshot({ path: join(artifact, "dl2-inbox-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl2-inbox-dark-1440.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  // On a phone it is a sheet with its own way out; the conversation and the deadline take a line each there, so neither
  // is squeezed away. A window that becomes narrow closes the popover rather than turning it into the sheet.
  await page.setViewportSize({ width: 320, height: 844 }); await expect(inbox).toHaveCount(0);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("dialog", { name: "主导航" }).getByRole("button", { name: "等你处理（1 项）", exact: true }).click();
  const phoneInbox = page.getByRole("dialog", { name: "等你处理" });
  await expect(phoneInbox.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  assert.ok(((await phoneInbox.getByText("approve this", { exact: true }).boundingBox())?.width ?? 0) >= 60, "the conversation keeps its name in the narrow sheet");
  await expect(phoneInbox).toContainText(/approve this·等你批准 · 等待期限 剩余 \d+ 分/u);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the inbox sheet fits 320");
  await expect(phoneInbox).toHaveCSS("opacity", "1"); await page.screenshot({ path: join(artifact, "dl2-inbox-sheet-items-light-320.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl2-inbox-sheet-items-dark-320.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  await phoneInbox.getByRole("button", { name: "关闭等你处理", exact: true }).click();
  await expect(phoneInbox).toHaveCount(0); await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await row("等你处理（1 项）").click(); await expect(inbox.getByRole("button", { name: /approve this/u })).toBeFocused();
  await inbox.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(navigation.locator(".attention-count")).toHaveCount(0, { timeout: 15000 });
  await expect(inbox).toContainText("没有等你处理的审批或提问。"); await page.keyboard.press("Escape");
  await expect(row("approve this").locator(".status-dot[data-tone=wait]")).toHaveCount(0); await expect(page).toHaveTitle("HarnessHub");
  // Notifications on, out of sight: a Turn that finishes is announced without a sound, with the Agent and the time only.
  await row("新对话").click(); await pick("Codex"); await hide(true); await send("后台完成的一轮");
  await expect.poll(async () => (await notices()).length, { timeout: 15000 }).toBe(1);
  const [done] = await notices();
  assert.equal(done!.title, "Codex 做完了"); assert.equal(done!.silent, true); assert.match(done!.body, /^用时 \d+ 秒$/u);
  await hide(false);
  // Agent counts updates only once the Gateway reports one.
  update = true; await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await expect(row("Harness 1 个更新")).toBeVisible({ timeout: 15000 });
  // Reduced motion stops the breathing; the dot stays.
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await row("等待取消 长任务").locator(".status-dot").evaluate(dot => getComputedStyle(dot).animationName), "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // On a narrow screen the sidebar is a drawer, opened and closed from the keyboard.
  await page.keyboard.press("ControlOrMeta+K"); await page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }).fill("设置"); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "dl2-settings-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl2-settings-dark-1440.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const menu = page.getByRole("button", { name: "打开导航", exact: true });
    await menu.focus(); await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "主导航" });
    await expect(drawer.getByRole("button", { name: "等待取消 长任务", exact: true })).toBeVisible();
    // Opened from the keyboard it is in place at once, from the next frame (ADR-054 §3).
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "the drawer fits " + width);
    await page.screenshot({ path: join(artifact, `dl2-drawer-light-${width}.png`), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, `dl2-drawer-dark-${width}.png`), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape"); await expect(drawer).toHaveCount(0); await expect(menu).toBeFocused();
  }
  // A drawer left open while the window was wide in between does not open again by itself.
  await page.getByRole("button", { name: "打开导航", exact: true }).click(); await expect(page.getByRole("dialog", { name: "主导航" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 }); await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0); await expect(navigation).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 }); await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
  // There, the inbox entry closes the drawer and opens the inbox as a sheet of its own, which takes the keyboard.
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("dialog", { name: "主导航" }).getByRole("button", { name: "等你处理", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "等你处理" });
  await expect(sheet).toContainText("没有等你处理的审批或提问。"); await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
  await expect.poll(() => sheet.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expect(sheet).toHaveCSS("opacity", "1"); await expect.poll(async () => (await sheet.boundingBox())?.y).toBeGreaterThan(400);
  await page.screenshot({ path: join(artifact, "dl2-inbox-sheet-light-320.png"), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0);
  assert.equal((await write("/api/v1/sessions/" + running + "/cancel", { commandId: "dl2-cancel-running" })).status(), 202);
  // The red dot is what this page saw: once that conversation moves on out of sight, its next Turn may end otherwise, so
  // the dot leaves rather than stays stale.
  await page.setViewportSize({ width: 1440, height: 900 }); await expect(row("FAIL_ONCE 第一段").locator(".status-dot")).toHaveAttribute("data-tone", "fail");
  const failedOnce = ((await (await context.request.get(origin + "/api/v1/state")).json()) as { sessions: { id: string; title: string }[] }).sessions.find(item => item.title === "FAIL_ONCE 第一段");
  assert.ok(failedOnce); assert.equal((await write("/api/v1/sessions/" + failedOnce.id + "/messages", { text: "第二段", commandId: "dl2-send-again" })).status(), 202);
  await expect.poll(async () => { await page.evaluate(() => { window.dispatchEvent(new Event("focus")); }); return row("FAIL_ONCE 第一段").locator(".status-dot").count(); }, { timeout: 15000 }).toBe(0);
  assert.deepEqual(errors, []);
});

test("G054-DL9 the application's shortcuts open what they name, ⌥⌘↓ goes through what waits for you, the sheet lists every shortcut, and ⌘N, ⌘T, ⌘W and composition are left alone", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const origin = new URL(fixture.gateway.url).origin;
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  await page.goto(fixture.gateway.url);
  const navigation = page.getByRole("complementary", { name: "主导航" });
  await expect(navigation.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  // ⌘N, ⌘T and ⌘W stay the browser's, with ⌘ or Ctrl; and nothing runs while an input method composes.
  const prevented = await page.evaluate(() => ["n", "t", "w"].flatMap(key => [{ metaKey: true }, { ctrlKey: true }].map(modifier => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifier }); document.body.dispatchEvent(event); return event.defaultPrevented; })));
  assert.deepEqual(prevented, [false, false, false, false, false, false]);
  await page.evaluate(() => { for (const key of ["k", "/", "ArrowDown"]) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, altKey: key === "ArrowDown", isComposing: true, bubbles: true, cancelable: true })); });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Nor do ⇧⌘O and ⌘B while composing: away from the conversation the page stays, and so does the sidebar. ⌘. is the
  // conversation's stop key alone (ADR-054 §5): outside a conversation it does nothing, and never opens or closes the
  // details panel, as the application's ⌘. once did.
  const heading = page.getByRole("heading", { name: "设置", exact: true }), panel = () => page.evaluate(() => localStorage.getItem("harnesshub:preferences"));
  await navigation.getByRole("button", { name: "设置", exact: true }).click(); await expect(heading).toBeVisible();
  await page.evaluate(() => { for (const [key, shiftKey] of [["o", true], ["b", false]] as const) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, shiftKey, isComposing: true, bubbles: true, cancelable: true })); });
  await expect(heading).toBeVisible(); await expect(navigation).toBeVisible();
  const before = await panel(); await page.keyboard.press("ControlOrMeta+."); await expect(heading).toBeVisible(); assert.equal(await panel(), before);
  // ⌘B hides the sidebar and brings it back. A control of the page keeps focus; one in the sidebar leaves with it, and
  // focus moves to the button that shows the sidebar again, then to the one that hides it: the keyboard keeps its place.
  const frozen = page.getByRole("switch", { name: FROZEN_SWITCH }), expand = page.locator("#main-content").getByRole("button", { name: "展开侧栏", exact: true });
  const collapse = navigation.getByRole("button", { name: "收起侧栏", exact: true });
  await frozen.focus();
  await page.keyboard.press("ControlOrMeta+B"); await expect(navigation).toHaveCount(0); await expect(frozen).toBeFocused();
  await page.keyboard.press("ControlOrMeta+B"); await expect(navigation).toBeVisible(); await expect(frozen).toBeFocused();
  await navigation.getByRole("button", { name: "设置", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+B"); await expect(navigation).toHaveCount(0); await expect(expand).toBeFocused();
  await page.keyboard.press("ControlOrMeta+B"); await expect(navigation).toBeVisible(); await expect(collapse).toBeFocused();
  // The two buttons do the same from the keyboard.
  await page.keyboard.press("Enter"); await expect(navigation).toHaveCount(0); await expect(expand).toBeFocused();
  await page.keyboard.press("Enter"); await expect(navigation).toBeVisible(); await expect(collapse).toBeFocused();
  // So does the palette's command: the palette gives focus back to the button it was opened from, which then leaves.
  const command = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true });
  await page.keyboard.press("ControlOrMeta+K"); await command.fill("收起侧栏"); await command.press("Enter");
  await expect(navigation).toHaveCount(0); await expect(expand).toBeFocused();
  await page.keyboard.press("ControlOrMeta+K"); await command.fill("展开侧栏"); await command.press("Enter");
  await expect(navigation).toBeVisible(); await expect(collapse).toBeFocused();
  // ⌘/ lists every shortcut in the board's words, each key as its own cap, with what the browser keeps. Stopping a reply
  // also takes esc in the composer, so its row gives both.
  await page.keyboard.press("ControlOrMeta+/");
  const sheet = page.getByRole("dialog", { name: "快捷键" });
  for (const [label, keys, caps = [...keys.matchAll(/[A-Za-z]{2,}|\S/gu)].length] of [["新对话", "⇧⌘O"], ["搜索与命令", "⌘K"], ["换 Harness", "⌘J"], ["停止当前回复", "⌘.或esc", 3], ["打开或收起详情面板", "⌘\\"],
    ["下一件“等你处理”", "⌥⌘↓"], ["允许一次", "⏎"], ["拒绝这次请求", "esc"], ["编辑上一条（输入框为空时）", "↑"], ["原生命令 · 引用文件", "/@"], ["全部快捷键", "⌘/"], ["关闭弹出层", "esc"]] as readonly (readonly [string, string, number?])[]) {
    const line = sheet.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
    await expect(line).toHaveText(label + keys); await expect(line.locator("kbd")).toHaveCount(caps);
  }
  await expect(sheet).toContainText("浏览器保留 ⌘N、⌘T、⌘W，所以不占用它们。“这个对话都允许”不绑快捷键，只能点选。");
  await page.screenshot({ path: join(artifact, "dl9-shortcuts-light-1440.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, "dl9-shortcuts-dark-1440.png"), animations: "disabled" }); await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0);
  // ⌘K finds commands with their keys beside them; ⌘/ swaps it for the sheet.
  await page.keyboard.press("ControlOrMeta+K");
  const search = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }); await expect(search).toBeFocused();
  await search.fill("下一件"); await expect(page.getByRole("option", { name: /^下一件“等你处理”/u })).toContainText("⌥⌘↓");
  // The details panel's command carries its key, ⌘\, not the ⌘. it once had.
  await search.fill("详情面板"); await expect(page.getByRole("option", { name: /详情面板/u })).toHaveText(/详情面板⌘\\$/u);
  // Its old name, Agent, still finds the Harness page (as 我的 Agent does); its name finds it first.
  await search.fill("Agent"); await expect(page.getByRole("option", { name: /^Harness/u })).toBeVisible();
  await search.fill("Harness"); await expect(page.getByRole("option").first()).toHaveAccessibleName(/^Harness/u);
  await page.screenshot({ path: join(artifact, "dl9-palette-light-1440.png"), animations: "disabled" });
  await page.keyboard.press("ControlOrMeta+/"); await expect(sheet).toBeVisible(); await expect(page.locator(".palette-pop")).toHaveCount(0);
  // The sheet takes the keyboard from the palette it replaced: esc closes it, and nothing stays open behind it.
  await expect.poll(() => sheet.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(page.getByRole("dialog")).toHaveCount(0);
  // ⌥⌘↓ with nothing waiting says so.
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
  await expect(page.getByText("没有等你处理的事", { exact: true })).toBeVisible();
  // Two conversations in two workspaces wait for approvals; ⌥⌘↓ opens the most urgent first, then the next, then comes back round.
  const csrf = String((await (await context.request.get(origin + "/api/v1/auth/session")).json()).csrfToken);
  const write = (path: string, data: unknown) => context.request.post(origin + path, { headers: { Origin: origin, "X-CSRF-Token": csrf }, data });
  const ids: string[] = [];
  for (const name of ["first", "second"]) {
    const workspace = join(fixture.root, "wait-" + name); await mkdir(workspace);
    const created = await write("/api/v1/sessions", { workspace, selection: { harnessId: "native-acp", controlId: "native-acp" }, commandId: "dl9-create-" + name }); assert.equal(created.status(), 201);
    const id = String((await created.json()).id); ids.push(id);
    assert.equal((await write("/api/v1/sessions/" + id + "/messages", { text: "approve " + name, commandId: "dl9-send-" + name })).status(), 202);
    await expect(navigation.locator(".attention-count")).toHaveText(String(ids.length), { timeout: 15000 });
  }
  await expect(page).toHaveTitle("(2) HarnessHub");
  for (const index of [0, 1, 0]) {
    await page.keyboard.press("ControlOrMeta+Alt+ArrowDown");
    await expect(page).toHaveURL(new RegExp("#session=" + ids[index]! + "$", "u"));
    await expect(navigation.getByRole("button", { name: "approve " + (index ? "second" : "first"), exact: true })).toHaveAttribute("aria-current", "page");
  }
  // ⇧⌘O opens a new conversation from anywhere.
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page).not.toHaveURL(/#session=/u);
  await expect(navigation.locator("[aria-current=page]")).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("G054-FR6 the chosen theme and its theme color apply before the first paint and survive reload, dark pages fit narrow screens with open collapsibles and uncut status words, the end dot follows a reply's last block, and reduced motion and the keyboard stop transitions", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [], fonts: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  page.on("request", request => { if (/^https:\/\/fonts\.(?:googleapis|gstatic)\.com\//u.test(request.url())) fonts.push(request.url()); });
  // The browser's theme color (its window or tab bar) is the first theme-color whose media matches; it is also read once
  // the page's scripts have run, before the application has drawn anything.
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    (window as unknown as { __loadedThemeColor: string | null }).__loadedThemeColor = [...document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color']")].find(meta => !meta.media || matchMedia(meta.media).matches)?.content ?? null;
  }, { once: true }));
  const themeColor = () => page.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color']")].find(meta => !meta.media || matchMedia(meta.media).matches)?.content ?? null);
  const loadedThemeColor = () => page.evaluate(() => (window as unknown as { __loadedThemeColor: string | null }).__loadedThemeColor);
  await page.goto(fixture.gateway.url);
  // Without a choice the theme color is the light main area of a light system.
  assert.deepEqual([await loadedThemeColor(), await themeColor()], ["#FFFFFF", "#FFFFFF"]);
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
  // The dark main area of ADR-054 §1 (#18191C), and the theme color with it although the system is light.
  assert.equal(await background(), "rgb(24, 25, 28)");
  await expect.poll(themeColor).toBe("#18191C");
  await page.reload(); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // After a reload the chosen theme color is in place as soon as the scripts have run, together with the theme.
  assert.deepEqual([await loadedThemeColor(), await themeColor()], ["#18191C", "#18191C"]);
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await page.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter"); await expect(page.getByRole("log", { name: "对话历史" })).toContainText("原生活动已完成。");
  for (const target of ["chat", "harnesses", "settings"] as const) {
    if (target === "harnesses") await page.getByRole("button", { name: "Harness", exact: true }).click();
    if (target === "settings") await page.getByRole("button", { name: "设置", exact: true }).click();
    if (target === "harnesses") {
      // #07: a state's box is held at its words' width rounded up, never cut by a fraction of a pixel. The shown words are
      // made a little wider, to a width ending in a small fraction that rounding to the nearest pixel would cut; words that
      // change while this runs are new words, made wider the same way.
      await expect.poll(() => page.evaluate(() => {
        const layer = document.querySelector<HTMLElement>(".agent-card .swap-text > .swap-text-layer:not(.swap-text-out)")!, box = layer.parentElement!;
        if (layer.dataset.fraction === undefined) { layer.style.width = (Math.floor(parseFloat(getComputedStyle(layer).width)) + 1.05).toFixed(2) + "px"; layer.dataset.fraction = ""; }
        const words = parseFloat(getComputedStyle(layer).width);
        return box.style.width === Math.ceil(words) + "px" ? "held at the words rounded up" : box.style.width + " for words of " + words + "px";
      })).toBe("held at the words rounded up");
      await page.evaluate(() => { for (const layer of document.querySelectorAll<HTMLElement>(".swap-text-layer[data-fraction]")) { layer.style.width = ""; delete layer.dataset.fraction; } });
    }
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${target} overflows at ${width} in the dark theme`);
      await page.screenshot({ path: join(artifact, `dark-${target}-${width}.png`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  // An open collapsible keeps to the width it is given: a long unbroken row inside is cut short instead of widening the page.
  await page.setViewportSize({ width: 320, height: 844 });
  assert.deepEqual(await page.evaluate(() => {
    const frame = document.createElement("div");
    frame.innerHTML = "<div class='collapsible' data-open='true' data-state='open'><div class='collapsible-inner'><div style='overflow: hidden; white-space: nowrap; text-overflow: ellipsis'>"
      + "一行很长而且没有断开的步骤说明".repeat(30) + "</div></div></div>";
    document.body.append(frame);
    const row = frame.querySelector(".collapsible-inner > div")!, result = { page: document.documentElement.scrollWidth <= innerWidth, row: row.getBoundingClientRect().width <= frame.clientWidth };
    frame.remove(); return result;
  }), { page: true, row: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // #11: the end dot follows a reply's last block as react-markdown renders it: at the end of the last line of a heading,
  // a quote's last paragraph or a list item, and on its own line after a code block or a table, also inside a list item or
  // a quote. That line starts right under the block, a table's as a code block's. Once done, the reply ends at its last
  // line, as the Conversation board's list does, and a quote at its own. Each reply sits in a column as in a Turn, which
  // keeps its children's margins inside it.
  assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries({
    heading: "<p>第一段。</p>\n<h2>流式标题</h2>", quote: "<blockquote>\n<p>引用的第一段</p>\n<p>引用的最后一段</p>\n</blockquote>",
    list: "<ul>\n<li>读取工作区</li>\n<li>修改文件</li>\n</ul>", loose: "<ul>\n<li>\n<p>读取工作区</p>\n</li>\n<li>\n<p>修改文件</p>\n</li>\n</ul>",
    nested: "<ul>\n<li>读取工作区\n<ul>\n<li>子步骤</li>\n</ul>\n</li>\n</ul>",
    code: "<h2>流式标题</h2>\n<div class='code-block'><div class='code-block-head'><span>typescript</span></div><pre><code>const answer = \"par</code></pre></div>",
    table: "<p>表格：</p>\n<div class='table-scroll'><table><thead><tr><th>项目</th><th>状态</th></tr></thead><tbody><tr><td>SSE</td><td>进行中</td></tr></tbody></table></div>",
    listCode: "<ul>\n<li>\n<p>运行：</p>\n<div class='code-block'><pre><code>pnpm test</code></pre></div>\n</li>\n</ul>",
    quoteCode: "<blockquote>\n<p>引用：</p>\n<div class='code-block'><pre><code>pnpm test</code></pre></div>\n</blockquote>",
    quoteThen: "<blockquote>\n<p>引用的一段</p>\n</blockquote>\n<p>之后的一段。</p>",
  }).map(([name, html]) => {
    const turn = document.createElement("article"), reply = document.createElement("div"); turn.className = "flex flex-col";
    reply.className = "markdown text-reading caret-host"; reply.innerHTML = html; turn.append(reply); document.body.append(turn);
    // From the end of a block's content to the end of its last child.
    const under = (node: Element) => { const style = getComputedStyle(node); return Math.round(node.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth) - node.lastElementChild!.getBoundingClientRect().bottom); };
    const marked = [reply, ...reply.querySelectorAll("*")].filter(node => getComputedStyle(node, "::after").content !== "none"), height = reply.getBoundingClientRect().height;
    const places = marked.map(node => node === reply ? "reply" : node.tagName.toLowerCase()), lines = marked.map(node => node.lastElementChild ? under(node) : null);
    reply.classList.remove("caret-host"); const own = reply.getBoundingClientRect().height, ends = [under(reply), ...[...reply.querySelectorAll("blockquote")].map(under)]; turn.remove();
    return [name, [...places.map((place, index) => place + (height > own ? ` on its own line ${lines[index]} px under the block` : "")), "ends " + ends.join(" / ") + " px under its last block"]];
  }))), { heading: ["h2", "ends 0 px under its last block"], quote: ["p", "ends 0 / 0 px under its last block"], list: ["li", "ends 0 px under its last block"],
    loose: ["p", "ends 0 px under its last block"], nested: ["li", "ends 0 px under its last block"], code: ["reply on its own line 26 px under the block", "ends 0 px under its last block"],
    table: ["reply on its own line 26 px under the block", "ends 0 px under its last block"], listCode: ["li on its own line 26 px under the block", "ends 0 px under its last block"],
    quoteCode: ["blockquote on its own line 26 px under the block", "ends 0 / 0 px under its last block"], quoteThen: ["p", "ends 0 / 0 px under its last block"] });

  // ADR-054 §3 for the classes that carry motion: the longest transition of each, in ms, and the end dot's loop. A chevron
  // turns on the `rotate` property that rotate-90 sets: the moment the angle changes, it still shows the old one.
  const motions = () => page.evaluate(() => {
    const holder = document.createElement("div"), longest = (node: Element) => Math.max(...getComputedStyle(node).transitionDuration.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)));
    holder.innerHTML = "<div class='motion-rotate'></div><div class='collapsible' data-open='true'></div><div class='backdrop'></div><div class='floating-bar'></div><div class='markdown caret-host'><p>正在写</p></div>";
    document.body.append(holder);
    const [chevron, collapsible, veil, bar, reply] = [...holder.children], from = getComputedStyle(chevron!).rotate; chevron!.classList.add("rotate-90");
    const dot = getComputedStyle(reply!.querySelector("p")!, "::after"), result = {
      chevron: [getComputedStyle(chevron!).transitionProperty, longest(chevron!), from, getComputedStyle(chevron!).rotate], collapsible: longest(collapsible!),
      veil: [getComputedStyle(veil!).transitionProperty, longest(veil!)], bar: [getComputedStyle(bar!).transitionProperty, longest(bar!)], dot: [dot.animationName, dot.animationIterationCount] };
    holder.remove(); return result;
  });
  const pointer = await motions();
  assert.notEqual(pointer.chevron[3], "90deg", "a chevron turns instead of jumping");
  assert.deepEqual({ ...pointer, chevron: pointer.chevron.slice(0, 3) }, { chevron: ["rotate", 200, "none"], collapsible: 200, veil: ["opacity", 200], bar: ["opacity, transform", 300], dot: ["hh-end-dot", "infinite"] });
  // #37: from the keyboard the same changes are instant; the dot keeps breathing, as nothing the keyboard did started it.
  await page.keyboard.press("Shift");
  assert.deepEqual(await motions(), { chevron: ["rotate", 0, "none", "90deg"], collapsible: 0, veil: ["opacity", 0], bar: ["opacity, transform", 0], dot: ["hh-end-dot", "infinite"] });
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
  // #38 with the pointer: the chevron and the collapsible change at once, the veil and the bar only fade, the end dot is still.
  assert.deepEqual(await motions(), { chevron: ["rotate", 0, "none", "90deg"], collapsible: 0, veil: ["opacity", 120], bar: ["opacity", 120], dot: ["none", "1"] });
  await page.getByRole("radio", { name: /跟随系统/u }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/u);
  // Following the system again, the theme color follows its changes; a manual light choice keeps light under a dark system.
  await expect.poll(themeColor).toBe("#FFFFFF");
  await page.emulateMedia({ colorScheme: "dark" }); await expect.poll(themeColor).toBe("#18191C");
  await page.getByRole("radio", { name: /浅色/u }).click(); await expect.poll(themeColor).toBe("#FFFFFF");
  await page.getByRole("radio", { name: /跟随系统/u }).click(); await expect.poll(themeColor).toBe("#18191C");
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
  // Dialogs, drawers and sheets sit on a veil of the sidebar's color at 60 % (the Capabilities board's write preview).
  const tokens = () => page.evaluate(() => {
    const probe = document.createElement("i"), well = document.createElement("span"), app = document.createElement("span"), mono = document.createElement("img"), veil = document.createElement("div");
    well.className = "brand-tile"; well.dataset.kind = "mark"; app.className = "brand-tile"; app.dataset.kind = "app"; mono.className = "brand-mono"; veil.className = "backdrop";
    document.body.append(probe, well, app, mono, veil);
    const color = (name: string) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const names = ["--bg-sidebar", "--bg-app", "--bg-surface", "--bg-subtle", "--bg-hover", "--bg-selected", "--text", "--text-2", "--text-3", "--accent", "--accent-text", "--on-accent", "--amber-dot", "--amber", "--red-dot", "--red", "--add-text"];
    probe.style.boxShadow = "var(--sh-composer)";
    const result = { ...Object.fromEntries(names.map(name => [name, color(name)])), page: getComputedStyle(document.body).backgroundColor, composer: getComputedStyle(probe).boxShadow,
      well: getComputedStyle(well).backgroundColor, app: getComputedStyle(app).backgroundColor, mono: getComputedStyle(mono).filter, veil: getComputedStyle(veil).backgroundColor, theme: document.documentElement.getAttribute("data-theme") };
    probe.remove(); well.remove(); app.remove(); mono.remove(); veil.remove(); return result;
  });
  assert.deepEqual(await tokens(), {
    "--bg-sidebar": "rgb(249, 250, 251)", "--bg-app": "rgb(255, 255, 255)", "--bg-surface": "rgb(255, 255, 255)", "--bg-subtle": "rgb(244, 245, 247)", "--bg-hover": "rgb(235, 237, 240)",
    "--bg-selected": "rgba(38, 49, 72, 0.07)", "--text": "rgb(15, 17, 21)", "--text-2": "rgb(75, 80, 89)", "--text-3": "rgb(100, 105, 115)", "--accent": "rgb(58, 106, 224)",
    "--accent-text": "rgb(47, 95, 208)", "--on-accent": "rgb(255, 255, 255)", "--amber-dot": "rgb(245, 158, 11)", "--amber": "rgb(180, 83, 9)", "--red-dot": "rgb(239, 68, 68)",
    "--red": "rgb(220, 38, 38)", "--add-text": "rgb(21, 128, 61)", page: "rgb(255, 255, 255)",
    composer: "rgba(0, 0, 0, 0.1) 0px 0px 0px 0.5px, rgba(0, 0, 0, 0.03) 0px 4px 16px 0px, rgba(0, 0, 0, 0.03) 0px 0px 24px 0px",
    well: "rgb(255, 255, 255)", app: "rgba(0, 0, 0, 0)", mono: "none", veil: "color(srgb 0.976471 0.980392 0.984314 / 0.6)", theme: null });
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
    well: "rgb(42, 43, 47)", app: "rgba(0, 0, 0, 0)", mono: "invert(1)", veil: "color(srgb 0.0666667 0.0705882 0.0784314 / 0.6)", theme: null });
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

/**
 * How a maintenance confirmation is spaced: as the capability dialogs, after the Capabilities board's write preview, the
 * body's first block 18 px under the title block and 12 px between blocks, the buttons 14 px below the body and 18 px
 * above the edge, with no rule between them (Base UI titles a dialog with an h2). `squeezed` counts the body's blocks
 * that would be drawn shorter than without the body's height limit if they clipped their overflow, which lets a block of
 * a flex column shrink below its content: a body taller than its limit must scroll instead. The probe's styles are put
 * back before it returns.
 */
function confirmationGeometry(dialog: ReturnType<Page["getByRole"]>) {
  return dialog.evaluate(element => {
    const title = element.querySelector("h2")!.parentElement!, body = title.nextElementSibling as HTMLElement, footer = body.nextElementSibling!, style = getComputedStyle(footer);
    const blocks = [...body.children] as HTMLElement[], heights = () => blocks.map(block => block.getBoundingClientRect().height);
    for (const block of blocks) block.style.overflow = "hidden";
    const limited = heights(); body.style.maxHeight = "none"; const natural = heights();
    body.style.maxHeight = ""; for (const block of blocks) block.style.overflow = "";
    return { first: Math.round(blocks[0]!.getBoundingClientRect().top - title.getBoundingClientRect().bottom + body.scrollTop), gap: getComputedStyle(body).rowGap,
      footer: [style.borderTopWidth, style.paddingTop, style.paddingBottom], squeezed: limited.filter((height, index) => height + 0.5 < natural[index]!).length };
  });
}
const CONFIRMATION_GEOMETRY = { first: 18, gap: "12px", footer: ["0px", "14px", "18px"], squeezed: 0 };

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
  await page.getByRole("button", { name: "Harness 1 个更新", exact: true }).click();
  const row = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }) });
  // Something in a Turn, or another HarnessHub process, blocks: said before anything runs, and the upgrade cannot be confirmed.
  await row.getByRole("button", { name: "升级到 2026.10.2", exact: true }).click();
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
  await row.getByRole("button", { name: "升级到 2026.10.2", exact: true }).click();
  await expect(dialog.getByText("2026.3.23-2 → 2026.10.2")).toBeVisible();
  for (const text of ["沿用原来的 npm 全局安装，把 OpenClaw 从 2026.3.23-2 升级到 2026.10.2。",
    "OpenClaw Gateway（ai.openclaw.gateway，进程 4039）会在新版本核实后立即重启：", "launchctl kickstart -k gui/501/ai.openclaw.gateway", "1 个对话保留的 OpenClaw 进程会先关闭，下次发消息时重新连接。",
    "OpenClaw Node（ai.openclaw.node，进程 4736），升级后可运行 openclaw node restart", "openclaw（进程 8100）", "还会清除 2 条已结束的 HarnessHub 进程留下的使用记录。",
    "已安装的插件：openclaw-weixin。新版本可能不兼容它们。", "最好选一个能接受短暂中断的时间升级", "npm install --global openclaw@2026.3.23-2"]) await expect(dialog).toContainText(text);
  // Seven months apart, and a target no record names: the versions are stated, and nothing is inferred from them (ADR-053).
  for (const text of ["相隔", "还没有验证", "验证过的版本"]) await expect(dialog).not.toContainText(text);
  // A service left running only needs a newer Node.js before its own restart: said, without blocking.
  await expect(dialog.locator(".upgrade-runtime-warning")).toHaveText("OpenClaw Node（ai.openclaw.node）启动用的 Node.js 是 25.9.0（/opt/homebrew/opt/node@25/bin/node），2026.10.2 要求 >=24.16.0 <25 || >=26.1.0。升级后重启它之前，需要先升级这个 Node.js（brew upgrade node@25）。");
  // Spaced as every confirmation is, the capability dialogs' write preview first among them.
  assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
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
  await openAdvanced(page); await page.getByRole("checkbox", { name: "保持原生进程" }).click(); await page.keyboard.press("Escape");
  await reply("first", 1);
  assert.equal((await current()).retention.process?.harnessId, "native-acp");
  assert.equal(await fixture.runtime().releaseForUpgrade("native-acp"), 1);
  const notice = "升级 Kept Agent 前，HarnessHub 关闭了这个对话保留的后台进程。下一条消息会用新版本重新启动原程序，并恢复原生会话。";
  await expect(page.locator("#composer-notice")).toHaveText(notice);
  const closed = await current();
  assert.equal(closed.retention.process, null); assert.equal(closed.retention.upgraded.harnessId, "native-acp");
  const events = await (await context.request.get(origin + "/api/v1/sessions/" + closed.id + "/events?afterSeq=0&limit=100")).json();
  assert.deepEqual(events.events.filter((event: { type: string }) => event.type === "native.process_closed").map((event: { data: { reason: string; cleanup: { closed: boolean } } }) => [event.data.reason, event.data.cleanup.closed]), [["harness_upgrade", true]]);
  // The details panel is closed until opened (ADR-054 decision E); at this width its button opens it beside the conversation.
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
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
  await page.getByRole("button", { name: "Harness 1 个更新", exact: true }).click();
  const row = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }) });
  await row.getByRole("button", { name: "升级到 2026.10.9", exact: true }).click();
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
  assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
  await page.screenshot({ path: join(artifact, "upgrade-sequence.png"), animations: "disabled" });
  // The longest confirmation of these fixtures, at 390 and 320: it stays inside the window, its body scrolls rather than
  // squeezing a block, nothing runs off to the side, and its last block scrolls into view whole.
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.deepEqual(await dialog.evaluate(element => {
      const box = element.getBoundingClientRect(), body = element.querySelector("h2")!.parentElement!.nextElementSibling!;
      const fits = { inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, scrolls: body.scrollHeight > body.clientHeight, across: body.scrollWidth <= body.clientWidth };
      body.scrollTop = body.scrollHeight;
      const last = body.lastElementChild!.getBoundingClientRect(), frame = body.getBoundingClientRect();
      return { ...fits, last: last.top >= frame.top - 1 && last.bottom <= frame.bottom + 1 };
    }), { inside: true, scrolls: true, across: true, last: true }, `the confirmation at ${width}`);
    assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
    for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, `upgrade-sequence-${scheme}-${width}.png`), animations: "disabled" }); }
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
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
  await page.getByRole("button", { name: "Harness", exact: true }).click();
  await page.getByRole("button", { name: "查看 Codex 详情", exact: true }).click();
  const codex = page.getByRole("dialog", { name: "Codex 详情" });
  await expect(codex.locator(".harness-installations li")).toHaveText([
    "npm 全局（nvm v26.11.1）当前使用0.162.1卸载…", "npm 全局（Homebrew 的 Node.js）0.160.0卸载…", "pnpm 全局0.150.0 · HarnessHub 不维护这种安装方式", "npm 全局（Homebrew 的 Node.js）接入口 codex-acp当前使用0.9.0卸载…"]);
  // Each maintained installation can be uninstalled on its own; a pnpm installation is listed only.
  await expect(codex.getByRole("button", { name: /^卸载/u })).toHaveCount(3);
  await expect(codex).toContainText("“当前使用”按 HarnessHub 服务进程的 PATH 顺序确定；终端常被 nvm 等改动 PATH，用的可能是另一份。");
  await expect(codex.locator(".harness-installations li").first().locator("[title]")).toHaveAttribute("title", "按 HarnessHub 服务进程的 PATH 顺序；终端里可能不同");
  // A development Gateway says it accepts unofficial entries; this fixture is one.
  await expect(page.locator(".development-entries")).toHaveText("开发模式：接受非官网安装。服务以 --allow-unofficial 启动，列表里的开发入口不是正式安装。");
  await expect(codex.locator(".harness-unofficial")).toHaveText("在 PATH 中发现一个非官网安装（开发目录、npm link 或其他），命令名 codex；平台不使用也不维护它。终端里 codex 运行的是这份非官网安装；HarnessHub 使用的是标为“当前使用”的官网安装。");
  // Pictured once the details have slid in.
  await expect.poll(() => codex.evaluate(element => getComputedStyle(element).opacity === "1" && getComputedStyle(element).transform === "none")).toBe(true);
  await page.screenshot({ path: join(artifact, "harness-installations.png"), animations: "disabled" });
  await codex.getByRole("button", { name: "关闭 Harness 详情" }).click();
  await page.getByRole("button", { name: "查看 DeepSeek Harness 详情", exact: true }).click();
  const dsh = page.getByRole("dialog", { name: "DeepSeek Harness 详情" });
  await expect(dsh.locator(".harness-unofficial")).toHaveText("在 PATH 中发现一个非官网安装（开发目录、npm link 或其他），命令名 dsh；平台不使用也不维护它。终端里能用的就是它。");
  await expect(dsh.locator(".harness-installations")).toHaveCount(0);
  await expect(dsh).toContainText("npm install -g @deepseek-ai/dsh"); await expect(dsh).toContainText("命令于 2026-10-17 对照官方说明核对。");
  await dsh.getByRole("button", { name: "关闭 Harness 详情" }).click();
  // The official page's own note travels with the product, installed or not. Frozen entries come last in "还可以安装".
  await page.getByRole("button", { name: /^显示全部/u }).click();
  await page.getByRole("button", { name: "查看 Gemini CLI 详情", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Gemini CLI 详情" }).locator(".harness-install-note")).toHaveText("官方仓库写明：自 2026-06-18 起，免费用户与 Google One 用户改用 Antigravity CLI。");
  assert.deepEqual(errors, []);
});

test("G054-UN1 uninstalling one installation first says what it stops, removes and keeps, and sends exactly that consent; a resident program blocks it", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  // Wide enough for the details to sit beside the cards with the sidebar shown (ADR-054 补充 C), which the confirmation then covers.
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
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
  await page.getByRole("button", { name: "Harness", exact: true }).click();
  await page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "OpenClaw 详情" });
  await detail.getByRole("button", { name: `卸载${label}里的 openclaw`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "卸载 OpenClaw" });
  // A resident program the uninstall cannot stop the product's way: said before anything runs, and nothing can be confirmed.
  await expect(dialog.getByText("现在不能卸载")).toBeVisible();
  await expect(dialog.locator(".uninstall-resident")).toHaveText("openclaw-node（进程 6576）正在运行，先运行 openclaw node stop 停止它，再卸载。");
  await expect(dialog.getByRole("button", { name: "停止服务并卸载" })).toBeDisabled();
  // While it closes (200 ms) the dialog keeps naming what it was opened for: its title never falls back to the generic word.
  await page.evaluate(() => {
    const seen: string[] = []; (window as unknown as { __closingTitles: string[] }).__closingTitles = seen;
    const read = () => { for (const node of document.querySelectorAll(".uninstall-dialog h2")) seen.push(node.textContent ?? ""); };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  const closingTitles = await page.evaluate(() => (window as unknown as { __closingTitles: string[] }).__closingTitles);
  assert.ok(closingTitles.length > 0 && closingTitles.every(title => title === "卸载 OpenClaw"), "the closing dialog kept its title: " + JSON.stringify([...new Set(closingTitles)]));
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
  assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
  await page.screenshot({ path: join(artifact, "uninstall-confirmation.png"), animations: "disabled" });
  // Opened from the details beside the cards, the confirmation sits over them: Escape closes it alone and sends nothing.
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(detail).toBeVisible(); assert.equal(submitted, null);
  await detail.getByRole("button", { name: `卸载${label}里的 openclaw`, exact: true }).click(); await expect(dialog.locator(".uninstall-after")).toBeVisible();
  await dialog.getByRole("button", { name: "停止服务并卸载" }).click(); await expect(dialog).toBeHidden();
  await expect.poll(() => submitted).not.toBeNull();
  const { commandId, ...consent } = submitted!;
  assert.match(String(commandId), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.deepEqual(consent, { harnessId: "openclaw", action: "uninstall", installation: ref, expectedInstallationFingerprint: fingerprint, stopServices: ["ai.openclaw.gateway"] }, "the consent is exactly what the confirmation showed");
  await expect(page.getByRole("dialog", { name: "OpenClaw 详情" }).locator(".installation-state")).toContainText("等待卸载");
  // While the task runs, its section is the state: the card's pill says it too, and nothing waits for the user.
  await expect(page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 OpenClaw 详情", exact: true }) }).locator(".status-pill")).toHaveText("等待卸载");
  await expect(page.getByRole("dialog", { name: "OpenClaw 详情" }).locator(".agent-health")).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "agents-task-running.png"), animations: "disabled" });
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
  await page.getByRole("button", { name: "Harness", exact: true }).click();
  const row = page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: "查看 DeepSeek Harness 详情", exact: true }) });
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
  assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
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
  // The sidebar counts the installation behind its channel's latest version as an update (ADR-054 S01).
  await page.getByRole("button", { name: "Harness 1 个更新", exact: true }).click();
  await page.getByRole("button", { name: "查看 Claude Code 详情", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Claude Code 详情" });
  // Each installation says what the last update check found; the one behind offers its exact newer version.
  await expect(detail.locator(".harness-installations li").nth(0)).toContainText("2.1.302 · 已是最新");
  await expect(detail.locator(".harness-installations li").nth(1)).toContainText("2.1.296 · 可升级到 2.1.305");
  await detail.getByRole("button", { name: `升级到 2.1.305：${label}里的 claude`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "升级 Claude Code" });
  // A conversation replying with it blocks the upgrade, and the conversation can be opened from there.
  await expect(dialog.locator(".upgrade-blocked")).toContainText("有 1 个 HarnessHub 对话正在使用这份安装");
  await expect(dialog.getByRole("button", { name: "正在回复的对话" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "升级", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  assert.equal(submitted, null, "nothing is sent while the upgrade is blocked");
  busy = false;
  await detail.getByRole("button", { name: `升级到 2.1.305：${label}里的 claude`, exact: true }).click();
  for (const text of ["2.1.296 → 2.1.305", "/opt/homebrew/bin/npm install --global --prefix /opt/homebrew @anthropic-ai/claude-code@2.1.305", "/opt/homebrew；其他位置都不能写。",
    "这些程序正在运行这份安装，不会被关闭，重开后才用新版本：claude（进程 4242）。", "升级后“当前使用”不变。"]) await expect(dialog).toContainText(text);
  // 2.1.305 is a version no record names: stated as the target, with nothing inferred from it (ADR-053).
  for (const text of ["还不是", "验证过的版本"]) await expect(dialog).not.toContainText(text);
  assert.deepEqual(await confirmationGeometry(dialog), CONFIRMATION_GEOMETRY);
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
  assert.deepEqual(await confirmationGeometry(terminal), CONFIRMATION_GEOMETRY);
  await terminal.getByRole("button", { name: "关闭", exact: true }).click(); await expect(terminal).toBeHidden();
  assert.deepEqual(errors, []);
});

test("G054-DL8 the Agent page gives each Agent a card with its version and channel, state, one sentence of facts and its actions, opens the details in a drawer, lists what can still be installed the official way, and fits 1440, 390 and 320 in both themes", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  // Three Agents on this Mac and every other catalog entry missing: Claude Code through npm under nvm and current; Codex from
  // Homebrew Cask with an update the Gateway reported; OpenClaw after a sequenced upgrade whose gateway did not come back.
  const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  type Shaped = { id: string; installations: unknown[]; controls: { available: boolean }[]; management: Record<string, unknown> };
  const shaped = (harness: Shaped) => {
    const { native: _unused, ...management } = harness.management;
    const here = (version: string, extra: Record<string, unknown>, installation: Record<string, unknown>) => ({ ...harness, installed: true, unofficial: null,
      controls: harness.controls.map((control, index) => ({ ...control, available: index === 0, reason: null })),
      management: { ...management, source: "system", installedVersion: version, programVersion: version, checkedAt, ...extra },
      installations: [{ ref: harness.id.padEnd(64, "0"), command: harness.id, version, role: "product", active: true, maintained: true, canUninstall: true, ...installation }] });
    if (harness.id === "claude") return here("2.1.316", { updateStatus: "current", latestVersion: "2.1.316" }, { channel: "npm", label: "npm 全局（nvm v26.13.0）", upgrade: "version", latest: { version: "2.1.316", source: "npm", checkedAt, error: null } });
    if (harness.id === "codex") return here("0.166.0", { updateStatus: "available", latestVersion: "0.167.0", native: { channel: "brew-cask", location: "/opt/homebrew/bin/codex", fingerprint: "c".repeat(64), canInstall: false, canUpgrade: true, reason: null } },
      { channel: "brew-cask", label: "Homebrew Cask", upgrade: "maintenance", latest: null });
    if (harness.id === "openclaw") return here("2026.10.9", { updateStatus: "current", latestVersion: "2026.10.9" }, { channel: "npm", label: "npm 全局（Homebrew 的 Node.js）", upgrade: "version", latest: { version: "2026.10.9", source: "npm", checkedAt, error: null } });
    return { ...harness, installed: false, installations: [], unofficial: null, controls: harness.controls.map(control => ({ ...control, available: false })), management: { ...management, source: "missing" } };
  };
  const cause = "OpenClaw Gateway 重新启动后 45 秒内没有在端口上监听；新版本已经装好，没有回滚。";
  const job = { id: "management-dddddddd-dddd-4ddd-8ddd-dddddddddddd", harnessId: "openclaw", controlId: "openclaw-native", action: "upgrade", status: "failed", phase: "failed", cancelRequested: false,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), updatedAt: new Date(Date.now() - 50 * 60_000).toISOString(), resolvedVersion: "2026.10.9", installationId: null, logCursor: 0,
    error: { code: "SERVICE_NOT_READY", message: cause },
    native: { channel: "npm", location: "/opt/homebrew/bin/openclaw", beforeVersion: "2026.10.2", actualVersion: "2026.10.9", dispatched: true, configurationPreserved: true, restartServices: ["ai.openclaw.gateway"], backupConfirmed: true,
      hops: [{ version: "2026.9.5", installed: true, doctor: "ok" }, { version: "2026.10.9", installed: true, doctor: "ok" }],
      services: [{ label: "ai.openclaw.gateway", outcome: "not_recovered", pid: null, ready: null }], configurationMigrated: ["~/.openclaw/openclaw.json"] } };
  // Claude Code's latest catalog read asked it to sign in, once the test says so; until then the Gateway's own reads stand.
  let claudeControl = "", signedOut = false;
  const readiness = (rows: unknown[]) => signedOut ? [...rows, { harnessId: "claude", controlId: claudeControl, state: "signed_out", checkedAt: Date.now() - 3 * 60_000 }] : rows;
  for (const path of ["**/api/v1/state", "**/api/v1/harnesses", "**/api/v1/harnesses/rescan", "**/api/v1/harnesses/check-updates"]) await page.route(path, async route => {
    const response = await route.fetch(), body = await response.json();
    claudeControl = ((Array.isArray(body) ? body : body.harnesses) as { id: string; controls: { id: string }[] }[]).find(harness => harness.id === "claude")?.controls[0]?.id ?? claudeControl;
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(shaped) : { ...body, harnesses: body.harnesses.map(shaped), jobs: [job], readiness: readiness(body.readiness) } });
  });
  await page.route("**/api/v1/harnesses/readiness", async route => { const response = await route.fetch(), body = await response.json(); await route.fulfill({ response, json: { ...body, readiness: readiness(body.readiness) } }); });
  await page.route("**/api/v1/installation-jobs?limit=50", route => route.fulfill({ json: [job] }));
  let submitted = 0;
  await page.route("**/api/v1/installation-jobs", async route => { if (route.request().method() !== "POST") return route.fallback(); submitted++; await route.abort(); });
  await page.route("**/api/v1/harnesses/codex/maintenance", route => route.fulfill({ json: { harnessId: "codex", checkedAt, fingerprint: "e".repeat(64), channel: "brew-cask", location: "/opt/homebrew/bin/codex",
    currentVersion: "0.166.0", targetVersion: "0.167.0", servicesKnown: true, restart: [], resident: [], processes: [], conversations: [], otherUsers: [], staleRecords: 0, plugins: [], notes: [], rollback: null, runtimes: [] } }));
  await page.goto(fixture.gateway.url);
  // The sidebar's entry is "Harness" (the user's decision of 2026-11-02), with or without its update count.
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: /^Harness\b/u }).click();
  const main = page.locator("#main-content");

  // A01: the page's title and what it is, with 检查更新 at the top right of the title block.
  const title = main.getByRole("heading", { level: 1, name: "Harness", exact: true }), lead = main.locator("#harnesses-title + p"), check = main.getByRole("button", { name: "检查更新", exact: true });
  await expect(title).toBeVisible();
  await expect(lead).toHaveText("这台 Mac 上的 3 个 Harness。用它们原来的安装和登录；升级、卸载都按官网的方式来。");
  const [titleBox, leadBox, checkBox, headerBox] = await Promise.all([title.boundingBox(), lead.boundingBox(), check.boundingBox(), main.locator("header").first().boundingBox()]);
  assert.ok(titleBox && leadBox && checkBox && headerBox);
  assert.ok(Math.abs(checkBox.x + checkBox.width - (headerBox.x + headerBox.width)) <= 1 && checkBox.y >= titleBox.y && checkBox.y + checkBox.height <= leadBox.y + leadBox.height + 1, "检查更新 sits at the right end of the title block");
  assert.deepEqual(await title.evaluate(element => { const style = getComputedStyle(element); return [style.fontSize, style.lineHeight, style.fontWeight]; }), ["28px", "36px", "600"]);
  // The board has no way back of its own (ADR-054 补充 D): the sidebar is it. With the sidebar shown on a wide screen no
  // bar sits above the page, and the title starts 44 px below the top, as on the board; hiding the sidebar brings a bar
  // holding the button that shows it again, and nothing else.
  await expect(main.getByRole("button", { name: "返回对话", exact: true })).toHaveCount(0);
  assert.equal(titleBox.y, 44, "the title starts at the board's top spacing");
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "收起侧栏", exact: true }).click();
  const expand = main.getByRole("button", { name: "展开侧栏", exact: true });
  await expect(expand).toBeVisible(); await expect(main.getByRole("button", { name: "返回对话", exact: true })).toHaveCount(0);
  assert.equal((await title.boundingBox())?.y, 56, "the title sits under the bar that shows the sidebar again");
  await expand.click(); await expect(page.getByRole("complementary", { name: "主导航" })).toBeVisible(); await expect(expand).toHaveCount(0);
  assert.equal((await title.boundingBox())?.y, 44);
  // From the keyboard the same round trip keeps its place: the button that hides the sidebar leaves with it and hands
  // focus to the bar's button that shows it again, which leaves in turn and hands it back.
  const collapse = page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "收起侧栏", exact: true });
  await collapse.focus(); await page.keyboard.press("Enter"); await expect(expand).toBeFocused();
  await page.keyboard.press("Enter"); await expect(collapse).toBeFocused(); assert.equal((await title.boundingBox())?.y, 44);

  // A02: one card per Agent: its mark, name, version · channel, state, one sentence of facts, and its actions; no count without a fact.
  const mine = main.getByRole("region", { name: "这台 Mac 上的 Harness" }), cards = mine.getByRole("article"), card = (name: string) => mine.getByRole("article", { name, exact: true });
  await expect(cards).toHaveCount(3);
  await expect(cards.locator("h3")).toHaveText(["Claude Code", "Codex", "OpenClaw"]);
  await expect.poll(() => cards.locator("img.brand-icon").evaluateAll(images => images.length === 3 && images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  await expect(cards.locator(".agent-meta")).toHaveText(["2.1.316 · npm（nvm）", "0.166.0 · Homebrew Cask", "2026.10.9 · npm（Homebrew Node）"]);
  await expect(cards.locator(".status-pill")).toHaveText(["就绪", "有更新", "需要处理"]);
  assert.deepEqual(await cards.locator(".status-pill").evaluateAll(pills => pills.map(pill => pill.getAttribute("data-tone"))), ["accent", "accent", "amber"]);
  // The sentence is about the Agent itself, as on the board; Codex's newer version is said once, by its pill and its button.
  await expect(cards.locator(".agent-summary")).toHaveText(["可以对话。模型和登录沿用它自己的配置。", "可以对话。模型和登录沿用它自己的配置。", "上次升级：已升级，服务未就绪。" + cause]);
  await expect(card("Codex").getByRole("button")).toHaveText(["升级到 0.167.0", "详情"]);
  await expect(card("Codex").getByText(/0\.167\.0/u)).toHaveCount(1);
  await expect(card("Claude Code").getByRole("button")).toHaveText(["详情"]); await expect(card("OpenClaw").getByRole("button")).toHaveText(["详情"]);
  await expect(cards.filter({ hasText: /\d+ 个模型|技能 \d+|MCP \d+|插件 \d+|¥|上下文/u })).toHaveCount(0);

  // A03: the details open in a sheet beside the cards, with the card marked: the state in the Gateway's words once, the
  // last task step by step, models and sign-in, maintenance per official installation, capabilities, and folded technical facts.
  await card("OpenClaw").getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "OpenClaw 详情" });
  const marked = main.locator(".agent-card").filter({ has: page.locator("h3", { hasText: /^OpenClaw$/u }) });
  await expect(drawer).toBeVisible(); await expect(marked).toHaveAttribute("data-selected", "true");
  await expect(drawer.locator(".agent-meta")).toHaveText("2026.10.9 · npm 全局（Homebrew 的 Node.js）");
  await expect(drawer.locator(".agent-health")).toHaveText("需要处理" + cause);
  const settled = (locator: ReturnType<Page["locator"]>) => expect.poll(() => locator.evaluate(element => { const style = getComputedStyle(element); return style.opacity === "1" && style.transform === "none"; })).toBe(true);
  await settled(drawer);
  // Beside the cards, as on the board: 360 px with a hairline and no scrim; the cards make way and stay usable.
  const beside = await drawer.evaluate(element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    // A 0.5 px hairline computes as 1 px on a 1x screen.
    return { width: box.width, right: innerWidth - box.right, shadow: style.boxShadow, hairline: style.borderLeftStyle === "solid" && parseFloat(style.borderLeftWidth) <= 1, modal: element.getAttribute("aria-modal"), scrim: document.querySelector(".backdrop") !== null }; });
  assert.deepEqual(beside, { width: 360, right: 0, shadow: "none", hairline: true, modal: null, scrim: false });
  const sheetLeft = await drawer.evaluate(element => element.getBoundingClientRect().left);
  for (const right of await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right))) assert.ok(right <= sheetLeft, "the cards make way for the details");
  await page.screenshot({ path: join(artifact, "agents-drawer-light-1440.png"), animations: "disabled" });
  await expect(drawer.getByText(cause, { exact: true })).toHaveCount(1);
  await expect(drawer.getByRole("heading", { name: /^这次升级 · (今天|昨天) \d\d:\d\d$/u })).toBeVisible();
  await expect(drawer.locator(".upgrade-steps > li")).toHaveText([/^备份/u, "第 1 跳2026.9.5：已装入，Doctor 通过", "第 2 跳2026.10.9：已装入，Doctor 通过", "后台服务ai.openclaw.gateway：重启后没有重新运行"]);
  await expect(drawer.locator(".installation-state")).toContainText("新版本 2026.10.9 已安装，~/.openclaw/openclaw.json 由 Doctor 迁移。");
  // The state box above already says what this task left, so the task's own status is a plain line in the same amber, not a second box.
  const stateColor = await drawer.locator(".agent-health > span").first().evaluate(element => getComputedStyle(element).color);
  assert.deepEqual(await drawer.locator(".installation-state").evaluate(element => [getComputedStyle(element).backgroundColor, getComputedStyle(element.firstElementChild!).color]), ["rgba(0, 0, 0, 0)", stateColor]);
  for (const heading of ["模型与登录", "维护 · 按官网的安装方式", "能力"]) await expect(drawer.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(drawer.locator(".harness-installations li")).toHaveText(["npm 全局（Homebrew 的 Node.js）当前使用2026.10.9 · 已是最新卸载…"]);
  await expect(drawer.getByRole("button", { name: "查看 OpenClaw 的能力", exact: true })).toBeVisible();
  const technical = drawer.getByRole("button", { name: "技术细节", exact: true });
  await expect(technical).toHaveAttribute("aria-expanded", "false"); await expect(drawer.getByText("控制入口", { exact: true })).toHaveCount(0);
  await technical.click(); await expect(technical).toHaveAttribute("aria-expanded", "true"); await expect(drawer.getByText("控制入口", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(artifact, "agents-drawer-technical-1440.png"), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(drawer).toBeHidden();
  await expect(card("OpenClaw").getByRole("button", { name: "查看 OpenClaw 详情", exact: true })).toBeFocused(); await expect(marked).toHaveAttribute("data-selected", "false");
  // The page stays usable beside the details: another card opens its details in the same place, and is marked instead.
  await card("OpenClaw").getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click(); await expect(drawer).toBeVisible();
  await card("Codex").locator(".agent-summary").click();
  const switched = page.getByRole("dialog", { name: "Codex 详情" });
  await expect(switched).toBeVisible(); await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(main.locator(".agent-card[data-selected='true'] h3")).toHaveText(["Codex"]);
  // An Agent with a newer version: the state says it once, and the upgrade is in its maintenance.
  await expect(switched.locator(".agent-health")).toHaveText("有新版本 0.167.0当前 0.166.0。升级沿用它原来的安装方式，在下面的“维护”里进行。开始对话");
  await expect(switched.getByRole("button", { name: "升级到 0.167.0", exact: true })).toBeVisible();
  await settled(switched); await page.screenshot({ path: join(artifact, "agents-drawer-update-1440.png"), animations: "disabled" });
  await switched.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click(); await expect(switched).toBeHidden();
  await expect(main.locator(".agent-card[data-selected='true']")).toHaveCount(0);
  // Once the details have gone, the cards take the width back.
  const body = main.locator(".harness-management-body");
  await expect.poll(() => body.evaluate(element => getComputedStyle(element).marginRight)).toBe("0px");

  // The tasks stay one click away: the list opens in place and leads to each task's details.
  const tasks = main.getByRole("button", { name: /^安装任务/u });
  await expect(tasks).toHaveAttribute("aria-expanded", "false"); await tasks.click(); await expect(tasks).toHaveAttribute("aria-expanded", "true");
  const taskList = main.getByRole("region", { name: "安装任务" });
  await expect(taskList.getByRole("listitem")).toHaveCount(1); await expect(taskList.locator(".status-pill")).toHaveText("已升级，服务未就绪");
  // Its row tints when pointed at, once the list has finished opening (until then it is clipped and scrolls into view).
  await expect(main.locator("#installation-tasks")).toHaveAttribute("data-state", "open"); await rowTint(page, taskList.getByRole("button"));
  await page.screenshot({ path: join(artifact, "agents-tasks-light-1440.png"), animations: "disabled" });
  await tasks.click(); await expect(tasks).toHaveAttribute("aria-expanded", "false"); await expect(taskList).toHaveCount(0);

  // A04: what can still be installed the official way: the first rows, then all of them; each row says how and offers it.
  const catalog = main.getByRole("region", { name: "还可以安装" }), rows = catalog.locator(".agent-row");
  const total = Number(/(\d+) 个，按官网的方式安装/u.exec(await catalog.innerText())?.[1]);
  assert.ok(total > 6, "the fixture's catalog has more than the first rows");
  await expect(rows).toHaveCount(6);
  await catalog.getByRole("button", { name: `显示全部 ${total} 个`, exact: true }).click();
  await expect(rows).toHaveCount(total); await expect(catalog.getByRole("button", { name: "收起", exact: true })).toHaveAttribute("aria-expanded", "true");
  for (const row of await rows.all()) {
    await expect(row.getByRole("button", { name: /^查看 .+ 详情$/u })).toHaveCount(1);
    await expect(row.getByRole("button", { name: /^(安装|安装方式)$/u })).toHaveCount(1);
  }
  await catalog.getByRole("button", { name: "收起", exact: true }).click(); await expect(rows).toHaveCount(6);

  // A05 and Motion #28: the confirmation of the card's upgrade grows from .98 over a fading scrim in 200 ms on the appear
  // curve; it changes nothing until confirmed.
  const motion = () => page.evaluate(() => {
    const read = (selector: string) => { const element = document.querySelector(selector); if (!element) return null; const style = getComputedStyle(element);
      return { property: style.transitionProperty, durations: style.transitionDuration.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)), easing: style.transitionTimingFunction }; };
    return { pop: read(".dialog-pop"), scrim: read(".backdrop"), drawer: read(".drawer-pop") };
  });
  const appear = "cubic-bezier(0.165, 0.84, 0.44, 1)";
  await card("Codex").getByRole("button", { name: "升级到 0.167.0", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "升级 Codex" });
  await expect(dialog.getByText("0.166.0 → 0.167.0", { exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: "升级", exact: true })).toBeEnabled();
  const grown = await motion();
  assert.deepEqual(grown.pop, { property: "opacity, transform", durations: [200, 200], easing: appear + ", " + appear });
  assert.deepEqual(grown.scrim, { property: "opacity", durations: [200], easing: appear });
  await expect.poll(() => dialog.evaluate(element => { const style = getComputedStyle(element); return style.opacity === "1" && style.transform === "none"; })).toBe(true);
  await page.screenshot({ path: join(artifact, "agents-dialog-light-1440.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  assert.equal(submitted, 0, "nothing is sent until the upgrade is confirmed");

  // R04: with reduced motion the confirmation and the drawer only fade, within 150 ms.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card("Codex").getByRole("button", { name: "升级到 0.167.0", exact: true }).click(); await expect(dialog).toBeVisible();
  const faded = await motion();
  assert.ok(faded.pop && faded.pop.property === "opacity" && faded.pop.durations.every(value => value <= 150), "the reduced dialog only fades: " + JSON.stringify(faded.pop));
  assert.ok(faded.scrim && faded.scrim.property === "opacity" && faded.scrim.durations.every(value => value <= 150), "the reduced scrim only fades: " + JSON.stringify(faded.scrim));
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  await card("Claude Code").getByRole("button", { name: "查看 Claude Code 详情", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Claude Code 详情" })).toBeVisible();
  const still = await motion();
  assert.ok(still.drawer && still.drawer.property === "opacity" && still.drawer.durations.every(value => value <= 150), "the reduced drawer only fades: " + JSON.stringify(still.drawer));
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", { name: "Claude Code 详情" })).toBeHidden();
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // R03: from the keyboard, Tab reaches 详情 with its ring at once, Enter opens the drawer without animation and moves focus
  // into it; Shift+Tab leads back to the page with the details still open beside it, and Escape closes them.
  await card("Codex").getByRole("button", { name: "升级到 0.167.0", exact: true }).focus(); await page.keyboard.press("Tab");
  const details = card("Codex").getByRole("button", { name: "查看 Codex 详情", exact: true });
  await expect(details).toBeFocused();
  assert.deepEqual(await details.evaluate(element => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth]; }), [true, "solid", "2px"]);
  await page.keyboard.press("Enter");
  const codex = page.getByRole("dialog", { name: "Codex 详情" });
  await expect(codex).toBeVisible();
  const instant = await motion(); assert.ok(instant.drawer && instant.drawer.durations.every(value => value === 0), "a drawer opened from the keyboard is not animated: " + JSON.stringify(instant.drawer));
  const close = codex.getByRole("button", { name: "关闭 Harness 详情", exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body && document.querySelector("#main-content")?.contains(document.activeElement) === true)).toBe(true);
  await expect(codex).toBeVisible();
  await close.focus(); await page.keyboard.press("Escape"); await expect(codex).toBeHidden(); await expect(details).toBeFocused();

  // R01, R02: no horizontal scroll at 1440, 390 and 320, light and dark, for the page, the drawer and a confirmation.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    assert.equal(await main.locator("section.management-page").evaluate(element => getComputedStyle(element).backgroundColor), scheme === "dark" ? "rgb(24, 25, 28)" : "rgb(255, 255, 255)");
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      // A bar only on a narrow screen, holding the navigation; never a way back (ADR-054 补充 D).
      await expect(main.getByRole("button", { name: "打开导航", exact: true })).toHaveCount(width === 1440 ? 0 : 1);
      await expect(main.getByRole("button", { name: "返回对话", exact: true })).toHaveCount(0);
      // The page at rest: the details gone and no focus ring left by the keyboard.
      await expect.poll(() => body.evaluate(element => getComputedStyle(element).marginRight)).toBe("0px");
      await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
      await page.screenshot({ path: join(artifact, `agents-${scheme}-${width}.png`), animations: "disabled" });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `the Agent page overflows at ${width} in ${scheme}`);
      for (const right of await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right))) assert.ok(right <= width, `a card overflows at ${width} in ${scheme}`);
      // Measured once the drawer has slid in: it starts 24 px to the right. At 1440 it sits beside the cards; narrower, over the page.
      await card("OpenClaw").getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click(); await expect(drawer).toBeVisible();
      await settled(drawer);
      await page.screenshot({ path: join(artifact, `agents-drawer-${scheme}-${width}.png`), animations: "disabled" });
      assert.ok(await drawer.evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth), `the drawer overflows at ${width} in ${scheme}`);
      if (width === 1440) {
        const left = await drawer.evaluate(element => element.getBoundingClientRect().left);
        for (const right of await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right))) assert.ok(right <= left, `a card is under the details at ${width} in ${scheme}`);
      } else assert.equal(await drawer.evaluate(element => element.getBoundingClientRect().width), width, `the drawer takes the whole width at ${width}`);
      await page.keyboard.press("Escape"); await expect(drawer).toBeHidden();
      await card("Codex").getByRole("button", { name: "升级到 0.167.0", exact: true }).click(); await expect(dialog.getByText("0.166.0 → 0.167.0", { exact: true })).toBeVisible();
      await expect.poll(() => dialog.evaluate(element => { const style = getComputedStyle(element); return style.opacity === "1" && style.transform === "none"; })).toBe(true);
      await page.screenshot({ path: join(artifact, `agents-dialog-${scheme}-${width}.png`), animations: "disabled" });
      assert.ok(await dialog.evaluate(element => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth), `the confirmation overflows at ${width} in ${scheme}`);
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }

  // ADR-054 补充 C: the details sit beside the cards only while the cards keep two columns at least as wide as the three
  // the page draws without them (311 px), judged by the page's own width, so the sidebar counts: with it shown (264 px)
  // from a 1352 px window, with it hidden from 1088. There the sheet clips no card text the page shows whole without it;
  // one pixel narrower the details open over the page, behind a scrim, and the cards keep their place.
  // Found by their class: a modal drawer hides the page from the accessibility tree, where roles are looked up.
  const shown = main.locator(".agent-card"), clipped = () => shown.evaluateAll(elements => elements.flatMap(element => [...element.querySelectorAll("*")].filter(child => {
    const style = getComputedStyle(child);
    return (style.overflow === "hidden" || style.webkitLineClamp !== "none") && (child.scrollWidth > child.clientWidth + 1 || child.scrollHeight > child.clientHeight + 1);
  }).map(child => element.querySelector("h3")?.textContent + " " + child.className)));
  // The sidebar comes back from the phone widths above once the page has seen the window widen.
  const navigation = page.getByRole("complementary", { name: "主导航" }); await expect(navigation).toBeVisible();
  for (const [sidebar, threshold] of [[true, 1352], [false, 1088]] as const) {
    if (!sidebar) { await navigation.getByRole("button", { name: "收起侧栏", exact: true }).click(); await expect(navigation).toHaveCount(0); }
    for (const width of [threshold, threshold - 1]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => main.locator("section.management-page").evaluate(element => element.clientWidth)).toBe(width - (sidebar ? 264 : 0));
      const whole = await clipped(), placed = await shown.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      await card("OpenClaw").getByRole("button", { name: "查看 OpenClaw 详情", exact: true }).click(); await expect(drawer).toBeVisible(); await settled(drawer);
      const beside = width === threshold, left = await drawer.evaluate(element => element.getBoundingClientRect().left);
      await expect(page.locator(".backdrop")).toHaveCount(beside ? 0 : 1);
      const boxes = await shown.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON() as DOMRect));
      if (beside) {
        assert.equal(left, width - 360, `the sheet sits at the right edge at ${width}`);
        assert.equal(boxes.filter(box => Math.round(box.top) === Math.round(boxes[0]!.top)).length, 2, `two columns beside the details at ${width}`);
        for (const box of boxes) assert.ok(box.width >= 310 && box.right <= left, `a card squeezed or under the details at ${width}: ${JSON.stringify(box)}`);
        assert.deepEqual(await clipped(), whole, `the sheet makes a card clip its text at ${width}`);
      } else assert.deepEqual(boxes, placed, `the cards move under the drawer at ${width}`);
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: join(artifact, `agents-details-${beside ? "beside" : "over"}-${sidebar ? "sidebar" : "full"}-${width}-${scheme}.png`), animations: "disabled" });
      }
      await page.emulateMedia({ colorScheme: "light" });
      await page.keyboard.press("Escape"); await expect(drawer).toBeHidden();
    }
  }
  await main.getByRole("button", { name: "展开侧栏", exact: true }).click(); await expect(navigation).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The page says what the Gateway knows of each Agent's sign-in and conversations, as the composer's picker does. A
  // conversation with Codex reads its models and opens a native session: Codex's details then say when that read was and
  // that it was signed in, and offer the command that continues the conversation in Codex itself. A read that asked
  // Claude Code to sign in is its card's state.
  await navigation.getByRole("button", { name: "新对话", exact: true }).click();
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "发送消息", exact: true });
  await composer.fill("hello"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(page.getByRole("log", { name: "对话历史" }).locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  signedOut = true;
  await navigation.getByRole("button", { name: /^Harness\b/u }).click();
  // Coming back into view reads the state again (ADR-050), which now carries Claude Code's read.
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
  await expect(card("Claude Code").locator(".status-pill")).toHaveText("需要登录");
  await expect(card("Claude Code").locator(".agent-summary")).toHaveText("需要先在 Claude Code 里登录或完成设置，才能用它对话。");
  await expect(card("Claude Code").locator(".status-pill")).toHaveAttribute("title", "3 分钟前检查时，它需要先在本机完成登录或配置");
  await expect(card("Codex").locator(".agent-summary")).toHaveText("已登录，可以对话。模型和登录沿用它自己的配置。");
  await card("Codex").getByRole("button", { name: "查看 Codex 详情", exact: true }).click();
  const facts = page.getByRole("dialog", { name: "Codex 详情" });
  await expect(facts.getByRole("region", { name: "模型与登录" })).toHaveText(/^模型与登录(刚刚|1 分钟前)读取过它的模型列表，已登录。模型和登录沿用 Codex 自己的配置，HarnessHub 不复制也不修改。$/u);
  const resume = facts.getByRole("region", { name: "在原程序里继续对话" });
  await expect(resume).toContainText("最近的对话「hello」，在它的工作区目录中运行：");
  await expect(resume.locator("code")).toHaveText(/^codex resume browser-native-\d+$/u); await expect(resume.getByRole("button", { name: "复制恢复命令", exact: true })).toBeVisible();
  await settled(facts); await page.screenshot({ path: join(artifact, "agents-drawer-facts-1440.png"), animations: "disabled" });
  await page.keyboard.press("Escape"); await expect(facts).toBeHidden();
  assert.equal(submitted, 0);
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
/** A capability dialog once it has faded in, captured in the light and the dark theme, then back in the light one the tests start in. */
async function captureDialog(page: Page, dialog: ReturnType<Page["getByRole"]>, name: string): Promise<void> {
  await expect(dialog).toHaveCSS("opacity", "1");
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: join(artifact, name + "-" + scheme + ".png"), animations: "disabled" }); }
  await page.emulateMedia({ colorScheme: "light" });
}
/** The whole page in the dark theme, beside a light capture the test takes, then back in the light theme the tests start in. */
async function captureDark(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: join(artifact, name + "-dark.png"), animations: "disabled", fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
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
  // The board's six kinds in its order, each with its count (ADR-054 §5); commands are listed only while an Agent has any.
  // The skills matrix has one column per Harness, saying how each sees each skill.
  const tabs = page.getByRole("tablist", { name: "能力类别" });
  for (const [label, count] of [["技能", 2], ["MCP 服务器", 1], ["指令", 1], ["子 Agent", 1], ["插件", 1], ["Hooks", 1]] as const) await expect(tabs.getByRole("tab", { name: label + " " + count, exact: true })).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveText([/^技能/u, /^MCP/u, /^指令/u, /^子 Agent/u, /^插件/u, /^Hooks/u]);
  // Each column names its Harness and the version its channel records, Cursor's dated one like the others; no column says anything about its version (ADR-053).
  await expect(matrix.locator("thead th")).toHaveText([/技能/u, /Claude Code.*(?<!v)2\.1\.302/u, /Codex.*(?<!v)0\.162\.1/u, /Cursor.*(?<!v)2026\.10\.01-e373342/u, /Hermes Agent.*(?<!v)0\.12\.0/u]);
  await expect(matrix.locator("thead")).not.toContainText("核实");
  // The rules section says which version each Harness runs and points to its notes, and nothing about the version.
  const rules = page.locator("details").filter({ hasText: "各 Harness 的读取规则与说明" });
  await rules.locator("summary").click();
  await expect(rules).toContainText(/(?<!v)2026\.10\.01-e373342 · 读取规则见说明/u); await expect(rules).not.toContainText("v2026.10.01"); await expect(rules).toContainText("Cursor 的用户规则保存在应用设置里，不在磁盘上。");
  await expect(rules).not.toContainText("核实");
  await rules.locator("summary").click();
  // A cell is in use (a check named with the way the Harness finds it), a state worth its own word, or one that can be turned on (ADR-054 §5).
  const alpha = matrix.locator("tbody tr").filter({ hasText: "alpha" }).first();
  await expect(alpha.locator("td").nth(0).getByRole("img")).toHaveAccessibleName("已生效 · 链接"); await expect(alpha.locator("td").nth(1).getByRole("img")).toHaveAccessibleName("已生效 · 共享目录、自有目录");
  await expect(alpha.locator("td").nth(2)).toHaveText("重复"); await expect(alpha.locator("td").nth(2).getByRole("img")).toHaveAccessibleName("重复 · 共享目录");
  await expect(matrix.locator("tbody tr").filter({ hasText: "beta" }).first().locator("td").nth(0).getByRole("button")).toHaveAccessibleName("Claude Code：已停用 · 链接，可以启用");
  await expect(alpha).toContainText("vercel skills"); await expect(alpha).toContainText("1 条提示");
  // An entry expands to where each Harness finds it, why, and the warnings.
  await alpha.getByRole("button", { name: /alpha/u }).click();
  const detail = page.locator(".capability-detail");
  for (const text of ["~/.agents/skills/alpha", "https://github.com/owner/repo.git", "2 个文件 · 2.0 KB", "Cursor 没有说明同名技能怎样处理", "Codex 会同时列出 2 个名为 alpha 的技能"]) await expect(detail).toContainText(text);
  await page.screenshot({ path: join(artifact, "capabilities-detail.png"), animations: "disabled" }); await captureDark(page, "capabilities-detail");
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
  // The key under the matrix explains the marks shown, "?" included, and only those.
  await expect(page.locator(".capability-legend")).toHaveText(/^已生效—这个 Harness 不读它\?保存在磁盘之外，无法读取$/u);
  await tabs.getByRole("tab", { name: "Hooks 1", exact: true }).click();
  await matrix.locator("tbody tr").first().getByRole("button").click();
  await expect(page.locator(".capability-detail")).toContainText("Cursor 默认也会运行这个 Hook");
  // No Harness has a command, so the kind is not offered; an empty kind still says so (below, MCP with only Codex).
  await expect(tabs.getByRole("tab", { name: /^命令/u })).toHaveCount(0);
  await tabs.getByRole("tab", { name: "MCP 服务器 1", exact: true }).click();
  await expect(matrix.locator("tbody tr").first().locator("td").nth(0).getByRole("img")).toHaveAccessibleName("已生效 · 配置");
  await page.getByRole("combobox", { name: "只看一个 Harness" }).selectOption("codex");
  await expect(page.getByText("这一类还没有条目")).toBeVisible();
  await page.getByRole("combobox", { name: "只看一个 Harness" }).selectOption("");
  await tabs.getByRole("tab", { name: "技能 2", exact: true }).click();
  await page.screenshot({ path: join(artifact, "capabilities.png"), animations: "disabled" });
  // From a Harness's details, the page opens on that Harness.
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "Harness", exact: true }).click();
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
  await captureDialog(page, dialog, "capability-change-dialog");
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
  await captureDialog(page, claw, "capability-rewrite-dialog");
  await expect(claw).toContainText("openclaw config set skills.entries.alpha.enabled false --strict-json");
  await claw.getByRole("button", { name: "取消", exact: true }).click();
  // The result offers the file as it was before; restoring shows its own diff first and sends exactly that check.
  await result.getByRole("button", { name: "恢复修改前的文件", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "恢复修改前的文件" });
  await expect(restore.locator(".capability-diff .text-green")).toHaveText(["+    \"alpha\": \"user-invocable-only\""]);
  await captureDialog(page, restore, "capability-restore-dialog");
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
  await page.screenshot({ path: join(artifact, "capabilities-shared-directory.png"), animations: "disabled" }); await captureDark(page, "capabilities-shared-directory");
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
  await captureDialog(page, adding, "skill-add-dialog");
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
  await expect(alphaRow.locator(".badge")).toContainText(["可更新"]);
  await alphaRow.getByRole("button", { name: /alpha/u }).click();
  const detail = page.locator(".capability-detail");
  await expect(detail.getByRole("button", { name: "覆盖本地改动并更新" })).toHaveCount(0);
  await detail.getByRole("button", { name: "更新", exact: true }).click();
  const confirmUpdate = page.getByRole("dialog", { name: "更新 alpha" });
  await expect(confirmUpdate.locator(".skill-file-changes li")).toHaveText(["~ 修改SKILL.md", "+ 新增new.md"]);
  await expect(confirmUpdate).toContainText("npx skills 的 lock 里有记录"); await expect(confirmUpdate.locator(".capability-diff .text-green")).toHaveText(["+      \"skillFolderHash\": \"new\","]);
  await captureDialog(page, confirmUpdate, "skill-update-dialog");
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
  await page.screenshot({ path: join(artifact, "capabilities-mcp.png"), animations: "disabled", fullPage: true }); await captureDark(page, "capabilities-mcp");
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
  await captureDialog(page, importing, "mcp-import-dialog");
  await importing.getByRole("button", { name: "导入所选（1）" }).click(); await expect(importing).toBeHidden();
  await expect(page.locator(".capability-notice")).toContainText("已导入 1 个服务器");
  // A new server keeps the variable's name, never a value.
  await panel.getByRole("button", { name: "新建服务器", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建 MCP 服务器" });
  await form.getByRole("textbox", { name: "服务器名称" }).fill("search"); await form.getByRole("textbox", { name: "程序" }).fill("uvx"); await form.getByRole("textbox", { name: "参数" }).fill("search-mcp\n--fast");
  await form.getByRole("button", { name: "添加", exact: true }).click();
  await form.getByRole("textbox", { name: "环境变量的名字" }).fill("SEARCH_TOKEN"); await form.getByRole("textbox", { name: "取值的变量" }).fill("SEARCH_TOKEN");
  await captureDialog(page, form, "mcp-server-dialog");
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
  await page.screenshot({ path: join(artifact, "capabilities-instructions.png"), animations: "disabled", fullPage: true }); await captureDark(page, "capabilities-instructions");
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
  await captureDialog(page, dialog, "instructions-blocked-dialog");
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
  await page.screenshot({ path: join(artifact, "capabilities-subagents.png"), animations: "disabled", fullPage: true }); await captureDark(page, "capabilities-subagents");
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
  await captureDialog(page, form, "subagent-dialog");
  await form.getByRole("button", { name: "保存到清单" }).click(); await expect(form).toBeHidden();
  // A skill written from text: the dialog collects the texts, and the change is shown and confirmed like any other.
  await page.getByRole("tab", { name: /^技能/u }).click();
  await page.getByRole("button", { name: "新建技能", exact: true }).click();
  const skillForm = page.getByRole("dialog", { name: "新建技能" });
  await skillForm.getByRole("textbox", { name: "技能名字" }).fill("standup-notes"); await skillForm.getByRole("textbox", { name: "技能说明" }).fill("Writes my standup notes"); await skillForm.getByRole("textbox", { name: "技能正文" }).fill("Summarize yesterday.");
  await captureDialog(page, skillForm, "skill-text-dialog");
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
  await expect(detail).toContainText(/(?<!v)1\.2\.0 · 已启用/u); await expect(detail).toContainText(/(?<!v)1\.1\.0 · 已停用/u); await expect(detail).not.toContainText(/v1\.[12]\.0/u); await expect(detail).toContainText("Codex 停用了它");
  const switches = page.locator(".plugin-switches");
  await expect(switches.getByRole("button")).toHaveText(["在 Claude Code 中停用", "在 Codex 中启用"]);
  await page.screenshot({ path: join(artifact, "capabilities-plugins.png"), animations: "disabled", fullPage: true }); await captureDark(page, "capabilities-plugins");
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

test("G054-DL8 the capability page lists the board's kinds with counts, marks each cell in use, can be turned on or not read, collects picked cells in a bar that counts their files, and writes them only after a preview, with an undo", { timeout: 180000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  // A check is good for 15 minutes from now; the page prepares again one that is about to run out before showing it.
  const at = "2026-11-01T10:00:00.000Z", expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(), settings = "~/.claude/settings.json";
  // beta is off in Claude Code, gamma lives only in the shared directory, the plugin is off in Claude Code, and Claude Code has one command.
  const view = capabilityView(), entries = view.entries as unknown as { key: string; edges: unknown[] }[];
  entries.push({ kind: "skill", key: "skill:gamma", name: "gamma", description: "Only in the shared directory", owner: "harnesshub", source: "https://github.com/acme/skills", location: "~/.agents/skills/gamma",
    edges: [{ harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/gamma", reason: null }], warnings: [], facts: { kind: "skill", files: 1, bytes: 120 },
    shared: { folder: "~/.agents/skills/gamma", placed: [] } } as unknown as { key: string; edges: unknown[] }, { kind: "command", key: "command:~/.claude/commands/review.md", name: "/review", description: null, owner: "user", source: null,
    location: "~/.claude/commands/review.md", edges: [{ harnessId: "claude", mechanism: "own-copy", status: "active", via: "~/.claude/commands/review.md", reason: null }], warnings: [], facts: { kind: "command", format: "markdown" } } as unknown as { key: string; edges: unknown[] });
  entries.find(entry => entry.key === "plugin:tool@market")!.edges = [
    { harnessId: "claude", mechanism: "config", status: "disabled", via: settings, reason: "settings.json 的 enabledPlugins 把它设为 false", facts: { kind: "plugin", version: "1.2.0", enabled: false, switchable: true } },
    { harnessId: "codex", mechanism: "config", status: "active", via: "~/.codex/config.toml", reason: null, facts: { kind: "plugin", version: "1.1.0", enabled: true, switchable: true } }];
  const betaDiff = "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -2,4 +2,3 @@\n   \"skillOverrides\": {\n-    \"beta\": \"off\"\n   },\n   \"enabledPlugins\": {\n";
  const pluginDiff = (around: string) => "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -4,4 +4,4 @@\n" + around + "   \"enabledPlugins\": {\n-    \"tool@market\": false\n+    \"tool@market\": true\n   }\n";
  const check = (fields: Record<string, unknown>) => ({ command: null, rewrite: null, links: [], current: "other", notes: [], blocked: null, expiresAt, ...fields });
  const requests: string[] = [], posted: string[] = [], restores: string[] = [];
  let pluginChecks = 0, history = { changes: [] as unknown[], backups: [] as unknown[], drift: [] as unknown[], ...HISTORY_EXTRA };
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: view }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: history }));
  await page.route(/\/api\/v1\/capabilities\/(skill-switch|skill-link|plugin-switch)\?/u, route => {
    const url = new URL(route.request().url()), path = url.pathname.replace("/api/v1/capabilities/", ""); requests.push(path + url.search);
    if (path === "skill-switch") return route.fulfill({ json: check({ kind: "skill-switch", harnessId: "claude", name: "beta", enabled: true, file: settings, diff: betaDiff, fingerprint: "1".repeat(64), notes: ["Claude Code 会立即读到改动。"] }) });
    if (path === "skill-link") return route.fulfill({ json: check({ kind: "skill-link", harnessId: "claude", name: "gamma", enabled: true, file: "~/.claude/skills", diff: null, current: "none", fingerprint: "2".repeat(64),
      links: [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "create" }] }) });
    // Prepared again after beta's change wrote the same file (the 2nd): the lines around the change moved, the change itself
    // did not. The 4th, prepared again in the second batch, finds the plugin's line followed by another: a different change.
    pluginChecks++;
    return route.fulfill({ json: check({ kind: "plugin-switch", harnessId: "claude", name: "tool@market", enabled: true, file: settings, fingerprint: (["3", "4", "7", "8"][pluginChecks - 1] ?? "9").repeat(64),
      diff: pluginChecks === 4 ? "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -4,4 +4,4 @@\n   \"enabledPlugins\": {\n-    \"tool@market\": false,\n+    \"tool@market\": true,\n     \"lone@market\": true\n"
        : pluginDiff(pluginChecks % 2 === 1 ? "   \"skillOverrides\": {\n    \"beta\": \"off\"\n   },\n" : "   \"skillOverrides\": {},\n"), notes: ["Claude Code 会立即读到改动。", "新开的 Claude Code 会话才读到这次插件改动。"] }) });
  });
  const results: Record<string, unknown> = {
    ["1".repeat(64)]: { id: "21111111-1111-4111-8111-111111111111", kind: "skill-switch", harnessId: "claude", subject: "beta", file: settings, status: "applied", diff: betaDiff, backupId: "31111111-1111-4111-8111-111111111111", error: null, notes: ["Claude Code 会立即读到改动。"], at },
    ["4".repeat(64)]: { id: "22222222-2222-4222-8222-222222222222", kind: "plugin-switch", harnessId: "claude", subject: "tool@market", file: settings, status: "applied", diff: null, backupId: "32222222-2222-4222-8222-222222222222", error: null, notes: ["新开的 Claude Code 会话才读到这次插件改动。"], at },
    ["2".repeat(64)]: { id: "23333333-3333-4333-8333-333333333333", kind: "skill-link", harnessId: "claude", subject: "gamma", file: "~/.claude/skills", status: "applied", diff: null, backupId: null, error: null, notes: [],
      links: [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "create" }], at },
    ["8".repeat(64)]: { id: "26666666-6666-4666-8666-666666666666", kind: "plugin-switch", harnessId: "claude", subject: "tool@market", file: settings, status: "applied", diff: null, backupId: "36666666-6666-4666-8666-666666666666", error: null, notes: [], at },
    ["5".repeat(64)]: { id: "24444444-4444-4444-8444-444444444444", kind: "link-undo", harnessId: "claude", subject: "gamma", file: "~/.claude/skills", status: "applied", diff: null, backupId: null, error: null, notes: [],
      links: [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "remove" }], at } };
  await page.route("**/api/v1/capabilities/changes", route => {
    const body = route.request().postDataJSON() as { fingerprint: string }; posted.push(body.fingerprint);
    // The plugin's first check was read before beta's change wrote the same file: the Gateway refuses it, as it does.
    if (body.fingerprint === "3".repeat(64) || body.fingerprint === "7".repeat(64)) return route.fulfill({ status: 409, json: { code: "CAPABILITY_TARGET_CHANGED", message: "文件在确认之后被改动过，没有写入；请重新检查" } });
    history = { ...history, changes: [results[body.fingerprint], ...history.changes] };
    return route.fulfill({ json: results[body.fingerprint] });
  });
  await page.route(/\/api\/v1\/capabilities\/changes\/[^/]+\/undo$/u, route => {
    requests.push(new URL(route.request().url()).pathname.replace("/api/v1/capabilities/", ""));
    return route.fulfill({ json: check({ kind: "link-undo", harnessId: "claude", name: "gamma", enabled: false, file: "~/.claude/skills", diff: null, current: "harnesshub", fingerprint: "5".repeat(64),
      links: [{ path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma", action: "remove" }], notes: ["撤销 1 个链接改动：删掉当初建的，放回当初删的。"] }) });
  });
  await page.route(/\/api\/v1\/capabilities\/backups\/[^/]+\/restore$/u, route => {
    requests.push(new URL(route.request().url()).pathname.replace("/api/v1/capabilities/", ""));
    return route.fulfill({ json: { backupId: "31111111-1111-4111-8111-111111111111", file: settings, changedSince: true, fingerprint: "6".repeat(64), expiresAt,
      diff: "--- a/~/.claude/settings.json\n+++ b/~/.claude/settings.json\n@@ -2,6 +2,7 @@\n   \"skillOverrides\": {\n+    \"beta\": \"off\"\n   },\n   \"enabledPlugins\": {\n-    \"tool@market\": true\n+    \"tool@market\": false\n   }\n",
      notes: ["这个文件在 HarnessHub 改动之后又被改过，恢复会连这些改动一起撤销。", "恢复前会先备份现在的文件。"] } });
  });
  await page.route("**/api/v1/capabilities/restores", route => {
    restores.push((route.request().postDataJSON() as { fingerprint: string }).fingerprint);
    return route.fulfill({ json: { id: "25555555-5555-4555-8555-555555555555", kind: "restore", harnessId: null, subject: "beta", file: settings, status: "applied", diff: null, backupId: "35555555-5555-4555-8555-555555555555", error: null, notes: ["已恢复到“beta”之前的样子。"], at } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();

  // The board's categories beside the content, each with its count, in its order; commands come last, listed because an Agent has one.
  const tabs = page.getByRole("tablist", { name: "能力类别" });
  await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
  for (const [label, count] of [["技能", 3], ["MCP 服务器", 1], ["指令", 1], ["子 Agent", 1], ["插件", 1], ["Hooks", 1], ["命令", 1]] as const) await expect(tabs.getByRole("tab", { name: label + " " + count, exact: true })).toBeVisible();
  await expect(tabs.getByRole("tab")).toHaveText([/^技能/u, /^MCP/u, /^指令/u, /^子 Agent/u, /^插件/u, /^Hooks/u, /^命令/u]);
  await expect(page.getByRole("heading", { name: "技能 3", exact: true })).toBeVisible();
  await expect(page.getByText("点空着的格子就能启用；写入前会给你看每个文件改哪几行。")).toBeVisible();
  // The list moves with the arrow keys, Home and End, choosing as it goes.
  await tabs.getByRole("tab", { name: "技能 3", exact: true }).focus(); await page.keyboard.press("ArrowDown");
  await expect(tabs.getByRole("tab", { name: "MCP 服务器 1", exact: true })).toBeFocused(); await expect(tabs.getByRole("tab", { name: "MCP 服务器 1", exact: true })).toHaveAttribute("aria-selected", "true");
  // The category is named as the board names it in its heading and its search too (MCP 服务器, not MCP).
  await expect(page.getByRole("heading", { name: "MCP 服务器 1", exact: true })).toBeVisible(); await expect(page.getByRole("textbox", { name: "搜索能力" })).toHaveAttribute("placeholder", "搜索 MCP 服务器");
  await page.keyboard.press("End"); await expect(tabs.getByRole("tab", { name: "命令 1", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "命令 1", exact: true })).toBeVisible();
  await page.keyboard.press("Home"); await expect(tabs.getByRole("tab", { name: "技能 3", exact: true })).toBeFocused();
  // Each column is an Agent, by its mark and short name; its full name and version are read out and shown on hover.
  const matrix = page.locator(".capability-matrix"), row = (name: string) => matrix.locator("tbody tr").filter({ hasText: name }).first();
  await expect(matrix.locator("thead th")).toHaveText([/^技能 · 来源$/u, /Claude Code 2\.1\.302/u, /Codex 0\.162\.1/u, /Hermes Agent 0\.12\.0/u]);
  await expect(matrix.locator("thead th").nth(1)).toHaveAttribute("title", "Claude Code · 2.1.302");
  // Three states: in use, can be turned on, not read; and each entry's source.
  await expect(row("alpha").locator("td").nth(0).getByRole("img")).toHaveAccessibleName("已生效 · 链接");
  const beta = row("beta").locator("td").nth(0).getByRole("button"), gamma = row("gamma").locator("td").nth(0).getByRole("button");
  await expect(beta).toHaveAccessibleName("Claude Code：已停用 · 链接，可以启用"); await expect(beta).toHaveAttribute("aria-pressed", "false");
  await expect(gamma).toHaveAccessibleName("Claude Code：看不到，可以启用");
  await expect(row("gamma").locator("td").nth(2).getByRole("img")).toHaveAccessibleName("不读共享目录；可以在下方“共享技能目录”里让它读取");
  await expect(row("alpha")).toContainText("共享目录 · owner/repo · vercel skills 管理"); await expect(row("gamma")).toContainText("共享目录 · acme/skills");
  await expect(page.locator(".capability-legend")).toHaveText(/已生效.*可以启用.*这个 Harness 不读它/u);
  await page.screenshot({ path: join(artifact, "dl8-capabilities-light-1440.png"), animations: "disabled" });

  // Picked with the pointer: the ring turns blue in 120 ms and a plus pops from half its size with the overshoot curve in
  // 300 ms while it fades in over 120 ms (Motion board #34); unpicked, it goes back the same way.
  const plusOf = (cell: typeof beta) => cell.evaluate(element => { const plus = getComputedStyle(element.querySelector("svg")!); return [plus.opacity, plus.scale]; });
  assert.deepEqual(await plusOf(beta), ["0", "0.5"], "an empty cell holds its plus transparent at half size");
  await beta.click();
  await expect(beta).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => beta.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/rgb\(47, 95, 208\) 0px 0px 0px 1\.5px inset$/u);
  assert.deepEqual(await beta.evaluate(element => { const style = getComputedStyle(element), plus = getComputedStyle(element.querySelector("svg")!);
    return [style.transitionProperty, style.transitionDuration, plus.transitionProperty, plus.transitionDuration, plus.transitionTimingFunction]; }),
  ["scale, background-color, box-shadow", "0.3s, 0.12s, 0.12s", "scale, opacity", "0.3s, 0.12s", "cubic-bezier(0.34, 1.3, 0.64, 1), cubic-bezier(0.2, 0, 0, 1)"]);
  await expect.poll(() => plusOf(beta)).toEqual(["1", "1"]);
  await beta.click(); await expect(beta).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => plusOf(beta)).toEqual(["0", "0.5"]);
  await expect.poll(() => beta.evaluate(element => getComputedStyle(element).boxShadow)).not.toMatch(/rgb\(47, 95, 208\)/u);
  await beta.click(); await expect(beta).toHaveAttribute("aria-pressed", "true");
  // The bar rises 16 px in 300 ms on the appear curve (Motion board #29) and counts the files once each change is prepared.
  const bar = page.getByRole("region", { name: "已选的格子" });
  await expect(bar).toContainText("已选 1 处 · 会改 1 个文件");
  // It centres itself in the page at its content's width (the page only says where its bottom is), so its words wrap only
  // when the room between its 16 px insets runs out, and then by whole phrases: at most two lines.
  const placed = (region: typeof bar) => region.evaluate(element => {
    const box = element.getBoundingClientRect(), page = element.closest(".capabilities-page")!.getBoundingClientRect(), words = element.querySelector("[role='status'], .trunc")!;
    return { offset: Math.round(Math.abs((box.left - page.left) - (page.right - box.right))), lines: Math.round((words.getBoundingClientRect().height - parseFloat(getComputedStyle(words).paddingTop) * 2) / 20) };
  });
  assert.deepEqual(await bar.evaluate(element => { const style = getComputedStyle(element); return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction]; }),
    ["opacity, transform", "0.3s, 0.3s", "cubic-bezier(0.165, 0.84, 0.44, 1), cubic-bezier(0.165, 0.84, 0.44, 1)"]);
  // From the keyboard: the focus ring is there at once, Space picks, and nothing animates (Motion board #37).
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await expect(gamma).toBeFocused();
  assert.deepEqual(await gamma.evaluate(element => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth, document.documentElement.dataset.input]; }), [true, "solid", "2px", "keyboard"]);
  await page.keyboard.press("Space");
  await expect(gamma).toHaveAttribute("aria-pressed", "true");
  assert.deepEqual(await gamma.evaluate(element => { const plus = getComputedStyle(element.querySelector("svg")!); return [plus.transitionDuration, plus.opacity]; }), ["0s", "1"], "a cell picked from the keyboard does not pop");
  await expect(bar).toContainText("已选 2 处 · 会改 2 个文件");
  await tabs.getByRole("tab", { name: "插件 1", exact: true }).click();
  const plugin = row("tool@market").locator("td").nth(0).getByRole("button");
  await expect(plugin).toHaveAccessibleName("Claude Code：已停用 · 配置，可以启用");
  await plugin.click();
  // Three cells, two files: the skill and the plugin both switch in ~/.claude/settings.json, the placement is a link in ~/.claude/skills.
  await expect(bar).toContainText("已选 3 处 · 会改 2 个文件");
  assert.deepEqual(requests, ["skill-switch?harnessId=claude&name=beta&enabled=true", "skill-link?harnessId=claude&name=gamma&present=true", "plugin-switch?harnessId=claude&id=tool%40market&enabled=true"]);
  assert.deepEqual(posted, [], "picking only prepares the checks");
  assert.deepEqual(await placed(bar), { offset: 0, lines: 1 });
  await page.screenshot({ path: join(artifact, "dl8-capabilities-picked-light-1440.png"), animations: "disabled" });

  // The preview names every file and shows its exact lines, or the link it makes; nothing is written before "写入".
  await bar.getByRole("button", { name: "预览写入", exact: true }).click();
  const write = page.getByRole("dialog", { name: "写入 2 个文件" }), files = write.locator(".capability-write-file");
  await expect(write).toContainText("只改下面这些行；写完可以撤销。");
  await expect(files).toHaveCount(2);
  await expect(files.nth(0)).toContainText(settings); await expect(files.nth(0).locator(".capability-write-item")).toHaveCount(2);
  await expect(files.nth(0).locator(".capability-diff .text-red")).toHaveText(["-    \"beta\": \"off\"", "-    \"tool@market\": false"]);
  await expect(files.nth(0).locator(".capability-diff .text-green")).toHaveText(["+    \"tool@market\": true"]);
  await expect(files.nth(0)).toContainText("现在的设置：不是 HarnessHub 写的"); await expect(files.nth(0)).toContainText("新开的 Claude Code 会话才读到这次插件改动。");
  await expect(files.nth(1)).toContainText("~/.claude/skills"); await expect(files.nth(1).locator(".capability-links li")).toHaveText(["+ 新建~/.claude/skills/gamma → ~/.agents/skills/gamma"]);
  await expect(bar).toBeHidden(); await expect(write).toHaveCSS("opacity", "1");
  // The page behind is veiled in the sidebar's color, as on the Capabilities board, not darkened.
  assert.equal(await page.locator(".backdrop").evaluate(element => getComputedStyle(element).backgroundColor), "color(srgb 0.976471 0.980392 0.984314 / 0.6)");
  // A preview taller than the dialog scrolls; no file's block is squeezed to hide some of its lines.
  assert.deepEqual(await files.evaluateAll(nodes => nodes.map(node => node.scrollHeight - node.clientHeight)), [0, 0]);
  await page.screenshot({ path: join(artifact, "dl8-capabilities-preview-light-1440.png"), animations: "disabled" });
  assert.deepEqual(posted, [], "the preview alone writes nothing");
  await write.getByRole("button", { name: "写入", exact: true }).click(); await expect(write).toBeHidden();
  // File by file, each change with its own confirmed check. The plugin's check went stale when beta's change wrote the same
  // file; prepared again, it makes the very same change and is written with its new check.
  assert.deepEqual(posted, ["1", "3", "4", "2"].map(digit => digit.repeat(64)));
  assert.equal(pluginChecks, 2);
  const written = page.getByRole("region", { name: "写入结果" }), result = page.locator(".capability-result");
  await expect(written).toContainText("已写入 2 个文件");
  assert.deepEqual(await placed(written), { offset: 0, lines: 1 });
  // The bar that opened the preview is gone; the focus moves to the undo of what was written instead of falling to the page.
  await expect(written.getByRole("button", { name: "撤销", exact: true })).toBeFocused();
  for (const text of ["已写入 2 个文件", "Claude Code · 启用 beta", "Claude Code · 启用插件 tool@market", "Claude Code · 把 gamma 放到 Claude Code", "新开的 Claude Code 会话才读到这次插件改动。"]) await expect(result).toContainText(text);
  await expect(plugin).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: join(artifact, "dl8-capabilities-written-light-1440.png"), animations: "disabled" });

  // Undo is shown first too: the settings go back to the backup from before the batch's first change to them, which also
  // takes back the plugin's change; the link is undone through its own check.
  await written.getByRole("button", { name: "撤销", exact: true }).click();
  const undo = page.getByRole("dialog", { name: "撤销写入的 2 个文件" }), back = undo.locator(".capability-undo-file");
  await expect(back).toHaveCount(2);
  await expect(back.nth(0)).toContainText("这次改了 2 处");
  await expect(back.nth(0).locator(".capability-diff .text-green")).toHaveText(["+    \"beta\": \"off\"", "+    \"tool@market\": false"]);
  await expect(back.nth(1).locator(".capability-links li")).toHaveText(["− 删除~/.claude/skills/gamma → ~/.agents/skills/gamma"]); await expect(undo).toHaveCSS("opacity", "1");
  await page.screenshot({ path: join(artifact, "dl8-capabilities-undo-light-1440.png"), animations: "disabled" });
  assert.deepEqual(restores, []);
  await undo.getByRole("button", { name: "撤销", exact: true }).click(); await expect(undo).toBeHidden();
  assert.deepEqual(restores, ["6".repeat(64)]); assert.equal(posted.at(-1), "5".repeat(64));
  assert.ok(requests.includes("backups/31111111-1111-4111-8111-111111111111/restore") && requests.includes("changes/23333333-3333-4333-8333-333333333333/undo"));
  await expect(result).toContainText("已撤销这次写入，改回了 2 个文件"); await expect(written).toBeHidden();

  // A stale check that, prepared again, makes a different change stops the writing: the new lines are shown and only
  // written once the user confirms again.
  await tabs.getByRole("tab", { name: "技能 3", exact: true }).click(); await beta.click();
  await tabs.getByRole("tab", { name: "插件 1", exact: true }).click(); await plugin.click();
  await expect(bar).toContainText("已选 2 处 · 会改 1 个文件");
  await bar.getByRole("button", { name: "预览写入", exact: true }).click();
  const again = page.getByRole("dialog", { name: "写入 1 个文件" }), second = again.locator(".capability-write-item").filter({ hasText: "启用插件 tool@market" });
  await again.getByRole("button", { name: "写入", exact: true }).click();
  await expect(again.locator(".write-changed")).toHaveText("写入前一项后，这一项的改动变成了下面这样，请再看一遍。");
  await expect(second.locator(".capability-diff .text-green")).toHaveText(["+    \"tool@market\": true,"]);
  await expect(again.locator(".capability-write-item").filter({ hasText: "启用 beta" })).toContainText("已写入");
  assert.deepEqual(posted.slice(-2), ["1".repeat(64), "7".repeat(64)], "nothing more is sent until the new change is confirmed");
  await page.screenshot({ path: join(artifact, "dl8-capabilities-changed-light-1440.png"), animations: "disabled" });
  await again.getByRole("button", { name: "继续写入", exact: true }).click(); await expect(again).toBeHidden();
  assert.equal(posted.at(-1), "8".repeat(64)); assert.equal(pluginChecks, 4);
  await expect(written).toContainText("已写入 1 个文件");

  // With reduced motion a pressed cell does not shrink, the ring and the plus change at once, and the bar only fades (ADR-054 §3).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tabs.getByRole("tab", { name: "技能 3", exact: true }).click();
  const box = await beta.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  assert.equal(await beta.evaluate(element => element.getBoundingClientRect().width), 28, "a pressed cell keeps its size");
  await page.mouse.up();
  await expect(beta).toHaveAttribute("aria-pressed", "true");
  assert.deepEqual(await beta.evaluate(element => [element, element.querySelector("svg")!].map(node => getComputedStyle(node).transitionDuration.split(",").every(part => parseFloat(part) === 0))), [true, true]);
  assert.deepEqual(await plusOf(beta), ["1", "1"], "with reduced motion the plus is there at once");
  const fade = await bar.evaluate(element => { const style = getComputedStyle(element);
    return { properties: style.transitionProperty, durations: style.transitionDuration.split(",").map(part => parseFloat(part) * (part.trim().endsWith("ms") ? 1 : 1000)), transform: style.transform }; });
  assert.equal(fade.properties, "opacity"); assert.equal(fade.transform, "none"); assert.ok(fade.durations.every(value => value > 0 && value <= 150), "the bar only fades, within 150 ms: " + fade.durations.join(","));
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Dark, and phone widths: the categories become a row of tabs, the matrix scrolls inside its frame, the bar stays on screen.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => beta.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/rgb\(138, 176, 255\) 0px 0px 0px 1\.5px inset$/u);
  await page.screenshot({ path: join(artifact, "dl8-capabilities-dark-1440.png"), animations: "disabled" });
  await bar.getByRole("button", { name: "预览写入", exact: true }).click();
  const darkPreview = page.getByRole("dialog", { name: "写入 1 个文件" });
  await expect(darkPreview.locator(".capability-diff .text-red")).toHaveText(["-    \"beta\": \"off\""]); await expect(darkPreview).toHaveCSS("opacity", "1");
  assert.equal(await page.locator(".backdrop").evaluate(element => getComputedStyle(element).backgroundColor), "color(srgb 0.0666667 0.0705882 0.0784314 / 0.6)");
  await page.screenshot({ path: join(artifact, "dl8-capabilities-preview-dark-1440.png"), animations: "disabled" });
  const sent = posted.length;
  await darkPreview.getByRole("button", { name: "取消", exact: true }).click(); await expect(darkPreview).toBeHidden();
  await expect(bar).toContainText("已选 1 处 · 会改 1 个文件");
  // The 预览写入 that opened it left with the bar; the focus comes back to the bar's new one instead of falling to the page.
  await expect(bar.getByRole("button", { name: "预览写入", exact: true })).toBeFocused();
  assert.equal(posted.length, sent, "cancelling the preview writes nothing");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("tablist", { name: "能力类别" })).not.toHaveAttribute("aria-orientation", "vertical");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const edges = await bar.boundingBox(); assert.ok(edges && edges.x >= 0 && edges.x + edges.width <= width, `the bar fits a ${width} px screen`);
      const where = await placed(bar); assert.ok(where.offset === 0 && where.lines <= 2, `the bar is centred with its words on at most two lines at ${width} px: ` + JSON.stringify(where));
      await page.screenshot({ path: join(artifact, `dl8-capabilities-${scheme}-${width}.png`), animations: "disabled" });
    }
  }
  // Scrolled sideways, the matrix keeps the names in place and marks their edge over the cells passing under them.
  const names = matrix.locator("tbody th").first();
  assert.equal(await names.evaluate(element => getComputedStyle(element).boxShadow), "none");
  await matrix.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => names.evaluate(element => getComputedStyle(element).boxShadow)).toMatch(/ -1px 0px 0px 0px inset$/u);
  assert.ok(await names.evaluate(element => Math.abs(element.getBoundingClientRect().left - element.closest(".capability-matrix")!.getBoundingClientRect().left) < 1), "the names stay at the start");
  await page.screenshot({ path: join(artifact, "dl8-capabilities-dark-320-scrolled.png"), animations: "disabled" });
  // The only errors the browser logs are the Gateway's refusals of the two stale checks, which the page answered by checking again.
  assert.deepEqual(errors, Array(2).fill("Failed to load resource: the server responded with a status of 409 (Conflict)"));
});

test("G054-DL8 an undo of a written batch that stops part way says what it put back and why the rest is not, and never claims the write was undone", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-11-01T10:00:00.000Z", expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(), settings = "~/.claude/settings.json";
  // beta is off in Claude Code; gamma lives only in the shared directory, so Claude Code takes it by a link.
  const view = capabilityView(), entries = view.entries as unknown as { key: string; edges: unknown[] }[];
  entries.push({ kind: "skill", key: "skill:gamma", name: "gamma", description: null, owner: "harnesshub", source: null, location: "~/.agents/skills/gamma",
    edges: [{ harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/gamma", reason: null }], warnings: [], facts: { kind: "skill", files: 1, bytes: 120 },
    shared: { folder: "~/.agents/skills/gamma", placed: [] } } as unknown as { key: string; edges: unknown[] });
  const check = (fields: Record<string, unknown>) => ({ command: null, rewrite: null, links: [], current: "other", notes: [], blocked: null, expiresAt, ...fields });
  const link = { path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma" }, posted: string[] = [], restores: string[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: view }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: { changes: [], backups: [], drift: [], ...HISTORY_EXTRA } }));
  await page.route(/\/api\/v1\/capabilities\/(skill-switch|skill-link)\?/u, route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("skill-switch")
    ? check({ kind: "skill-switch", harnessId: "claude", name: "beta", enabled: true, file: settings, fingerprint: "1".repeat(64), diff: "--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n   \"skillOverrides\": {\n-    \"beta\": \"off\"\n   }\n" })
    : check({ kind: "skill-link", harnessId: "claude", name: "gamma", enabled: true, file: "~/.claude/skills", diff: null, current: "none", fingerprint: "2".repeat(64), links: [{ ...link, action: "create" }] }) }));
  await page.route("**/api/v1/capabilities/changes", route => {
    const fingerprint = (route.request().postDataJSON() as { fingerprint: string }).fingerprint; posted.push(fingerprint);
    // Undoing the link meets a link someone changed in between: the Gateway refuses it.
    if (fingerprint === "5".repeat(64)) return route.fulfill({ status: 409, json: { code: "CAPABILITY_TARGET_CHANGED", message: "链接在确认之后被改动过，没有撤销；请重新检查" } });
    return route.fulfill({ json: fingerprint === "1".repeat(64)
      ? { id: "21111111-1111-4111-8111-111111111111", kind: "skill-switch", harnessId: "claude", subject: "beta", file: settings, status: "applied", diff: null, backupId: "31111111-1111-4111-8111-111111111111", error: null, notes: [], at }
      : { id: "23333333-3333-4333-8333-333333333333", kind: "skill-link", harnessId: "claude", subject: "gamma", file: "~/.claude/skills", status: "applied", diff: null, backupId: null, error: null, notes: [], links: [{ ...link, action: "create" }], at } });
  });
  await page.route(/\/api\/v1\/capabilities\/changes\/[^/]+\/undo$/u, route => route.fulfill({ json: check({ kind: "link-undo", harnessId: "claude", name: "gamma", enabled: false, file: "~/.claude/skills", diff: null,
    current: "harnesshub", fingerprint: "5".repeat(64), links: [{ ...link, action: "remove" }] }) }));
  await page.route(/\/api\/v1\/capabilities\/backups\/[^/]+\/restore$/u, route => route.fulfill({ json: { backupId: "31111111-1111-4111-8111-111111111111", file: settings, changedSince: false, fingerprint: "6".repeat(64), expiresAt,
    diff: "--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n   \"skillOverrides\": {\n+    \"beta\": \"off\"\n   }\n", notes: ["恢复前会先备份现在的文件。"] } }));
  await page.route("**/api/v1/capabilities/restores", route => { restores.push((route.request().postDataJSON() as { fingerprint: string }).fingerprint);
    return route.fulfill({ json: { id: "25555555-5555-4555-8555-555555555555", kind: "restore", harnessId: null, subject: "beta", file: settings, status: "applied", diff: null, backupId: "35555555-5555-4555-8555-555555555555", error: null, notes: [], at } }); });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  const matrix = page.locator(".capability-matrix"), claude = (name: string) => matrix.locator("tbody tr").filter({ hasText: name }).first().locator("td").nth(0).getByRole("button");
  await claude("beta").click(); await claude("gamma").click();
  const bar = page.getByRole("region", { name: "已选的格子" });
  await expect(bar).toContainText("已选 2 处 · 会改 2 个文件");
  await bar.getByRole("button", { name: "预览写入", exact: true }).click();
  const write = page.getByRole("dialog", { name: "写入 2 个文件" });
  await write.getByRole("button", { name: "写入", exact: true }).click(); await expect(write).toBeHidden();
  await page.getByRole("region", { name: "写入结果" }).getByRole("button", { name: "撤销", exact: true }).click();
  const undo = page.getByRole("dialog", { name: "撤销写入的 2 个文件" });
  await expect(undo.locator(".capability-undo-file")).toHaveCount(2);
  await undo.getByRole("button", { name: "撤销", exact: true }).click(); await expect(undo).toBeHidden();
  // The settings went back; the link did not. The result says so with the Gateway's reason, and nowhere that the write was undone.
  const result = page.locator(".capability-result");
  await expect(result).toContainText("撤销没有全部完成，改回了 1 个文件"); await expect(result).toContainText("链接在确认之后被改动过，没有撤销；请重新检查");
  await expect(result).not.toContainText("已撤销这次写入"); await expect(result).toHaveAttribute("role", "alert");
  assert.deepEqual(restores, ["6".repeat(64)]);
  assert.deepEqual(posted, ["1".repeat(64), "2".repeat(64), "5".repeat(64)]);
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 409 (Conflict)"]);
});

test("G054-DL8 a change of a batch that the Gateway reports as not done is said with its reason, is not counted as written, and stays picked to try again", { timeout: 120000 }, async t => {
  const fixture = await launchFixture(false); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: { width: 1280, height: 900 } }), page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  const at = "2026-11-01T10:00:00.000Z", expiresAt = new Date(Date.now() + 15 * 60_000).toISOString(), settings = "~/.claude/settings.json";
  const view = capabilityView(), entries = view.entries as unknown as { key: string; edges: unknown[] }[];
  entries.push({ kind: "skill", key: "skill:gamma", name: "gamma", description: null, owner: "harnesshub", source: null, location: "~/.agents/skills/gamma",
    edges: [{ harnessId: "codex", mechanism: "native-shared", status: "active", via: "~/.agents/skills/gamma", reason: null }], warnings: [], facts: { kind: "skill", files: 1, bytes: 120 },
    shared: { folder: "~/.agents/skills/gamma", placed: [] } } as unknown as { key: string; edges: unknown[] });
  const check = (fields: Record<string, unknown>) => ({ command: null, rewrite: null, links: [], current: "other", notes: [], blocked: null, expiresAt, ...fields });
  const link = { path: "~/.claude/skills/gamma", target: "~/.agents/skills/gamma" }, posted: string[] = [];
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: view }));
  await page.route("**/api/v1/capabilities/history", route => route.fulfill({ json: { changes: [], backups: [], drift: [], ...HISTORY_EXTRA } }));
  await page.route(/\/api\/v1\/capabilities\/(skill-switch|skill-link)\?/u, route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("skill-switch")
    ? check({ kind: "skill-switch", harnessId: "claude", name: "beta", enabled: true, file: settings, fingerprint: "1".repeat(64), diff: "--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n   \"skillOverrides\": {\n-    \"beta\": \"off\"\n   }\n" })
    : check({ kind: "skill-link", harnessId: "claude", name: "gamma", enabled: true, file: "~/.claude/skills", diff: null, current: "none", fingerprint: "2".repeat(64), links: [{ ...link, action: "create" }] }) }));
  // beta is written; the Gateway reports the link as not done, with why.
  await page.route("**/api/v1/capabilities/changes", route => {
    const fingerprint = (route.request().postDataJSON() as { fingerprint: string }).fingerprint; posted.push(fingerprint);
    return route.fulfill({ json: fingerprint === "1".repeat(64)
      ? { id: "21111111-1111-4111-8111-111111111111", kind: "skill-switch", harnessId: "claude", subject: "beta", file: settings, status: "applied", diff: null, backupId: "31111111-1111-4111-8111-111111111111", error: null, notes: [], at }
      : { id: "23333333-3333-4333-8333-333333333333", kind: "skill-link", harnessId: "claude", subject: "gamma", file: "~/.claude/skills", status: "failed", diff: null, backupId: null,
        error: { code: "CAPABILITY_LINK_FAILED", message: "~/.claude/skills/gamma 已经存在，没有建链接" }, notes: [], links: [], at } });
  });
  await page.goto(fixture.gateway.url); await expect(page.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "能力", exact: true }).click();
  const matrix = page.locator(".capability-matrix"), claude = (name: string) => matrix.locator("tbody tr").filter({ hasText: name }).first().locator("td").nth(0).getByRole("button");
  await claude("beta").click(); await claude("gamma").click();
  const bar = page.getByRole("region", { name: "已选的格子" });
  await bar.getByRole("button", { name: "预览写入", exact: true }).click();
  const write = page.getByRole("dialog", { name: "写入 2 个文件" });
  await write.getByRole("button", { name: "写入", exact: true }).click();
  // The dialog stays with the reason; nothing after the failed change is sent.
  const gamma = write.locator(".capability-write-item").filter({ hasText: "把 gamma 放到 Claude Code" });
  await expect(gamma).toContainText("没有完成"); await expect(gamma).toContainText("~/.claude/skills/gamma 已经存在，没有建链接");
  await expect(write.locator(".capability-write-item").filter({ hasText: "启用 beta" })).toContainText("已写入");
  await expect(write.getByRole("button", { name: /写入/u })).toHaveCount(0);
  await write.getByRole("button", { name: "关闭", exact: true }).click(); await expect(write).toBeHidden();
  // The result counts what was written and says what was not; the link stays picked, so the bar is back to try it again.
  const result = page.locator(".capability-result");
  await expect(result).toContainText("1 处没有写入完成"); await expect(result).toContainText("Claude Code · 把 gamma 放到 Claude Code：~/.claude/skills/gamma 已经存在，没有建链接");
  await expect(result.getByRole("button", { name: "撤销这次写入" })).toBeVisible();
  await expect(bar).toContainText("已选 1 处 · 会改 1 个文件"); await expect(claude("gamma")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "写入结果" })).toHaveCount(0);
  assert.deepEqual(posted, ["1".repeat(64), "2".repeat(64)]);
  assert.deepEqual(errors, []);
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
  const welcome = page.getByRole("region", { name: "本机可用的 Harness" }), navigation = page.getByRole("complementary", { name: "主导航" });
  const row = (name: string) => page.locator(".agent-entry").filter({ has: page.getByRole("button", { name: `查看 ${name} 详情`, exact: true }) });
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
  await navigation.getByRole("button", { name: "Harness", exact: true }).click();
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
  // Shown: each is listed with its mark, and only they carry it; the ones not installed come last in "还可以安装".
  await navigation.getByRole("button", { name: "Harness", exact: true }).click();
  await page.getByRole("button", { name: /^显示全部/u }).click();
  for (const name of frozen) await expect(row(name).locator(".harness-frozen")).toHaveText("冻结");
  await expect(row("Codex").locator(".harness-frozen")).toHaveCount(0); await expect(note).toHaveCount(0);
  await page.screenshot({ path: join(artifact, "frozen-shown.png"), animations: "disabled" });
  // A conversation on Gemini CLI, begun from the sidebar: the Agent page has no way back of its own (ADR-054 补充 D).
  await navigation.getByRole("button", { name: "新对话", exact: true }).click();
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
  await page.getByRole("complementary", { name: "主导航" }).getByRole("button", { name: "Harness", exact: true }).click();
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
  // The picker shows the version as a fact, as the Agent page does (no "v"), and nothing about it.
  await expect(option).toContainText("0.3.1"); await expect(option).not.toContainText("v0.3.1"); await expect(option).not.toContainText("验证"); await option.click();
  await composer.fill("hello"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  await expect(log.locator("[data-run-status=completed]")).toHaveCount(1, { timeout: 15000 });
  // The details panel is closed until opened (ADR-054 decision E); it opens on the Turn's execution facts.
  await page.getByRole("button", { name: "详情栏", exact: true }).click();
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

/** The sizes G054-DL10 looks at (ADR-054 验证): a desktop, a phone and the narrowest phone, each at its own height. */
const DL10_SIZES = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }] as const;
type Dl10Size = (typeof DL10_SIZES)[number];
type Dl10Locator = ReturnType<Page["locator"]>;
/** The page's uncaught exceptions and console errors; G054-DL10 causes none, so each of its tests expects this to stay empty. */
function dl10Errors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  return errors;
}
/**
 * Waits until the page has settled: nothing finite moves (transitions, entrances) and no element moved or changed size across two
 * frames, so a check or a shot sees the layout the page chose for its size (a resize reaches it through media queries a frame or
 * more later). What a loop moves (a turning arc) is left out.
 */
async function dl10Settle(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const looping = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations === Infinity).flatMap(animation => {
      const target = (animation.effect as KeyframeEffect | null)?.target; return target ? [target] : []; });
    const shape = () => [...document.querySelectorAll("body *")].filter(element => !looping.some(target => target.contains(element))).map(element => {
      const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height].join(","); }).join(";");
    const before = shape();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return shape() === before && !document.getAnimations().some(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity);
  }), { message: "the page settles", timeout: 15000 }).toBe(true);
}
/**
 * Asserts the page fits its width (ADR-054 R01): neither the document nor the scrolling body of any of `anchors` (the nearest
 * element at or above it whose overflow-y scrolls, else the anchor itself) scrolls sideways, and no visible element ends past the
 * viewport's right edge, except inside an element that scrolls sideways on purpose (overflow-x auto or scroll with wider content:
 * code, diffs, the capability matrix) or inside a clipping box with no room left inside its borders, which shows nothing. The failure
 * names each offender by a selector and its text.
 */
async function dl10Fits(page: Page, label: string, anchors: readonly Dl10Locator[]): Promise<void> {
  const handles = await Promise.all(anchors.map(anchor => anchor.elementHandle({ timeout: 10000 })));
  try {
    const problems = await page.evaluate(bodies => {
      const limit = document.documentElement.clientWidth, problems: string[] = [];
      const name = (element: Element) => {
        const parts: string[] = [];
        for (let node: Element | null = element, depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
          const classes = (node.getAttribute("class") ?? "").trim().split(/\s+/u).filter(Boolean).slice(0, 3), role = node.getAttribute("role"), label = node.getAttribute("aria-label");
          parts.unshift(node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (classes.length ? "." + classes.join(".") : "") + (role ? `[role=${role}]` : "") + (label ? `[aria-label="${label}"]` : ""));
        }
        const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 60);
        return (parts.join(" > ") || element.tagName.toLowerCase()) + (text ? ` “${text}”` : "");
      };
      for (const element of [document.documentElement, document.body]) if (element.scrollWidth > element.clientWidth + 1) problems.push(`${name(element)} scrolls sideways (${element.scrollWidth} > ${element.clientWidth})`);
      for (const anchor of bodies) {
        let body: Element | null = anchor;
        while (body && !/^(auto|scroll)$/u.test(getComputedStyle(body).overflowY)) body = body.parentElement;
        const target = body ?? anchor;
        if (target.scrollWidth > target.clientWidth + 1) problems.push(`the body ${name(target)} scrolls sideways (${target.scrollWidth} > ${target.clientWidth})`);
      }
      // The outermost element that sticks out is named; what is inside it sticks out with it.
      const walk = (element: Element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.height > 0 && box.right > limit + 1) { problems.push(`${name(element)} ends at ${Math.round(box.right)}, past ${limit}`); return; }
        // A box that clips and has no room left inside its borders (a panel closed to its hairline, still mounted) shows nothing inside.
        if (style.overflowX !== "visible" && !/^(inline|contents)$/u.test(style.display) && (element.clientWidth === 0 || element.clientHeight === 0)) return;
        if (/^(auto|scroll)$/u.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1) return;
        for (const child of element.children) walk(child);
      };
      walk(document.body);
      return problems;
    }, handles);
    assert.deepEqual(problems, [], `${label} does not fit its width:\n${problems.join("\n")}`);
  } finally { await Promise.all(handles.map(handle => handle.dispose())); }
}
/**
 * Asserts the page reads in its theme (ADR-054 R02): its own background is the theme's (light or dark), and every visible text is
 * read against what is painted behind it, its own and its ancestors' backgrounds laid over each other. Text smaller than 24 px
 * needs WCAG AA, 4.5:1, whatever its colour and whatever tint it sits on (ruling M): grey on grey, a status colour, the diff's
 * lines; only text of 24 px and up may use 3:1. Text an ancestor fades (a disabled control) or that sits on an image is left to
 * the shots.
 */
async function dl10Readable(page: Page, label: string, scheme: "light" | "dark"): Promise<void> {
  const { ground, faint } = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true })!;
    // Any CSS color as the 8-bit sRGB pixel it paints, and its alpha.
    const rgba = (value: string): [number, number, number, number] => {
      paint.clearRect(0, 0, 1, 1); paint.fillStyle = "#000"; paint.fillStyle = value; paint.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = paint.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255];
    };
    const over = (top: readonly number[], bottom: readonly number[]) => [0, 1, 2].map(index => top[index]! * top[3]! + bottom[index]! * (1 - top[3]!));
    const luminance = (color: readonly number[]) => { const [r = 0, g = 0, b = 0] = color.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
    const behind = (element: Element): number[] | null => {
      const layers: number[][] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (Number(style.opacity) < 1 || style.backgroundImage !== "none") return null;
        const color = rgba(style.backgroundColor);
        if (color[3] > 0) layers.push(color);
        if (color[3] >= 1) break;
      }
      return layers.reverse().reduce<number[]>((ground, layer) => over(layer, ground), [255, 255, 255]);
    };
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight, faint: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim())) continue;
      const box = element.getBoundingClientRect(), style = getComputedStyle(element), ink = rgba(style.color);
      if (box.width < 2 || box.height < 2 || box.right <= 0 || box.left >= width || box.bottom <= 0 || box.top >= height || style.visibility !== "visible" || ink[3] === 0) continue;
      const ground = behind(element);
      if (!ground) continue;
      const shown = over(ink, ground), [light = 0, dark = 0] = [luminance(shown), luminance(ground)].sort((a, b) => b - a), ratio = (light + .05) / (dark + .05);
      const floor = parseFloat(style.fontSize) < 24 ? 4.5 : 3;
      if (ratio < floor) faint.push(`${ratio.toFixed(2)}:1 (under ${floor}:1) ${style.color} on rgb(${ground.map(Math.round).join(", ")}) ${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").trim().split(/\s+/u).slice(0, 4).join(".")} “${(element.textContent ?? "").trim().slice(0, 40)}”`);
    }
    return { ground: luminance(behind(document.body) ?? [255, 255, 255]), faint };
  });
  assert.ok(scheme === "dark" ? ground < .05 : ground > .9, `${label}: the page's background follows the ${scheme} theme (luminance ${ground.toFixed(3)})`);
  assert.deepEqual(faint, [], `${label}: text too faint to read:\n${faint.join("\n")}`);
}
/** Whether the sidebar (complementary 主导航) is anywhere on screen, also behind a modal layer that hides it from assistive technology. */
function dl10SidebarShown(page: Page): Promise<boolean> {
  return page.getByRole("complementary", { name: "主导航", includeHidden: true }).evaluateAll(elements => elements.some(element => {
    const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && getComputedStyle(element).visibility !== "hidden"; }));
}
/**
 * On a phone the sidebar is a drawer (ADR-054 S06): off screen until 打开导航 opens it, which Enter on the button does; the drawer
 * takes the focus and fits the screen, Escape closes it and the focus is back on 打开导航. With `shot`, the open drawer is saved
 * under that file name. Returns with nothing focused, so the next shot shows no focus ring.
 */
async function dl10Drawer(page: Page, label: string, shot?: string): Promise<void> {
  const menu = page.getByRole("button", { name: "打开导航", exact: true }), drawer = page.getByRole("dialog", { name: "主导航" });
  assert.equal(await dl10SidebarShown(page), false, label + ": the sidebar stays off screen until it is opened");
  await menu.focus(); await page.keyboard.press("Enter");
  await expect(drawer.getByRole("complementary", { name: "主导航" })).toBeVisible(); await dl10Settle(page);
  assert.equal(await dl10SidebarShown(page), true, label + ": 打开导航 brings the sidebar on screen");
  await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement)), { message: label + ": the drawer takes the focus" }).toBe(true);
  await dl10Opaque(drawer.getByRole("complementary", { name: "主导航" }), label + " with the drawer open");
  await dl10Fits(page, label + " with the drawer open", [drawer.getByRole("complementary", { name: "主导航" })]);
  if (shot) await page.screenshot({ path: join(artifact, shot), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0); await expect(menu).toBeFocused();
  assert.equal(await dl10SidebarShown(page), false, label + ": Escape takes the sidebar off screen again");
  await menu.evaluate(element => (element as HTMLElement).blur());
}
/**
 * Waits until `target` and everything above it are at full opacity (D6): what fades in is checked and saved whole, and
 * dl10Readable, which leaves faded text to the shots, does not pass over it.
 */
async function dl10Opaque(target: Dl10Locator, label: string): Promise<void> {
  await expect.poll(() => target.evaluate(element => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    return opacity;
  }), { message: label + ": shown at full opacity", timeout: 10000 }).toBe(1);
}
/**
 * One state of a page at each size in both themes (ADR-054 R01, R02): `ready` brings the state back at a size (some take another
 * form across the narrow breakpoint); on the settled page each of `anchors` is at full opacity, the sidebar is beside the page on
 * the desktop and off screen on a phone, `check` asserts what the state itself must be at that size, and the page must fit
 * (dl10Fits on `anchors`) and read (dl10Readable). The page is then saved as dl10-<name>-<light|dark>-<width>.png, with the pointer
 * resting in a corner. With `drawer`, on a phone the sidebar's drawer is also opened and closed from the keyboard: in the light
 * theme, or with "shoot" in both and saved as dl10-drawer-<light|dark>-<width>.png.
 */
async function dl10Shoot(page: Page, name: string, options: { readonly anchors: () => readonly Dl10Locator[]; readonly ready?: (size: Dl10Size) => Promise<void>; readonly check?: (size: Dl10Size, label: string) => Promise<void>; readonly sizes?: readonly Dl10Size[]; readonly drawer?: "check" | "shoot" }): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const size of options.sizes ?? DL10_SIZES) {
      await page.setViewportSize(size); await page.mouse.move(size.width - 2, size.height - 2); await dl10Settle(page);
      await options.ready?.(size); await page.mouse.move(size.width - 2, size.height - 2); await dl10Settle(page);
      const label = `${name} at ${size.width} in ${scheme}`, phone = size.width < 760;
      for (const anchor of options.anchors()) await dl10Opaque(anchor, label);
      assert.equal(await dl10SidebarShown(page), !phone, label + (phone ? ": on a phone the sidebar is a drawer, off screen until opened" : ": on a desktop the sidebar is beside the page"));
      await options.check?.(size, label);
      await dl10Fits(page, label, options.anchors());
      await dl10Readable(page, label, scheme);
      await page.screenshot({ path: join(artifact, `dl10-${name}-${scheme}-${size.width}.png`), animations: "disabled" });
      if (phone && options.drawer && (scheme === "light" || options.drawer === "shoot")) await dl10Drawer(page, label, options.drawer === "shoot" ? `dl10-drawer-${scheme}-${size.width}.png` : undefined);
    }
  }
  await page.emulateMedia({ colorScheme: "light" }); await page.setViewportSize(DL10_SIZES[0]); await dl10Settle(page);
}
/** One animation or transition the page ran: what it animates, for how long, after what delay, how many times, and on what. */
interface Dl10Motion { readonly kind: string; readonly properties: readonly string[]; readonly duration: number; readonly delay: number; readonly iterations: number; readonly target: string }
/**
 * Records every animation and transition the pages of `context` run (ADR-054 §3): at each animation frame and each start event the
 * page's document.getAnimations() is read, and each animation is kept once (dl10Still reads and empties the record).
 */
async function dl10RecordMotion(context: Awaited<ReturnType<typeof isolatedContext>>): Promise<void> {
  await context.addInitScript(() => {
    const record: unknown[] = [], seen = new WeakSet<Animation>();
    const look = () => {
      for (const animation of document.getAnimations()) {
        if (seen.has(animation)) continue;
        seen.add(animation);
        const effect = animation.effect as KeyframeEffect | null, timing = effect?.getComputedTiming(), target = effect?.target ?? null;
        const properties = animation instanceof CSSTransition ? [animation.transitionProperty] : [...new Set((effect?.getKeyframes() ?? []).flatMap(frame =>
          Object.keys(frame).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key)).map(key => key.replace(/[A-Z]/gu, letter => "-" + letter.toLowerCase()))))];
        record.push({ kind: animation instanceof CSSTransition ? "transition" : animation instanceof CSSAnimation ? "animation " + animation.animationName : "script animation", properties,
          duration: Number(timing?.duration ?? 0), delay: timing?.delay ?? 0, iterations: timing?.iterations ?? 1,
          target: target ? target.tagName.toLowerCase() + "." + (target.getAttribute("class") ?? "").trim().split(/\s+/u).slice(0, 4).join(".") + (effect?.pseudoElement ?? "") : "" });
      }
    };
    const frame = () => { look(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    for (const type of ["transitionrun", "animationstart"]) document.addEventListener(type, look, true);
    Object.defineProperty(window, "__dl10Motion", { value: () => record.splice(0) });
  });
}
/** The colors a hover or focus changes (#30), which reduced motion keeps changing as usual: they move nothing. */
const DL10_COLORS = new Set(["color", "background-color", "border-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "box-shadow", "fill", "stroke", "text-decoration-color"]);
/**
 * Asserts that, with reduced motion, all the page ran since the last call only faded (ADR-054 §3, R04): every animation and
 * transition the record caught changes opacity (a transition may also change a hover or focus color), lasts 150 ms or less with its
 * delay, and does not loop. Returns what ran.
 */
async function dl10Still(page: Page, label: string): Promise<readonly Dl10Motion[]> {
  await dl10Settle(page);
  const ran = await page.evaluate(() => (window as unknown as { __dl10Motion: () => Dl10Motion[] }).__dl10Motion());
  const moving = ran.filter(entry => entry.iterations === Infinity || entry.delay + entry.duration * entry.iterations > 150
    || entry.duration > 0 && !entry.properties.every(property => property === "opacity" || entry.kind === "transition" && DL10_COLORS.has(property)));
  assert.deepEqual(moving, [], `${label}: with reduced motion only fades of 150 ms or less run:\n${moving.map(entry => `${entry.kind} of ${entry.properties.join(", ")} on ${entry.target}: ${entry.duration} ms × ${entry.iterations} after ${entry.delay} ms`).join("\n")}`);
  return ran;
}

test("G054-DL10 the home on first use and on return, a finished Turn with its steps and diff and its details, an approval at the composer, the inbox, the palette and the shortcut sheet fit 1440, 390 and 320 and read in both themes, and on a phone the sidebar is a drawer the keyboard opens and closes", { timeout: 300000 }, async t => {
  // The DeepSeek Harness shim keeps discovery to the fixture's programs: the PATH holds Node.js alone, not what this computer has installed.
  const fixture = await launchFixture(false, { name: "Shared Agent", scenario: "hermes" }, null, false, undefined, undefined, { dsh: "0.3.1" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: DL10_SIZES[0] }), page = await context.newPage(), errors = dl10Errors(page);
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin, composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  const pick = async (name: string) => { await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name, exact: true }).click(); };
  const greeting = page.getByRole("heading", { name: "今天想让哪个 Harness 做什么？", exact: true }), navigation = page.getByRole("complementary", { name: "主导航" });
  // H06: the first time, the home walks through its three steps.
  await expect(greeting).toBeVisible(); await expect(page.getByRole("list", { name: "开始使用" }).getByRole("listitem")).toHaveCount(3);
  await dl10Shoot(page, "home-first", { anchors: () => [greeting], drawer: "check" });

  // A finished Turn with its steps opened and the edit's diff shown in the conversation.
  await pick("Codex"); await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  await expect.poll(async () => (await current()).runs[0]?.status, { timeout: 15000 }).toBe("completed");
  const process = log.getByRole("button", { name: /运行 1 条命令/u });
  await expect(process).toHaveAttribute("aria-expanded", "false"); await process.click(); await expect(process).toHaveAttribute("aria-expanded", "true");
  await log.getByRole("list", { name: "工具活动" }).getByRole("button", { name: /修改 README\.md/u }).click();
  await expect(log.getByText("新内容", { exact: true }).first()).toBeVisible();
  // The details panel is not taken to be open or closed by default: its header button says which, and is pressed until it does.
  const details = page.getByRole("button", { name: "详情栏", exact: true }), panel = page.getByRole("complementary", { name: "详情栏" });
  const showDetails = async (open: boolean) => { if (await details.getAttribute("aria-pressed") !== String(open)) await details.click(); await expect(details).toHaveAttribute("aria-pressed", String(open)); };
  await dl10Shoot(page, "conversation", { anchors: () => [log], drawer: "shoot", ready: async size => { if (size.width === 1440) await showDetails(false); } });
  // D01-D03: the same conversation with its details beside it, on 改动.
  await dl10Shoot(page, "conversation-panel", { sizes: [DL10_SIZES[0]], anchors: () => [log, panel.getByRole("tabpanel")], ready: async () => {
    await showDetails(true);
    const changes = panel.getByRole("tab", { name: /^改动/u }); await changes.click(); await expect(changes).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tabpanel")).toContainText("README.md");
  } });
  await showDetails(false);

  // On return the home says who is ready instead of the first steps.
  await navigation.getByRole("button", { name: "新对话", exact: true }).click();
  await expect(greeting).toBeVisible(); await expect(page.getByRole("list", { name: "开始使用" })).toHaveCount(0);
  await dl10Shoot(page, "home", { anchors: () => [greeting], drawer: "check" });

  // P02: an approval waits in the composer's place.
  await pick("Shared Agent"); await composer.fill("approve this"); await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeEnabled(); await composer.press("Enter");
  const dock = page.getByRole("region", { name: "工具审批", exact: true });
  await expect(dock).toContainText("rm -rf build", { timeout: 15000 }); await expect(composer).toBeHidden();
  await dl10Shoot(page, "approval", { anchors: () => [log, dock], drawer: "check" });
  // The keyboard's trips through the drawer decided nothing: Enter went to 打开导航, not to the approval.
  await expect(dock).toContainText("rm -rf build");

  // X03: the inbox, beside its row on the desktop and a sheet of its own on a phone (crossing the breakpoint closes either).
  await navigation.getByRole("button", { name: "新对话", exact: true }).click(); await expect(greeting).toBeVisible();
  const inbox = page.getByRole("dialog", { name: "等你处理" }), inboxRow = navigation.getByRole("button", { name: "等你处理（1 项）", exact: true });
  await dl10Shoot(page, "inbox", { anchors: () => [inbox], ready: async size => {
    if (await inbox.count()) return;
    if (size.width < 760) { await page.getByRole("button", { name: "打开导航", exact: true }).click(); await page.getByRole("dialog", { name: "主导航" }).getByRole("button", { name: "等你处理（1 项）", exact: true }).click(); }
    else await inboxRow.click();
    await expect(inbox).toContainText("approve this"); await expect(inbox).toContainText("rm -rf build");
  }, check: async (size, label) => {
    // The form it takes there: a sheet across the bottom of a phone, a popover level with its row beside the sidebar on a desktop.
    const box = await inbox.boundingBox(); assert.ok(box, label + ": the inbox is on screen");
    if (size.width < 760) assert.ok(box.x <= 16 && box.x + box.width >= size.width - 16 && box.y + box.height >= size.height - 16, `${label}: on a phone the inbox is a sheet across the bottom of the screen: ${JSON.stringify(box)}`);
    else {
      const row = await inboxRow.boundingBox(), sidebar = await navigation.boundingBox(); assert.ok(row && sidebar);
      assert.ok(box.x >= sidebar.x + sidebar.width - 1 && box.y <= row.y + row.height && box.y + box.height >= row.y && box.width < size.width / 2,
        `${label}: on a desktop the inbox is a popover beside its row, right of the sidebar: ${JSON.stringify({ box, row, sidebar })}`);
    }
  } });
  await page.keyboard.press("Escape"); await expect(inbox).toHaveCount(0);

  // ⌘K and ⌘/.
  const search = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }), palette = page.getByRole("dialog").filter({ has: search });
  await page.keyboard.press("ControlOrMeta+K"); await expect(search).toBeFocused();
  await expect(palette.getByRole("option", { name: /NATIVE_ACTIVITY/u })).toBeVisible();
  await dl10Shoot(page, "palette", { anchors: () => [palette.getByRole("listbox")] });
  await page.keyboard.press("Escape"); await expect(palette).toHaveCount(0);
  const sheet = page.getByRole("dialog", { name: "快捷键" });
  await page.keyboard.press("ControlOrMeta+/"); await expect(sheet).toContainText("搜索与命令");
  await dl10Shoot(page, "shortcuts", { anchors: () => [sheet] });
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0);
  assert.deepEqual(errors, []);
});

test("G054-DL10 the Agent page and an Agent's details, the capabilities, the settings and the model connections fit 1440, 390 and 320 and read in both themes, and on a phone the sidebar is a drawer the keyboard opens and closes", { timeout: 300000 }, async t => {
  // Provider management is on so the model connections page is shown; the DeepSeek Harness shim keeps discovery to the fixture's programs.
  const fixture = await launchFixture(true, null, null, false, undefined, undefined, { dsh: "0.3.1" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  await mkdir(artifact, { recursive: true });
  const context = await isolatedContext(browser, { viewport: DL10_SIZES[0] }), page = await context.newPage(), errors = dl10Errors(page);
  // The capability page shows the synthetic view the CA tests use, so its matrix has every kind of cell.
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  // One model connection exists before the page opens, so its page lists it.
  const launch = new URL(fixture.gateway.url), origin = launch.origin;
  const boot = await context.request.post(origin + "/api/v1/auth/bootstrap", { headers: { Origin: origin }, data: { token: new URLSearchParams(launch.hash.slice(1)).get("token") } });
  assert.equal(boot.status(), 200); const csrf = String((await boot.json()).csrfToken);
  assert.equal((await context.request.post(origin + "/api/v1/providers", { headers: { Origin: origin, "X-CSRF-Token": csrf }, data: { commandId: "dl10-provider", input: {
    name: "验收模型连接", protocol: "openai-responses", baseUrl: fixture.baseUrl, models: ["model-a", "model-b"], defaultModel: "model-a", enabled: true, apiKey: "dl10-synthetic-fixture-key" } } })).status(), 201);
  await page.goto(origin);
  const navigation = page.getByRole("complementary", { name: "主导航" }), go = (name: string) => navigation.getByRole("button", { name, exact: true }).click();
  await expect(navigation.getByRole("button", { name: "新对话", exact: true })).toBeVisible();

  await go("Harness");
  const agents = page.getByRole("heading", { level: 1, name: "Harness", exact: true });
  await expect(agents).toBeVisible(); await expect(page.getByRole("button", { name: "查看 Codex 详情", exact: true })).toBeVisible();
  await dl10Shoot(page, "agents", { anchors: () => [agents], drawer: "check" });
  // A03: one Agent's details, beside the cards on the desktop and over the page on a phone. Beside them the cards make room, so the
  // page's own body is checked as well (found under the phone's modal drawer too).
  const codex = page.getByRole("dialog", { name: "Codex 详情" }), agentsBody = page.getByRole("heading", { level: 1, name: "Harness", exact: true, includeHidden: true });
  await dl10Shoot(page, "agent-details", { anchors: () => [agentsBody, codex.getByRole("heading", { name: "模型与登录", exact: true })], ready: async () => {
    if (await codex.count()) return;
    await page.getByRole("button", { name: "查看 Codex 详情", exact: true }).click(); await expect(codex).toBeVisible();
  } });
  await page.keyboard.press("Escape"); await expect(codex).toHaveCount(0);

  await go("能力");
  await expect(page.getByRole("heading", { name: /^技能/u })).toBeVisible(); await expect(page.getByRole("tabpanel")).toContainText("alpha");
  await dl10Shoot(page, "capabilities", { anchors: () => [page.getByRole("tabpanel")], drawer: "check" });

  await go("设置");
  const settings = page.getByRole("heading", { level: 1, name: "设置", exact: true });
  await expect(settings).toBeVisible();
  await dl10Shoot(page, "settings", { anchors: () => [settings], drawer: "check" });

  await go("模型连接");
  const providers = page.getByRole("heading", { level: 1, name: "模型连接", exact: true });
  await expect(providers).toBeVisible(); await expect(page.getByRole("heading", { name: "验收模型连接", exact: true })).toBeVisible();
  await dl10Shoot(page, "providers", { anchors: () => [providers], drawer: "check" });
  assert.ok(!(await page.locator("body").innerText()).includes("dl10-synthetic-fixture-key"), "the connection's key is never shown");
  assert.deepEqual(errors, []);
});

test("G054-DL10 with reduced motion a Turn, the palette, the details, an Agent's details, a capability dialog and the drawer only fade, within 150 ms and never in a loop, and each opens and closes from the pointer and from the keyboard", { timeout: 300000 }, async t => {
  const fixture = await launchFixture(false, null, null, false, undefined, undefined, { dsh: "0.3.1" }); let browser: Browser | null = null;
  t.after(async () => { try { await browser?.close(); } finally { await fixture.close(); } });
  browser = await chromium.launch({ headless: true });
  const context = await isolatedContext(browser, { viewport: DL10_SIZES[0] });
  await dl10RecordMotion(context);
  const page = await context.newPage(), errors = dl10Errors(page);
  await page.route("**/api/v1/capabilities", route => route.fulfill({ json: capabilityView() }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(fixture.gateway.url);
  const origin = new URL(fixture.gateway.url).origin, composer = page.getByRole("textbox", { name: "发送消息", exact: true }), log = page.getByRole("log", { name: "对话历史" });
  const navigation = page.getByRole("complementary", { name: "主导航" }), go = (name: string) => navigation.getByRole("button", { name, exact: true }).click();
  const current = async () => { const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get("session"); assert.ok(id); return (await context.request.get(origin + "/api/v1/sessions/" + id)).json(); };
  await expect(page.getByRole("heading", { name: "今天想让哪个 Harness 做什么？", exact: true })).toBeVisible();
  await dl10Still(page, "the home as it opens");
  // The palette: opened with the pointer it fades in (so the record is known to catch a fade) and fades out when the scrim beside it is
  // clicked; ⌘K and esc open and close it at once.
  const search = page.getByRole("combobox", { name: "搜索对话、页面或操作", exact: true }), palette = page.getByRole("dialog").filter({ has: search });
  const paletteBoth = async (where: string) => {
    await navigation.getByRole("button", { name: "搜索与命令", exact: true }).click(); await expect(search).toBeFocused();
    const opened = await dl10Still(page, `the palette opened with the pointer on ${where}`);
    assert.ok(opened.some(entry => entry.properties.includes("opacity")), `the palette fades in on ${where}: ` + JSON.stringify(opened));
    await page.mouse.click(page.viewportSize()!.width - 8, 8); await expect(palette).toHaveCount(0);
    await dl10Still(page, `the palette closed with the pointer on ${where}`);
    await page.keyboard.press("ControlOrMeta+K"); await expect(search).toBeFocused(); await search.fill("设置"); await expect(palette.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape"); await expect(palette).toHaveCount(0);
    await dl10Still(page, `the palette from the keyboard on ${where}`);
  };
  await paletteBoth("the home");

  // A whole Turn, from the message rising in to its folded process line, only fades.
  await page.getByRole("button", { name: "选择 Harness", exact: true }).click(); await page.getByRole("option", { name: "Codex", exact: true }).click();
  await composer.fill("NATIVE_ACTIVITY"); await composer.press("Enter");
  await expect(log).toContainText("原生活动已完成。");
  await expect.poll(async () => (await current()).runs[0]?.status, { timeout: 15000 }).toBe("completed");
  await expect(log.getByRole("button", { name: /运行 1 条命令/u })).toHaveAttribute("aria-expanded", "false");
  await dl10Still(page, "a Turn from its message to its folded process");
  await paletteBoth("the conversation");
  // The details beside the conversation: from the pointer and from ⌘\, open and closed again.
  const details = page.getByRole("button", { name: "详情栏", exact: true }), panel = page.getByRole("complementary", { name: "详情栏" });
  const pressed = async (open: boolean) => { await expect(details).toHaveAttribute("aria-pressed", String(open)); if (open) await expect(panel.getByRole("tab").first()).toBeVisible(); else await expect(panel).toHaveCount(0); };
  const before = await details.getAttribute("aria-pressed") === "true";
  for (const open of [!before, before]) { await details.click(); await pressed(open); await dl10Still(page, `the details ${open ? "opened" : "closed"} with the pointer`); }
  for (const open of [!before, before]) { await page.keyboard.press("ControlOrMeta+\\"); await pressed(open); await dl10Still(page, `the details ${open ? "opened" : "closed"} with ⌘\\`); }
  // On a phone they are a sheet over the conversation: the pointer opens it and its close button closes it; Enter and esc do the same.
  await page.setViewportSize(DL10_SIZES[1]); await dl10Settle(page);
  const sheet = page.getByRole("dialog", { name: "详情栏" });
  await details.click(); await expect(sheet.getByRole("tab").first()).toBeVisible();
  await dl10Still(page, "the details sheet opened with the pointer");
  await sheet.getByRole("button", { name: "关闭详情栏", exact: true }).click(); await expect(sheet).toHaveCount(0);
  await dl10Still(page, "the details sheet closed with the pointer");
  await details.focus(); await page.keyboard.press("Enter"); await expect(sheet.getByRole("tab").first()).toBeVisible();
  await expect.poll(() => sheet.evaluate(element => element.contains(document.activeElement)), { message: "the details sheet takes the focus" }).toBe(true);
  await page.keyboard.press("Escape"); await expect(sheet).toHaveCount(0); await expect(details).toBeFocused();
  await dl10Still(page, "the details sheet from the keyboard");
  // The drawer of the sidebar: the pointer opens it and its close button closes it; Enter and esc do the same (dl10Drawer).
  const drawer = page.getByRole("dialog", { name: "主导航" });
  await page.getByRole("button", { name: "打开导航", exact: true }).click(); await expect(drawer.getByRole("complementary", { name: "主导航" })).toBeVisible();
  await dl10Still(page, "the drawer opened with the pointer");
  await drawer.getByRole("button", { name: "关闭导航", exact: true }).click(); await expect(drawer).toHaveCount(0);
  await dl10Still(page, "the drawer closed with the pointer");
  await dl10Drawer(page, "the drawer from the keyboard with reduced motion");
  await dl10Still(page, "the drawer from the keyboard");
  await page.setViewportSize(DL10_SIZES[0]); await dl10Settle(page); await dl10Still(page, "the conversation back on the desktop");

  // An Agent's details: from the pointer (opened from its card, closed by its close button) and from the keyboard (Enter, esc).
  await go("Harness"); await expect(page.getByRole("heading", { level: 1, name: "Harness", exact: true })).toBeVisible();
  await dl10Still(page, "the Agent page as it opens");
  await paletteBoth("the Agent page");
  const open = page.getByRole("button", { name: "查看 Codex 详情", exact: true }), codex = page.getByRole("dialog", { name: "Codex 详情" });
  await open.click(); await expect(codex).toBeVisible();
  await dl10Still(page, "an Agent's details opened with the pointer");
  await codex.getByRole("button", { name: "关闭 Harness 详情", exact: true }).click(); await expect(codex).toHaveCount(0);
  await dl10Still(page, "an Agent's details closed with the pointer");
  await open.focus(); await page.keyboard.press("Enter"); await expect(codex).toBeVisible();
  await expect.poll(() => codex.evaluate(element => element.contains(document.activeElement)), { message: "the details take the focus" }).toBe(true);
  await page.keyboard.press("Escape"); await expect(codex).toHaveCount(0); await expect(open).toBeFocused();
  await dl10Still(page, "an Agent's details from the keyboard");

  // A capability dialog: 新建技能 from the pointer (closed by 取消) and from the keyboard (Enter, esc).
  await go("能力"); await expect(page.getByRole("tabpanel")).toContainText("alpha");
  await dl10Still(page, "the capability page as it opens");
  await paletteBoth("the capability page");
  const create = page.getByRole("button", { name: "新建技能", exact: true }), dialog = page.getByRole("dialog", { name: "新建技能" });
  await create.click(); await expect(dialog.getByRole("textbox", { name: "技能名字" })).toBeVisible();
  await dl10Still(page, "a capability dialog opened with the pointer");
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toHaveCount(0);
  await dl10Still(page, "a capability dialog closed with the pointer");
  await create.focus(); await page.keyboard.press("Enter"); await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)), { message: "the dialog takes the focus" }).toBe(true);
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(create).toBeFocused();
  await dl10Still(page, "a capability dialog from the keyboard");
  assert.deepEqual(errors, []);
});
