// app_open / app_close / app_list: start, verify and close Windows desktop applications.
//
// On Windows every HarnessHub Session runs inside a kill-on-close Job object, so a program
// the agent starts directly dies when the Session ends. app_open therefore starts programs
// through a broker outside that Job (the desktop shell via explorer.exe, a temporary
// shortcut when arguments are needed, a one-shot scheduled task, WMI) and only falls back
// to a direct child process, which it reports as inJob:true.
import { existsSync } from "node:fs";
import path from "node:path";
import { finish, parse, ToolError } from "./common.mjs";
import { CLOSE, FUNCTIONS, LIST, OPEN } from "./app-scripts.mjs";
import { powershell, requireWindows } from "./win.mjs";

const openUsage = `
app_open <应用名|文件路径|网址> [--args "启动参数"] [--with <应用名>] [--timeout 20] [--direct]
  应用名: outlook word excel powerpoint onenote teams wps notepad(记事本) calculator(计算器)
  paint(画图) explorer(资源管理器) edge chrome cmd powershell terminal taskmgr control settings
  snipping wordpad clock calendar mail photos camera store wechat wxwork dingtalk feishu welink
  qq tencentmeeting zoom vscode acrobat, or any Start-menu name / .exe path.
  文件或网址用默认程序打开; --with word 指定用哪个应用打开文件。
Starts the target outside the agent's process tree (it stays open after the task), waits for
its process and window and prints {"ok":true,"running":true,"launcher":...,"inJob":false,
"processes":[{name,pid,title}]}. --direct starts a child process instead (inJob:true: it is
closed when the Session ends).`;
const closeUsage = `
app_close <应用名|进程名> [--force]
Asks every window of the application to close (unsaved documents may keep it open; --force
ends the processes) and prints which processes are still running.`;
const listUsage = `
app_list [关键字] [--windows]
Without a keyword: known applications that are installed or running. With a keyword: matching
Start-menu entries. --windows lists every open top-level window (process, pid, title).`;

const office = (exe) =>
  ["ProgramFiles", "ProgramFiles(x86)"].flatMap((root) =>
    [
      "Microsoft Office\\root\\Office16",
      "Microsoft Office\\Office16",
      "Microsoft Office\\root\\Office15",
      "Microsoft Office\\Office15",
      "Microsoft Office\\Office14",
    ].map((folder) => `%${root}%\\${folder}\\${exe}`),
  );
const app = (names, exe, paths, processes, start, extra = {}) => ({
  names,
  exe,
  paths,
  processes,
  start,
  uris: [],
  ...extra,
});

