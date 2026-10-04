// SPDX-License-Identifier: MIT
/**
 * Messages shared by the console: actions, the shell (sidebar, sign-in,
 * notifications), the daemon's error codes and the model plane's terms
 * (see ./types.ts).
 */
import type { Translation } from "./types";

export const zh = {
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.retry": "重试",
  "common.refresh": "刷新",
  "common.loading": "正在读取",
  "common.loadFailed": "读取失败：{message}",
  "common.failureTitle": "{title}：{message}",
  "common.technicalDetails": "技术详情",
  "common.dismissNotice": "关闭通知",
  "common.notProvided": "未提供",
  "common.unavailable": "暂时无法连接控制台服务",
  "common.actionFailed": "操作失败",
  "common.actionIncomplete": "操作未完成，请重试。",

  "common.language": "语言",
  "common.languageLede": "控制台的显示语言，只保存在这个浏览器中。",

  "common.code.PROVIDER_EXISTS": "已有同名 provider",
  "common.code.PROVIDER_INVALID": "provider 配置不正确",
  "common.code.PROVIDER_IN_USE": "仍有路由组或 Gateway Key 引用此 provider",
  "common.code.PROVIDER_NOT_FOUND": "provider 不存在",
  "common.code.CREDENTIAL_EXISTS": "已有同 ID 的凭据",
  "common.code.CREDENTIAL_INVALID": "凭据不正确",
  "common.code.CREDENTIAL_NOT_MANAGED":
    "只有由 HarnessHub 保存的凭据可以在这里轮换",
  "common.code.CREDENTIAL_NOT_FOUND": "凭据不存在",
  "common.code.INVALID_SECRET": "密钥必须是非空的单行文本，最长 8 KiB",
  "common.code.ROUTE_GROUP_EXISTS": "已有同名路由组",
  "common.code.ROUTE_GROUP_INVALID": "路由组配置不正确",
  "common.code.ROUTE_GROUP_IN_USE": "仍有 Gateway Key 允许使用此路由组",
  "common.code.ROUTE_GROUP_NOT_FOUND": "路由组不存在",
  "common.code.GATEWAY_KEY_INVALID": "Key 设置不正确",
  "common.code.GATEWAY_KEY_NOT_FOUND": "Key 不存在",
  "common.code.INVALID_REQUEST": "输入不符合接口要求",
  "common.code.CONSOLE_SESSION_INVALID":
    "控制台会话已结束，请运行 hh console 重新登录",
  "common.code.ADMIN_TOKEN_REQUIRED":
    "控制台尚未登录，请运行 hh console 打开登录链接",
  "common.code.BACKUP_PASSPHRASE": "口令不对，或者文件被改动过",
  "common.code.BACKUP_UNSUPPORTED":
    "这个备份来自更新版本的 HarnessHub，请先升级",
  "common.code.SYNC_PASSPHRASE":
    "口令与服务器上的副本不符：每台电脑要用同一个口令",
  "common.code.SYNC_CONFLICT": "另一台电脑刚刚同步过，下次同步时会再合并",
  "common.code.SYNC_DISABLED": "同步未开启",
  "common.code.LIBRARY_EXISTS": "已有同名条目",
  "common.code.LIBRARY_NOT_FOUND": "条目不存在，可能已被删除",
  "common.code.LIBRARY_CONCURRENT_MODIFICATION":
    "预览之后 Agent 的文件又被改动，什么都没有写入；请重新预览",
  "common.code.AGENT_WIRING_UNAVAILABLE":
    "这个守护进程启动时没有接线目录，不能写入 Agent 的文件（hh serve 默认使用你的主目录）",
  "common.code.SUBSCRIPTION_NOTICE_NOT_ACCEPTED":
    "风险告知已经更新，请重新阅读并接受",
  "common.code.COPILOT_TOKEN_INVALID":
    "只接受带 Copilot Requests 权限的细粒度个人访问令牌（github_pat_…）",
  "common.code.NPM_NOT_FOUND": "找不到 npm：请在终端运行下面的安装命令",

  "common.reference.route-group": "路由组",
  "common.reference.gateway-key": "Gateway Key",

  "common.endpointHint.chat":
    "官方 SDK 的基址，通常含 /v1，例如 https://api.openai.com/v1；不要包含 /chat/completions",
  "common.endpointHint.responses":
    "官方 SDK 的基址，通常含 /v1，例如 https://api.openai.com/v1；不要包含 /responses",
  "common.endpointHint.anthropic":
    "不含版本段，例如 https://api.anthropic.com；网关会追加 /v1/messages",
  "common.endpointHint.gemini":
    "不含版本段，例如 https://generativelanguage.googleapis.com；网关会追加 /v1beta/models/…",
  "common.kind.vendor": "模型厂商",
  "common.kind.relay": "中转或聚合网关",
  "common.kind.local": "本机服务",
  "common.kind.custom": "自定义",
  "common.expiry.30d": "30 天",
  "common.expiry.90d": "90 天（默认）",
  "common.expiry.365d": "1 年",
  "common.expiry.never": "永不过期",
  "common.range.24h": "24 小时",
  "common.range.7d": "7 天",
  "common.range.30d": "30 天",
  "common.range.all": "全部",
  "common.source.override": "模型覆盖",
  "common.source.override-provider": "provider 级覆盖（provider/*）",
  "common.source.provider": "provider 配置中手工填写",
  "common.source.live": "上游模型列表",
  "common.source.preset": "provider 预设",
  "common.source.catalog": "models.dev 目录快照",
  "common.source.unknown": "未知：没有来源提供此值，不会按默认值估计",
  "common.source.note": "来源：{source}",
  "common.source.noteAt": "来源：{source}，{at}",
  "common.source.noteChecked": "来源：{source}，核对于 {date}",
  "common.source.priceNote": "输入：{input}\n输出：{output}",

  "common.nav.main": "主导航",
  "common.nav.pages": "页面",
  "common.nav.home": "HarnessHub 首页",
  "common.nav.expand": "展开侧栏",
  "common.nav.collapse": "收起侧栏",
  "common.nav.agents": "Agent",
  "common.nav.providers": "Provider",
  "common.nav.subscriptions": "订阅账号",
  "common.nav.routing": "路由与 Key",
  "common.nav.usage": "用量",
  "common.nav.profiles": "Profile",
  "common.nav.library": "Library",
  "common.nav.settings": "设置",
  "common.nav.tasks": "任务",
  "common.nav.newTask": "新建任务",
  "common.nav.model": "统一模型",
  "common.nav.engines": "引擎",
  "common.nav.tools": "工具",
  "common.nav.observability": "观测",
  "common.nav.modelMissing": "尚未连接统一模型",
  "common.nav.searchTasks": "搜索任务",
  "common.nav.workflow": "计划任务",
  "common.nav.running": "执行中",
  "common.nav.noMatch": "没有匹配的任务",
  "common.nav.noTasks": "还没有任务",
  "common.nav.syncFailed": "同步失败",
  "common.nav.toLight": "切换到浅色",
  "common.nav.toDark": "切换到深色",
  "common.nav.light": "浅色",
  "common.nav.dark": "深色",
  "common.nav.signOut": "退出登录",
  "common.health.ready": "已连接",
  "common.health.checking": "正在连接",
  "common.health.not-ready": "服务未就绪",
  "common.health.offline": "无法连接服务",
  "common.history.today": "今天",
  "common.history.yesterday": "昨天",
  "common.history.week": "近 7 天",
  "common.history.earlier": "更早",

  "common.signIn.none":
    "控制台需要登录。登录链接由本机的 hh 命令生成，不需要口令。每个浏览器标签页分别登录，刷新页面后仍保持登录。",
  "common.signIn.invalid-link":
    "这个登录链接已使用、已过期或不完整。每个链接只能用一次，60 秒内有效。",
  "common.signIn.ended":
    "控制台会话已结束（长时间未使用、已退出登录，或守护进程已重启）。",
  "common.signIn.signed-out": "已退出登录。",
  "common.signIn.connecting": "正在连接控制台…",
  "common.signIn.unreachable": "无法连接守护进程",
  "common.signIn.unreachableDetail": "无法连接 HarnessHub 守护进程",
  "common.signIn.title": "打开控制台",
  "common.signIn.run": "在运行守护进程的电脑上执行：",
  "common.signIn.then":
    "然后在本机浏览器中打开它输出的链接。守护进程启动时（hh serve）也会打印一个链接。",
  "common.signIn.notSignedIn": "控制台尚未登录，请运行 hh console 打开登录链接",

  "common.shell.skip": "跳到主要内容",
  "common.shell.closeNav": "关闭导航",
  "common.shell.openNav": "打开导航",
  "common.shell.fullAccess": "完全访问",
  "common.shell.fullAccessHint": "工具与权限请求自动批准",
  "common.shell.model": "模型",
  "common.shell.noModel": "未连接模型",
  "common.shell.modelHint": "所有引擎共用的模型",
  "common.shell.noModelHint": "连接模型后才能执行任务",
  "common.shell.openDetails": "打开执行详情",
  "common.shell.closeDetails": "关闭执行详情",
  "common.shell.details": "执行详情",
  "common.shell.closeHint": "关闭提示",
  "common.shell.session": "会话 {id}",
  "common.shell.connectionPrompt":
    "连接测试：请仅回复 HARNESSHUB_CONNECTION_OK。不要使用工具或修改文件。",
  "common.shell.noRuns": "还没有执行记录",
  "common.shell.streamLost": "实时连接已断开，正在通过记录同步。",
  "common.shell.reconnect": "重新连接",
  "common.shell.sessionEnded": "会话已结束",
} as const;

