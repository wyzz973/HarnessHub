// SPDX-License-Identifier: MIT
/**
 * Messages of the subscription accounts page (see ./types.ts). The risk
 * notices come from the daemon and are shown as it sends them; the
 * vendors' own phrases ("Use your ChatGPT plan", "Continue with ChatGPT")
 * stay the same in every language.
 */
import type { Translation } from "./types";

export const zh = {
  "subscriptions.backend.siwc": "ChatGPT",
  "subscriptions.backend.copilot": "GitHub Copilot",
  "subscriptions.brand.chatgpt": "Use your ChatGPT plan",
  "subscriptions.brand.copilot": "Use your GitHub Copilot plan",
  "subscriptions.brand.continue": "Continue with ChatGPT",

  "subscriptions.state.signedOut": "已退出登录",
  "subscriptions.state.signedOutHint": "令牌已清除；重新登录后恢复",
  "subscriptions.state.notice": "需要接受新的告知",
  "subscriptions.state.noticeHint": "风险告知已更新；重新登录并接受后恢复",
  "subscriptions.state.disabled": "已停用",
  "subscriptions.state.disabledHint": "凭据已停用",
  "subscriptions.state.usable": "可用",
  "subscriptions.state.unusable": "不可用",

  "subscriptions.lede":
    "用你自己的 ChatGPT 套餐或 GitHub Copilot 订阅为本机的 Agent 提供模型。账号只服务这台电脑上的 Agent，局域网共享的 Key 看不到它们。",
  "subscriptions.empty.title": "还没有订阅账号",
  "subscriptions.empty.body":
    "登录 ChatGPT 或 GitHub Copilot 后，账号作为 provider 出现在模型选择中。",
  "subscriptions.chatgpt.lede":
    "经 OpenAI 的 Sign in with ChatGPT for open-source apps（预览）使用 Plus、Pro 等套餐。",
  "subscriptions.chatgpt.body":
    "登录在 OpenAI 自己的页面完成，HarnessHub 不经手你的密码；请求计入套餐的用量限制，可在 ChatGPT 设置中查看和限制。",
  "subscriptions.claudeUnavailable":
    "Claude 订阅不可用：Anthropic 不允许第三方应用经 Free、Pro、Max 套餐转发请求；使用 Claude 模型请添加 Anthropic API Key。",

  "subscriptions.signIn.cancelled": "这次登录已取消",
  "subscriptions.signIn.incomplete": "登录没有完成",
  "subscriptions.signIn.cancelDone": "已取消登录",
  "subscriptions.signIn.completing":
    "浏览器已回到 HarnessHub，登录正在完成，稍候即可看到结果",
  "subscriptions.signIn.ended": "这次登录已经结束，稍候显示结果",
  "subscriptions.signIn.again": "重新登录 {name} 账号 {credential}。",
  "subscriptions.signIn.lede":
    "用你自己的 {name} 订阅为本机的 Agent 提供模型。",
  "subscriptions.signIn.waiting":
    "在新标签页中用 OpenAI 的页面登录并授权；完成后这里会自动继续。",
  "subscriptions.signIn.remaining": "剩余 {time}",
  "subscriptions.signIn.popupBlocked": "浏览器拦截了新标签页，",
  "subscriptions.signIn.noPopup": "没有看到新标签页？",
  "subscriptions.signIn.doneChatgpt":
    "You're using your ChatGPT plan{email}。HarnessHub 中符合条件的用量计入你的 ChatGPT 套餐。",
  "subscriptions.signIn.email": "（{email}）",
  "subscriptions.signIn.doneCopilot": "已登录 GitHub Copilot{login}。",
  "subscriptions.signIn.login": "：{login}",
  "subscriptions.signIn.added":
    "已添加 provider {provider}，账号 {credential}。",
  "subscriptions.signIn.modelsFailed":
    "读取模型列表失败：{error}。可以稍后在 Provider 页刷新。",
  "subscriptions.signIn.manageChatgpt": "在 ChatGPT 设置中管理用量",
  "subscriptions.signIn.manageCopilot": "在 GitHub 计费设置中查看用量",
  "subscriptions.signIn.failed": "登录失败：{message}",
  "subscriptions.signIn.finish": "完成",
  "subscriptions.signIn.cancel": "取消登录",
  "subscriptions.signIn.acceptAndSignIn": "接受并登录",

  "subscriptions.notice.label": "风险告知",
  "subscriptions.notice.version": "告知版本 {version}",
  "subscriptions.notice.manageUsage": "管理用量",
  "subscriptions.notice.accept": "我已阅读并接受以上告知",
  "subscriptions.notice.loadFailed": "读取风险告知失败，不能登录。",

  "subscriptions.copilot.authMode": "登录方式",
  "subscriptions.copilot.cliLogin": "Copilot CLI 自己的登录",
  "subscriptions.copilot.cliLoginHint":
    "先在终端运行 copilot 并用 /login 登录；HarnessHub 不读取这份登录。",
  "subscriptions.copilot.pat": "细粒度个人访问令牌",
  "subscriptions.copilot.patHint":
    "在 GitHub 创建、带 Copilot Requests 权限的 github_pat_…；只发送一次，保存在秘密存储中。",
  "subscriptions.copilot.patShort": "个人访问令牌",
  "subscriptions.copilot.ledeShort":
    "经 GitHub 的 Copilot SDK 驱动你安装的 Copilot CLI。",
  "subscriptions.copilot.lede":
    "经 GitHub 的 Copilot SDK 驱动你安装的 Copilot CLI，用 CLI 自己的登录或细粒度个人访问令牌。",
  "subscriptions.copilot.unavailable":
    "这个守护进程不提供 Copilot 账号：{message}",
  "subscriptions.copilot.installed": "已安装 {version}",
  "subscriptions.copilot.notInstalled": "未安装",
  "subscriptions.copilot.otherVersion": "{version}（支持 {supported}）",
  "subscriptions.copilot.notFound": "未找到",
  "subscriptions.copilot.installCli":
    "先安装 GitHub 的 Copilot CLI（命令 copilot 在 PATH 上），再回到这里。",
  "subscriptions.copilot.installSdk": "安装 SDK",
  "subscriptions.copilot.signIn": "登录 Copilot",

  "subscriptions.install.title": "安装 Copilot SDK",
  "subscriptions.install.description":
    "GitHub 的 Copilot SDK 是可选附加组件，不随 HarnessHub 分发。守护进程会用你 PATH 上的 npm 安装受支持的版本 {version}，不装 SDK 自带的平台运行时，也不运行依赖的安装脚本；可能需要几分钟。",
  "subscriptions.install.target":
    "安装到 {directory}。没有 npm 时可以在终端自己运行上面的命令。",
  "subscriptions.install.done": "已安装 Copilot SDK {version}",
  "subscriptions.install.installing": "正在安装…",
  "subscriptions.install.confirm": "确认安装",

  "subscriptions.account.cliLogin": "CLI 登录",
  "subscriptions.account.accepted": "接受告知于 {time}",
  "subscriptions.account.signInAgain": "重新登录",
  "subscriptions.account.signOut": "退出登录",
  "subscriptions.account.deleteLabel": "删除 {who}",

  "subscriptions.signOut.title": "退出 {who}",
  "subscriptions.signOut.copilot":
    "停止这个账号的 Copilot 宿主进程并清除令牌；账号登记保留，以后可以重新登录。Copilot CLI 自己的登录不受影响，个人访问令牌在你于 GitHub 撤销之前仍然有效。",
  "subscriptions.signOut.chatgpt":
    "向 OpenAI 撤销这个账号的会话并清除令牌；账号登记保留，以后可以重新登录。",
  "subscriptions.signOut.revoked": "已退出登录，会话已撤销",
  "subscriptions.signOut.unconfirmed":
    "已退出登录；OpenAI 没有确认撤销，可在 ChatGPT 设置中断开 HarnessHub",
  "subscriptions.signOut.tokenValid":
    "已退出登录；令牌在 GitHub 撤销之前仍然有效",
  "subscriptions.delete.title": "删除 {who}",
  "subscriptions.delete.description":
    "先结束这个账号与厂商的会话，再删除它的令牌与登记。撤销没有确认也会删除。",
  "subscriptions.delete.action": "删除",
  "subscriptions.delete.done": "已删除账号",
} as const;