/** id -> how to find, start and recognise an application. `start` patterns use -like. */
export const APPS = {
  outlook: app(["outlook", "邮件客户端", "outlook邮件", "outlook邮箱"], ["OUTLOOK.EXE"], office("OUTLOOK.EXE"), ["OUTLOOK", "olk"], ["Outlook*", "*OutlookForWindows*", "*Outlook*"]),
  word: app(["word", "winword"], ["WINWORD.EXE"], office("WINWORD.EXE"), ["WINWORD"], ["Word", "Word 20*", "Microsoft Word*"]),
  excel: app(["excel"], ["EXCEL.EXE"], office("EXCEL.EXE"), ["EXCEL"], ["Excel", "Excel 20*", "Microsoft Excel*"]),
  powerpoint: app(["powerpoint", "ppt", "powerpnt"], ["POWERPNT.EXE"], office("POWERPNT.EXE"), ["POWERPNT"], ["PowerPoint", "PowerPoint 20*", "Microsoft PowerPoint*"]),
  onenote: app(["onenote"], ["ONENOTE.EXE"], office("ONENOTE.EXE"), ["ONENOTE"], ["OneNote*"]),
  access: app(["access"], ["MSACCESS.EXE"], office("MSACCESS.EXE"), ["MSACCESS"], ["Access", "Access 20*"]),
  visio: app(["visio"], ["VISIO.EXE"], office("VISIO.EXE"), ["VISIO"], ["Visio*"]),
  teams: app(["teams"], ["ms-teams.exe", "Teams.exe"], ["%LOCALAPPDATA%\\Microsoft\\Teams\\current\\Teams.exe"], ["ms-teams", "Teams"], ["Microsoft Teams*", "*Teams*"], { uris: ["msteams:"] }),
  wps: app(["wps", "wps文字", "wpsoffice", "金山办公"], ["wps.exe", "ksolaunch.exe"], ["%LOCALAPPDATA%\\Kingsoft\\WPS Office\\ksolaunch.exe"], ["wps", "wpsoffice", "ksolaunch"], ["WPS Office*", "WPS 文字*", "*WPS*"]),
  et: app(["et", "wps表格"], ["et.exe"], [], ["et"], ["WPS 表格*"]),
  wpp: app(["wpp", "wps演示"], ["wpp.exe"], [], ["wpp"], ["WPS 演示*"]),
  notepad: app(["notepad", "记事本"], ["notepad.exe"], ["%SystemRoot%\\System32\\notepad.exe"], ["notepad"], ["Notepad*", "记事本*"]),
  calculator: app(["calculator", "calc", "计算器"], ["calc.exe"], ["%SystemRoot%\\System32\\calc.exe"], ["CalculatorApp", "Calculator", "calc", "win32calc"], ["Calculator*", "计算器*"], { uris: ["calculator:"] }),
  paint: app(["paint", "mspaint", "画图"], ["mspaint.exe"], ["%SystemRoot%\\System32\\mspaint.exe", "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\mspaint.exe"], ["mspaint"], ["Paint*", "画图*"]),
  explorer: app(["explorer", "资源管理器", "文件资源管理器", "文件管理器", "此电脑", "我的电脑"], ["explorer.exe"], ["%SystemRoot%\\explorer.exe"], ["explorer"], [], { folder: true }),
  edge: app(["edge", "msedge", "浏览器", "microsoftedge"], ["msedge.exe"], ["%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe", "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"], ["msedge"], ["Microsoft Edge*"], { uris: ["microsoft-edge:"] }),
  chrome: app(["chrome", "googlechrome", "谷歌浏览器"], ["chrome.exe"], ["%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe", "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe", "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"], ["chrome"], ["Google Chrome*"]),
  firefox: app(["firefox", "火狐"], ["firefox.exe"], ["%ProgramFiles%\\Mozilla Firefox\\firefox.exe"], ["firefox"], ["Firefox*"]),
  cmd: app(["cmd", "命令提示符", "命令行"], ["cmd.exe"], ["%SystemRoot%\\System32\\cmd.exe"], ["cmd"], []),
  powershell: app(["powershell"], ["powershell.exe"], ["%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"], ["powershell"], []),
  terminal: app(["terminal", "windowsterminal", "wt", "终端"], ["wt.exe"], ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"], ["WindowsTerminal"], ["Terminal*", "Windows Terminal*", "终端*"]),
  taskmgr: app(["taskmgr", "taskmanager", "任务管理器"], ["Taskmgr.exe"], ["%SystemRoot%\\System32\\Taskmgr.exe"], ["Taskmgr"], []),
  control: app(["control", "controlpanel", "控制面板"], ["control.exe"], ["%SystemRoot%\\System32\\control.exe"], ["explorer"], [], { folder: true }),
  settings: app(["settings", "设置", "系统设置"], [], [], ["SystemSettings"], ["Settings*", "设置*"], { uris: ["ms-settings:"] }),
  snipping: app(["snipping", "snippingtool", "截图工具", "截图"], ["SnippingTool.exe"], ["%SystemRoot%\\System32\\SnippingTool.exe"], ["SnippingTool", "ScreenClippingHost"], ["Snipping Tool*", "截图工具*"], { uris: ["ms-screenclip:"] }),
  wordpad: app(["wordpad", "写字板"], ["wordpad.exe", "write.exe"], ["%ProgramFiles%\\Windows NT\\Accessories\\wordpad.exe"], ["wordpad"], ["WordPad*", "写字板*"]),
  clock: app(["clock", "alarms", "时钟", "闹钟"], [], [], ["Time"], ["Clock*", "Alarms*", "时钟*", "闹钟*"], { uris: ["ms-clock:"] }),
  calendar: app(["calendar", "日历"], [], [], ["HxCalendarAppImm", "olk", "OUTLOOK"], ["Calendar*", "日历*"], { uris: ["outlookcal:"] }),
  mail: app(["mail", "邮件"], [], [], ["HxOutlook", "olk", "OUTLOOK"], ["Mail*", "邮件*"], { uris: ["outlookmail:", "mailto:"] }),
  photos: app(["photos", "照片"], [], [], ["Photos", "Microsoft.Photos"], ["Photos*", "照片*"], { uris: ["ms-photos:"] }),
  camera: app(["camera", "相机"], [], [], ["WindowsCamera"], ["Camera*", "相机*"], { uris: ["microsoft.windows.camera:"] }),
  store: app(["store", "microsoftstore", "应用商店"], [], [], ["WinStore.App"], ["Microsoft Store*"], { uris: ["ms-windows-store:"] }),
  stickynotes: app(["stickynotes", "便笺", "便签"], [], [], ["Microsoft.Notes"], ["Sticky Notes*", "便笺*", "*StickyNotes*"]),
  wechat: app(["wechat", "weixin", "微信"], ["WeChat.exe", "Weixin.exe"], ["%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe", "%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe", "%ProgramFiles%\\Tencent\\Weixin\\Weixin.exe"], ["WeChat", "Weixin"], ["微信*", "WeChat*"]),
  wxwork: app(["wxwork", "wecom", "企业微信"], ["WXWork.exe"], ["%ProgramFiles(x86)%\\WXWork\\WXWork.exe"], ["WXWork"], ["企业微信*"]),
  dingtalk: app(["dingtalk", "钉钉"], ["DingtalkLauncher.exe", "DingTalk.exe"], ["%ProgramFiles(x86)%\\DingDing\\DingtalkLauncher.exe"], ["DingTalk"], ["钉钉*", "DingTalk*"]),
  feishu: app(["feishu", "lark", "飞书"], ["Feishu.exe", "Lark.exe"], ["%LOCALAPPDATA%\\Feishu\\Feishu.exe"], ["Feishu", "Lark"], ["飞书*", "Feishu*", "Lark*"]),
  welink: app(["welink"], ["WeLink.exe"], [], ["WeLink"], ["WeLink*", "*WeLink*"]),
  qq: app(["qq"], ["QQ.exe"], ["%ProgramFiles%\\Tencent\\QQNT\\QQ.exe", "%ProgramFiles(x86)%\\Tencent\\QQ\\Bin\\QQ.exe"], ["QQ"], ["QQ", "腾讯QQ*"]),
  tencentmeeting: app(["tencentmeeting", "wemeet", "腾讯会议"], ["wemeetapp.exe"], [], ["wemeetapp"], ["腾讯会议*"]),
  zoom: app(["zoom"], ["Zoom.exe"], ["%APPDATA%\\Zoom\\bin\\Zoom.exe"], ["Zoom"], ["Zoom*"]),
  vscode: app(["vscode", "code", "visualstudiocode"], ["Code.exe"], ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe", "%ProgramFiles%\\Microsoft VS Code\\Code.exe"], ["Code"], ["Visual Studio Code*"]),
  acrobat: app(["acrobat", "adobereader", "pdf阅读器"], ["Acrobat.exe", "AcroRd32.exe"], [], ["Acrobat", "AcroRd32"], ["Adobe Acrobat*", "Acrobat Reader*"]),
};

const BY_EXTENSION = {
  ".docx": ["WINWORD", "wps", "wpsoffice"], ".doc": ["WINWORD", "wps", "wpsoffice"], ".rtf": ["WINWORD", "wordpad", "wps"],
  ".xlsx": ["EXCEL", "et", "wpsoffice"], ".xls": ["EXCEL", "et", "wpsoffice"], ".csv": ["EXCEL", "et", "notepad"],
  ".pptx": ["POWERPNT", "wpp", "wpsoffice"], ".ppt": ["POWERPNT", "wpp", "wpsoffice"],
  ".pdf": ["msedge", "Acrobat", "AcroRd32", "chrome", "wpspdf"], ".txt": ["notepad"], ".log": ["notepad"], ".md": ["notepad", "Code"],
  ".eml": ["OUTLOOK", "olk", "HxOutlook"], ".msg": ["OUTLOOK"], ".ics": ["OUTLOOK", "olk", "HxCalendarAppImm"],
  ".html": ["msedge", "chrome", "firefox"], ".htm": ["msedge", "chrome", "firefox"],
  ".png": ["Photos", "Microsoft.Photos", "mspaint"], ".jpg": ["Photos", "Microsoft.Photos", "mspaint"],
};

export function normalise(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/microsoft|office|微软|客户端|应用程序|软件|程序|应用|\.exe$|[\s_\-·]/g, "");
}

/** Known application of a user supplied name (exact alias first, then containment). */
export function knownApp(name) {
  const wanted = normalise(name);
  if (!wanted) return undefined;
  for (const [id, entry] of Object.entries(APPS))
    if (id === wanted || entry.names.some((alias) => normalise(alias) === wanted)) return { id, ...entry };
  // Phrases such as "Outlook 邮件客户端" name a known application inside other words; a
  // plain token such as "notepad++" is a different program and is searched as written.
  if (/[\u4e00-\u9fff\s]/.test(String(name)))
    for (const [id, entry] of Object.entries(APPS))
      if (entry.names.some((alias) => normalise(alias).length >= 3 && wanted.includes(normalise(alias))))
        return { id, ...entry };
  return undefined;
}

/** Classify the positional argument: URL / protocol, existing file, or an application name. */
export function classify(name, exists = existsSync) {
  const text = String(name).trim().replace(/^["']|["']$/g, "");
  if (/^[a-z][a-z0-9+.-]+:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return { uri: text };
  if (/[\\/]/.test(text) || /\.[a-z0-9]{1,5}$/i.test(text)) {
    const absolute = path.resolve(process.cwd(), text);
    if (exists(absolute)) return { file: absolute };
  }
  return {};
}

const compact = (value) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));

export async function appOpen(argv) {
  const { values, positionals } = parse(
    argv,
    {
      args: { type: "string" },
      with: { type: "string" },
      timeout: { type: "string", default: "20" },
      direct: { type: "boolean", default: false },
      "no-window": { type: "boolean", default: false },
    },
    openUsage,
    { positionals: true },
  );
  requireWindows("app_open");
  const name = positionals.join(" ").trim();
  if (!name) throw new ToolError("USAGE", "Name the application, file or URL to open", openUsage.trim());
  const found = classify(name);
  const known = found.file || found.uri ? undefined : knownApp(name);
  let spec = known ?? app([], [], [], [], []);
  if (found.file && /\.(exe|com)$/i.test(found.file)) {
    spec = app([], [], [found.file], [path.basename(found.file).replace(/\.[^.]+$/, "")], []);
    delete found.file;
  } else if (found.file)
    spec = { ...spec, processes: BY_EXTENSION[path.extname(found.file).toLowerCase()] ?? [] };
  else if (!known && !found.uri) {
    const bare = name.replace(/\.exe$/i, "");
    spec = app([], [`${bare}.exe`], [], [bare], [`${name}*`, `*${name}*`]);
  }
  let opener = null;
  if (values.with) {
    opener = knownApp(values.with);
    if (!opener) throw new ToolError("APP_NOT_FOUND", `Unknown application for --with: ${values.with}`);
    if (!found.file) throw new ToolError("USAGE", "--with needs an existing file to open", openUsage.trim());
    spec = { ...spec, processes: opener.processes };
  }
  const result = await powershell(
    FUNCTIONS + OPEN,
    {
      name,
      spec,
      file: found.file ?? null,
      uri: found.uri ?? null,
      title: found.file ? path.basename(found.file, path.extname(found.file)) : null,
      arguments: values.args ?? null,
      with: opener,
      withName: values.with ?? null,
      direct: values.direct,
      noWindow: values["no-window"],
      timeout: Math.min(24, Math.max(4, Number(values.timeout) || 20)),
    },
    29000,
  );
  if (!result.ok)
    throw new ToolError(
      "APP_NOT_RUNNING",
      `${name} was started (${result.target}) but no process ${spec.processes.join("/")} appeared in time`,
      "Check app_list --windows; the application may need a first-run setup or is not installed correctly.",
    );
  const { ok: _ok, ...rest } = result;
  finish(compact(rest));
}

export async function appClose(argv) {
  const { values, positionals } = parse(argv, { force: { type: "boolean", default: false } }, closeUsage, { positionals: true });
  requireWindows("app_close");
  const name = positionals.join(" ").trim();
  if (!name) throw new ToolError("USAGE", "Name the application to close", closeUsage.trim());
  const known = knownApp(name);
  if (known?.id === "explorer" || known?.id === "control")
    throw new ToolError("REFUSED", "explorer.exe is the desktop shell; close its windows by hand instead");
  const processes = known ? known.processes : [name.replace(/\.exe$/i, "")];
  const { ok: _ok, ...rest } = await powershell(FUNCTIONS + CLOSE, { name, processes, force: values.force });
  finish(compact(rest));
}

export async function appList(argv) {
  const { values, positionals } = parse(argv, { windows: { type: "boolean", default: false } }, listUsage, { positionals: true });
  requireWindows("app_list");
  const { ok: _ok, ...rest } = await powershell(FUNCTIONS + LIST, {
    windows: values.windows,
    query: positionals.join(" ").trim() || null,
    apps: Object.entries(APPS).map(([id, entry]) => ({ id, exe: entry.exe, paths: entry.paths, processes: entry.processes, start: entry.start })),
  });
  finish(rest);
}