export const en: Translation<typeof zh> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
  "common.loading": "Loading",
  "common.loadFailed": "Could not load: {message}",
  "common.failureTitle": "{title}: {message}",
  "common.technicalDetails": "Technical details",
  "common.dismissNotice": "Dismiss notification",
  "common.notProvided": "Not provided",
  "common.unavailable": "The console service cannot be reached right now",
  "common.actionFailed": "The action failed",
  "common.actionIncomplete": "The action did not finish; please try again.",

  "common.language": "Language",
  "common.languageLede":
    "The console's display language, kept in this browser only.",

  "common.code.PROVIDER_EXISTS": "A provider with this ID already exists",
  "common.code.PROVIDER_INVALID": "The provider's settings are not valid",
  "common.code.PROVIDER_IN_USE":
    "Route groups or Gateway Keys still refer to this provider",
  "common.code.PROVIDER_NOT_FOUND": "The provider does not exist",
  "common.code.CREDENTIAL_EXISTS": "A credential with this ID already exists",
  "common.code.CREDENTIAL_INVALID": "The credential is not valid",
  "common.code.CREDENTIAL_NOT_MANAGED":
    "Only credentials that HarnessHub stores can be rotated here",
  "common.code.CREDENTIAL_NOT_FOUND": "The credential does not exist",
  "common.code.INVALID_SECRET":
    "A secret must be one non-empty line of at most 8 KiB",
  "common.code.ROUTE_GROUP_EXISTS": "A route group with this ID already exists",
  "common.code.ROUTE_GROUP_INVALID": "The route group's settings are not valid",
  "common.code.ROUTE_GROUP_IN_USE": "Gateway Keys still allow this route group",
  "common.code.ROUTE_GROUP_NOT_FOUND": "The route group does not exist",
  "common.code.GATEWAY_KEY_INVALID": "The key's settings are not valid",
  "common.code.GATEWAY_KEY_NOT_FOUND": "The key does not exist",
  "common.code.INVALID_REQUEST":
    "The input does not match what the API accepts",
  "common.code.CONSOLE_SESSION_INVALID":
    "The console session has ended; run hh console to sign in again",
  "common.code.ADMIN_TOKEN_REQUIRED":
    "The console is not signed in; run hh console to open a sign-in link",
  "common.code.BACKUP_PASSPHRASE":
    "The passphrase is wrong, or the file has been changed",
  "common.code.BACKUP_UNSUPPORTED":
    "This backup comes from a newer version of HarnessHub; upgrade first",
  "common.code.SYNC_PASSPHRASE":
    "The passphrase does not match the copy on the server: every computer must use the same passphrase",
  "common.code.SYNC_CONFLICT":
    "Another computer has just synced; the next sync will merge again",
  "common.code.SYNC_DISABLED": "Sync is off",
  "common.code.LIBRARY_EXISTS": "An item with this name already exists",
  "common.code.LIBRARY_NOT_FOUND":
    "The item does not exist; it may have been deleted",
  "common.code.LIBRARY_CONCURRENT_MODIFICATION":
    "An agent's file changed after the preview, so nothing was written; preview again",
  "common.code.AGENT_WIRING_UNAVAILABLE":
    "This daemon was started without a wiring home, so it cannot write agents' files (hh serve uses your home directory by default)",
  "common.code.SUBSCRIPTION_NOTICE_NOT_ACCEPTED":
    "The risk notice has changed; read it again and accept it",
  "common.code.COPILOT_TOKEN_INVALID":
    "Only a fine-grained personal access token with the Copilot Requests permission (github_pat_…) is accepted",
  "common.code.NPM_NOT_FOUND":
    "npm was not found: run the install command below in a terminal",

  "common.reference.route-group": "Route group",
  "common.reference.gateway-key": "Gateway Key",

  "common.endpointHint.chat":
    "The official SDK's base URL, usually with /v1, such as https://api.openai.com/v1; without /chat/completions",
  "common.endpointHint.responses":
    "The official SDK's base URL, usually with /v1, such as https://api.openai.com/v1; without /responses",
  "common.endpointHint.anthropic":
    "Without a version segment, such as https://api.anthropic.com; the gateway appends /v1/messages",
  "common.endpointHint.gemini":
    "Without a version segment, such as https://generativelanguage.googleapis.com; the gateway appends /v1beta/models/…",
  "common.kind.vendor": "Model vendor",
  "common.kind.relay": "Relay or aggregator",
  "common.kind.local": "Local service",
  "common.kind.custom": "Custom",
  "common.expiry.30d": "30 days",
  "common.expiry.90d": "90 days (default)",
  "common.expiry.365d": "1 year",
  "common.expiry.never": "Never expires",
  "common.range.24h": "24 hours",
  "common.range.7d": "7 days",
  "common.range.30d": "30 days",
  "common.range.all": "All",
  "common.source.override": "Model override",
  "common.source.override-provider": "Provider-wide override (provider/*)",
  "common.source.provider": "Entered in the provider's settings",
  "common.source.live": "The upstream's model list",
  "common.source.preset": "Provider preset",
  "common.source.catalog": "models.dev catalog snapshot",
  "common.source.unknown":
    "Unknown: no source provides this value, and no default is assumed",
  "common.source.note": "Source: {source}",
  "common.source.noteAt": "Source: {source}, {at}",
  "common.source.noteChecked": "Source: {source}, checked on {date}",
  "common.source.priceNote": "Input: {input}\nOutput: {output}",

  "common.nav.main": "Main navigation",
  "common.nav.pages": "Pages",
  "common.nav.home": "HarnessHub home",
  "common.nav.expand": "Expand the sidebar",
  "common.nav.collapse": "Collapse the sidebar",
  "common.nav.agents": "Agents",
  "common.nav.providers": "Providers",
  "common.nav.subscriptions": "Subscriptions",
  "common.nav.routing": "Routing and keys",
  "common.nav.usage": "Usage",
  "common.nav.profiles": "Profiles",
  "common.nav.library": "Library",
  "common.nav.settings": "Settings",
  "common.nav.tasks": "Tasks",
  "common.nav.newTask": "New task",
  "common.nav.model": "Unified model",
  "common.nav.engines": "Engines",
  "common.nav.tools": "Tools",
  "common.nav.observability": "Observability",
  "common.nav.modelMissing": "No unified model connected yet",
  "common.nav.searchTasks": "Search tasks",
  "common.nav.workflow": "Planned task",
  "common.nav.running": "Running",
  "common.nav.noMatch": "No matching tasks",
  "common.nav.noTasks": "No tasks yet",
  "common.nav.syncFailed": "Sync failed",
  "common.nav.toLight": "Switch to light",
  "common.nav.toDark": "Switch to dark",
  "common.nav.light": "Light",
  "common.nav.dark": "Dark",
  "common.nav.signOut": "Sign out",
  "common.health.ready": "Connected",
  "common.health.checking": "Connecting",
  "common.health.not-ready": "Service not ready",
  "common.health.offline": "Cannot reach the service",
  "common.history.today": "Today",
  "common.history.yesterday": "Yesterday",
  "common.history.week": "Last 7 days",
  "common.history.earlier": "Earlier",

  "common.signIn.none":
    "The console needs you to sign in. Sign-in links come from the hh command on this computer; there is no password. Each browser tab signs in on its own and stays signed in when reloaded.",
  "common.signIn.invalid-link":
    "This sign-in link has been used, has expired or is incomplete. Each link works once, within 60 seconds.",
  "common.signIn.ended":
    "The console session has ended (unused for a long time, signed out, or the daemon restarted).",
  "common.signIn.signed-out": "Signed out.",
  "common.signIn.connecting": "Connecting to the console…",
  "common.signIn.unreachable": "Cannot reach the daemon",
  "common.signIn.unreachableDetail": "Cannot reach the HarnessHub daemon",
  "common.signIn.title": "Open the console",
  "common.signIn.run": "On the computer that runs the daemon, run:",
  "common.signIn.then":
    "Then open the link it prints in a browser on that computer. The daemon also prints a link when it starts (hh serve).",
  "common.signIn.notSignedIn":
    "The console is not signed in; run hh console to open a sign-in link",

  "common.shell.skip": "Skip to main content",
  "common.shell.closeNav": "Close navigation",
  "common.shell.openNav": "Open navigation",
  "common.shell.fullAccess": "Full access",
  "common.shell.fullAccessHint":
    "Tool and permission requests are approved automatically",
  "common.shell.model": "Model",
  "common.shell.noModel": "No model connected",
  "common.shell.modelHint": "The model every engine shares",
  "common.shell.noModelHint": "Connect a model before running tasks",
  "common.shell.openDetails": "Open run details",
  "common.shell.closeDetails": "Close run details",
  "common.shell.details": "Run details",
  "common.shell.closeHint": "Dismiss",
  "common.shell.session": "Session {id}",
  "common.shell.connectionPrompt":
    "Connection test: reply with HARNESSHUB_CONNECTION_OK only. Do not use tools or change files.",
  "common.shell.noRuns": "No runs yet",
  "common.shell.streamLost":
    "The live connection was lost; syncing from the records.",
  "common.shell.reconnect": "Reconnect",
  "common.shell.sessionEnded": "The session has ended",
};
