import { app, BaseWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell, View, WebContentsView, type MenuItemConstructorOptions, type WebContents } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

app.setName("HarnessHub");
const given = parseArgs({ args: process.argv.slice(app.isPackaged ? 1 : 2), strict: false, options: {
  "hub-data-dir": { type: "string" }, "hub-cwd": { type: "string" }, "hub-port": { type: "string" }, "hub-scratch-dir": { type: "string" }, "hub-node": { type: "string" }, "hub-user-data": { type: "string" },
} }).values;
const word = (value: unknown): string | undefined => typeof value === "string" && value.trim() !== "" ? value : undefined;
// A second set of the app's own files (window place, runtime, logs), so a trial beside the installed app shares nothing with it.
if (word(given["hub-user-data"])) app.setPath("userData", resolve(word(given["hub-user-data"])!));
const userData = app.getPath("userData");

interface Settings { readonly dataDir: string; readonly cwd: string; readonly port: number; readonly scratchDir: string | null; readonly node: string | null }
function readSettings(): Settings {
  let saved: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(readFileSync(join(userData, "desktop.json"), "utf8")); if (typeof value === "object" && value !== null) saved = value as Record<string, unknown>; } catch { /* the defaults */ }
  const port = Number(word(given["hub-port"]) ?? saved.port ?? 4317);
  return {
    dataDir: resolve(word(given["hub-data-dir"]) ?? word(saved.dataDir) ?? join(userData, "data")),
    cwd: resolve(word(given["hub-cwd"]) ?? word(saved.cwd) ?? homedir()),
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 4317,
    scratchDir: word(given["hub-scratch-dir"]) ?? word(saved.scratchDir) ?? null,
    node: word(given["hub-node"]) ?? word(saved.node) ?? null,
  };
}
const settings = readSettings();

/** What a terminal's login shell would give a program: the PATH that finds each Harness, and whatever the user exports there. */
function shellEnvironment(): Promise<Record<string, string>> {
  const own = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const shellPath = process.env.SHELL || "/bin/zsh";
  const base: Record<string, string> = { HOME: homedir(), SHELL: shellPath, TERM: "dumb", LANG: process.env.LANG || "en_US.UTF-8" };
  for (const name of ["USER", "LOGNAME", "TMPDIR"]) { const value = process.env[name]; if (value) base[name] = value; }
  return new Promise(done => {
    execFile(shellPath, ["-ilc", "printf '\\0HHENV\\0'; /usr/bin/env -0"], { env: base, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }, (error, stdout) => {
      const text = stdout.toString("utf8"), mark = text.indexOf("\0HHENV\0");
      if (error !== null && mark < 0) { done(own); return; }
      const read: Record<string, string> = {};
      for (const pair of text.slice(mark + 7).split("\0")) { const at = pair.indexOf("="); if (at > 0) read[pair.slice(0, at)] = pair.slice(at + 1); }
      done(read.PATH ? read : own);
    });
  });
}

/** The system's Liquid Glass behind the page (desktop/native/glass.mm); absent where the module was not built, and the window then takes the older material. */
interface Glass {
  prepare(handle: Buffer): boolean; behind(handle: Buffer, other: Buffer): boolean; describe(handle: Buffer): string;
  pane(handle: Buffer, id: string, left: number, top: number, width: number, height: number, radius: number, clear: number, alpha: number, anchor: number, order: number): void;
  backdrop(handle: Buffer, red?: number, green?: number, blue?: number, left?: number, inset?: number, width?: number, radius?: number): void;
}
let glass: Glass | null = null;
try { glass = createRequire(import.meta.url)("./native/glass.node") as Glass; } catch { glass = null; }
let material: "liquid" | "vibrancy" = "vibrancy";
/** Whether a copy of the page lies behind the window for its glass to show: the page's floating surfaces are then the system's glass too. */
let layered = false;

const logFile = join(userData, "logs", "gateway.log");
function log(line: string): void { try { appendFileSync(logFile, new Date().toISOString() + " " + line + "\n", { mode: 0o600 }); } catch { /* the log is a convenience */ } }

