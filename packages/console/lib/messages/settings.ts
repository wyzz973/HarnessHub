// SPDX-License-Identifier: MIT
/**
 * Messages of the console's settings area: the general settings (LAN
 * sharing, the model catalog, about) and the gateway features (see
 * ./types.ts).
 */
import type { Translation } from "./types";

export const zh = {
  "settings.title": "设置",
  "settings.lede": "局域网共享、模型目录与这个守护进程的信息。",
  "settings.tab.settings": "通用",
  "settings.tab.features": "网关功能",
  "settings.tab.backup": "备份与同步",
  "settings.save": "保存",
  "settings.add": "添加",
  "settings.delete": "删除",

  "settings.lan.enabled": "局域网共享已开启",
  "settings.lan.disabled": "局域网共享已关闭",
  "settings.lan.title": "局域网共享",
  "settings.lan.lede":
    "让同一网络中的其他电脑或 HarnessHub 使用本机的模型网关。只开放模型协议；管理接口与控制台仍只在本机。",
  "settings.lan.listening": "监听中",
  "settings.lan.port": " · 端口 {port}",
  "settings.lan.notListening": "未在监听",
  "settings.lan.off": "已关闭",
  "settings.lan.warning":
    "局域网上的请求是明文 HTTP：只在可信网络中开启，或放在 TLS 反向代理之后。只有创建时勾选了局域网、并设置了有效期的 client Key 能在局域网上使用。",
  "settings.lan.enable": "开启局域网共享",
  "settings.lan.host": "监听地址",
  "settings.lan.hostPlaceholder": "192.168.1.20 或 0.0.0.0",
  "settings.lan.hostHint":
    "本机的一个 IP 地址；0.0.0.0 监听全部地址。开启时必填。",
  "settings.lan.portLabel": "端口",
  "settings.lan.portPlaceholder": "与守护进程相同",
  "settings.lan.portHint": "留空则使用守护进程的端口。",
  "settings.lan.names": "主机名",
  "settings.lan.namesHint":
    "其他电脑访问时使用的名字，以逗号分隔；只接受列出的名字与 IP。",
  "settings.lan.publicBaseUrl": "公开地址（可选）",
  "settings.lan.publicBaseUrlHint": "位于反向代理之后时，客户端使用的地址。",
  "settings.lan.urls":
    "其他电脑使用 {urls}，另一台 HarnessHub 用 harnesshub-remote 预设添加它。",
  "settings.lan.confirmBody":
    "本机的模型网关将在 {address} 上对局域网开放，请求是明文 HTTP。只有勾选了局域网的 client Key 能使用它。",
  "settings.lan.confirm": "开启",

  "settings.catalog.refreshed.updated": "模型目录已更新",
  "settings.catalog.refreshed.unchanged": "模型目录没有变化",
  "settings.catalog.refreshed.failed": "模型目录失败",
  "settings.catalog.outcome.updated": "已更新",
  "settings.catalog.outcome.unchanged": "没有变化",
  "settings.catalog.outcome.failed": "失败",
  "settings.catalog.notRefreshed": "目录没有刷新",
  "settings.catalog.title": "模型目录",
  "settings.catalog.lede":
    "models.dev 的模型窗口、输出上限与价格，补齐 provider 没有给出的元数据。",
  "settings.catalog.refresh": "立即刷新",
  "settings.catalog.inUse": "使用中",
  "settings.catalog.bundled": "内置快照",
  "settings.catalog.refreshedCopy": "刷新后的副本",
  "settings.catalog.counts": "{providers} 个 provider、{models} 个模型",
  "settings.catalog.retrieved": "取得时间",
  "settings.catalog.commit": "上游提交",
  "settings.catalog.auto": "后台刷新",
  "settings.catalog.autoOn": "开启",
  "settings.catalog.autoOffline": "关闭（离线模式 HH_OFFLINE）",
  "settings.catalog.autoOff": "关闭（设置）",
  "settings.catalog.next": " · 下次 {time}",
  "settings.catalog.last": "上次刷新",
  "settings.catalog.never": "还没有刷新过",
  "settings.catalog.source": "来源",

  "settings.proxy.title": "出站代理",
  "settings.proxy.lede":
    "守护进程自己发出的请求经过的代理：模型调用、模型列表、目录刷新、同步与 OTLP 导出等。由 hh serve 的 --proxy、HTTPS_PROXY 等环境变量或 config.jsonc 的 network.proxy 设置，修改后重启守护进程生效；这里只读。provider 可以在自己的设置中改为直连或另一个代理。",
  "settings.proxy.proxy": "代理",
  "settings.proxy.direct": "直连，没有代理",
  "settings.proxy.source": "来源",
  "settings.proxy.from.flag": "hh serve 的 --proxy 参数",
  "settings.proxy.from.env": "环境变量（HTTPS_PROXY 等）",
  "settings.proxy.from.file": "config.jsonc 的 network.proxy",
  "settings.proxy.notSet": "未设置",
  "settings.proxy.noProxy": "不经代理的主机",
  "settings.proxy.always": "本机回环地址与私有网络始终直连。密码显示为 ***。",
  "settings.about.title": "关于",
  "settings.about.version": "版本",
  "settings.about.process": "进程",
  "settings.about.started": "pid {pid} · 启动于 {time}",
  "settings.about.dataDir": "数据目录",
  "settings.about.secrets": "秘密存储",
  "settings.about.keychain": "macOS 钥匙串",
  "settings.about.dpapi": "Windows DPAPI",
  "settings.about.file": "加密文件",
  "settings.about.openai": "OpenAI 基址",
  "settings.about.anthropic": "Anthropic / Gemini 基址",

  "settings.features.cost": "费用",
  "settings.features.privacy": "隐私",
  "settings.features.title": "网关功能",
  "settings.features.lede":
    "共享模型网关的可选能力。修改立即保存在数据目录中，对下一个请求生效。",

  "settings.redaction.title": "出站脱敏",
  "settings.redaction.lede":
    "请求发往上游之前，把已知的秘密换成占位符；模型在工具调用参数中写回占位符时还原为原值，写给人看的文本保留占位符。",
  "settings.redaction.enabled": "已开启出站脱敏",
  "settings.redaction.cost": "不额外请求，不额外计费。",
  "settings.redaction.privacy":
    "缺省开启：厂商看不到 HarnessHub 自己的凭据，即使提示词或工具结果引用了它们；关闭后这些值原样发出。",
  "settings.redaction.known1": "Gateway Key、守护进程的管理令牌",
  "settings.redaction.known2":
    "本进程解析过的 provider 凭据与订阅令牌（至少 8 个字符的精确值）",
  "settings.redaction.known3": "下面的规则匹配到的值（有分组时取第 1 组）",
  "settings.redaction.offWarning":
    "出站脱敏已关闭：提示词与工具结果中出现的秘密会原样发给上游。",
  "settings.redaction.rule": "规则",
  "settings.redaction.pattern": "正则表达式",
  "settings.redaction.case": "大小写",
  "settings.redaction.ignore": "忽略",
  "settings.redaction.match": "区分",
  "settings.redaction.deleteRule": "删除规则 {name}",
  "settings.redaction.deleted": "已删除规则 {name}",
  "settings.redaction.noRules": "没有自己的规则，只替换上面列出的已知秘密。",
  "settings.redaction.ruleName": "规则名",
  "settings.redaction.saved": "已保存规则 {name}",
  "settings.redaction.addRule": "添加规则",
  "settings.redaction.ignoreCase": "忽略大小写",
  "settings.redaction.hint":
    "JavaScript 正则表达式；规则名是占位符中的种类（字母、数字与下划线），同名的规则被替换。",
  "settings.redaction.offTitle": "关闭出站脱敏",
  "settings.redaction.offBody":
    "关闭后，提示词、工具结果与搜索查询中出现的 Gateway Key、provider 凭据和管理令牌会原样发给上游厂商。",
  "settings.redaction.offAction": "关闭脱敏",
  "settings.redaction.disabled": "已关闭出站脱敏",

  "settings.vision.off": "已关闭视觉兜底",
  "settings.vision.using": "视觉兜底使用 {model}",
  "settings.vision.title": "视觉兜底",
  "settings.vision.lede":
    "请求带图片、而目标模型的元数据表明它不接受图片时，先由这里的模型把每张图片描述成文字（逐字转写图中文字），再交给目标模型。",
  "settings.vision.model": "视觉模型",
  "settings.vision.none": "不使用：图片换成占位文字",
  "settings.vision.hint":
    "选择能看图的模型或路由组。描述调用经网关自己的路由、熔断与脱敏，作为 Agent harnesshub-vision 的独立调用记账；同一张图片的描述会缓存。",
  "settings.vision.key":
    "描述以发出请求的 Gateway Key 进行：视觉模型必须在这把 Key 允许的模型中，否则不描述；描述计入它的预算与每分钟请求数。每个请求至多描述 gateway.limits.maxDescribedImages（默认 16）张没有缓存的图片。",
  "settings.vision.cost":
    "每张新图片一次额外的模型调用，按视觉模型的价格计费（缓存命中不再调用）。",
  "settings.vision.privacy":
    "图片发给视觉模型所在的 provider，而不只是目标模型的 provider。",

  "settings.alerts.title": "用量提醒",
  "settings.alerts.lede":
    "某个凭据的额度窗口用到这个百分比时提醒。读数来自上游答复的限流响应头与 Copilot 的额度；守护进程启动 1 分钟后、之后每 5 分钟查看一次，每个窗口每轮只提醒一次。提醒显示在用量页与导航中，也写进 gateway.log。HarnessHub 读不到余额，因此没有余额提醒。",
  "settings.alerts.percent": "提醒阈值（%）",
  "settings.alerts.save": "保存",
  "settings.alerts.turnOff": "关闭提醒",
  "settings.alerts.on": "{percent}% 时提醒",
  "settings.alerts.off": "已关闭",
  "settings.alerts.saved": "用量到 {percent}% 时提醒",
  "settings.alerts.turnedOff": "用量提醒已关闭",
  "settings.alerts.wholeNumber": "请填写 1 到 100 的整数",
  "settings.search.addTitle": "添加搜索后端",
  "settings.search.addLede":
    "网关按登记顺序使用后端，前一个失败或没有结果时用下一个。查询发出之前同样经过出站脱敏。",
  "settings.search.service": "服务",
  "settings.search.keyOptional": "（实例需要时填写）",
  "settings.search.keyHint": "只发送一次，保存在守护进程的秘密存储中。",
  "settings.search.instance": "实例地址",
  "settings.search.apiUrl": "API 地址（可选）",
  "settings.search.defaultUrl": "缺省为 {name} 的官方地址",
  "settings.search.added": "已添加 {name}",
  "settings.search.title": "联网搜索模拟",
  "settings.search.lede":
    "客户端给模型提供厂商自己执行的联网搜索（Responses 的 web_search、Anthropic 的 web_search_*），而上游执行不了时，由网关调用这里的搜索后端完成。没有后端时这项功能关闭。",
  "settings.search.addBackend": "添加后端",
  "settings.search.cost":
    "搜索服务按它自己的方式计费（不进 HarnessHub 的账本）；模型为使用搜索结果至多多答 6 轮，按模型价格计费。",
  "settings.search.privacy":
    "搜索查询（经出站脱敏后）发给你登记的搜索服务；结果交给模型。",
  "settings.search.keySaved": "Key 已保存",
  "settings.search.noKey": "无 Key",
  "settings.search.deleteBackend": "删除 {id}",
  "settings.search.none":
    "没有搜索后端：翻译时这类工具被拒绝，直通时原样发送。",
  "settings.search.deleteTitle": "删除搜索后端 {id}",
  "settings.search.deleteBody": "网关不再使用它，保存的 Key 一并删除。",
  "settings.search.deleted": "已删除 {id}",

  "settings.images.title": "图像生成",
  "settings.images.lede":
    "网关的 POST /v1/images/generations（OpenAI Images）直通到设置了图像端点的 provider；model 是 Model Ref 或路由组，订阅 provider 不参与。",
  "settings.images.configure": "在 Provider 中设置",
  "settings.images.none":
    "还没有 provider 设置图像端点，图像请求返回 404 images_unavailable。",
} as const;