export const en: Translation<typeof zh> = {
  "subscriptions.backend.siwc": "ChatGPT",
  "subscriptions.backend.copilot": "GitHub Copilot",
  "subscriptions.brand.chatgpt": "Use your ChatGPT plan",
  "subscriptions.brand.copilot": "Use your GitHub Copilot plan",
  "subscriptions.brand.continue": "Continue with ChatGPT",

  "subscriptions.state.signedOut": "Signed out",
  "subscriptions.state.signedOutHint":
    "The tokens were cleared; signing in again restores it",
  "subscriptions.state.notice": "A new notice to accept",
  "subscriptions.state.noticeHint":
    "The risk notice has changed; sign in again and accept it to restore the account",
  "subscriptions.state.disabled": "Disabled",
  "subscriptions.state.disabledHint": "The credential is disabled",
  "subscriptions.state.usable": "Usable",
  "subscriptions.state.unusable": "Not usable",

  "subscriptions.lede":
    "Use your own ChatGPT plan or GitHub Copilot subscription to provide models to the agents on this computer. Accounts serve agents on this computer only; keys shared on the local network cannot see them.",
  "subscriptions.empty.title": "No subscription accounts yet",
  "subscriptions.empty.body":
    "After you sign in to ChatGPT or GitHub Copilot, the account appears as a provider in the model pickers.",
  "subscriptions.chatgpt.lede":
    "Uses a Plus, Pro or other plan through OpenAI's Sign in with ChatGPT for open-source apps (preview).",
  "subscriptions.chatgpt.body":
    "You sign in on OpenAI's own page, and HarnessHub never handles your password; requests count toward your plan's usage limits, which you can review and limit in ChatGPT's settings.",
  "subscriptions.claudeUnavailable":
    "Claude subscriptions are not available: Anthropic does not allow third-party apps to route requests through Free, Pro or Max plans. To use Claude models, add an Anthropic API key.",

  "subscriptions.signIn.cancelled": "This sign-in was cancelled",
  "subscriptions.signIn.incomplete": "The sign-in did not complete",
  "subscriptions.signIn.cancelDone": "Sign-in cancelled",
  "subscriptions.signIn.completing":
    "The browser is back at HarnessHub and the sign-in is completing; the result shows shortly",
  "subscriptions.signIn.ended":
    "This sign-in has already ended; the result shows shortly",
  "subscriptions.signIn.again":
    "Sign in the {name} account {credential} again.",
  "subscriptions.signIn.lede":
    "Use your own {name} subscription to provide models to the agents on this computer.",
  "subscriptions.signIn.waiting":
    "Sign in and authorize on OpenAI's page in the new tab; this continues by itself when you are done.",
  "subscriptions.signIn.remaining": "{time} left",
  "subscriptions.signIn.popupBlocked": "The browser blocked the new tab: ",
  "subscriptions.signIn.noPopup": "No new tab? ",
  "subscriptions.signIn.doneChatgpt":
    "You're using your ChatGPT plan{email}. Eligible usage in HarnessHub uses your ChatGPT plan.",
  "subscriptions.signIn.email": " ({email})",
  "subscriptions.signIn.doneCopilot": "Signed in to GitHub Copilot{login}.",
  "subscriptions.signIn.login": " as {login}",
  "subscriptions.signIn.added":
    "Added the provider {provider} with the account {credential}.",
  "subscriptions.signIn.modelsFailed":
    "Reading the model list failed: {error}. You can refresh it on the Providers page later.",
  "subscriptions.signIn.manageChatgpt": "Manage usage in ChatGPT's settings",
  "subscriptions.signIn.manageCopilot":
    "Review usage in GitHub's billing settings",
  "subscriptions.signIn.failed": "Sign-in failed: {message}",
  "subscriptions.signIn.finish": "Done",
  "subscriptions.signIn.cancel": "Cancel sign-in",
  "subscriptions.signIn.acceptAndSignIn": "Accept and sign in",

  "subscriptions.notice.label": "Risk notice",
  "subscriptions.notice.version": "Notice version {version}",
  "subscriptions.notice.manageUsage": "Manage usage",
  "subscriptions.notice.accept": "I have read and accept the notice above",
  "subscriptions.notice.loadFailed":
    "The risk notice could not be read, so you cannot sign in.",

  "subscriptions.copilot.authMode": "Sign-in method",
  "subscriptions.copilot.cliLogin": "The Copilot CLI's own login",
  "subscriptions.copilot.cliLoginHint":
    "Run copilot in a terminal and sign in with /login first; HarnessHub never reads that login.",
  "subscriptions.copilot.pat": "Fine-grained personal access token",
  "subscriptions.copilot.patHint":
    "A github_pat_… created on GitHub with the Copilot Requests permission; sent once and kept in the secret store.",
  "subscriptions.copilot.patShort": "Personal access token",
  "subscriptions.copilot.ledeShort":
    "Drives the Copilot CLI you installed through GitHub's Copilot SDK.",
  "subscriptions.copilot.lede":
    "Drives the Copilot CLI you installed through GitHub's Copilot SDK, with the CLI's own login or a fine-grained personal access token.",
  "subscriptions.copilot.unavailable":
    "This daemon does not offer Copilot accounts: {message}",
  "subscriptions.copilot.installed": "Installed {version}",
  "subscriptions.copilot.notInstalled": "Not installed",
  "subscriptions.copilot.otherVersion": "{version} (supported: {supported})",
  "subscriptions.copilot.notFound": "Not found",
  "subscriptions.copilot.installCli":
    "Install GitHub's Copilot CLI first (the copilot command on PATH), then come back here.",
  "subscriptions.copilot.installSdk": "Install the SDK",
  "subscriptions.copilot.signIn": "Sign in to Copilot",

  "subscriptions.install.title": "Install the Copilot SDK",
  "subscriptions.install.description":
    "GitHub's Copilot SDK is an optional add-on that HarnessHub does not ship. The daemon installs the supported version {version} with the npm on your PATH, without the SDK's bundled platform runtimes and without running its dependencies' install scripts; it may take a few minutes.",
  "subscriptions.install.target":
    "Installs into {directory}. Without npm, you can run the command above in a terminal yourself.",
  "subscriptions.install.done": "Installed the Copilot SDK {version}",
  "subscriptions.install.installing": "Installing…",
  "subscriptions.install.confirm": "Install",

  "subscriptions.account.cliLogin": "CLI login",
  "subscriptions.account.accepted": "Notice accepted {time}",
  "subscriptions.account.signInAgain": "Sign in again",
  "subscriptions.account.signOut": "Sign out",
  "subscriptions.account.deleteLabel": "Delete {who}",

  "subscriptions.signOut.title": "Sign out {who}",
  "subscriptions.signOut.copilot":
    "Stops this account's Copilot host process and clears its tokens; the account's registration stays so you can sign in again later. The Copilot CLI's own login is not affected, and a personal access token stays valid until you revoke it on GitHub.",
  "subscriptions.signOut.chatgpt":
    "Revokes this account's session with OpenAI and clears its tokens; the account's registration stays so you can sign in again later.",
  "subscriptions.signOut.revoked": "Signed out; the session was revoked",
  "subscriptions.signOut.unconfirmed":
    "Signed out; OpenAI did not confirm the revocation, so you can disconnect HarnessHub in ChatGPT's settings",
  "subscriptions.signOut.tokenValid":
    "Signed out; the token stays valid until it is revoked on GitHub",
  "subscriptions.delete.title": "Delete {who}",
  "subscriptions.delete.description":
    "First ends this account's session with the vendor, then deletes its tokens and registration. It is deleted even if the revocation is not confirmed.",
  "subscriptions.delete.action": "Delete",
  "subscriptions.delete.done": "Account deleted",
};