interface Gateway { readonly url: string; readonly child: ChildProcess }
let environment: Promise<Record<string, string>> | null = null;
async function startGateway(): Promise<Gateway> {
  const env = await (environment ??= shellEnvironment());
  const args = ["--cwd", settings.cwd, "--data-dir", settings.dataDir, "--port", String(settings.port), ...(settings.scratchDir === null ? [] : ["--scratch-dir", resolve(settings.scratchDir)])];
  const child = settings.node !== null
    ? spawn(settings.node, [join(root, "dist", "src", "cli", "web.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [join(here, "gateway.js"), ...args], { env: { ...env, ELECTRON_RUN_AS_NODE: "1", HARNESSHUB_RUNTIME_DIR: join(userData, "runtime") }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((done, fail) => {
    let said = "";
    // The line with the address carries the one-use sign-in token: it goes to the window and nowhere else.
    createInterface({ input: child.stdout! }).on("line", line => { if (/^https?:\/\//u.test(line)) done({ url: line.trim(), child }); else log(line); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { said = (said + chunk).slice(-2000); for (const line of chunk.split("\n")) if (line.trim()) log(line); });
    child.once("error", fail);
    child.once("exit", code => fail(new Error(said.split("\n").filter(line => line.startsWith("HarnessGateway:")).at(-1)?.replace(/^HarnessGateway:\s*/u, "") || said.trim().split("\n").at(-1) || `退出码 ${code ?? "?"}`)));
  });
}

let gateway: Gateway | null = null, win: BaseWindow | null = null, page: WebContents | null = null, copy: BaseWindow | null = null, quitting = false;
let keys: Readonly<Record<string, string>> = {}, checks: Readonly<Record<string, boolean>> = {};
const activity = { running: 0, waiting: 0 };

/** What the window was like when it was last seen: where it stood, and enough of the page's look to stand in for it while the page loads. */
const boundsFile = join(userData, "window.json");
interface Kept { x?: number; y?: number; width?: number; height?: number; sidebar?: boolean; theme?: "system" | "light" | "dark"; zoom?: number }
const kept: Kept = (() => { try { const value: unknown = JSON.parse(readFileSync(boundsFile, "utf8")); return typeof value === "object" && value !== null ? value as Kept : {}; } catch { return {}; } })();
let keeping: NodeJS.Timeout | null = null;
function keep(change: Kept): void {
  Object.assign(kept, change);
  if (keeping !== null) clearTimeout(keeping);
  keeping = setTimeout(() => { try { writeFileSync(boundsFile, JSON.stringify(kept)); } catch { /* next time */ } }, 400);
}
function savedBounds(): { width: number; height: number; x?: number; y?: number } {
  if (typeof kept.width === "number" && typeof kept.height === "number" && typeof kept.x === "number" && typeof kept.y === "number") {
    const area = screen.getDisplayMatching({ x: kept.x, y: kept.y, width: kept.width, height: kept.height }).workArea;
    const width = Math.min(Math.max(kept.width, 760), area.width), height = Math.min(Math.max(kept.height, 480), area.height);
    return { width, height, x: Math.min(Math.max(kept.x, area.x), area.x + area.width - width), y: Math.min(Math.max(kept.y, area.y), area.y + area.height - height) };
  }
  return { width: 1320, height: 860 };
}

// Before the Gateway answers the window shows no page of its own: only its strip that moves the window. Under it stand the window's glass and
// the content layer's color (standIn below).
const BLANK = "data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;height:100%;background:transparent}body{-webkit-app-region:drag}</style>");
/** The page's look while there is no page: the window's own ground, and floating on it the sidebar's pane of glass where it last was. */
let standing = false, laid = new Set<string>();
function standIn(): void {
  if (win === null || win.isDestroyed() || glass === null || material !== "liquid" || standing) return;
  const handle = win.getNativeWindowHandle(), zoom = typeof kept.zoom === "number" && kept.zoom > 0 ? kept.zoom : 1, shown = kept.sidebar !== false;
  const size = win.getContentBounds();
  // The window's ground, as the system's own windows have it (windowBackgroundColor), with the sidebar's pane of glass floating on it.
  const color = nativeTheme.shouldUseDarkColors ? [30 / 255, 30 / 255, 30 / 255] as const : [1, 1, 1] as const;
  glass.backdrop(handle, color[0], color[1], color[2], 8 * zoom, 8 * zoom, shown ? 274 * zoom : 0, 16 * zoom);
  if (shown && !laid.has("sidebar")) { glass.pane(handle, "sidebar", 8 * zoom, 8 * zoom, 274 * zoom, Math.max(size.height - 16 * zoom, 0), 16 * zoom, 0, 1, 4 | 16, 1); laid.add("sidebar"); }
  standing = true;
}
function standDown(): void {
  if (!standing) return;
  standing = false;
  // The page has painted by the time it says where its glass lies; a moment more, and the stand-in fades from under it.
  setTimeout(() => { if (!standing && win !== null && !win.isDestroyed() && glass !== null) glass.backdrop(win.getNativeWindowHandle()); }, 120);
}
const windowState = () => ({ focused: win?.isFocused() ?? false, fullscreen: win?.isFullScreen() ?? false, material, layered });
function sendState(): void { if (win !== null && !win.isDestroyed() && page !== null && !page.isDestroyed()) page.send("hub:state", windowState()); }
function command(id: string): void { if (win === null || page === null) return; if (!win.isVisible()) win.show(); page.send("hub:command", id); }

/*
 * The page is the window's content. Where the system has Liquid Glass, sheets of it lie under the page, which leaves an opening wherever one of
 * its surfaces floats; and right behind the window is fastened a second, bare window holding a copy of the page that the page itself keeps
 * (web/src/ui/mirror.ts: a window it opens by the name "hub-mirror"). The glass shows what is behind the window, so under each opening it shows
 * the copy of what the surface floats over — and the desktop where the copy is clear, as under the sidebar.
 */
function createWindow(): BaseWindow {
  const made = new BaseWindow({
    ...savedBounds(), minWidth: 760, minHeight: 480, show: false, title: "HarnessHub",
    // A transparent window: the page's openings are cleared afresh in every frame (in an opaque window whatever was last drawn there would stay).
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 21, y: 23 }, backgroundColor: "#00000000", transparent: true,
  });
  const layers = new View();
  made.contentView = layers;
  const top = new WebContentsView({ webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  top.setBackgroundColor("#00000000");
  layers.addChildView(top);
  const fit = () => { const { width, height } = made.getContentBounds(); top.setBounds({ x: 0, y: 0, width, height }); if (copy !== null && !copy.isDestroyed()) copy.setBounds(made.getBounds()); };
  fit();
  // Liquid Glass where the system has it: the window itself lets the desktop through and panes of glass lie under the page's openings. Elsewhere
  // the whole window is the older sidebar material.
  material = glass !== null && glass.prepare(made.getNativeWindowHandle()) ? "liquid" : "vibrancy";
  if (material === "vibrancy") made.setVibrancy("sidebar");
  const remember = () => { if (!made.isDestroyed() && !made.isFullScreen() && !made.isMinimized()) keep(made.getBounds()); };
  made.on("resize", () => { fit(); remember(); }).on("move", () => { fit(); remember(); });
  made.on("blur", sendState);
  // Full screen is another space: the copy is fastened behind the window again once the window has arrived there, and once it is back.
  for (const event of ["enter-full-screen", "leave-full-screen"] as const) made.on(event as "enter-full-screen", () => {
    if (copy !== null && !copy.isDestroyed() && glass !== null) { copy.setBounds(made.getBounds()); glass.behind(made.getNativeWindowHandle(), copy.getNativeWindowHandle()); }
    sendState();
  });
  made.on("focus", () => { if (!top.webContents.isDestroyed()) top.webContents.focus(); sendState(); });
  // Closing the window leaves the app and its conversations running, as the Dock icon says; ⌘Q ends them.
  made.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    if (made.isFullScreen()) { made.once("leave-full-screen", () => made.hide()); made.setFullScreen(false); } else made.hide();
  });
  const contents = top.webContents;
  page = contents;
  contents.once("did-finish-load", () => made.show());
  // A page on its way (the first, or the same one again after the Gateway came back): the stand-in holds the window until it has painted.
  contents.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) standIn(); });
  const own = (url: string): boolean => { try { return gateway !== null && new URL(url).origin === new URL(gateway.url).origin; } catch { return false; } };
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === "hub-mirror" && (url === "" || url === "about:blank") && material === "liquid" && glass !== null) return { action: "allow", createWindow: options => {
      const before = copy, held = new WebContentsView({ webContents: (options as { readonly webContents: WebContents }).webContents });
      const under = new BaseWindow({ ...made.getBounds(), show: false, frame: false, transparent: true, hasShadow: false, focusable: false, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, roundedCorners: false, backgroundColor: "#00000000" });
      held.setBackgroundColor("#00000000");
      under.contentView = held;
      under.setIgnoreMouseEvents(true);
      copy = under;
      layered = glass!.behind(made.getNativeWindowHandle(), under.getNativeWindowHandle());
      if (before !== null && !before.isDestroyed()) before.destroy();
      under.once("closed", () => { if (copy === under) { copy = null; layered = false; sendState(); } });
      if (process.env.HARNESSHUB_DEBUG_VIEWS) setTimeout(() => console.log("views\n" + glass!.describe(made.getNativeWindowHandle())), 1500);
      sendState();
      return held.webContents;
    } };
    if (/^(https?|mailto):/u.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => { if (!own(url)) { event.preventDefault(); if (/^(https?|mailto):/u.test(url)) void shell.openExternal(url); } });
  contents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      const can = params.editFlags;
      items.push({ label: "撤销", role: "undo", enabled: can.canUndo }, { label: "重做", role: "redo", enabled: can.canRedo }, { type: "separator" },
        { label: "剪切", role: "cut", enabled: can.canCut }, { label: "拷贝", role: "copy", enabled: can.canCopy }, { label: "粘贴", role: "paste", enabled: can.canPaste }, { type: "separator" },
        { label: "全选", role: "selectAll", enabled: can.canSelectAll });
    } else {
      if (params.linkURL) items.push({ label: "打开链接", click: () => void shell.openExternal(params.linkURL) }, { label: "拷贝链接", click: () => clipboard.writeText(params.linkURL) });
      const chosen = params.selectionText.trim();
      if (chosen) {
        if (items.length) items.push({ type: "separator" });
        items.push({ label: "拷贝", role: "copy" }, { label: `查询“${chosen.length > 20 ? chosen.slice(0, 20) + "…" : chosen}”`, click: () => contents.showDefinitionForSelection() });
      }
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: made });
  });
  void contents.loadURL(BLANK);
  return made;
}