export const en: Translation<typeof zh> = {
  "settings.title": "Settings",
  "settings.lede":
    "LAN sharing, the model catalog and information about this daemon.",
  "settings.tab.settings": "General",
  "settings.tab.features": "Gateway features",
  "settings.tab.backup": "Backup and sync",
  "settings.save": "Save",
  "settings.add": "Add",
  "settings.delete": "Delete",

  "settings.lan.enabled": "LAN sharing is on",
  "settings.lan.disabled": "LAN sharing is off",
  "settings.lan.title": "LAN sharing",
  "settings.lan.lede":
    "Lets other computers or HarnessHub instances on the same network use this computer's model gateway. Only the model protocols are opened; the management API and the console stay on this computer.",
  "settings.lan.listening": "Listening",
  "settings.lan.port": " · port {port}",
  "settings.lan.notListening": "Not listening",
  "settings.lan.off": "Off",
  "settings.lan.warning":
    "Requests on the LAN are plain HTTP: turn this on only in a trusted network, or put it behind a TLS reverse proxy. Only client keys created with LAN access and an expiry can be used on the LAN.",
  "settings.lan.enable": "Turn on LAN sharing",
  "settings.lan.host": "Listen address",
  "settings.lan.hostPlaceholder": "192.168.1.20 or 0.0.0.0",
  "settings.lan.hostHint":
    "One of this computer's IP addresses; 0.0.0.0 listens on every address. Required when turning it on.",
  "settings.lan.portLabel": "Port",
  "settings.lan.portPlaceholder": "Same as the daemon",
  "settings.lan.portHint": "Leave empty to use the daemon's port.",
  "settings.lan.names": "Host names",
  "settings.lan.namesHint":
    "The names other computers use to reach it, separated by commas; only the listed names and IPs are accepted.",
  "settings.lan.publicBaseUrl": "Public address (optional)",
  "settings.lan.publicBaseUrlHint":
    "The address clients use when it sits behind a reverse proxy.",
  "settings.lan.urls":
    "Other computers use {urls}; another HarnessHub adds it with the harnesshub-remote preset.",
  "settings.lan.confirmBody":
    "This computer's model gateway will be open to the LAN on {address}, and requests are plain HTTP. Only client keys with LAN access can use it.",
  "settings.lan.confirm": "Turn on",

  "settings.catalog.refreshed.updated": "The model catalog was updated",
  "settings.catalog.refreshed.unchanged": "The model catalog has not changed",
  "settings.catalog.refreshed.failed": "The model catalog refresh failed",
  "settings.catalog.outcome.updated": "Updated",
  "settings.catalog.outcome.unchanged": "No change",
  "settings.catalog.outcome.failed": "Failed",
  "settings.catalog.notRefreshed": "The catalog was not refreshed",
  "settings.catalog.title": "Model catalog",
  "settings.catalog.lede":
    "Context windows, output limits and prices of models from models.dev, filling in metadata that providers do not give.",
  "settings.catalog.refresh": "Refresh now",
  "settings.catalog.inUse": "In use",
  "settings.catalog.bundled": "Bundled snapshot",
  "settings.catalog.refreshedCopy": "Refreshed copy",
  "settings.catalog.counts":
    "{providers, plural, one {# provider} other {# providers}}, {models, plural, one {# model} other {# models}}",
  "settings.catalog.retrieved": "Retrieved",
  "settings.catalog.commit": "Upstream commit",
  "settings.catalog.auto": "Background refresh",
  "settings.catalog.autoOn": "On",
  "settings.catalog.autoOffline": "Off (offline mode HH_OFFLINE)",
  "settings.catalog.autoOff": "Off (settings)",
  "settings.catalog.next": " · next {time}",
  "settings.catalog.last": "Last refresh",
  "settings.catalog.never": "Never refreshed yet",
  "settings.catalog.source": "Source",

  "settings.proxy.title": "Outbound proxy",
  "settings.proxy.lede":
    "The proxy of the daemon's own requests: model calls, model lists, catalog refresh, sync, OTLP export and more. It is set with hh serve's --proxy, the HTTPS_PROXY family of environment variables or network.proxy in config.jsonc, and a change takes effect when the daemon restarts; it is read-only here. A provider can choose direct or another proxy in its own settings.",
  "settings.proxy.proxy": "Proxy",
  "settings.proxy.direct": "Direct, no proxy",
  "settings.proxy.source": "Set by",
  "settings.proxy.from.flag": "hh serve's --proxy flag",
  "settings.proxy.from.env":
    "An environment variable (HTTPS_PROXY and the like)",
  "settings.proxy.from.file": "network.proxy in config.jsonc",
  "settings.proxy.notSet": "Not set",
  "settings.proxy.noProxy": "Hosts that bypass it",
  "settings.proxy.always":
    "Loopback and private network addresses always go direct. A password shows as ***.",
  "settings.about.title": "About",
  "settings.about.version": "Version",
  "settings.about.process": "Process",
  "settings.about.started": "pid {pid} · started {time}",
  "settings.about.dataDir": "Data directory",
  "settings.about.secrets": "Secret store",
  "settings.about.keychain": "macOS Keychain",
  "settings.about.dpapi": "Windows DPAPI",
  "settings.about.file": "Encrypted file",
  "settings.about.openai": "OpenAI base URL",
  "settings.about.anthropic": "Anthropic / Gemini base URL",

  "settings.features.cost": "Cost",
  "settings.features.privacy": "Privacy",
  "settings.features.title": "Gateway features",
  "settings.features.lede":
    "Optional capabilities of the shared model gateway. Changes are saved in the data directory right away and apply to the next request.",

  "settings.redaction.title": "Outbound redaction",
  "settings.redaction.lede":
    "Before a request goes upstream, known secrets are replaced with placeholders; where the model writes a placeholder back into tool call arguments it is restored to the original value, while text meant for people keeps the placeholder.",
  "settings.redaction.enabled": "Outbound redaction is on",
  "settings.redaction.cost": "No extra requests, no extra charges.",
  "settings.redaction.privacy":
    "On by default: vendors do not see HarnessHub's own credentials even when prompts or tool results quote them; when it is off, these values are sent as they are.",
  "settings.redaction.known1": "Gateway Keys and the daemon's admin token",
  "settings.redaction.known2":
    "Provider credentials and subscription tokens this process has resolved (exact values of at least 8 characters)",
  "settings.redaction.known3":
    "Values the rules below match (group 1 when there is a group)",
  "settings.redaction.offWarning":
    "Outbound redaction is off: secrets that appear in prompts and tool results are sent upstream as they are.",
  "settings.redaction.rule": "Rule",
  "settings.redaction.pattern": "Regular expression",
  "settings.redaction.case": "Case",
  "settings.redaction.ignore": "Ignored",
  "settings.redaction.match": "Matched",
  "settings.redaction.deleteRule": "Delete the rule {name}",
  "settings.redaction.deleted": "Deleted the rule {name}",
  "settings.redaction.noRules":
    "No rules of your own; only the known secrets listed above are replaced.",
  "settings.redaction.ruleName": "Rule name",
  "settings.redaction.saved": "Saved the rule {name}",
  "settings.redaction.addRule": "Add rule",
  "settings.redaction.ignoreCase": "Ignore case",
  "settings.redaction.hint":
    "A JavaScript regular expression; the rule name is the kind in the placeholder (letters, digits and underscores), and a rule of the same name is replaced.",
  "settings.redaction.offTitle": "Turn off outbound redaction",
  "settings.redaction.offBody":
    "Once it is off, Gateway Keys, provider credentials and the admin token that appear in prompts, tool results and search queries are sent to upstream vendors as they are.",
  "settings.redaction.offAction": "Turn off redaction",
  "settings.redaction.disabled": "Outbound redaction is off",

  "settings.vision.off": "Vision fallback is off",
  "settings.vision.using": "Vision fallback uses {model}",
  "settings.vision.title": "Vision fallback",
  "settings.vision.lede":
    "When a request carries images and the target model's metadata says it does not take images, the model chosen here first describes each image in words (transcribing any text in it verbatim), and then the target model gets the request.",
  "settings.vision.model": "Vision model",
  "settings.vision.none": "None: images become placeholder text",
  "settings.vision.hint":
    "Choose a model or route group that can see images. Description calls go through the gateway's own routing, breakers and redaction, and are recorded as separate calls of the agent harnesshub-vision; descriptions of the same image are cached.",
  "settings.vision.key":
    "Descriptions run as the Gateway Key that sent the request: the vision model must be among that key's allowed models, or nothing is described, and descriptions count against its budget and requests per minute. Each request has at most gateway.limits.maxDescribedImages (16 by default) uncached images described.",
  "settings.vision.cost":
    "One extra model call per new image, charged at the vision model's price (cache hits make no call).",
  "settings.vision.privacy":
    "Images are sent to the vision model's provider, not only to the target model's provider.",

  "settings.alerts.title": "Usage alerts",
  "settings.alerts.lede":
    "Alert when a credential's allowance window reaches this share used. The readings come from the rate-limit headers of upstream replies and from Copilot's allowance; the daemon looks one minute after it starts and then every five minutes, and alerts once per run of a window. Alerts show on the Usage page and in the navigation, and go to gateway.log. HarnessHub reads no balances, so there are no balance alerts.",
  "settings.alerts.percent": "Alert threshold (%)",
  "settings.alerts.save": "Save",
  "settings.alerts.turnOff": "Turn alerts off",
  "settings.alerts.on": "Alerts at {percent}%",
  "settings.alerts.off": "Off",
  "settings.alerts.saved": "Usage alerts at {percent}%",
  "settings.alerts.turnedOff": "Usage alerts are off",
  "settings.alerts.wholeNumber": "Enter a whole number from 1 to 100",
  "settings.search.addTitle": "Add a search backend",
  "settings.search.addLede":
    "The gateway uses backends in the order they were added, the next one when one fails or finds nothing. Queries also go through outbound redaction before they are sent.",
  "settings.search.service": "Service",
  "settings.search.keyOptional": " (if the instance needs one)",
  "settings.search.keyHint": "Sent once and kept in the daemon's secret store.",
  "settings.search.instance": "Instance address",
  "settings.search.apiUrl": "API address (optional)",
  "settings.search.defaultUrl": "Defaults to {name}'s official address",
  "settings.search.added": "Added {name}",
  "settings.search.title": "Web search emulation",
  "settings.search.lede":
    "When a client offers the model a web search that the vendor runs itself (web_search in Responses, web_search_* in Anthropic) and the upstream cannot run it, the gateway completes it with the search backends here. With no backend, this feature is off.",
  "settings.search.addBackend": "Add backend",
  "settings.search.cost":
    "Search services charge in their own way (not in HarnessHub's ledger); to use the results the model answers up to 6 more rounds, charged at the model's price.",
  "settings.search.privacy":
    "Search queries (after outbound redaction) go to the search services you registered; the results go to the model.",
  "settings.search.keySaved": "Key saved",
  "settings.search.noKey": "No key",
  "settings.search.deleteBackend": "Delete {id}",
  "settings.search.none":
    "No search backends: when translating, such tools are refused; in passthrough they are sent as they are.",
  "settings.search.deleteTitle": "Delete the search backend {id}",
  "settings.search.deleteBody":
    "The gateway stops using it, and its saved key is deleted too.",
  "settings.search.deleted": "Deleted {id}",

  "settings.images.title": "Image generation",
  "settings.images.lede":
    "The gateway's POST /v1/images/generations (OpenAI Images) passes through to providers that have an image endpoint; model is a Model Ref or a route group, and subscription providers do not take part.",
  "settings.images.configure": "Set it on a provider",
  "settings.images.none":
    "No provider has an image endpoint yet; image requests get 404 images_unavailable.",
};