/** A shortcut the page itself answers is shown in the menu and left to the page; one the page has no key for is the menu's own. */
function shown(action: string): MenuItemConstructorOptions {
  const accelerator = keys[action];
  return { click: () => command(action), ...(accelerator ? { accelerator, registerAccelerator: false } : {}) };
}
function buildMenu(): void {
  const check = (id: string): MenuItemConstructorOptions => checks[id] === undefined ? {} : { type: "checkbox", checked: checks[id] };
  const template: MenuItemConstructorOptions[] = [
    { label: "HarnessHub", submenu: [
      { label: "关于 HarnessHub", role: "about" }, { type: "separator" },
      { label: "设置…", accelerator: "Cmd+,", click: () => command("settings") }, { type: "separator" },
      { label: "服务", role: "services" }, { type: "separator" },
      { label: "隐藏 HarnessHub", role: "hide" }, { label: "隐藏其他", role: "hideOthers" }, { label: "全部显示", role: "unhide" }, { type: "separator" },
      { label: "退出 HarnessHub", role: "quit" },
    ] },
    { label: "文件", submenu: [
      { label: "新对话", ...shown("new") },
      { label: "打开文件夹…", accelerator: "Cmd+O", click: () => command("open-folder") }, { type: "separator" },
      { label: "关闭窗口", role: "close" },
    ] },
    { label: "编辑", submenu: [
      { label: "撤销", role: "undo" }, { label: "重做", role: "redo" }, { type: "separator" },
      { label: "剪切", role: "cut" }, { label: "拷贝", role: "copy" }, { label: "粘贴", role: "paste" }, { label: "粘贴并匹配样式", role: "pasteAndMatchStyle" }, { label: "删除", role: "delete" }, { label: "全选", role: "selectAll" }, { type: "separator" },
      { label: "查找…", ...shown("find") },
    ] },
    { label: "显示", submenu: [
      { label: "侧栏", ...check("sidebar"), ...shown("sidebar") }, { label: "详情栏", ...check("panel"), ...shown("panel") }, { label: "终端", ...check("terminal"), ...shown("terminal") }, { type: "separator" },
      { label: "搜索与命令…", ...shown("palette") }, { type: "separator" },
      { label: "实际大小", role: "resetZoom" }, { label: "放大", role: "zoomIn" }, { label: "缩小", role: "zoomOut" }, { type: "separator" },
      { label: "进入全屏幕", role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ type: "separator" as const }, { label: "重新载入", role: "reload" as const }, { label: "开发者工具", role: "toggleDevTools" as const }]),
    ] },
    { label: "对话", submenu: [
      { label: "后退", accelerator: "Cmd+[", click: () => command("back") }, { label: "前进", accelerator: "Cmd+]", click: () => command("forward") }, { type: "separator" },
      { label: "换 Harness", ...shown("picker") }, { label: "选模型", ...shown("model") }, { label: "选思考强度", ...shown("effort") }, { label: "选权限", ...shown("permission") }, { type: "separator" },
      { label: "停止回复", ...shown("stop") }, { type: "separator" },
      { label: "上一个对话", ...shown("previous") }, { label: "下一个对话", ...shown("next") }, { label: "下一件等你处理", ...shown("nextWaiting") },
    ] },
    { label: "窗口", role: "windowMenu", submenu: [
      { label: "最小化", role: "minimize" }, { label: "缩放", role: "zoom" }, { type: "separator" }, { label: "HarnessHub", click: () => win?.show() }, { type: "separator" }, { label: "前置全部窗口", role: "front" },
    ] },
    { label: "帮助", role: "help", submenu: [{ label: "键盘快捷键", ...shown("shortcuts") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface MenuEntry { readonly id?: string; readonly label?: string; readonly type?: "separator" | "checkbox"; readonly checked?: boolean; readonly enabled?: boolean; readonly keys?: string; readonly items?: readonly MenuEntry[] }
function nativeMenu(entries: readonly MenuEntry[], choose: (id: string) => void, depth = 0): MenuItemConstructorOptions[] {
  return entries.slice(0, 200).map((entry): MenuItemConstructorOptions => entry.type === "separator" ? { type: "separator" } : {
    label: String(entry.label ?? "").slice(0, 200), enabled: entry.enabled !== false,
    ...(entry.type === "checkbox" ? { type: "checkbox" as const, checked: entry.checked === true } : {}),
    ...(typeof entry.keys === "string" && entry.keys ? { accelerator: entry.keys, registerAccelerator: false } : {}),
    ...(entry.items !== undefined && depth < 3 ? { submenu: nativeMenu(entry.items, choose, depth + 1) } : typeof entry.id === "string" ? { click: () => choose(entry.id!) } : {}),
  });
}

function wire(): void {
  ipcMain.handle("hub:state", () => windowState());
  ipcMain.on("hub:state-now", event => { event.returnValue = windowState(); });
  // The page says where its openings are (in its own pixels, lowest first), every time they change; the glass lies under them, and a sheet the
  // page no longer names is taken away.
  ipcMain.on("hub:glass", (event, panes: readonly { id?: unknown; left?: unknown; top?: unknown; width?: unknown; height?: unknown; radius?: unknown; clear?: unknown; alpha?: unknown; anchor?: unknown }[]) => {
    if (win === null || page === null || event.sender !== page || glass === null || material !== "liquid" || !Array.isArray(panes)) return;
    const handle = win.getNativeWindowHandle(), zoom = page.getZoomFactor();
    const beneath = copy !== null && !copy.isDestroyed() ? (copy.contentView as WebContentsView).webContents : null;
    if (beneath !== null && !beneath.isDestroyed() && beneath.getZoomFactor() !== zoom) beneath.setZoomFactor(zoom);
    const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback, seen = new Set<string>();
    panes.slice(0, 64).forEach((pane, order) => {
      if (typeof pane.id !== "string" || pane.id.length > 40 || seen.has(pane.id)) return;
      seen.add(pane.id);
      glass!.pane(handle, pane.id, number(pane.left) * zoom, number(pane.top) * zoom, Math.max(number(pane.width), 0) * zoom, Math.max(number(pane.height), 0) * zoom, Math.max(number(pane.radius), 0) * zoom,
        pane.clear === true ? 1 : 0, Math.min(Math.max(number(pane.alpha, 1), 0), 1), number(pane.anchor) & 63, order);
    });
    for (const id of laid) if (!seen.has(id)) glass!.pane(handle, id, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    laid = seen;
    if (zoom !== kept.zoom) keep({ zoom });
    if (gateway !== null && event.sender.getURL().startsWith(new URL(gateway.url).origin)) standDown();
  });
  ipcMain.handle("hub:menu", (_event, entries: readonly MenuEntry[], at?: { x: number; y: number }) => new Promise<string | null>(done => {
    if (win === null || !Array.isArray(entries)) { done(null); return; }
    let chosen: string | null = null;
    // The menu closes before its item's click is told: the answer waits a moment for it.
    Menu.buildFromTemplate(nativeMenu(entries, id => { chosen = id; done(id); })).popup({ window: win,
      ...(at !== undefined && Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : {}), callback: () => setTimeout(() => done(chosen), 80) });
  }));
  ipcMain.on("hub:keys", (_event, next: Record<string, string>) => { if (typeof next === "object" && next !== null) { keys = next; buildMenu(); } });
  ipcMain.on("hub:checks", (_event, next: Record<string, boolean>) => {
    if (typeof next !== "object" || next === null) return;
    checks = next; buildMenu();
    if (typeof next.sidebar === "boolean" && next.sidebar !== kept.sidebar) keep({ sidebar: next.sidebar });
  });
  ipcMain.on("hub:activity", (_event, next: { running?: unknown; waiting?: unknown }) => {
    activity.running = Number(next?.running) || 0; activity.waiting = Number(next?.waiting) || 0;
    app.dock?.setBadge(activity.waiting > 0 ? String(activity.waiting) : "");
  });
  ipcMain.on("hub:theme", (_event, theme: unknown) => { if (theme === "system" || theme === "light" || theme === "dark") { nativeTheme.themeSource = theme; if (theme !== kept.theme) keep({ theme }); } });
  ipcMain.handle("hub:pick-folder", async (_event, start?: string) => {
    if (win === null) return null;
    const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], ...(typeof start === "string" && start ? { defaultPath: start } : {}) });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
}

async function connect(): Promise<void> {
  for (;;) {
    try {
      const started = await startGateway();
      gateway = started;
      started.child.once("exit", () => { if (gateway === started) { gateway = null; if (!quitting) void connect(); } });
      if (page !== null && !page.isDestroyed()) await page.loadURL(started.url);
      return;
    } catch (failure) {
      if (quitting) return;
      const choice = await dialog.showMessageBox({ type: "error", message: "HarnessHub 没能启动", detail: failure instanceof Error ? failure.message : String(failure), buttons: ["重试", "退出"], defaultId: 0, cancelId: 1 });
      if (choice.response === 1) { quitting = true; app.quit(); return; }
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win !== null) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on("activate", () => { if (win !== null) win.show(); });
  app.on("window-all-closed", () => { /* the Dock icon keeps the app */ });
  app.on("before-quit", event => {
    if (quitting && gateway === null) return;
    if (!quitting && activity.running > 0 && dialog.showMessageBoxSync({ type: "warning", message: `${activity.running} 个对话正在运行`, detail: "退出会停止它们。", buttons: ["退出", "取消"], defaultId: 0, cancelId: 1 }) === 1) { event.preventDefault(); return; }
    quitting = true;
    const running = gateway;
    if (running === null || running.child.exitCode !== null) return;
    // The Gateway settles its conversations before it goes: the app waits for it, a while.
    event.preventDefault();
    const end = setTimeout(() => { running.child.kill("SIGKILL"); }, 20_000);
    running.child.once("exit", () => { clearTimeout(end); gateway = null; app.quit(); });
    running.child.kill("SIGTERM");
  });
  void app.whenReady().then(() => {
    mkdirSync(join(userData, "logs"), { recursive: true });
    // The theme chosen last time, before the page is there to say it again.
    nativeTheme.themeSource = kept.theme === "light" || kept.theme === "dark" ? kept.theme : "system";
    wire(); buildMenu();
    win = createWindow();
    standIn();
    void connect();
  });
}
